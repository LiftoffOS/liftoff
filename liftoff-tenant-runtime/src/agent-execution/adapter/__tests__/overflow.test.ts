// Structural context-overflow detection.
//
// Two of the three modes produce NO error text, so the existing prose check
// (resume-safety.ts#contextExhaustedCompletion, capped at 600 characters and
// requiring a subject clause and a state clause) cannot see them at all. The
// assertions below are ordered by how much damage getting them wrong does.

import { detectContextOverflow, CONTEXT_SATURATION_RATIO } from '../overflow';
import type { InvocationEvent } from '../types';
import type { ContextWindowReading } from '../../../llm/context-window';

const REGISTRY: ContextWindowReading = { tokens: 200_000, source: 'registry' };
const FLOOR: ContextWindowReading = { tokens: 200_000, source: 'provider_floor' };

const completion = (
  outcome: 'success' | 'error' | 'escalated' | 'limit_reached',
  reason?: string,
): Extract<InvocationEvent, { type: 'completion' }> => ({ type: 'completion', outcome, ...(reason ? { reason } : {}) });

/** A usage reading as an adapter emits it.
 *
 *  `contextTokens` is what this module measures, and the default here is the
 *  INCLUSIVE convention (OpenAI, Google, opencode after its own
 *  normalisation): the prompt total already carries the cached part, so the
 *  context is `inputTokens`. The Anthropic shape — input exclusive of cache
 *  reads and cache writes — is spelled out where it is asserted. */
const usage = (inputTokens: number, cachedTokens = 0, outputTokens = 0, contextTokens = inputTokens) =>
  ({ inputTokens, cachedTokens, outputTokens, contextTokens });

describe('mode 1 — the provider said the input did not fit', () => {
  it.each([
    ['anthropic token overflow', 'prompt is too long: 250000 tokens > 200000 maximum'],
    ['anthropic byte overflow', 'request_too_large: body exceeded limit'],
    ['openai', 'This model\'s maximum context length exceeds the context window'],
    ['google', 'The input token count 1500000 exceeds the maximum number of tokens allowed'],
    ['bedrock', 'Input is too long for requested model'],
    ['openrouter', 'This endpoint\'s maximum context length is 128000 tokens'],
    ['generic', 'context_length_exceeded'],
  ])('%s', (_label, reason) => {
    expect(detectContextOverflow(completion('error', reason), usage(0), REGISTRY)).toBe('error_text');
  });

  // Available on ANY window, because it does not use one — the provider said so,
  // and that is not an inference.
  it('fires on a provider floor too, because it needs no window', () => {
    expect(detectContextOverflow(completion('error', 'prompt is too long'), usage(0), FLOOR)).toBe('error_text');
  });

  it('fires with no window at all', () => {
    expect(detectContextOverflow(completion('error', 'prompt is too long'), usage(0), undefined)).toBe('error_text');
  });
});

describe('mode 1 — the non-overflow patterns are tested first', () => {
  // Bedrock formats throttling as "Too many tokens, please wait before trying
  // again". Read as an overflow it would retire a session that only needed to
  // wait for capacity.
  it.each([
    'Throttling error: Too many tokens, please wait before trying again.',
    'Service unavailable: too many requests, retry shortly',
    'rate limit reached; maximum context length is 128000 tokens',
  ])('does not classify %s as an overflow', (reason) => {
    expect(detectContextOverflow(completion('error', reason), usage(0), REGISTRY)).toBeUndefined();
  });
});

describe('mode 2 — silent overflow', () => {
  // Some providers accept an oversized request and answer anyway. Nothing in the
  // run says it happened, and we already receive the usage that shows it.
  it('fires on a HEALTHY outcome whose prompt exceeded the window', () => {
    expect(detectContextOverflow(completion('success'), usage(210_000), REGISTRY)).toBe('silent');
  });

  it('reads the ADAPTER\'s context figure, not input + cached', () => {
    // The Anthropic shape: `inputTokens` is the uncached part alone, and the
    // cache read and the cache WRITE are their own counts. 150k + 60k read +
    // 30k written is 240,000 tokens of prompt against a 200,000 window — and
    // `input + cached` would have reported 210,000, which happens to trip here
    // and would be short by the cache write every time it mattered.
    expect(detectContextOverflow(completion('success'), usage(150_000, 60_000, 0, 240_000), REGISTRY)).toBe('silent');
  });

  it('does NOT count an inclusive provider\'s cached part twice', () => {
    // OpenAI and Google report a prompt TOTAL that already carries the cached
    // part. `input + cached` read 150,000 here and called a healthy run
    // overflowed; the prompt was 100,000.
    expect(detectContextOverflow(completion('success'), usage(100_000, 50_000), REGISTRY)).toBeUndefined();
  });

  it('does not fire on a run that fitted', () => {
    expect(detectContextOverflow(completion('success'), usage(100_000, 50_000, 0, 100_000), REGISTRY)).toBeUndefined();
  });
});

describe('mode 3 — length-stop overflow', () => {
  // The provider truncated the input to fit and had no room left to generate.
  it('fires on limit_reached with zero output at a full window', () => {
    expect(detectContextOverflow(completion('limit_reached'), usage(199_000, 0, 0), REGISTRY)).toBe('length_stop');
  });

  // Zero output is what separates it from an ordinary max-tokens stop, where the
  // model generated right up to its ceiling. Those are opposite situations and
  // conflating them would retire sessions that were working perfectly.
  it('does not fire when the model actually generated', () => {
    expect(detectContextOverflow(completion('limit_reached'), usage(199_000, 0, 4096), REGISTRY)).toBeUndefined();
  });

  it('does not fire well below the window', () => {
    expect(detectContextOverflow(completion('limit_reached'), usage(50_000, 0, 0), REGISTRY)).toBeUndefined();
  });
});

describe('a provider floor may never produce an inferred overflow', () => {
  // The case the whole guard exists for. claude-opus-5[1m] holds 1,000,000 and
  // the Anthropic floor is 200,000, so a healthy 300k-token run measured against
  // the floor looks saturated — and wired to a session retirement, its
  // conversation is abandoned. A data-losing false positive produced by the
  // check meant to prevent data loss.
  it('skips silent-overflow detection on a floor', () => {
    expect(detectContextOverflow(completion('success'), usage(300_000), FLOOR)).toBeUndefined();
  });

  it('skips length-stop detection on a floor', () => {
    expect(detectContextOverflow(completion('limit_reached'), usage(300_000, 0, 0), FLOOR)).toBeUndefined();
  });

  it('skips both when there is no window at all', () => {
    expect(detectContextOverflow(completion('success'), usage(300_000), undefined)).toBeUndefined();
  });

  it('skips both on a non-positive window', () => {
    expect(detectContextOverflow(completion('success'), usage(300_000), { tokens: 0, source: 'registry' })).toBeUndefined();
  });
});

describe('the saturation ratio is the length-stop ratio', () => {
  // They describe one condition — the provider has already truncated or is about
  // to reject — so they are one number, not two thresholds that can drift apart.
  it('is a single value', () => {
    expect(CONTEXT_SATURATION_RATIO).toBe(0.99);
  });
});

// The detector names the MODE rather than returning a bare boolean, because the
// log line an operator reads has to distinguish "the provider said so" from "we
// inferred it from token counts". Those are different claims, and a retirement
// justified by the second deserves to say so.
describe('a clean run is not an overflow', () => {
  it('returns undefined rather than a mode', () => {
    expect(detectContextOverflow(completion('success'), usage(1_000), REGISTRY)).toBeUndefined();
  });
});
