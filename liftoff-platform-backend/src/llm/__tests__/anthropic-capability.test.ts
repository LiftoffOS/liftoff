// Per-model capability tests for the Anthropic provider.
//
// Three properties, all of them "what actually goes on the wire for THIS model":
// `temperature` stripped for Opus 5 + 4.x and left alone elsewhere; a forced
// `tool_choice` translated to `auto` only where the vendor rejects it; and
// `output_config.effort` sent only where the model's surface states one.
//
// The surface table lives in providers/anthropic-shared.ts rather than in the
// provider file. It was lifted there when there were two Anthropic providers
// that had to answer identically; Claude over Google Vertex is now retired, so
// one provider reads it — and it stays shared because the instruction text it
// holds is model-facing and belongs in one place.
//
// This test does not call out to the SDK; it tests the local request-building
// logic only. SDK-level behavior (the API returning 400 if temperature, a
// forced tool choice, or an effort is sent to a model that rejects it) is
// verified end-to-end by post-deploy curl in the playbook, not here.

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from '../providers/anthropic';

jest.mock('../../infrastructure/secrets', () => ({
  getAnthropicApiKey: jest.fn().mockResolvedValue('test-key'),
  getAnthropicApiKeyForGroup: jest.fn().mockResolvedValue('test-key'),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const stream = jest.fn();
  const ctor = jest.fn().mockImplementation(() => ({
    messages: { create, stream },
  }));
  // Expose the mocks for assertions
  (ctor as unknown as Record<string, jest.Mock>).__create = create;
  (ctor as unknown as Record<string, jest.Mock>).__stream = stream;
  return { __esModule: true, default: ctor };
});

const cannedResponse = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-8',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe('Anthropic provider — temperature capability stripping', () => {
  let create: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
     
    create = (Anthropic as any).__create;
    create.mockResolvedValue(cannedResponse);
  });

  it('strips temperature when the resolved model is claude-opus-4-8', async () => {
    const provider = await AnthropicProvider.create();
    if (!provider) throw new Error('provider failed to initialize');

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-opus-4-8',
      temperature: 0.3,
      tools: [],
    });

    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0][0];
    expect(args).not.toHaveProperty('temperature');
    expect(args.model).toBe('claude-opus-4-8');
  });

  it('strips temperature when the resolved model is claude-opus-5', async () => {
    const provider = await AnthropicProvider.create();
    if (!provider) throw new Error('provider failed to initialize');

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-opus-5',
      temperature: 0.3,
      tools: [],
    });

    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0][0];
    expect(args).not.toHaveProperty('temperature');
    expect(args.model).toBe('claude-opus-5');
  });

  it('strips temperature when the resolved model is claude-opus-4-7', async () => {
    const provider = await AnthropicProvider.create();
    if (!provider) throw new Error('provider failed to initialize');

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-opus-4-7',
      temperature: 0.5,
      tools: [],
    });

    const args = create.mock.calls[0][0];
    expect(args).not.toHaveProperty('temperature');
  });

  it('strips temperature when the resolved model is claude-sonnet-5', async () => {
    const provider = await AnthropicProvider.create();
    if (!provider) throw new Error('provider failed to initialize');

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-sonnet-5',
      temperature: 0.4,
      tools: [],
    });

    const args = create.mock.calls[0][0];
    expect(args).not.toHaveProperty('temperature');
    expect(args.model).toBe('claude-sonnet-5');
  });

  it('passes temperature through for claude-sonnet-4-6', async () => {
    const provider = await AnthropicProvider.create();
    if (!provider) throw new Error('provider failed to initialize');

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-sonnet-4-6',
      temperature: 0.7,
      tools: [],
    });

    const args = create.mock.calls[0][0];
    expect(args.temperature).toBe(0.7);
  });

  it('passes temperature through for claude-haiku-4-5', async () => {
    const provider = await AnthropicProvider.create();
    if (!provider) throw new Error('provider failed to initialize');

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-haiku-4-5',
      temperature: 1.0,
      tools: [],
    });

    const args = create.mock.calls[0][0];
    expect(args.temperature).toBe(1.0);
  });

  it('strips temperature on the responseSchema (tool-use) path too', async () => {
    const provider = await AnthropicProvider.create();
    if (!provider) throw new Error('provider failed to initialize');

    create.mockResolvedValueOnce({
      ...cannedResponse,
      content: [
        { type: 'tool_use', id: 't1', name: 'produce_agent', input: { ok: true } },
      ],
    });

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-opus-4-8',
      temperature: 0.3,
      responseSchema: {
        name: 'produce_agent',
        description: 'test schema',
        // `maxLength` is rejected by the constrained decoder, so this schema
        // CANNOT use structured outputs and falls back to the tool route —
        // which is the route this test is about. That is the real shape of
        // produce_agent too, which uses maxLength throughout.
        schema: { type: 'object', properties: { s: { type: 'string', maxLength: 10 } } },
      },
    });

    const args = create.mock.calls[0][0];
    expect(args).not.toHaveProperty('temperature');
    expect(args.tools?.[0]?.name).toBe('produce_agent');
    expect(args.output_config?.format).toBeUndefined();
  });

  it('leaves the args unchanged when temperature is undefined (no strip needed)', async () => {
    const provider = await AnthropicProvider.create();
    if (!provider) throw new Error('provider failed to initialize');

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-opus-4-8',
      // no temperature set on the request
      tools: [],
    });

    // The provider passes `temperature: request.temperature` to the SDK; when
    // the request didn't set one, that's `temperature: undefined`. dropUnsupportedParams
    // only strips when temperature !== undefined, so the args object still
    // carries the key with an undefined value — which the SDK serializes
    // away at JSON-encoding time. Verify the value is undefined rather than
    // any unexpected coerced value.
    const args = create.mock.calls[0][0];
    expect(args.temperature).toBeUndefined();
    expect(args.model).toBe('claude-opus-4-8');
  });
});

// ── Opus 5.5: forced tool choice, and the effort control ───────────────────
//
// Two vendor changes land together on this model and both fail LOUDLY if we get
// them wrong, in opposite directions:
//
//   * `tool_choice` `any` / `tool` now return 400. Every forced selection in
//     this estate — distillation, the A/B judge, every responseSchema call —
//     would fail on the first request. The translation to `auto` keeps the
//     caller's intent as an instruction on `system`.
//   * `output_config.effort` defaults to `medium` here where Opus 5's default
//     was `high`, so an unset effort silently buys less thinking than the model
//     it replaces. It is pinned back to `high`.
//
// The `output_config` assertions matter in BOTH directions. The parameter is
// rejected outright by models that predate it — Haiku 4.5 and Sonnet 4.5 return
// 400 — and Haiku is what the `small` tier resolves to, which is the busiest
// path here. So "no output_config unless the model's surface states one" is a
// property, not an implementation detail.

const A_TOOL = [{
  name: 'record_verdict',
  description: 'Record the verdict.',
  input_schema: { type: 'object' as const, properties: { picked: { type: 'string' as const } } },
}];

describe('Anthropic provider — Opus 5.5 tool choice and effort', () => {
  let create: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    create = (Anthropic as unknown as Record<string, jest.Mock>).__create;
    create.mockResolvedValue(cannedResponse);
  });

  async function callWith(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const provider = await AnthropicProvider.create();
    if (!provider) throw new Error('provider failed to initialize');
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: A_TOOL,
      ...request,
    } as Parameters<NonNullable<typeof provider>['complete']>[0]);
    expect(create).toHaveBeenCalledTimes(1);
    return create.mock.calls[0][0];
  }

  it('translates a NAMED forced tool to auto and says so in the system prompt', async () => {
    const args = await callWith({ model: 'claude-opus-5-5', toolChoice: { name: 'record_verdict' } });

    expect(args.tool_choice).toEqual({ type: 'auto' });
    expect(JSON.stringify(args.system)).toContain('must call the record_verdict tool');
  });

  it('translates a REQUIRED tool choice to auto', async () => {
    const args = await callWith({ model: 'claude-opus-5-5', toolChoice: 'required' });

    expect(args.tool_choice).toEqual({ type: 'auto' });
    expect(JSON.stringify(args.system)).toContain('must call one of the available tools');
  });

  it("leaves 'none' alone — only any/tool are rejected by the vendor", async () => {
    const args = await callWith({ model: 'claude-opus-5-5', toolChoice: 'none' });

    expect(args.tool_choice).toEqual({ type: 'none' });
    expect(JSON.stringify(args.system ?? '')).not.toContain('must call');
  });

  it('pins effort to high on Opus 5.5, whose vendor default is medium', async () => {
    const args = await callWith({ model: 'claude-opus-5-5' });

    expect(args.output_config).toEqual({ effort: 'high' });
  });

  it('lets an explicit caller effort win over the model default', async () => {
    const args = await callWith({ model: 'claude-opus-5-5', effort: 'low' });

    expect(args.output_config).toEqual({ effort: 'low' });
  });

  it('leaves a forced tool choice UNTOUCHED on Opus 5, which still accepts it', async () => {
    const args = await callWith({ model: 'claude-opus-5', toolChoice: { name: 'record_verdict' } });

    expect(args.tool_choice).toEqual({ type: 'tool', name: 'record_verdict' });
    expect(JSON.stringify(args.system ?? '')).not.toContain('must call');
  });

  it('sends NO output_config for a model with no stated effort (Opus 5)', async () => {
    const args = await callWith({ model: 'claude-opus-5' });

    expect(args).not.toHaveProperty('output_config');
  });

  it('sends NO output_config for claude-haiku-4-5, which 400s on effort', async () => {
    const args = await callWith({ model: 'claude-haiku-4-5' });

    expect(args).not.toHaveProperty('output_config');
  });

  it('translates a forced tool choice on Sonnet 5.5, the medium tier', async () => {
    // The same vendor removal as Opus 5.5, now on the busiest tier. Every
    // forced selection here — distillation, the A/B judge, every responseSchema
    // caller that falls off the structured-outputs route — would 400 on its
    // first request without the translation.
    const args = await callWith({ model: 'claude-sonnet-5-5', toolChoice: { name: 'record_verdict' } });

    expect(args.tool_choice).toEqual({ type: 'auto' });
    expect(JSON.stringify(args.system)).toContain('must call the record_verdict tool');
  });

  it('leaves a forced tool choice UNTOUCHED on Sonnet 5, which still accepts it', async () => {
    const args = await callWith({ model: 'claude-sonnet-5', toolChoice: { name: 'record_verdict' } });

    expect(args.tool_choice).toEqual({ type: 'tool', name: 'record_verdict' });
  });

  it('sends NO output_config for Sonnet 5.5, whose vendor default is already high', async () => {
    const args = await callWith({ model: 'claude-sonnet-5-5' });

    expect(args).not.toHaveProperty('output_config');
  });

  it('strips temperature on Sonnet 5.5, which rejects a non-default value', async () => {
    const args = await callWith({ model: 'claude-sonnet-5-5', temperature: 0.7 });

    expect(args.temperature).toBeUndefined();
  });

  it('sends NO thinking on a non-streamed Sonnet 5.5 call', async () => {
    // between_tools is asked for only where a person reads the stream. It also
    // turns OFF up-front thinking, so sending it here would trade reasoning
    // depth for a narration nobody is watching — a behaviour change for no
    // benefit. complete() stays adaptive, exactly as it is on Sonnet 5.
    const args = await callWith({ model: 'claude-sonnet-5-5' });

    expect(args).not.toHaveProperty('thinking');
  });

  it('never adds strict, and keeps one the caller set', async () => {
    const plain = await callWith({ model: 'claude-opus-5-5', toolChoice: { name: 'record_verdict' } });
    expect((plain.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty('strict');

    jest.clearAllMocks();
    create.mockResolvedValue(cannedResponse);

    const strict = await callWith({
      model: 'claude-opus-5-5',
      toolChoice: { name: 'record_verdict' },
      tools: [{ ...A_TOOL[0], strict: true }],
    });
    expect((strict.tools as Array<Record<string, unknown>>)[0].strict).toBe(true);
  });
});
