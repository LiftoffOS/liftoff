// The verdict a closing reply carries, and its removal from the text.
//
// When a bound closes a reply, the closing instruction asks the model to end
// with exactly one line on its own: `[continue]` when work it was asked for
// is still to do, `[done]` when it is finished. The line is model-only: it is
// read here, once, and removed before the text goes anywhere a person reads
// it. A stray marker elsewhere in the text is removed too, so a model that
// wrote the line mid-paragraph cannot show it to anyone either.
//
// Kept identical to platform-backend's `src/common/closing-verdict.ts`: the
// three platform assistants read one instruction and one marker.

export type ClosingVerdict = 'continue' | 'done';

const MARKER_LINE = /^\s*\[(continue|done)\]\s*$/i;
const STRAY_MARKER = /\s*\[(?:continue|done)\]/gi;

export interface ClosingVerdictRead {
  /** The text with the verdict line, and any stray marker, removed. */
  text: string;
  /** The verdict the last marker line carried; null when the text carried
   *  no marker line at all. */
  verdict: ClosingVerdict | null;
}

/** Read the verdict off a closing reply and strip it from the text. */
export function readClosingVerdict(raw: string): ClosingVerdictRead {
  const lines = raw.split('\n');
  let verdict: ClosingVerdict | null = null;
  // The LAST line that is a marker on its own decides; blank lines after it
  // are tolerated, because a model tends to end with a newline.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const m = MARKER_LINE.exec(line);
    if (m) {
      verdict = m[1].toLowerCase() as ClosingVerdict;
      lines.splice(i, 1);
    }
    break;
  }
  const text = lines.join('\n').replace(STRAY_MARKER, '').trimEnd();
  return { text, verdict };
}
