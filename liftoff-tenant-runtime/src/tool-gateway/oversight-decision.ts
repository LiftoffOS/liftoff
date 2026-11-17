// Communication-mode oversight gate, extracted from mcp-server.ts so BOTH the
// LLM tool catalog AND the sandbox-code dispatch path apply identical logic.
//
// Maps the workspace `communication` oversight policy (draft / review / auto)
// onto an outbound connector tool. Pure function — no I/O, no closure capture.
//
//   communication='draft'                          → DRAFT where a draft form exists,
//                                                    else an approvable pause
//   communication='review' + matches sensitiveWork → an approvable pause, then the
//                                                    REAL send once a person approves
//   communication='review' + no sensitive match    → ALLOW
//   communication='auto' (or no oversight)         → ALLOW
//
// The two settings mean two different things. "Draft first" means the message is
// saved for a person to review and send from their own client: the LLM catalog
// registers only the draft form (skip_for_draft) and the outbound tool never
// runs. "Review" means a person reviews the send itself, in the dashboard, and
// the outbound tool runs as sent once they approve (require_approval) — a draft
// would substitute a different action for the one they were asked to approve.
// The sandbox path treats any non-`allow` decision as "must gate" because
// in-sandbox code calls the outbound tool directly (it can't be silently swapped
// for the draft variant the way the LLM catalog is).

import type { OversightSettings } from '../hitl-enforcement/types';

export const OUTBOUND_CATEGORIES = new Set(['outbound', 'externalPublishing', 'customerCommunication']);

export type OversightFilterDecision =
  | { kind: 'allow' }
  | { kind: 'skip_for_draft' }
  /** No draft form exists, so the call must produce an APPROVABLE pause — something
   *  the user can act on in /dashboard/review. Formerly `wrap_with_hitl`, which named
   *  the mechanism (wrap the handler, throw at execute time) rather than the
   *  requirement, and that mechanism silently failed: the throw was swallowed by the
   *  in-process McpServer and reached the model as an ordinary tool error, so the call
   *  was blocked with no approval record and the run reported success. */
  | { kind: 'require_approval'; reason: string };

/**
 * Is this tool's call an outbound one, i.e. governed by the Communication policy?
 *
 * The ONE definition. hitl-enforcement's external-content invariant exempts outbound
 * calls on the grounds that Communication already routes them, and that reasoning only
 * holds if both sites agree exactly on which calls those are. A second copy of the
 * predicate, however carefully mirrored, can drift into exempting a call the policy
 * does not pick up, which would leave it neither gated nor governed.
 *
 * Case-sensitive, matching the category vocabulary the catalog actually emits
 * (`outbound` on connector tools, `customerCommunication` / `externalPublishing` on
 * vendor MCP tools, which never carry `outbound`).
 */
export function isOutboundTool(fn: { categories?: string[] } | undefined): boolean {
  return (fn?.categories ?? []).some(c => OUTBOUND_CATEGORIES.has(c));
}

/** Categories that would make a message leave the workspace, or do something a
 *  notification never does. Any one of them disqualifies the internal-only
 *  reading below, so a tool tagged both internal and outbound is outbound. */
const NOT_INTERNAL_ONLY = new Set([
  ...OUTBOUND_CATEGORIES,
  'destructive',
  'admin',
]);

/**
 * A message into the workspace's OWN Slack or Teams — the agent telling its
 * colleagues something, not writing anything external.
 *
 * `internalCollaboration` is the category the agent Slack and Teams catalogs
 * tag every post with, and until now no policy read it. That left those tools in
 * a gap: not outbound, so `oversightDecisionFor` returns `allow` and the
 * Communication policy never governs them — and not read, so the
 * external_content_write invariant counted them as unknown effectful writes and
 * gated. Oversight said yes and the invariant said no.
 *
 * So an agent handling an inbound customer email that routes to escalation and
 * tries to post the escalation to `#customer-support` pauses for approval. An
 * escalation exists to tell a
 * person that something needs a person; requiring an approval to deliver that
 * notification is circular, and it stops the run before the customer
 * acknowledgement that follows it.
 *
 * Scoped by exclusion, not by name: a tool carrying any outbound, destructive or
 * admin category is not internal-only however it is also tagged.
 */
export function isInternalCollaborationTool(
  fn: { categories?: string[] } | undefined,
): boolean {
  const cats = fn?.categories ?? [];
  if (!cats.includes('internalCollaboration')) return false;
  return !cats.some(c => NOT_INTERNAL_ONLY.has(c));
}

/**
 * The enabled sensitive-work category this outbound tool falls under, or null.
 *
 * A tool matches a toggle by carrying its category outright — the vendor-MCP
 * classifier tags a 1:1 message `customerCommunication`, and that is read as
 * written. A tool carrying only the generic `outbound` category — every native
 * connector's send, whose registry names no finer class — falls under
 * `externalPublishing`, because that is the toggle whose scope is external
 * email and chat. Without this, Review had nothing to match a native send
 * against and behaved as Send automatically for exactly the tools the toggle
 * describes. One function, so the catalog filter and the interceptor cannot
 * disagree about what "sensitive" means.
 */
export function sensitiveWorkMatch(
  fn: { categories?: string[] } | undefined,
  sensitiveWork: OversightSettings['sensitiveWork'] | undefined,
): string | null {
  if (!sensitiveWork) return null;
  const enabled = sensitiveWork as Record<string, boolean | undefined>;
  const cats = fn?.categories ?? [];
  const literal = cats.find(c => enabled[c] === true);
  if (literal) return literal;
  if (cats.includes('outbound') && enabled.externalPublishing === true) return 'externalPublishing';
  return null;
}

export function oversightDecisionFor(
  fn: { categories?: string[]; draftVariant?: string },
  oversight: OversightSettings | undefined,
): OversightFilterDecision {
  if (!oversight) return { kind: 'allow' };
  if (!isOutboundTool(fn)) return { kind: 'allow' };
  const triggersBlock =
    oversight.communication === 'draft'
      ? true
      : oversight.communication === 'review'
        ? sensitiveWorkMatch(fn, oversight.sensitiveWork) !== null
        : false;
  if (!triggersBlock) return { kind: 'allow' };
  // Draft substitution belongs to Draft-first only: where a draft form exists,
  // drafting is that setting working as designed. Under Review the person is
  // approving the send itself, so the outbound tool stays registered and pauses.
  if (fn.draftVariant && oversight.communication === 'draft') {
    return { kind: 'skip_for_draft' };
  }
  // An approvable pause: under Draft-first because no draft form exists (the
  // alternative would be demanding a draft the tool cannot produce), under
  // Review because that is what the setting means.
  return {
    kind: 'require_approval',
    reason: oversight.communication === 'draft' ? 'communication_review' : 'sensitive_work',
  };
}
