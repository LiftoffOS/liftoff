// OpenAIProvider tests — covers tool-use normalization and streaming.
//
// We bypass the static `create()` factory and construct the provider directly
// with a stub OpenAI client. The stub returns canned responses shaped exactly
// like what `chat.completions.create()` would actually return.

import type OpenAI from 'openai';
import { OpenAIProvider } from '../openai';
import type { LLMStreamEvent } from '../../types';

jest.mock('../../../infrastructure/secrets', () => ({
  getOpenAIApiKey: jest.fn().mockResolvedValue('test-key'),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Construct the provider directly, bypassing the private constructor guard. */
function makeProvider(stub: unknown): OpenAIProvider {
  // Access private constructor via prototype trick — only valid in tests.
  const Ctor = OpenAIProvider as unknown as new (client: unknown) => OpenAIProvider;
  return new Ctor(stub);
}

async function* fromChunks<T>(chunks: T[]): AsyncIterable<T> {
  for (const c of chunks) yield c;
}

describe('OpenAIProvider.complete with tools (Phase 4)', () => {
  it('normalizes tool_calls into LLMToolCall[] with parsed input', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.4',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_cost', arguments: '{"period":"week"}' },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const provider = makeProvider({
      chat: { completions: { create } },
    } as unknown as OpenAI);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'How much did I spend?' }],
      tools: [{
        name: 'get_cost',
        description: 'Get cost',
        input_schema: { type: 'object', properties: { period: { type: 'string' } } },
      }],
    });

    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      { id: 'call_abc', name: 'get_cost', input: { period: 'week' } },
    ]);
    expect(result.content).toBe('');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, webSearchRequests: 0, webFetchRequests: undefined, cacheReadTokens: 0, contextTokens: 10 });
  });

  it('returns empty input on malformed JSON arguments', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.4',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [{
            id: 'call_x',
            type: 'function',
            function: { name: 'get_cost', arguments: '{not valid json' },
          }],
        },
      }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });

    const provider = makeProvider({ chat: { completions: { create } } });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'cost?' }],
      tools: [{ name: 'get_cost', description: '', input_schema: { type: 'object', properties: {} } }],
    });

    expect(result.toolCalls?.[0]?.input).toEqual({});
  });

  it.each([
    ['stop', 'end_turn'],
    ['tool_calls', 'tool_use'],
    ['length', 'max_tokens'],
    ['function_call', 'tool_use'],
  ])('maps finish_reason %s → stopReason %s', async (finishReason, expected) => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.4',
      choices: [{
        finish_reason: finishReason,
        message: { role: 'assistant', content: 'hi' },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });

    const provider = makeProvider({ chat: { completions: { create } } });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.stopReason).toBe(expected);
  });

  it('appends toolResults as tool messages in the request', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.4',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });

    const provider = makeProvider({ chat: { completions: { create } } });

    await provider.complete({
      messages: [
        { role: 'user', content: 'cost?' },
        { role: 'assistant', content: '' },
      ],
      toolResults: [
        { toolCallId: 'call_abc', content: '{"total":42}' },
      ],
    });

    const sentMessages = create.mock.calls[0][0].messages;
    expect(sentMessages).toEqual([
      { role: 'user', content: 'cost?' },
      { role: 'assistant', content: '' },
      { role: 'tool', tool_call_id: 'call_abc', content: '{"total":42}' },
    ]);
  });

  it('still works with responseSchema (regression for existing call sites)', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.4',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [{
            id: 'call_schema',
            type: 'function',
            function: { name: 'extract_data', arguments: '{"value":42}' },
          }],
        },
      }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    });

    const provider = makeProvider({ chat: { completions: { create } } });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'extract' }],
      responseSchema: {
        name: 'extract_data',
        schema: { type: 'object', properties: { value: { type: 'number' } } },
      },
    });

    // The responseSchema path returns the raw JSON arguments string as `content`,
    // not the parsed object — that's the existing contract that 12+ call sites depend on.
    expect(result.content).toBe('{"value":42}');
    expect(result.toolCalls).toBeUndefined();
    expect(result.stopReason).toBeUndefined();

    // And the tool_choice should be forced to the schema's name.
    const callArgs = create.mock.calls[0][0];
    expect(callArgs.tool_choice).toEqual({ type: 'function', function: { name: 'extract_data' } });
  });
});

describe('OpenAIProvider.completeStream (Phase 4)', () => {
  it('emits text_delta events for streaming text content', async () => {
    const create = jest.fn().mockResolvedValue(fromChunks([
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ]));

    const provider = makeProvider({ chat: { completions: { create } } });
    const events: LLMStreamEvent[] = [];

    for await (const ev of provider.completeStream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'message_complete', model: expect.any(String), stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2, webSearchRequests: 0, webFetchRequests: undefined, cacheReadTokens: 0, contextTokens: 3 } },
    ]);
  });

  it('accumulates fragmented tool_call deltas into one tool_use event', async () => {
    const create = jest.fn().mockResolvedValue(fromChunks([
      // Chunk 1: tool call announced (id + name only, empty args)
      { choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_xyz',
            type: 'function',
            function: { name: 'get_cost', arguments: '' },
          }],
        },
        finish_reason: null,
      }] },
      // Chunk 2: arguments fragment
      { choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: '{"per' } }] },
        finish_reason: null,
      }] },
      // Chunk 3: arguments fragment
      { choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: 'iod":"week"}' } }] },
        finish_reason: null,
      }] },
      // Chunk 4: terminator
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      // Chunk 5: usage
      { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } },
    ]));

    const provider = makeProvider({ chat: { completions: { create } } });
    const events: LLMStreamEvent[] = [];

    for await (const ev of provider.completeStream({
      messages: [{ role: 'user', content: 'cost?' }],
      tools: [{
        name: 'get_cost',
        description: '',
        input_schema: { type: 'object', properties: { period: { type: 'string' } } },
      }],
    })) {
      events.push(ev);
    }

    const toolEvents = events.filter(e => e.type === 'tool_use');
    expect(toolEvents).toEqual([
      { type: 'tool_use', toolCall: { id: 'call_xyz', name: 'get_cost', input: { period: 'week' } } },
    ]);

    const last = events[events.length - 1];
    expect(last.type).toBe('message_complete');
    if (last.type === 'message_complete') {
      expect(last.stopReason).toBe('tool_use');
      expect(last.usage).toEqual({ inputTokens: 8, outputTokens: 4, webSearchRequests: 0, webFetchRequests: undefined, cacheReadTokens: 0, contextTokens: 8 });
    }
  });

  it('handles multiple parallel tool calls in deterministic order', async () => {
    const create = jest.fn().mockResolvedValue(fromChunks([
      { choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'foo', arguments: '{}' } },
            { index: 1, id: 'call_b', type: 'function', function: { name: 'bar', arguments: '{}' } },
          ],
        },
        finish_reason: null,
      }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ]));

    const provider = makeProvider({ chat: { completions: { create } } });
    const events: LLMStreamEvent[] = [];
    for await (const ev of provider.completeStream({
      messages: [{ role: 'user', content: 'do both' }],
      tools: [
        { name: 'foo', description: '', input_schema: { type: 'object', properties: {} } },
        { name: 'bar', description: '', input_schema: { type: 'object', properties: {} } },
      ],
    })) {
      events.push(ev);
    }

    const toolEvents = events.filter(e => e.type === 'tool_use');
    expect(toolEvents.map(e => e.type === 'tool_use' ? e.toolCall.name : null)).toEqual(['foo', 'bar']);
  });

  it('yields error event when create() throws before iteration', async () => {
    const create = jest.fn().mockRejectedValue(new Error('rate limited'));
    const provider = makeProvider({ chat: { completions: { create } } });

    const events: LLMStreamEvent[] = [];
    for await (const ev of provider.completeStream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(ev);
    }

    expect(events).toEqual([{ type: 'error', message: 'rate limited' }]);
  });

  it('yields error event when stream throws mid-iteration', async () => {
    async function* throwingStream(): AsyncIterable<unknown> {
      yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
      throw new Error('stream broke');
    }

    const create = jest.fn().mockResolvedValue(throwingStream());
    const provider = makeProvider({ chat: { completions: { create } } });

    const events: LLMStreamEvent[] = [];
    for await (const ev of provider.completeStream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'error', message: 'stream broke' },
    ]);
    // No message_complete after an error
    expect(events.find(e => e.type === 'message_complete')).toBeUndefined();
  });
});

describe('OpenAIProvider.complete multi-round tool use (Phase 6)', () => {
  it('emits assistant message with tool_calls field for per-message LLMMessage.toolCalls', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.4',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Based on the data, costs are up 10%.' },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    const provider = makeProvider({
      chat: { completions: { create } },
    } as unknown as OpenAI);

    await provider.complete({
      messages: [
        { role: 'user', content: 'How much did I spend?' },
        {
          role: 'assistant',
          content: 'Let me check.',
          toolCalls: [
            { id: 'call_abc', name: 'get_cost', input: { period: 'week' } },
          ],
        },
        {
          role: 'user',
          content: '',
          toolResults: [
            { toolCallId: 'call_abc', content: '{"totalUsd":123.45}' },
          ],
        },
      ],
      tools: [{
        name: 'get_cost',
        description: 'Get cost',
        input_schema: { type: 'object', properties: { period: { type: 'string' } } },
      }],
    });

    const sentMessages = create.mock.calls[0][0].messages;
    // Should have: user, assistant-with-tool-calls, tool-result (3 messages)
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[0]).toEqual({ role: 'user', content: 'How much did I spend?' });
    expect(sentMessages[1]).toMatchObject({
      role: 'assistant',
      content: 'Let me check.',
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'get_cost', arguments: '{"period":"week"}' },
        },
      ],
    });
    expect(sentMessages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_abc',
      content: '{"totalUsd":123.45}',
    });
  });

  it('still emits tool results from the legacy request.toolResults path (backwards compat)', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.4',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });

    const provider = makeProvider({
      chat: { completions: { create } },
    } as unknown as OpenAI);

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      toolResults: [
        { toolCallId: 'call_legacy', content: '{"ok":true}' },
      ],
    });

    const sentMessages = create.mock.calls[0][0].messages;
    expect(sentMessages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call_legacy',
      content: '{"ok":true}',
    });
  });
});

describe('OpenAIProvider — model tier resolution', () => {
  function makeOkResponse() {
    return {
      model: 'whatever',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  }

  it('uses tier model when tier is set and model is not', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProvider({ chat: { completions: { create } } } as unknown as OpenAI).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'small',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-luna' }));
  });

  it('uses medium tier mapping (gpt-6.1-sol)', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProvider({ chat: { completions: { create } } } as unknown as OpenAI).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'medium',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6.1-sol' }));
  });

  it('uses large tier mapping (gpt-6-astra)', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProvider({ chat: { completions: { create } } } as unknown as OpenAI).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'large',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-astra' }));
  });

  it('takes the tier map from the registry overlay when one is applied', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    const provider = makeProvider({ chat: { completions: { create } } } as unknown as OpenAI);
    // Per-INSTANCE overlay, so no cleanup is needed the way the module-level
    // providers need it — this instance is discarded with the test.
    provider.applyRegistryTierModels({ large: 'gpt-9-from-registry' });
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }], tier: 'large' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-9-from-registry' }),
    );
    // A tier the registry does not carry keeps its static seed value.
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }], tier: 'small' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-luna' }));
  });

  it('uses explicit model when both model and tier are set (model wins)', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProvider({ chat: { completions: { create } } } as unknown as OpenAI).complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-custom',
      tier: 'small',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-custom' }));
  });

  it('uses DEFAULT_MODEL when neither model nor tier is set', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProvider({ chat: { completions: { create } } } as unknown as OpenAI).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-astra' }));
  });

  it('propagates provider errors when tier-resolved model is invalid (no auto-fallback)', async () => {
    const create = jest.fn().mockRejectedValue(new Error('invalid model'));
    await expect(
      makeProvider({ chat: { completions: { create } } } as unknown as OpenAI).complete({
        messages: [{ role: 'user', content: 'hi' }],
        tier: 'small',
      }),
    ).rejects.toThrow('invalid model');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
