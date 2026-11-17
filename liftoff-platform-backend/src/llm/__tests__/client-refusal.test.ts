// LLMClient refusal guard tests — a completion that resolves with
// stopReason === 'refusal' must throw LLMRefusalError (fail loud) rather than
// be returned as a successful empty response, and the token usage must still be
// recorded once (the provider billed the tokens).

import type {
  LLMProviderClient,
  LLMCompletionResponse,
  LLMStreamEvent,
  LLMUsageEvent,
} from '../types';

// NOTE: LLMRefusalError is imported *dynamically inside each test*, from the
// same post-`jest.resetModules()` module graph as `../client`. A static
// top-level import would bind to a different `../types` instance than the one
// the freshly-imported client throws, and `instanceof` would fail even though
// both classes are "LLMRefusalError".

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let fakeCompleteResponse: LLMCompletionResponse = {
  content: '',
  model: 'gpt-5.4',
  provider: 'openai',
  stopReason: 'end_turn',
};
let fakeStreamEvents: LLMStreamEvent[] = [];

class FakeOpenAIProvider implements LLMProviderClient {
  readonly provider = 'openai' as const;
  async complete(): Promise<LLMCompletionResponse> {
    return fakeCompleteResponse;
  }
  async *completeStream(): AsyncIterable<LLMStreamEvent> {
    for (const ev of fakeStreamEvents) yield ev;
  }
}

jest.mock('../providers', () => ({
  AnthropicProvider: { create: jest.fn().mockResolvedValue(null), createPool: jest.fn().mockResolvedValue(null) },
  GoogleProvider: { create: jest.fn().mockResolvedValue(null) },
  OpenRouterProvider: { createOpenRouter: jest.fn().mockResolvedValue(null) },
  OpenAIProvider: {
    create: jest.fn().mockImplementation(() => Promise.resolve(new FakeOpenAIProvider())),
    createPool: jest.fn().mockImplementation(() => {
      const pool = new Map();
      const inst = new FakeOpenAIProvider();
      pool.set('agent-execution', inst);
      pool.set('reflective-services', inst);
      pool.set('platform-analytics', inst);
      pool.set('background-services', inst);
      return Promise.resolve(pool);
    }),
  },
}));

describe('LLMClient.complete — refusal guard', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('throws LLMRefusalError when a completion resolves with stopReason "refusal"', async () => {
    fakeCompleteResponse = {
      content: '',
      model: 'gpt-5.4',
      provider: 'openai',
      stopReason: 'refusal',
      refusalCategory: 'content_filter',
      usage: { inputTokens: 12, outputTokens: 0 },
    };

    const { llmClient } = await import('../client');
    const { LLMRefusalError } = await import('../types');
    const usageEvents: LLMUsageEvent[] = [];
    llmClient.onUsage(ev => usageEvents.push(ev));

    await expect(
      llmClient.complete({ messages: [{ role: 'user', content: 'hi' }] }, 'openai'),
    ).rejects.toBeInstanceOf(LLMRefusalError);

    // Usage recorded exactly once, as a successful (billed) call.
    expect(usageEvents.length).toBe(1);
    expect(usageEvents[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 12,
      success: true,
    });
  });

  it('carries provider/model/category on the thrown error', async () => {
    fakeCompleteResponse = {
      content: '',
      model: 'gpt-5.4',
      provider: 'openai',
      stopReason: 'refusal',
      refusalCategory: 'content_filter',
    };

    const { llmClient } = await import('../client');
    const { LLMRefusalError } = await import('../types');
    let caught: unknown;
    try {
      await llmClient.complete({ messages: [{ role: 'user', content: 'hi' }] }, 'openai');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LLMRefusalError);
    const refusal = caught as InstanceType<typeof LLMRefusalError>;
    expect(refusal.provider).toBe('openai');
    expect(refusal.model).toBe('gpt-5.4');
    expect(refusal.category).toBe('content_filter');
  });

  it('does NOT throw for a normal end_turn completion', async () => {
    fakeCompleteResponse = {
      content: 'all good',
      model: 'gpt-5.4',
      provider: 'openai',
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 2 },
    };

    const { llmClient } = await import('../client');
    const result = await llmClient.complete({ messages: [{ role: 'user', content: 'hi' }] }, 'openai');
    expect(result.content).toBe('all good');
  });
});

describe('LLMClient.completeStream — refusal guard', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('throws LLMRefusalError when the stream terminates with stopReason "refusal"', async () => {
    fakeStreamEvents = [
      { type: 'text_delta', text: 'partial' },
      {
        type: 'message_complete',
        stopReason: 'refusal',
        refusalCategory: 'SAFETY',
        usage: { inputTokens: 9, outputTokens: 4 },
      },
    ];

    const { llmClient } = await import('../client');
    const { LLMRefusalError } = await import('../types');
    const usageEvents: LLMUsageEvent[] = [];
    llmClient.onUsage(ev => usageEvents.push(ev));

    const drain = async () => {
      for await (const _ev of llmClient.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        'openai',
      )) {
        // drain
      }
    };

    await expect(drain()).rejects.toBeInstanceOf(LLMRefusalError);
    // Usage recorded once as a billed (successful) call; not double-counted.
    expect(usageEvents.length).toBe(1);
    expect(usageEvents[0]).toMatchObject({ provider: 'openai', inputTokens: 9, outputTokens: 4, success: true });
  });
});
