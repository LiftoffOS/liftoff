// HITL Enforcement Types — TR-local.
//
// Single source of truth for shared shapes is @liftoffos/governance-types
// (packages/governance-types in liftoff-platform-backend). Adding a new
// gate reason, sensitivity category, or super-destructive operation
// happens THERE; every consumer reads it through that package. This
// file declares only what is genuinely TR-specific:
//
//   - `HitlGateError` — runtime control-flow exception, not a data
//     shape. Used by executeToolCalls + the workflow hybrid loop catch
//     to thread approvalId through the pause/resume contract.
//   - `OversightSettings.sensitiveWork` is widened to
//     `Partial<Record<SensitivityCategory, boolean>>` because the
//     runtime reads JSONB rows that may legitimately be missing keys
//     (cache rows written before a category was added). The shared
//     OversightSettings uses the strict Record; TR's override makes the
//     gate logic honest about what it actually sees off the wire.
//   - `HitlApprovalRequest`/`CreateApprovalInput` are extended with
//     `injectedSkillIds` — TR's skills flywheel persists which skills
//     were injected for each approval so the post-resolution feedback
//     loop can attribute outcomes back to skills.

export {
  ToolCallRequest,
  ModelTool,
  ApprovalStatus,
  ApprovalDecision,
  RejectionCategory,
  ResolveApprovalInput,
  SensitivityCategory,
  GateReason,
  SUPER_DESTRUCTIVE_OPERATIONS,
  MERGE_TO_MAIN_TOOL_NAMES,
  hardInvariantEffectOf,
  type HardInvariantEffect,
  WITHDRAWN_BY_SYSTEM,
} from '@liftoffos/governance-types';

import type { ApprovedEdits } from './approved-edits';
import type {
  ToolCallRequest,
  SensitivityCategory,
  GateReason,
  GateResult as SharedGateResult,
  OversightSettings as SharedOversightSettings,
  HitlApprovalRequest as SharedHitlApprovalRequest,
  CreateApprovalInput as SharedCreateApprovalInput,
} from '@liftoffos/governance-types';

// The gate's decision, with what a gate raised by the contract check carries
// into the approval's existing columns: `detail` (which contract was checked
// and the recorded probability) and `context` (`contract_check = { kind,
// stepId?, p }`). Display and audit fields, like `detail` on the approval
// request below: TR-local, not part of the shared governance contract.
export interface GateResult extends SharedGateResult {
  detail?: string;
  context?: Record<string, unknown>;
}

// HITL gate error — thrown when human approval is required. Local because
// it's a runtime control-flow primitive, not a wire shape. `reason` types
// against the shared `GateReason` union so adding a new reason in the
// shared package automatically flows here without an edit.
export class HitlGateError extends Error {
  /** Approval row id; stamped by `executeToolCalls` after it calls
   *  `createApprovalRequest` and before re-throwing. The outer workflow
   *  hybrid-loop catch reads this to populate
   *  `HybridResumeState.hitlContext.approvalId`, which
   *  `resumeFromHitlApproval` uses to join back to the approval row on
   *  grant. */
  public approvalId?: string;
  /** Approval-card summary (hitl-card-content.ts), stamped alongside approvalId at the
   *  workflow tool_call gate site; the outer catch reads it into
   *  HybridResumeState.hitlContext so createHitlPause surfaces it on the result. */
  public actionSummary?: string | null;
  public whySummary?: string | null;
  public detail?: string | null;
  /** The gate's own record of why (the contract check's `contract_check`),
   *  for the approval's `context` column. */
  public context?: Record<string, unknown>;
  constructor(
    public readonly pendingToolCalls: ToolCallRequest[],
    public readonly reason: GateReason,
    public readonly matchedCategory?: string,
  ) {
    super('HITL gate: human approval required');
    this.name = 'HitlGateError';
  }
}

// HITL approval request — extends the shared shape with the TR-specific
// `injectedSkillIds` field used by the skills flywheel to attribute
// outcomes back to which skills informed the gated tool call.
export interface HitlApprovalRequest extends SharedHitlApprovalRequest {
  injectedSkillIds: string[];
  /** 'agent' (default) or 'sandbox_code' — see CreateApprovalInput.source. */
  source: 'agent' | 'sandbox_code';
  /** Human-readable approval-card summary generated once at the gate
   *  (src/agent-execution/hitl-card-content.ts) and stored on the row so every
   *  surface renders the same strings. Null on historical rows / when the
   *  generic-card flag is off — consumers fall back to the raw tool-call list.
   *  Display-only; NOT part of the shared governance contract, so it lives on
   *  TR's local extension rather than @liftoffos/governance-types. */
  actionSummary?: string | null;
  whySummary?: string | null;
  detail?: string | null;
  /** Chat thread this gate paused (migration 327). NULL for gates with no
   *  conversation; see CreateApprovalInput.threadId. */
  threadId?: string | null;
  /** Tool inputs the approver rewrote before saying yes, keyed by pending tool
   *  call id (migration 376). NULL for an ordinary approval and on every
   *  rejection.
   *
   *  Beside `pendingToolCalls`, never over them: `toolCallsHash` covers the
   *  calls as the agent proposed them, and the pair is what an audit needs —
   *  what the agent wanted to send, and what a person actually sent. */
  editedToolInputs?: ApprovedEdits | null;
  /** The fingerprint of the calls that will RUN — `pendingToolCalls` with
   *  `editedToolInputs` applied — written when the approval is granted and
   *  verified immediately before dispatch (migration 409). NULL on rows
   *  decided before it, which consumption treats as no fingerprint to check. */
  finalToolCallsHash?: string | null;
  /** What the yes covered: the gate reasons in force for the final calls at
   *  approval time, computed by `evaluateApprovalObligations`. Consumption
   *  recomputes under the settings as they are then and asks again only about
   *  a reason not in this set. NULL before migration 409. */
  grantedObligations?: GateReason[] | null;
  /** The evaluator version that produced `grantedObligations`. */
  obligationsEvaluatorVersion?: number | null;
  /** How the gate classified the pending calls when it fired — the tools as it
   *  saw them and the run facts the reasons depend on. Captured at the pause so
   *  the grant can be recomputed at approval and at consumption; the SETTINGS
   *  are never snapshotted, they are read live both times. */
  gateView?: ApprovalGateView | null;
}

/** The classification inputs a gate decision rests on, as of the pause. */
export interface ApprovalGateView {
  tools: Array<{ name: string; description?: string; effect?: 'read' | 'write' | 'spawn'; categories?: string[]; writeRole?: 'stage' | 'apply' | 'direct' }>;
  trustLevel?: 'trusted' | 'untrusted_inbound';
  externalContentGateDisabled?: boolean;
  triggerTarget?: unknown;
  declaredStep?: unknown;
  runningTotals?: { entitiesTouched: number; destructiveOps: number; clearedFields: number };
}

// Create approval request input — same extension as HitlApprovalRequest.
// Optional because not every gated call has associated skills.
export interface CreateApprovalInput extends Omit<SharedCreateApprovalInput, 'workflowId' | 'taskId'> {
  /** The run's workflow and task ids, present or absent — never a blank. The
   *  columns are nullable uuids; the write translates absence into NULL. A
   *  caller with no workflow (an external-agent call, a chat clarification)
   *  leaves them out rather than passing an empty string. */
  workflowId?: string;
  taskId?: string;
  injectedSkillIds?: string[];
  /** 'agent' (default) = LLM tool-loop pause, resumed by re-running the agent.
   *  'sandbox_code' = a connector call from in-sandbox code, resumed by
   *  executing the connector server-side at approval time (migration 295). */
  source?: 'agent' | 'sandbox_code';
  /** Owning invocation (invocations.id). Persisted to hitl_approval_requests.invocation_id
   *  (migration 312). The trajectory assembler also reads it as an immutable per-trajectory training label. NULL for
   *  session-less paths (sandbox, inbound origin) with no ExecutionContext, and historical rows. */
  invocationId?: string | null;
  /** Approval-card summary generated once at the gate and persisted to
   *  hitl_approval_requests.{action_summary,why_summary,detail} (migration 313).
   *  Display-only; see HitlApprovalRequest above. */
  actionSummary?: string | null;
  whySummary?: string | null;
  detail?: string | null;
  /** Chat thread this gate paused (migration 327), so the decision can be posted
   *  back into the conversation that stalled. NULL for workflow, scheduled and
   *  sandbox gates, which have no thread. */
  threadId?: string | null;
  /** See HitlApprovalRequest.gateView. Captured by the gate site, which is the
   *  one place the catalog and the run facts are both in hand. */
  gateView?: ApprovalGateView | null;
}

// Oversight settings as TR reads them from `tenant_oversight_cache`
// (sensitive_work is a JSONB column). Older cache rows may not
// have `mergeToMain`; legacy cache rows may also be missing categories
// added by future PB updates. Widening `sensitiveWork` to
// `Partial<Record<...>>` makes the type honest about what JSONB can
// hold — consumers must treat every key as possibly-undefined, which is
// the right discipline for cache-aside reads. The shared package keeps
// the strict shape because PB controls every write and always emits
// all keys; the looser shape lives here at the read boundary.
export interface OversightSettings extends Omit<SharedOversightSettings, 'sensitiveWork'> {
  sensitiveWork: Partial<Record<SensitivityCategory, boolean>>;
  /** Which meaning of the Escalation setting the workspace chose under:
   *  1 = before the surfacing policy (hitl-enforcement/surfacing.ts), 2 = the
   *  page's stated levels. The reader sets it from the cache row or the wire;
   *  absent or unparseable reads as 1 (`semanticsOf`), so an older control
   *  plane or a snapshot from before the columns keeps today's behaviour. */
  escalationSemantics?: number;
  /** The same for the Communication setting: 2 = the message check's
   *  Review-direction clearing is in force (Phase 7). */
  communicationSemantics?: number;
}

/** A semantics column as the runtime reads it: an integer 1 or above, else 1. */
export function semanticsOf(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
