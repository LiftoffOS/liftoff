// Liftoff Switch — OpenAI Codex source adapter.
//
// Codex keeps everything in one file, `~/.codex/config.toml`, and that file has
// a hazard the other sources do not: `~/.codex` is SHARED with the ChatGPT
// desktop app, which writes its own plumbing into it. A live installation
// carries `mcp_servers.node_repl` pointing into ChatGPT.app, a
// `computer-use` server, eight `[plugins.*]` entries from two bundled
// marketplaces, and a `[desktop]` block — none of which is the user's
// configuration and none of which is importable.
//
// So the vendor-internal filter runs FIRST, and it drops silently rather than
// reporting. An unsupported item is a message to a person, and "we could not
// import OpenAI's own node_repl" is not a message anybody needs; it is noise
// that makes the real list of gaps harder to read.
//
// Pinned upstream layout: openai/codex, config layering and skills discovery
// verified against its own source on 2026-09-08 (`codex-rs/config/src/loader`,
// `codex-rs/ext/skills/src/host_roots.rs`).
//
// Like Claude Code, Codex is not an always-on runtime: nothing to stop, no
// local scheduled work to double-execute.

import crypto from 'crypto';
import os from 'os';
import path from 'path';
import {
  type CatalogConnectorRequirement,
  type CustomMcpServerRequirement,
  type DetectOptions,
  type DetectedInstallation,
  type HostingRequirement,
  type ImportedGovernanceRule,
  type ImportedMemory,
  type ImportedModelPreference,
  type ImportedSkill,
  type MigrationBundleV1,
  type PauseGuidance,
  type RawArtifact,
  type RawIdentity,
  type RawMcpServer,
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
  readTextFile,
  readTomlFile,
  redactHome,
  walkFiles,
  type ScanBudget,
} from '../filesystem';
import { redactText } from '../secret-filter';
import {
  assertWithinDistillBounds,
  boundDiagnostics,
  normalizeIdentity,
  recordNormalizationLosses,
  type NormalizableArtifact,
} from '../normalizer';
import { mapToCatalogConnector } from './connector-map';
import { mapGovernancePolicies, type RawPolicy } from './governance-map';
import {
  declaredSecretNames,
  groupSkillFiles,
  readSkillFileSet,
  readSkillGroupText,
} from './skill-collection';
import { parseStdioPackage } from '../stdio-package';
import { splitScriptMembers } from './script-members';

export const CODEX_ADAPTER_VERSION = '1.0.0';

interface CodexConfig {
  model?: string;
  model_reasoning_effort?: string;
  personality?: string;
  approval_policy?: string;
  sandbox_mode?: string;
  notify?: unknown;
  mcp_servers?: Record<string, CodexMcpConfig>;
  projects?: Record<string, { trust_level?: string }>;
  marketplaces?: Record<string, unknown>;
  plugins?: Record<string, unknown>;
  desktop?: unknown;
  features?: unknown;
  [key: string]: unknown;
}

interface CodexMcpConfig {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export function codexAdapter(opts: DetectOptions & { includeProjects?: boolean } = {}): SourceAdapter {
  return {
    source: 'codex',
    adapterVersion: CODEX_ADAPTER_VERSION,
    detect: () => detect(opts),
    inventory: (installation) => inventory(installation, opts),
    normalize,
    pauseGuidance,
    searchPaths: (o) => resolveRoots({ ...opts, ...o }).map(redactHome),
  };
}

// ── the vendor-internal filter ─────────────────────────────────────────

/** Paths that mean "this is the desktop app's, not the user's". */
const VENDOR_PATH_MARKERS = ['ChatGPT.app', 'codex-runtimes', '/.codex/.tmp/'];

/** Marketplaces OpenAI ships. Plugins from these are product surface. */
const VENDOR_MARKETPLACES = ['openai-bundled', 'openai-primary-runtime'];

/** True when an MCP entry is the desktop app's own plumbing.
 *
 *  Dropped SILENTLY. Reporting it would fill a person's list of gaps with
 *  OpenAI's internals and bury the entries that are actually theirs. */
export function isVendorInternalMcp(name: string, cfg: CodexMcpConfig): boolean {
  if (name === 'node_repl' || name === 'computer-use') return true;

  const haystack = [cfg.command ?? '', ...(cfg.args ?? []), cfg.cwd ?? ''].join(' ');
  if (VENDOR_PATH_MARKERS.some((marker) => haystack.includes(marker))) return true;

  // An entry the user explicitly disabled is not part of their setup either.
  return cfg.enabled === false;
}

export function isVendorMarketplace(name: string): boolean {
  return VENDOR_MARKETPLACES.some((v) => name === v || name.endsWith(`@${v}`));
}

// ── detect ─────────────────────────────────────────────────────────────

export function resolveRoots(opts: DetectOptions): string[] {
  if (opts.path) return [path.resolve(opts.path)];
  const configured = process.env.CODEX_HOME;
  if (configured) return [path.resolve(configured)];
  return [path.join(os.homedir(), '.codex')];
}

/** The config file for a profile, when one is named.
 *
 *  Codex layers `${CODEX_HOME}/<name>.config.toml` over `config.toml`, so a
 *  named profile is a different effective configuration and must be resolved
 *  before anything is read. */
function configPathFor(root: string, profile?: string): string {
  return path.join(root, profile ? `${profile}.config.toml` : 'config.toml');
}

async function detect(opts: DetectOptions): Promise<DetectedInstallation[]> {
  const out: DetectedInstallation[] = [];

  for (const root of resolveRoots(opts)) {
    if (!dirExists(root)) continue;
    const configPath = configPathFor(root, opts.profile);
    if (!fileExists(configPath)) continue;

    const budget = newScanBudget();
    const version = readVersion(root, budget);

    out.push({
      source: 'codex',
      stateRoot: root,
      profile: opts.profile,
      sourceVersion: version,
      installationFingerprint: crypto
        .createHash('sha256')
        .update(`codex:${path.resolve(root)}:${opts.profile ?? ''}`)
        .digest('hex')
        .slice(0, 32),
      resolvedFrom: [redactHome(root), redactHome(configPath)],
    });
  }

  return out;
}

/** Version as the installation records it. No binary is executed. */
function readVersion(root: string, budget: ScanBudget): string | undefined {
  const versionPath = path.join(root, 'version.json');
  if (!fileExists(versionPath)) return undefined;
  const text = readTextFile(root, versionPath, budget);
  if (text === null) return undefined;
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

// ── inventory ──────────────────────────────────────────────────────────

async function inventory(
  installation: DetectedInstallation,
  opts: { includeProjects?: boolean } = {},
): Promise<SourceInventory> {
  const root = installation.stateRoot;
  const budget = newScanBudget();
  const unsupportedItems: UnsupportedItem[] = [];

  const config =
    readTomlFile<CodexConfig>(root, configPathFor(root, installation.profile), budget) ?? {};

  // ── instructions ────────────────────────────────────────────────────
  //
  // AGENTS.md is optional and its absence is ORDINARY: a live installation on
  // this machine had none. An adapter that treated that as a failure would
  // refuse the common case.
  const artifacts: RawArtifact[] = [];
  const agentsMd = path.join(root, 'AGENTS.md');
  if (fileExists(agentsMd)) {
    const text = readTextFile(root, agentsMd, budget);
    if (text !== null) {
      artifacts.push({
        sourcePath: redactHome(agentsMd),
        text: redactText(text).text,
        category: 'instructions',
      });
    }
  }

  // ── skills and prompts ──────────────────────────────────────────────
  const skills: RawSkill[] = [];
  collectSkillDir(path.join(root, 'skills'), skills, budget);
  // The cross-vendor root Codex also reads (`.agents/skills`).
  collectSkillDir(path.join(os.homedir(), '.agents', 'skills'), skills, budget);
  collectPromptDir(path.join(root, 'prompts'), skills, budget);

  // ── MCP servers ─────────────────────────────────────────────────────
  const mcpServers = collectMcpServers(config, unsupportedItems);

  // ── policies ────────────────────────────────────────────────────────
  const governanceRules = mapPolicies(config, root, unsupportedItems, budget);

  const modelPreference: ImportedModelPreference | undefined = config.model
    ? {
        model: config.model,
        note: [
          config.model_reasoning_effort ? `Reasoning effort: ${config.model_reasoning_effort}` : '',
          config.personality ? `Personality: ${config.personality}` : '',
        ]
          .filter(Boolean)
          .join('. ') || undefined,
      }
    : undefined;

  // ── projects ────────────────────────────────────────────────────────
  const projectPaths = Object.keys(config.projects ?? {});
  if (projectPaths.length > 0 && !opts.includeProjects) {
    budget.diagnostics.push(
      `${projectPaths.length} trusted project(s) were not scanned; re-run with --include-projects to bring their instructions across`,
    );
  }
  if (opts.includeProjects) {
    for (const projectPath of projectPaths) {
      if (!dirExists(projectPath)) continue;
      const projectAgents = path.join(projectPath, 'AGENTS.md');
      if (fileExists(projectAgents)) {
        const text = readTextFile(projectPath, projectAgents, budget);
        if (text !== null) {
          artifacts.push({
            sourcePath: redactHome(projectAgents),
            text: redactText(text).text,
            category: 'instructions',
          });
        }
      }
      collectSkillDir(path.join(projectPath, '.agents', 'skills'), skills, budget);
      collectSkillDir(path.join(projectPath, '.codex', 'skills'), skills, budget);

      // A repository can carry its own `.codex/config.toml`, and Codex layers
      // it over the user's. Only its MCP servers are read here: the model and
      // policy settings of a repo are that repo's, not this person's.
      const projectConfigPath = path.join(projectPath, '.codex', 'config.toml');
      if (fileExists(projectConfigPath)) {
        const projectConfig = readTomlFile<CodexConfig>(projectPath, projectConfigPath, budget);
        for (const server of collectMcpServers(projectConfig ?? {}, unsupportedItems)) {
          if (mcpServers.some((s) => s.name === server.name)) continue;
          mcpServers.push(server);
        }
      }
    }
  }

  // ── exclusions ──────────────────────────────────────────────────────
  reportExclusions(root, unsupportedItems);

  // ── identity ────────────────────────────────────────────────────────
  //
  // One per installation or profile. Codex has no sub-agent registry, so there
  // is nothing here that could become a second durable identity.
  const identity: RawIdentity = {
    sourceRef: installation.profile ? `profile:${installation.profile}` : 'profile:default',
    displayName: installation.profile ? `Codex (${installation.profile})` : 'Codex assistant',
    artifacts,
    memories: [],
    skills,
    modelPreference,
    integrationRefs: [],
    mcpServerRefs: mcpServers.map((s) => s.sourceRef),
    routineRefs: [],
    delegatesTo: [],
  };

  return {
    installation,
    identities: [identity],
    sharedArtifacts: [],
    mcpServers,
    routines: [],
    unsupportedItems,
    governanceRules,
    diagnostics: budget.diagnostics,
  };
}

function collectSkillDir(dir: string, out: RawSkill[], budget: ScanBudget): void {
  if (!dirExists(dir)) return;
  // The WHOLE directory: a skill's scripts and references are part of it.
  const files = walkFiles(dir, budget);
  for (const group of groupSkillFiles(dir, files, (f) => path.basename(f, '.md'))) {
    if (out.some((s) => s.name === group.name)) continue;
    const text = readSkillGroupText(dir, group, budget);
    if (text === null) continue;
    const fileSet = readSkillFileSet(dir, group, budget);
    const secretNames = declaredSecretNames(text);
    out.push({
      sourceRef: `skill:${group.name}`,
      name: group.name,
      text,
      sourcePath: redactHome(group.primaryPath),
      files: fileSet.files.length > 0 ? fileSet.files : undefined,
      binaryPaths: fileSet.binaries.length > 0 ? fileSet.binaries : undefined,
      referencedSecretNames: secretNames.length > 0 ? secretNames : undefined,
    });
  }
}

/** Custom prompts are reusable procedures: the same thing a skill is. */
function collectPromptDir(dir: string, out: RawSkill[], budget: ScanBudget): void {
  if (!dirExists(dir)) return;
  for (const file of walkFiles(dir, budget, { filter: (f) => f.endsWith('.md') })) {
    const name = path.basename(file, '.md');
    if (out.some((s) => s.name === name)) continue;
    const text = readTextFile(dir, file, budget);
    if (text === null) continue;
    out.push({
      sourceRef: `prompt:${name}`,
      name,
      text: redactText(text).text,
      sourcePath: redactHome(file),
    });
  }
}

function collectMcpServers(
  config: CodexConfig,
  unsupportedItems: UnsupportedItem[],
): RawMcpServer[] {
  const out: RawMcpServer[] = [];

  for (const [name, raw] of Object.entries(config.mcp_servers ?? {})) {
    if (!raw || typeof raw !== 'object') {
      unsupportedItems.push({
        sourceRef: `mcp:${name}`,
        reason: 'malformed_configuration',
        detail: `The MCP server "${name}" could not be read and was not imported.`,
      });
      continue;
    }
    const cfg = raw as CodexMcpConfig;

    // The filter runs FIRST and drops silently.
    if (isVendorInternalMcp(name, cfg)) continue;

    out.push({
      sourceRef: `mcp:${name}`,
      name,
      transport: cfg.url ? 'http' : 'stdio',
      url: cfg.url,
      command: cfg.command,
      args: cfg.args,
      authScheme: 'none',
      usedByIdentityRefs: [],
    });
  }

  return out;
}

/** `sandbox_mode` maps exactly; a deny rule maps exactly; nothing else does.
 *
 *  `approval_policy` deliberately does NOT map: it decides when the LOCAL
 *  client stops to ask its user, which is a different thing from Liftoff's
 *  per-tool approval gate. Calling them the same would hand somebody a
 *  guardrail they did not ask for, or claim one they did. */
function mapPolicies(
  config: CodexConfig,
  root: string,
  unsupportedItems: UnsupportedItem[],
  budget: ScanBudget,
): ImportedGovernanceRule[] {
  const policies: RawPolicy[] = [];

  if (typeof config.sandbox_mode === 'string') {
    policies.push({ key: 'sandbox', value: config.sandbox_mode !== 'danger-full-access' });
  }

  const denied = readDeniedPrefixRules(root, budget);
  if (denied.length > 0) policies.push({ key: 'deniedTools', value: denied });

  const mapped = mapGovernancePolicies('codex', policies);

  if (typeof config.approval_policy === 'string') {
    unsupportedItems.push({
      sourceRef: 'config:approval_policy',
      reason: 'policy_without_liftoff_equivalent',
      detail:
        `approval_policy "${config.approval_policy}" was not imported. It decides when Codex ` +
        'stops to ask you on this machine, which is not the same as Liftoff approving a tool.',
    });
  }

  return mapped.rules;
}

/** `rules/*.rules` holds `prefix_rule(pattern=[...], decision="allow"|"deny")`.
 *
 *  Only the deny half is carried. An allow prefix exists to stop Codex asking
 *  its user, and Liftoff has nothing that asks in that way — so importing it
 *  would map a prompt-suppression to a permission grant. */
function readDeniedPrefixRules(root: string, budget: ScanBudget): string[] {
  const rulesDir = path.join(root, 'rules');
  if (!dirExists(rulesDir)) return [];

  const denied: string[] = [];
  for (const file of walkFiles(rulesDir, budget, { filter: (f) => f.endsWith('.rules') })) {
    const text = readTextFile(rulesDir, file, budget);
    if (text === null) continue;
    for (const line of text.split('\n')) {
      if (!/decision\s*=\s*"deny"/.test(line)) continue;
      const pattern = /pattern\s*=\s*\[([^\]]*)\]/.exec(line);
      if (!pattern) continue;
      const command = pattern[1]
        .split(',')
        .map((p) => p.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
        .join(' ');
      if (command) denied.push(command);
    }
  }
  return denied;
}

function reportExclusions(root: string, unsupportedItems: UnsupportedItem[]): void {
  if (fileExists(path.join(root, 'memories_1.sqlite')) || dirExists(path.join(root, 'memories'))) {
    unsupportedItems.push({
      sourceRef: 'state:memories',
      reason: 'unknown_configuration_field',
      detail:
        'Codex memories were not imported: they are stored in a database whose layout is not ' +
        'documented, and importing a guess at it would produce memories that say the wrong thing.',
    });
  }

  for (const name of ['sessions', 'archived_sessions', 'history.jsonl']) {
    if (!fileExists(path.join(root, name))) continue;
    unsupportedItems.push({
      sourceRef: `state:${name}`,
      reason: 'session_history_excluded',
      detail: `${name} holds session history, which is never imported.`,
    });
  }
}

// ── normalize ──────────────────────────────────────────────────────────

async function normalize(inv: SourceInventory): Promise<MigrationBundleV1> {
  convertScriptSkills(inv);

  const unsupportedItems: UnsupportedItem[] = [...inv.unsupportedItems];
  const skills: ImportedSkill[] = [];
  const memories: ImportedMemory[] = [];
  const instructions: MigrationBundleV1['instructions'] = [];
  const modelPreferences: ImportedModelPreference[] = [];
  const lossNotes: string[] = [];

  const identity = inv.identities[0];

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
  ];

  const responsibilities = identity.artifacts.map((a) => a.text).join('\n\n').trim();

  const result = normalizeIdentity({
    sourceRef: identity.sourceRef,
    label: identity.displayName,
    responsibilities: responsibilities.length > 0
      ? responsibilities
      : 'Continue the work this Codex setup was used for.',
    artifacts,
    integrationRefs: identity.integrationRefs,
    mcpServerRefs: identity.mcpServerRefs,
    routineRefs: [],
    modelPreference: identity.modelPreference,
  });

  assertWithinDistillBounds(result.agent);
  unsupportedItems.push(...result.unsupportedItems);
  recordNormalizationLosses(lossNotes, identity.sourceRef, result);
  if (identity.modelPreference) modelPreferences.push(identity.modelPreference);

  for (const artifact of identity.artifacts) {
    instructions.push({
      sourceRef: `${identity.sourceRef}:${artifact.sourcePath}`,
      identitySourceRef: identity.sourceRef,
      name: path.basename(artifact.sourcePath),
      category: 'instructions',
      sourcePath: artifact.sourcePath,
    });
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

    // Named rather than dropped: a skill arriving without the script it
    // describes, with nothing said, is the failure this reports its way out of.
    for (const binary of skill.binaryPaths ?? []) {
      unsupportedItems.push({
        sourceRef: `${skill.sourceRef}:${binary}`,
        reason: 'binary_asset_excluded',
        detail: `${binary} is not a text file, so it was not imported with the ${skill.name} skill.`,
      });
    }
  }

  // ── connections ─────────────────────────────────────────────────────
  const catalogConnectorRequirements: CatalogConnectorRequirement[] = [];
  const customMcpServerRequirements: CustomMcpServerRequirement[] = [];
  const hostingRequirements: HostingRequirement[] = [];

  for (const server of inv.mcpServers) {
    const usedBy = [identity.sourceRef];

    const catalog = mapToCatalogConnector(server.name);
    if (catalog) {
      catalogConnectorRequirements.push({
        sourceRef: server.sourceRef,
        connectorType: catalog.connectorType,
        usedByIdentityRefs: usedBy,
        usedByRoutineRefs: [],
        authMethod: catalog.authMethod,
      });
      continue;
    }

    if (server.transport === 'http' && server.url) {
      customMcpServerRequirements.push({
        sourceRef: server.sourceRef,
        name: server.name,
        url: server.url,
        transport: 'http',
        authScheme: server.authScheme ?? 'none',
        customHeaderNames: server.customHeaderNames,
        usedByIdentityRefs: usedBy,
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
      usedByIdentityRefs: usedBy,
      packageIdentity: parseStdioPackage(server.command, server.args) ?? undefined,
    });
  }

  const bundle: MigrationBundleV1 = {
    bundleVersion: MIGRATION_BUNDLE_VERSION,
    source: 'codex',
    sourceVersion: inv.installation.sourceVersion,
    adapterVersion: CODEX_ADAPTER_VERSION,
    installationFingerprint: inv.installation.installationFingerprint,
    agents: [result.agent],
    agentRelationships: [],
    instructions,
    skills,
    memories,
    routines: [],
    catalogConnectorRequirements,
    customMcpServerRequirements,
    hostingRequirements,
    governanceRules: inv.governanceRules ?? [],
    modelPreferences,
    unsupportedItems,
    diagnostics: boundDiagnostics([...inv.diagnostics, ...lossNotes]),
  };

  return bundle;
}

// ── pause guidance ─────────────────────────────────────────────────────

function pauseGuidance(): PauseGuidance {
  return {
    steps: [
      'Nothing needs to be stopped. Codex runs only while you are using it, so there is no background process to pause.',
      'Your installation is left exactly as it was. Importing copies your setup and changes nothing on this machine.',
    ],
  };
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
