// Liftoff Switch — OpenClaw source adapter.
//
// OpenClaw supports genuinely separate persistent agents: each can have its own
// workspace, agent state directory, authentication profiles, model
// configuration, session store, skills, channel bindings and routing rules.
// That makes it the general case, and this adapter is written first so the
// shared contract is shaped against the hardest source.
//
// Pinned upstream revision for fixtures: b689bf06, version 2026.9.3 (see the
// implementation plan's research basis). The previous pin, 8032e6c, had no
// skill carrying a `references/` directory, which is why the fixtures never
// caught those files being imported as skills of their own. Environment
// variables and named profiles override the default locations, so the effective
// configuration is resolved BEFORE any file is scanned — reading ~/.openclaw
// when OPENCLAW_HOME points elsewhere would import the wrong installation.
//
// Nothing found here is ever executed. Skills, hooks, plugins and policies are
// text to this adapter, always.

import crypto from 'crypto';
import os from 'os';
import path from 'path';
import {
  type CatalogConnectorRequirement,
  type CustomMcpServerRequirement,
  type DetectedInstallation,
  type HostingRequirement,
  type ImportedMemory,
  type ImportedRelationship,
  type ImportedRoutine,
  type ImportedSkill,
  type MigrationBundleV1,
  type PauseGuidance,
  type RawArtifact,
  type RawIdentity,
  type RawMcpServer,
  type RawRoutine,
  type RawSkill,
  type SourceAdapter,
  type SourceInventory,
  type UnsupportedItem,
  MIGRATION_BUNDLE_VERSION,
} from '../contract';
import {
  dirExists,
  fileExists,
  newScanBudget,
  probeSqlite,
  readSqliteRows,
  readJsonFile,
  readTextFile,
  redactHome,
  walkFiles,
  type ScanBudget,
} from '../filesystem';
import { redactText } from '../secret-filter';
import {
  assertWithinDistillBounds,
  normalizeIdentity,
  splitSchedules,
  type NormalizableArtifact,
  type ScheduledJob,
  recordNormalizationLosses,
  boundDiagnostics,
} from '../normalizer';
import { mapToCatalogConnector } from './connector-map';
import { mapGovernancePolicies, type RawPolicy } from './governance-map';
import {
  declaredBinaries,
  declaredSecretNames,
  groupSkillFiles,
  readSkillFileSet,
  readSkillGroupText,
} from './skill-collection';
import { parseStdioPackage } from '../stdio-package';
import { splitScriptMembers } from './script-members';

export const OPENCLAW_ADAPTER_VERSION = '1.0.0';

/** Instruction files OpenClaw recognises at an agent or workspace root. */
const INSTRUCTION_FILENAMES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'CLAUDE.md'];

interface OpenClawConfig {
  version?: string;
  /** Real shape: `{ agents: { list: [{ id, name, workspace, agentDir, ... }] } }`.
   *  The map and bare-array forms are kept because older installations and the
   *  `--profile` variants have carried them. */
  agents?:
    | { list?: OpenClawAgentConfig[]; defaults?: Record<string, unknown> }
    | Record<string, OpenClawAgentConfig>
    | OpenClawAgentConfig[];
  /** Real shape: `mcp.servers`. `mcpServers` never existed at the root. */
  mcp?: { servers?: Record<string, OpenClawMcpConfig> };
  mcpServers?: Record<string, OpenClawMcpConfig>;
  /** Channels are configured ONCE at the root, keyed by channel type, not per
   *  agent. An agent reaches a channel through a routing binding. */
  channels?: Record<string, unknown>;
  /** Per-skill settings, including the credentials a skill's script needs.
   *  Values are never read — the NAMES are what decide whether a script
   *  reaches an outside service. */
  skills?: {
    entries?: Record<string, {
      env?: Record<string, string>;
      apiKey?: { source?: string; id?: string; provider?: string };
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  workspace?: string;
  [key: string]: unknown;
}

interface OpenClawAgentConfig {
  id?: string;
  name?: string;
  description?: string;
  instructions?: string;
  workspace?: string;
  model?: string;
  provider?: string;
  channels?: string[];
  mcpServers?: string[];
  /** Agent-to-agent permissions. */
  canDelegateTo?: string[];
  skills?: string[];
  [key: string]: unknown;
}

interface OpenClawMcpConfig {
  type?: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface OpenClawCronJob {
  id?: string;
  name?: string;
  schedule?: string;
  cron?: string;
  prompt?: string;
  agentId?: string;
  agent?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export function openclawAdapter(opts: { path?: string; profile?: string } = {}): SourceAdapter {
  return {
    source: 'openclaw',
    adapterVersion: OPENCLAW_ADAPTER_VERSION,
    detect: () => detect(opts),
    inventory: (installation) => inventory(installation),
    normalize: (inv) => normalize(inv),
    pauseGuidance: (installation) => pauseGuidance(installation),
    searchPaths: (o) => resolveStateRoots({ path: o.path ?? opts.path, profile: o.profile ?? opts.profile }).map(redactHome),
  };
}

// ── detect ─────────────────────────────────────────────────────────────

/** Resolve the effective state root. Explicit --path wins, then the
 *  environment override, then the default. */
export function resolveStateRoots(opts: { path?: string; profile?: string }): string[] {
  if (opts.path) return [path.resolve(opts.path)];

  const roots: string[] = [];
  const envHome = process.env.OPENCLAW_HOME || process.env.OPENCLAW_STATE_DIR;
  if (envHome) roots.push(path.resolve(envHome));

  const defaultRoot = path.join(os.homedir(), '.openclaw');
  if (!roots.includes(defaultRoot)) roots.push(defaultRoot);

  // Named profiles live beside the default root as sibling directories.
  if (opts.profile) {
    const profileRoot = path.join(os.homedir(), `.openclaw-${opts.profile}`);
    return [profileRoot, ...roots].filter((r, i, a) => a.indexOf(r) === i);
  }

  return roots;
}

async function detect(opts: { path?: string; profile?: string }): Promise<DetectedInstallation[]> {
  const out: DetectedInstallation[] = [];

  for (const root of resolveStateRoots(opts)) {
    if (!dirExists(root)) continue;
    const configPath = path.join(root, 'openclaw.json');
    // A state root without a config is an empty or partially initialised
    // installation; report nothing rather than inventing an agent from it.
    if (!fileExists(configPath)) continue;

    const budget = newScanBudget();
    const config = readJsonFile<OpenClawConfig>(root, configPath, budget);

    out.push({
      source: 'openclaw',
      stateRoot: root,
      profile: opts.profile,
      sourceVersion: typeof config?.version === 'string' ? config.version : undefined,
      installationFingerprint: fingerprint('openclaw', root),
      resolvedFrom: [redactHome(configPath)],
    });
  }

  return out;
}

export function fingerprint(source: string, root: string): string {
  // Stable across runs on ONE machine, and different on every other machine.
  //
  // The path alone was not enough. `/root/.openclaw` is identical on every
  // Linux server, and two laptops belonging to the same person have the same
  // home directory layout — so one person's two computers, and two people with
  // the same username, all produced the same fingerprint. Combined with a
  // workspace-scoped uniqueness key that meant a second import RESUMED someone
  // else's migration and overwrote their bundle.
  //
  // The hostname is hashed with everything else and never sent: the server
  // receives 32 hex characters it cannot reverse into a machine name or a home
  // directory layout.
  const machine = os.hostname();
  return crypto
    .createHash('sha256')
    .update(`${source}:${machine}:${root}`)
    .digest('hex')
    .slice(0, 32);
}

// ── inventory ──────────────────────────────────────────────────────────

async function inventory(installation: DetectedInstallation): Promise<SourceInventory> {
  const root = installation.stateRoot;
  const budget = newScanBudget();
  const unsupportedItems: UnsupportedItem[] = [];

  const config = readJsonFile<OpenClawConfig>(root, path.join(root, 'openclaw.json'), budget);
  if (!config) {
    unsupportedItems.push({
      sourceRef: 'openclaw.json',
      reason: 'malformed_configuration',
      detail:
        'The OpenClaw configuration could not be read. Nothing was imported from this ' +
        'installation and it was not modified.',
      sourcePath: redactHome(path.join(root, 'openclaw.json')),
    });
    return {
      installation,
      identities: [],
      sharedArtifacts: [],
      mcpServers: [],
      routines: [],
      unsupportedItems,
      diagnostics: budget.diagnostics,
    };
  }

  // Unknown top-level configuration fields are reported in redacted form only.
  reportUnknownFields(config, unsupportedItems);

  const agentsDir = path.join(root, 'agents');
  const workspaceRoot = typeof config.workspace === 'string'
    ? path.resolve(root, config.workspace)
    : path.join(root, 'workspace');

  // ── shared artifacts (workspace-level instructions and skills) ───────
  const sharedArtifacts: RawArtifact[] = [];
  if (dirExists(workspaceRoot)) {
    for (const name of INSTRUCTION_FILENAMES) {
      const p = path.join(workspaceRoot, name);
      const text = readTextFile(workspaceRoot, p, budget);
      if (text !== null) {
        sharedArtifacts.push({
          sourcePath: redactHome(p),
          text: redactText(text).text,
          category: 'instructions',
        });
      }
    }
  }

  // ── MCP servers ─────────────────────────────────────────────────────
  const mcpServers = collectMcpServers((config.mcp?.servers ?? config.mcpServers), unsupportedItems);

  // ── cron jobs / standing recurring work ─────────────────────────────
  // The store first, because that is where the real product writes. The JSON
  // candidates stay as a fallback for installations that predate it.
  const routines = [
    ...(await collectRoutinesFromStore(root, budget, unsupportedItems)),
    ...collectRoutines(root, budget, unsupportedItems),
  ];

  // ── agents ──────────────────────────────────────────────────────────
  const identities: RawIdentity[] = [];
  const agentConfigs = normalizeAgentMap(config.agents);

  for (const [agentId, agentConfig] of agentConfigs) {
    // The product records the agent directory ABSOLUTELY in its config, and
    // `agents add --agent-dir` lets it sit anywhere. Deriving it from the state
    // root is only correct for the default layout, so the recorded value wins
    // when the scan can still reach it.
    const recordedDir = typeof agentConfig.agentDir === 'string' ? agentConfig.agentDir : null;
    const derivedDir = path.join(agentsDir, agentId, 'agent');
    const agentStateDir =
      recordedDir && dirExists(recordedDir) ? recordedDir : derivedDir;

    // Session stores hold raw transcripts and tool results, which are on the
    // do-not-import list. Probed read-only, for presence only; no row content
    // is ever read, and a WAL sidecar is reported rather than checkpointed
    // because checkpointing would MUTATE the user's installation.
    const sessionDb = path.join(agentStateDir, 'openclaw-agent.sqlite');
    const probe = await probeSqlite(sessionDb, budget);
    if (probe.present) {
      unsupportedItems.push({
        sourceRef: `agent:${agentId}`,
        reason: 'session_history_excluded',
        detail:
          'Conversation history and tool results stay in OpenClaw. Liftoff imports ' +
          'instructions, skills, memories and recurring work, not past runs.',
        sourcePath: redactHome(sessionDb),
      });
    }

    const artifacts: RawArtifact[] = [];
    const memories: RawArtifact[] = [];

    // Agent-level instruction files, from both the agent state dir and the
    // agent's own workspace when it declares one.
    const agentWorkspace = typeof agentConfig.workspace === 'string'
      ? path.resolve(root, agentConfig.workspace)
      : null;

    for (const base of [agentStateDir, agentWorkspace].filter(Boolean) as string[]) {
      if (!dirExists(base)) continue;
      for (const name of INSTRUCTION_FILENAMES) {
        const p = path.join(base, name);
        const text = readTextFile(base, p, budget);
        if (text !== null) {
          artifacts.push({
            sourcePath: redactHome(p),
            text: redactText(text).text,
            category: 'instructions',
          });
        }
      }

      // MEMORY.md plus dated files under memory/.
      const memoryMd = path.join(base, 'MEMORY.md');
      const memText = readTextFile(base, memoryMd, budget);
      if (memText !== null) {
        memories.push({
          sourcePath: redactHome(memoryMd),
          text: redactText(memText).text,
          category: 'memory',
        });
      }
      const memoryDir = path.join(base, 'memory');
      if (dirExists(memoryDir)) {
        for (const file of walkFiles(memoryDir, budget, { filter: (f) => f.endsWith('.md') })) {
          const text = readTextFile(memoryDir, file, budget);
          if (text !== null) {
            memories.push({
              sourcePath: redactHome(file),
              text: redactText(text).text,
              category: 'memory',
            });
          }
        }
      }
    }

    const skills = collectSkills(root, agentStateDir, agentWorkspace, workspaceRoot, budget, config);

    identities.push({
      sourceRef: `agent:${agentId}`,
      displayName: agentConfig.name || agentConfig.id || agentId,
      artifacts,
      memories,
      skills,
      modelPreference: agentConfig.model || agentConfig.provider
        ? {
            provider: typeof agentConfig.provider === 'string' ? agentConfig.provider : undefined,
            model: typeof agentConfig.model === 'string' ? agentConfig.model : undefined,
            note: 'Imported as a preference. Liftoff selects the model for its own runtime.',
          }
        : undefined,
      integrationRefs: Array.isArray(agentConfig.channels) ? agentConfig.channels.filter(isString) : [],
      mcpServerRefs: Array.isArray(agentConfig.mcpServers)
        ? agentConfig.mcpServers.filter(isString)
        : mcpServers.map((s) => s.sourceRef),
      routineRefs: routines
        .filter((r) => r.identityRef === `agent:${agentId}`)
        .map((r) => r.sourceRef),
      delegatesTo: Array.isArray(agentConfig.canDelegateTo)
        ? agentConfig.canDelegateTo.filter(isString).map((id) => `agent:${id}`)
        : [],
    });
  }

  // Declarative tool policies and sandbox preferences. Only settings with an
  // exact Liftoff equivalent become governance rules; the rest are reported.
  const policies: RawPolicy[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (POLICY_KEYS.has(key.toLowerCase())) policies.push({ key, value });
  }
  for (const [agentId, agentConfig] of agentConfigs) {
    for (const [key, value] of Object.entries(agentConfig)) {
      if (POLICY_KEYS.has(key.toLowerCase())) {
        policies.push({ key, value, identitySourceRef: `agent:${agentId}` });
      }
    }
  }
  const governance = mapGovernancePolicies('openclaw', policies);
  for (const key of governance.unmappedKeys) {
    unsupportedItems.push({
      sourceRef: `policy:${key}`,
      reason: 'policy_without_liftoff_equivalent',
      detail:
        `The policy "${key}" has no exact Liftoff equivalent and was not imported. Set the ` +
        'equivalent rule in Liftoff governance if you need it.',
    });
  }

  return {
    installation,
    identities,
    sharedArtifacts,
    mcpServers,
    routines,
    unsupportedItems,
    governanceRules: governance.rules,
    diagnostics: budget.diagnostics,
  };
}

/** Config keys that express a declarative policy. */
const POLICY_KEYS = new Set([
  'approvalrequired', 'requireapproval', 'askbeforerunning',
  'deniedtools', 'blockedtools', 'sandbox', 'sandboxed',
  'allowedhosts', 'allowlisthosts', 'toolpolicy', 'permissions',
]);

function normalizeAgentMap(
  agents: OpenClawConfig['agents'],
): Array<[string, OpenClawAgentConfig]> {
  if (!agents) return [];
  if (Array.isArray(agents)) {
    return agents.map((a, i) => [a.id || a.name || `agent-${i + 1}`, a]);
  }

  // The real product writes `agents.list` as an ARRAY. Treating the object as a
  // map produced one phantom team member whose id was the literal string
  // "list", carrying none of the installation's instructions, skills, memories
  // or schedules — the entire import of a real machine, wrong.
  const listed = (agents as { list?: OpenClawAgentConfig[] }).list;
  if (Array.isArray(listed)) {
    return listed.map((a, i) => [a.id || a.name || `agent-${i + 1}`, a]);
  }

  // A map keyed by id, minus the structural keys the real schema puts beside
  // the list.
  return Object.entries(agents as Record<string, OpenClawAgentConfig>).filter(
    ([key, value]) => key !== 'defaults' && value && typeof value === 'object',
  );
}

function collectSkills(
  root: string,
  agentStateDir: string,
  agentWorkspace: string | null,
  workspaceRoot: string,
  budget: ScanBudget,
  config: OpenClawConfig,
): RawSkill[] {
  const out: RawSkill[] = [];
  const seen = new Set<string>();

  // Workspace, shared, managed and agent-local skill directories. Read in a
  // deterministic order so a re-run produces an identical bundle.
  const skillRoots = [
    path.join(agentStateDir, 'skills'),
    agentWorkspace ? path.join(agentWorkspace, 'skills') : null,
    path.join(workspaceRoot, 'skills'),
    path.join(root, 'skills'),
    path.join(root, 'shared', 'skills'),
    path.join(root, 'managed', 'skills'),
  ].filter(Boolean) as string[];

  for (const skillRoot of skillRoots) {
    if (!dirExists(skillRoot)) continue;
    // The WHOLE directory, not just its markdown: 11 of OpenClaw's 50 bundled
    // skills ship `scripts/`, `references/` or `examples/`, and the
    // markdown-only walk left all of it behind.
    const files = walkFiles(skillRoot, budget);
    // Naming a file for its parent directory turned every `references/*.md`
    // inside a skill into a skill of its own, called `references`, whose body
    // was one page of that skill's API notes. Support files belong to the
    // skill above them; only a flat `skills/<name>.md` is named for its file.
    for (const group of groupSkillFiles(skillRoot, files, legacyOpenClawSkillName)) {
      if (seen.has(group.name)) continue;
      const text = readSkillGroupText(skillRoot, group, budget);
      if (text === null) continue;
      seen.add(group.name);
      const fileSet = readSkillFileSet(skillRoot, group, budget);
      out.push({
        sourceRef: `skill:${group.name}`,
        name: group.name,
        text,
        sourcePath: redactHome(group.primaryPath),
        files: fileSet.files.length > 0 ? fileSet.files : undefined,
        binaryPaths: fileSet.binaries.length > 0 ? fileSet.binaries : undefined,
        referencedSecretNames: orUndefined([
          ...new Set([...declaredSecretNames(text), ...configuredSecretNames(config, group.name)]),
        ].sort()),
        requiredBinaries: orUndefined(declaredBinaries(text)),
      });
    }
  }

  return out;
}

/** The pre-SKILL.md naming rule, kept for a file that is neither a `SKILL.md`
 *  nor a support file: a flat `skills/<name>.md` is named for the file, and
 *  anything deeper for the directory holding it. */
function legacyOpenClawSkillName(file: string): string {
  return path.basename(path.dirname(file)) === 'skills'
    ? path.basename(file, '.md')
    : path.basename(path.dirname(file));
}

function collectMcpServers(
  servers: OpenClawConfig['mcpServers'],
  unsupportedItems: UnsupportedItem[],
): RawMcpServer[] {
  if (!servers || typeof servers !== 'object') return [];
  const out: RawMcpServer[] = [];

  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object') continue;
    const cfg = raw as OpenClawMcpConfig;
    const url = typeof cfg.url === 'string' ? cfg.url : undefined;
    const command = typeof cfg.command === 'string' ? cfg.command : undefined;

    // A definition that launches a local process cannot be called as a remote
    // MCP server, and executing imported commands would violate the import
    // trust boundary outright.
    const transport: 'http' | 'stdio' = url ? 'http' : 'stdio';

    out.push({
      sourceRef: `mcp:${name}`,
      name,
      transport,
      url,
      command,
      args: Array.isArray(cfg.args) ? cfg.args.filter(isString) : undefined,
      authScheme: inferAuthScheme(cfg),
      // Header NAMES only. Values are never read into the bundle.
      customHeaderNames: cfg.headers && typeof cfg.headers === 'object'
        ? Object.keys(cfg.headers)
        : undefined,
      usedByIdentityRefs: [],
    });

    if (transport === 'stdio') {
      unsupportedItems.push({
        sourceRef: `mcp:${name}`,
        reason: 'stdio_mcp_requires_hosting',
        detail:
          `"${name}" starts a local command. Liftoff cannot run that command in the cloud. ` +
          'Replace it with a Liftoff connection, host it at a public URL, or reach it through ' +
          'a Liftoff tunnel.',
      });
    }
  }

  return out;
}

function inferAuthScheme(cfg: OpenClawMcpConfig): 'none' | 'api_key' | 'bearer' | 'custom_headers' {
  const headers = cfg.headers && typeof cfg.headers === 'object' ? Object.keys(cfg.headers) : [];
  const lower = headers.map((h) => h.toLowerCase());
  if (lower.includes('authorization')) return 'bearer';
  if (lower.some((h) => h.includes('api-key') || h.includes('apikey'))) return 'api_key';
  if (headers.length > 0) return 'custom_headers';
  return 'none';
}

/** Cron jobs from the product's own store.
 *
 *  The real OpenClaw keeps schedules in the `cron_jobs` TABLE of
 *  `<state>/openclaw.sqlite`, written through the Gateway. It has no
 *  `cron/jobs.json` and never did — reading one found nothing on a real
 *  installation, so every schedule on every real machine was silently dropped
 *  and the import reported no recurring work at all.
 *
 *  Columns are taken from the shipped schema (`.schema cron_jobs` at
 *  2026.7.1-2): schedule_kind / schedule_expr carry the cadence, agent_id the
 *  owner, name and display_name the label, enabled the state.
 *
 *  Read-only and never checkpointed: the importer must leave the source exactly
 *  as it found it. */
async function collectRoutinesFromStore(
  root: string,
  budget: ScanBudget,
  unsupportedItems: UnsupportedItem[],
): Promise<RawRoutine[]> {
  const out: RawRoutine[] = [];
  const rows = await readSqliteRows(path.join(root, 'state', 'openclaw.sqlite'), 'cron_jobs', budget);

  for (const row of rows) {
    const id = String(row.job_id ?? row.name ?? '');
    if (!id) continue;
    const kind = typeof row.schedule_kind === 'string' ? row.schedule_kind : '';
    const expr = typeof row.schedule_expr === 'string' ? row.schedule_expr : '';

    // Only a cron cadence maps to a Liftoff trigger. `every`/`at` jobs are one
    // shots or interval timers with no cron equivalent, and inventing one would
    // run someone's work at the wrong time.
    if (kind !== 'cron' || !expr) {
      unsupportedItems.push({
        sourceRef: `routine:${id}`,
        reason: 'unconvertible_schedule',
        detail:
          `"${String(row.name ?? id)}" runs on a ${kind || 'unknown'} schedule, which has no ` +
          'Liftoff equivalent. It was not imported rather than guessed at.',
      });
      continue;
    }

    out.push({
      sourceRef: `routine:${id}`,
      name: String(row.display_name ?? row.name ?? id),
      schedule: expr,
      prompt: typeof row.payload_message === 'string' ? row.payload_message : '',
      identityRef: typeof row.agent_id === 'string' && row.agent_id ? `agent:${row.agent_id}` : '',
      enabledInSource: row.enabled === 1 || row.enabled === true,
    });
  }

  return out;
}

function collectRoutines(
  root: string,
  budget: ScanBudget,
  unsupportedItems: UnsupportedItem[],
): RawRoutine[] {
  const out: RawRoutine[] = [];

  const candidates = [
    path.join(root, 'cron', 'jobs.json'),
    path.join(root, 'automations', 'jobs.json'),
    path.join(root, 'cron.json'),
  ];

  for (const candidate of candidates) {
    if (!fileExists(candidate)) continue;
    const parsed = readJsonFile<OpenClawCronJob[] | { jobs?: OpenClawCronJob[] }>(
      root,
      candidate,
      budget,
    );
    if (!parsed) continue;
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];

    for (const [i, job] of jobs.entries()) {
      const schedule = job.schedule || job.cron;
      const id = job.id || job.name || `job-${i + 1}`;
      if (!schedule || typeof schedule !== 'string') {
        unsupportedItems.push({
          sourceRef: `routine:${id}`,
          reason: 'unconvertible_schedule',
          detail: 'This scheduled job has no readable schedule and was not imported.',
          sourcePath: redactHome(candidate),
        });
        continue;
      }
      const agentRef = job.agentId || job.agent;
      out.push({
        sourceRef: `routine:${id}`,
        name: job.name || id,
        schedule,
        prompt: redactText(typeof job.prompt === 'string' ? job.prompt : '').text,
        identityRef: agentRef ? `agent:${agentRef}` : '',
        enabledInSource: job.enabled !== false,
      });
    }
  }

  return out;
}

function reportUnknownFields(config: OpenClawConfig, unsupportedItems: UnsupportedItem[]): void {
  const known = new Set([
    'version',
    'agents',
    'mcpServers',
    'channels',
    'workspace',
    'gateway',
    'models',
    'providers',
    'skills',
    'defaults',
    'telemetry',
  ]);
  for (const key of Object.keys(config)) {
    if (known.has(key)) continue;
    unsupportedItems.push({
      sourceRef: `config:${key}`,
      reason: 'unknown_configuration_field',
      detail:
        `The configuration field "${key}" is not recognised by this importer version and was ` +
        'not imported. Its value is not included in this report.',
    });
  }
}

// ── normalize ──────────────────────────────────────────────────────────

async function normalize(inv: SourceInventory): Promise<MigrationBundleV1> {
  convertScriptSkills(inv);

  const unsupportedItems: UnsupportedItem[] = [...inv.unsupportedItems];
  const agents = [];
  const skills: ImportedSkill[] = [];
  const memories: ImportedMemory[] = [];
  const instructions = [];
  const agentRelationships: ImportedRelationship[] = [];
  // Support-facing notes, paths only and never contents. Seeded from the
  // filesystem scan — skipped symlinks, unreadable directories, oversized
  // files, excluded credential files — because the inventory is where those
  // land and the bundle is the only thing that leaves the user's machine.
  // Normalization losses are appended per identity below.
  const diagnostics: string[] = [...inv.diagnostics];

  for (const identity of inv.identities) {
    const artifacts: NormalizableArtifact[] = [
      // Workspace-level instructions apply to every agent in the installation,
      // so each imported team member carries them. Collecting them and then
      // dropping them would lose the rules the whole workspace ran under.
      ...inv.sharedArtifacts.map((a) => ({
        sourcePath: a.sourcePath,
        text: a.text,
        category: a.category,
      })),
      ...identity.artifacts.map((a) => ({
        sourcePath: a.sourcePath,
        text: a.text,
        category: a.category,
      })),
      ...identity.skills.map((s) => ({
        sourcePath: s.sourcePath,
        text: s.text,
        category: 'skill' as const,
      })),
      ...identity.memories.map((m) => ({
        sourcePath: m.sourcePath,
        text: m.text,
        category: 'memory' as const,
      })),
    ];

    // Responsibilities are built from the identity's own instruction files.
    // These become DISTILLER INPUT, never a field copied onto an agent: the
    // canonical distiller is the only agent-provisioning path.
    const responsibilities = identity.artifacts
      .map((a) => a.text)
      .join('\n\n')
      .trim() || `Imported from OpenClaw agent "${identity.displayName}".`;

    // A schedule is how a team member RUNS, so it belongs on the member. The
    // first becomes this identity's trigger; any others become team members of
    // their own below, because Liftoff gives each member exactly one trigger.
    // A schedule with no owner belongs to the FIRST identity, which is the
    // same fallback the routines list already uses. An OpenClaw job may omit `agentId`,
    // so matching strictly on it dropped every schedule: no member got a
    // trigger and no member was spawned for the extras. The routines array
    // still recorded them, which made the loss invisible — Liftoff has no
    // routine entity, so a schedule that does not become a member's trigger
    // does not run at all.
    const ownerOfUnassigned = inv.identities[0]?.sourceRef;
    const jobs: ScheduledJob[] = inv.routines
      .filter((r) =>
        r.identityRef ? r.identityRef === identity.sourceRef : ownerOfUnassigned === identity.sourceRef,
      )
      .map((r) => ({
        sourceRef: r.sourceRef,
        name: r.name,
        cronExpr: normalizeCron(r.schedule) ?? '',
        prompt: r.prompt,
      }))
      .filter((j) => j.cronExpr.length > 0);
    const schedules = splitSchedules(jobs);

    const result = normalizeIdentity({
      sourceRef: identity.sourceRef,
      label: identity.displayName,
      responsibilities,
      artifacts,
      integrationRefs: identity.integrationRefs,
      mcpServerRefs: identity.mcpServerRefs,
      routineRefs: identity.routineRefs,
      cronExpr: schedules.ownerCronExpr,
      modelPreference: identity.modelPreference,
    });

    assertWithinDistillBounds(result.agent);
    agents.push(result.agent);
    unsupportedItems.push(...result.unsupportedItems);
    recordNormalizationLosses(diagnostics, identity.sourceRef, result);

    // Each remaining scheduled job is a recurring responsibility in its own
    // right, so it is built the way everything else is: distilled from its own
    // prompt, carrying the parent's instructions as context so it inherits how
    // that part of the workspace works.
    for (const job of schedules.spawned) {
      const spawned = normalizeIdentity({
        sourceRef: `${identity.sourceRef}::${job.sourceRef}`,
        label: job.name,
        responsibilities: job.prompt || `Recurring work imported from OpenClaw: ${job.name}.`,
        artifacts: identity.artifacts.map((a) => ({
          sourcePath: a.sourcePath,
          text: a.text,
          category: a.category,
        })),
        integrationRefs: identity.integrationRefs,
        mcpServerRefs: identity.mcpServerRefs,
        routineRefs: [job.sourceRef],
        cronExpr: job.cronExpr,
        modelPreference: identity.modelPreference,
      });
      assertWithinDistillBounds(spawned.agent);
      agents.push(spawned.agent);
      unsupportedItems.push(...spawned.unsupportedItems);
      recordNormalizationLosses(diagnostics, `${identity.sourceRef}::${job.sourceRef}`, spawned);
    }

    for (const skill of identity.skills) {
      skills.push({
        sourceRef: skill.sourceRef,
        identitySourceRef: identity.sourceRef,
        name: skill.name,
        content: skill.text,
        sourcePath: skill.sourcePath,
        files: skill.files,
        referencedSecretNames: skill.referencedSecretNames,
      });

      // A file nobody can scan does not travel, and it is named rather than
      // dropped: watching a skill arrive without the script it describes, with
      // nothing said, is the failure this reports its way out of.
      for (const binary of skill.binaryPaths ?? []) {
        unsupportedItems.push({
          sourceRef: `${skill.sourceRef}:${binary}`,
          reason: 'binary_asset_excluded',
          detail: `${binary} is not a text file, so it was not imported with the ${skill.name} skill.`,
        });
      }

      // Binaries the skill expects on the machine running it. Liftoff runs in a
      // cloud sandbox, so a skill that shells out to a local tool will not work
      // there — said plainly rather than imported as a capability that fails on
      // first use.
      if (skill.requiredBinaries?.length) {
        unsupportedItems.push({
          sourceRef: `${skill.sourceRef}:bins`,
          reason: 'policy_without_liftoff_equivalent',
          detail:
            `The ${skill.name} skill expects ${skill.requiredBinaries.join(', ')} to be installed ` +
            'on the machine running it. It was imported, but will not work until an equivalent is available.',
        });
      }
    }

    for (const [i, memory] of identity.memories.entries()) {
      memories.push({
        sourceRef: `${identity.sourceRef}:memory:${i}`,
        identitySourceRef: identity.sourceRef,
        content: memory.text,
        // Agent-scoped context lands immediately and stays governable.
        // Nothing here is promoted to workspace scope without explicit
        // consent, which the wizard collects.
        scope: 'agent',
        sourcePath: memory.sourcePath,
      });
    }

    for (const artifact of identity.artifacts) {
      instructions.push({
        sourceRef: `${identity.sourceRef}:${artifact.sourcePath}`,
        identitySourceRef: identity.sourceRef,
        name: path.basename(artifact.sourcePath),
        category: artifact.category,
        sourcePath: artifact.sourcePath,
      });
    }
  }

  // Agent-to-agent permissions become team relationships, never new
  // identities. A delegation target that is not itself a persistent agent is
  // dropped with a report rather than manufactured into a team member.
  const identityRefs = new Set(inv.identities.map((i) => i.sourceRef));
  for (const identity of inv.identities) {
    for (const target of identity.delegatesTo) {
      if (!identityRefs.has(target)) {
        unsupportedItems.push({
          sourceRef: identity.sourceRef,
          reason: 'transient_delegation_not_an_identity',
          detail:
            `"${identity.displayName}" could delegate to "${target}", which is not a persistent ` +
            'agent in this installation. No team member was created for it.',
        });
        continue;
      }
      agentRelationships.push({
        fromSourceRef: identity.sourceRef,
        toSourceRef: target,
        kind: 'delegates_to',
      });
    }
  }

  // ── connections ─────────────────────────────────────────────────────
  const catalogConnectorRequirements: CatalogConnectorRequirement[] = [];
  const customMcpServerRequirements: CustomMcpServerRequirement[] = [];
  const hostingRequirements: HostingRequirement[] = [];

  const channelRefs = new Set<string>();
  for (const identity of inv.identities) {
    for (const ref of identity.integrationRefs) channelRefs.add(ref);
  }

  for (const ref of [...channelRefs].sort()) {
    const mapped = mapToCatalogConnector(ref);
    if (mapped) {
      catalogConnectorRequirements.push({
        sourceRef: `channel:${ref}`,
        connectorType: mapped.connectorType,
        authMethod: mapped.authMethod,
        usedByIdentityRefs: inv.identities
          .filter((i) => i.integrationRefs.includes(ref))
          .map((i) => i.sourceRef),
        usedByRoutineRefs: [],
      });
    } else {
      unsupportedItems.push({
        sourceRef: `channel:${ref}`,
        reason: 'unknown_configuration_field',
        detail:
          `"${ref}" does not match a Liftoff connection type. Reconnect an equivalent ` +
          'connection in Liftoff, or leave this capability out.',
      });
    }
  }

  for (const server of inv.mcpServers) {
    if (server.transport === 'http' && server.url) {
      // Prefer a catalog connector when the same capability exists both ways:
      // a reconnected Liftoff connection is governed, a raw MCP endpoint is not.
      const mapped = mapToCatalogConnector(server.name);
      if (mapped) {
        catalogConnectorRequirements.push({
          sourceRef: server.sourceRef,
          connectorType: mapped.connectorType,
          authMethod: mapped.authMethod,
          usedByIdentityRefs: inv.identities
            .filter((i) => i.mcpServerRefs.includes(server.sourceRef))
            .map((i) => i.sourceRef),
          usedByRoutineRefs: [],
        });
        continue;
      }
      customMcpServerRequirements.push({
        sourceRef: server.sourceRef,
        name: server.name,
        url: server.url,
        transport: 'http',
        authScheme: server.authScheme ?? 'none',
        customHeaderNames: server.customHeaderNames,
        usedByIdentityRefs: inv.identities
          .filter((i) => i.mcpServerRefs.includes(server.sourceRef))
          .map((i) => i.sourceRef),
      });
      continue;
    }

    // stdio, private, or otherwise unreachable: an unresolved requirement,
    // NOT a connector row and NOT a custom_mcp_servers row. A fake row with no
    // callable endpoint would present a broken capability as a working one.
    hostingRequirements.push({
      sourceRef: server.sourceRef,
      name: server.name,
      command: server.command,
      args: server.args,
      url: server.url,
      reason: server.url ? 'unreachable_mcp_endpoint' : 'stdio_mcp_requires_hosting',
      usedByIdentityRefs: inv.identities
        .filter((i) => i.mcpServerRefs.includes(server.sourceRef))
        .map((i) => i.sourceRef),
      // The published package the command runs, when it names one. Recorded
      // here and resolved server-side against the MCP registry: most of these
      // are local wrappers around an API Liftoff already reaches.
      packageIdentity: parseStdioPackage(server.command, server.args) ?? undefined,
    });
  }

  // ── routines ────────────────────────────────────────────────────────
  const routines: ImportedRoutine[] = [];
  for (const routine of inv.routines) {
    const cronExpr = normalizeCron(routine.schedule);
    if (!cronExpr) {
      unsupportedItems.push({
        sourceRef: routine.sourceRef,
        reason: 'unconvertible_schedule',
        detail: `The schedule "${routine.schedule}" could not be converted and was not imported.`,
      });
      continue;
    }
    routines.push({
      sourceRef: routine.sourceRef,
      identitySourceRef: routine.identityRef || (inv.identities[0]?.sourceRef ?? ''),
      name: routine.name,
      cronExpr,
      prompt: routine.prompt,
      enabledInSource: routine.enabledInSource,
    });
  }

  return {
    bundleVersion: MIGRATION_BUNDLE_VERSION,
    source: 'openclaw',
    sourceVersion: inv.installation.sourceVersion,
    adapterVersion: OPENCLAW_ADAPTER_VERSION,
    installationFingerprint: inv.installation.installationFingerprint,
    agents,
    agentRelationships,
    instructions,
    skills,
    memories,
    routines,
    catalogConnectorRequirements,
    customMcpServerRequirements,
    hostingRequirements,
    governanceRules: inv.governanceRules ?? [],
    modelPreferences: inv.identities
      .map((i) => i.modelPreference)
      .filter((m): m is NonNullable<typeof m> => Boolean(m)),
    unsupportedItems,
    diagnostics: boundDiagnostics(diagnostics),
  };
}

/** Convert a source schedule to a standard 5-field cron expression. Returns
 *  null when the dialect cannot be converted, which is reported rather than
 *  guessed: a wrong schedule runs someone's work at the wrong time. */
export function normalizeCron(schedule: string): string | null {
  const trimmed = schedule.trim();

  const named: Record<string, string> = {
    '@hourly': '0 * * * *',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@weekly': '0 0 * * 0',
    '@monthly': '0 0 1 * *',
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
  };
  if (named[trimmed.toLowerCase()]) return named[trimmed.toLowerCase()];

  const fields = trimmed.split(/\s+/);
  // 6-field expressions carry seconds; Liftoff schedules at minute
  // granularity, so the seconds field is dropped only when it is a constant.
  if (fields.length === 6) {
    if (/^\d+$/.test(fields[0])) return fields.slice(1).join(' ');
    return null;
  }
  if (fields.length === 5) return fields.join(' ');
  return null;
}

// ── pause guidance ─────────────────────────────────────────────────────

/** Displayed at cutover as copyable text. Liftoff never runs this. */
function pauseGuidance(installation: DetectedInstallation): PauseGuidance {
  const profileNote = installation.profile
    ? ` This installation uses the named profile "${installation.profile}", so make sure you ` +
      'stop the gateway that owns that profile.'
    : '';

  return {
    command: 'openclaw gateway stop --disable --force --json',
    steps: [
      'Run the command below in your terminal to stop the OpenClaw gateway.',
      'If a service manager such as launchd or systemd owns the gateway, disable that service ' +
        'as well so it does not restart automatically.',
      'Leave your OpenClaw files in place. Liftoff does not delete or modify them.',
    ],
    supervisedNote:
      'Liftoff does not run this command and cannot confirm that OpenClaw has stopped. ' +
      'If equivalent schedules stay active in OpenClaw, the same work can run twice.' +
      profileNote,
  };
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/** Drop an empty list rather than carrying `[]` across the wire, so a skill
 *  that declares nothing looks like a skill that declares nothing. */
function orUndefined(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined;
}

/** Credential NAMES `openclaw.json` records for one skill.
 *
 *  A skill declares what it needs in its own frontmatter, and the installation
 *  separately records what was actually configured for it — under
 *  `skills.entries.<name>`, as an `env` map whose KEYS are variable names, and
 *  an `apiKey` pointer naming an environment variable by id. Reading only the
 *  frontmatter missed every skill whose author documented nothing and whose
 *  user configured it anyway.
 *
 *  Values are never read. `env` here holds real secrets on a real machine. */
function configuredSecretNames(config: OpenClawConfig, skillName: string): string[] {
  const entry = config.skills?.entries?.[skillName];
  if (!entry) return [];

  const names = new Set<string>();
  for (const key of Object.keys(entry.env ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) names.add(key);
  }
  // `apiKey: { source: 'env', id: 'GEMINI_API_KEY' }` names the variable to
  // read, not the key itself.
  if (entry.apiKey?.source === 'env' && typeof entry.apiKey.id === 'string') {
    if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(entry.apiKey.id)) names.add(entry.apiKey.id);
  }
  return [...names].sort();
}

/** Turn every script that reaches an outside service into a delegate team
 *  member, before the inventory is normalized.
 *
 *  Applied to each identity in turn: its own skills are partitioned, the
 *  members that result are appended, and the identity delegates to them. The
 *  new members carry no schedule, so they run only when their caller asks.
 *
 *  Shared by every adapter (script-members.ts) because the decision is not
 *  source-specific: a script that needs a credential is the same problem
 *  wherever it was imported from. */
function convertScriptSkills(inv: SourceInventory): void {
  const created: RawIdentity[] = [];

  for (const identity of inv.identities) {
    const split = splitScriptMembers(identity.skills);
    identity.skills = split.skills;
    inv.unsupportedItems.push(...split.unsupported);

    for (const member of split.members) {
      if (created.some((m) => m.sourceRef === member.sourceRef)) continue;
      created.push(member);
      identity.delegatesTo.push(member.sourceRef);
    }
  }

  inv.identities.push(...created);
}
