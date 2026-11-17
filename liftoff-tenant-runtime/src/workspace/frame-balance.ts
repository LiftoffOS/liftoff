// One rule: no text handed to a model ever carries an untrusted delimiter
// without its pair.
//
// The framer wraps untrusted content in `<UNTRUSTED_<nonce>_BEGIN>` … `_END>`,
// and the system prompt tells the model that everything between them is DATA
// and that a marker cannot be forged from inside a payload. A cut that keeps
// the BEGIN and loses the END breaks both halves of that promise at once: the
// region never closes, so host text after it reads as data, and the model is
// looking at a marker the notice says cannot be unbalanced.
//
// It is not hypothetical. `boundToolText` preserved the delimiters only when
// the frame WAS the whole text block — the connector paths, where the frame is
// the outermost thing. A frame framed IN PLACE sits inside a serialised result
// (`{"result":{"content":"<UNTRUSTED_…"}}`), which the anchored patterns do not
// match, so the structure-aware reducer cut the page string and dropped the
// closing delimiter. `file_read` has had that shape since it was framed;
// `web_fetch_advanced` and `read_active_browser_session` joined it, and
// `observe-result-size.ts` records a real 62,918-character fetch against a
// 50,000 budget, so the case is measured rather than imagined.
//
// PURE. No crypto, no screen, no I/O — the grammar only. That is what lets the
// two cutters that must obey it (`engine/truncate-for-prompt`, which documents
// itself as dependency-free, and `adapter/tool-result-bound`) both import it.

/** A delimiter ANYWHERE in the text, not anchored: a frame is as often nested
 *  inside a serialised result as it is the whole of one. The nonce is captured
 *  so a closer can be rebuilt for exactly the frame that was left open. */
const FRAME_DELIMITER = /<UNTRUSTED_([0-9a-fA-F]{32,64})_(BEGIN|END)>/g;

/** The nonces still open at the end of `text`, innermost last.
 *
 *  A stack rather than a counter: two frames with different nonces can nest
 *  (a framed result quoted inside another), and closing the wrong one would
 *  leave the delimiters crossed rather than balanced. An END whose nonce is
 *  not on top closes its own frame wherever it sits, which is the reading that
 *  matches how the framer emits them. */
function openNonces(text: string): string[] {
  const stack: string[] = [];
  for (const m of text.matchAll(FRAME_DELIMITER)) {
    const [, nonce, kind] = m;
    if (kind === 'BEGIN') { stack.push(nonce); continue; }
    const at = stack.lastIndexOf(nonce);
    if (at !== -1) stack.splice(at, 1);
  }
  return stack;
}

/** The closing delimiters `text` is missing, innermost first, ready to append. */
export function missingClosers(text: string): string {
  return openNonces(text)
    .reverse()
    .map((nonce) => `\n\n<UNTRUSTED_${nonce}_END>`)
    .join('');
}

/**
 * Close every frame `text` left open.
 *
 * The last line of defence rather than the mechanism: every cutter below
 * shortens text frame-aware, and this makes the invariant hold whatever any
 * future one does. A balanced text is returned unchanged.
 */
export function sealFrames(text: string): string {
  const closers = missingClosers(text);
  return closers ? text + closers : text;
}

/** Where a cut at `index` would land inside a delimiter rather than between
 *  two, and the position just before that delimiter instead. A half-written
 *  `<UNTRUSTED_9f2c` is not a marker, but it is debris in the model's context
 *  and it reads as though something was tampered with. */
function snapBeforeDelimiter(text: string, index: number): number {
  for (const m of text.matchAll(FRAME_DELIMITER)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (index > start && index < end) return start;
  }
  return index;
}

/**
 * Shorten `text` to `max` characters of CONTENT without leaving a frame open.
 *
 * `max` bounds the content, and the note and any closers follow it — the
 * convention every cutter here already used (`boundToolText` reserves the
 * header and footer out of its budget and then lets `reduce` append its
 * marker; `spillToolText` slices to PREVIEW_CHARS and appends the path note).
 * Keeping that means this is a drop-in for each of them: the only thing that
 * changes is the closers, and they are the point.
 *
 * The note says what was dropped and is written by the caller, because the
 * three cutters phrase it differently and the model has learned each one.
 */
export function truncateWithinFrames(
  text: string,
  max: number,
  note: (droppedChars: number) => string,
): string {
  if (text.length <= max) return text;
  const kept = text.slice(0, snapBeforeDelimiter(text, Math.max(0, max)));
  return kept + note(text.length - kept.length) + missingClosers(kept);
}
