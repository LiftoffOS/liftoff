// Did this run overflow its context window?
//
// The existing answer reads the model's own prose:
// `resume-safety.ts#contextExhaustedCompletion` scans the output, capped at 600
// characters, requiring both a subject clause and a state clause. Its header
// explains why it has to: context-pressure.ts is gated on
// `adapter.managesOwnContext !== true`, which excludes every primary engine —
// and the engines that manage their own context are exactly the ones that hit
// the ceiling.
//
// TWO OF THE THREE OVERFLOW MODES PRODUCE NO ERROR TEXT AT ALL, so no prose
// check can ever see them:
//
//   1. Error text        — the provider rejected the request and said so.
//   2. Silent overflow   — the provider ACCEPTED an oversized request and
//                          answered anyway. We are blind to this today, and we
//                          already receive the usage events that would show it.
//   3. Length-stop       — the provider truncated the input to fit and had no
//                          room left to generate, so it stops with zero output
//                          tokens and no complaint.
//
// Cases 2 and 3 compare usage against the window, so they are only as
// trustworthy as the window is. They are SKIPPED when the window is a
// provider-family floor rather than a recorded per-model figure: Anthropic's
// floor is 200,000 and claude-opus-5[1m] holds 1,000,000, so a healthy 300k-token
// run measured against the floor would be declared overflowed and — wired to a
// session retirement — its conversation abandoned. That is a data-losing false
// positive produced by the check meant to prevent data loss.

import type { InvocationEvent } from './types';
import type { ContextWindowReading } from '../../llm/context-window';
import { mayDriveRetirement } from '../../llm/context-window';

/** Provider rejections that mean "your input did not fit". Every entry is a
 *  string a provider actually emits, kept separate from `classifyFailure`'s
 *  broader `context_overflow` regex because this one has to be exact: it is
 *  read as evidence for ending a session. */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,                        // anthropic — token overflow
  /request_too_large/i,                         // anthropic — HTTP 413 byte overflow
  /exceeds the context window/i,                // openai (completions + responses)
  /input token count.*exceeds the maximum/i,    // google
  /input is too long for requested model/i,     // bedrock
  /maximum context length is \d+ tokens/i,      // openrouter (all backends)
  /context[_ ]length[_ ]exceeded/i,             // generic
];

/** Tested FIRST, and the order is the point. Bedrock formats throttling as
 *  "ThrottlingException: Too many tokens, please wait before trying again." —
 *  a capacity problem whose words are about tokens. Read as an overflow it would
 *  retire a session that only needed to wait. */
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

export interface OverflowUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** The WHOLE prompt the call carried, as the provider counted it. The one
   *  figure this module measures against the window — see the note on `used`
   *  below. */
  contextTokens: number;
}

/** Which of the three modes fired, or undefined for none. Named rather than
 *  boolean so a log line can say WHY a run was judged overflowed — "the provider
 *  said so" and "we inferred it from token counts" are different claims and an
 *  operator reading a retirement should be able to tell them apart. */
export type OverflowMode = 'error_text' | 'silent' | 'length_stop';

/** Fraction of the window at which a zero-output stop is read as the provider
 *  having truncated the input to fit and left no room to generate. Just under
 *  1.0 because the provider counts the system prompt and tool schemas that our
 *  usage figure does not. */
const LENGTH_STOP_RATIO = 0.99;

/** Share of the window a run must have been observed occupying before its
 *  session is retired as saturated.
 *
 *  Not a first guess dressed up as a threshold: at this fraction the provider
 *  has already truncated or is about to reject, which is the same condition
 *  `LENGTH_STOP_RATIO` describes — they are one number and are kept as one.
 *  Only ever compared against a ratio measured on a RECORDED window. */
export const CONTEXT_SATURATION_RATIO = LENGTH_STOP_RATIO;

export function detectContextOverflow(
  event: Extract<InvocationEvent, { type: 'completion' }>,
  usage: OverflowUsage,
  window: ContextWindowReading | undefined,
): OverflowMode | undefined {
  const reason = event.reason ?? '';

  // ── 1. Error text ──────────────────────────────────────────────────────────
  // Available on any window, because it does not use one: the provider said the
  // input did not fit, and that is not an inference.
  if (event.outcome === 'error' && reason) {
    if (!NON_OVERFLOW_PATTERNS.some((p) => p.test(reason))
      && OVERFLOW_PATTERNS.some((p) => p.test(reason))) {
      return 'error_text';
    }
  }

  // Cases 2 and 3 compare against the window, so they need a RECORDED one.
  // Skipped rather than guessed: an inferred overflow on a floor is exactly the
  // false positive that would abandon a healthy conversation.
  if (!mayDriveRetirement(window) || !window || window.tokens <= 0) return undefined;

  // `contextTokens`, not `inputTokens + cachedTokens`.
  //
  // That sum was wrong in BOTH directions and neither error announced itself.
  // Anthropic reports `input_tokens` exclusive of cache reads AND cache
  // writes, so the sum was short by every cache-creation token — on the first
  // call of a cached conversation, by most of the prompt. Every provider whose
  // input is already inclusive (OpenAI, Google, and opencode after its own
  // normalisation) had the cached part counted TWICE, so a healthy run could
  // read as overflowed. Each adapter now states the figure the guard needs, in
  // the one place that knows which convention its numbers arrived in.
  const used = usage.contextTokens ?? 0;

  // ── 2. Silent overflow ─────────────────────────────────────────────────────
  // A healthy outcome whose input exceeded the window. Some providers accept an
  // oversized request and answer anyway, so nothing in the run says it happened.
  if (event.outcome !== 'error' && used > window.tokens) return 'silent';

  // ── 3. Length-stop overflow ────────────────────────────────────────────────
  // The provider truncated the input to fit and had no room left to generate.
  // Zero output tokens is what distinguishes it from an ordinary max-tokens stop,
  // where the model generated right up to its ceiling.
  if (event.outcome === 'limit_reached'
    && (usage.outputTokens ?? 0) === 0
    && used >= window.tokens * LENGTH_STOP_RATIO) {
    return 'length_stop';
  }

  return undefined;
}
