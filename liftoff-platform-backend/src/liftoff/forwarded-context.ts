// The background one assistant hands a colleague, and why nobody reads it.
//
// A colleague answers in its OWN thread and cannot see the conversation it
// was brought into, so `bring_in_colleague` asks the model for a `task`: one
// or two sentences, "in your own words", carrying anything from earlier that
// the colleague would otherwise not know. Without it a forwarded "yes, do
// that" is three words with nothing behind them.
//
// That summary used to be concatenated onto the person's message and sent as
// one string, which every delegate surface then persisted as the USER's row.
// The colleague's thread therefore showed a paragraph the person never wrote,
// in Liftoff's voice, about them:
//
//   "[Context from the conversation so far: ... I raised the risk twice and
//    the user declined each time, so build without it ...]
//
//    Yes"
//
// It then travelled as its own field and was persisted as its own typed row,
// which the person could open. That showed them the brief itself, and a brief
// is one model's note to another: third person about the user, terse, with
// the identifiers and directives a colleague needs, such as an AI team's id
// with an instruction to confirm it, which a colleague will then repeat back
// to the person. Every agent platform keeps such a
// brief out of the end-user surface: a hand-off's context travels silently,
// and a transfer note is an internal note. So does this one now.
//
// Two products, then:
//   - the BRIEF (`forwardedContextForModel`): put in front of the person's
//     message for the colleague's model this turn, and never persisted. It
//     opens by saying what it is and that the person does not see it, so the
//     colleague neither repeats it nor the identifiers in it;
//   - the STATUS ROW (`forwardedContextStatus`): the one line the colleague's
//     thread keeps, saying who brought the colleague in. Typed so the UI
//     renders it as a status line and the model's history skips it.
//
// Rows written before this split carry the old note after a blank line;
// liftoff-react renders only the first line of any such row, so they show
// the same status line and nothing else.

/** Marks a row as forwarded background rather than speech. Mirrored in
 *  liftoff-react (`ForwardedContextRow.tsx`) and in workforce-service, which is
 *  the other service that persists one. */
export const FORWARDED_CONTEXT_MESSAGE_TYPE = 'forwarded_context';

/**
 * The one line the colleague's thread keeps about a hand-over: who brought the
 * colleague in. Liftoff, the Insights Manager, the Chief AI Officer or an AI
 * team can each hand a turn over. Spelled identically in workforce-service,
 * which persists it for the Chief AI Officer's threads, and matched by the
 * label liftoff-react falls back to for a row written before the forwarder
 * was stamped; the tests on both sides pin the text.
 */
export function forwardedContextStatus(askerLabel: string): string {
  return `${askerLabel} shared background from the conversation so far`;
}

/**
 * The brief for the colleague's model, or null when there is nothing worth
 * forwarding.
 *
 * Null for an empty summary, and null when the summary only repeats the message
 * — the common case for a first request, where forwarding it would put the same
 * sentence in front of the model twice.
 *
 * The opening line is load-bearing: it tells the colleague what the paragraph
 * is, that the person does not see it, and not to repeat it or any identifier
 * in it. The Chief AI Officer's prompt keys its hand-over rule on that opening
 * (migration 497).
 */
export function forwardedContextForModel(
  userMessage: string,
  taskSummary: string,
  askerLabel: string,
): string | null {
  const summary = taskSummary.trim();
  if (!summary) return null;
  if (summary.toLowerCase() === userMessage.trim().toLowerCase()) return null;
  return (
    `Background from ${askerLabel}, which brought you into this conversation. `
    + 'It is not shown to the person: do not repeat it, or any identifier in it, to them. '
    + `Answer the message that follows it.\n\n${summary}`
  );
}

/**
 * What the colleague's model actually reads: the brief, then the person's own
 * words, unchanged.
 *
 * The person's words go through untouched because they are what was said, and a
 * colleague answers people rather than paraphrases. Composed here rather than in
 * each delegate so the wording exists once; a delegate receives the finished
 * brief and only has to decide where to put it.
 */
export function withForwardedContext(userMessage: string, note: string | null): string {
  return note ? `${note}\n\n${userMessage}` : userMessage;
}
