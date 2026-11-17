// 4-Provider Parity Smoke Test
//
// Drives all four providers through the same canned input and asserts the
// resulting LLMStreamEvent sequence is shape-equivalent. Catches normalization
// drift if a fix lands in one provider but not the others.
//
// What's compared:
// - Tool calls extracted (name + parsed input)
// - Final stopReason
// - Whether any text deltas were emitted
//
// What's NOT compared:
// - Text delta granularity (varies wildly by provider — what matters is the
//   end shape, not how the model chose to chunk its output)
// - Provider field (obviously different)
// - Token counts (each stub uses different counts; usage tracking is tested
//   separately in client.test.ts via the LLMClient.completeStream wrapper)

import { OpenAIProvider } from '../providers/openai';
import { OpenRouterProvider } from '../providers/openrouter';
import { AnthropicProvider } from '../providers/anthropic';
import { GoogleProvider } from '../providers/google';
import type { LLMProviderClient, LLMStreamEvent } from '../types';

jest.mock('../../infrastructure/secrets', () => ({
  getOpenAIApiKey: jest.fn().mockResolvedValue('test-key'),
  getAnthropicApiKey: jest.fn().mockResolvedValue('test-key'),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

async function* fromValues<T>(values: T[]): AsyncIterable<T> {
  for (const v of values) yield v;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-provider stub builders. Each one constructs a provider whose underlying
// SDK returns a canned response equivalent to:
//   "say 'Looking...' then call get_cost(period: 'week')"
// ──────────────────────────────────────────────────────────────────────────

function buildOpenAIStub(): LLMProviderClient {
  const stream = fromValues<unknown>([
    { choices: [{ delta: { content: 'Looking...' }, finish_reason: null }] },
    { choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_xyz',
          type: 'function',
          function: { name: 'get_cost', arguments: '{"period":"week"}' },
        }],
      },
      finish_reason: null,
    }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
  ]);

  const stub = {
    chat: { completions: { create: jest.fn().mockResolvedValue(stream) } },
  };
  const Ctor = OpenAIProvider as unknown as new (client: unknown) => OpenAIProvider;
  return new Ctor(stub);
}

function buildAnthropicDirectStub(): LLMProviderClient {
  const stream = fromValues<unknown>([
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking...' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_cost', input: {} },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"period":"week"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);

  const stub = { messages: { stream: jest.fn().mockReturnValue(stream) } };
  const Ctor = AnthropicProvider as unknown as new (client: unknown) => AnthropicProvider;
  return new Ctor(stub);
}

function buildGoogleStub(): LLMProviderClient {
  const stream = fromValues<unknown>([
    {
      candidates: [{
        content: {
          parts: [
            { text: 'Looking...' },
            { functionCall: { name: 'get_cost', args: { period: 'week' } } },
          ],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    },
  ]);

  const generativeModel = {
    generateContentStream: jest.fn().mockResolvedValue({ stream }),
    generateContent: jest.fn(),
    startChat: jest.fn(),
  };
  const stub = { getGenerativeModel: jest.fn().mockReturnValue(generativeModel) };
  const Ctor = GoogleProvider as unknown as new (vertexAI: unknown, projectId: string) => GoogleProvider;
  return new Ctor(stub, 'test-project');
}

function buildOpenRouterStub(): LLMProviderClient {
  // GLM/Z.ai is OpenAI-wire — same stub shape as buildOpenAIStub, constructed as
  // OpenRouterProvider to exercise the parameterized OpenAIProvider subclass path.
  const stream = fromValues<unknown>([
    { choices: [{ delta: { content: 'Looking...' }, finish_reason: null }] },
    { choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_xyz',
          type: 'function',
          function: { name: 'get_cost', arguments: '{"period":"week"}' },
        }],
      },
      finish_reason: null,
    }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
  ]);

  const stub = {
    chat: { completions: { create: jest.fn().mockResolvedValue(stream) } },
  };
  const Ctor = OpenRouterProvider as unknown as new (client: unknown) => OpenRouterProvider;
  return new Ctor(stub);
}

const PROVIDERS: Array<{ name: string; build: () => LLMProviderClient }> = [
  { name: 'openai', build: buildOpenAIStub },
  { name: 'anthropic', build: buildAnthropicDirectStub },
  { name: 'google', build: buildGoogleStub },
  { name: 'openrouter', build: buildOpenRouterStub },
];

describe('Provider Parity — completeStream (Phase 4)', () => {
  it.each(PROVIDERS)('$name yields the same normalized event sequence', async ({ build }) => {
    const provider = build();
    const events: LLMStreamEvent[] = [];

    for await (const ev of provider.completeStream({
      messages: [{ role: 'user', content: 'cost?' }],
      tools: [{
        name: 'get_cost',
        description: 'Get cost',
        input_schema: { type: 'object', properties: { period: { type: 'string' } } },
      }],
    })) {
      events.push(ev);
    }

    // Discard non-essential details for the comparison.
    const summary = {
      tools: events
        .filter((e): e is Extract<LLMStreamEvent, { type: 'tool_use' }> => e.type === 'tool_use')
        .map(e => ({ name: e.toolCall.name, input: e.toolCall.input })),
      stopReason: events
        .filter((e): e is Extract<LLMStreamEvent, { type: 'message_complete' }> => e.type === 'message_complete')
        .map(e => e.stopReason)[0],
      hadText: events.some(e => e.type === 'text_delta'),
      terminator: events[events.length - 1]?.type,
    };

    expect(summary).toEqual({
      tools: [{ name: 'get_cost', input: { period: 'week' } }],
      stopReason: 'tool_use',
      hadText: true,
      terminator: 'message_complete',
    });
  });

  it('every provider yields exactly one terminator event', async () => {
    for (const { name, build } of PROVIDERS) {
      const provider = build();
      const events: LLMStreamEvent[] = [];
      for await (const ev of provider.completeStream({
        messages: [{ role: 'user', content: 'cost?' }],
        tools: [{ name: 'get_cost', description: '', input_schema: { type: 'object', properties: {} } }],
      })) {
        events.push(ev);
      }
      const terminators = events.filter(e => e.type === 'message_complete' || e.type === 'error');
      expect({ provider: name, terminators: terminators.length }).toEqual({ provider: name, terminators: 1 });
    }
  });
});
