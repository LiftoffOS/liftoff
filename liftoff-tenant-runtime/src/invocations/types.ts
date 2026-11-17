// Invocations and Threads Types
// Per implementation plan: Phase 3 Invocations & Threads

import type { ExecutionEngineId } from '../agent-execution/adapter/types';

// Thread status
export type ThreadStatus = 'open' | 'closed' | 'archived' | 'completed' | 'failed' | 'waiting_on_human';

// Who initiated the thread
export type InitiatedByType = 'human' | 'agent' | 'system' | 'scheduler';

// Message role
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// Invocation trigger type
export type TriggerType = 'human' | 'agent' | 'cron' | 'event';

// Invocation outcome
//
// 'gated' (migration 329) means oversight blocked or paused the run. It exists because
// otherwise a governance stop records 'success': a run that was blocked, created no
// approval and surfaced nothing on /dashboard/review reports a clean run, so a broken
// gate is invisible to every query and dashboard.
//
// Distinct from 'escalated' on purpose: that means the agent handed off to a human as
// part of doing its job, a NORMAL outcome. Overloading it would make escalation metrics
// unreadable and hide exactly the failures this value needs to expose.
export type InvocationOutcome = 'success' | 'error' | 'escalated' | 'gated' | 'parked';

// Granular failure taxonomy for outcome='error' runs (migration 308). Nullable in
// the DB; NULL for success/escalated and pre-308 rows. Derived by classifyFailure at
// the error-path completeInvocation site; set to 'stalled' by the stalled-run reconciler.
//
// NOT to be confused with PauseResumeFailureClass
// (observability/pause-resume-telemetry.ts), which classifies why a PAUSE failed
// to resume and shares nothing with this taxonomy.
//
// The remediation differs per value, and that is the point: 'the run failed' is
// not actionable, and treating a credit lapse the same as an Anthropic 429 is
// how a healthy routine got stopped for a reason retrying would have fixed.
export type FailureClass =
  // Superseded by the provider_* classes below, which say WHICH transient. Still
  // legal so historical rows keep their meaning; nothing writes it any more.
  | 'transient_infra'
  | 'agent_declined'
  | 'timeout'
  | 'stalled'
  | 'tool_error'
  | 'validation'
  | 'unknown'
  // A healthy agent reported, through report_task_outcome, that the task cannot
  // be completed — go fix the environment, not the agent. Distinct from
  // 'agent_declined' ("nothing to do"), which is reachable only from a thrown
  // message regex in classifyFailure.
  | 'task_failed'
  // The agent could not handle its own anomaly and the recovery advisor
  // terminated the run — go fix the agent. Deliberate, so never auto-retried.
  | 'recovery_declined'
  // The run hit a ceiling we configured before it finished — go raise the
  // budget, not fix the agent. Says nothing about whether the agent was doing
  // the right thing, which is why it is worth its own class: it used to be
  // stored as a plain engine failure and read as a crash.
  | 'limit_reached'
  // ── Provider failures ──────────────────────────────────────────────────────
  // Split out of 'transient_infra' / 'unknown' because the remediation differs.
  /** The model provider is at capacity (429 / overloaded). Back off and retry. */
  | 'provider_capacity'
  /** The provider returned a 5xx. Short backoff, then retry. */
  | 'provider_server_error'
  /** The call never reached the provider (socket reset, DNS, TLS). Retry, and
   *  the session can be resumed because no turn was consumed. */
  | 'provider_network'
  /** The provider rejected our credentials (401 / 403). A retry sends the same
   *  bad key, so NEVER retry — someone has to re-authenticate. */
  | 'provider_auth'
  /** The account is out of provider quota or credit (402 / insufficient_quota).
   *  NEVER retry — someone has to top it up. */
  | 'provider_quota'
  /** The conversation no longer fits the model's window. Retryable, but only on
   *  a FRESH session — resuming the saturated one reproduces it exactly. */
  | 'context_overflow'
  /** OUR bug, not the provider's: a TypeError/RangeError/ReferenceError thrown
   *  while an adapter translated, dispatched or consumed. NEVER retried — the
   *  same input reproduces it deterministically — and deliberately its own class
   *  so `WHERE failure_class = 'adapter_internal'` is a list of defects with our
   *  name on them rather than another entry in `unknown`, which is supposed to
   *  mean "nobody has classified this yet". Named after a real one: a rebuilt
   *  cross-engine conversation died on `item.content.map is not a function`
   *  inside the OpenAI SDK and read as `unknown` because no provider was
   *  involved and nothing carried a status. */
  | 'adapter_internal'
  // ── Pre-invocation guards ──────────────────────────────────────────────────
  // Result-level ONLY. These three guards return before any `invocations` row
  // exists, so they never reach the DB and never appear in the failure_class
  // column — they exist so the caller can tell a real failure from a run that
  // never started.
  /** The admission gate refused the run (entitlement, suspension, kill switch).
   *  NEVER retry — the entitlement has to change first. */
  | 'admission_denied'
  /** The agent already held its execution lock. Not a failure at all: the agent
   *  is working. */
  | 'agent_busy'
  /** The agent is not ACTIVE (paused, archived, draft). Not a failure at all. */
  | 'lifecycle_not_active';

// Thread record
export interface Thread {
  id: string;
  tenantId: string;
  agentId: string;
  initiatedByUser: string | null;
  initiatedByType: InitiatedByType;
  title: string | null;
  status: ThreadStatus;
  createdAt: Date;
  updatedAt: Date;
}

// Message record
export interface Message {
  id: string;
  tenantId: string;
  threadId: string;
  role: MessageRole;
  content: string;
  toolCalls: ToolCallRecord[] | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
}

// Tool call record
export interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

/** How a run's accountable party was arrived at (migration 357).
 *
 *  The split that matters is PRECISE vs DEGRADED: a statement about someone who
 *  actually acted, versus an inference about someone who may never have seen
 *  this run. Reporting the two as one number is how a coverage figure becomes a
 *  lie about how much attribution we really have — which is why the source is
 *  stored and not just the id.
 *
 *  Every member below is PRODUCED. Deriving an owner from the schedule that
 *  fired, the reactive rule that matched, or the agent itself would be the
 *  natural next members — but the runtime holds no owner for any of the three:
 *  companion routines live in the agent's runtime config with no creator,
 *  reactive subscriptions are owned in the control plane, and neither `agents`
 *  nor `cached_internal_agents` carries a creator column. Adding those values
 *  before the data exists would put a class in the taxonomy that nothing can
 *  ever emit, and a coverage metric would report a category that is structurally
 *  always zero. They belong in this union on the day the control plane publishes
 *  an owner onto the agent snapshot, and not before. */
export type AttributionSource =
  /** The person acted on this run themselves. PRECISE. */
  | 'direct_human'
  /** Inherited from the parent run of a delegated child. PRECISE — a delegation
   *  does not change who asked for the work. */
  | 'delegation'
  /** No human could be identified, and accountableUserId is NULL. */
  | 'unattributed';

// Invocation record
export interface Invocation {
  id: string;
  tenantId: string;
  agentId: string;
  threadId: string | null;
  triggeredBy: TriggerType;
  /** Human who triggered the run (migration 311) — PB account id or slack:/teams:<id>.
   *  NULL for non-human triggers and human paths that carry no user id.
   *  The ORIGINATOR: strictly who acted, never inferred. */
  triggeredByUserId: string | null;
  /** The Liftoff operator's `accounts.id` when a support delegation session set
   *  this run in motion. Stored beside triggered_by_user_id so a delegated
   *  CHILD run inherits it the same way the human is inherited: by reading the
   *  parent invocation, rather than by every fan-out caller remembering to
   *  thread it. Absent on every ordinary run. See migration 379. */
  impersonatedBy: string | null;
  /** Whose run this is for budget, review-queue and escalation purposes
   *  (migration 357). Equal to triggeredByUserId whenever that is set — a table
   *  CHECK enforces it — and otherwise derived or NULL. */
  accountableUserId: string | null;
  /** How accountableUserId was arrived at (migration 357). NULL on pre-357 rows. */
  attributionSource: AttributionSource | null;
  /** Granular trigger label (invocations.triggered_by_label). NULL when unset. */
  triggeredByLabel: string | null;
  triggerRef: string | null;
  /** The run that delegated this one, when it is a child. */
  parentInvocationId: string | null;
  modelId: string | null;
  provider: string;
  /** Concrete outer-agent engine that ran this invocation (migration 321,
   * resolveExecutionEngine at creation). NULL for pre-321 rows and providers the
   * resolver does not understand. See the ExecutionEngineId type. */
  executionEngine: ExecutionEngineId | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Computed from price snapshots and token counts — not stored in DB. Does NOT
   *  include grounding cost (that is persisted + carried separately below). */
  costUsd: number | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cachedInputPricePerMillion: number | null;
  /** Cache WRITES and the rate they were priced at (migration 439). NULL for
   *  every vendor that does not charge for one. */
  cacheWriteTokens: number | null;
  cacheWritePricePerMillion: number | null;
  /** Google Search grounding (migration 288), persisted per-query, NOT folded into
   *  costUsd by the mapper — consumers sum both. */
  groundingQueries: number;
  groundingCostUsd: number;
  /** What the gateway charged (migration 438), where one reported a charge.
   *  NULL means price the row from its rate snapshot — the normal case for every
   *  direct-API vendor — and is never 0. */
  vendorCostUsd: number | null;
  /** Granular failure taxonomy (migration 308); NULL for success/escalated/pre-308. */
  failureClass: FailureClass | null;
  toolCalls: ToolCallRecord[];
  outcome: InvocationOutcome | null;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

// Create thread input
export interface CreateThreadInput {
  tenantId: string;
  agentId: string;
  initiatedByUser?: string;
  initiatedByType?: InitiatedByType;
  title?: string;
}

// Create message input
export interface CreateMessageInput {
  tenantId: string;
  threadId: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRecord[];
  inputTokens?: number;
  outputTokens?: number;
}

// Create invocation input
export interface CreateInvocationInput {
  tenantId: string;
  agentId: string;
  threadId?: string;
  triggeredBy: TriggerType;
  /** Granular trigger label, persisted to invocations.triggered_by_label.
   *  Examples: 'companion:weekly-summary', 'reactive:<label>',
   *  'workflow_delay:<workflowId>', 'computed_metric:<label>'. */
  triggeredByLabel?: string;
  /** Human who triggered the run (migration 311) — PB account id or slack:/teams:<id>.
   *  Persisted to invocations.triggered_by_user_id. Omit for non-human triggers. */
  triggeredByUserId?: string;
  /** The Liftoff operator's `accounts.id` when a support delegation session set
   *  this run in motion. Stored beside triggered_by_user_id so a delegated
   *  CHILD run inherits it the same way the human is inherited: by reading the
   *  parent invocation, rather than by every fan-out caller remembering to
   *  thread it. Absent on every ordinary run. See migration 379. */
  impersonatedBy?: string;
  triggerRef?: string;
  modelId?: string;
  provider: string;
  // Optional pre-generated UUID — lets callers plumb invocation.id into
  // upstream work (e.g. retrieval event log) before the row is created.
  id?: string;
  /** Orchestrator invocation that spawned this one via delegate_to_agent.
   *  Set on child (delegated specialist) invocations so cost-attribution can
   *  trace the delegation tree. Null for top-level invocations. */
  parentInvocationId?: string;
  /** Part 5 §C — depth in the delegation tree. Root invocations stay NULL
   *  (resolver treats NULL as 0). Fan-out children carry parentDepth + 1
   *  so delegateToAgents can enforce the per-tenant depth cap. */
  delegationDepth?: number | null;
  /** ADR-030: full re-runnable input for top-level runs — persisted to
   *  invocations.replay_input so "Run again" can re-enqueue a faithful fresh
   *  execution. Shape: { objective, threadId, triggeredBy, triggeredByLabel,
   *  trigger, chainDepth }. Omitted for delegated child invocations. */
  replayInput?: Record<string, unknown>;
  /** ADR-030: when this invocation is itself a "Run again" of an earlier run,
   *  the id of the original invocation. Persisted to
   *  invocations.rerun_of_invocation_id for backend lineage. */
  rerunOfInvocationId?: string;
}

// ADR-030: the minimal invocation projection the "Run again" endpoint needs to
// validate re-runnability and reconstruct the original run input.
export interface RerunSource {
  id: string;
  agentId: string;
  triggeredBy: TriggerType;
  outcome: InvocationOutcome | null;
  failureClass: FailureClass | null;
  parentInvocationId: string | null;
  replayInput: Record<string, unknown> | null;
}

// Complete invocation input
export interface CompleteInvocationInput {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  /** Tokens spent WRITING the prompt cache, billed at 1.25x input where the
   *  vendor charges for one. Additive to `inputTokens`, which Anthropic reports
   *  exclusive of both cache reads and cache writes (migration 439). */
  cacheWriteTokens?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  cachedInputPricePerMillion?: number | null;
  cacheWritePricePerMillion?: number | null;
  /** Native Google Search grounding queries performed this invocation, and the
   *  per-query cost charged ($0.014/query). Persisted because grounding is
   *  per-query (not per-token) and so cannot be re-derived from token snapshots
   *  by the billing-queued reconciliation job. */
  groundingQueries?: number;
  groundingCostUsd?: number;
  /** What the gateway charged for this invocation, summed over its steps, where
   *  one reported a charge. Persisted for the same reason `groundingCostUsd` is:
   *  it cannot be re-derived from the token snapshot, and the reconciliation path
   *  reads this row rather than the completion event.
   *
   *  Undefined for every direct-API vendor — they publish price lists, not
   *  charges — and undefined means "price it from the rate snapshot", NEVER zero. */
  vendorCostUsd?: number;
  toolCalls: ToolCallRecord[];
  outcome: InvocationOutcome;
  errorMessage?: string;
  /** Granular failure taxonomy (migration 308); set only on outcome='error'. */
  failureClass?: FailureClass;
  /** What the PROVIDER said, structured (migration 360). Distinct from
   *  `failureClass`, which is our DERIVED label: keeping both means the label
   *  can be checked against its evidence instead of taken on trust, and a
   *  provider introducing a new error type shows up as itself rather than
   *  collapsing into 'unknown'. `providerRequestId` is the field a vendor asks
   *  for on a support ticket. Set only on a failing outcome. */
  providerFailure?: {
    kind: string;
    providerErrorType?: string;
    status?: number;
    requestId?: string;
    /** The provider's own words, bounded. Not persisted on the row; carried to
     *  the completion log line, where a 400 becomes diagnosable. */
    detail?: string;
  };
  /** The run objective, forwarded to the learning extractor so escalation
   *  memories read "Escalated during \"<objective>\"" instead of an empty
   *  quote. Not persisted on the invocation row itself. */
  objective?: string;
  /** The completing run's live trust (trustRef.current). Not persisted on the invocation row; forwarded
   *  to fireWakeOnJobForCompletedInvocation so a wake_on_job resume inherits the child run's ACTUAL
   * trust rather than a hardcoded default. Absent → the resume assumes untrusted (safe floor). */
  trustLevel?: 'trusted' | 'untrusted_inbound';
  /** Liftoff Switch: the stable reference an IMPORTED routine carries, set on
   *  the trigger that started this run. Present only for scheduled runs of
   *  imported recurring work, and only until the control plane has recorded a
   *  first outcome for it. Not persisted on the invocation row; forwarded so
   *  the migration view can stop saying "awaiting" once the work has actually
   *  run once. */
  migrationRoutineRef?: string;
}

// Aggregated cost stats
export interface CostStats {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  invocationCount: number;
  successfulInvocations: number;
  failedInvocations: number;
}

// Per-agent cost aggregation
export interface AgentCostEntry {
  totalCostUsd: number;
  invocationCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}
