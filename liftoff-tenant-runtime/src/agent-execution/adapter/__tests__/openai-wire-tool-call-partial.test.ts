// Tool arguments stream as fragments on the OpenAI wire too, and a consumer
// reassembles them exactly as it does the Claude adapter's.
//
// The Agents SDK's typed union has no argument delta, but it forwards every
// raw provider event through its generic `model` member, and both wire
// shapes stream arguments there by INDEX: the Responses API announces a
// function call at an `output_index` and then sends
// `response.function_call_arguments.delta` events; Chat Completions chunks
// carry `delta.tool_calls[]` entries whose first names the call and whose
// rest carry fragments. The correlator binds index to call id, and the
// adapter emits `tool_call_partial` — so the stream contract is the same event
// on Claude, OpenAI, xAI and OpenRouter, and this is the consumer that proves
// the fragments reassemble on each.

jest.mock('../../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger, logAudit: jest.fn() };
});
jest.mock('../../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
  getPool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));
jest.mock('../../../infrastructure/secrets', () => ({
  getOpenRouterApiKey: jest.fn().mockResolvedValue('test-openrouter-key'),
  getXaiApiKey: jest.fn().mockResolvedValue('test-xai-key'),
}));
jest.mock('../mcp-client-pool', () => ({
  getMcpClientPool: () => ({ acquire: jest.fn(), releaseAll: jest.fn().mockResolvedValue(undefined) }),
}));

/** The raw events the mocked run() streams for the current case. */
const script: { raw: unknown[] } = { raw: [] };

jest.mock('@openai/agents', () => ({
  run: jest.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'raw_model_stream_event', data: { type: 'response_started' } };
      for (const event of script.raw) {
        yield { type: 'raw_model_stream_event', data: { type: 'model', event } };
      }
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'done' } };
    },
    completed: Promise.resolve(),
    newItems: [{ type: 'message_output_item', rawItem: { content: [{ type: 'output_text', text: 'done' }] } }],
    rawResponses: [{ usage: { inputTokens: 1, outputTokens: 1, inputTokensDetails: [{ cached_tokens: 0 }] } }],
    history: [],
    interruptions: [],
  })),
  Agent: class MockAgent { constructor(public opts: unknown) {} },
  tool: (def: unknown) => def,
  webSearchTool: jest.fn(() => ({ type: 'hosted', name: 'web_search' })),
  protocol: jest.requireActual('@openai/agents').protocol,
}));

import { OpenAiWireAdapter } from '../openai-wire';
import { openAiTarget } from '../openai';
import { openRouterTarget } from '../openrouter';
import { ArgumentDeltaCorrelator } from '../openai-wire/argument-deltas';
import type { InvocationEvent, InvocationInput, McpToolCatalog } from '../types';

type Partial = Extract<InvocationEvent, { type: 'tool_call_partial' }>;

/** The consumer side of the contract: fragments concatenated per call, in
 *  order, parse to the arguments the complete call carries. */
function reassemble(events: InvocationEvent[]): Map<string, { toolName: string; args: unknown }> {
  const buffers = new Map<string, { toolName: string; json: string }>();
  for (const e of events) {
    if (e.type !== 'tool_call_partial') continue;
    const b = buffers.get(e.callId) ?? { toolName: e.toolName, json: '' };
    b.json += e.partialJson;
    buffers.set(e.callId, b);
  }
  return new Map([...buffers].map(([id, b]) => [id, { toolName: b.toolName, args: JSON.parse(b.json) }]));
}

async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function catalog(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'liftoff-tool-gateway', config: { type: 'sdk', name: 'liftoff-tool-gateway', instance: {} as never } }],
    tools: [{ name: 'gmail__send_email', description: 'Send', inputSchema: { type: 'object', properties: {} }, serverId: 'liftoff-tool-gateway' }],
  };
}

function input(provider: InvocationInput['provider'], model: string): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'send it' }] }],
    systemPrompt: 'system', model, provider, tenantId: 't1', invocationId: `inv-${provider}`, maxTurns: 2,
  };
}

// ── The Responses API shape: OpenAI and xAI ────────────────────────────────
const RESPONSES_RAW = [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'gmail__send_email', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"to": "x@' },
  { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: 'y.com", "sub' },
  { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: 'ject": "Hi"}' },
  { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_1', arguments: '{"to": "x@y.com", "subject": "Hi"}' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'gmail__send_email' } },
];

// ── The Chat Completions shape: OpenRouter ────────────────────────────────
const CHAT_RAW = [
  { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_xyz', type: 'function', function: { name: 'gmail__send_email', arguments: '' } }] } }] },
  { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"to": "x@' } }] } }] },
  { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'y.com", "sub' } }] } }] },
  { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ject": "Hi"}' } }] } }] },
  { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
];

describe('tool_call_partial on the OpenAI wire', () => {
  it.each([
    ['openai (Responses API)', () => new OpenAiWireAdapter({ target: openAiTarget }), 'openai' as const, 'gpt-5-codex', RESPONSES_RAW, 'call_abc'],
    ['openrouter (Chat Completions)', () => new OpenAiWireAdapter({ target: openRouterTarget }), 'glm' as const, 'z-ai/glm-5.2', CHAT_RAW, 'call_xyz'],
  ])('%s: the adapter correlates the fragments to the call and a consumer reassembles the arguments', async (_name, build, provider, model, raw, callId) => {
    script.raw = raw;
    const adapter = build();
    adapter.registerToolCatalog(catalog());
    adapter.registerHitlGate(async () => ({ allow: true }));
    adapter.registerAnomalyHandler(async () => ({ decision: 'continue' } as never));
    const events = await drain(adapter.invoke(input(provider, model), new AbortController().signal));

    const partials = events.filter((e): e is Partial => e.type === 'tool_call_partial');
    expect(partials).toHaveLength(3);
    for (const p of partials) {
      expect(p.callId).toBe(callId);
      expect(p.toolName).toBe('gmail__send_email');
    }
    expect(reassemble(events).get(callId)).toEqual({ toolName: 'gmail__send_email', args: { to: 'x@y.com', subject: 'Hi' } });
    // Text deltas are untouched by the addition, and the turn still ends.
    expect(events.filter((e) => e.type === 'assistant_delta')).toEqual([{ type: 'assistant_delta', text: 'done' }]);
    expect(events[events.length - 1].type).toBe('completion');
  });
});

describe('the correlator', () => {
  it('keeps two calls streaming in one response apart, by index, on both shapes', () => {
    const c = new ArgumentDeltaCorrelator();
    const responses = [
      ...c.onRawEvent({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'crm__get_contact' } }),
      ...c.onRawEvent({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'crm__get_deal' } }),
      ...c.onRawEvent({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"id":' }),
      ...c.onRawEvent({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"deal":' }),
      ...c.onRawEvent({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '"c1"}' }),
      ...c.onRawEvent({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '"d9"}' }),
    ];
    const built = reassemble(responses);
    expect(built.get('call_a')).toEqual({ toolName: 'crm__get_contact', args: { id: 'c1' } });
    expect(built.get('call_b')).toEqual({ toolName: 'crm__get_deal', args: { deal: 'd9' } });

    c.reset();
    const chat = [
      ...c.onRawEvent({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_a', function: { name: 'crm__get_contact', arguments: '' } },
        { index: 1, id: 'call_b', function: { name: 'crm__get_deal', arguments: '' } },
      ] } }] }),
      ...c.onRawEvent({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"id":' } }, { index: 1, function: { arguments: '{"deal":' } }] } }] }),
      ...c.onRawEvent({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"c1"}' } }, { index: 1, function: { arguments: '"d9"}' } }] } }] }),
    ];
    const builtChat = reassemble(chat);
    expect(builtChat.get('call_a')).toEqual({ toolName: 'crm__get_contact', args: { id: 'c1' } });
    expect(builtChat.get('call_b')).toEqual({ toolName: 'crm__get_deal', args: { deal: 'd9' } });
  });

  it('drops a fragment for an index nothing announced rather than emitting it nameless', () => {
    const c = new ArgumentDeltaCorrelator();
    expect(c.onRawEvent({ type: 'response.function_call_arguments.delta', output_index: 7, delta: '{}' })).toEqual([]);
    expect(c.onRawEvent({ choices: [{ delta: { tool_calls: [{ index: 3, function: { arguments: '{}' } }] } }] })).toEqual([]);
  });

  it('a done item takes no more fragments, and a new response clears every binding', () => {
    const c = new ArgumentDeltaCorrelator();
    c.onRawEvent({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'x' } });
    c.onRawEvent({ type: 'response.output_item.done', output_index: 0 });
    expect(c.onRawEvent({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' })).toEqual([]);
    expect(c.onRawEvent({ type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{}' })).toEqual([]);

    c.onRawEvent({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_c', call_id: 'call_c', name: 'y' } });
    c.reset();
    expect(c.onRawEvent({ type: 'response.function_call_arguments.delta', output_index: 2, delta: '{}' })).toEqual([]);
  });

  it('a message item is not a call, and a non-call event is not a fragment', () => {
    const c = new ArgumentDeltaCorrelator();
    expect(c.onRawEvent({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg' } })).toEqual([]);
    expect(c.onRawEvent({ type: 'response.output_text.delta', output_index: 0, delta: 'hello' })).toEqual([]);
    expect(c.onRawEvent(null)).toEqual([]);
    expect(c.onRawEvent('response.completed')).toEqual([]);
  });
});
