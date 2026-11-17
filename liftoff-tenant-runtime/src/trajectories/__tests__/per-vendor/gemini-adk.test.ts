// Google ADK per-vendor mapper. Fixtures mirror @google/adk
// Event shapes (Gemini Content parts + errorCode/errorMessage).

import { adkEventToCanonical } from '../../per-vendor/gemini-adk';

describe('adkEventToCanonical', () => {
  it('maps a text response part to an assistant text block', () => {
    const unknown = new Set<string>();
    const { message, extras } = adkEventToCanonical(
      { content: { role: 'model', parts: [{ text: 'hello' }] } },
      unknown,
    );
    expect(message).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
    expect(extras).toEqual({});
    expect(unknown.size).toBe(0);
  });

  it('maps thought parts to thinking blocks with signature captured in extras', () => {
    const unknown = new Set<string>();
    const { message, extras } = adkEventToCanonical(
      { content: { parts: [{ text: 'reasoning', thought: true, thoughtSignature: 'sig9' }] } },
      unknown,
    );
    expect(message.content[0]).toEqual({ type: 'thinking', thinking: 'reasoning', signature: 'sig9' });
    expect((extras as { per_part_thought_signatures?: unknown[] }).per_part_thought_signatures).toEqual(['sig9']);
  });

  it('maps functionCall → assistant tool_use and functionResponse → user tool_result', () => {
    const unknown = new Set<string>();
    const call = adkEventToCanonical(
      { content: { parts: [{ functionCall: { id: 'f1', name: 'my_tool', args: { x: 1 } } }] } },
      unknown,
    );
    expect(call.message).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'my_tool', input: { x: 1 } }] });

    const resp = adkEventToCanonical(
      { content: { parts: [{ functionResponse: { id: 'f1', name: 'my_tool', response: { ok: true } } }] } },
      unknown,
    );
    expect(resp.message.role).toBe('user');
    // `name` is carried; Gemini requires it on replay.
    expect(resp.message.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'f1',
      name: 'my_tool',
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    });
  });

  it('preserves an ADK error event in extras and yields no content', () => {
    const unknown = new Set<string>();
    const { message, extras } = adkEventToCanonical(
      { errorCode: 'UNKNOWN_ERROR', errorMessage: 'invalid_rapt' },
      unknown,
    );
    expect(message.content).toEqual([]);
    expect((extras as { adk_error?: unknown }).adk_error).toEqual({ errorCode: 'UNKNOWN_ERROR', errorMessage: 'invalid_rapt' });
    expect(unknown.has('adk:error')).toBe(true);
  });

  it('flags an unrecognized part on the unknown set and does not throw on malformed input', () => {
    const unknown = new Set<string>();
    adkEventToCanonical({ content: { parts: [{ inlineData: { data: 'x' } } as never] } }, unknown);
    expect([...unknown].some((u) => u.startsWith('adk:'))).toBe(true);
    expect(() => adkEventToCanonical(null, unknown)).not.toThrow();
    expect(() => adkEventToCanonical({}, unknown)).not.toThrow();
  });
});
