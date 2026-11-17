// AnthropicProvider tests.
//
// This file used to assert PARITY between two providers — the direct SDK and
// Claude over Google Vertex — because they wrapped the same SDK shape with
// different transports and someone updating one (a new content-block type in
// the streaming switch, say) would forget the other. That second provider is
// retired, so the parity assertions would now compare a provider with itself.
// They are deleted rather than left green: a test that asserts nothing is
// worse than no test, because it reads like coverage.
//
// What remains is what the fixtures can still prove of the one provider: it
// normalizes a canned complete() and stream() as expected, and reports its own
// provider name. Cross-provider normalization is covered by
// provider-parity.test.ts, which spans all five.

import { AnthropicProvider } from '../anthropic';
import {
  runProviderCompleteFixture,
  runProviderStreamFixture,
} from './fixtures/anthropic-tool-fixture';

jest.mock('../../../infrastructure/secrets', () => ({
  getAnthropicApiKey: jest.fn().mockResolvedValue('test-key'),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('AnthropicProvider — fixture normalization', () => {
  it('complete() normalizes the canned tool-use fixture', async () => {
    const result = await runProviderCompleteFixture(AnthropicProvider);

    expect(result.provider).toBe('anthropic');
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_01', name: 'get_cost', input: { period: 'week' } },
    ]);
  });

  it('completeStream() yields the normalized event sequence', async () => {
    const events = await runProviderStreamFixture(AnthropicProvider);

    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: 'message_complete' });
  });
});

describe('AnthropicProvider — responseSchema takes the better of two routes', () => {
  function providerWith(create: jest.Mock): AnthropicProvider {
    const Ctor = AnthropicProvider as unknown as new (client: unknown) => AnthropicProvider;
    return new Ctor({ messages: { create } });
  }

  it('uses structured outputs when the model and the schema both allow it', async () => {
    // The constrained decode returns the JSON as TEXT — there is no tool to
    // unwrap, which is the point: the guarantee is in the decoder rather than
    // in the model choosing to call something.
    const create = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"value":42}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
      model: 'claude-opus-5-5',
    });

    const result = await providerWith(create).complete({
      messages: [{ role: 'user', content: 'extract' }],
      responseSchema: {
        name: 'extract',
        schema: { type: 'object', properties: { value: { type: 'number' } } },
      },
    });

    const args = create.mock.calls[0][0];
    expect(args.output_config.format.type).toBe('json_schema');
    // Closed objects are required by the vendor and written by no caller.
    expect(args.output_config.format.schema.additionalProperties).toBe(false);
    expect(args.tools).toBeUndefined();

    expect(result.content).toBe('{"value":42}');
    expect(result.toolCalls).toBeUndefined();
    expect(result.provider).toBe('anthropic');
  });

  it('falls back to the forced-tool route when the schema cannot be constrained', async () => {
    // `maxLength` is outside the decoder's subset. Falling back is the whole
    // reason the check is a whitelist: an unvetted keyword costs one
    // unnecessary fallback, never a rejected request.
    const create = jest.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'extract', input: { value: 42 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
      model: 'claude-opus-5-5',
    });

    const result = await providerWith(create).complete({
      messages: [{ role: 'user', content: 'extract' }],
      responseSchema: {
        name: 'extract',
        schema: { type: 'object', properties: { value: { type: 'string', maxLength: 5 } } },
      },
    });

    const args = create.mock.calls[0][0];
    expect(args.output_config?.format).toBeUndefined();
    expect(args.tools[0].name).toBe('extract');
    expect(result.content).toBe('{"value":42}');
  });

  it('falls back on a model that does not support structured outputs', async () => {
    const create = jest.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'extract', input: { value: 42 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
      model: 'claude-haiku-4-5',
    });

    await providerWith(create).complete({
      messages: [{ role: 'user', content: 'extract' }],
      model: 'claude-haiku-4-5',
      responseSchema: {
        name: 'extract',
        schema: { type: 'object', properties: { value: { type: 'number' } } },
      },
    });

    const args = create.mock.calls[0][0];
    expect(args.output_config?.format).toBeUndefined();
    expect(args.tools[0].name).toBe('extract');
  });
});

describe('AnthropicProvider — prompt caching (Option 1)', () => {
  function makeProvider(create: jest.Mock): AnthropicProvider {
    const Ctor = AnthropicProvider as unknown as new (client: unknown) => AnthropicProvider;
    return new Ctor({ messages: { create } });
  }

  function makeOkResponse(usageOverrides?: Record<string, number>) {
    return {
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 3, ...usageOverrides },
      model: 'claude-opus-4-6',
    };
  }

  it('sends system as a content-block array when cacheControl is set', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProvider(create).complete({
      messages: [
        { role: 'system', content: 'You are helpful.', cacheControl: { type: 'ephemeral' } },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      system: [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }],
    }));
  });

  it('sends system as a plain string when cacheControl is absent', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProvider(create).complete({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      system: 'You are helpful.',
    }));
  });

  it('spreads cache_control only onto tools that have cacheControl set', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProvider(create).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'tool_a', description: 'First', input_schema: { type: 'object', properties: {} } },
        { name: 'tool_b', description: 'Last', input_schema: { type: 'object', properties: {} }, cacheControl: { type: 'ephemeral' } },
      ],
    });
    const sentTools = create.mock.calls[0][0].tools;
    expect(sentTools[0].cache_control).toBeUndefined();
    expect(sentTools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('puts a user-turn cacheControl on that message\'s LAST content block', async () => {
    // The distiller marks its first user message: the one carrying the tool
    // catalog, byte-identical on every retry. The cached prefix runs up to and
    // including the marked block, so the mark has to sit on the LAST block of
    // that message or the rest of it falls outside the cache.
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProvider(create).complete({
      messages: [
        { role: 'system', content: 'You are helpful.', cacheControl: { type: 'ephemeral' } },
        { role: 'user', content: 'the catalog', cacheControl: { type: 'ephemeral' } },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'the correction' },
      ],
    });
    const sent = create.mock.calls[0][0].messages;
    expect(sent[0].role).toBe('user');
    const blocks = sent[0].content;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[blocks.length - 1]).toEqual({
      type: 'text', text: 'the catalog', cache_control: { type: 'ephemeral' },
    });
    // Only the marked turn carries it.
    expect(JSON.stringify(sent[1])).not.toContain('cache_control');
    expect(JSON.stringify(sent[2])).not.toContain('cache_control');
  });

  it('returns cacheWriteTokens on a cache write (first call)', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse({
      cache_creation_input_tokens: 80,
      cache_read_input_tokens: 0,
    }));
    const result = await makeProvider(create).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.usage?.cacheWriteTokens).toBe(80);
    expect(result.usage?.cacheReadTokens).toBe(0);
  });

  it('returns cacheReadTokens > 0 on a cache hit (subsequent call)', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse({
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 80,
    }));
    const result = await makeProvider(create).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.usage?.cacheWriteTokens).toBe(0);
    expect(result.usage?.cacheReadTokens).toBe(80);
  });
});

describe('AnthropicProvider — model tier resolution', () => {
  function makeProviderWith(create: jest.Mock): AnthropicProvider {
    const Ctor = AnthropicProvider as unknown as new (client: unknown) => AnthropicProvider;
    return new Ctor({ messages: { create } });
  }

  function makeOkResponse() {
    return {
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'whatever',
    };
  }

  it('uses tier model when tier is set and model is not', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProviderWith(create).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'small',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-haiku-5-5' }));
  });

  it('uses medium tier mapping (claude-sonnet-5-5)', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProviderWith(create).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'medium',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5-5' }));
  });

  it('uses large tier mapping (claude-opus-5-5)', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProviderWith(create).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'large',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5-5' }));
  });

  it('uses explicit model when both model and tier are set (model wins)', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProviderWith(create).complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-custom-id',
      tier: 'small',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-custom-id' }));
  });

  it('uses DEFAULT_MODEL when neither model nor tier is set', async () => {
    const create = jest.fn().mockResolvedValue(makeOkResponse());
    await makeProviderWith(create).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5-5' }));
  });

  it('propagates provider errors when tier-resolved model is invalid (no auto-fallback)', async () => {
    const create = jest.fn().mockRejectedValue(new Error('invalid model'));
    await expect(
      makeProviderWith(create).complete({
        messages: [{ role: 'user', content: 'hi' }],
        tier: 'small',
      }),
    ).rejects.toThrow('invalid model');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// ── Sonnet 5.5 moved between-tool prose into thinking blocks ───────────────
//
// This is the change that breaks a streaming assistant WITHOUT breaking a
// request. From Sonnet 5.5 onward, prose the model writes between tool calls
// comes back in `thinking` blocks rather than `text` blocks, and at the default
// display those blocks carry no text at all. Nothing errors. The final answer is
// unaffected. The only symptom is that a person watching a multi-tool turn — the
// three platform assistants all stream one — sees nothing until the turn ends.
//
// `between_tools` is the setting that returns those notes readably, so the
// provider asks for it on the streaming path and forwards the notes as ordinary
// text. The gate is what keeps that safe: with `between_tools` a thinking block
// is a progress note written for the reader; WITHOUT it a thinking block is
// reasoning, which may never reach a person. Both directions are asserted here,
// because a mapping that forwarded reasoning would be a worse defect than the
// silence it was meant to fix.
describe('AnthropicProvider — between_tools and the notes it returns', () => {
  function streamingProviderWith(stream: jest.Mock): AnthropicProvider {
    const Ctor = AnthropicProvider as unknown as new (client: unknown) => AnthropicProvider;
    return new Ctor({ messages: { stream } });
  }

  /** A turn that writes a note and stops — the shape that goes quiet on Sonnet
   *  5.5 when the thinking block is dropped. */
  function noteStream(): jest.Mock {
    return jest.fn().mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'message_start',
          message: { usage: { input_tokens: 10, output_tokens: 0 } },
        };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } };
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Checking the invoice totals next.' },
        };
        yield { type: 'content_block_stop', index: 0 };
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 7 },
        };
        yield { type: 'message_stop' };
      },
    }));
  }

  async function drain(
    provider: AnthropicProvider,
    request: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = [];
    for await (const event of provider.completeStream({
      messages: [{ role: 'user', content: 'hi' }],
      ...request,
    } as Parameters<AnthropicProvider['completeStream']>[0])) {
      events.push(event as unknown as Record<string, unknown>);
    }
    return events;
  }

  it('asks for between_tools when streaming Sonnet 5.5', async () => {
    const stream = noteStream();
    await drain(streamingProviderWith(stream), { model: 'claude-sonnet-5-5' });

    expect(stream.mock.calls[0][0].thinking).toEqual({ type: 'between_tools' });
  });

  it('forwards the note as text, so the stream does not go quiet', async () => {
    const stream = noteStream();
    const events = await drain(streamingProviderWith(stream), { model: 'claude-sonnet-5-5' });

    expect(events).toEqual(expect.arrayContaining([
      { type: 'text_delta', text: 'Checking the invoice totals next.' },
    ]));
  });

  it('asks for nothing on Sonnet 5, which still returns that prose as text', async () => {
    const stream = noteStream();
    await drain(streamingProviderWith(stream), { model: 'claude-sonnet-5' });

    expect(stream.mock.calls[0][0]).not.toHaveProperty('thinking');
  });

  it('DROPS a thinking block on a model that was not asked for between_tools', async () => {
    // The safety half. Under adaptive thinking these blocks are reasoning, and
    // forwarding them would stream a model's inner workings to a person.
    const stream = noteStream();
    const events = await drain(streamingProviderWith(stream), { model: 'claude-sonnet-5' });

    expect(events.some((e) => e.type === 'text_delta')).toBe(false);
  });

  it('omits between_tools when a caller asks for max effort, which would 400', async () => {
    // The vendor rejects between_tools above `high`. A caller asking for maximum
    // reasoning gets it; the narration is what yields, not the request.
    const stream = noteStream();
    await drain(streamingProviderWith(stream), { model: 'claude-sonnet-5-5', effort: 'max' });

    expect(stream.mock.calls[0][0]).not.toHaveProperty('thinking');
    expect(stream.mock.calls[0][0].output_config).toEqual({ effort: 'max' });
  });
});
