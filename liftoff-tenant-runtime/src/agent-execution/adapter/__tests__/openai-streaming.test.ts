// OpenAI adapter token streaming: run(..., { stream: true }) → forward
// raw_model_stream_event output_text_delta as assistant_delta, then the
// terminal assistant_message from newItems (multi-turn history) + completion.

jest.mock('@openai/agents', () => ({
  run: jest.fn(),
  Agent: jest.fn().mockImplementation(function (this: Record<string, unknown>, opts: unknown) { this.opts = opts; }),
  tool: (def: unknown) => def,
  webSearchTool: jest.fn(() => ({ type: 'hosted', name: 'web_search' })),
}));

import { run } from '@openai/agents';
import { OpenAiWireAdapter } from '../openai-wire';
import { openAiTarget } from '../openai';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, InvocationEvent } from '../types';

const emptyCatalog: McpToolCatalog = { servers: [], tools: [] };
function makeInput(): InvocationInput {
  return { messages: [], systemPrompt: 's', model: 'gpt-5.4', provider: 'openai', tenantId: 't1', invocationId: 'inv1', maxTurns: 5 };
}
async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

beforeEach(() => jest.clearAllMocks());

it('streams output_text_delta as assistant_delta, then assistant_message + completion', async () => {
  const fakeStreamed = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'Hel' } };
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'lo' } };
      yield { type: 'run_item_stream_event', name: 'message_output_created', item: {} };  // ignored
    },
    completed: Promise.resolve(),
    newItems: [{ type: 'message_output_item', rawItem: { content: [{ type: 'output_text', text: 'Hello' }] } }],
    history: [],
    interruptions: [],
  };
  (run as jest.Mock).mockResolvedValue(fakeStreamed);

  const adapter = new OpenAiWireAdapter({ target: openAiTarget });
  adapter.registerToolCatalog(emptyCatalog);
  const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

  const deltas = events.filter((e) => e.type === 'assistant_delta') as Array<Extract<InvocationEvent, { type: 'assistant_delta' }>>;
  expect(deltas.map((d) => d.text)).toEqual(['Hel', 'lo']);
  const msg = events.find((e) => e.type === 'assistant_message') as Extract<InvocationEvent, { type: 'assistant_message' }>;
  expect(msg.content).toEqual([{ type: 'text', text: 'Hello' }]);
  expect(events.at(-1)).toMatchObject({ type: 'completion', outcome: 'success' });

  // run() must be invoked in streaming mode.
  expect((run as jest.Mock).mock.calls.at(-1)?.[2]).toMatchObject({ stream: true });
});

describe('tool calls reach the event stream as they happen, not after the run', () => {
  // Every listener on the event stream — the ledger, the provenance recorder,
  // the persisted call, the chat frames — used to hear about a run's tool
  // calls only once `newItems` was read after the run: a write at the end of
  // a run was judged against a store its own reads had not reached. The
  // stream's items are the same objects `newItems` holds, so each is yielded
  // once, from the stream.
  it('yields tool_call_started/finished off the stream, once, before the run ends', async () => {
    const call = { type: 'tool_call_item', rawItem: { type: 'function_call', name: 'github__pull_request_read', arguments: '{"n":1}', call_id: 'c1', callId: 'c1' } };
    const output = { type: 'tool_call_output_item', rawItem: { call_id: 'c1', output: { type: 'text', text: '{"content":[{"type":"text","text":"{\\"head\\":{\\"sha\\":\\"abc\\"}}"}]}' } } };
    const message = { type: 'message_output_item', rawItem: { content: [{ type: 'output_text', text: 'Done.' }] } };
    let runEnded = false;
    const fakeStreamed = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'run_item_stream_event', name: 'tool_called', item: call };
        yield { type: 'run_item_stream_event', name: 'tool_output', item: output };
        yield { type: 'raw_model_stream_event', data: { type: 'response_started' } };
        yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'Done.' } };
      },
      get completed() { runEnded = true; return Promise.resolve(); },
      newItems: [call, output, message],
      history: [],
      interruptions: [],
    };
    (run as jest.Mock).mockResolvedValue(fakeStreamed);

    const adapter = new OpenAiWireAdapter({ target: openAiTarget });
    adapter.registerToolCatalog(emptyCatalog);
    const seen: Array<{ type: string; beforeEnd: boolean }> = [];
    for await (const ev of adapter.invoke(makeInput(), new AbortController().signal)) {
      seen.push({ type: ev.type, beforeEnd: !runEnded });
    }

    const started = seen.filter((e) => e.type === 'tool_call_started');
    const finished = seen.filter((e) => e.type === 'tool_call_finished');
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(started[0].beforeEnd).toBe(true);
    expect(finished[0].beforeEnd).toBe(true);
    // The message still comes from the pass at the end, as before.
    expect(seen.filter((e) => e.type === 'assistant_message')).toHaveLength(1);
    expect(seen.at(-1)?.type).toBe('completion');
  });
});

// ── What a torn-down run had produced is recorded before the teardown ─────
//
// The items were recorded off `newItems` once the run resolved, and a pause
// aborts the run mid-flight: the turn that proposed the gated call never
// reached the recorder, the pause's checkpoint held only the user turn, and
// its resume could not find the call it was meant to complete. The SDK keeps
// the items generated so far on the result; the catch reads them.
describe('the recorder sees what a run produced before it was torn down', () => {
  it('records the generated items when the stream throws, ahead of the terminal event', async () => {
    const call = { type: 'tool_call_item', rawItem: { type: 'function_call', callId: 'call_1', name: 'gmail__send_email', arguments: '{"to":"x"}' } };
    const fakeStreamed = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'run_item_stream_event', name: 'tool_called', item: call };
        throw new Error('aborted by the bridge');
      },
      completed: Promise.resolve(),
      newItems: [call],
      history: [],
      interruptions: [],
    };
    (run as jest.Mock).mockResolvedValue(fakeStreamed);

    const adapter = new OpenAiWireAdapter({ target: openAiTarget });
    adapter.registerToolCatalog(emptyCatalog);
    const recorded: unknown[] = [];
    adapter.registerTrajectoryRecorder({ recordRaw: (e) => { recorded.push(e.raw); } });
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

    expect(recorded).toEqual([call]);
    expect(events.at(-1)).toMatchObject({ type: 'completion', outcome: 'error' });
  });

  it('records a completed run\'s items exactly once', async () => {
    const message = { type: 'message_output_item', rawItem: { content: [{ type: 'output_text', text: 'Hello' }] } };
    const fakeStreamed = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'Hello' } };
      },
      completed: Promise.resolve(),
      newItems: [message],
      history: [],
      interruptions: [],
    };
    (run as jest.Mock).mockResolvedValue(fakeStreamed);
    const adapter = new OpenAiWireAdapter({ target: openAiTarget });
    adapter.registerToolCatalog(emptyCatalog);
    const recorded: unknown[] = [];
    adapter.registerTrajectoryRecorder({ recordRaw: (e) => { recorded.push(e.raw); } });
    await drain(adapter.invoke(makeInput(), new AbortController().signal));
    expect(recorded).toEqual([message]);
  });
});
