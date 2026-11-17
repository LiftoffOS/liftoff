// Tool arguments stream as fragments, and a consumer can put them back
// together — the stream contract for `tool_call_partial`.
//
// The Claude Agent SDK announces a tool use once (`content_block_start` with
// the tool's id and name at a block index) and then streams the arguments as
// `input_json_delta` blocks that carry ONLY the index. The adapter used to
// forward text deltas alone; argument deltas named no call and were dropped.
// The correlation state — index → {id, name}, opened at the start block,
// closed at the stop block, cleared at message_start — is what makes the event
// emittable, and this is the consumer that proves the fragments reassemble.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
  AbortError: class AbortError extends Error {},
}));

import { AnthropicAdapter } from '../anthropic';
import type { InvocationEvent } from '../types';

type Translate = (message: unknown) => InvocationEvent[];

function translator(): Translate {
  const adapter = new AnthropicAdapter();
  return (m) => (adapter as unknown as { translateSDKMessage: Translate }).translateSDKMessage(m);
}

const streamEvent = (event: unknown) => ({ type: 'stream_event', event });

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

describe('tool_call_partial', () => {
  it('correlates argument deltas to the tool the start block announced, and the fragments reassemble', () => {
    const t = translator();
    const events = [
      ...t(streamEvent({ type: 'message_start' })),
      ...t(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })),
      ...t(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sending now.' } })),
      ...t(streamEvent({ type: 'content_block_stop', index: 0 })),
      ...t(streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'gmail__send_email', input: {} } })),
      ...t(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"to": "x@' } })),
      ...t(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'y.com", "sub' } })),
      ...t(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ject": "Hi"}' } })),
      ...t(streamEvent({ type: 'content_block_stop', index: 1 })),
    ];
    const partials = events.filter((e) => e.type === 'tool_call_partial') as Extract<InvocationEvent, { type: 'tool_call_partial' }>[];
    expect(partials).toHaveLength(3);
    for (const p of partials) {
      expect(p.callId).toBe('toolu_01');
      expect(p.toolName).toBe('gmail__send_email');
    }
    expect(reassemble(events).get('toolu_01')).toEqual({ toolName: 'gmail__send_email', args: { to: 'x@y.com', subject: 'Hi' } });
    // Text deltas are untouched by the addition.
    expect(events.filter((e) => e.type === 'assistant_delta')).toEqual([{ type: 'assistant_delta', text: 'Sending now.' }]);
  });

  it('keeps two tool uses streaming in parallel apart, by index', () => {
    const t = translator();
    const events = [
      ...t(streamEvent({ type: 'message_start' })),
      ...t(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'crm__get_contact' } })),
      ...t(streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_b', name: 'crm__get_deal' } })),
      ...t(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":' } })),
      ...t(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"deal":' } })),
      ...t(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"c1"}' } })),
      ...t(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"d9"}' } })),
      ...t(streamEvent({ type: 'content_block_stop', index: 0 })),
      ...t(streamEvent({ type: 'content_block_stop', index: 1 })),
    ];
    const built = reassemble(events);
    expect(built.get('toolu_a')).toEqual({ toolName: 'crm__get_contact', args: { id: 'c1' } });
    expect(built.get('toolu_b')).toEqual({ toolName: 'crm__get_deal', args: { deal: 'd9' } });
  });

  it('drops a delta for an index nothing announced rather than emitting it nameless', () => {
    const t = translator();
    const events = t(streamEvent({ type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: '{}' } }));
    expect(events).toEqual([]);
  });

  it('a closed block does not accept more deltas, and message_start clears everything', () => {
    const t = translator();
    t(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'x' } }));
    t(streamEvent({ type: 'content_block_stop', index: 0 }));
    expect(t(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }))).toEqual([]);

    t(streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_c', name: 'y' } }));
    t(streamEvent({ type: 'message_start' }));
    expect(t(streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }))).toEqual([]);
  });

  it('the complete call still arrives when the block completes', () => {
    // Additive: the consumers that do not stream read `tool_call_started` off
    // the assistant message exactly as before.
    const t = translator();
    const events = t({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'gmail__send_email', input: { to: 'x@y.com' } }] },
    });
    expect(events.find((e) => e.type === 'tool_call_started')).toEqual({
      type: 'tool_call_started', toolName: 'gmail__send_email', args: { to: 'x@y.com' }, callId: 'toolu_01',
    });
  });
});
