// A pending review left behind by a dead run wedges every run after it.
//
// GitHub allows ONE pending (draft) review per pull request per user. The
// three-op review flow opens the container at `pr_review_begin`
// (`pull_request_review_write { method: 'create' }`), attaches findings to it,
// and publishes at `pr_review_publish`. Any run that dies between the first and
// the last leaves the container open — and because the agent is a single user
// (the GitHub App installation), the NEXT run cannot open its own:
//
//   workflow step failed and routed to its onFailure branch
//   stepId: s7   error: "User can only have one pending review per pull request"
//
// That error is permanent by the retry contract, so `executeToolStep` stops on
// the first attempt and the step takes its failure branch. The run completes,
// reports success, and posts nothing. Nothing clears the container either: the
// only operation that can is `delete_pending`, and no path in the graph calls
// it. So the wedge is PERMANENT — every subsequent review dies at the same step
// until a human opens the pull request and discards the draft by hand.
//
// Getting everything else right does not help: every trigger-bound step can
// resolve, the gate can raise nothing, and s7 still fails on a draft left over
// from an earlier dead run.
//
// WHY DISCARD RATHER THAN ADOPT
// ─────────────────────────────
// Adopting the existing container — treating "one already exists" as success —
// is tempting: the step's postcondition is "there is a container to write
// into", and there is one. But its contents are a PREVIOUS run's half-written
// findings against a DIFFERENT commit. Publishing those as this run's review
// would attribute stale, possibly wrong comments to code that has since
// changed, and the run would have no way to tell it had done so. A review that
// says the wrong thing is worse than a review that is late.
//
// WHY THIS IS SAFE TO DO WITHOUT ASKING
// ─────────────────────────────────────
// `delete_pending` is already reasoned about in `hitl-enforcement/
// in-place-reply.ts`, which permits it in place with: "Opening and discarding a
// DRAFT reach nobody. Nothing is visible on the pull request until it is
// submitted, so there is no external effect to bound and no third party to
// reach." The operation cannot touch a human's review either — GitHub scopes
// the pending review to the authenticated user, so the agent can only discard
// its own.
//
// The repair still goes through `executeToolCalls` like any other call, with NO
// gate bypass. A self-healing path that quietly exempts itself from oversight is
// how a carve-out becomes a hole; if this ever does gate, that is a fact worth
// seeing rather than one worth hiding.

import type { ToolCallRequest } from './types';

/** The bare action name from `<alias>__<action>`, or the name itself. */
function bareAction(name: string): string {
  const i = name.lastIndexOf('__');
  return i < 0 ? name : name.slice(i + 2);
}

/** The one operation that can open a review container. */
const REVIEW_WRITE_ACTION = 'pull_request_review_write';

/**
 * GitHub's refusal, matched on its stable clause.
 *
 * Deliberately narrow. Matching loosely on "pending review" would also catch
 * `add_comment_to_pending_review` failing because there is NO pending review —
 * the opposite condition, where deleting is exactly wrong.
 */
const ONE_PENDING_REVIEW = /only have one pending review/i;

/**
 * Is this failure the stale-container wedge, on the call that opens one?
 *
 * Fail closed on every leg: a different action, a different method, or a
 * different error is not this condition and gets today's behaviour.
 */
export function isStalePendingReviewBlock(
  call: Pick<ToolCallRequest, 'actionType' | 'payload'>,
  error: string | undefined,
): boolean {
  if (!error || !ONE_PENDING_REVIEW.test(error)) return false;
  if (bareAction(call.actionType ?? '') !== REVIEW_WRITE_ACTION) return false;
  const method = (call.payload as { method?: unknown } | undefined)?.method;
  return typeof method === 'string' && method.toLowerCase() === 'create';
}

/**
 * The discard call, addressed at the SAME pull request as the blocked create.
 *
 * Identity is copied from the call that failed rather than rebuilt, because the
 * failed call's arguments were themselves built by `resolveTriggerBoundTool`
 * from the triggering event record. Rebuilding them here would be a second,
 * independently-wrong way to say which pull request we mean — which is the
 * reconstruction defect this codebase has already paid for three times.
 */
export function buildDiscardPendingReviewCall(
  call: ToolCallRequest,
  id: string,
): ToolCallRequest {
  const payload = { ...(call.payload as Record<string, unknown> | undefined ?? {}) };
  // Only the verb changes. `event` and `body` belong to submit_pending and are
  // meaningless on a discard; carrying them through invites the vendor to
  // reject arguments it did not ask for.
  delete payload.event;
  delete payload.body;
  payload.method = 'delete_pending';
  return {
    ...call,
    id,
    payload,
  };
}
