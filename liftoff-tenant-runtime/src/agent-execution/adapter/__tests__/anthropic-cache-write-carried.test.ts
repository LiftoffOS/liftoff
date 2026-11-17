/**
 * The Anthropic adapter must carry cache WRITES, not only cache reads.
 *
 * Anthropic bills a cache write at 1.25x the input rate and a read at 0.1x. This
 * adapter read `cache_creation_input_tokens` and spent it on `contextTokens`
 * alone — a window measurement, not money — under a comment noting that cache
 * creation is "billed differently". It was billed differently by Anthropic and
 * not at all by us, on `claude-agent-sdk`.
 */

// The Claude Agent SDK is ESM-only and jest cannot parse it; the adapter only
// needs to be constructible here, since the seam under test is pure translation.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  AbortError: class AbortError extends Error {},
  query: jest.fn(() => {
    const it = (async function* () { /* no messages */ })();
    return Object.assign(it, { interrupt: jest.fn(), setPermissionMode: jest.fn() });
  }),
}));

import { AnthropicAdapter } from '../anthropic';
import type { InvocationEvent } from '../types';

function usageFrom(resultMessage: unknown): Extract<InvocationEvent, { type: 'usage' }> | undefined {
  const adapter = new AnthropicAdapter();
  const translate = (adapter as unknown as {
    translateSDKMessage(m: unknown): InvocationEvent[];
  }).translateSDKMessage.bind(adapter);
  return translate(resultMessage).find((e) => e.type === 'usage') as
    Extract<InvocationEvent, { type: 'usage' }> | undefined;
}

const result = (usage: Record<string, unknown>) => ({ type: 'result', subtype: 'success', usage });

it('carries cache_creation_input_tokens as a billable count', () => {
  const usage = usageFrom(result({
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_input_tokens: 24_000,
    cache_creation_input_tokens: 4_000,
  }));
  expect(usage?.usage.cacheWriteTokens).toBe(4_000);
});

it('keeps the write distinct from the read, because the two rates differ 12.5x', () => {
  const usage = usageFrom(result({
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_input_tokens: 24_000,
    cache_creation_input_tokens: 4_000,
  }));
  expect(usage?.usage.cachedTokens).toBe(24_000);
  expect(usage?.usage.cacheWriteTokens).toBe(4_000);
  // And input is untouched: Anthropic reports it exclusive of both, so the three
  // are additive and none of them may be derived from another.
  expect(usage?.usage.inputTokens).toBe(1_000);
});

it('still reports the whole prompt as the context, writes included', () => {
  // The context guard needs input + read + write; that reading must survive the
  // write becoming billable too.
  const usage = usageFrom(result({
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_input_tokens: 24_000,
    cache_creation_input_tokens: 4_000,
  }));
  expect(usage?.usage.contextTokens).toBe(29_000);
});

it('sums the cache write from the PER-CALL usage, which is where the real figure is', () => {
  // The Agent SDK's `result` aggregate reports cache_creation_input_tokens as 0
  // even on a turn that demonstrably wrote the cache: runs whose cache READS
  // climb turn over turn still see every result aggregate report no write.
  // An assistant message carries the raw Anthropic usage for one API
  // call, which is the shape platform-backend already bills cache writes from.
  //
  // Summed across calls, not taken as a total: a turn makes several and each writes
  // its own increment.
  const adapter = new AnthropicAdapter();
  const translate = (adapter as unknown as {
    translateSDKMessage(m: unknown): InvocationEvent[];
  }).translateSDKMessage.bind(adapter);

  translate({ type: 'assistant', message: { content: [], usage: { cache_creation_input_tokens: 24_000 } } });
  translate({ type: 'assistant', message: { content: [], usage: { cache_creation_input_tokens: 3_285 } } });
  const events = translate(result({
    input_tokens: 3,
    output_tokens: 4,
    cache_read_input_tokens: 31_300,
    // What the aggregate actually says, and why reading it alone billed nothing.
    cache_creation_input_tokens: 0,
  }));
  const usage = events.find((e) => e.type === 'usage') as
    Extract<InvocationEvent, { type: 'usage' }> | undefined;
  expect(usage?.usage.cacheWriteTokens).toBe(27_285);
});

it('reads the write from modelUsage, which is the only source that carries it', () => {
  // The result's snake_case `usage` says 0 while reporting the READ correctly on the
  // same object. `modelUsage` is the SDK's per-model breakdown and declares
  // `cacheCreationInputTokens` — camelCase, which is why a snake_case read finds
  // nothing. These are the real dev numbers from a cold turn: a ~28,000-token prompt
  // that recorded 3 input, 0 read and no write at all.
  const usage = usageFrom({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {
      'claude-sonnet-4-6': { cacheCreationInputTokens: 28_015 },
    },
  });
  expect(usage?.usage.cacheWriteTokens).toBe(28_015);
});

it('sums modelUsage across models, because a turn can straddle two', () => {
  const usage = usageFrom({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0 },
    modelUsage: {
      'claude-sonnet-4-6': { cacheCreationInputTokens: 28_015 },
      'claude-haiku-4-5': { cacheCreationInputTokens: 1_200 },
    },
  });
  expect(usage?.usage.cacheWriteTokens).toBe(29_215);
});

it('never lets a smaller source win', () => {
  // All three are compared and the largest is taken, so a populated field can only
  // ever raise the figure — never mask a bigger one reported elsewhere.
  const usage = usageFrom({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 9_000 },
    modelUsage: { 'claude-sonnet-4-6': { cacheCreationInputTokens: 100 } },
  });
  expect(usage?.usage.cacheWriteTokens).toBe(9_000);
});

it('reports zero rather than undefined when the turn wrote no cache', () => {
  // Zero is the honest answer here: this vendor DOES charge for writes, so the
  // absence of one is a measurement, not an unknown.
  const usage = usageFrom(result({
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_input_tokens: 0,
  }));
  expect(usage?.usage.cacheWriteTokens).toBe(0);
});
