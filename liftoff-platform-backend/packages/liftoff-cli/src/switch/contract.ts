// Liftoff Switch — source-neutral migration contract.
//
// This module is a TRANSPORT format, not a persistent agent model. Nothing here
// is written to a Liftoff column verbatim: the backend feeds the normalized
// material to the canonical distiller, which is the only agent-provisioning
// path (see docs/switch-implementation-plan.md §6).
//
// Every adapter — OpenClaw first, Hermes second — implements SourceAdapter and
// produces MigrationBundleV1. The Hermes adapter is the proof that this contract
// is genuinely source-neutral: it should land with adapter-local changes only.

/** Sources this importer can read. DeerFlow, Omnigent and Agno are deferred and
 *  deliberately absent — the contract stays extensible without carrying unused
 *  source-specific fields.
 *
 *  Claude Code and Codex are a different shape from the first two: neither is
 *  an always-on runtime, so neither has a daemon to stop or local scheduled
 *  work to double-execute. What they have is the same durable material —
 *  instructions, skills, MCP servers, memory — which is what this contract
 *  carries. */
export type MigrationSource = 'openclaw' | 'hermes' | 'claude-code' | 'codex';

export const MIGRATION_BUNDLE_VERSION = 1 as const;

// ── Detection and inventory ────────────────────────────────────────────

/** A source installation located on this machine. Detection never mutates the
 *  installation it finds. */
export interface DetectedInstallation {
  source: MigrationSource;
  /** Resolved state root (after environment-variable and profile overrides). */
  stateRoot: string;
  /** Named profile, when the source supports profiles and one is in use. */
  profile?: string;
  /** Version string read from the installation, when it exposes one. */
  sourceVersion?: string;
  /** Stable, non-secret fingerprint of this installation. Used to key a
   *  migration so a re-run resumes rather than starting over. */
  installationFingerprint: string;
  /** Paths that were consulted to resolve this installation. Support-visible
   *  diagnostics; contains no file contents. */
  resolvedFrom: string[];
}

/** Raw material read from an installation, before normalization. Adapters put
 *  source-shaped data here; nothing in this type reaches Liftoff directly. */
export interface SourceInventory {
  installation: DetectedInstallation;
  identities: RawIdentity[];
  /** Files read for the whole installation rather than one identity
   *  (workspace-level instructions, shared skills). */
  sharedArtifacts: RawArtifact[];
  mcpServers: RawMcpServer[];
  routines: RawRoutine[];
  /** Anything the adapter recognised but cannot carry forward. */
  unsupportedItems: UnsupportedItem[];
  /** Declarative policies with an EXACT Liftoff equivalent. Anything that only
   *  half-maps is reported as unsupported instead: a guardrail the user thinks
   *  came across but did not is worse than one they know is missing. */
  governanceRules?: ImportedGovernanceRule[];
  /** Non-secret notes for the support view. Never contains file contents. */
  diagnostics: string[];
}

/** One persistent source identity — an OpenClaw agent, a Hermes profile. A
 *  transient delegated subagent is NOT an identity and must never become one. */
export interface RawIdentity {
  /** Stable reference within the source installation. Combined with the
   *  migration id this is the idempotency key for the whole item. */
  sourceRef: string;
  displayName: string;
  /** Instruction text keyed by its source path. */
  artifacts: RawArtifact[];
  memories: RawArtifact[];
  skills: RawSkill[];
  modelPreference?: ImportedModelPreference;
  /** Connector/channel types this identity used, by source name. */
  integrationRefs: string[];
  mcpServerRefs: string[];
  routineRefs: string[];
  /** Agent-to-agent permissions, as source refs of other PERSISTENT
   *  identities. A transient delegated worker is never listed here: it is not
   *  a durable identity and must not become a Liftoff team member. */
  delegatesTo: string[];
}

export interface RawArtifact {
  /** Absolute path inside the source installation. */
  sourcePath: string;
  /** Post-secret-filter text. The filter runs before this value is set. */
  text: string;
  category: ArtifactCategory;
}

export interface RawSkill {
  sourceRef: string;
  name: string;
  /** Skill body text, post-secret-filter. */
  text: string;
  sourcePath: string;
  /** The skill's own files (`scripts/`, `references/`), post-secret-filter.
   *  Text only — see ImportedSkill.files. */
  files?: ImportedSkillFile[];
  /** Relative paths of files refused for being unscannable. Reported per file
   *  as an unsupported item, never dropped in silence. */
  binaryPaths?: string[];
  /** Environment variable NAMES the skill declares it needs. Never values. */
  referencedSecretNames?: string[];
  /** Binaries the skill declares it needs on the machine running it. Carried
   *  as a note: they exist on the author's laptop, not in a cloud sandbox. */
  requiredBinaries?: string[];
}

export interface RawMcpServer {
  sourceRef: string;
  name: string;
  /** 'http' when the definition names a reachable endpoint; 'stdio' when it
   *  launches a local command. The two take completely different paths. */
  transport: 'http' | 'stdio';
  url?: string;
  /** Command and args are recorded for the review surface ONLY. They are never
   *  executed, and a stdio server never becomes a connector row. */
  command?: string;
  args?: string[];
  authScheme?: McpAuthScheme;
  /** Header NAMES only. Values are never read into the bundle. */
  customHeaderNames?: string[];
  usedByIdentityRefs: string[];
}

export type McpAuthScheme = 'none' | 'api_key' | 'bearer' | 'custom_headers';

export interface RawRoutine {
  sourceRef: string;
  name: string;
  /** Cron expression in the source's own dialect. */
  schedule: string;
  prompt: string;
  identityRef: string;
  enabledInSource: boolean;
}

// ── The normalized bundle ──────────────────────────────────────────────

export type ArtifactCategory = 'instructions' | 'skill' | 'memory' | 'routine';

/** Memory scope decides consent. Agent-scoped context lands immediately;
 *  workspace-scoped context requires explicit consent (invariant 9). */
export type MemoryScope = 'agent' | 'workspace';

export interface ImportedAgent {
  sourceRef: string;
  /** Bounded to the canonical distill schema before it ever leaves the machine
   *  (see normalizer.ts). At most 255 characters. */
  role: string;
  /** At most 10,000 characters. Overflow lives in an attachment. */
  responsibilities: string;
  /** At most 10,000 characters. Overflow lives in an attachment. */
  additionalContext?: string;
  /** Original, unbounded display label preserved for the review surface when
   *  `role` had to be shortened. */
  originalLabel?: string;
  attachments: ImportedAttachment[];
  integrationRefs: string[];
  mcpServerRefs: string[];
  routineRefs: string[];
  /** How this team member runs. A schedule in the source is not a separate
   *  object beside the agent — it IS the agent's trigger, which is the only
   *  thing Liftoff models (internal_agents.trigger_config, one per member). */
  cronExpr?: string;
  modelPreference?: ImportedModelPreference;
}

/** A packed attachment. Absorption classifies each attachment as a unit, so a
 *  packed attachment is always category-homogeneous. */
export interface ImportedAttachment {
  name: string;
  /** At most 100,000 characters. */
  content: string;
  category: ArtifactCategory;
  /** Source paths packed into this attachment, in order, with their boundaries
   *  preserved in the content body. */
  sourcePaths: string[];
}

export interface ImportedRelationship {
  fromSourceRef: string;
  toSourceRef: string;
  kind: 'delegates_to' | 'shares_workspace';
}

export interface ImportedArtifact {
  sourceRef: string;
  identitySourceRef?: string;
  name: string;
  category: ArtifactCategory;
  sourcePath: string;
}

export interface ImportedSkill {
  sourceRef: string;
  identitySourceRef: string;
  name: string;
  content: string;
  sourcePath: string;
  /** Environment variable NAMES this skill expects to be set — never values.
   *
   *  Both sources declare these structurally (OpenClaw's `requires.env` and
   *  `primaryEnv`, the `env` block on a stdio MCP entry), so this is read, not
   *  guessed at from script text. The value stays on the user's machine and is
   *  re-entered into the workspace locker on our side, which is the same rule
   *  the MCP header names follow: carry the requirement, never the credential. */
  referencedSecretNames?: string[];
  /** The skill's own files: `scripts/`, `references/`, `examples/`.
   *
   *  TEXT only. The secret filter reads text and cannot scan a binary, and a
   *  file nobody can scan must not travel from a customer's machine into shared
   *  storage. A binary is reported as an unsupported item naming the file,
   *  never dropped in silence. */
  files?: ImportedSkillFile[];
}

export interface ImportedSkillFile {
  /** Path relative to the skill root, e.g. `scripts/run.py`. Always relative
   *  and never containing `..`: it is joined onto a sandbox directory. */
  path: string;
  text: string;
  executable?: boolean;
}

export interface ImportedMemory {
  sourceRef: string;
  identitySourceRef: string;
  content: string;
  scope: MemoryScope;
  sourcePath: string;
}

export interface ImportedRoutine {
  sourceRef: string;
  identitySourceRef: string;
  name: string;
  /** Normalized to a standard 5-field cron expression where the source dialect
   *  permits; adapters report anything they cannot convert as unsupported. */
  cronExpr: string;
  prompt: string;
  /** Whether the routine was enabled in the source. Recorded for the review
   *  surface; imported routines are created disabled regardless, and stay
   *  disabled until cutover. */
  enabledInSource: boolean;
}

/** A source integration that matches a Liftoff catalog connector. Carries a
 *  requirement, NEVER a credential — this holds even when the source contains a
 *  static API key that could technically be read. */
export interface CatalogConnectorRequirement {
  sourceRef: string;
  /** Liftoff's canonical connector type. */
  connectorType: string;
  usedByIdentityRefs: string[];
  usedByRoutineRefs: string[];
  /** Non-secret account label, when the source exposes one safely. */
  externalAccountLabel?: string;
  /** Authorization method from Liftoff's catalog. */
  authMethod?: string;
}

/** A customer-owned MCP server Liftoff can reach over HTTP. */
export interface CustomMcpServerRequirement {
  sourceRef: string;
  name: string;
  url: string;
  transport: 'http';
  authScheme: McpAuthScheme;
  /** Header names only — never values. */
  customHeaderNames?: string[];
  usedByIdentityRefs: string[];
}

export interface ImportedGovernanceRule {
  sourceRef: string;
  identitySourceRef?: string;
  /** Only rules with exact Liftoff semantics are carried. Anything else is an
   *  unsupported item. */
  kind: string;
  description: string;
}

export interface ImportedModelPreference {
  provider?: string;
  model?: string;
  /** Recorded as a preference only. The source harness selection never implies
   *  identical Liftoff behaviour. */
  note?: string;
}

export type UnsupportedReason =
  | 'stdio_mcp_requires_hosting'
  | 'unreachable_mcp_endpoint'
  | 'executable_plugin'
  | 'policy_without_liftoff_equivalent'
  | 'transient_delegation_not_an_identity'
  | 'session_history_excluded'
  | 'credential_excluded'
  | 'unknown_configuration_field'
  | 'unsupported_source_version'
  | 'attachment_overflow'
  | 'integration_overflow'
  | 'unconvertible_schedule'
  | 'malformed_configuration'
  /** A skill file that is not text. Reported per file rather than dropped:
   *  the secret filter cannot scan it, so it cannot travel. */
  | 'binary_asset_excluded';

export interface UnsupportedItem {
  sourceRef: string;
  reason: UnsupportedReason;
  /** Human-readable, secret-free explanation shown in the review surface. */
  detail: string;
  sourcePath?: string;
}

/** Package registries a stdio command can resolve to. `nuget` and `mcpb` exist
 *  in the MCP registry and are deliberately absent: this parser does not
 *  produce them, and admitting a value nothing can emit invites a reader to
 *  handle a case that never arrives. */
export type McpPackageRegistryType = 'npm' | 'pypi' | 'oci';

/** The published package a local stdio command actually runs.
 *
 *  The CLI RECORDS this and never resolves it. Resolution needs the official
 *  MCP registry, and a lookup table baked into a shipped CLI would answer from
 *  whatever the ecosystem looked like on the day that version was built —
 *  frozen into every installed copy. The server resolves it live instead. */
export interface McpPackageIdentity {
  registryType: McpPackageRegistryType;
  /** The package as the command names it. An OCI identifier keeps its tag
   *  here; the comparison on the server side is what ignores it. */
  name: string;
}

/** A local stdio / private / unreachable MCP server. Deliberately NOT a
 *  connector row and NOT a custom_mcp_servers row: it has no callable endpoint,
 *  so it is carried as an unresolved requirement and shown as Requires hosting. */
export interface HostingRequirement {
  sourceRef: string;
  name: string;
  /** Recorded for display so the user can recognise which server this was.
   *  Never executed. */
  command?: string;
  args?: string[];
  url?: string;
  reason: 'stdio_mcp_requires_hosting' | 'unreachable_mcp_endpoint';
  usedByIdentityRefs: string[];
  /** Set when the command names a published package. Absent for someone's
   *  in-house script, which is exactly the case that stays a hosting card. */
  packageIdentity?: McpPackageIdentity;
}

export interface MigrationBundleV1 {
  bundleVersion: typeof MIGRATION_BUNDLE_VERSION;
  source: MigrationSource;
  sourceVersion?: string;
  adapterVersion: string;
  installationFingerprint: string;

  agents: ImportedAgent[];
  agentRelationships: ImportedRelationship[];
  instructions: ImportedArtifact[];
  skills: ImportedSkill[];
  memories: ImportedMemory[];
  routines: ImportedRoutine[];
  catalogConnectorRequirements: CatalogConnectorRequirement[];
  customMcpServerRequirements: CustomMcpServerRequirement[];
  hostingRequirements: HostingRequirement[];
  governanceRules: ImportedGovernanceRule[];
  modelPreferences: ImportedModelPreference[];
  unsupportedItems: UnsupportedItem[];
  /** What the normalizer had to give up, in plain language, for support to read
   *  later. Never file contents and never a path outside the source root.
   *
   *  This exists because the alternative was computing the fact and discarding
   *  it: overflow packing decided what to drop and nothing recorded the
   *  decision, so "my instructions file did not come across" had no answer.
   *  It is deliberately NOT shown to the person importing — "pick four files to
   *  delete" is not a question anyone can answer well. */
  diagnostics?: string[];
}

// ── Adapter lifecycle ──────────────────────────────────────────────────

/** Manual pause guidance for a source. Liftoff DISPLAYS this and never executes
 *  it: the user owns the decision to stop their incumbent platform. */
export interface PauseGuidance {
  /** Ordered, human-readable steps. */
  steps: string[];
  /** The command a user would run, when the source has a single one. Shown as
   *  copyable text; never executed by Liftoff. */
  command?: string;
  /** Extra guidance for supervised installations (launchd/systemd) and named
   *  profiles, where stopping the foreground process is not enough. */
  supervisedNote?: string;
}

export interface SourceAdapter {
  readonly source: MigrationSource;
  readonly adapterVersion: string;
  detect(): Promise<DetectedInstallation[]>;
  inventory(installation: DetectedInstallation): Promise<SourceInventory>;
  normalize(inventory: SourceInventory): Promise<MigrationBundleV1>;
  /** Returned for display at cutover. Never executed. */
  pauseGuidance(installation: DetectedInstallation): PauseGuidance;
  /** The paths detection would consult, in order. Reported when nothing is
   *  found so the user can see where we looked rather than being told only
   *  that we failed. Home directories are redacted to `~`. */
  searchPaths(opts: DetectOptions): string[];
}

// ── Detection options ──────────────────────────────────────────────────

export interface DetectOptions {
  /** Non-standard installation path (--path). */
  path?: string;
  /** Named source profile (--profile). */
  profile?: string;
}
