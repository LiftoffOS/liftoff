// 2.1 — translateRunItem against the REAL @openai/agents RunItem shapes.
//
// RunItem class instances expose `_item`-suffixed `type` discriminators and carry
// the protocol payload on `rawItem` (NOT the item top level). These fixtures use
// those exact shapes — the previous translator matched bare 'message_output' etc.
// and read top-level fields, so it emitted nothing for real production items.

jest.mock('@openai/agents', () => ({
  run: jest.fn(),
  Agent: class MockAgent { constructor(public opts: unknown) {} },
}));

import { OpenAiWireAdapter } from '../index';
import { openAiTarget } from '../../openai';
import type { McpToolCatalog } from '../../catalog-types';

type Ev = { type: string; [k: string]: unknown };
function translate(item: unknown): Ev[] {
  const a = new OpenAiWireAdapter({ target: openAiTarget });
  a.registerToolCatalog({ servers: [], tools: [] } as McpToolCatalog);
  return (a as unknown as { translateRunItem(i: unknown): Ev[] }).translateRunItem(item);
}

it('message_output_item → assistant_message from rawItem.content output_text blocks', () => {
  expect(translate({
    type: 'message_output_item',
    rawItem: { content: [{ type: 'output_text', text: 'hel' }, { type: 'output_text', text: 'lo' }] },
  })).toEqual([{ type: 'assistant_message', content: [{ type: 'text', text: 'hello' }] }]);
});

it('tool_call_item (function_call) → tool_call_started with parsed args + call_id', () => {
  expect(translate({
    type: 'tool_call_item',
    rawItem: { type: 'function_call', name: 'send_email', arguments: '{"to":"x@y.com"}', call_id: 'c1' },
  })).toEqual([{ type: 'tool_call_started', toolName: 'send_email', args: { to: 'x@y.com' }, callId: 'c1' }]);
});

it('tool_call_item with non-JSON arguments → anomaly_detected (malformed_output)', () => {
  const out = translate({
    type: 'tool_call_item',
    rawItem: { type: 'function_call', name: 'send_email', arguments: 'not json', call_id: 'c1' },
  });
  expect(out[0]).toMatchObject({ type: 'anomaly_detected', kind: 'malformed_output' });
});

it('tool_call_output_item → tool_call_finished with output', () => {
  expect(translate({
    type: 'tool_call_output_item',
    rawItem: { call_id: 'c1', output: 'ok' },
  })).toEqual([{ type: 'tool_call_finished', callId: 'c1', result: 'ok' }]);
});

it('tool_search_call_item → tool_call_started{web_search} (hosted web_search billing surface)', () => {
  expect(translate({
    type: 'tool_search_call_item',
    rawItem: { call_id: 'ws1', arguments: { query: 'foo' } },
  })).toEqual([{ type: 'tool_call_started', toolName: 'web_search', args: { query: 'foo' }, callId: 'ws1' }]);
});

it('tool_search_output_item → tool_call_finished', () => {
  expect(translate({
    type: 'tool_search_output_item',
    rawItem: { call_id: 'ws1', output: [{ url: 'http://x' }] },
  })).toEqual([{ type: 'tool_call_finished', callId: 'ws1', result: [{ url: 'http://x' }] }]);
});

it('reasoning / handoff / approval items are intentionally dropped (no events)', () => {
  for (const t of ['reasoning_item', 'handoff_call_item', 'handoff_output_item', 'tool_approval_item']) {
    expect(translate({ type: t, rawItem: {} })).toEqual([]);
  }
});

describe('tool_call_output_item → tool_call_finished carries the failure the output holds', () => {
  // The SDK marks every function-call output `completed` and stringifies the
  // tool's return into `{ type: 'text', text }`. Whether the CALL failed is in
  // that text: the bridge answers a denied gate with `{ error }` and a tool
  // that ran and failed with an `isError` envelope. An event with no `error`
  // made both a completed action in the ledger and a success on the surfaces.
  const wrapped = (value: unknown): unknown => ({ type: 'text', text: JSON.stringify(value) });

  it('a denied gate', () => {
    const [ev] = translate({ type: 'tool_call_output_item', rawItem: { call_id: 'c1', output: wrapped({ error: 'HITL gate denied', reason: 'x' }) } });
    expect(ev.type).toBe('tool_call_finished');
    expect(ev.error).toBe('HITL gate denied');
  });

  it('a tool that ran and failed', () => {
    const [ev] = translate({ type: 'tool_call_output_item', rawItem: { call_id: 'c2', output: wrapped({ content: [{ type: 'text', text: 'Validation Failed' }], isError: true }) } });
    expect(ev.error).toBe('Validation Failed');
  });

  it('a tool that succeeded — no error, result untouched', () => {
    const output = wrapped({ content: [{ type: 'text', text: '{"id":1}' }] });
    const [ev] = translate({ type: 'tool_call_output_item', rawItem: { call_id: 'c3', output } });
    expect(ev.error).toBeUndefined();
    expect(ev.result).toBe(output);
  });
});

describe('a started call and its finished counterpart carry the SAME id, in the protocol\'s own spelling', () => {
  // `FunctionCallItem` and `FunctionCallResultItem` both carry `callId`. The
  // result item has no `id` at all, so a translation that read `call_id ?? id`
  // keyed the start by the item id and the finish by '' — and nothing on the
  // event stream could pair a result with the call that produced it.
  it('pairs by callId', () => {
    const [started] = translate({ type: 'tool_call_item', rawItem: { type: 'function_call', name: 'github__pull_request_read', arguments: '{}', callId: 'call_9', id: 'fc_item_1', status: 'completed' } });
    const [finished] = translate({ type: 'tool_call_output_item', rawItem: { type: 'function_call_result', name: 'github__pull_request_read', callId: 'call_9', status: 'completed', output: { type: 'text', text: '{}' } } });
    expect(started.callId).toBe('call_9');
    expect(finished.callId).toBe('call_9');
  });
});

describe('tool_call_finished carries the MODEL-FACING output', () => {
  // This event is persisted and replayed into later model contexts, and the
  // untrusted frame on a vendor result is the boundary there. The raw data
  // went to the observer at dispatch and is not on the stream.
  it('keeps the output as the SDK delivered it, and reads the failure from it', () => {
    const output = { type: 'text', text: '{"content":[{"type":"text","text":"<UNTRUSTED_x_BEGIN>…"}]}' };
    const [ev] = translate({ type: 'tool_call_output_item', rawItem: { callId: 'call_1', output } });
    expect(ev.result).toBe(output);
    expect(ev.error).toBeUndefined();
  });

  it('a denied gate: its output is the answer', () => {
    const [ev] = translate({ type: 'tool_call_output_item', rawItem: { callId: 'call_2', output: { type: 'text', text: JSON.stringify({ error: 'HITL gate denied' }) } } });
    expect(ev.error).toBe('HITL gate denied');
  });

  it('an input_required interim result reads as a failure, as the observer was told', () => {
    // The bridge returns it to the model as an isError envelope; the event
    // must say the same thing the ledger was told, or run state, persistence
    // and the surfaces record a success the ledger recorded as a failure.
    const [ev] = translate({ type: 'tool_call_output_item', rawItem: { callId: 'call_3', output: { type: 'text', text: JSON.stringify({ content: [{ type: 'text', text: 'MCP tool "x" returned resultType=input_required' }], isError: true }) } } });
    expect(ev.error).toBeDefined();
  });
});

describe('a call the bridge already handed to the observer is marked on its finished event', () => {
  it('sets recordedAtDispatch, once, and leaves other calls unmarked', () => {
    const a = new OpenAiWireAdapter({ target: openAiTarget });
    a.registerToolCatalog({ servers: [], tools: [] } as McpToolCatalog);
    (a as unknown as { recordedCalls: Set<string> }).recordedCalls.add('call_1');
    const t = (a as unknown as { translateRunItem(i: unknown): Ev[] });
    const [marked] = t.translateRunItem({ type: 'tool_call_output_item', rawItem: { callId: 'call_1', output: { type: 'text', text: '{}' } } });
    expect(marked.recordedAtDispatch).toBe(true);
    const [other] = t.translateRunItem({ type: 'tool_call_output_item', rawItem: { callId: 'call_2', output: { type: 'text', text: '{}' } } });
    expect(other.recordedAtDispatch).toBeUndefined();
  });
});
