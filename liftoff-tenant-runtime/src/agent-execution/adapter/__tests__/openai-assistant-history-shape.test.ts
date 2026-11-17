// Regression: the OpenAI adapter must hand the SDK a well-formed ASSISTANT
// input item when it replays conversation history.
//
// The unit tests elsewhere cannot see this. A thread rebuilt from the canonical
// record (claude-agent-sdk -> openai-agents) can die with
// `item.content.map is not a function` — a TypeError thrown inside
// @openai/agents, with no provider involved, recorded as failure_class
// 'unknown'.
//
// Cause: translatePlatformMessages emitted `{ role: 'assistant', content: <string> }`.
// The SDK's AssistantMessageItem (agents-core protocol.d.ts) requires
// `status: 'in_progress' | 'completed' | 'incomplete'` and a `content` ARRAY of
// output parts, and the SDK maps over that array. A USER item does take a bare
// string, which is why this was invisible: until cross-engine rebuild shipped,
// `input.messages` on this path only ever carried the current user turn.
//
// The inverse-mapper unit tests and the 7x7 cross-engine matrix could not catch
// it — both assert on what `canonicalToEngine` EMITS and stop before anything
// consumes it. This test asserts the other side of that seam.

jest.mock('@openai/agents', () => ({
  run: jest.fn(),
  Agent: class MockAgent {
    constructor(public opts: unknown) {}
  },
  // The vendor's own runtime schemas, which the replay validator checks against.
  protocol: jest.requireActual('@openai/agents').protocol,
}));

import { OpenAiWireAdapter } from '../openai-wire';
import { openAiTarget } from '../openai';
import type { PlatformMessage } from '../types';

interface AssistantItem {
  role: string;
  status?: string;
  content: unknown;
}

/** translatePlatformMessages is private; the shape it produces is the contract
 *  under test, so reach it directly rather than asserting on a proxy. */
function translate(msgs: PlatformMessage[]): AssistantItem[] {
  const adapter = new OpenAiWireAdapter({ target: openAiTarget }) as unknown as {
    translatePlatformMessages(m: PlatformMessage[]): AssistantItem[];
  };
  return adapter.translatePlatformMessages(msgs);
}

const REBUILT_HISTORY: PlatformMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Remember this codeword: ZEPHYRA.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Got it, ZEPHYRA.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Second codeword: ZEPHYRB.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Both saved.' }] },
  { role: 'user', content: [{ type: 'text', text: 'What two codewords did I give you?' }] },
];

describe('OpenAI adapter: assistant items in replayed history', () => {
  it('gives every assistant item an ARRAY content — the shape the SDK maps over', () => {
    const items = translate(REBUILT_HISTORY);
    const assistants = items.filter((i) => i.role === 'assistant');

    expect(assistants).toHaveLength(2);
    for (const item of assistants) {
      // The failure verbatim: `item.content.map is not a function`.
      expect(Array.isArray(item.content)).toBe(true);
      expect(() => (item.content as unknown[]).map((c) => c)).not.toThrow();
    }
  });

  it('gives every assistant item a status — the SDK requires one', () => {
    const items = translate(REBUILT_HISTORY);
    for (const item of items.filter((i) => i.role === 'assistant')) {
      expect(['in_progress', 'completed', 'incomplete']).toContain(item.status);
    }
  });

  it('carries the assistant text through as an output_text part', () => {
    const items = translate(REBUILT_HISTORY);
    const first = items.filter((i) => i.role === 'assistant')[0];
    expect(first.content).toEqual([{ type: 'output_text', text: 'Got it, ZEPHYRA.' }]);
  });

  it('leaves USER items as a bare string — that shape was always valid', () => {
    const items = translate(REBUILT_HISTORY);
    const users = items.filter((i) => i.role === 'user');
    expect(users).toHaveLength(3);
    for (const item of users) {
      expect(typeof item.content).toBe('string');
    }
    expect(users[0].content).toBe('Remember this codeword: ZEPHYRA.');
  });

  it('preserves conversation order, so the rebuilt history reads as a conversation', () => {
    const items = translate(REBUILT_HISTORY);
    expect(items.map((i) => i.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user',
    ]);
  });

  it('still drops system turns (they travel in the SDK instructions slot)', () => {
    const items = translate([
      { role: 'system', content: [{ type: 'text', text: 'you are a bot' }] },
      ...REBUILT_HISTORY,
    ]);
    expect(items.some((i) => i.role === 'system')).toBe(false);
    expect(items).toHaveLength(5);
  });

  it('drops a message whose content has no text, rather than emitting an empty item', () => {
    const items = translate([
      { role: 'assistant', content: [] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe('user');
  });
});

// ── Tool exchanges in replayed history ────────────────────────────────────
//
// A replayed tool call and its result reach the SDK as its OWN items — a
// `function_call` on the assistant side, a `function_call_result` on the user
// side, paired by callId — the shape the Responses API replays natively. They
// used to be dropped: only text blocks were translated, so a resumed run read
// an approval's outcome from nowhere.
describe('OpenAI adapter: tool exchanges in replayed history', () => {
  const HISTORY_WITH_TOOLS: PlatformMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Email Dana the summary.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Sending.' },
        { type: 'tool_use', toolName: 'gmail__send_email', callId: 'call_1', args: '{"to":"dana@example.com"}' },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', callId: 'call_1', result: '{"messageId":"m-1"}' }] },
    { role: 'user', content: [{ type: 'text', text: 'continue' }] },
  ];

  it('emits function_call and function_call_result items, paired by callId, in the model\'s order', () => {
    const items = translate(HISTORY_WITH_TOOLS) as unknown as Array<Record<string, unknown>>;
    expect(items.map((i) => i.type ?? i.role)).toEqual(['user', 'assistant', 'function_call', 'function_call_result', 'user']);
    expect(items[2]).toEqual({ type: 'function_call', callId: 'call_1', name: 'gmail__send_email', status: 'completed', arguments: '{"to":"dana@example.com"}' });
    expect(items[3]).toEqual({
      type: 'function_call_result', callId: 'call_1', name: 'gmail__send_email', status: 'completed',
      output: { type: 'text', text: '{"messageId":"m-1"}' },
    });
  });

  it('re-serializes arguments the run\'s own history carries as an object', () => {
    const items = translate([
      { role: 'assistant', content: [{ type: 'tool_use', toolName: 'slack__post', callId: 'c2', args: { text: 'hi' } }] },
      { role: 'user', content: [{ type: 'tool_result', callId: 'c2', result: { ok: true } }] },
    ]) as unknown as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ type: 'function_call', arguments: '{"text":"hi"}' });
    expect(items[1]).toMatchObject({ type: 'function_call_result', output: { type: 'text', text: '{"ok":true}' } });
  });

  it('every item passes the SDK\'s own schema', () => {
    const adapter = new OpenAiWireAdapter({ target: openAiTarget });
    expect(() => adapter.assertCanReplayHistory(HISTORY_WITH_TOOLS)).not.toThrow();
  });
});
