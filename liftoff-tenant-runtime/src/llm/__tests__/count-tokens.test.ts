// Part 2 — countTokens unit tests.
//
// Scope: provider implementations that don't need network. The OpenAI
// provider's countTokens runs locally via tiktoken; the Anthropic, Vertex
// Anthropic, and Google implementations need network and are exercised by
// the live ground-truth tests (count-tokens.live.test.ts, opt-in via
// LIVE_TESTS=true).
//
// 4 unit tests per the plan:
//   1. non-zero, no-throw
//   2. tool-schema overhead increases the count meaningfully
//   3. pickEncoder handles unknown models without throwing
//   4. OpenAI message-overhead roughly tracks message count

import OpenAI from 'openai';
import { OpenAIProvider } from '../providers/openai';
import type { LLMTokenCountRequest } from '../types';

function makeProvider(): OpenAIProvider {
  // The OpenAI client is unused by countTokens (everything is local
  // tiktoken). Constructing it with a placeholder key keeps the
  // tests offline.
  return new (OpenAIProvider as unknown as new (c: OpenAI) => OpenAIProvider)(
    new OpenAI({ apiKey: 'sk-test' }),
  );
}

const SAMPLE: LLMTokenCountRequest = {
  messages: [
    { role: 'system', content: 'You are a careful test responder.' },
    { role: 'user', content: 'Summarize: the quick brown fox jumps over the lazy dog.' },
    { role: 'assistant', content: 'A pangram about a fox and a dog.' },
  ],
  model: 'gpt-4o-mini',
};

const SAMPLE_TOOL = {
  name: 'lookup_record',
  description: 'Fetch a record by id from the in-memory store',
  input_schema: {
    type: 'object' as const,
    properties: { id: { type: 'string' as const } },
    required: ['id'],
  },
};

describe('OpenAIProvider.countTokens', () => {
  it('returns a positive token count for a non-empty request (no-throw, non-zero)', async () => {
    const provider = makeProvider();
    const result = await provider.countTokens(SAMPLE);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.estimated).toBe(true);
  });

  it('tool definitions increase the count by ≥20 tokens', async () => {
    const provider = makeProvider();
    const without = await provider.countTokens(SAMPLE);
    const withTool = await provider.countTokens({ ...SAMPLE, tools: [SAMPLE_TOOL] });
    expect(withTool.inputTokens - without.inputTokens).toBeGreaterThan(20);
  });

  it('pickEncoder handles unknown model without throwing (warns + falls back to o200k_base)', async () => {
    const provider = makeProvider();
    const result = await provider.countTokens({ ...SAMPLE, model: 'gpt-99-future' });
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.estimated).toBe(true);
  });

  it('per-message overhead scales with message count', async () => {
    const provider = makeProvider();
    const oneMessage = await provider.countTokens({ ...SAMPLE, messages: SAMPLE.messages.slice(0, 1) });
    const threeMessages = await provider.countTokens(SAMPLE);
    // Three messages must produce a strictly greater count than one.
    expect(threeMessages.inputTokens).toBeGreaterThan(oneMessage.inputTokens);
  });

  it('strips date-suffix variants before defaulting (gpt-4o-2024-08-06 ≈ gpt-4o)', async () => {
    const provider = makeProvider();
    const exact = await provider.countTokens({ ...SAMPLE, model: 'gpt-4o' });
    const dated = await provider.countTokens({ ...SAMPLE, model: 'gpt-4o-2024-08-06' });
    expect(dated.inputTokens).toBe(exact.inputTokens);
  });
});
