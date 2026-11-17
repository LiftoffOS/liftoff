// review.json: the two runtime feeds, late feedback, and both status tables.
//
// `As of` governs recorded decisions as well as records. Filtering on creation
// alone would let an approval created yesterday and decided during assembly
// export as "Approved" against an As of that predates the decision, so each
// table is an ORDERED decision procedure: the test on the transition timestamp
// comes BEFORE any reading of the terminal status, and a row that moved after
// the cutoff is projected as it stood before.

import { walkRemote, type ExportBudget } from './budget';
import {
  tenantRuntimeClient,
  type ReviewHistoryApproval,
  type ReviewHistoryClarification,
} from '../connectors/tenant-runtime-client';
import { readLateFeedback, type LateFeedbackRow } from './queries';
import {
  describeToolCall,
  toDetailFields,
  redactSecrets,
  detailFieldsToObject,
  detailNote,
  scrubKnownIds,
  type KnownIds,
} from './action-format';
import {
  REVIEW_KEYS as K,
  LEVEL_LABELS,
  REASON_LABELS,
  UNKNOWN_REASON,
  APPROVAL_STATUS_LABELS,
  CLARIFICATION_STATUS_LABELS,
  WOULD_HAVE_LABELS,
  UNKNOWN_AI_TEAM,
} from './labels';

export interface CollectedReview {
  approvals: ReviewHistoryApproval[];
  clarifications: ReviewHistoryClarification[];
  lateFeedback: LateFeedbackRow[];
}

export async function collectLateFeedback(
  tenantId: string, asOf: Date, budget: ExportBudget,
): Promise<LateFeedbackRow[]> {
  return readLateFeedback(tenantId, asOf, budget);
}

export async function collectRuntimeReview(
  tenantId: string, asOf: Date, budget: ExportBudget,
): Promise<{ approvals: ReviewHistoryApproval[]; clarifications: ReviewHistoryClarification[] }> {
  const approvals = await walkRemote<ReviewHistoryApproval>('tenant_runtime', budget, (cursor, limit) =>
    tenantRuntimeClient.listReviewHistoryApprovals(tenantId, { asOf, cursor, limit }));
  const clarifications = await walkRemote<ReviewHistoryClarification>('tenant_runtime', budget, (cursor, limit) =>
    tenantRuntimeClient.listReviewHistoryClarifications(tenantId, { asOf, cursor, limit }));
  return { approvals, clarifications };
}

// ── Projection ──────────────────────────────────────────────────────────

export interface ReviewContext {
  asOf: Date;
  /** accounts.id → what the person recognises. */
  accountName: (accountId: string) => string | undefined;
  /** Late-feedback rows by approval id, already bounded by asOf in SQL. */
  lateFeedbackByApproval: ReadonlyMap<string, LateFeedbackRow>;
  known: KnownIds;
}

export interface RequestedAction {
  [K.app]?: string;
  [K.action]: string;
  [K.details]?: Record<string, unknown>;
  [K.changedByApprover]?: true;
}

export interface FeedbackAfterWindow {
  [K.wouldHave]: string;
  [K.rejectionReason]?: string;
  [K.by]?: string;
  [K.sent]: string;
}

export interface ApprovalEntry {
  [K.aiTeam]: string;
  [K.requested]?: string;
  [K.level]?: string;
  [K.reason]?: string;
  [K.requestedActions]?: string | RequestedAction[];
  [K.why]?: string;
  [K.details]?: string;
  [K.status]: string;
  [K.decidedBy]?: string;
  [K.decided]?: string;
  [K.rejectionReason]?: string;
  [K.feedbackAfterWindow]?: FeedbackAfterWindow;
}

export interface ClarificationEntry {
  [K.aiTeam]: string;
  [K.asked]?: string;
  [K.question]: string;
  [K.status]: string;
  [K.answeredBy]?: string;
  [K.answered]?: string;
  [K.declinedBy]?: string;
  [K.declined]?: string;
}

const after = (iso: string | null, asOf: Date): boolean => iso !== null && new Date(iso).getTime() > asOf.getTime();

function agentLabel(item: { agentName?: string | null }): string {
  return item.agentName?.trim() || UNKNOWN_AI_TEAM;
}

/** The requested actions as the page renders them: `action_summary` when the
 *  row has one and the approver changed nothing; otherwise one entry per
 *  pending call, written by the port of the page's own functions. */
function requestedActions(
  approval: ReviewHistoryApproval, known: KnownIds,
): string | RequestedAction[] | undefined {
  const edits = approval.editedToolInputs ?? {};
  const calls = approval.pendingToolCalls ?? [];
  const edited = calls.some((call) => Object.prototype.hasOwnProperty.call(edits, call.id));
  if (!edited && approval.actionSummary) return approval.actionSummary;
  if (calls.length === 0) return undefined;
  return calls.map((call) => {
    const { connector, action } = describeToolCall(call.name);
    const input = edits[call.id] ?? call.input;
    const fields = toDetailFields(redactSecrets(input) as Record<string, unknown>);
    const details = scrubKnownIds(detailFieldsToObject(fields), known) as Record<string, unknown>;
    return {
      ...(connector !== null ? { [K.app]: connector } : {}),
      [K.action]: action,
      ...(Object.keys(details).length > 0 ? { [K.details]: details } : {}),
      ...(Object.prototype.hasOwnProperty.call(edits, call.id) ? { [K.changedByApprover]: true as const } : {}),
    };
  });
}

/**
 * Approval `Status`, the complete table over `hitl_approval_requests.status`,
 * evaluated in order:
 *   1. approved/rejected decided after asOf → as if still pending (step 4)
 *   2. withdrawn after asOf → as if still pending
 *   3. approved / rejected / withdrawn
 *   4. expires_at null or after asOf → Awaiting decision; else Passed, with
 *      the late feedback recorded at or before asOf.
 */
export function projectApproval(approval: ReviewHistoryApproval, ctx: ReviewContext): ApprovalEntry {
  const entry: ApprovalEntry = {
    [K.aiTeam]: agentLabel(approval),
    ...(approval.createdAt !== null ? { [K.requested]: approval.createdAt } : {}),
    ...(approval.hitlLevel !== null && LEVEL_LABELS[approval.hitlLevel] !== undefined
      ? { [K.level]: LEVEL_LABELS[approval.hitlLevel] }
      : {}),
    ...(approval.reason !== null ? { [K.reason]: REASON_LABELS[approval.reason] ?? UNKNOWN_REASON } : {}),
    [K.status]: '',
  };
  const actions = requestedActions(approval, ctx.known);
  if (actions !== undefined) entry[K.requestedActions] = actions;
  if (approval.whySummary) entry[K.why] = approval.whySummary;
  // Only what the stored detail line says that the calls do not: the
  // blast-radius measurement, or an older row's free prose. The rest of that
  // line IS the flattened call, arguments and all, which the entry above
  // already carries redacted and scrubbed.
  const note = detailNote(approval.detail, approval.pendingToolCalls ?? []);
  if (note !== null) entry[K.details] = note;

  const status = approval.status;
  const decidedAfter = (status === 'approved' || status === 'rejected') && after(approval.decidedAt, ctx.asOf);
  const withdrawnAfter = status === 'withdrawn' && after(approval.updatedAt, ctx.asOf);

  if (!decidedAfter && !withdrawnAfter) {
    if (status === 'approved' || status === 'rejected') {
      entry[K.status] = status === 'approved' ? APPROVAL_STATUS_LABELS.approved : APPROVAL_STATUS_LABELS.rejected;
      const decidedBy = approval.decidedBy ? ctx.accountName(approval.decidedBy) : undefined;
      if (decidedBy !== undefined) entry[K.decidedBy] = decidedBy;
      if (approval.decidedAt !== null) entry[K.decided] = approval.decidedAt;
      if (status === 'rejected' && approval.rejectionReason) entry[K.rejectionReason] = approval.rejectionReason;
      return entry;
    }
    if (status === 'withdrawn') {
      entry[K.status] = APPROVAL_STATUS_LABELS.withdrawn;
      return entry;
    }
  }

  if (approval.expiresAt === null || after(approval.expiresAt, ctx.asOf)) {
    entry[K.status] = APPROVAL_STATUS_LABELS.awaiting;
    return entry;
  }
  entry[K.status] = APPROVAL_STATUS_LABELS.passed;
  const feedback = ctx.lateFeedbackByApproval.get(approval.id);
  if (feedback) {
    const by = ctx.accountName(feedback.decided_by);
    entry[K.feedbackAfterWindow] = {
      [K.wouldHave]: WOULD_HAVE_LABELS[feedback.decision] ?? feedback.decision,
      ...(feedback.rejection_reason ? { [K.rejectionReason]: feedback.rejection_reason } : {}),
      ...(by !== undefined ? { [K.by]: by } : {}),
      [K.sent]: feedback.created_at.toISOString(),
    };
  }
  return entry;
}

/**
 * Clarification `Status`, the complete table over
 * `agent_scheduled_invocations.status` joined with `resolution_kind`:
 *   1. a non-pending row whose transition is after asOf → as if still pending
 *   2. answered / declined (with the actor) / expired → Passed
 *   3. cancelled → Cancelled; errored → Failed; any other non-pending row with
 *      no resolution_kind (pre-migration history) → Resolved
 *   4. fires_at after asOf → Awaiting answer; else Passed.
 * `transitioned_at` is resolved_at when set, else cancelled_at for a cancelled
 * row, else fired_at for a fired row, else updated_at.
 */
export function projectClarification(c: ReviewHistoryClarification, ctx: ReviewContext): ClarificationEntry {
  const entry: ClarificationEntry = {
    [K.aiTeam]: agentLabel(c),
    ...(c.createdAt !== null ? { [K.asked]: c.createdAt } : {}),
    [K.question]: c.question,
    [K.status]: '',
  };
  const transitionedAt = c.resolvedAt
    ?? (c.status === 'cancelled' ? c.cancelledAt : null)
    ?? (c.status === 'fired' ? c.firedAt : null)
    ?? c.updatedAt;
  const movedAfter = c.status !== 'pending' && after(transitionedAt, ctx.asOf);

  if (!movedAfter) {
    const actor = (c.resolvedBy ? ctx.accountName(c.resolvedBy) : undefined) ?? c.resolvedByLabel ?? undefined;
    if (c.resolutionKind === 'answered') {
      entry[K.status] = CLARIFICATION_STATUS_LABELS.answered;
      if (actor !== undefined) entry[K.answeredBy] = actor;
      if (c.resolvedAt !== null) entry[K.answered] = c.resolvedAt;
      return entry;
    }
    if (c.resolutionKind === 'declined') {
      entry[K.status] = CLARIFICATION_STATUS_LABELS.declined;
      if (actor !== undefined) entry[K.declinedBy] = actor;
      if (c.resolvedAt !== null) entry[K.declined] = c.resolvedAt;
      return entry;
    }
    if (c.resolutionKind === 'expired') {
      entry[K.status] = CLARIFICATION_STATUS_LABELS.passed;
      return entry;
    }
    if (c.status === 'cancelled') {
      entry[K.status] = CLARIFICATION_STATUS_LABELS.cancelled;
      return entry;
    }
    if (c.status === 'errored') {
      entry[K.status] = CLARIFICATION_STATUS_LABELS.failed;
      return entry;
    }
    if (c.status !== 'pending') {
      entry[K.status] = CLARIFICATION_STATUS_LABELS.resolved;
      return entry;
    }
  }

  entry[K.status] = after(c.firesAt, ctx.asOf)
    ? CLARIFICATION_STATUS_LABELS.awaiting
    : CLARIFICATION_STATUS_LABELS.passed;
  return entry;
}
