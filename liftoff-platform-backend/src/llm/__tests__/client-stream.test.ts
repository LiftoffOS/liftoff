// LLMClient.completeStream tests — verifies the orchestrator forwards events
// from the chosen provider AND fires the usage callback exactly once with the
// correct token totals on either message_complete or error.

import type {
  LLMProviderClient,
  LLMStreamEvent,
  LLMUsageEvent,
} from '../types';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Stub all four provider factories so init() succeeds without real SDKs.
const fakeProviderEvents: LLMStreamEvent[] = [
  { type: 'text_delta', text: 'Hello' },
  { type: 'text_delta', text: ' world' },
  {
    type: 'message_complete',
    stopReason: 'end_turn',
    usage: { inputTokens: 7, outputTokens: 3 },
  },
];

let fakeStreamEvents: LLMStreamEvent[] = fakeProviderEvents;

class FakeOpenAIProvider implements LLMProviderClient {
  readonly provider = 'openai' as const;
  async complete(): Promise<never> {
    throw new Error('not used in this test');
  }
  async *completeStream(): AsyncIterable<LLMStreamEvent> {
    for (const ev of fakeStreamEvents) yield ev;
  }
  static async create(): Promise<FakeOpenAIProvider | null> {
    return new FakeOpenAIProvider();
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

describe('LLMClient.completeStream (Phase 4)', () => {
  beforeEach(() => {
    jest.resetModules();
    fakeStreamEvents = fakeProviderEvents;
  });

  it('forwards events from the chosen provider', async () => {
    const { llmClient } = await import('../client');
    const events: LLMStreamEvent[] = [];

    for await (const ev of llmClient.completeStream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(ev);
    }

    expect(events).toEqual(fakeProviderEvents);
  });

  it('fires usage callback with correct totals on message_complete', async () => {
    const { llmClient } = await import('../client');
    const usageEvents: LLMUsageEvent[] = [];
    llmClient.onUsage(ev => usageEvents.push(ev));

    for await (const _ev of llmClient.completeStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      'openai',
      { tenantId: 't1', purpose: 'insights_chat' },
    )) {
      // drain
    }

    expect(usageEvents.length).toBe(1);
    expect(usageEvents[0]).toMatchObject({
      provider: 'openai',
      inputTokens: 7,
      outputTokens: 3,
      success: true,
      context: { tenantId: 't1', purpose: 'insights_chat' },
    });
  });

  it('passes cacheWriteTokens and cacheReadTokens from message_complete through to the usage callback', async () => {
    fakeStreamEvents = [
      { type: 'text_delta', text: 'hi' },
      {
        type: 'message_complete',
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 3, cacheWriteTokens: 80, cacheReadTokens: 0 },
      },
    ];

    const { llmClient } = await import('../client');
    const usageEvents: LLMUsageEvent[] = [];
    llmClient.onUsage(ev => usageEvents.push(ev));

    for await (const _ of llmClient.completeStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      'openai',
    )) { /* drain */ }

    expect(usageEvents.length).toBe(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 3,
      cacheWriteTokens: 80,
      cacheReadTokens: 0,
      success: true,
    });
  });

  it('fires usage callback with success=false when stream ends in error event', async () => {
    fakeStreamEvents = [
      { type: 'text_delta', text: 'partial' },
      { type: 'error', message: 'rate limited' },
    ];

    const { llmClient } = await import('../client');
    const usageEvents: LLMUsageEvent[] = [];
    llmClient.onUsage(ev => usageEvents.push(ev));

    for await (const _ev of llmClient.completeStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      'openai',
    )) {
      // drain
    }

    expect(usageEvents.length).toBe(1);
    expect(usageEvents[0]).toMatchObject({
      provider: 'openai',
      success: false,
      error: 'rate limited',
    });
  });
});
