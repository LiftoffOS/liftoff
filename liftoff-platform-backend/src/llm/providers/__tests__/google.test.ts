// GoogleProvider tests — covers tool-use normalization and streaming.
//
// We bypass the static `create()` factory and construct the provider directly
// with a stub VertexAI surface. The stub returns canned responses shaped
// exactly like what the @google-cloud/vertexai SDK would return.

import { GoogleProvider } from '../google';
import type { LLMStreamEvent } from '../../types';

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Construct the provider directly via the private 2-arg constructor. */
function makeProvider(vertexAI: unknown): GoogleProvider {
  const Ctor = GoogleProvider as unknown as new (vertexAI: unknown, projectId: string) => GoogleProvider;
  return new Ctor(vertexAI, 'test-project');
}

async function* fromChunks<T>(chunks: T[]): AsyncIterable<T> {
  for (const c of chunks) yield c;
}

/** Build a fake VertexAI whose getGenerativeModel returns a model that
 *  responds with the given canned data. Two-call paths supported:
 *  - generateContent (non-streaming)
 *  - generateContentStream */
function buildVertexStub(opts: {
  generateContent?: jest.Mock;
  generateContentStream?: jest.Mock;
}) {
  const getGenerativeModel = jest.fn().mockReturnValue({
    generateContent: opts.generateContent ?? jest.fn(),
    generateContentStream: opts.generateContentStream ?? jest.fn(),
    // The responseSchema path uses startChat → sendMessage; left unused here.
    startChat: jest.fn(),
  });
  return { getGenerativeModel };
}

describe('GoogleProvider.complete with tools (Phase 4)', () => {
  it('normalizes functionCall parts into LLMToolCall[] with synthesized ids', async () => {
    const generateContent = jest.fn().mockResolvedValue({
      response: {
        candidates: [{
          content: {
            parts: [
              { text: 'Looking it up' },
              { functionCall: { name: 'get_cost', args: { period: 'week' } } },
            ],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });

    const provider = makeProvider(buildVertexStub({ generateContent }));

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'cost?' }],
      tools: [{
        name: 'get_cost',
        description: 'Get cost',
        input_schema: { type: 'object', properties: { period: { type: 'string' } } },
      }],
    });

    expect(result.content).toBe('Looking it up');
    expect(result.toolCalls).toEqual([
      // index 1 because the text part is at index 0
      { id: 'get_cost-1', name: 'get_cost', input: { period: 'week' } },
    ]);
    // hasToolCalls is true → stopReason inferred as 'tool_use' even though Gemini said STOP
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, webSearchRequests: 0, webFetchRequests: 0, cacheReadTokens: 0, contextTokens: 10 });
  });

  it('coerces proto-like args via JSON round-trip', async () => {
    // Simulate a Struct-like object where JSON.stringify still produces a plain object.
    const fakeProtoArgs = Object.create(null);
    Object.assign(fakeProtoArgs, { period: 'week', limit: 5 });

    const generateContent = jest.fn().mockResolvedValue({
      response: {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'get_cost', args: fakeProtoArgs } }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      },
    });

    const provider = makeProvider(buildVertexStub({ generateContent }));
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'cost?' }],
      tools: [{ name: 'get_cost', description: '', input_schema: { type: 'object', properties: {} } }],
    });

    expect(result.toolCalls?.[0]?.input).toEqual({ period: 'week', limit: 5 });
  });

  it.each([
    ['STOP', false, 'end_turn'],
    ['STOP', true, 'tool_use'],
    ['MAX_TOKENS', false, 'max_tokens'],
    ['OTHER', false, 'end_turn'],
    [undefined, false, 'end_turn'],
  ])('maps finishReason %s (hasToolCalls=%s) → %s', async (finishReason, withTool, expected) => {
    const parts = withTool
      ? [{ functionCall: { name: 'foo', args: {} } }]
      : [{ text: 'hi' }];

    const generateContent = jest.fn().mockResolvedValue({
      response: {
        candidates: [{ content: { parts }, finishReason }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      },
    });

    const provider = makeProvider(buildVertexStub({ generateContent }));
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: withTool
        ? [{ name: 'foo', description: '', input_schema: { type: 'object', properties: {} } }]
        : undefined,
    });

    expect(result.stopReason).toBe(expected);
  });

  it('round-trips toolResults as functionResponse parts in a user-role Content', async () => {
    const generateContent = jest.fn().mockResolvedValue({
      response: {
        candidates: [{
          content: { parts: [{ text: 'done' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
      },
    });

    const provider = makeProvider(buildVertexStub({ generateContent }));

    await provider.complete({
      messages: [
        { role: 'user', content: 'cost?' },
        { role: 'assistant', content: 'checking...' },
      ],
      toolResults: [
        // The id matches what we synthesize: ${name}-${index}
        { toolCallId: 'get_cost-1', content: '{"total":42}' },
      ],
    });

    const sentContents = generateContent.mock.calls[0][0].contents;
    // Last entry should be the user-role Content with a functionResponse part.
    const last = sentContents[sentContents.length - 1];
    expect(last.role).toBe('user');
    expect(last.parts).toEqual([
      {
        functionResponse: {
          name: 'get_cost',
          response: { content: { total: 42 } },
        },
      },
    ]);
  });

  it('still works with responseSchema (regression for existing call sites)', async () => {
    const sendMessage = jest.fn().mockResolvedValue({
      response: {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'extract', args: { value: 42 } } }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      },
    });
    const startChat = jest.fn().mockReturnValue({ sendMessage });
    const getGenerativeModel = jest.fn().mockReturnValue({ startChat });

    const provider = makeProvider({ getGenerativeModel });

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'extract' }],
      responseSchema: {
        name: 'extract',
        schema: { type: 'object', properties: { value: { type: 'number' } } },
      },
    });

    // The existing contract: content is the JSON-stringified args, no toolCalls.
    expect(result.content).toBe('{"value":42}');
    expect(result.toolCalls).toBeUndefined();
    expect(result.stopReason).toBeUndefined();
  });
});

describe('GoogleProvider.completeStream (Phase 4)', () => {
  it('emits text_delta events for streaming text', async () => {
    const generateContentStream = jest.fn().mockResolvedValue({
      stream: fromChunks([
        {
          candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: undefined }],
        },
        {
          candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
        },
      ]),
    });

    const provider = makeProvider(buildVertexStub({ generateContentStream }));
    const events: LLMStreamEvent[] = [];

    for await (const ev of provider.completeStream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'message_complete', model: expect.any(String), stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2, webSearchRequests: 0, webFetchRequests: 0, cacheReadTokens: 0, contextTokens: 3 } },
    ]);
  });

  it('emits tool_use events for functionCall parts and infers tool_use stopReason', async () => {
    const generateContentStream = jest.fn().mockResolvedValue({
      stream: fromChunks([
        {
          candidates: [{
            content: {
              parts: [
                { text: 'Let me check' },
                { functionCall: { name: 'get_cost', args: { period: 'week' } } },
              ],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
        },
      ]),
    });

    const provider = makeProvider(buildVertexStub({ generateContentStream }));
    const events: LLMStreamEvent[] = [];

    for await (const ev of provider.completeStream({
      messages: [{ role: 'user', content: 'cost?' }],
      tools: [{ name: 'get_cost', description: '', input_schema: { type: 'object', properties: {} } }],
    })) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: 'text_delta', text: 'Let me check' },
      { type: 'tool_use', toolCall: { id: 'get_cost-0', name: 'get_cost', input: { period: 'week' } } },
      { type: 'message_complete', model: expect.any(String), stopReason: 'tool_use', usage: { inputTokens: 8, outputTokens: 4, webSearchRequests: 0, webFetchRequests: 0, cacheReadTokens: 0, contextTokens: 8 } },
    ]);
  });

  it('yields error event when generateContentStream() throws', async () => {
    const generateContentStream = jest.fn().mockRejectedValue(new Error('quota exceeded'));
    const provider = makeProvider(buildVertexStub({ generateContentStream }));

    const events: LLMStreamEvent[] = [];
    for await (const ev of provider.completeStream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(ev);
    }

    expect(events).toEqual([{ type: 'error', message: 'quota exceeded' }]);
  });

  it('yields error event when stream throws mid-iteration', async () => {
    async function* throwingStream(): AsyncIterable<unknown> {
      yield {
        candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: undefined }],
      };
      throw new Error('stream broke');
    }

    const generateContentStream = jest.fn().mockResolvedValue({ stream: throwingStream() });
    const provider = makeProvider(buildVertexStub({ generateContentStream }));

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
    expect(events.find(e => e.type === 'message_complete')).toBeUndefined();
  });
});

describe('GoogleProvider.complete multi-round tool use (Phase 6)', () => {
  it('emits model turn with text + functionCall parts for per-message LLMMessage.toolCalls', async () => {
    const generateContent = jest.fn().mockResolvedValue({
      response: {
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: 'Final answer.' }] },
        }],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10 },
      },
    });
    const getGenerativeModel = jest.fn().mockReturnValue({ generateContent });

    const provider = makeProvider({ getGenerativeModel });

    await provider.complete({
      messages: [
        { role: 'user', content: 'How much did I spend?' },
        {
          role: 'assistant',
          content: 'Let me check.',
          // Gemini uses synthesized ids; the chat service reuses the same pattern.
          toolCalls: [
            { id: 'get_cost-0', name: 'get_cost', input: { period: 'week' } },
          ],
        },
        {
          role: 'user',
          content: '',
          toolResults: [
            { toolCallId: 'get_cost-0', content: '{"totalUsd":123.45}' },
          ],
        },
      ],
      tools: [{
        name: 'get_cost',
        description: 'Get cost',
        input_schema: { type: 'object', properties: { period: { type: 'string' } } },
      }],
    });

    const sentContents = generateContent.mock.calls[0][0].contents;
    expect(sentContents).toHaveLength(3);

    // User turn unchanged
    expect(sentContents[0]).toEqual({
      role: 'user',
      parts: [{ text: 'How much did I spend?' }],
    });

    // Model turn with text + functionCall
    expect(sentContents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Let me check.' },
        { functionCall: { name: 'get_cost', args: { period: 'week' } } },
      ],
    });

    // Tool result as user turn with functionResponse
    expect(sentContents[2]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'get_cost',
            response: { content: { totalUsd: 123.45 } },
          },
        },
      ],
    });
  });
});

describe('GoogleProvider — model tier resolution', () => {
  function buildOkStub() {
    const generateContent = jest.fn().mockResolvedValue({
      response: {
        candidates: [{
          content: { parts: [{ text: 'hi' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      },
    });
    const getGenerativeModel = jest.fn().mockReturnValue({
      generateContent,
      generateContentStream: jest.fn(),
      startChat: jest.fn(),
    });
    return { vertexAI: { getGenerativeModel }, getGenerativeModel };
  }

  it('uses tier model when tier is set and model is not', async () => {
    const { vertexAI, getGenerativeModel } = buildOkStub();
    await makeProvider(vertexAI).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'small',
    });
    expect(getGenerativeModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3.1-flash-lite' }));
  });

  it('uses medium tier mapping (gemini-3.5-flash)', async () => {
    const { vertexAI, getGenerativeModel } = buildOkStub();
    await makeProvider(vertexAI).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'medium',
    });
    expect(getGenerativeModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3.5-flash' }));
  });

  it('uses large tier mapping (gemini-3.1-pro-preview)', async () => {
    const { vertexAI, getGenerativeModel } = buildOkStub();
    await makeProvider(vertexAI).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'large',
    });
    expect(getGenerativeModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3.1-pro-preview' }));
  });

  it('uses explicit model when both model and tier are set (model wins)', async () => {
    const { vertexAI, getGenerativeModel } = buildOkStub();
    await makeProvider(vertexAI).complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gemini-custom',
      tier: 'small',
    });
    expect(getGenerativeModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-custom' }));
  });

  it('uses DEFAULT_MODEL when neither model nor tier is set', async () => {
    const { vertexAI, getGenerativeModel } = buildOkStub();
    await makeProvider(vertexAI).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(getGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-3.1-pro-preview' }),
    );
  });

  it('takes the tier map from the registry overlay when one is applied', async () => {
    const { vertexAI, getGenerativeModel } = buildOkStub();
    const provider = makeProvider(vertexAI);
    try {
      provider.applyRegistryTierModels({ medium: 'gemini-9-flash-from-registry' });
      await provider.complete({ messages: [{ role: 'user', content: 'hi' }], tier: 'medium' });
      expect(getGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-9-flash-from-registry' }),
      );
      // A tier the registry does not carry keeps its static seed value.
      await provider.complete({ messages: [{ role: 'user', content: 'hi' }], tier: 'small' });
      expect(getGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-3.1-flash-lite' }),
      );
    } finally {
      // Module-level state: leaving it overlaid would leak into the tests below.
      provider.applyRegistryTierModels({});
    }
  });

  it('propagates provider errors when tier-resolved model is invalid (no auto-fallback)', async () => {
    const generateContent = jest.fn().mockRejectedValue(new Error('invalid model'));
    const getGenerativeModel = jest.fn().mockReturnValue({
      generateContent,
      generateContentStream: jest.fn(),
      startChat: jest.fn(),
    });
    await expect(
      makeProvider({ getGenerativeModel }).complete({
        messages: [{ role: 'user', content: 'hi' }],
        tier: 'small',
      }),
    ).rejects.toThrow('invalid model');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

// Gemini takes a declaration with nothing to pass only WITHOUT `parameters`
// (it rejects an OBJECT schema whose properties are empty), and a closing
// call that forbids tools says so with FunctionCallingMode NONE.
describe('GoogleProvider tool declarations and tool choice', () => {
  it('omits `parameters` for a tool with no properties, and keeps them for one that has some', async () => {
    const generateContent = jest.fn().mockResolvedValue({
      response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    });
    const stub = buildVertexStub({ generateContent });
    const provider = makeProvider(stub);
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'dataset_list', description: 'List', input_schema: { type: 'object', properties: {} } },
        { name: 'dataset_query', description: 'Read', input_schema: { type: 'object', properties: { datasetId: { type: 'string' } } } },
      ],
    });
    const declarations = stub.getGenerativeModel.mock.calls[0][0].tools[0].functionDeclarations;
    expect(declarations[0]).toEqual({ name: 'dataset_list', description: 'List' });
    expect(declarations[1].parameters).toEqual({ type: 'object', properties: { datasetId: { type: 'string' } } });
  });

  it('maps toolChoice none to FunctionCallingMode NONE with the tools still declared', async () => {
    const generateContent = jest.fn().mockResolvedValue({
      response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    });
    const stub = buildVertexStub({ generateContent });
    const provider = makeProvider(stub);
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'dataset_query', description: 'Read', input_schema: { type: 'object', properties: { datasetId: { type: 'string' } } } }],
      toolChoice: 'none',
    });
    const params = stub.getGenerativeModel.mock.calls[0][0];
    expect(params.toolConfig.functionCallingConfig).toEqual({ mode: 'NONE' });
    expect(params.tools[0].functionDeclarations).toHaveLength(1);
  });
});
