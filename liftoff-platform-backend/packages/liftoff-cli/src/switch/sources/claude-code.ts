// Liftoff Switch — Claude Code source adapter.
//
// Claude Code is not an always-on runtime. It has no gateway to stop and no
// local scheduled work to double-execute, so the cutover risk the first two
// adapters are built around does not exist here. What it has is the material
// that matters: standing instructions, skills, sub-agent definitions, MCP
// servers, and — the surface nothing else carries — the auto-memory directory,
// which is where months of "how this person works" actually accumulates.
//
// Pinned upstream layout: Claude Code 2.x (`~/.claude`, `~/.claude.json`),
// verified against a live installation on 2026-09-08.
//
// Two hazards this adapter is written around:
//
//   * `settings.json` is a KNOWN SECRET SURFACE. Its `env` block routinely
//     holds ANTHROPIC_API_KEY — Liftoff's own CLI writes one there. The block
//     is excluded structurally: names are read, values never are.
//   * Liftoff writes into this installation itself (the `liftoff` MCP entry,
//     `collab.md`, the proxy env). Importing those back would hand a
//     workspace a copy of its own plumbing, so they are recognised and skipped.
//
// Nothing found here is ever executed. Hooks, commands and skills are text.

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
  type ImportedRelationship,
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
  readJsonFile,
  readTextFile,
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

export const CLAUDE_CODE_ADAPTER_VERSION = '1.0.0';

/** Entries Liftoff itself wrote into this installation. Importing them back
 *  would give a workspace a duplicate of its own plumbing. */
const LIFTOFF_MCP_SERVER_NAME = 'liftoff';
const LIFTOFF_COLLAB_FILE = 'collab.md';

interface ClaudeSettings {
  model?: string;
  effortLevel?: string;
  env?: Record<string, string>;
  hooks?: Record<string, unknown>;
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  [key: string]: unknown;
}

interface ClaudeJson {
  mcpServers?: Record<string, ClaudeMcpConfig>;
  projects?: Record<string, ClaudeProjectEntry>;
  lastReleaseNotesSeen?: string;
  [key: string]: unknown;
}

interface ClaudeMcpConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface ClaudeProjectEntry {
  mcpServers?: Record<string, ClaudeMcpConfig>;
  hasTrustDialogAccepted?: boolean;
  [key: string]: unknown;
}

export function claudeCodeAdapter(opts: DetectOptions & { includeProjects?: boolean } = {}): SourceAdapter {
  return {
    source: 'claude-code',
    adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
    detect: () => detect(opts),
    inventory: (installation) => inventory(installation, opts),
    normalize,
    pauseGuidance,
    searchPaths: (o) => resolveRoots({ ...opts, ...o }).map(redactHome),
  };
}

// ── detect ─────────────────────────────────────────────────────────────

/** Where a Claude Code installation can live, in resolution order.
 *
 *  CLAUDE_CONFIG_DIR first, for the same reason the Hermes adapter resolves
 *  HERMES_HOME first: reading ~/.claude when the environment points elsewhere
 *  imports an installation the person is not using. */
export function resolveRoots(opts: DetectOptions): string[] {
  if (opts.path) return [path.resolve(opts.path)];
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured) return [path.resolve(configured)];
  return [path.join(os.homedir(), '.claude')];
}

/** The user-level MCP registry lives beside the state directory, not inside
 *  it. Derived from the resolved root so a non-standard install still finds
 *  its own file rather than the home directory's. */
function claudeJsonPathFor(root: string): string {
  return path.join(path.dirname(root), '.claude.json');
}

async function detect(opts: DetectOptions): Promise<DetectedInstallation[]> {
  const out: DetectedInstallation[] = [];

  for (const root of resolveRoots(opts)) {
    if (!dirExists(root)) continue;

    const budget = newScanBudget();
    const claudeJson = readJsonFile<ClaudeJson>(
      path.dirname(root),
      claudeJsonPathFor(root),
      budget,
    );

    out.push({
      source: 'claude-code',
      stateRoot: root,
      // No binary is executed to learn the version. The release-notes marker is
      // what the installation itself records, and it is enough to say which
      // generation of the layout this is.
      sourceVersion: typeof claudeJson?.lastReleaseNotesSeen === 'string'
        ? claudeJson.lastReleaseNotesSeen
        : undefined,
      installationFingerprint: fingerprintFor(root),
      resolvedFrom: [redactHome(root), redactHome(claudeJsonPathFor(root))],
    });
  }

  return out;
}

function fingerprintFor(root: string): string {
  return crypto.createHash('sha256').update(`claude-code:${path.resolve(root)}`).digest('hex').slice(0, 32);
}

// ── inventory ──────────────────────────────────────────────────────────

async function inventory(
  installation: DetectedInstallation,
  opts: { includeProjects?: boolean } = {},
): Promise<SourceInventory> {
  const root = installation.stateRoot;
  const budget = newScanBudget();
  const unsupportedItems: UnsupportedItem[] = [];

  const settings = readJsonFile<ClaudeSettings>(root, path.join(root, 'settings.json'), budget) ?? {};
  const claudeJson =
    readJsonFile<ClaudeJson>(path.dirname(root), claudeJsonPathFor(root), budget) ?? {};

  // ── instructions ────────────────────────────────────────────────────
  const artifacts: RawArtifact[] = [];

  const claudeMd = path.join(root, 'CLAUDE.md');
  if (fileExists(claudeMd)) {
    const text = readTextFile(root, claudeMd, budget);
    if (text !== null) {
      artifacts.push({
        sourcePath: redactHome(claudeMd),
        text: redactText(text).text,
        category: 'instructions',
      });
    }
  }

  const rulesDir = path.join(root, 'rules');
  if (dirExists(rulesDir)) {
    for (const file of walkFiles(rulesDir, budget, { filter: (f) => f.endsWith('.md') })) {
      // Liftoff's own collaboration instructions, written by `liftoff connect`.
      if (path.basename(file) === LIFTOFF_COLLAB_FILE) continue;
      const text = readTextFile(rulesDir, file, budget);
      if (text === null) continue;
      artifacts.push({
        sourcePath: redactHome(file),
        text: redactText(text).text,
        category: 'instructions',
      });
    }
  }

  // ── skills and commands ─────────────────────────────────────────────
  const skills: RawSkill[] = [];
  collectSkillDir(path.join(root, 'skills'), skills, budget);
  // A slash command is a reusable procedure someone wrote down: the same thing
  // a skill is, in a different directory.
  collectSkillDir(path.join(root, 'commands'), skills, budget);

  // ── memories ────────────────────────────────────────────────────────
  //
  // The highest-value surface here and the one no other importer carries.
  // Files live under projects/<slug>/memory/ and carry a `type:` in their
  // frontmatter, which is what decides scope.
  const memories: RawArtifact[] = [];
  const projectsDir = path.join(root, 'projects');
  if (dirExists(projectsDir)) {
    for (const file of walkFiles(projectsDir, budget, {
      filter: (f) => f.endsWith('.md') && f.includes(`${path.sep}memory${path.sep}`),
    })) {
      // The index is a table of contents for the others; its content is
      // pointers, not memory.
      if (path.basename(file) === 'MEMORY.md') continue;
      const text = readTextFile(projectsDir, file, budget);
      if (text === null) continue;
      memories.push({
        sourcePath: redactHome(file),
        text: redactText(text).text,
        category: 'memory',
      });
    }
  }

  // ── MCP servers ─────────────────────────────────────────────────────
  const mcpServers = collectMcpServers(claudeJson, unsupportedItems);

  // ── hooks, permissions, model ───────────────────────────────────────
  reportHooks(settings, unsupportedItems);
  const governanceRules = mapPermissions(settings, unsupportedItems);
  reportEnvExclusion(settings, unsupportedItems);

  const modelPreference: ImportedModelPreference | undefined = settings.model
    ? {
        model: settings.model,
        note: settings.effortLevel ? `Effort level: ${settings.effortLevel}` : undefined,
      }
    : undefined;

  // ── projects ────────────────────────────────────────────────────────
  const projectPaths = Object.keys(claudeJson.projects ?? {});
  if (projectPaths.length > 0 && !opts.includeProjects) {
    budget.diagnostics.push(
      `${projectPaths.length} registered project(s) were not scanned; re-run with --include-projects to bring their instructions across`,
    );
  }
  const projectSubagents: RawIdentity[] = [];
  if (opts.includeProjects) {
    collectProjectMaterial(projectPaths, artifacts, skills, projectSubagents, budget);
    collectProjectMcpServers(projectPaths, mcpServers, budget);
  }

  // ── identities ──────────────────────────────────────────────────────
  const identities: RawIdentity[] = [];
  const integrationRefs = mcpServers.flatMap((s) => s.usedByIdentityRefs.length === 0 ? [s.sourceRef] : []);

  const primaryRef = 'assistant:primary';
  identities.push({
    sourceRef: primaryRef,
    displayName: 'Claude Code assistant',
    artifacts,
    memories,
    skills,
    modelPreference,
    integrationRefs: [],
    mcpServerRefs: mcpServers.map((s) => s.sourceRef),
    routineRefs: [],
    delegatesTo: [],
  });
  void integrationRefs;

  // Sub-agents are DURABLE identities: user-authored files with names, not
  // records of something a session spawned. The same distinction the Hermes
  // adapter draws between a registered agent and a transient worker.
  const agentsDir = path.join(root, 'agents');
  if (dirExists(agentsDir)) {
    for (const file of walkFiles(agentsDir, budget, { filter: (f) => f.endsWith('.md') })) {
      const text = readTextFile(agentsDir, file, budget);
      if (text === null) continue;
      const name = path.basename(file, '.md');
      const ref = `subagent:${name}`;
      identities.push({
        sourceRef: ref,
        displayName: name,
        artifacts: [
          { sourcePath: redactHome(file), text: redactText(text).text, category: 'instructions' },
        ],
        memories: [],
        skills: [],
        integrationRefs: [],
        mcpServerRefs: [],
        routineRefs: [],
        delegatesTo: [],
      });
      identities[0].delegatesTo.push(ref);
    }
  }

  // Sub-agents found inside the person's own projects, when they opted into
  // that scan. Deduped against the user-level ones by name: the same sub-agent
  // vendored into a repo is one team member, not two.
  for (const subagent of projectSubagents) {
    if (identities.some((i) => i.sourceRef === subagent.sourceRef)) continue;
    identities.push(subagent);
    identities[0].delegatesTo.push(subagent.sourceRef);
  }

  // ── what does not come across ───────────────────────────────────────
  reportExclusions(root, unsupportedItems, budget);

  return {
    installation,
    identities,
    sharedArtifacts: [],
    mcpServers,
    routines: [],
    unsupportedItems,
    governanceRules,
    diagnostics: budget.diagnostics,
  };
}

/** Read one directory of SKILL.md-style skills into `out`. */
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

function collectMcpServers(
  claudeJson: ClaudeJson,
  unsupportedItems: UnsupportedItem[],
): RawMcpServer[] {
  const out: RawMcpServer[] = [];
  const seen = new Set<string>();

  const add = (name: string, cfg: ClaudeMcpConfig): void => {
    // Liftoff's own MCP entry, written by `liftoff connect`. Importing it would
    // point a workspace at itself.
    if (name === LIFTOFF_MCP_SERVER_NAME) return;
    if (seen.has(name)) return;
    seen.add(name);

    if (!cfg || typeof cfg !== 'object') {
      unsupportedItems.push({
        sourceRef: `mcp:${name}`,
        reason: 'malformed_configuration',
        detail: `The MCP server "${name}" could not be read and was not imported.`,
      });
      return;
    }

    const transport: 'http' | 'stdio' = cfg.url ? 'http' : 'stdio';
    out.push({
      sourceRef: `mcp:${name}`,
      name,
      transport,
      url: cfg.url,
      command: cfg.command,
      args: cfg.args,
      authScheme: inferAuthScheme(cfg),
      // Header NAMES only. A header value is a credential.
      customHeaderNames: cfg.headers ? Object.keys(cfg.headers) : undefined,
      usedByIdentityRefs: [],
    });
  };

  for (const [name, cfg] of Object.entries(claudeJson.mcpServers ?? {})) add(name, cfg);
  for (const project of Object.values(claudeJson.projects ?? {})) {
    for (const [name, cfg] of Object.entries(project?.mcpServers ?? {})) add(name, cfg);
  }

  return out;
}

/** A project's own `.mcp.json`, which is checked into the repository rather
 *  than registered in `~/.claude.json`. Only read when the person opted into
 *  scanning their projects. */
function collectProjectMcpServers(
  projectPaths: string[],
  out: RawMcpServer[],
  budget: ScanBudget,
): void {
  for (const projectPath of projectPaths) {
    if (!dirExists(projectPath)) continue;
    const mcpJsonPath = path.join(projectPath, '.mcp.json');
    if (!fileExists(mcpJsonPath)) continue;

    const parsed = readJsonFile<{ mcpServers?: Record<string, ClaudeMcpConfig> }>(
      projectPath,
      mcpJsonPath,
      budget,
    );
    for (const [name, cfg] of Object.entries(parsed?.mcpServers ?? {})) {
      if (name === LIFTOFF_MCP_SERVER_NAME) continue;
      if (out.some((s) => s.name === name)) continue;
      if (!cfg || typeof cfg !== 'object') continue;
      out.push({
        sourceRef: `mcp:${name}`,
        name,
        transport: cfg.url ? 'http' : 'stdio',
        url: cfg.url,
        command: cfg.command,
        args: cfg.args,
        authScheme: inferAuthScheme(cfg),
        customHeaderNames: cfg.headers ? Object.keys(cfg.headers) : undefined,
        usedByIdentityRefs: [],
      });
    }
  }
}

function inferAuthScheme(cfg: ClaudeMcpConfig): 'none' | 'api_key' | 'bearer' | 'custom_headers' {
  const headerNames = Object.keys(cfg.headers ?? {}).map((h) => h.toLowerCase());
  if (headerNames.includes('authorization')) return 'bearer';
  if (headerNames.some((h) => h.includes('api-key') || h.includes('apikey'))) return 'api_key';
  if (headerNames.length > 0) return 'custom_headers';
  return 'none';
}

/** Hooks are shell commands this installation runs on lifecycle events.
 *
 *  They are reported, never carried. The command text names paths, binaries and
 *  scripts on that machine, and Liftoff runs agents in a cloud sandbox — so an
 *  imported hook could not run. More importantly it is an ENFORCEMENT
 *  mechanism, and Liftoff has exactly one of those; a second, per-tenant one
 *  living outside the governance engine is the shape of defect this codebase
 *  keeps paying for. */
function reportHooks(settings: ClaudeSettings, unsupportedItems: UnsupportedItem[]): void {
  for (const event of Object.keys(settings.hooks ?? {})) {
    unsupportedItems.push({
      sourceRef: `hook:${event}`,
      reason: 'executable_plugin',
      detail:
        `The ${event} hook runs a command on your machine and was not imported. ` +
        'Liftoff enforces tool policy through its governance rules instead.',
    });
  }
}

/** `deny` and `ask` have exact Liftoff equivalents. `allow` does not, and that
 *  is not a gap: an allow entry exists to stop the local client prompting, and
 *  Liftoff has nothing that prompts in that way. */
function mapPermissions(
  settings: ClaudeSettings,
  unsupportedItems: UnsupportedItem[],
): ImportedGovernanceRule[] {
  const policies: RawPolicy[] = [];
  const deny = settings.permissions?.deny ?? [];
  const ask = settings.permissions?.ask ?? [];
  if (deny.length > 0) policies.push({ key: 'deniedTools', value: deny });
  if (ask.length > 0) policies.push({ key: 'approvalRequired', value: ask });

  const mapped = mapGovernancePolicies('claude-code', policies);
  for (const key of mapped.unmappedKeys) {
    unsupportedItems.push({
      sourceRef: `permission:${key}`,
      reason: 'policy_without_liftoff_equivalent',
      detail: `The ${key} permission setting has no Liftoff equivalent and was not imported.`,
    });
  }

  const allow = settings.permissions?.allow ?? [];
  if (allow.length > 0) {
    unsupportedItems.push({
      sourceRef: 'permission:allow',
      reason: 'policy_without_liftoff_equivalent',
      detail:
        `${allow.length} allow rule(s) were not imported. They exist to stop your local ` +
        'client asking for confirmation, which Liftoff does not do.',
    });
  }

  return mapped.rules;
}

/** The env block is excluded structurally, and said out loud.
 *
 *  Names are read so the review surface can offer to re-enter each value into
 *  the workspace locker. The VALUES are never read: this is the file Liftoff's
 *  own CLI writes an API key into. */
function reportEnvExclusion(settings: ClaudeSettings, unsupportedItems: UnsupportedItem[]): void {
  const names = Object.keys(settings.env ?? {});
  if (names.length === 0) return;
  unsupportedItems.push({
    sourceRef: 'settings:env',
    reason: 'credential_excluded',
    detail:
      `${names.length} environment value(s) were not read: ${names.join(', ')}. ` +
      'Provide any that your skills need in Liftoff, where they are stored as secrets.',
  });
}

function reportExclusions(
  root: string,
  unsupportedItems: UnsupportedItem[],
  budget: ScanBudget,
): void {
  for (const dir of ['sessions', 'projects', 'file-history', 'todos', 'history.jsonl']) {
    if (!fileExists(path.join(root, dir))) continue;
    if (dir === 'projects') continue; // scanned above for memory only
    unsupportedItems.push({
      sourceRef: `state:${dir}`,
      reason: 'session_history_excluded',
      detail: `${dir} holds session transcripts and history, which are never imported.`,
    });
  }

  if (dirExists(path.join(root, 'plugins'))) {
    unsupportedItems.push({
      sourceRef: 'state:plugins',
      reason: 'executable_plugin',
      detail:
        'Installed plugins were not imported as units. Any skills or commands they provide are ' +
        'imported with the rest.',
    });
  }

  // Scheduled work lives in the Claude account, not on this machine, so there
  // is nothing here to read. Said plainly rather than silently omitted.
  budget.diagnostics.push(
    'scheduled routines live in the Claude account rather than on this machine and were not scanned',
  );
}

/** Per-project material, only when the user opted in.
 *
 *  Reading inside someone's repositories is a different consent posture from
 *  reading their own config directory, which is why it is not the default. */
function collectProjectMaterial(
  projectPaths: string[],
  artifacts: RawArtifact[],
  skills: RawSkill[],
  subagents: RawIdentity[],
  budget: ScanBudget,
): void {
  for (const projectPath of projectPaths) {
    if (!dirExists(projectPath)) continue;

    const projectClaudeMd = path.join(projectPath, 'CLAUDE.md');
    if (fileExists(projectClaudeMd)) {
      const text = readTextFile(projectPath, projectClaudeMd, budget);
      if (text !== null) {
        artifacts.push({
          sourcePath: redactHome(projectClaudeMd),
          text: redactText(text).text,
          category: 'instructions',
        });
      }
    }

    const projectRules = path.join(projectPath, '.claude', 'rules');
    if (dirExists(projectRules)) {
      for (const file of walkFiles(projectRules, budget, { filter: (f) => f.endsWith('.md') })) {
        const text = readTextFile(projectRules, file, budget);
        if (text === null) continue;
        artifacts.push({
          sourcePath: redactHome(file),
          text: redactText(text).text,
          category: 'instructions',
        });
      }
    }

    collectSkillDir(path.join(projectPath, '.claude', 'skills'), skills, budget);

    // A project's own sub-agents are durable identities in exactly the way the
    // user-level ones are: files somebody wrote and named.
    const projectAgents = path.join(projectPath, '.claude', 'agents');
    if (dirExists(projectAgents)) {
      for (const file of walkFiles(projectAgents, budget, { filter: (f) => f.endsWith('.md') })) {
        const text = readTextFile(projectAgents, file, budget);
        if (text === null) continue;
        const name = path.basename(file, '.md');
        if (subagents.some((s) => s.displayName === name)) continue;
        subagents.push({
          sourceRef: `subagent:${name}`,
          displayName: name,
          artifacts: [
            { sourcePath: redactHome(file), text: redactText(text).text, category: 'instructions' },
          ],
          memories: [],
          skills: [],
          integrationRefs: [],
          mcpServerRefs: [],
          routineRefs: [],
          delegatesTo: [],
        });
      }
    }
  }
}

// ── normalize ──────────────────────────────────────────────────────────

async function normalize(inv: SourceInventory): Promise<MigrationBundleV1> {
  convertScriptSkills(inv);

  const unsupportedItems: UnsupportedItem[] = [...inv.unsupportedItems];
  const agents: MigrationBundleV1['agents'] = [];
  const agentRelationships: ImportedRelationship[] = [];
  const instructions: MigrationBundleV1['instructions'] = [];
  const skills: ImportedSkill[] = [];
  const memories: ImportedMemory[] = [];
  const modelPreferences: ImportedModelPreference[] = [];
  const lossNotes: string[] = [];

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

    const responsibilities = identity.artifacts.map((a) => a.text).join('\n\n').trim();

    const result = normalizeIdentity({
      sourceRef: identity.sourceRef,
      label: identity.displayName,
      responsibilities: responsibilities.length > 0
        ? responsibilities
        : `Continue the work this ${identity.displayName} was set up for.`,
      artifacts,
      integrationRefs: identity.integrationRefs,
      mcpServerRefs: identity.mcpServerRefs,
      routineRefs: [],
      modelPreference: identity.modelPreference,
    });

    assertWithinDistillBounds(result.agent);
    agents.push(result.agent);
    unsupportedItems.push(...result.unsupportedItems);
    recordNormalizationLosses(lossNotes, identity.sourceRef, result);

    if (identity.modelPreference) modelPreferences.push(identity.modelPreference);

    for (const target of identity.delegatesTo) {
      agentRelationships.push({
        fromSourceRef: identity.sourceRef,
        toSourceRef: target,
        kind: 'delegates_to',
      });
    }

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

    for (const memory of identity.memories) {
      memories.push({
        sourceRef: `memory:${memory.sourcePath}`,
        identitySourceRef: identity.sourceRef,
        content: memory.text,
        // Scope decides consent. `type: user` and `type: feedback` describe the
        // PERSON and how they want to be worked with, which is workspace-wide
        // and therefore consented; everything else is this member's own context
        // and lands immediately.
        scope: memoryScopeFor(memory.text),
        sourcePath: memory.sourcePath,
      });
    }
  }

  // ── connections ─────────────────────────────────────────────────────
  const catalogConnectorRequirements: CatalogConnectorRequirement[] = [];
  const customMcpServerRequirements: CustomMcpServerRequirement[] = [];
  const hostingRequirements: HostingRequirement[] = [];

  for (const server of inv.mcpServers) {
    const usedBy = inv.identities
      .filter((i) => i.mcpServerRefs.includes(server.sourceRef))
      .map((i) => i.sourceRef);

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
    source: 'claude-code',
    sourceVersion: inv.installation.sourceVersion,
    adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
    installationFingerprint: inv.installation.installationFingerprint,
    agents,
    agentRelationships,
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

/** Which memories are workspace-wide.
 *
 *  The files carry a `type:` in their frontmatter. `user` and `feedback`
 *  describe the person and how they want to be worked with, which every member
 *  should know — workspace scope, and therefore consented before it lands
 *  (invariant 9). `project` and `reference` are this member's own context and
 *  land immediately. */
export function memoryScopeFor(text: string): 'agent' | 'workspace' {
  const match = /^\s*type:\s*([a-z]+)/mi.exec(text);
  const type = match?.[1]?.toLowerCase();
  return type === 'user' || type === 'feedback' ? 'workspace' : 'agent';
}

// ── pause guidance ─────────────────────────────────────────────────────

/** There is nothing to pause, and saying so is the honest answer.
 *
 *  Claude Code runs when the person runs it. It has no gateway holding
 *  connections and no local scheduled work, so the duplicate-execution risk the
 *  OpenClaw and Hermes guidance is built around does not exist here. */
function pauseGuidance(): PauseGuidance {
  return {
    steps: [
      'Nothing needs to be stopped. Claude Code runs only while you are using it, so there is no background process to pause.',
      'Your installation is left exactly as it was. Importing copies your setup and changes nothing on this machine.',
      'Scheduled work you created in your Claude account keeps running there. Recreate anything you want Liftoff to own as a trigger on the team member.',
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
