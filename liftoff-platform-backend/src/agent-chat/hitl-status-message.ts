// The sentence a paused thread posts into itself.
//
// This is a persisted chat message, not the banner. The distinction drives every
// choice here: one row is read by everyone in the thread, so it cannot address
// the reader. "Waiting on your review" is correct on the banner, which renders
// only for people who must act, and wrong here, where the same text reaches the
// person waiting, the person who triggered it, and three bystanders.
//
// So this is third person throughout, and names people rather than roles
// wherever it can.

import type { ApprovalRouteDescription } from './approval-route-description';

/** "Ada", "Ada and Grace", "Ada, Grace and 2 others". Mirrors the banner's
 *  describePeople so the two surfaces summarise a crowd the same way. */
function describePeople(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/**
 * What the thread says when a gate pauses it.
 *
 * Falls back to the vaguest honest sentence rather than naming the wrong person:
 * route resolution is best-effort, and a gate whose audience could not be
 * resolved still stopped the conversation and still needs explaining.
 */
export function waitingMessage(route: ApprovalRouteDescription): string {
  if (route.names.length > 0) {
    return `Waiting on ${describePeople(route.names)} to approve before continuing.`;
  }
  // No eligible assignee, so it escalated. Naming the role is honest: these are
  // whoever holds the role today, not people anyone chose for this team.
  if (route.toAdmins) {
    return 'Waiting on a workspace admin to approve before continuing.';
  }
  // Nobody is assigned, so it belongs to the workspace at large.
  if (route.unassigned) {
    return 'Waiting on a workspace member to approve before continuing.';
  }
  return 'Waiting on a review before continuing.';
}

/**
 * What the thread says once somebody decides.
 *
 * `decidedBy` is a display name resolved by the caller. It falls back to the
 * role-less form rather than printing an account id, which would mean nothing
 * to anyone reading the conversation.
 */
export function decisionMessage(
  decision: 'approved' | 'rejected',
  decidedBy?: string | null,
): string {
  const verb = decision === 'approved' ? 'Approved' : 'Rejected';
  return decidedBy ? `${verb} by ${decidedBy}.` : `${verb}.`;
}

/** Marks these rows so the UI can render them as status rather than speech, and
 *  so they can be kept out of the model's context. */
export const HITL_STATUS_MESSAGE_TYPE = 'hitl_status';

/** A status row about a DELEGATED team's approval, as opposed to this team's
 *  own gate. Its own type rather than a copy convention: the row carries an
 *  affordance (the way to the review queue, where the other team's approval
 *  waits) that the team's own gate rows must not, because their audience is
 *  already routed by the banner. Distinguishing them by matching the sentence
 *  text would break the affordance on the day anybody rewords the sentence.
 *  Excluded from the model's context exactly like hitl_status. */
export const DELEGATION_STATUS_MESSAGE_TYPE = 'delegation_status';

/** What the thread says when a team it delegated work to stops for approval. */
export function delegatedWaitingMessage(delegateName: string | null): string {
  return delegateName
    ? `${delegateName} is waiting on an approval in the review queue before it can continue the delegated work.`
    : 'A team this conversation delegated work to is waiting on an approval in the review queue.';
}

/** A status row saying the person handed the browser back: "<name> handed the
 *  browser back". Written by the stream router of every chat surface when
 *  the person's hand-back starts a turn; rendered as status, kept out of the
 *  model's context, and never a reply for the unread clock. */
export const BROWSER_HANDBACK_MESSAGE_TYPE = 'browser_handback';

/** A status row saying what the person pointed at in the browser without
 *  taking over: "<name> pointed at link "Sports"". Handled as the hand-back
 *  row is. */
export const BROWSER_POINT_MESSAGE_TYPE = 'browser_point';
