// The row type of a colleague's reply inside another conversation.
//
// Liftoff, the Chief AI Officer or the Insights Manager can be brought into a
// team's chat (colleague-worker.ts), and the Chief AI Officer or Liftoff into
// an Insights Manager conversation, or the Insights Manager or Liftoff into a
// Chief AI Officer one (agent-chat/handover.ts), and their reply is posted
// INTO that conversation. The row is conversation, not narration, and the
// client does not dispatch on the type: it is an ordinary bubble whose words
// are the colleague's verbatim, attributed through `contributors` like every
// other reply a colleague wrote.
//
// Its own module rather than a member of colleague-worker.ts because the
// readers that must know who spoke (the rolling summary, which turns rows into
// the next turn's context) must not import the worker to find out.
export const COLLEAGUE_MESSAGE_TYPE = 'colleague';

/** Who wrote a persisted reply, when it was not the surface's own assistant:
 *  the first contributor's label on a `colleague` row, and null for a row the
 *  assistant wrote itself (with or without help). One rule for every surface
 *  that reports `answeredBy` to a caller outside the dashboard. */
export function colleagueAnsweredBy(row: {
  messageType: string | null;
  contributors: ReadonlyArray<{ label: string }>;
} | null | undefined): string | null {
  if (!row || row.messageType !== COLLEAGUE_MESSAGE_TYPE) return null;
  return row.contributors[0]?.label ?? null;
}
