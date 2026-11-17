/**
 * Fold a run's own narration — its progress lines and the terminal row that
 * says it stopped — into one item per run.
 *
 * The backend appends a line as the work proceeds — deliberately, because one
 * row rewritten in place showed only the latest state and the earlier updates
 * vanished, which is the opposite of the running account it exists to give. So
 * the rows are right and stay exactly as they are; this only decides how they
 * are DISPLAYED.
 *
 * Two things were wrong on screen. A one-minute run left three status lines in
 * the transcript and an eleven-minute one left fourteen, and because the closing
 * summary is written by a wrapper that only sees the run end AFTER the reply has
 * been saved, the conversation ended on "This run took 1 minute" instead of on
 * the answer.
 *
 * Grouping fixes both without moving a single row.
 */

/** The shape this needs from a message. Deliberately narrow so the grouping can
 *  be tested without a chat message, a thread, or React. */
export interface GroupableMessage {
  id: string;
  role: string;
  messageType?: string | null;
  content: string;
}

export type GroupedItem<T extends GroupableMessage> =
  | { kind: 'message'; message: T }
  /** One run's worth of consecutive progress lines. */
  | { kind: 'progress'; rows: T[]; answered: boolean };

/**
 * A run's lines are grouped up to the next USER message, not up to the next
 * reply.
 *
 * The closing summary is written after the answer — the wrapper that writes it
 * only learns the run ended once the core has saved the reply — so a run's rows
 * are not contiguous: six lines, the answer, then "This run took 3 minutes".
 * Keying on consecutive rows split that into two groups and left the second one
 * alone after the reply, so the thread still ended on housekeeping, which is the
 * whole thing this was meant to fix.
 *
 * A person asking again is what starts a new run. A reply in the middle is not.
 * The group renders where its FIRST line was, so the answer stays last.
 *
 * `answered` decides whether the group may collapse, and it is read from the
 * TRANSCRIPT rather than from the text of the lines.
 *
 * A run that ends without an answer must keep shouting: a dead turn that looked
 * identical to a live one is the whole reason these rows exist, and folding that
 * away would restore the "three states, one appearance" bug they were written to
 * kill. A run that is still going must also stay open, or the person is back to
 * watching a blank thread.
 *
 * Both of those are the same question — is there a reply after this run — so
 * that is what is asked, instead of matching on "This run is still working",
 * which would break the moment somebody rewords a sentence.
 */
export function groupRunProgress<T extends GroupableMessage>(
  messages: readonly T[],
  /** Every type a run uses to narrate ITSELF — its progress lines and the
   *  terminal row that says it stopped. A SET rather than one type, because the
   *  terminal row is the last line of the same run and belongs in the same
   *  group: read as its own kind of row it would fall through to the ordinary
   *  assistant bubble and be attributed to the team. */
  narrationMessageTypes: ReadonlySet<string>,
): GroupedItem<T>[] {
  const isProgress = (m: T) => m.messageType !== undefined && m.messageType !== null
    && narrationMessageTypes.has(m.messageType);
  const out: GroupedItem<T>[] = [];
  /** Index in `out` of the group this run is still filling, or -1. */
  let openGroup = -1;

  for (const msg of messages) {
    if (msg.role === 'user') {
      // A new question is a new run. Anything after this belongs to it.
      openGroup = -1;
      out.push({ kind: 'message', message: msg });
      continue;
    }
    if (!isProgress(msg)) {
      out.push({ kind: 'message', message: msg });
      continue;
    }
    if (openGroup === -1) {
      // Rendered here, where the run's first line was, so the reply that comes
      // later is still the last thing in the thread.
      out.push({ kind: 'progress', rows: [msg], answered: false });
      openGroup = out.length - 1;
      continue;
    }
    (out[openGroup] as { rows: T[] }).rows.push(msg);
  }

  // A group may fold once its run produced a reply. Resolved in a second pass
  // because the reply arrives after the group was opened.
  for (let i = 0; i < out.length; i++) {
    const item = out[i];
    if (item.kind !== 'progress') continue;
    let answered = false;
    for (let j = i + 1; j < out.length; j++) {
      const later = out[j];
      if (later.kind === 'progress') continue;
      // The next question ends this run's window without answering it.
      if (later.message.role === 'user') break;
      if (later.message.role === 'assistant') { answered = true; break; }
    }
    item.answered = answered;
  }
  return out;
}

/** What the folded line says.
 *
 *  The LAST row, verbatim. The backend already writes a closing summary there
 *  ("This run took 1 minute. Work done: 6 actions…"), and it is derived from the
 *  run's own counters, so re-deriving a summary here would be a second opinion
 *  that can disagree with the first. When a run is still going the last row is
 *  its current state, which is the right thing to show while it runs. */
export function collapsedLabel<T extends GroupableMessage>(rows: readonly T[]): string {
  return rows.length > 0 ? rows[rows.length - 1].content : '';
}
