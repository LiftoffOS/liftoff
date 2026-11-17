// Run contract-level engine certification against the REAL
// adapters (the real vendor SDKs installed in the built image) and write the
// machine-readable artifact for promotion automation. Unlike the jest cert suite
// (which mocks the SDKs), this stamps the ACTUAL SDK/CLI version + image revision
// so a promotion gate can verify the engine and SDK version in the image have a
// passing certification result.
//
// Invoke in CI after the build, e.g.: node dist/scripts/certify-engines.js
// Env:
// CERTIFICATION_OUTPUT output path (default./certification-results.json)
// IMAGE_REVISION|SHORT_SHA built image revision to stamp
// Exits 1 if any engine fails certification (fail closed), and 2 (INCONCLUSIVE)
// when every failure is a vendor refusing an unfunded account.

import { CERTIFICATION_PAIRS, certificationVerdict, certifyEngine, failedOnlyForFunding, writeCertificationArtifact } from '../agent-execution/certification/certify';
import { CERTIFICATION_CONTRACT_VERSION } from '../agent-execution/certification/types';
import type { EngineCertificationResult } from '../agent-execution/certification/types';
import type { EngineProviderPair } from '../agent-execution/adapter/vendors';
import type { ExecutionEngineId, VendorSdkAdapter } from '../agent-execution/adapter';
import { execFileSync } from 'child_process';
import { readPackageVersion } from '../infrastructure/package-version';
import { getManagedSecret } from '../infrastructure/secret-store';

/** SDK/CLI package whose installed version stamps each engine's runtimeVersion.
 *  `null` for the sentinel; a CLI binary (`{ cli }`) for an engine that has no
 *  npm SDK in this tree and is driven through a globally installed binary. */
const ENGINE_SDK_PKG: Record<ExecutionEngineId, string | { cli: string } | null> = {
  'claude-agent-sdk': '@anthropic-ai/claude-agent-sdk',
  'openai-agents': '@openai/agents',
  'openai-codex': '@openai/codex-sdk',
  'google-genai': '@google/genai',
  'google-adk': '@google/adk',
  // No SDK on npm yet; the binary's own `--version` is the runtime version.
  'google-gemini-cli': { cli: 'gemini' },
  'openrouter-openai-wire': '@openai/agents',
  // Same SDK as the OpenRouter engine: xAI speaks the OpenAI wire format, and
  // sharing that implementation is why the adapter is a target rather than a
  // second copy.
  'xai-openai-wire': '@openai/agents',
  opencode: '@opencode-ai/sdk',
  'unknown-legacy': null,
};

/** Every (engine, provider) pair a run can resolve to, derived from the vendor
 *  record rather than written out again here.
 *
 *  It was a list of engines, written out, and `xai-openai-wire` was missing
 *  from it. That engine is routable in production — `adapter/index.ts` has
 *  resolved it since Grok became its own provider — so the omission did not
 *  fail anything: it silently narrowed "certify every engine" to "certify the
 *  seven somebody remembered". Then it was a derived list of engines, and that
 *  was one row short in a different way: opencode serves Grok from xAI's
 *  account AND the open-weights families from OpenRouter's, and a run per
 *  engine could only drive one of them. A hand-kept copy of a list that
 *  already exists is a copy that falls behind, and the falling behind is
 *  invisible because the short list still passes. */
const ALL_PAIRS: readonly EngineProviderPair[] = CERTIFICATION_PAIRS;

/** Which pairs to LIVE-certify. DEFAULT: every pair — the platform is
 *  deliberately provider-switchable, so every engine must be kept live-ready in
 *  every configuration it serves, not just the one currently active; a pair that
 *  cannot authenticate/construct in an env fails closed and the canary surfaces
 *  exactly which one (a real readiness gap). CERTIFY_ENGINES is an OPTIONAL
 *  comma-list of engine ids to narrow the set (e.g. to re-certify one engine
 *  after an SDK bump), and keeps every pair on the engines it names; unset =
 *  all. */
function pairsToCertify(): readonly EngineProviderPair[] {
  const raw = (process.env.CERTIFY_ENGINES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return ALL_PAIRS;
  return ALL_PAIRS.filter((p) => raw.includes(p.engine));
}

/** Emit a structured per-engine result line so a log-based metric
 *  (engine_live_certification) can alert on a live-cert failure. Cloud Logging
 *  captures the JSON as jsonPayload. */
function emitResultLog(r: EngineCertificationResult): void {
  // eslint-disable-next-line r5/no-console-in-src -- CLI batch job: stdout JSON IS the log-based-metric payload
  console.log(JSON.stringify({
    event: 'engine_live_certification',
    metric_name: 'engine_live_certification',
    metric_kind: 'gauge',
    metric_value: r.passed ? 1 : 0,
    execution_engine: r.engine,
    // Per pair: a failure on opencode-as-xAI and one on opencode-as-OpenRouter
    // are different findings, and a metric keyed on the engine alone would
    // fold them into one.
    provider: r.provider,
    // Unambiguous string outcome for the log-based metric label (a boolean field
    // extracts unreliably): 'passed' | 'failed' | 'unfunded'. 'unfunded' is a
    // vendor refusing the account, which proves nothing about the engine.
    outcome: r.passed ? 'passed' : failedOnlyForFunding(r) ? 'unfunded' : 'failed',
    runtime_version: r.runtimeVersion,
    image_revision: r.imageRevision,
    contract_version: r.contractVersion,
    passed: r.passed,
    // Name AND detail for each failing check, so the log-based metric names the
    // real cause (e.g. "clean_stream…: terminal outcome='error' reason='…404…'")
    // instead of a bare check name.
    failed_checks: r.checkDetail
      .filter((c) => !c.passed)
      .map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name)),
  }));
}

function sdkVersion(pkg: string | { cli: string } | null): string {
  if (!pkg) return 'unknown';
  if (typeof pkg === 'object') {
    try {
      return execFileSync(process.env.GEMINI_CLI_PATH || pkg.cli, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim() || 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return readPackageVersion(pkg) ?? 'unknown';
}

/** Construct the concrete adapter for an engine using the SAME construction path
 * the running service uses (lazy vendor SDK loads happen here, in the real
 * runtime — not mocked). */
async function makeAdapter(engine: ExecutionEngineId): Promise<VendorSdkAdapter> {
  switch (engine) {
    case 'claude-agent-sdk':
      return new (await import('../agent-execution/adapter/anthropic')).AnthropicAdapter();
    case 'openai-agents':
      return new (await import('../agent-execution/adapter/openai-wire')).OpenAiWireAdapter(
        { target: (await import('../agent-execution/adapter/openai')).openAiTarget },
      );
    case 'openai-codex':
      return new (await import('../agent-execution/adapter/codex')).CodexAdapter();
    case 'google-genai':
      return new (await import('../agent-execution/adapter/gemini')).GeminiAdapter();
    case 'google-adk':
      return new (await import('../agent-execution/adapter/gemini-adk')).GeminiAdkAdapter();
    case 'google-gemini-cli':
      return new (await import('../agent-execution/adapter/gemini-cli')).GeminiCliAdapter();
    case 'openrouter-openai-wire':
      return new (await import('../agent-execution/adapter/openai-wire')).OpenAiWireAdapter(
        { target: (await import('../agent-execution/adapter/openrouter')).openRouterTarget },
      );
    case 'xai-openai-wire':
      return (await import('../agent-execution/adapter/xai')).createXaiAdapter();
    case 'opencode':
      return new (await import('../agent-execution/adapter/opencode')).OpencodeAdapter();
    default:
      throw new Error(`no constructable adapter for engine '${engine}'`);
  }
}

async function main(): Promise<void> {
  // Hydrate provider secrets into process.env exactly as the service does at boot
  // (index.ts), so EVERY engine authenticates the way it does in production —
  // including adapters like Codex that read getManagedSecret('OPENAI_API_KEY') directly
  // rather than through the secrets helper. Without this the live run would report
  // spurious auth failures instead of genuine contract results.
  const { loadSecretsToEnv } = await import('../infrastructure/secrets');
  await loadSecretsToEnv();

  const imageRevision = process.env.IMAGE_REVISION ?? process.env.SHORT_SHA ?? 'unknown';
  const pairs = pairsToCertify();
  const results: EngineCertificationResult[] = [];

  for (const { engine, provider } of pairs) {
    const runtimeVersion = sdkVersion(ENGINE_SDK_PKG[engine]);
    let result: EngineCertificationResult;
    try {
      // A fresh adapter per pair: an adapter carries the catalog, the gate and
      // the recorder the last probe registered on it.
      const adapter = await makeAdapter(engine);
      // Live, so the catalog probe runs: this job is the one place the claim
      // "this engine's catalog reaches its model" can be made at all.
      result = await certifyEngine(engine, adapter, { runtimeVersion, imageRevision, provider, liveCatalog: true });
    } catch (err) {
      // Construction failure (missing/broken SDK in the image) = fail closed.
      result = {
        engine,
        provider,
        runtimeVersion,
        imageRevision,
        contractVersion: CERTIFICATION_CONTRACT_VERSION,
        passed: false,
        checks: { adapter_constructs: false },
        checkDetail: [{
          category: 'invocation_and_termination',
          name: 'adapter_constructs',
          passed: false,
          detail: (err as Error).message,
        }],
      };
    }
    emitResultLog(result);
    results.push(result);
  }

  const outPath = process.env.CERTIFICATION_OUTPUT ?? 'certification-results.json';
  const allPassed = writeCertificationArtifact(results, outPath);
  const verdict = certificationVerdict(results);
  // eslint-disable-next-line r5/no-console-in-src -- CLI batch job: stdout JSON IS the log-based-metric payload
  console.log(`[certify-engines] wrote ${outPath}; contract=${CERTIFICATION_CONTRACT_VERSION}; allPassed=${allPassed}; verdict=${verdict}`);
  // The deploy gate reads the task's exit code: 2 lets the deploy proceed
  // without stamping the pins as certified, so the next build tries again.
  if (verdict === 'failed') process.exitCode = 1;
  else if (verdict === 'inconclusive') process.exitCode = 2;
}

// Certification is a one-shot batch job: after the verdicts + artifact are
// written it MUST exit, even though the vendor SDK clients / DB pools / timers
// left open keep Node's event loop alive. Without an explicit exit the process
// hangs until Cloud Run kills it at the 900s task timeout — which marks EVERY
// run failed and masks the real per-engine verdicts. All result logs + the
// artifact are written synchronously before main() resolves, so exiting here
// does not truncate them.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    // eslint-disable-next-line r5/no-console-in-src -- CLI batch job: stdout JSON IS the log-based-metric payload
    console.error('[certify-engines] fatal', err);
    process.exit(1);
  });
