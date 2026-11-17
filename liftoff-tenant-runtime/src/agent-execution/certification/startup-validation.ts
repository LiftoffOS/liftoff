// Startup / deployment-smoke engine validation.
//
// For each provider, resolve the CONFIGURED engine and confirm it can
// initialize: the engine id is recognized by the current contract, and (for the
// self-managing engines) its SDK/CLI package is resolvable. An explicitly
// enabled engine that cannot initialize FAILS the revision before traffic
// (assertEnabledEnginesInitializable). This is a STRUCTURAL check only — it never
// makes a network provider call (live availability belongs in the deploy
// smoke/canary job), so it is safe to run on every process start.

import { accessSync, constants as fsConstants } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import { resolveExecutionEngine } from '../adapter/engine-resolver';
import { RESOLVABLE_EXECUTION_ENGINE_IDS, RESOLVED_PROVIDERS } from '../adapter/types';
import type { ExecutionEngineId, ResolvedProvider } from '../adapter';
import { CERTIFICATION_CONTRACT_VERSION } from './types';

/** SDK/CLI package each self-managing engine lazy-loads. The eager engines
 * (claude-agent-sdk, google-genai, and the three OpenAI-wire targets) ride
 * core dependencies and are always present. Two of the lazy ones are DEFAULTS
 * now — Codex for OpenAI, opencode for xAI and the open-weights families — so
 * this check bites on every boot, not only on a flag-selected escape hatch. */
const ENGINE_SDK: Partial<Record<ExecutionEngineId, string>> = {
  'openai-codex': '@openai/codex-sdk',
  'google-adk': '@google/adk',
  opencode: '@opencode-ai/sdk',
};

/** The BINARY an engine spawns when it has no npm SDK in this tree. The Gemini
 *  CLI's SDK is not published, so the engine drives the globally installed
 *  binary (Dockerfile) and the thing to check at boot is that it is on PATH —
 *  or at the path the override names. A missing binary fails the first Google
 *  run with ENOENT, which reads as a vendor error and is a deploy one. */
const ENGINE_BINARY: Partial<Record<ExecutionEngineId, { name: string; overrideEnv: string }>> = {
  'google-gemini-cli': { name: 'gemini', overrideEnv: 'GEMINI_CLI_PATH' },
};

/** The engine ids the current contract recognizes (excludes the unknown-legacy
 * sentinel, which is provenance-only and never resolved).
 *
 * Derived rather than listed. Restated here, this set went stale the moment
 * `xai-openai-wire` was added: a Grok run reported an unrecognized engine from
 * the one check whose job is to notice that at boot. */
const KNOWN_ENGINES: ReadonlySet<ExecutionEngineId> = new Set(RESOLVABLE_EXECUTION_ENGINE_IDS);

/** Non-secret STRUCTURAL configuration a self-managing engine needs
 * to initialize, checked at boot for the engines that RESOLVE (a default, or a
 * flag-selected one — the ones in ENGINE_SDK). ADK runs over Vertex (ADC),
 * which the adapter documents as requiring these deployment env vars. API keys
 * are secrets loaded AFTER this check, so they are validated elsewhere, not
 * here (and live provider reachability belongs in deploy smoke/canary, never
 * process startup).
 *
 * Each entry is a group of spellings any one of which satisfies it, reported
 * under the first when none is set. The project and the region have three
 * names apiece because the deploy sets the repo-standard `GCP_*` pair and the
 * Google SDKs read their own; the ADK adapter resolves them the way the other
 * two Google engines do (`adkVertexTarget`), so the check accepts what the
 * adapter accepts. */
const ENGINE_REQUIRED_CONFIG: Partial<Record<ExecutionEngineId, ReadonlyArray<readonly string[]>>> = {
  'google-adk': [
    ['GOOGLE_GENAI_USE_VERTEXAI'],
    ['GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT_ID'],
    ['GOOGLE_CLOUD_LOCATION', 'GCP_LOCATION', 'VERTEX_LOCATION'],
  ],
};

/** Same reason as KNOWN_ENGINES: a provider missing from this list is a
 *  provider whose engine is never checked at boot. */
const PROVIDERS: readonly ResolvedProvider[] = RESOLVED_PROVIDERS;

export interface EngineInitReport {
  provider: ResolvedProvider;
  engine: ExecutionEngineId;
  recognized: boolean;
  /** The engine's SDK package resolves — or, for an engine driven through a
   *  binary, the binary is on PATH. */
  sdkPresent: boolean;
  configPresent: boolean;
  /** Structural config keys that were required for this engine but absent. */
  missingConfig: string[];
  ok: boolean;
  detail?: string;
}

function defaultResolver(pkg: string): string {
  return require.resolve(pkg);
}

function sdkPresent(pkg: string, resolver: (id: string) => string): boolean {
  try {
    resolver(pkg);
    return true;
  } catch (err) {
    // An ESM-only package — @opencode-ai/sdk, @openai/codex-sdk — has an
    // export map with no CommonJS entry, so `require.resolve` refuses it
    // with THIS code after finding it: node read the package's own
    // package.json to consult that map. A package that is not there fails
    // with MODULE_NOT_FOUND instead. The adapters load these through
    // `esmImport`, which the export map does serve; read as "absent", the
    // probe refused to boot a service whose engine SDK was installed.
    return (err as { code?: string }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  }
}

/** Whether a binary is runnable: at the override path when one is set, else
 *  somewhere on PATH. The override and PATH are read from the injected env
 *  when it names them, else from the process — a caller that injects `{}` is
 *  asking about engine FLAGS, not about where binaries live, the same way the
 *  default module resolver answers from the real tree whatever env is passed. */
function binaryPresent(
  binary: { name: string; overrideEnv: string },
  env: NodeJS.ProcessEnv,
  isExecutable: (path: string) => boolean,
): boolean {
  const override = env[binary.overrideEnv] ?? process.env[binary.overrideEnv];
  if (override) return isExecutable(override);
  if (isAbsolute(binary.name)) return isExecutable(binary.name);
  const path = env.PATH ?? process.env.PATH ?? '';
  return path.split(delimiter).filter(Boolean).some((dir) => isExecutable(join(dir, binary.name)));
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve every provider's engine and report whether it can initialize. Pure
 * over the injected env + module resolver + executable probe (all injectable
 * for tests). */
export function validateEnabledEngines(
  env: NodeJS.ProcessEnv = process.env,
  resolver: (id: string) => string = defaultResolver,
  isExecutable: (path: string) => boolean = defaultIsExecutable,
): { ok: boolean; reports: EngineInitReport[] } {
  const reports = PROVIDERS.map((provider): EngineInitReport => {
    const engine = resolveExecutionEngine(provider, env);
    const recognized = KNOWN_ENGINES.has(engine);
    const sdk = ENGINE_SDK[engine];
    const binary = ENGINE_BINARY[engine];
    const present = sdk
      ? sdkPresent(sdk, resolver)
      : binary
        ? binaryPresent(binary, env, isExecutable)
        : true;
    // Structural config is only required for explicitly-enabled self-managing
    // engines; the default eager engines have no boot-time structural config.
    const missingConfig = (ENGINE_REQUIRED_CONFIG[engine] ?? [])
      .filter((group) => !group.some((k) => env[k]))
      .map((group) => group[0]);
    const configPresent = missingConfig.length === 0;
    const ok = recognized && present && configPresent;
    const detail = ok
      ? undefined
      : !recognized
        ? `unrecognized engine '${engine}'`
        : !present
          ? sdk
            ? `SDK '${sdk}' not resolvable`
            : `binary '${binary?.name}' not on PATH (set ${binary?.overrideEnv} to its location)`
          : `missing required config: ${missingConfig.join(', ')}`;
    return { provider, engine, recognized, sdkPresent: present, configPresent, missingConfig, ok, detail };
  });
  return { ok: reports.every((r) => r.ok), reports };
}

/** Fail the revision BEFORE traffic when a configured engine cannot
 * initialize. Call at process startup. Throws with the offending engine(s);
 * under the default configuration it holds every provider's runtime — Codex
 * and opencode included — to the SDK it needs. */
export function assertEnabledEnginesInitializable(
  env: NodeJS.ProcessEnv = process.env,
  resolver?: (id: string) => string,
  isExecutable?: (path: string) => boolean,
): void {
  const { ok, reports } = validateEnabledEngines(env, resolver, isExecutable);
  if (ok) return;
  const failed = reports
    .filter((r) => !r.ok)
    .map((r) => `${r.provider}→${r.engine}: ${r.detail}`)
    .join('; ');
  throw new Error(
    `[engine-init] configured engine(s) cannot initialize (contract ${CERTIFICATION_CONTRACT_VERSION}): ${failed}`,
  );
}
