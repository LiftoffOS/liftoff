// `usage.contextTokens` is the whole prompt a call carried, as each vendor
// counts it, on the streamed and the non-streamed path alike. The chat loops
// guard on it, so the per-vendor rule is pinned here: Anthropic reports the
// uncached input, the cache reads and the cache writes as three figures and
// the prompt is their sum; OpenAI's `prompt_tokens` and Google's
// `promptTokenCount` already include what was served from the cache.

import type OpenAI from 'openai';
import { AnthropicProvider } from '../anthropic';
import { OpenAIProvider } from '../openai';
import { GoogleProvider } from '../google';
import type { LLMStreamEvent } from '../../types';

jest.mock('../../../infrastructure/secrets', () => ({
  getAnthropicApiKey: jest.fn().mockResolvedValue('test-key'),
  getOpenAIApiKey: jest.fn().mockResolvedValue('test-key'),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

async function* fromItems<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

async function lastEvent(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent> {
  const events: LLMStreamEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events[events.length - 1];
}

const ANTHROPIC_USAGE = { input_tokens: 20_000, output_tokens: 100, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 140_000 };

describe('contextTokens per provider', () => {
  describe.each([
    ['AnthropicProvider', AnthropicProvider],
  ] as const)('%s: the uncached input plus the cache reads and writes', (_name, Provider) => {
    const make = (client: unknown) => new (Provider as unknown as new (client: unknown) => AnthropicProvider)(client);

    it('complete()', async () => {
      const create = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: ANTHROPIC_USAGE,
        model: 'claude-x',
      });
      const result = await make({ messages: { create } }).complete({ messages: [{ role: 'user', content: 'hi' }] });
      expect(result.usage?.inputTokens).toBe(20_000);
      expect(result.usage?.cacheReadTokens).toBe(140_000);
      expect(result.usage?.cacheWriteTokens).toBe(1_000);
      expect(result.usage?.contextTokens).toBe(161_000);
    });

    it('completeStream()', async () => {
      const stream = jest.fn().mockReturnValue(fromItems([
        { type: 'message_start', message: { usage: ANTHROPIC_USAGE } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ]));
      const last = await lastEvent(make({ messages: { stream } }).completeStream({ messages: [{ role: 'user', content: 'hi' }] }));
      expect(last.type).toBe('message_complete');
      if (last.type !== 'message_complete') return;
      expect(last.usage.inputTokens).toBe(20_000);
      expect(last.usage.contextTokens).toBe(161_000);
    });
  });

  describe('OpenAIProvider: prompt_tokens is the whole prompt, cached part included', () => {
    const make = (stub: unknown) => new (OpenAIProvider as unknown as new (client: unknown) => OpenAIProvider)(stub as OpenAI);

    it('complete()', async () => {
      const create = jest.fn().mockResolvedValue({
        model: 'gpt-x',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 160_000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 140_000 } },
      });
      const result = await make({ chat: { completions: { create } } }).complete({ messages: [{ role: 'user', content: 'hi' }] });
      expect(result.usage?.inputTokens).toBe(160_000);
      expect(result.usage?.cacheReadTokens).toBe(140_000);
      expect(result.usage?.contextTokens).toBe(160_000);
    });

    it('completeStream()', async () => {
      const create = jest.fn().mockResolvedValue(fromItems([
        { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 160_000, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 140_000 } } },
      ]));
      const last = await lastEvent(make({ chat: { completions: { create } } }).completeStream({ messages: [{ role: 'user', content: 'hi' }] }));
      expect(last.type).toBe('message_complete');
      if (last.type !== 'message_complete') return;
      expect(last.usage.contextTokens).toBe(160_000);
    });
  });

  describe('GoogleProvider: promptTokenCount is the whole prompt, cached part included', () => {
    const make = (vertexAI: unknown) => new (GoogleProvider as unknown as new (vertexAI: unknown, projectId: string) => GoogleProvider)(vertexAI, 'test-project');
    const stub = (model: Record<string, unknown>) => ({ getGenerativeModel: jest.fn().mockReturnValue({ startChat: jest.fn(), ...model }) });

    it('complete()', async () => {
      const generateContent = jest.fn().mockResolvedValue({
        response: {
          candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 160_000, candidatesTokenCount: 5, cachedContentTokenCount: 140_000 },
        },
      });
      const result = await make(stub({ generateContent, generateContentStream: jest.fn() })).complete({ messages: [{ role: 'user', content: 'hi' }] });
      expect(result.usage?.inputTokens).toBe(160_000);
      expect(result.usage?.cacheReadTokens).toBe(140_000);
      expect(result.usage?.contextTokens).toBe(160_000);
    });

    it('completeStream()', async () => {
      const generateContentStream = jest.fn().mockResolvedValue({
        stream: fromItems([
          { candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: undefined }] },
          {
            candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 160_000, candidatesTokenCount: 2, cachedContentTokenCount: 140_000 },
          },
        ]),
      });
      const last = await lastEvent(make(stub({ generateContent: jest.fn(), generateContentStream })).completeStream({ messages: [{ role: 'user', content: 'hi' }] }));
      expect(last.type).toBe('message_complete');
      if (last.type !== 'message_complete') return;
      expect(last.usage.contextTokens).toBe(160_000);
    });
  });
});
