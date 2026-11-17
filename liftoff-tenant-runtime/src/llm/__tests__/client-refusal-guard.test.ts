// Integration-ish unit test for LLMClient.complete()'s refusal guard.
//
// This exercises the REAL guard in client.ts (the `if (response.stopReason ===
// 'refusal')` block), not a extracted helper: we mock the providers barrel so
// init() wires up a single fake provider whose complete() we control, then
// drive the singleton llmClient through a refusal and a success and assert the
// externally observable behavior (throws LLMRefusalError / returns the
// completion) plus the usage event emitted at the same chokepoint.

// Controllable stand-in for the underlying provider's complete(). Prefixed
// `mock` so jest's factory-hoisting allow-list lets the factory close over it.
const mockComplete = jest.fn();

// Replace the providers barrel so init() never touches real SDKs/secrets. Only
// Google resolves, so it becomes the default (GLOBAL_PROVIDER_PRIORITY =
// anthropic → openai → google; the first two are null here).
//
// GOOGLE, AND THAT IS NOT ARBITRARY. This suite needs a provider that is NOT
// pool-routed, so that complete() dispatches straight to the fake instead of
// through a purpose pool. It used to use anthropic-vertex for that; Claude over
// Google Vertex is retired, and Google is the remaining provider with a single
// instance rather than a pool. If Google ever gains a pool, this mock stops
// reaching the fake and these tests will say so loudly rather than quietly
// testing nothing.
jest.mock('../providers', () => ({
  AnthropicProvider: {
    create: jest.fn().mockResolvedValue(null),
    createPool: jest.fn().mockResolvedValue(null),
  },
  GoogleProvider: {
    create: jest.fn().mockResolvedValue({
      provider: 'google',
      complete: (req: unknown) => mockComplete(req),
      countTokens: jest.fn(),
    }),
  },
  OpenAIProvider: { createPool: jest.fn().mockResolvedValue(null) },
}));

import { llmClient } from '../client';
import { LLMRefusalError } from '../types';
import type { LLMUsageEvent } from '../types';

const usageEvents: LLMUsageEvent[] = [];

beforeAll(() => {
  // Register exactly once — the client singleton persists across tests.
  llmClient.onUsage(evt => usageEvents.push(evt));
});

beforeEach(() => {
  usageEvents.length = 0;
});

const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('LLMClient.complete() refusal guard', () => {
  it('throws LLMRefusalError (does NOT return) when the provider reports stopReason: refusal', async () => {
    mockComplete.mockResolvedValueOnce({
      content: 'partial refused output',
      model: 'gemini-3.5-flash',
      provider: 'google',
      stopReason: 'refusal',
      usage: { inputTokens: 12, outputTokens: 3, cachedTokens: 0 },
    });

    await expect(llmClient.complete(REQUEST)).rejects.toBeInstanceOf(LLMRefusalError);
  });

  it('populates the thrown error with provider/model/partialContent from the response', async () => {
    mockComplete.mockResolvedValueOnce({
      content: 'partial refused output',
      model: 'gemini-3.5-flash',
      provider: 'google',
      stopReason: 'refusal',
      usage: { inputTokens: 12, outputTokens: 3, cachedTokens: 0 },
    });

    const err = await llmClient.complete(REQUEST).catch(e => e);
    expect(err).toBeInstanceOf(LLMRefusalError);
    expect(err.provider).toBe('google');
    expect(err.model).toBe('gemini-3.5-flash');
    expect(err.partialContent).toBe('partial refused output');
  });

  it('emits a single failure usage event tagged llm_refusal (tokens stay auditable)', async () => {
    mockComplete.mockResolvedValueOnce({
      content: '',
      model: 'gemini-3.5-flash',
      provider: 'google',
      stopReason: 'refusal',
      usage: { inputTokens: 40, outputTokens: 0, cachedTokens: 5 },
    });

    await expect(llmClient.complete(REQUEST)).rejects.toBeInstanceOf(LLMRefusalError);

    // The guard emits one failure event with error 'llm_refusal'; the outer
    // catch does NOT re-emit for the refusal path (the guard's throw is caught,
    // but assert we didn't produce a spurious success event).
    const refusalEvents = usageEvents.filter(e => e.error === 'llm_refusal');
    expect(refusalEvents).toHaveLength(1);
    expect(refusalEvents[0]).toMatchObject({
      provider: 'google',
      model: 'gemini-3.5-flash',
      inputTokens: 40,
      outputTokens: 0,
      cachedTokens: 5,
      success: false,
    });
    expect(usageEvents.some(e => e.success === true)).toBe(false);
  });

  it('returns the completion and emits a success event when stopReason is not a refusal', async () => {
    mockComplete.mockResolvedValueOnce({
      content: 'a real answer',
      model: 'gemini-3.5-flash',
      provider: 'google',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 0 },
    });

    const res = await llmClient.complete(REQUEST);
    expect(res.content).toBe('a real answer');
    expect(res.stopReason).toBe('end_turn');
    const successEvents = usageEvents.filter(e => e.success === true);
    expect(successEvents).toHaveLength(1);
    expect(usageEvents.some(e => e.error === 'llm_refusal')).toBe(false);
  });
});
