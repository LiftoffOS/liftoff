// Decide a review: the one function behind the dashboard's approve/reject
// routes, the Slack and Teams buttons, and the assistants' review_decide.
//
// The body is the oversight route's, lifted out, so every surface applies the
// same level rule (canApproveHitl against the approval's own level, or level
// 1 when the approval cannot be read), the same standing-decision rule
// (alwaysApply is offered only where the gate reason allows it), and the same
// side effects — the runtime call, the audit row under the person, the
// approval.decided lifecycle event for the customer's own systems, the
// Slack/Teams sibling-card update, and the decision posted back into the
// conversation the gate paused. A Slack-origin decision used to skip the last
// three; now it cannot.

import { tenantRuntimeClient, HitlError, type HitlApproval, type QueueItem, type QueueWindow, type PendingItemsCount } from '../connectors/tenant-runtime-client';
import { enqueueLifecycleEvent } from '../event-sources/outbound-webhooks';
import { log } from '../infrastructure/logging';
import { canApproveHitl } from './permissions';
import type { Actor } from './actor';
import { writeAudit } from './audit';

export type EditedToolInputs = Record<string, Record<string, unknown>>;

// The closed set the tenant runtime writes to hitl_approval_requests.reason.
export type GateReason =
  | 'level_1_gate' | 'destructive_gate' | 'super_destructive_gate' | 'sensitive_work'
  | 'communication_review' | 'rate_limit_exceeded' | 'merge_to_main'
  | 'external_content_write' | 'blast_radius';

// Gate reasons too high-risk to offer a standing "always apply" decision — each
// must get a fresh human decision. Mirror of tenant-runtime's
// standingApprovalAllowed and of the dashboard's (services/oversight.ts): the
// runtime enforces this authoritatively; here it keeps an assistant from
// carrying a standing decision the person could not have asked for on the
// page. `blast_radius` belongs here for the reason it exists: a standing
// "always approve" on a gate that fires BECAUSE the change is large would
// switch the feature off on its first use.
export const STANDING_APPROVAL_SUPPRESSED: ReadonlySet<string> = new Set<GateReason>([
  'super_destructive_gate', 'merge_to_main', 'sensitive_work', 'blast_radius',
]);

export function standingApprovalAllowed(reason: string): boolean {
  return !STANDING_APPROVAL_SUPPRESSED.has(reason);
}

export type ReviewDecisionRefusal = {
  refused: 'not_found' | 'forbidden' | 'already_decided' | 'expired' | 'tamper_detected' | 'standing_not_allowed';
  message: string;
  lateFeedbackEndpoint?: string;
  /** The status and code the dashboard route answers with (HitlError's). */
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
};

export type ReviewDecisionResult = { approval: HitlApproval } | ReviewDecisionRefusal;

/** Best-effort: grey out any Slack/Teams review cards after a decision. The
 *  Slack/Teams button paths already update their own cards (idempotent with
 *  this); the web dashboard did not, which left stale clickable "Approve"
 *  cards behind. Fire-and-forget — never blocks the caller. */
export function updateReviewSiblingCards(tenantId: string, reviewId: string, agentId: string, footer: string): void {
  void import('../agent-chat/slack-adapter/review-dm-notifier')
    .then(({ chatUpdateAllSiblingCards }) => chatUpdateAllSiblingCards({ reviewId, tenantId, footer }))
    .catch(() => undefined);
  void import('../agent-chat/teams-adapter/review-card-notifier')
    .then(({ updateAllReviewCards }) => updateAllReviewCards(tenantId, reviewId, agentId, footer))
    .catch(() => undefined);
}

/** Best-effort: post the outcome back into the conversation the gate paused, so
 *  the thread that said "waiting on Ada" goes on to say who decided and the
 *  record survives in history. Fire-and-forget for the same reason as the card
 *  update above: a decision must not fail because a message could not be posted.
 *
 *  Silent when the approval has no thread — workflow, scheduled and sandbox
 *  gates have no conversation to post into (tenant-runtime migration 327). */
export function postDecisionToThread(
  tenantId: string,
  threadId: string | null | undefined,
  agentId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string | null,
): void {
  if (!threadId) return;
  void (async () => {
    const [{ appendMessage }, { decisionMessage, HITL_STATUS_MESSAGE_TYPE }] = await Promise.all([
      import('../agent-chat/chat-repository'),
      import('../agent-chat/hitl-status-message'),
    ]);
    await appendMessage(
      tenantId,
      threadId,
      'assistant',
      decisionMessage(decision, decidedBy),
      agentId,
      null, 0, 0,
      HITL_STATUS_MESSAGE_TYPE,
    );
  })().catch(() => undefined);
}

/** Tell the customer's own systems, if any asked. Fire-and-forget by
 *  construction — one INSERT, no socket — so a registered endpoint can never
 *  slow down or fail a decision. */
export { enqueueLifecycleEvent };

const SURFACE_FOOTER: Record<Actor['surface'], string> = {
  dashboard: 'via Liftoff Dashboard',
  liftoff: 'via Liftoff',
  caio: 'via the Chief AI Officer',
  insights: 'via the Insights Manager',
  slack: 'via Slack',
  teams: 'via Microsoft Teams',
};

function lateFeedbackEndpoint(approvalId: string): string {
  return `/api/internal-agent-oversight/hitl-approvals/${approvalId}/late-feedback`;
}

function refusalFromHitlError(error: HitlError, approvalId: string): ReviewDecisionRefusal {
  const refused: ReviewDecisionRefusal['refused'] =
    error.errorCode === 'EXPIRED' ? 'expired'
      : error.errorCode === 'ALREADY_DECIDED' ? 'already_decided'
        : error.errorCode === 'TAMPER_DETECTED' ? 'tamper_detected'
          : 'not_found';
  return {
    refused,
    message: error.message,
    status: error.status,
    code: error.errorCode,
    details: error.details,
    ...(error.errorCode === 'EXPIRED' ? { lateFeedbackEndpoint: lateFeedbackEndpoint(approvalId) } : {}),
  };
}

export async function decideReview(
  actor: Actor,
  approvalId: string,
  decision: 'approve' | 'reject',
  opts: { alwaysApply?: boolean; approvalNote?: string; reason?: string; editedToolInputs?: EditedToolInputs } = {},
): Promise<ReviewDecisionResult> {
  const { tenantId } = actor;

  // A readable approval authorizes against its own level. An UNREADABLE one
  // authorizes against level 1 — the stricter of the two — because we cannot
  // see what we would be deciding and must not assume the cheaper rule.
  const approvalToCheck = await tenantRuntimeClient.getApproval(tenantId, approvalId);
  const hitlLevel = (approvalToCheck ? approvalToCheck.hitlLevel || 2 : 1) as 1 | 2;
  if (!canApproveHitl(actor.role, hitlLevel)) {
    return {
      refused: 'forbidden',
      message: `Level ${hitlLevel} HITL approvals require ${hitlLevel === 1 ? 'admin' : 'member'} role or higher`,
      status: 403,
      code: 'FORBIDDEN',
    };
  }

  // A standing decision is offered only where the gate reason allows one; a
  // request for one anywhere else is dropped, and the caller is told so
  // rather than left believing it stuck.
  let alwaysApply = opts.alwaysApply === true;
  let standingDropped = false;
  if (alwaysApply && approvalToCheck && !standingApprovalAllowed(approvalToCheck.reason)) {
    alwaysApply = false;
    standingDropped = true;
  }

  const approvalNote = opts.approvalNote?.trim() || undefined;

  let approval: HitlApproval | null;
  try {
    approval = decision === 'approve'
      ? await tenantRuntimeClient.approveRequest(
        tenantId, approvalId, actor.accountId, actor.role, alwaysApply, approvalNote, opts.editedToolInputs,
      )
      : await tenantRuntimeClient.rejectRequest(
        tenantId, approvalId, actor.accountId, actor.role, opts.reason, alwaysApply,
      );
  } catch (error) {
    if (error instanceof HitlError) return refusalFromHitlError(error, approvalId);
    throw error;
  }
  if (!approval) {
    return { refused: 'not_found', message: 'Approval not found', status: 404, code: 'NOT_FOUND' };
  }

  const outcome = decision === 'approve' ? 'approved' : 'rejected';
  writeAudit(actor, decision === 'approve' ? 'hitl.approved' : 'hitl.rejected', {
    tenantId,
    approvalId,
    alwaysApply,
    ...(decision === 'approve' ? { noteProvided: !!approvalNote } : { reason: opts.reason }),
    ...(standingDropped ? { standingDropped: true } : {}),
  });
  void enqueueLifecycleEvent({
    tenantId,
    eventType: 'approval.decided',
    payload: {
      approvalId,
      agentId: approval.agentId,
      decision: outcome,
      decidedBy: actor.accountId,
      alwaysApply,
      ...(decision === 'reject' ? { reason: opts.reason } : {}),
    },
  });
  updateReviewSiblingCards(
    tenantId, approvalId, approval.agentId,
    `${decision === 'approve' ? 'Approved' : 'Rejected'} ${SURFACE_FOOTER[actor.surface]}.`,
  );
  postDecisionToThread(tenantId, approvalToCheck?.threadId, approval.agentId, outcome, actor.displayName || null);

  if (standingDropped) {
    log.info({ tenantId, approvalId, reason: approvalToCheck?.reason }, 'review: standing decision dropped for a gate that does not allow one');
  }
  return { approval };
}

// ── Clarifications ──────────────────────────────────────────────────────

export type ClarificationResult =
  | { done: true }
  | { refused: 'not_found' | 'already_resolved'; message: string };

// The runtime's two refusals, in the precedence the dashboard routes have
// always applied: a status code when the client attached one, then the
// message — "already resolved" before "not found", because the Connect
// method's one message names both.
function clarificationRefusal(err: Error & { status?: number }): ClarificationResult | null {
  if (err.status === 404) return { refused: 'not_found', message: 'Clarification not found' };
  if (err.status === 409) return { refused: 'already_resolved', message: err.message };
  if (err.message.includes('already resolved')) return { refused: 'already_resolved', message: err.message };
  if (err.message.includes('not found')) return { refused: 'not_found', message: err.message };
  return null;
}

export async function answerClarification(
  actor: Actor,
  clarificationId: string,
  response: string,
): Promise<ClarificationResult> {
  try {
    await tenantRuntimeClient.respondToClarification(actor.tenantId, clarificationId, response, actor.accountId);
  } catch (e) {
    const refusal = clarificationRefusal(e as Error & { status?: number });
    if (refusal) return refusal;
    throw e;
  }
  writeAudit(actor, 'hitl.clarification_answered', { tenantId: actor.tenantId, clarificationId });
  return { done: true };
}

export async function declineClarification(
  actor: Actor,
  clarificationId: string,
  reason?: string,
): Promise<ClarificationResult> {
  try {
    await tenantRuntimeClient.declineClarification(actor.tenantId, clarificationId, actor.accountId, reason);
  } catch (e) {
    const refusal = clarificationRefusal(e as Error & { status?: number });
    if (refusal) return refusal;
    throw e;
  }
  writeAudit(actor, 'hitl.clarification_declined', { tenantId: actor.tenantId, clarificationId, reason });
  return { done: true };
}

// ── The queue ───────────────────────────────────────────────────────────

/** The review queue as the page reads it: the page and its counts from the
 *  same runtime predicate, fetched together. `agentId` is the RUNTIME's
 *  agents.id (ADR-039); callers translate a team through the runtime's
 *  mapping, never a local table. */
export async function listReviews(
  tenantId: string,
  opts: { window?: QueueWindow; agentId?: string; cursor?: string; limit?: number } = {},
): Promise<{ items: QueueItem[]; nextCursor: string | null; counts: PendingItemsCount | null }> {
  const [result, counts] = await Promise.all([
    tenantRuntimeClient.listPendingApprovals(tenantId, {
      cursor: opts.cursor, limit: opts.limit, agentId: opts.agentId, window: opts.window,
    }),
    tenantRuntimeClient.getPendingApprovalCount(tenantId, { agentId: opts.agentId }),
  ]);
  return { items: result.items, nextCursor: result.nextCursor, counts };
}
