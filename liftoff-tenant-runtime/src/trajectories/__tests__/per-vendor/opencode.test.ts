// OpenCode per-vendor mapper. Fixtures mirror @opencode-ai/sdk
// Event shapes ({ type: 'message.part.updated', properties: { part } }).

import { opencodePartToCanonical } from '../../per-vendor/opencode';

describe('opencodePartToCanonical', () => {
  it('maps a text part to an assistant text block', () => {
    const unknown = new Set<string>();
    const { message, extras } = opencodePartToCanonical(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'hello' } } },
      unknown,
    );
    expect(message).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
    expect(extras).toEqual({});
  });

  it('maps a running tool part → assistant tool_use and a completed one → user tool_result', () => {
    const unknown = new Set<string>();
    const started = opencodePartToCanonical(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'my_tool', callID: 'c1', state: { status: 'running', input: { x: 1 } } } } },
      unknown,
    );
    expect(started.message).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'my_tool', input: { x: 1 } }] });

    const done = opencodePartToCanonical(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'my_tool', callID: 'c1', state: { status: 'completed', output: 'ok' } } } },
      unknown,
    );
    expect(done.message.role).toBe('user');
    expect(done.message.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'c1', content: 'ok' });
  });

  it('records a call once, under the catalog\'s name: pending and running coalesce under the call id, the result closes it', () => {
    const unknown = new Set<string>();
    const pending = opencodePartToCanonical(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'liftoff_gmail__send_email', callID: 'c1', state: { status: 'pending', input: {} } } } },
      unknown,
    );
    expect(pending.message).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'gmail__send_email', input: {} }] });
    expect(pending.coalesceKey).toBe('tool:c1');
    expect(pending.closeKeys).toBeUndefined();
    const running = opencodePartToCanonical(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'liftoff_gmail__send_email', callID: 'c1', state: { status: 'running', input: { to: 'a@b.c' } } } } },
      unknown,
    );
    expect(running.message.content[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'gmail__send_email', input: { to: 'a@b.c' } });
    expect(running.coalesceKey).toBe('tool:c1');
    const done = opencodePartToCanonical(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'liftoff_gmail__send_email', callID: 'c1', state: { status: 'completed', input: { to: 'a@b.c' }, output: 'sent' } } } },
      unknown,
    );
    expect(done.coalesceKey).toBeUndefined();
    expect(done.closeKeys).toEqual(['tool:c1']);
    // A built-in the CLI names without the prefix keeps its name.
    const builtin = opencodePartToCanonical(
      { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', callID: 'c9', state: { status: 'running', input: {} } } } },
      unknown,
    );
    expect((builtin.message.content[0] as { name: string }).name).toBe('bash');
  });

  it('flags a failed tool part as an error tool_result', () => {
    const unknown = new Set<string>();
    const { message } = opencodePartToCanonical(
      { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'my_tool', callID: 'c2', state: { status: 'error', error: 'boom' } } } },
      unknown,
    );
    expect(message.role).toBe('user');
    expect(message.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'c2', content: 'boom', is_error: true });
  });

  it('yields no content for step-finish and non-part lifecycle events', () => {
    const unknown = new Set<string>();
    const step = opencodePartToCanonical(
      { type: 'message.part.updated', properties: { part: { type: 'step-finish', tokens: { input: 5, output: 3 } } } },
      unknown,
    );
    expect(step.message.content).toEqual([]);
    const idle = opencodePartToCanonical({ type: 'session.idle', properties: { sessionID: 's1' } }, unknown);
    expect(idle.message.content).toEqual([]);
  });

  it('preserves an unrecognized part type in extras and does not throw on malformed input', () => {
    const unknown = new Set<string>();
    const { message, extras } = opencodePartToCanonical(
      { type: 'message.part.updated', properties: { part: { type: 'snapshot', id: 'snap1' } } },
      unknown,
    );
    expect(message.content).toEqual([]);
    expect((extras as { opencode_unmapped?: unknown[] }).opencode_unmapped).toHaveLength(1);
    expect(unknown.has('opencode:snapshot')).toBe(true);
    expect(() => opencodePartToCanonical(null, unknown)).not.toThrow();
    expect(() => opencodePartToCanonical({}, unknown)).not.toThrow();
  });
});
