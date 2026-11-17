// Liftoff Switch — Hermes source adapter.
//
// Hermes is primarily ONE persistent agent per profile. Delegated subagents are
// usually temporary workers rather than durable identities, and this adapter
// must never manufacture permanent Liftoff team members out of transient
// delegation history — that would hand a switcher a team of ghosts on their
// first day.
//
// Written against the contract settled by the OpenClaw adapter. It is the proof
// that the contract is genuinely source-neutral: everything source-specific
// lives in this file, and nothing here required a contract change.
//
// Pinned upstream revision for fixtures: f03ed94 (see the plan's research
// basis). The previous pin, 036cbdf, predated the move to
// `skills/<category>/<name>/SKILL.md`, so the fixtures kept asserting a layout
// upstream no longer writes and hid a defect that imported one skill out of
// every installation. HERMES_HOME overrides the default location, so it is
// resolved before any scan.

import crypto from 'crypto';
import fs from 'fs';
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
  readJsonFile,
  readTextFile,
  readYamlFile,
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
import { normalizeCron } from './openclaw';
import {
  declaredBinaries,
  declaredSecretNames,
  groupSkillFiles,
  readSkillFileSet,
  readSkillGroupText,
} from './skill-collection';
import { parseStdioPackage } from '../stdio-package';
import { splitScriptMembers } from './script-members';

export const HERMES_ADAPTER_VERSION = '1.0.0';

interface HermesConfig {
  version?: string;
  name?: string;
  persona?: string;
  model?: string;
  provider?: string;
  channels?: Record<string, unknown> | string[];
  mcp_servers?: Record<string, HermesMcpConfig>;
  mcpServers?: Record<string, HermesMcpConfig>;
  toolsets?: string[];
  /** Stable registered multi-agent definitions, when present. These ARE
   *  durable identities; transient delegation records are not. */
  agents?: Record<string, HermesAgentConfig>;
  [key: string]: unknown;
}

interface HermesAgentConfig {
  name?: string;
  persona?: string;
  model?: string;
  provider?: string;
  registered?: boolean;
  [key: string]: unknown;
}

interface HermesMcpConfig {
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  transport?: string;
  [key: string]: unknown;
}

interface HermesCronJob {
  id?: string;
  name?: string;
  /** Real shape: an OBJECT `{ kind, expr, display }`. The bare string form is
   *  kept because older jobs.json files carry it. */
  schedule?: string | { kind?: string; expr?: string; display?: string };
  cron?: string;
  prompt?: string;
  enabled?: boolean;
  delivery?: unknown;
  [key: string]: unknown;
}

export function hermesAdapter(opts: { path?: string; profile?: string } = {}): SourceAdapter {
  return {
    source: 'hermes',
    adapterVersion: HERMES_ADAPTER_VERSION,
    detect: () => detect(opts),
    inventory: (installation) => inventory(installation),
    normalize: (inv) => normalize(inv),
    pauseGuidance: (installation) => pauseGuidance(installation),
    searchPaths: (o) => resolveHermesRoots({ path: o.path ?? opts.path, profile: o.profile ?? opts.profile }).map(redactHome),
  };
}

// ── detect ─────────────────────────────────────────────────────────────

export function resolveHermesRoots(opts: { path?: string; profile?: string }): string[] {
  if (opts.path) return [path.resolve(opts.path)];

  const roots: string[] = [];
  const envHome = process.env.HERMES_HOME;
  if (envHome) roots.push(path.resolve(envHome));

  const defaultRoot = path.join(os.homedir(), '.hermes');
  if (!roots.includes(defaultRoot)) roots.push(defaultRoot);
  return roots;
}

/** Profiles are subdirectories of the state root. A root with a config at its
 *  top level is itself the (default) profile. */
function profileDirs(root: string, requested?: string): Array<{ dir: string; profile?: string }> {
  if (requested) {
    const dir = path.join(root, 'profiles', requested);
    if (dirExists(dir)) return [{ dir, profile: requested }];
    const flat = path.join(root, requested);
    if (dirExists(flat)) return [{ dir: flat, profile: requested }];
    return [];
  }

  const out: Array<{ dir: string; profile?: string }> = [];
  if (hasConfig(root)) out.push({ dir: root });

  const profilesRoot = path.join(root, 'profiles');
  if (dirExists(profilesRoot)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(profilesRoot).sort();
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const dir = path.join(profilesRoot, entry);
      if (dirExists(dir) && hasConfig(dir)) out.push({ dir, profile: entry });
    }
  }

  return out;
}

function hasConfig(dir: string): boolean {
  return fileExists(path.join(dir, 'config.yaml')) || fileExists(path.join(dir, 'config.yml'));
}

function configPathFor(dir: string): string {
  return fileExists(path.join(dir, 'config.yaml'))
    ? path.join(dir, 'config.yaml')
    : path.join(dir, 'config.yml');
}

async function detect(opts: { path?: string; profile?: string }): Promise<DetectedInstallation[]> {
  const out: DetectedInstallation[] = [];

  for (const root of resolveHermesRoots(opts)) {
    if (!dirExists(root)) continue;
    for (const { dir, profile } of profileDirs(root, opts.profile)) {
      const budget = newScanBudget();
      const config = readYamlFile<HermesConfig>(dir, configPathFor(dir), budget);
      out.push({
        source: 'hermes',
        stateRoot: dir,
        profile,
        sourceVersion: typeof config?.version === 'string' ? config.version : undefined,
        installationFingerprint: hermesFingerprint(dir),
        resolvedFrom: [redactHome(configPathFor(dir))],
      });
    }
  }

  return out;
}

function hermesFingerprint(root: string): string {
  return crypto.createHash('sha256').update(`hermes:${root}`).digest('hex').slice(0, 32);
}

// ── inventory ──────────────────────────────────────────────────────────

async function inventory(installation: DetectedInstallation): Promise<SourceInventory> {
  const root = installation.stateRoot;
  const budget = newScanBudget();
  const unsupportedItems: UnsupportedItem[] = [];

  const config = readYamlFile<HermesConfig>(root, configPathFor(root), budget);
  if (!config) {
    unsupportedItems.push({
      sourceRef: 'config.yaml',
      reason: 'malformed_configuration',
      detail:
        'The Hermes configuration could not be read. Nothing was imported from this profile ' +
        'and it was not modified.',
      sourcePath: redactHome(configPathFor(root)),
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

  reportUnknownFields(config, unsupportedItems);

  // state.db holds raw messages and session history — do not import. Probed
  // read-only for presence only; pending delegation tasks, approvals and
  // execution queues stay in Hermes by design.
  const stateDb = path.join(root, 'state.db');
  const probe = await probeSqlite(stateDb, budget);
  if (probe.present) {
    unsupportedItems.push({
      sourceRef: 'state.db',
      reason: 'session_history_excluded',
      detail:
        'Message history, pending delegations and approval queues stay in Hermes. Liftoff ' +
        'imports instructions, skills, memories and recurring work.',
      sourcePath: redactHome(stateDb),
    });
  }

  // ── instructions and memories ───────────────────────────────────────
  const artifacts: RawArtifact[] = [];
  const memories: RawArtifact[] = [];

  const soul = path.join(root, 'SOUL.md');
  const soulText = readTextFile(root, soul, budget);
  if (soulText !== null) {
    artifacts.push({
      sourcePath: redactHome(soul),
      text: redactText(soulText).text,
      category: 'instructions',
    });
  }

  const memoriesDir = path.join(root, 'memories');
  if (dirExists(memoriesDir)) {
    for (const file of walkFiles(memoriesDir, budget, { filter: (f) => f.endsWith('.md') })) {
      const text = readTextFile(memoriesDir, file, budget);
      if (text === null) continue;
      const base = path.basename(file).toUpperCase();
      // USER.md is a user-preference document: instructions, not a memory.
      const category = base === 'USER.MD' ? 'instructions' : 'memory';
      const target = category === 'instructions' ? artifacts : memories;
      target.push({
        sourcePath: redactHome(file),
        text: redactText(text).text,
        category,
      });
    }
  }

  // ── skills ──────────────────────────────────────────────────────────
  const skills = collectSkills(root, config, budget);

  // ── MCP servers and toolsets ────────────────────────────────────────
  const mcpServers = collectMcpServers(config, unsupportedItems);

  // ── cron jobs ───────────────────────────────────────────────────────
  const routines = collectRoutines(root, budget, unsupportedItems);

  // ── identities ──────────────────────────────────────────────────────
  // One Liftoff team member per persistent Hermes profile, plus any STABLE
  // registered multi-agent definitions. Transient delegation history is
  // deliberately not consulted.
  const identities: RawIdentity[] = [];
  const profileName = config.name || installation.profile || 'Hermes';

  identities.push({
    sourceRef: `profile:${installation.profile ?? 'default'}`,
    displayName: typeof profileName === 'string' ? profileName : 'Hermes',
    artifacts,
    memories,
    skills,
    modelPreference:
      config.model || config.provider
        ? {
            provider: typeof config.provider === 'string' ? config.provider : undefined,
            model: typeof config.model === 'string' ? config.model : undefined,
            note: 'Imported as a preference. Liftoff selects the model for its own runtime.',
          }
        : undefined,
    integrationRefs: channelRefsOf(config),
    mcpServerRefs: mcpServers.map((s) => s.sourceRef),
    routineRefs: routines.map((r) => r.sourceRef),
    delegatesTo: [],
  });

  for (const [id, agent] of Object.entries(config.agents ?? {})) {
    if (!agent || typeof agent !== 'object') continue;
    // Only stable REGISTERED definitions are durable identities. Compared
    // loosely because a source may express the flag as a YAML boolean or as a
    // string, and defaulting a transient worker into a permanent team member
    // is the more expensive mistake.
    if (agent.registered === false || String(agent.registered) === 'false') {
      unsupportedItems.push({
        sourceRef: `agent:${id}`,
        reason: 'transient_delegation_not_an_identity',
        detail:
          `"${id}" is a temporary worker in Hermes rather than a registered team member, so no ` +
          'Liftoff team member was created for it.',
      });
      continue;
    }
    identities.push({
      sourceRef: `agent:${id}`,
      displayName: agent.name || id,
      artifacts: agent.persona
        ? [
            {
              sourcePath: `${redactHome(configPathFor(root))}#agents.${id}.persona`,
              text: redactText(String(agent.persona)).text,
              category: 'instructions',
            },
          ]
        : [],
      memories: [],
      skills: [],
      modelPreference:
        agent.model || agent.provider
          ? {
              provider: typeof agent.provider === 'string' ? agent.provider : undefined,
              model: typeof agent.model === 'string' ? agent.model : undefined,
              note: 'Imported as a preference. Liftoff selects the model for its own runtime.',
            }
          : undefined,
      integrationRefs: [],
      mcpServerRefs: [],
      routineRefs: [],
      // A registered definition may name other REGISTERED definitions it hands
      // off to. Anything not registered is a transient worker and is filtered
      // at normalization rather than becoming a team member.
      delegatesTo: Array.isArray((agent as Record<string, unknown>).handoffs)
        ? ((agent as Record<string, unknown>).handoffs as unknown[])
            .filter((h): h is string => typeof h === 'string')
            .map((h) => `agent:${h}`)
        : [],
    });
  }

  // Declarative policies. Hermes expresses most governance as prose in SOUL.md,
  // which rides across as instructions and is deliberately NOT treated as a
  // rule; only structured settings with an exact Liftoff equivalent map here.
  const policies: RawPolicy[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (HERMES_POLICY_KEYS.has(key.toLowerCase())) policies.push({ key, value });
  }
  const governance = mapGovernancePolicies('hermes', policies);
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
    sharedArtifacts: [],
    mcpServers,
    routines,
    unsupportedItems,
    governanceRules: governance.rules,
    diagnostics: budget.diagnostics,
  };
}

/** Config keys that express a declarative policy. */
const HERMES_POLICY_KEYS = new Set([
  'approvalrequired', 'require_approval', 'requireapproval', 'ask_before_running',
  'denied_tools', 'deniedtools', 'blocked_tools', 'sandbox', 'sandboxed',
  'allowed_hosts', 'allowedhosts', 'tool_policy',
]);

function channelRefsOf(config: HermesConfig): string[] {
  const channels = config.channels;
  if (Array.isArray(channels)) return channels.filter((c): c is string => typeof c === 'string');
  if (channels && typeof channels === 'object') return Object.keys(channels);
  return [];
}

function collectSkills(root: string, config: HermesConfig, budget: ScanBudget): RawSkill[] {
  const out: RawSkill[] = [];
  const seen = new Set<string>();

  const skillRoots = [path.join(root, 'skills')];
  // Configured external skill directories, each containment-checked on read.
  const external = (config as Record<string, unknown>).skill_dirs;
  if (Array.isArray(external)) {
    for (const dir of external) {
      if (typeof dir === 'string') skillRoots.push(path.resolve(root, dir));
    }
  }

  for (const skillRoot of skillRoots) {
    if (!dirExists(skillRoot)) continue;
    // The WHOLE directory, not just its markdown: a skill's scripts and
    // references are part of it, and the markdown-only walk left every one of
    // them on the machine we imported from.
    const files = walkFiles(skillRoot, budget);
    // Hermes lays skills out as `skills/<category>/<name>/SKILL.md`. Naming
    // them for the file called every one of them `SKILL`, and the dedupe below
    // then kept exactly one: an installation with twelve skills imported one.
    // The legacy flat `skills/<name>.md` layout still names for the file.
    for (const group of groupSkillFiles(skillRoot, files, (f) => path.basename(f, '.md'))) {
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
        referencedSecretNames: orUndefined(declaredSecretNames(text)),
        requiredBinaries: orUndefined(declaredBinaries(text)),
      });
    }
  }

  return out;
}

function collectMcpServers(
  config: HermesConfig,
  unsupportedItems: UnsupportedItem[],
): RawMcpServer[] {
  const servers = config.mcp_servers ?? config.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const out: RawMcpServer[] = [];

  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object') continue;
    const cfg = raw as HermesMcpConfig;
    const url = typeof cfg.url === 'string' ? cfg.url : undefined;
    const command = typeof cfg.command === 'string' ? cfg.command : undefined;
    const transport: 'http' | 'stdio' = url ? 'http' : 'stdio';

    out.push({
      sourceRef: `mcp:${name}`,
      name,
      transport,
      url,
      command,
      args: Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : undefined,
      authScheme: inferAuthScheme(cfg),
      customHeaderNames:
        cfg.headers && typeof cfg.headers === 'object' ? Object.keys(cfg.headers) : undefined,
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

function inferAuthScheme(cfg: HermesMcpConfig): 'none' | 'api_key' | 'bearer' | 'custom_headers' {
  const headers = cfg.headers && typeof cfg.headers === 'object' ? Object.keys(cfg.headers) : [];
  const lower = headers.map((h) => h.toLowerCase());
  if (lower.includes('authorization')) return 'bearer';
  if (lower.some((h) => h.includes('api-key') || h.includes('apikey'))) return 'api_key';
  if (headers.length > 0) return 'custom_headers';
  return 'none';
}

function collectRoutines(
  root: string,
  budget: ScanBudget,
  unsupportedItems: UnsupportedItem[],
): RawRoutine[] {
  const jobsPath = path.join(root, 'cron', 'jobs.json');
  if (!fileExists(jobsPath)) return [];

  const parsed = readJsonFile<HermesCronJob[] | { jobs?: HermesCronJob[] }>(root, jobsPath, budget);
  if (!parsed) return [];
  const jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];

  const out: RawRoutine[] = [];
  for (const [i, job] of jobs.entries()) {
    const id = job.id || job.name || `job-${i + 1}`;
    // Hermes writes `schedule` as `{ kind: 'cron', expr: '0 * * * *', display }`.
    // Reading it as a string reported every job on a real installation as
    // unconvertible, so a real Hermes import carried no schedules at all —
    // and the error said the job "has no readable schedule" while the
    // expression sat one field down.
    const raw = job.schedule ?? job.cron;
    const schedule =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object'
          ? // `kind` distinguishes cron from interval forms like `30m`. Only a
            // cron expression maps to a Liftoff trigger; an interval has no
            // equivalent and is reported rather than guessed at.
            (raw.kind ?? 'cron') === 'cron'
            ? (raw.expr ?? raw.display ?? '')
            : ''
          : '';

    if (!schedule || typeof schedule !== 'string') {
      unsupportedItems.push({
        sourceRef: `routine:${id}`,
        reason: 'unconvertible_schedule',
        detail: 'This scheduled job has no readable schedule and was not imported.',
        sourcePath: redactHome(jobsPath),
      });
      continue;
    }
    out.push({
      sourceRef: `routine:${id}`,
      name: job.name || id,
      schedule,
      prompt: redactText(typeof job.prompt === 'string' ? job.prompt : '').text,
      identityRef: '',
      enabledInSource: job.enabled !== false,
    });
  }
  return out;
}

function reportUnknownFields(config: HermesConfig, unsupportedItems: UnsupportedItem[]): void {
  const known = new Set([
    'version',
    'name',
    'persona',
    'model',
    'provider',
    'channels',
    'mcp_servers',
    'mcpServers',
    'toolsets',
    'agents',
    'skill_dirs',
    'gateway',
    'memory',
    'terminal',
    'tools',
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

    const responsibilities =
      identity.artifacts.map((a) => a.text).join('\n\n').trim() ||
      `Imported from the Hermes profile "${identity.displayName}".`;

    // A schedule is how a team member RUNS, so it belongs on the member. The
    // first becomes this identity's trigger; any others become team members of
    // their own below, because Liftoff gives each member exactly one trigger.
    // A schedule with no owner belongs to the FIRST identity, which is the
    // same fallback the routines list already uses. Hermes cron jobs carry no agent id at all, so `identityRef` is
    // empty for every one of them,
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
        responsibilities: job.prompt || `Recurring work imported from Hermes: ${job.name}.`,
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

  // Handoffs between registered definitions become relationships, never new
  // identities. A target that is not itself a registered definition is
  // reported rather than manufactured.
  const identityRefs = new Set(inv.identities.map((i) => i.sourceRef));
  for (const identity of inv.identities) {
    for (const target of identity.delegatesTo) {
      if (!identityRefs.has(target)) {
        unsupportedItems.push({
          sourceRef: identity.sourceRef,
          reason: 'transient_delegation_not_an_identity',
          detail:
            `"${identity.displayName}" hands off to "${target}", which is not a registered ` +
            'team member in this profile. No Liftoff team member was created for it.',
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
  const primaryIdentity = inv.identities[0]?.sourceRef ?? '';
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
      identitySourceRef: routine.identityRef || primaryIdentity,
      name: routine.name,
      cronExpr,
      prompt: routine.prompt,
      enabledInSource: routine.enabledInSource,
    });
  }

  return {
    bundleVersion: MIGRATION_BUNDLE_VERSION,
    source: 'hermes',
    sourceVersion: inv.installation.sourceVersion,
    adapterVersion: HERMES_ADAPTER_VERSION,
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

// ── pause guidance ─────────────────────────────────────────────────────

function pauseGuidance(installation: DetectedInstallation): PauseGuidance {
  const profileNote = installation.profile
    ? ` This profile is "${installation.profile}", so stop the gateway that owns it.`
    : '';

  return {
    command: 'hermes gateway stop',
    steps: [
      'Run the command below in your terminal to stop the Hermes gateway.',
      'If launchd or systemd owns the gateway, disable the corresponding service so it does not ' +
        'restart automatically.',
      'Leave your Hermes files in place. Liftoff does not delete or modify them.',
    ],
    supervisedNote:
      'Liftoff does not run this command and cannot confirm that Hermes has stopped. ' +
      'If equivalent schedules stay active in Hermes, the same work can run twice.' +
      profileNote,
  };
}

/** Drop an empty list rather than carrying `[]` across the wire, so a skill
 *  that declares nothing looks like a skill that declares nothing. */
function orUndefined(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined;
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
