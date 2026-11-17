// MIRRORED from platform-backend src/common/assistant-message-boundary.ts and
// from Liftoff-Tenant-Runtime src/interactive-chat/assistant-message-boundary.ts.
// The three keep the same table of cases in their tests. A turn assembled in
// one process and one assembled in another must read the same afterwards: the
// same thread carries messages from the Chief AI Officer (here), from the
// three platform assistants, and from an agent.
//
// Where one assistant message ends and the next begins, inside a single turn.
//
// A turn writes more than once: a round says what it is about to do, runs a
// tool, and a later round writes the answer. Those are separate messages. The
// stream renders each as it arrives, so on screen they are already apart -- but
// the string the turn accumulates is what gets PERSISTED, and that row is what
// a reload, a /share link, a relay to another surface and every other
// participant on the thread read afterwards. Joined with nothing between them
// the two run together mid-sentence:
//
//     ...so let me pull the rest.Here are the top 20 in r/founder this week
//
// which is how it reached a person. Sized to what the text already ends with,
// so a message that closed on its own newline does not open a gap of four, and
// to what the next one starts with, so a paragraph the model opened with a
// blank line is not pushed further down the page.
//
// The separator has to be written into BOTH the accumulated string and the
// stream. Writing it to only one is how the two disagree, and the disagreement
// is invisible until somebody refreshes.

function newlinesIn(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

/** The separator to put between `before` and `after`, or '' when they already
 *  meet as separate paragraphs, or when there is nothing to separate.
 *
 *  Omit `after` where the boundary is known before the next message is: a
 *  surface told "that message ended" writes the gap then, and what the next
 *  message opens with is that delta's business. */
export function assistantMessageGap(before: string, after?: string): string {
  if (!before.trim()) return '';
  if (after !== undefined && !after.trim()) return '';
  const trailing = /\s*$/.exec(before)?.[0] ?? '';
  const leading = after === undefined ? '' : /^\s*/.exec(after)?.[0] ?? '';
  const present = newlinesIn(trailing) + newlinesIn(leading);
  return present >= 2 ? '' : '\n'.repeat(2 - present);
}

/** The two pieces to append when `after` opens a new assistant message: the
 *  gap that goes in front of it, and the text itself.
 *
 *  Where a gap is inserted, the spaces and tabs the next message opens with
 *  are dropped: they were shaping it against the message before it, and after
 *  a paragraph break they are at best stray and at worst a markdown indented
 *  code block. Only the incoming side is touched -- the text already sent has
 *  been streamed to the person and must stay what they were shown. */
export function openAssistantMessage(before: string, after: string): { gap: string; text: string } {
  const gap = assistantMessageGap(before, after);
  return gap ? { gap, text: after.replace(/^[ \t]+/, '') } : { gap: '', text: after };
}
