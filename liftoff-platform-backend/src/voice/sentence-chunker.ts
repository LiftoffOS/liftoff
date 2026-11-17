// Cutting a token stream into things worth speaking.
//
// The agent produces text a few characters at a time. Synthesising each fragment
// as it lands would be unlistenable and would bill a request per token;
// synthesising only once the whole reply is written would mean silence for as
// long as the reply takes. So: emit whole sentences, as soon as each one is
// whole.
//
// This is the single biggest lever on how quickly a reply starts. The first
// sentence is the only one whose synthesis the listener actually waits through —
// every later one is being synthesised while an earlier one plays. That is why
// the first chunk is allowed to be shorter than the rest: getting a voice started
// matters more at the beginning than a well-shaped clause does.

/**
 * Below this, a mid-reply "sentence" is merged into the next one.
 *
 * Not a correctness guard — `terminates` already rejects abbreviations, decimals
 * and initials. This is phrasing: a bare "Yes." in the middle of a reply is
 * better read as part of the clause that follows it than as its own utterance
 * with a synthesis boundary either side.
 */
const MIN_CHARS = 12;

/**
 * The first chunk is exempt from that, near enough.
 *
 * A reply opening with "Sure." or "Done." is the best possible thing to have
 * already spoken while the rest is still being written, so it is emitted at
 * once. The floor only rejects a fragment too short to be a sentence at all.
 */
const MIN_FIRST_CHARS = 2;

/**
 * Emit at a clause boundary once a chunk gets this long without ending.
 *
 * A reply can run for a long time without a full stop — a list read as prose, or
 * a single unpunctuated sentence. Without this the listener waits in silence
 * while text piles up.
 */
const CLAUSE_LIMIT = 180;

/** Hard cap. Beyond this we cut at the last space rather than keep waiting. */
const HARD_LIMIT = 320;

/** Sentence-ending punctuation, including the CJK forms. */
const TERMINATORS = new Set(['.', '!', '?', '。', '！', '？', '…']);

/** Clause punctuation, used only once CLAUSE_LIMIT is passed. */
const CLAUSE_MARKS = new Set([',', ';', ':', '，', '；', '：']);

/**
 * Abbreviations whose full stop does not end a sentence.
 *
 * Deliberately short. A missed abbreviation splits one sentence into two, which
 * a listener hears as a slightly long pause; a wrongly-held sentence waits for a
 * terminator that never comes. The first failure is cheap and the second is not,
 * so this list stays small on purpose.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'no',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

/** Does the full stop at `index` actually end a sentence? */
function terminates(buffer: string, index: number): boolean {
  const char = buffer[index];
  if (char !== '.') return true;

  // A decimal point: digit on both sides.
  const before = buffer[index - 1];
  const after = buffer[index + 1];
  if (before !== undefined && after !== undefined && /\d/.test(before) && /\d/.test(after)) {
    return false;
  }

  // An abbreviation, or a single initial as in "J. Smith".
  const word = buffer.slice(0, index).match(/([A-Za-z.]+)$/)?.[1]?.toLowerCase();
  if (word !== undefined) {
    if (ABBREVIATIONS.has(word)) return false;
    if (word.length === 1) return false;
  }
  return true;
}

/**
 * Accumulates streamed text and hands back complete utterances.
 *
 * Stateful and single-threaded by design: one chunker per spoken reply, fed in
 * arrival order.
 */
export class SentenceChunker {
  private buffer = '';
  private emitted = 0;

  /**
   * Add text from the stream. Returns whatever became speakable — usually
   * nothing, sometimes one utterance, occasionally several.
   */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const chunk = this.takeOne();
      if (chunk === null) break;
      out.push(chunk);
    }
    return out;
  }

  /**
   * Everything still buffered, whether or not it ends cleanly.
   *
   * Called when the reply is finished: a last sentence with no full stop is
   * still the end of what the agent said, and dropping it would silently lose
   * the last words of a reply.
   */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest.length === 0) return [];
    this.emitted += 1;
    return [rest];
  }

  /** One complete utterance, or null if the buffer does not hold one yet. */
  private takeOne(): string | null {
    const minimum = this.emitted === 0 ? MIN_FIRST_CHARS : MIN_CHARS;

    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i] as string;
      if (!TERMINATORS.has(char)) continue;
      if (!terminates(this.buffer, i)) continue;

      // Absorb a run of terminators ("?!") and any closing quote or bracket, so
      // they travel with the sentence they belong to.
      let end = i + 1;
      while (end < this.buffer.length && TERMINATORS.has(this.buffer[end] as string)) end++;
      while (end < this.buffer.length && /["'”’)\]]/.test(this.buffer[end] as string)) end++;

      // Nothing follows yet: the next token could be a closing quote, so wait
      // rather than cut early. flush() covers the case where nothing more comes.
      if (end >= this.buffer.length) break;

      const candidate = this.buffer.slice(0, end).trim();
      if (candidate.length < minimum) continue;

      this.buffer = this.buffer.slice(end);
      this.emitted += 1;
      return candidate;
    }

    if (this.buffer.length > CLAUSE_LIMIT) {
      const cut = this.cutLong();
      if (cut !== null) return cut;
    }
    return null;
  }

  /** A long unterminated buffer: cut at the best boundary available. */
  private cutLong(): string | null {
    const window = this.buffer.slice(0, HARD_LIMIT);

    let at = -1;
    for (let i = window.length - 1; i >= CLAUSE_LIMIT / 2; i--) {
      if (CLAUSE_MARKS.has(window[i] as string)) { at = i + 1; break; }
    }
    if (at === -1 && this.buffer.length > HARD_LIMIT) {
      at = window.lastIndexOf(' ');
    }
    if (at <= 0) return null;

    const candidate = this.buffer.slice(0, at).trim();
    if (candidate.length === 0) return null;

    this.buffer = this.buffer.slice(at);
    this.emitted += 1;
    return candidate;
  }
}
