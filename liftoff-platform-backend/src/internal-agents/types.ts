// Internal Agents Types
// Per Section 11: Internal agent configuration management (UI: "Agents")

import type { LLMModelTier } from '../llm/types';
import type { AutonomyLevel } from '../internal-agent-oversight/types';
import type { CollaborationMode } from '../external-agents/types';
import type { WorkspaceAiSelection } from '../model-registry/workspace-ai-vendors';

export type InternalAgentStatus = 'draft' | 'active' | 'paused';

// Agent type determines execution pattern.
//
//   agent    = dynamic LLM loop (formerly Type A=Manager and Type B=IC)
//   workflow = predetermined step graph (formerly Type C=Single-task scheduled)
//
// Phase 1c: narrowed from the Phase 1b transitional union ('A'|'B'|'C'|'agent'|'workflow')
// to the canonical form only. The DB CHECK constraint (migration 089) already enforces
// this; the Zod schemas and TypeScript type now match. The legacy {A,B,C} taxonomy
// is gone from every code path, DB row, JSONB column, and Pub/Sub event envelope.
export type AgentType = 'agent' | 'workflow';

// Model configuration for internal agent execution
export interface ModelConfig {
  modelId?: string;
  tier?: LLMModelTier;
  maxTokens?: number;
  temperature?: number;
  // serving-side createAdapter provider ('google' | 'openai' | 'openrouter' | 'anthropic' |
  // …). Admin-authored only: pins serving to a specific adapter without a
  // family-inference step.
  provider?: string;
}

// Memory scope defines what memory layers the agent can access
export interface MemoryScope {
  readableLayers?: Array<'global' | 'role' | 'individual'>;
  writableLayers?: Array<'global' | 'role' | 'individual'>;
  scopeKeys?: string[];
}

// Execution configuration for runtime limits
export interface ExecConfig {
  maxToolCalls?: number;
  timeoutMs?: number;
}

// Workflow step — imported from @liftoffos/shared-types (D-3.5 fix).
// Re-exported so existing consumers of './types' keep working.
export type {
  WorkflowStep,
  WorkflowStepLoop,
  WorkflowStepRetry,
} from '@liftoffos/shared-types';
import type { WorkflowStep } from '@liftoffos/shared-types';
import type { GroundsOnRule } from './grounds-on';

// Display-only workflow visualization steps for the AgentWorkflowViz UI component.
// Uses WorkflowVisualization prefix to avoid collision with the runtime WorkflowStep type.
export interface WorkflowVisualizationForkPath { condition: string; steps: WorkflowVisualizationStep[] }
/** A node in the dashboard's workflow diagram.
 *
 *  `stepId` names the executable step this node depicts. It exists because the
 *  diagram is produced by its OWN model call, which for a long time was handed
 *  only the role and the prompts and never the steps — so it was being asked to
 *  IMAGINE the picture rather than describe it. A dev Code Reviewer drew
 *  "Find senior engineer" -> "Hand off to senior" under an "if high-risk"
 *  branch while its instructions said, in as many words, "do not name an
 *  individual and do not route the review anywhere". Nothing reconciled the two,
 *  so there was no bound on how far the picture could drift from the agent.
 *
 *  Optional on the TYPE because rows written before this carry no stepId and
 *  must keep rendering. Required in PRACTICE at generation time: a node whose
 *  stepId is missing or names no real step is dropped before it is stored. */
export interface WorkflowVisualizationStep {
  id: string;
  label: string;
  /** stepId of the executable step this node depicts. */
  stepId?: string;
  fork?: { paths: WorkflowVisualizationForkPath[] };
}

// Trigger configuration - determines how the agent is invoked.
//
// The primary schedule plus everything the distiller emits alongside it and
// the runtime schedules off: companion crons, reactive subscriptions, the
// timezone. The API boundary (router.ts triggerConfigSchema) declares the same
// set; the parity test keeps the two and the distiller's schema in step.
export interface CompanionCron {
  label: string;
  cronExpr: string;
  timezone?: string;
  contextFromLabel?: string;
  objective?: string;
  script?: string[];
  noAgent?: boolean;
  workSource?: {
    toolName: string;
    toolArgs?: Record<string, unknown>;
    itemsPath: string;
    source: string;
    maxItems?: number;
  };
}

export interface ReactiveSubscription {
  label: string;
  source: {
    kind: 'connector_event' | 'system_event' | 'computed_metric';
    connectorRef?: string;
    entityType?: string;
    topic?: string;
    fn?: string;
    args?: Record<string, unknown>;
    pollIntervalSeconds?: number;
    extractPath?: string;
  };
  filter?: Record<string, unknown>;
  window?: Record<string, unknown>;
  cooldownSeconds?: number;
  objective: string;
}

export interface TriggerConfig {
  type: 'cron' | 'event' | 'manual';
  cronExpr?: string;
  eventTopic?: string;
  eventTopics?: string[];
  timezone?: string;
  companionCrons?: CompanionCron[];
  /** @deprecated singular form; the runtime normalises it to companionCrons. */
  companionCron?: { cronExpr: string; timezone?: string };
  reactiveSubscriptions?: ReactiveSubscription[];
  reasoning?: string;
}

// Integration permission - defines what objects within an integration the internal agent can access
// Empty selectedObjects array means full access to all objects
//
// `type` is the connector type (e.g. 'google_sheets', 'hubspot') OR the literal string
// 'external_agent' for external agent integrations. It is enriched at event-publish time
// from the connectors table so the tenant runtime can resolve the integration to the
// CURRENT connector regardless of UUID changes after reconnect. Existing rows in the DB
// may not have `type` populated; the tenant runtime falls back to a JOIN through the
// connectors table by id, so absence of `type` is not a hard failure.
/**
 * Per-binding Gmail config. Stored on the IntegrationPermission for
 * connectors of type 'google_mail'. Composed (AND) with the polling
 * `since:` cursor at execution time, and used to inject the From: header
 * on outbound send/reply/forward.
 */
export type GmailBindingConfig = {
  /** Gmail search query. Composed (AND) with the polling `since:` cursor.
   *  e.g. 'label:support-agent', 'to:support@example.com'. Omitted = full inbox. */
  gmailQuery?: string;
  /** Send-as alias used as From: on send/reply/forward. Must be a verified
   *  alias on the connected account. Omitted = primary address. */
  sendAs?: string;
};

/** Per-binding config for Microsoft Outlook Mail integrations. Stored in
 *  IntegrationPermission.config when the agent binds an outlook account. */
export type OutlookBindingConfig = {
  /** Microsoft Graph $filter expression. Applied to inbound polling AND to
   *  the agent's explicit list_messages tool calls. Composed with `and`
   *  with any caller-supplied filter.
   *  Examples:
   *    "from/emailAddress/address eq 'support@example.com'"
   *    "categories/any(c:c eq 'Support')"
   *    "toRecipients/any(t:t/emailAddress/address eq 'support@example.com')" */
  outlookFilter?: string;
  /** Shared mailbox address to send/reply/forward as. Used to construct
   *  `/users/{sendAs}/sendMail`. Must be a mailbox the connected user has
   *  Send-As permission on. */
  sendAs?: string;
};

export interface IntegrationPermission {
  id: string;
  type?: string;
  integrationId?: string;
  selectedObjects: string[];
  collaborationMode?: CollaborationMode;
  /**
   * Per-connector-type binding config. Schema is `Record<string, unknown>`
   * at this layer; Zod refinement at the router enforces per-type shape
   * using the outer `type` field as discriminator. See `GmailBindingConfig`
   * (type='google_mail') and `OutlookBindingConfig` (type='microsoft_outlook_mail')
   * above for the per-provider shapes.
   */
  config?: Record<string, unknown>;
}

/**
 * Semantic instruction module emitted by distillation and stored in the
 * `skills` JSONB column on internal_agents and internal_agent_versions.
 *
 * Lifted from distill-service.ts in the v5 redistill-parity work so the
 * type is reachable from the row mapper, service, event-payload, and
 * redistill-service without a circular import through distill-service.
 */
/**
 * Skill provenance — who authored this skill, and therefore who may rewrite it.
 *
 * - `distilled` — authored by the distiller. Redistill replaces these freely.
 * - `learned`   — authored by the reflection flywheel (skill-feedback).
 * - `operator`  — authored or edited by a human, or imported by one.
 *
 * The provenance split is what makes redistill non-destructive: a redistill
 * replaces only the `distilled` slice and passes `learned` / `operator` skills
 * through untouched. Before this field existed, every Optimize silently
 * discarded whatever the team member had learned.
 */
export type SkillProvenance = 'distilled' | 'learned' | 'operator';

/**
 * Configuration provenance: what this agent's shape was decided BY, so the next
 * distillation can merge against it instead of overwriting it.
 *
 * Every field answers a question a redistill would otherwise re-answer from
 * scratch, and re-answer differently, because the input that settled it was a
 * conversation rather than a document. That is the failure this exists for and
 * it is worst in the conversational build loop: a person says "this agent has
 * no email", the distiller writes that into prose, and the next "tweak my
 * agent" reverses it — prose is not a decision, it is a sentence a later
 * generation is free to rewrite.
 *
 * Recorded, a refinement becomes a merge against what the user already settled.
 * This is the ADR-043 skill-provenance discipline applied to configuration.
 */
export interface DecisionRecord {
  /** Which trigger was chosen and WHY. The why is the load-bearing half: a
   *  redistill that sees only "cron" will re-derive a cron from prose, while
   *  one that sees "cron because no webhook-capable connector was bound" knows
   *  the choice was forced and can revisit it when one is. */
  trigger?: { type: string; reason: string };
  /** Cadence the model asked for versus what it was clamped to. Without the
   *  original, every redistill re-proposes the same rejected cadence and the
   *  clamp reads as the model's own choice. */
  cadenceClamps?: Array<{ requested: string; applied: string; reason: string }>;
  /** Per-capability live | unwired | absent as decided at this distillation.
   *  `absent` is the one that must survive: it is a fact about the business,
   *  not about today's bindings, and re-deriving it from bindings would turn
   *  "we have no chat tool" back into "chat is not connected yet". */
  capabilityStates?: Record<string, 'live' | 'unwired' | 'absent'>;
  /** What was assumed where an input went unanswered, so the next run can tell
   *  an assumption from a stated fact and ask rather than re-assume. */
  assumptions?: Array<{ about: string; assumed: string }>;
  /** The tool-description-override keys THIS distillation authored.
   *
   *  Lives here rather than beside the overrides because the override map is a
   *  flat {toolName: text} with no room for a per-entry marker, and without a
   *  marker a redistill cannot tell its own previous output from a human's.
   *  See tool-override-provenance.ts. */
  distilledOverrideTools?: string[];
  /** The subject each flow was minted from, keyed by skill id.
   *
   *  Recorded at mint time rather than re-derived, for the same reason the rest
   *  of this record exists: re-deriving it from the CURRENT responsibilities
   *  asks whether the flow suits them as they are now, which answers "yes" for
   *  a flow that has quietly drifted away from what it was for. See
   *  flow-incumbency.ts. */
  flowSubjects?: Record<string, string[]>;
  /** When this record was written, for the diff's own reporting. */
  recordedAt?: string;
}

/** One file belonging to a skill. A POINTER — content lives in the generated
 *  files bucket, content-addressed by its digest. */
export interface SkillBundleFile {
  /** Path relative to the skill root, e.g. `scripts/run.py`. Always relative,
   *  never containing `..`: it is joined onto a sandbox directory. */
  path: string;
  bytes: number;
  sha256: string;
  /** Object path in the bucket. */
  storageRef: string;
  executable?: boolean;
}

/** The files a skill ships with, from the SKILL.md convention's `scripts/`,
 *  `references/`, `examples/` and `assets/` directories. */
export interface SkillBundle {
  files: SkillBundleFile[];
}

export interface Skill {
  /** Stable identity, mirrored into the runtime so `agent_skill_metrics`
   *  (keyed on skill_id) and usefulness scoring survive a rewrite. Optional
   *  on input: absent means "mint one on the way in". */
  id?: string;
  name: string;
  description: string;
  instruction: string;
  tags?: string[];
  /** Absent on legacy rows written before provenance existed; readers treat
   *  a missing value as `distilled` (see normalizeSkillProvenance). */
  provenance?: SkillProvenance;
  /** Operator-protected: the reflection flywheel may not rewrite or merge
   *  into this skill. Set implicitly when a human edits a skill. */
  protected?: boolean;
  /** Archived skills stay in the authoritative platform column but are
   *  filtered out of every outbound event payload, so the runtime drops them
   *  from the active set on the next write. Restoring flips the flag back. */
  archived?: boolean;
  /** Files this skill ships with. Pointers only.
   *
   *  Survives a rewrite by default: the reflection flywheel and a redistill
   *  both rewrite `instruction` TEXT, and a skill whose text was improved has
   *  not thereby lost its scripts. Only an explicit re-import replaces it. */
  bundle?: SkillBundle;
}

/**
 * Per-integration config emitted by distillation, keyed by integration id
 * (catalog type OR connector instance UUID — the merge helper accepts both).
 * Gmail entries carry { gmailQuery?, sendAs? }; Outlook entries carry
 * { outlookFilter?, sendAs? }. The redistill server-side merge applies these
 * onto each IntegrationPermission.config before persisting.
 */
export type DistillIntegrationConfigs = Record<
  string,
  {
    gmailQuery?: string;
    outlookFilter?: string;
    sendAs?: string;
    /**
     * GitHub PR narrowing, read by the tenant runtime's `githubEventMatches`.
     *
     * `allowedActions` is DERIVED from the declared event topics rather than
     * authored (see github-topic-actions.ts). Without it the runtime applies its
     * own default of opened/reopened/ready_for_review, which silently drops a
     * `pr.updated` the trigger config declares.
     */
    githubFilter?: {
      repos?: string[];
      branches?: string[];
      authors?: string[];
      skipDrafts?: boolean;
      allowedActions?: string[];
    };
  }
>;

export type CapabilityTier = 'connector_only' | 'execution_enabled';

/**
 * Per-tool constraint on how a result may be consumed, authored by distillation.
 *
 * A result too large for the model's context is parked in the workspace and only
 * a view of it is returned. For most calls that is fine. For a call whose whole
 * point is to decide whether a record already exists, how many there are, or
 * what differs between two sources, a view is not a partial answer — it is a
 * wrong one, because everything unseen looks absent.
 *
 * `requiresComplete` names such a call. The runtime fails it retryably instead
 * of handing the view back as a success, and tells the agent to read the parked
 * copy in the workspace.
 */
export interface ResultRule {
  /** Aliased tool name, as it appears in the agent's catalog. */
  toolName: string;
  requiresComplete: boolean;
}

/**
 * Team-scoped build-time attachment imported on the team-build / team-update
 * pages (docs/REQUIRED_BACKEND_APIS.md "Team Attachments"). NOT a knowledge
 * item — no rows exist in the knowledge domain. Attachments live on the
 * internal agent, feed the distill step (they shape the generated prompts the
 * way pasted responsibilities text used to), and are returned on agent reads
 * so the UI can rehydrate the attachment cards.
 */
export interface UploadAttachment {
  kind: 'upload';
  name: string;
  /** Plain text, read client-side at import time. */
  content: string;
  /** ISO timestamp. */
  addedAt: string;
  /** Which build input imported it. */
  source: 'responsibilities' | 'guidance';
}

export interface ConnectorAttachment {
  kind: 'connector';
  name: string;
  /** Live connector instance UUID. */
  connectorId: string;
  /** e.g. 'google_drive' | 'microsoft_onedrive' | 'dropbox' | 'box'. */
  connectorType: string;
  /** Provider file id (browse result id). */
  externalId: string;
  sourceUrl?: string;
  addedAt: string;
  source: 'responsibilities' | 'guidance';
}

export type TeamAttachment = UploadAttachment | ConnectorAttachment;

export interface InternalAgent extends TemplateProvenance {
  id: string;
  tenantId: string;
  role: string;
  responsibilities: string | null;
  integrations: IntegrationPermission[];
  /** Connector type names the agent needs but that were not connected when
   *  the agent was provisioned. Populated by the HRBP Agent during batch
   *  provisioning (Phase 4) so the OAuth callback can auto-grant access
   *  once the user connects the app. Stored as a plain string array keyed
   *  by connector type (e.g. `["hubspot", "slack"]`). */
  pendingIntegrations: string[];
  additionalContext: string | null;
  summary: string | null;
  systemPrompt: string | null;
  userInstructions: string | null;
  /**
   * Agent-level CLAUDE.md markdown loaded by the Claude Agent SDK. Merged
   * with tenant + workforce-plan layers at Pub/Sub publish time to produce
   * the effective instructionsMd sent to the tenant runtime.
   */
  instructionsMd: string | null;
  temperature: number;
  status: InternalAgentStatus;
  currentVersion: number;
  tasksCompleted: number;
  /** Trailing 30-day invocation count from tenant runtime. Computed at read time. */
  tasks30d: number;
  /** Computed from tenant runtime invocation data, not stored in DB. */
  monthlyCost: number;
  lastActive: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Runtime config fields
  agentType: AgentType;
  modelConfig: ModelConfig;
  memoryScope: MemoryScope;
  execConfig: ExecConfig;
  workflowSteps: WorkflowStep[] | null;
  triggerConfig: TriggerConfig | null;
  /** FK to the workforce plan this agent was provisioned from. Null for manually-created agents. */
  workforcePlanId: string | null;
  /** IDs of knowledge_items the operator pinned via [[knowledge:id:title]] markers
   *  in responsibilities / additionalContext. Acts as a retrieval bias in
   *  corpus_search — pinned items are positionally elevated above natural matches when they match the query.
   *  Validated at save time: every ID's source connector must be bound to the
   *  agent. Empty array when no pins. */
  pinnedKnowledgeIds: string[];
  // Phase 4: Workflow integrity metadata
  /** Timestamp when workflow steps were last semantically validated and hash-pinned. NULL for agent-type agents. */
  reviewedAt: Date | null;
  /** Identity of the reviewer (e.g. 'system:claude-opus-4.6' for LLM semantic validation). NULL for agent-type agents. */
  reviewedBy: string | null;
  /** SHA-256 of canonicalized workflowSteps, pinned at validation time. Execution-time tamper check compares against this. */
  workflowStepsHash: string | null;
  /** Short name for the agent on Slack, Teams, and web chat (max 35 chars). */
  messagingNickname: string | null;
  /** ISO timestamp of latest entry in agent_audit_logs. Null if no activity. Populated by workforce endpoint only. */
  lastActivity: string | null;
  /** Action string of latest entry in agent_audit_logs. Null if no activity. Populated by workforce endpoint only. */
  lastActivityAction: string | null;
  /** Display-only workflow steps for the AgentWorkflowViz UI component.
   *  Generated by a trailing Haiku call after distillation. Nullable until first generation. */
  workflowVisualizationSteps: WorkflowVisualizationStep[] | null;
  /** Per-agent autonomy override. NULL means use the workspace-level setting. */
  autonomyOverride: AutonomyLevel | null;
  /** Per-agent AI vendor override. Three states:
   *    null        inherit — follow the workspace vendor, including future changes.
   *    'default'   pinned to Liftoff Managed routing for THIS agent, whatever the
   *                workspace is set to. Not a synonym for inherit.
   *    <vendor>    pinned to that vendor.
   *  The column holds the CHOICE; events carry the RESOLUTION. Translated into
   *  modelConfig.provider/modelId at publish time by `effectiveModelConfig`, at
   *  BOTH sites that stamp modelConfig into runtime-bound events (the primary
   *  envelope and runtime_config_updated). Never materialized into model_config. */
  aiVendorOverride: WorkspaceAiSelection | null;
  /** Semantic instruction modules emitted by distillation. Reflection-service
   *  may append/refine via the skills_updated event. Empty array until first
   *  distillation runs. */
  skills: Skill[];
  /** Capability tier classification emitted by distillation. Drives runtime
   *  gating without the substring heuristic that event-payload.ts used pre-v5. */
  capabilityTier: CapabilityTier;
  /** Per-tool result-handling policy emitted by distillation. Empty until a
   *  distillation names a tool whose result the agent may only act on whole. */
  resultRules: ResultRule[];
  /** Rules appended to a single tool's description when the runtime assembles
   *  its catalog, keyed by catalog tool name. The layer table's first row: a
   *  rule governing one call is read at the moment that call is written. */
  toolDescriptionOverrides: Record<string, string>;
  /** Declared grounding rules: which read to run before answering, keyed to the
   *  SHAPE of the request rather than to model judgment. Evaluated by the host
   *  on every engine, so the behaviour is identical wherever the agent runs. */
  groundsOn: GroundsOnRule[];
  /** Per-capability live | unwired | absent. `absent` is a fact about the
   *  business, not about today's bindings: the runtime refuses those tools by
   *  name so the agent stops rather than retrying or substituting. */
  capabilityStates: Record<string, 'live' | 'unwired' | 'absent'>;
  /** Configuration provenance — trigger choice and why, cadence clamps applied,
   *  capability tri-states, assumptions made for unanswered inputs. A redistill
   *  honours and diffs against it, so a human decision is merged rather than
   *  silently reversed. */
  decisionRecord: DecisionRecord;
  /** Build-time attachments imported on the team-build / team-update pages.
   *  Empty array when none. Deliberately NOT included in the runtime event
   *  payload — their effect reaches the runtime through the distilled
   *  prompts/instructions. */
  attachments: TeamAttachment[];
}

/** Provenance of a template hire, read on redistill. See migration 378. */
export interface TemplateProvenance {
  templateId?: string | null;
  templateSourceHash?: string | null;
}

export interface CreateInternalAgentInput {
  role: string;
  responsibilities?: string;
  /** The agent-template this hire came from, stored so a redistill can seed
   *  from it again. See migration 378 for why it is paired with a hash. */
  templateId?: string;
  /** The prose above was already rewritten before this hire was created, so it
   *  is the person's text rather than the template's.
   *
   *  create() fingerprints the text IT RECEIVES into `template_source_hash`,
   *  and `templateIdForRedistill` reuses the template id only while the agent
   *  still hashes to that baseline. That is exactly right while the only way to
   *  reach create is with the catalog's text verbatim — which stopped being
   *  true when the explore detail step became editable in place. Text edited
   *  BEFORE creation would be fingerprinted as its own baseline, hash equal to
   *  itself forever, and every redistill would re-seed from our catalog and
   *  drag their wording back toward ours, silently.
   *
   *  Set, this records no baseline, which is what "this text is theirs" already
   *  means for an agent edited after the fact. `templateIdForObligations` is
   *  deliberately unaffected: the template's structural guarantees survive an
   *  edit, and always did. */
  templateTextEdited?: boolean;
  /** Destinations the person named on the connectors step, keyed by object id.
   *  Consumed by create() to resolve the template's placeholders and never
   *  stored: it is an input to the text, not a column.
   *
   *  `kind` travels with it because `resolveTemplatePlaceholders` READS it to
   *  decide the destination rule, and a type that omits it is still structurally
   *  satisfied by every caller — so the field went missing with nothing to say so
   *  and the rule resolved to nothing on every hire. One declaration, in
   *  `destination-rule.ts`. */
  templatePicks?: Record<string, import('./destination-rule').DestinationPick>;
  integrations?: IntegrationPermission[];
  /** Connector type names required by the agent but not yet connected.
   *  Populated by the HRBP Agent during batch provisioning (Phase 4). */
  pendingIntegrations?: string[];
  additionalContext?: string;
  summary?: string;
  systemPrompt?: string;
  userInstructions?: string;
  instructionsMd?: string;
  temperature?: number;
  status?: InternalAgentStatus;
  // Runtime config fields
  agentType?: AgentType;
  modelConfig?: ModelConfig;
  memoryScope?: MemoryScope;
  execConfig?: ExecConfig;
  workflowSteps?: WorkflowStep[];
  triggerConfig?: TriggerConfig;
  workforcePlanId?: string;
  pinnedKnowledgeIds?: string[];
  messagingNickname?: string;
  /** If true, create a Slack app for this agent during creation. */
  slackEnabled?: boolean;
  skills?: Skill[];
  capabilityTier?: CapabilityTier;
  resultRules?: ResultRule[];
  toolDescriptionOverrides?: Record<string, string>;
  groundsOn?: GroundsOnRule[];
  capabilityStates?: Record<string, 'live' | 'unwired' | 'absent'>;
  decisionRecord?: DecisionRecord;
  /** Escalation recipient (accounts.id) stamped onto internal_agents.escalation_recipient.
   *  Set by team-preset provisioning per role. */
  escalationRecipient?: string;
  /** When set, stamp internal_agent_provenance in the SAME transaction as the agent row —
   *  the crash-safe create key for team-preset provisioning (existence per run+role). */
  provenance?: { provisioningRunId: string; roleKey: string; workforcePlanId?: string | null };
  attachments?: TeamAttachment[];
}

export interface UpdateInternalAgentInput {
  role?: string;
  responsibilities?: string;
  integrations?: IntegrationPermission[];
  /** Update the connector-type strings that are waiting on the user to
   *  connect the matching app. Populated by the HRBP Agent during
   *  re-provisioning of an amended workforce plan (Phase 4). */
  pendingIntegrations?: string[];
  additionalContext?: string;
  summary?: string;
  systemPrompt?: string;
  userInstructions?: string;
  instructionsMd?: string | null;
  temperature?: number;
  // Runtime config fields
  agentType?: AgentType;
  modelConfig?: ModelConfig;
  memoryScope?: MemoryScope;
  execConfig?: ExecConfig;
  workflowSteps?: WorkflowStep[] | null;
  triggerConfig?: TriggerConfig | null;
  pinnedKnowledgeIds?: string[];
  messagingNickname?: string;
  autonomyOverride?: AutonomyLevel | null;
  /** null CLEARS the override (back to inherit) and must therefore be
   *  distinguishable from an absent key — undefined leaves the column alone. */
  aiVendorOverride?: WorkspaceAiSelection | null;
  skills?: Skill[];
  capabilityTier?: CapabilityTier;
  /** Full-list replace. A redistill that names no tool sends `[]`, which clears
   *  a policy the previous distillation set — the rules describe the workflow
   *  that distillation just produced, so carrying an old one forward would apply
   *  it to steps that no longer exist. */
  resultRules?: ResultRule[];
  toolDescriptionOverrides?: Record<string, string>;
  groundsOn?: GroundsOnRule[];
  capabilityStates?: Record<string, 'live' | 'unwired' | 'absent'>;
  decisionRecord?: DecisionRecord;
  /** Full-list replace, like integrations. */
  attachments?: TeamAttachment[];
}

export interface PaginatedInternalAgentsResponse {
  internalAgents: InternalAgent[];
  cursor: string | null;
  hasMore: boolean;
  total: number;
}

export interface InternalAgentAuditEntry {
  id: string;
  internalAgentId: string;
  tenantId: string;
  action: 'created' | 'updated' | 'deleted' | 'status_changed';
  changes: Record<string, unknown> | null;
  actorId: string | null;
  createdAt: Date;
}

// Version source indicates how the version was created
export type VersionSource = 'create' | 'distill' | 'manual';

// Internal agent version - snapshot of configuration at a point in time
export interface InternalAgentVersion {
  id: string;
  internalAgentId: string;
  version: number;
  role: string;
  responsibilities: string | null;
  integrations: IntegrationPermission[];
  additionalContext: string | null;
  systemPrompt: string | null;
  userInstructions: string | null;
  instructionsMd: string | null;
  source: VersionSource;
  createdBy: string | null;
  createdAt: Date;
  // Runtime config fields (snapshotted for version tracking)
  agentType: AgentType;
  modelConfig: ModelConfig;
  memoryScope: MemoryScope;
  execConfig: ExecConfig;
  workflowSteps: WorkflowStep[] | null;
  triggerConfig: TriggerConfig | null;
  workflowVisualizationSteps: WorkflowVisualizationStep[] | null;
  autonomyOverride: AutonomyLevel | null;
  aiVendorOverride: WorkspaceAiSelection | null;
  pinnedKnowledgeIds: string[];
  skills: Skill[];
  capabilityTier: CapabilityTier;
  attachments: TeamAttachment[];
}

// Recently viewed internal agents types
/**
 * An agent as a browser receives it: everything except the compiled prompt.
 *
 * systemPrompt / userInstructions / instructionsMd stay on `InternalAgent`
 * because server-side callers need them (version snapshots, the reconciler, the
 * Pub/Sub payload the tenant runtime executes from, the service-auth _svc
 * routes). No client has ever rendered one, and returning them made the list
 * endpoint a bulk export of every agent's prompt. `toClientAgent` in
 * row-mapper.ts produces this shape.
 */
export type ClientInternalAgent = Omit<
  InternalAgent,
  'systemPrompt' | 'userInstructions' | 'instructionsMd'
>;

export interface RecentlyViewedInternalAgentEntry {
  // The wire shape, so without the compiled prompt. This response goes to a
  // browser and nowhere else; see toClientAgent in row-mapper.ts.
  internalAgent: ClientInternalAgent;
  viewedAt: string;
}

export interface RecentlyViewedInternalAgentsResponse {
  internalAgents: RecentlyViewedInternalAgentEntry[];
}
