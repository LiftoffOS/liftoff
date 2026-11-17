// Semantic compression of oversized runtime values, as an alternative to
// slicing them.
//
// `truncateForPrompt` is a deterministic, shape-preserving bound: it shrinks long
// strings to 200 characters, arrays to 10 items and objects to 20 keys. That is
// the right last resort, but it cuts by position, so it drops whatever happens to
// come last — often the numbers, ids and dates the next step actually needs.
//
// agno solves this with an LLM pass instead of a slice
// (`libs/agno/agno/compression/manager.py`), whose prompt is explicit about what
// survives: "ALWAYS PRESERVE: specific facts: numbers, statistics, amounts,
// prices, quantities, metrics; temporal data; entities; identifiers... REMOVE
// ENTIRELY: introductions, conclusions, hedging language, meta-commentary,
// formatting artifacts." Applied to a page of API records, that keeps every
// record's identifying fields and discards the prose around them — the opposite
// of what a positional cut does.
//
// Fail-open by construction. A compression error, an empty response, or a
// malformed one falls back to `truncateForPrompt`, so this can only ever produce
// a value at least as usable as the deterministic bound. It never throws and
// never fails a step.
//
// An over-budget result is the exception, and it is trimmed rather than
// discarded. Falling back there is the worse choice: at the real 8,192 budget
// the model can return a few hundred characters over while holding far more
// identifiers than the deterministic bound would. Trimming costs about one
// record; the fallback costs many.

import { truncateForPrompt, serializeForPrompt } from './truncate-for-prompt';
import { logger } from '../../infrastructure/logging';

/** Mirrors agno's compression prompt: name what must survive, name what to drop.
 *  Positional truncation cannot make this distinction. */
const COMPRESSION_PROMPT = `You are compressing a tool result so it fits a smaller context budget while preserving everything the next step needs.

ALWAYS PRESERVE:
- Specific facts: numbers, amounts, quantities, metrics, statistics
- Temporal data: dates and times (short form, e.g. "Oct 21 2025")
- Entities: people, companies, products, locations
- Identifiers: ids, URLs, slugs, codes, versions
- Structure: if the input is a list of records, keep every record and its identifying fields

REMOVE ENTIRELY:
- Introductions, conclusions, transitions, meta-commentary
- Hedging language and promotional or filler text
- Long free-text descriptions that are not identifiers
- Formatting artifacts

Return only the compressed content. Do not explain what you removed.`;

/**
 * The instruction to use when "keep every record" cannot be honoured.
 *
 * At a large enough ratio the two demands in the prompt above contradict each
 * other: 1,181 URLs need roughly 65,000 characters of identifiers alone and
 * cannot become 8,192. Issued anyway, the model drops records while having been
 * told not to, and the result reads as a faithful compression — which is worse
 * than an obviously short one, because the consumer has no reason to doubt it.
 *
 * So past the ratio, the instruction changes rather than the budget: keep as
 * many whole records as fit and SAY how many were kept out of how many. A stated
 * omission can be acted on; a silent one cannot.
 */
const LOSSY_COMPRESSION_PROMPT = `You are summarising a value that is far too large for the available budget. It CANNOT be preserved in full — do not pretend otherwise.

DO:
- Keep whole, complete records from the START of the input, as many as fit
- Keep each kept record's identifying fields intact (ids, URLs, slugs, codes)
- Begin your output with one line: "PARTIAL: kept N of M records" (use the real counts; if the input is not a list of records, write "PARTIAL: truncated summary")

DO NOT:
- Summarise records into prose, counts, or ranges — a half-described record is worse than an omitted one
- Invent totals or claim coverage you do not have

Return only that line followed by the kept records.`;

/**
 * Past this ratio of input to budget, preserving every record is not possible,
 * so the honest instruction is the lossy one.
 *
 * 4 rather than a tighter number: between 1x and 4x, dropping prose and
 * formatting genuinely can fit the records, which is the case the original
 * prompt was written for and where it works. Beyond it, no amount of prose
 * removal closes the gap and the model is being asked for the impossible.
 *
 * REASONED, NOT MEASURED — and this file's neighbours hold the line that a
 * number needs a derivation, so it says which it is. What would settle it is
 * the ratio at which `prompt.value.compressed` starts returning fewer records
 * than it was given, which needs a record count on both sides of the call; the
 * event carries `originalChars` and `compressedChars` only. Until then the cost
 * of being wrong is asymmetric and cheap in one direction: too low a ratio sends
 * a satisfiable case down the honest path and loses a little fidelity, too high
 * a one issues an impossible instruction and gets a confident lie.
 */
const LOSSY_RATIO = 4;

/**
 * Below this fraction of the INPUT, a compression is treated as lossy whatever
 * its ratio predicted.
 *
 * The ratio decides which INSTRUCTION to send, because that choice has to be
 * made before the call. It is the wrong signal for whether the ANSWER kept
 * everything: a compression whose input ratio is comfortably "satisfiable"
 * (under 2x) can still come back condensed to prose, using a small fraction of
 * the room it had.
 *
 * Measured against the input rather than the budget, because the question is
 * how much was THROWN AWAY, not how much room was left. Dropping prose from a
 * list of records typically keeps 40-60% of the characters; a result keeping a
 * few percent is not a compression, it is a précis, and the records are gone.
 *
 * 20% sits well below any faithful record compression and well above a
 * précis-shaped failure, so it fires on a précis and not on a good shrink. The
 * error is asymmetric on purpose: a false PARTIAL costs a sentence of caution,
 * a missed one costs a confident wrong answer.
 *
 * Applied only to record lists (`looksLikeRecordList`), because only there does
 * a shrunken result mean missing ROWS. The size metric carries sizes, not
 * values, so this catches the failure MODE, not provably every instance.
 */
const LOSSY_OUTPUT_FRACTION = 0.2;

/**
 * Whether the value is a list of records — the shape where losing content means
 * losing ROWS, and where a shrunken result is dangerous rather than merely terse.
 *
 * The condensed check below applies only here on purpose. `{pad: "ppppp…"}`
 * compressed to "padded string of 500 p characters" lost nothing: the content
 * was redundant and the précis is faithful. A list of 400 campaigns rendered as
 * a paragraph lost 400 rows. Only the second can turn "which of these already
 * exist" into a wrong answer, and only the second should carry the warning —
 * a marker that fires on every terse summary is a marker nobody reads.
 *
 * Inspected structurally rather than by pattern-matching the serialized text,
 * because the shape is knowable here and a regex over JSON is a guess.
 */
function looksLikeRecordList(value: unknown): boolean {
  const isRecordArray = (v: unknown): boolean =>
    Array.isArray(v) && v.length >= 2
    && v.filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x)).length >= 2;

  if (isRecordArray(value)) return true;
  // The common wrapper: `{ rows: [...] }`, `{ items: [...] }`, `{ values: [...] }`.
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(isRecordArray);
  }
  return false;
}

export function semanticCompressionEnabled(): boolean {
  return process.env.SEMANTIC_COMPRESSION_ENABLED === '1';
}

/**
 * Hard ceiling on how long compression may add to a step.
 *
 * Fail-open covers errors but not slowness: without this, a hung provider call
 * stalls the step for as long as the provider takes, and the step's own timeout
 * fires instead — turning a context optimisation into a step failure. Ten
 * seconds is generous for a small-tier pass over at most a few tens of thousands
 * of characters, and short relative to the step timeouts it sits inside
 * (min 1s, max 600s, per the platform's workflowStepSchema).
 */
const COMPRESSION_TIMEOUT_MS = 10_000;

interface CompressOptions {
  /** Character budget the result must fit. */
  maxChars: number;
  /** For the usage ledger, so the cost is attributable. */
  attribution: { tenantId: string; agentId?: string; invocationId?: string };
  /** Appears in logs and in the cost record's purpose. */
  purpose: string;
}

/**
 * Compress `value` to fit `maxChars`, preserving facts rather than position.
 *
 * Returns the deterministic bound when compression is disabled, unnecessary, or
 * unsuccessful — so callers can use the result unconditionally.
 */
export async function compressForPrompt(
  value: unknown,
  opts: CompressOptions,
): Promise<string> {
  const deterministic = truncateForPrompt(value, opts.maxChars);

  // Serialized ONCE, and the same string decides both questions: whether the
  // value needs shrinking at all, and what the model is asked to shrink.
  // Deriving those from two separate serializations let them disagree at the
  // margin — `truncateForPrompt` stringifies compactly while a differently
  // spaced copy could land either side of the budget, so a value could be
  // declared "already fits" while the bound had in fact truncated it, or vice
  // versa. One string, one decision.
  const full = serializeForPrompt(value);
  if (full.length <= opts.maxChars) return deterministic;

  if (!semanticCompressionEnabled()) return deterministic;

  // Which of the two instructions is truthful for this input.
  const lossy = full.length > opts.maxChars * LOSSY_RATIO;

  try {
    // Imported lazily so this module stays usable in contexts that never
    // compress, and so the LLM client is not pulled into pure-logic tests.
    const { llmClient } = await import('../../llm');
    // Attribution keys are the ones `llm/usage-tracker.ts` reads off the usage
    // event's context when it writes llm_usage_log — tenantId, agentId,
    // invocationId, purpose. Any other spelling records a NULL column, so a
    // compression call would cost real tokens against nobody.
    const response = await withTimeout(
      llmClient.complete(
        {
          tier: 'small',
          // Tokens sized so the model is not set up to overshoot the CHARACTER
          // budget it was just asked to hit.
          //
          // At maxChars/3 it was: 8,192 chars allowed 2,730 tokens, and 2,730
          // tokens of record-shaped JSON is 8,500-10,900 characters. The model
          // runs to `stop=max_tokens` and returns a few hundred characters over
          // the budget, every time. Discarding that result for being over budget
          // would replace a good compression with a deterministic bound holding
          // far fewer identifiers. The overshoot would be manufactured here.
          //
          // /4 because JSON with punctuation and URLs runs near 4 characters per
          // token; the trim below covers what this does not.
          maxTokens: Math.max(256, Math.floor(opts.maxChars / 4)),
          temperature: 0,
          messages: [
            { role: 'user', content: `${lossy ? LOSSY_COMPRESSION_PROMPT : COMPRESSION_PROMPT}\n\nTarget length: at most ${opts.maxChars} characters.\n\nContent:\n${full}` },
          ],
        },
        undefined,
        { purpose: opts.purpose, ...opts.attribution },
      ),
      COMPRESSION_TIMEOUT_MS,
    );

    let compressed = response?.content?.trim();
    if (!compressed) {
      logger.warn({ purpose: opts.purpose }, 'semantic compression returned empty — using deterministic bound');
      return deterministic;
    }
    // An over-budget compression is TRIMMED, not thrown away.
    //
    // Discarding it was a false choice between "blow the budget" and "fall back":
    // a third option was always available, and it is strictly better than both.
    // At the real 8,192 budget a discarded result can hold far more identifiers
    // than the deterministic bound that replaces it — so the fallback cuts
    // retention precisely when compression is doing its job. Trimming a few
    // hundred characters off the end costs about one record; falling back costs
    // many.
    //
    // The cut is marked, for the same reason every other cut here is: a record
    // sliced mid-way reads as a whole one.
    if (compressed.length > opts.maxChars) {
      logger.warn(
        { metric: 'prompt.value.compression_trimmed', purpose: opts.purpose, got: compressed.length, budget: opts.maxChars },
        'semantic compression exceeded the budget — trimming to fit rather than discarding it',
      );
      const CUT = '…[cut]';
      compressed = compressed.slice(0, Math.max(0, opts.maxChars - CUT.length)) + CUT;
    }

    logger.info(
      {
        metric: 'prompt.value.compressed',
        purpose: opts.purpose,
        originalChars: full.length,
        compressedChars: compressed.length,
        budget: opts.maxChars,
        lossy,
      },
      'compressed an oversized prompt value semantically',
    );
    // The partiality is stated by US when the input could not fit, not left to
    // the model to remember. `truncateForPrompt` already marks its own cuts, so
    // the deterministic path says so; without this the COMPRESSED path is the
    // one rendering that reads as complete while being the most lossy of the
    // three. Skipped when the model already opened with the statement it was
    // asked for, so the note appears exactly once.
    //
    // Marked on the OBSERVED result as well as the predicted ratio: a model
    // handed a satisfiable input can still answer with a précis — a few
    // hundred characters from an input whose ratio the gate above calls
    // satisfiable. Judging solely by what was sent would let it through
    // looking complete.
    const condensed = looksLikeRecordList(value)
      && compressed.length < full.length * LOSSY_OUTPUT_FRACTION;
    return lossy || condensed
      ? withPartialMarker(compressed, full.length, opts.maxChars)
      : compressed;
  } catch (err) {
    // Fail-open: a compression failure must never fail the step it was helping.
    // A timeout lands here too, which is the point — it becomes today's
    // behaviour, not a failed step.
    logger.warn(
      { purpose: opts.purpose, err: (err as Error).message },
      'semantic compression failed — using deterministic bound',
    );
    return deterministic;
  }
}

/**
 * Guarantee a compressed value announces that it is not the whole value.
 *
 * The model is asked to open with `PARTIAL: kept N of M records`, and usually
 * will; this is what makes the guarantee not depend on that. A consumer deciding
 * whether a key is present must be able to see, from the text alone, that
 * absence here is not evidence of absence.
 *
 * The marker is charged against the budget rather than added on top of it —
 * a caller that asked for at most N characters gets at most N.
 */
function withPartialMarker(compressed: string, originalChars: number, maxChars: number): string {
  if (/^\s*PARTIAL\b/i.test(compressed)) return compressed;
  const marker = `PARTIAL: summarised from ${originalChars} characters — this is NOT the complete value, and something absent here may still exist.\n`;
  if (marker.length >= maxChars) return compressed;
  const room = maxChars - marker.length;
  if (compressed.length <= room) return marker + compressed;
  // Making room for the marker means cutting the model's text, and cutting it
  // positionally can leave a half-written record that reads as a whole one —
  // the thing the lossy instruction above calls worse than an omission. So the
  // cut announces itself, the same way `truncateForPrompt` marks its own.
  const CUT = '…[cut]';
  return marker + compressed.slice(0, Math.max(0, room - CUT.length)) + CUT;
}

/**
 * Reject after `ms` if the promise has not settled.
 *
 * The underlying call is not cancelled — the LLM client exposes no signal — so a
 * timed-out request may still complete and still emit its usage event. That is
 * the correct trade: the tokens were genuinely spent and stay attributed, while
 * the step stops waiting.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`semantic compression exceeded ${ms}ms`)),
      ms,
    );
    // Never hold the process open for a compression pass.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
