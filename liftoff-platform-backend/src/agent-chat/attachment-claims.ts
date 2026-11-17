// Does a reply claim that a file is attached to it, and is the claim true?
//
// A reply is composed by the model independently of what the platform attached
// to the turn: the model reads a successful tool result and narrates the
// outcome that success implies. When the card then fails downstream, the
// person reads "attached below", sees nothing, and concludes the team is
// lying. This module holds the question "does this text say a file is attached
// to THIS message" and the check that answers it against the cards the turn
// appended. The two places a completed reply is persisted — chat-service's
// `complete` handler and the settle-turn callback — call it on the text they
// are about to write, so the line it may add is part of the row and holds on
// every surface and in the transcript.
//
// It is NOT run on the partial a turn writes when it pauses for an approval or
// a clarification. Those pause the run mid-work, often on the very tool that
// will produce the card, and the card then lands under the continuation: a
// correction on the partial would be false the moment the run resumes. Only a
// terminal reply is held to account.
//
// Whole phrases, case-insensitive, and deliberately few. The cost of a miss is
// a reply that keeps claiming a card it does not have — what happens today —
// and the cost of a false hit is a host line saying no file was attached under
// a reply that never said one was. The second is worse, so a phrase joins the
// list only when it names THIS message as the place the file is: "I attached a
// note to the CRM record" is a claim about a record, not about this reply.
//
// Product voice for the line: no contractions, no em dashes, does not say
// "agent".

import * as chatRepo from './chat-repository';
import { log } from '../infrastructure/logging';

/** Phrases that assert an attachment on the message being read. */
const ATTACHMENT_CLAIMS: readonly RegExp[] = [
  // "attached below", "attached here", "attached to this message",
  // "attached to this conversation" — also through "is attached below this
  // message" and "attached below".
  /\battached (?:below|here|to this (?:message|conversation))\b/i,
  // "as an attachment"
  /\bas an attachment\b/i,
  // "the card under this message", "the file card below", "card below"
  /\b(?:the )?(?:file )?card (?:under|below)\b/i,
];

/** True when the reply asserts that a file is attached to it. */
export function claimsAttachment(text: string): boolean {
  return ATTACHMENT_CLAIMS.some((re) => re.test(text));
}

/** The one host-authored line appended when a reply claims an attachment
 *  this turn did not produce. Says nothing about a link, because the reply
 *  may not contain one. Owned here so the check and its tests share one
 *  string. */
export const NO_FILE_ATTACHED = 'No file was attached to this message.';

/** Why an attachment claim was left unchecked. Logged, never silent. */
export type AttachmentClaimSkipReason = 'no_turn_id' | 'lookup_failed' | 'unattributed_card_present';

/** What the check found. One positive outcome; everything else leaves the
 *  reply as the model wrote it. */
export type AttachmentClaimFinding =
  | { kind: 'no_claim' }
  | { kind: 'backed' }
  | { kind: 'unbacked' }
  | { kind: 'skipped'; reason: AttachmentClaimSkipReason; detail?: Record<string, unknown> };

export interface AttachmentClaimVerdict {
  /** The text to persist: the model's words untouched, plus the one
   *  host-authored line when the claim is unbacked. */
  text: string;
  finding: AttachmentClaimFinding;
}

/**
 * Hold a reply's attachment claim against the cards this turn appended.
 *
 * Truth is the exact record in `produced_in_turn_id` (migration 474), read by
 * `(thread_id, produced_in_turn_id)` and anchored on the turn's own row for
 * when it started: no application time window, no media rows,
 * `host_delivered` frames not consulted. The correction is added on ONE
 * finding only — a known turn, a lookup that succeeded, zero cards attributed
 * to the turn AND zero cards this check cannot attribute since the turn
 * started. A card with no turn id (an older runtime image, a non-chat caller)
 * is not proof that none exists, so its presence is a reason to say nothing.
 *
 * Decides and returns; it does not log. The caller records the finding with
 * recordAttachmentClaimFinding once the row is actually written, so a lost
 * race on the one-assistant-row-per-turn index cannot log a correction that
 * nobody will read.
 */
export async function checkAttachmentClaim(args: {
  tenantId: string;
  threadId: string;
  turnId: string | null;
  text: string;
}): Promise<AttachmentClaimVerdict> {
  const { tenantId, threadId, turnId, text } = args;
  if (!claimsAttachment(text)) return { text, finding: { kind: 'no_claim' } };

  const skipped = (reason: AttachmentClaimSkipReason, detail?: Record<string, unknown>): AttachmentClaimVerdict =>
    ({ text, finding: { kind: 'skipped', reason, ...(detail ? { detail } : {}) } });

  if (!turnId) return skipped('no_turn_id');

  let counts: chatRepo.TurnFileCardCounts | null;
  try {
    counts = await chatRepo.countFileCardsProducedInTurn(tenantId, threadId, turnId);
  } catch (err) {
    return skipped('lookup_failed', { error: (err as Error).message });
  }
  // The turn is not on record, so when it started cannot be established and
  // an untagged card cannot be placed against it. Not a positive finding.
  if (!counts) return skipped('lookup_failed', { turnFound: false });

  // Backed: this turn appended at least one card.
  if (counts.attributed > 0) return { text, finding: { kind: 'backed' } };
  // A card exists that this check cannot attribute. Not evidence either way.
  if (counts.unattributed > 0) return skipped('unattributed_card_present', { unattributed: counts.unattributed });

  // The one positive finding: a claim, and nothing behind it.
  return { text: `${text}\n\n${NO_FILE_ATTACHED}`, finding: { kind: 'unbacked' } };
}

/**
 * Log what the check found, for a reply that has been persisted. Called after
 * the insert succeeded and only then: on the terminal reply the two writers
 * race under acm_assistant_turn_uniq, and the one that lost wrote nothing —
 * its finding would describe a row that does not exist.
 */
export function recordAttachmentClaimFinding(
  finding: AttachmentClaimFinding,
  ids: { tenantId: string; threadId: string; turnId: string | null; invocationId: string | null },
): void {
  switch (finding.kind) {
    case 'no_claim':
    case 'backed':
      return;
    case 'skipped':
      log.info(
        { event: 'attachment_claim_check_skipped', reason: finding.reason, ...ids, ...(finding.detail ?? {}) },
        'agent-chat: a reply claims an attachment and the claim was left unchecked',
      );
      return;
    case 'unbacked':
      log.warn(
        { event: 'attachment_claim_unbacked', ...ids },
        'agent-chat: a reply claims an attachment this turn did not produce',
      );
      return;
  }
}
