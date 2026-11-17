// The background Liftoff hands the Chief AI Officer, and why it is not the
// person's words.
//
// Liftoff can bring the CAIO into a conversation the CAIO cannot see, so it
// writes a short summary of what has been said and sends it with the person's
// message. That summary used to be concatenated onto the message before it left
// platform-backend, and this service persisted the whole string as the USER's
// row. The CAIO's thread therefore showed paragraphs the person never wrote, in
// Liftoff's voice, about them:
//
//   "[Context from the conversation so far: ... I flagged the CAN-SPAM and
//    GDPR/PECR risk three times and the user declined each time ...]
//
//    Yes"
//
// The two halves arrive as separate fields now. `content` is persisted as the
// person's turn; `forwardedContext` is put in front of the message for the
// model and is NEVER persisted: it is a brief one model wrote for another,
// third person about the user, terse, with the identifiers and directives a
// colleague needs, and none of that is for a person to read. What the thread
// keeps is provenance: one status row, composed here from `forwardedBy`,
// saying who brought the Chief AI Officer in and shared the background.
//
// THE WORDING OF THE BRIEF IS NOT HERE. platform-backend composes it, because
// it is the service that knows what was said in the other conversation, and
// one wording in one place cannot drift from itself. This module holds only
// what this service needs: the type marker, the join, and the status line,
// which liftoff/forwarded-context.ts in platform-backend spells identically
// (its test and this one pin the same text). See the two `message_type`
// migrations (174 and 352 there, 020 here) for the vocabulary this borrows.

/** Marks a row as forwarded background rather than speech. Must match the
 *  constant of the same name in platform-backend, which is what decides that a
 *  row gets written at all, and in liftoff-react, which renders it. */
export const FORWARDED_CONTEXT_MESSAGE_TYPE = 'forwarded_context';

/** The one line the thread keeps about a hand-over: who brought the Chief AI
 *  Officer in. The whole of the row's content; the brief itself is never
 *  stored. Same text as platform-backend's forwardedContextStatus, and the
 *  same text liftoff-react falls back to for a row written before the
 *  forwarder was stamped. */
export function forwardedContextStatus(askerLabel: string): string {
  return `${askerLabel} shared background from the conversation so far`;
}

/**
 * What the model reads: the forwarded brief, then the person's own words,
 * unchanged.
 *
 * The person's words go through untouched because they are what was said, and
 * the CAIO answers people rather than paraphrases. Returns the message alone
 * when nothing was forwarded, which is the ordinary case for somebody typing on
 * the CAIO page and for a first request through Liftoff.
 */
export function withForwardedContext(userMessage: string, note: string | null): string {
  return note ? `${note}\n\n${userMessage}` : userMessage;
}
