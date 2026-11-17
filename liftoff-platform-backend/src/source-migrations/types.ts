// Liftoff Switch — backend types.
//
// The server half of the migration bundle contract. These mirror the CLI's
// transport types (packages/liftoff-cli/src/switch/contract.ts) because the
// bundle crosses a process boundary; they are validated at the API edge with
// zod rather than trusted.
//
// Nothing here is a persistent agent model. The bundle is input to the
// canonical distiller, and internal_agents remains the only place a team member
// is described.

export type MigrationSource = 'openclaw' | 'hermes' | 'claude-code' | 'codex';

export type MigrationState =
  | 'importing'
  | 'setup_required'
  | 'payment_required'
  | 'conversion_queued'
  | 'converting'
  | 'conversion_ready'
  | 'ready_to_cutover'
  | 'active'
  | 'failed';

export type MigrationItemState = 'pending' | 'distilling' | 'creating' | 'converted' | 'failed';

export type FirstRunStatus = 'awaiting' | 'succeeded' | 'failed';

export type ConnectionKind = 'catalog' | 'mcp_http';

export type ConnectionStatus = 'placeholder_pending' | 'needs_reconnect' | 'active' | 'dismissed';

export type ArtifactCategory = 'instructions' | 'skill' | 'memory' | 'routine';

export type MemoryScope = 'agent' | 'workspace';

// ── bundle (as uploaded) ───────────────────────────────────────────────

export interface ImportedAttachment {
  name: string;
  content: string;
  category: ArtifactCategory;
  sourcePaths: string[];
}

export interface ImportedModelPreference {
  provider?: string;
  model?: string;
  note?: string;
}

export interface ImportedAgent {
  sourceRef: string;
  role: string;
  responsibilities: string;
  additionalContext?: string;
  originalLabel?: string;
  attachments: ImportedAttachment[];
  integrationRefs: string[];
  mcpServerRefs: string[];
  routineRefs: string[];
  /** How this team member runs. Applied to trigger_config after distillation:
   *  the source told us the schedule, so the distiller must not guess it. */
  cronExpr?: string;
  modelPreference?: ImportedModelPreference;
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
  /** Environment variable NAMES the skill expects, never values. The review
   *  surface turns each into a provide-a-value card writing to the workspace
   *  locker. */
  referencedSecretNames?: string[];
  /** The skill's own text files. Uploaded at absorption and replaced by
   *  pointers on the stored skill. */
  files?: ImportedSkillFile[];
}

export interface ImportedSkillFile {
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
  cronExpr: string;
  prompt: string;
  enabledInSource: boolean;
}

export interface CatalogConnectorRequirement {
  sourceRef: string;
  connectorType: string;
  usedByIdentityRefs: string[];
  usedByRoutineRefs: string[];
  externalAccountLabel?: string;
  authMethod?: string;
}

export interface CustomMcpServerRequirement {
  sourceRef: string;
  name: string;
  url: string;
  transport: 'http';
  authScheme: 'none' | 'api_key' | 'bearer' | 'custom_headers';
  customHeaderNames?: string[];
  usedByIdentityRefs: string[];
}

/** Package registries an imported stdio server can name. Mirrors the CLI
 *  contract; `nuget` and `mcpb` exist in the MCP registry and are deliberately
 *  absent, because the CLI never produces them. */
export type McpPackageRegistryType = 'npm' | 'pypi' | 'oci';

/** The published package a local stdio command actually runs.
 *
 *  Recorded by the CLI, never resolved by it: turning an identity into a
 *  connector or an endpoint needs the MCP registry, and a lookup baked into a
 *  shipped CLI would answer from whatever the ecosystem looked like on the day
 *  that version was built. */
export interface McpPackageIdentity {
  registryType: McpPackageRegistryType;
  name: string;
}

export interface HostingRequirement {
  sourceRef: string;
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  reason: 'stdio_mcp_requires_hosting' | 'unreachable_mcp_endpoint';
  usedByIdentityRefs: string[];
  packageIdentity?: McpPackageIdentity;
}

export interface ImportedGovernanceRule {
  sourceRef: string;
  identitySourceRef?: string;
  kind: string;
  description: string;
}

export interface UnsupportedItem {
  sourceRef: string;
  reason: string;
  detail: string;
  sourcePath?: string;
}

export interface MigrationBundleV1 {
  bundleVersion: 1;
  source: MigrationSource;
  sourceVersion?: string;
  adapterVersion: string;
  installationFingerprint: string;
  agents: ImportedAgent[];
  teamRelationships: ImportedRelationship[];
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
  /** Normalizer notes from the user's machine: what overflowed and what was
   *  dropped or shortened. Stored on the migration row for support, never shown
   *  in the wizard. */
  diagnostics?: string[];
}

// ── persisted rows ─────────────────────────────────────────────────────

export interface SourceMigration {
  id: string;
  tenantId: string;
  /** The person whose machine this import came from. Null only for rows created
   *  before migration 368, which recorded no importer at all. */
  accountId: string | null;
  source: MigrationSource;
  sourceVersion: string | null;
  adapterVersion: string;
  installationFingerprint: string;
  state: MigrationState;
  bundle: MigrationBundleV1 | null;
  unsupportedItems: UnsupportedItem[];
  hostingRequirements: HostingRequirement[];
  diagnostics: string[];
  /** Artifact names approved for the shared knowledge library (invariant 9). */
  libraryApprovals: string[];
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  convertedAt: Date | null;
  completedAt: Date | null;
}

/** The canonical distill input for one identity, persisted so a resume uses
 *  exactly the bounded input the user reviewed. */
export interface StoredDistillInput {
  role: string;
  responsibilities: string;
  additionalContext?: string;
  attachments: ImportedAttachment[];
  integrationRefs: string[];
  mcpServerRefs: string[];
  routineRefs: string[];
  originalLabel?: string;
  cronExpr?: string;
  modelPreference?: ImportedModelPreference;
}

export interface SourceMigrationItem {
  id: string;
  migrationId: string;
  tenantId: string;
  sourceRef: string;
  normalizedInputHash: string;
  distillInput: StoredDistillInput;
  state: MigrationItemState;
  attemptCount: number;
  lastError: string | null;
  /** Persisted BEFORE agent creation is attempted, so a crash between the two
   *  never costs a second distill. Typed loosely on purpose: it is the
   *  distiller's own output shape, round-tripped through JSONB. */
  distillOutput: Record<string, unknown> | null;
  /** internal_agents.id — never the Tenant Runtime's agents.id (ADR-039). */
  destinationAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  convertedAt: Date | null;
}

export interface SourceMigrationRoutine {
  id: string;
  migrationId: string;
  tenantId: string;
  itemId: string | null;
  sourceRef: string;
  name: string;
  cronExpr: string;
  prompt: string;
  enabledInSource: boolean;
  accepted: boolean;
  enabledAtCutover: boolean;
  destinationAgentId: string | null;
  routineRef: string;
  firstRunStatus: FirstRunStatus;
  firstRunAt: Date | null;
  firstRunErrorCategory: string | null;
}

export interface SourceMigrationConnection {
  id: string;
  migrationId: string;
  tenantId: string;
  sourceRef: string;
  kind: ConnectionKind;
  connectorType: string;
  displayName: string | null;
  endpointUrl: string | null;
  authScheme: string | null;
  customHeaderNames: string[];
  externalAccountLabel: string | null;
  connectorId: string | null;
  customMcpServerId: string | null;
  status: ConnectionStatus;
}

// ── API views ──────────────────────────────────────────────────────────

export interface MigrationRequirement {
  kind: 'credential' | 'collaboration' | 'consent' | 'payment' | 'hosting' | 'selection';
  detail: string;
  resolvePath?: string;
}

export interface MigrationItemView {
  sourceRef: string;
  role: string;
  state: MigrationItemState;
  destinationAgentId?: string;
  lastError?: string;
}

export interface MigrationRoutineView {
  sourceRef: string;
  name: string;
  cronExpr: string;
  accepted: boolean;
  enabledInSource: boolean;
  firstRunStatus: FirstRunStatus;
  firstRunErrorCategory?: string;
}

export interface MigrationConnectionView {
  sourceRef: string;
  kind: ConnectionKind;
  connectorType: string;
  displayName?: string;
  endpointUrl?: string;
  authScheme?: string;
  connectorId?: string;
  status: ConnectionStatus;
}

export interface MigrationView {
  id: string;
  source: MigrationSource;
  state: MigrationState;
  itemCount: number;
  convertedCount: number;
  unsupportedCount: number;
  items: MigrationItemView[];
  requirements: MigrationRequirement[];
  webPath: string;
  onboardingComplete: boolean;
  /** Everything the review and setup stages render. */
  unsupportedItems: UnsupportedItem[];
  hostingRequirements: HostingRequirement[];
  routines: MigrationRoutineView[];
  connections: MigrationConnectionView[];
  /** Artifact names eligible for the shared knowledge library, and the ones
   *  already approved. Workspace-scoped context requires explicit consent. */
  consentCandidates: string[];
  libraryApprovals: string[];
  /** Copyable reference text for the cutover screen. Never a step Liftoff
   *  verifies or gates on. */
  pauseGuidance: { command?: string; steps: string[]; supervisedNote?: string };
}
