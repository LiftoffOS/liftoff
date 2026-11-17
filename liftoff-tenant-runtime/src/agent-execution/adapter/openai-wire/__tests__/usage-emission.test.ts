// 1.1 + 1.2 — OpenAI adapter emits a billing usage event after the stream:
// token counts summed from rawResponses[].usage (incl. cached from
// inputTokensDetails[]), and hosted web_search counted from tool_search_call_item.
// Without this the OpenAI path published inputTokens=0/outputTokens=0 to billing.

jest.mock('@openai/agents', () => ({
  run: jest.fn(),
  Agent: jest.fn().mockImplementation(function (this: Record<string, unknown>, o: unknown) { this.opts = o; }),
  tool: (d: unknown) => d,
  webSearchTool: jest.fn(() => ({ type: 'hosted', name: 'web_search' })),
}));

import { run } from '@openai/agents';
import { OpenAiWireAdapter } from '../index';
import { openAiTarget } from '../../openai';
import type { McpToolCatalog } from '../../catalog-types';
import type { InvocationInput, InvocationEvent } from '../../types';

const emptyCatalog: McpToolCatalog = { servers: [], tools: [] };
function makeInput(): InvocationInput {
  return { messages: [], systemPrompt: 's', model: 'gpt-5', provider: 'openai', tenantId: 't1', invocationId: 'inv1', maxTurns: 5 };
}
async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = []; for await (const e of it) out.push(e); return out;
}
beforeEach(() => jest.clearAllMocks());

it('yields exactly one usage event: summed tokens (incl. cached) + web_search count', async () => {
  const fakeStreamed = {
    async *[Symbol.asyncIterator]() { /* no text deltas needed */ },
    completed: Promise.resolve(),
    newItems: [
      { type: 'tool_search_call_item', rawItem: { call_id: 'ws1', arguments: {} } },
      { type: 'message_output_item', rawItem: { content: [{ type: 'output_text', text: 'done' }] } },
    ],
    rawResponses: [
      { usage: { inputTokens: 10, outputTokens: 5, inputTokensDetails: [{ cached_tokens: 3 }] } },
      { usage: { inputTokens: 20, outputTokens: 8, inputTokensDetails: [] } },
    ],
    history: [],
    interruptions: [],
  };
  (run as jest.Mock).mockResolvedValue(fakeStreamed);

  const adapter = new OpenAiWireAdapter({ target: openAiTarget });
  adapter.registerToolCatalog(emptyCatalog);
  const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

  const usage = events.filter((e) => e.type === 'usage') as Array<Extract<InvocationEvent, { type: 'usage' }>>;
  expect(usage).toHaveLength(1);
  // `contextTokens` is the prompt total this wire already reports inclusive
  // of the cached part, so it equals inputTokens; adding cachedTokens to it
  // would count the cached part twice.
  expect(usage[0].usage).toEqual({ inputTokens: 30, outputTokens: 13, cachedTokens: 3, contextTokens: 30, webSearchRequests: 1 });
});

it('omits webSearchRequests when no web_search occurred', async () => {
  (run as jest.Mock).mockResolvedValue({
    async *[Symbol.asyncIterator]() {},
    completed: Promise.resolve(),
    newItems: [{ type: 'message_output_item', rawItem: { content: [{ type: 'output_text', text: 'hi' }] } }],
    rawResponses: [{ usage: { inputTokens: 4, outputTokens: 2, inputTokensDetails: [] } }],
    history: [], interruptions: [],
  });
  const adapter = new OpenAiWireAdapter({ target: openAiTarget }); adapter.registerToolCatalog(emptyCatalog);
  const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));
  const usage = events.find((e) => e.type === 'usage') as Extract<InvocationEvent, { type: 'usage' }>;
  expect(usage.usage.webSearchRequests).toBeUndefined();
  expect(usage.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
});

// A run that FAILS still spent what it spent.
//
// The usage event used to be emitted only after a clean loop, so every early
// return in the catch — max turns, an abort, any error, and all three pause
// paths — dropped the tokens on the floor. That is invisible by construction: a
// failed run with no cost row looks exactly like a run that never started.
// Found on a Grok turn that searched the web for 38 seconds, hit the turn
// ceiling, reported ok:true, and billed nothing.
it('bills for the turns already spent when the run exceeds max turns', async () => {
  const spent = {
    async *[Symbol.asyncIterator]() {},
    // The ceiling is raised while awaiting completion — AFTER the model calls
    // have been made and paid for.
    completed: Promise.reject(new Error('Max turns (10) exceeded')),
    newItems: [
      { type: 'tool_call_item', rawItem: { type: 'hosted_tool_call', name: 'web_search_call' } },
    ],
    rawResponses: [{ usage: { inputTokens: 900, outputTokens: 120, inputTokensDetails: [{ cached_tokens: 100 }] } }],
    history: [], interruptions: [],
  };
  (run as jest.Mock).mockResolvedValue(spent);

  const adapter = new OpenAiWireAdapter({ target: openAiTarget });
  adapter.registerToolCatalog(emptyCatalog);
  const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

  const usage = events.filter((e) => e.type === 'usage') as Array<Extract<InvocationEvent, { type: 'usage' }>>;
  expect(usage).toHaveLength(1);
  expect(usage[0].usage).toEqual({
    inputTokens: 900, outputTokens: 120, cachedTokens: 100, contextTokens: 900, webSearchRequests: 1,
  });
  // Still reported as a ceiling rather than a fault.
  expect(events.some((e) => e.type === 'completion' && e.outcome === 'limit_reached')).toBe(true);
});

it('counts a hosted web_search the way the Responses surface reports it', async () => {
  // `web_search_call` arrives as a hosted_tool_call carrying the original type
  // as its NAME. Matching the run-item type alone would also count every
  // function tool the agent dispatched.
  (run as jest.Mock).mockResolvedValue({
    async *[Symbol.asyncIterator]() {},
    completed: Promise.resolve(),
    newItems: [
      { type: 'tool_call_item', rawItem: { type: 'hosted_tool_call', name: 'web_search_call' } },
      { type: 'tool_call_item', rawItem: { type: 'function_call', name: 'corpus_search' } },
    ],
    rawResponses: [{ usage: { inputTokens: 1, outputTokens: 1, inputTokensDetails: [] } }],
    history: [], interruptions: [],
  });

  const adapter = new OpenAiWireAdapter({ target: openAiTarget });
  adapter.registerToolCatalog(emptyCatalog);
  const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));
  const usage = events.filter((e) => e.type === 'usage') as Array<Extract<InvocationEvent, { type: 'usage' }>>;
  expect(usage[0].usage.webSearchRequests).toBe(1);
});
