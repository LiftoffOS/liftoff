// Codex per-vendor mapper. Fixtures mirror @openai/codex-sdk
// ThreadEvent/ThreadItem shapes (sanitized). Covers text, governed tool call +
// result, tool error, multi-tool turn, reasoning, web_search, a terminal provider
// error, unmapped-item-into-extras, and non-content structural events.

import { codexThreadItemToCanonical } from '../../per-vendor/codex';

describe('codexThreadItemToCanonical', () => {
  it('maps a text-only agent_message completion to an assistant text block', () => {
    const unknown = new Set<string>();
    const { message, extras } = codexThreadItemToCanonical(
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'hello world' } },
      unknown,
    );
    expect(message).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hello world' }] });
    expect(extras).toEqual({});
    expect(unknown.size).toBe(0);
  });

  it('maps a governed mcp_tool_call: started → assistant tool_use, completed → user tool_result', () => {
    const unknown = new Set<string>();
    const started = codexThreadItemToCanonical(
      { type: 'item.started', item: { id: 'c1', type: 'mcp_tool_call', server: 'liftoff', tool: 'my_tool', arguments: { x: 1 }, status: 'in_progress' } },
      unknown,
    );
    expect(started.message).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'my_tool', input: { x: 1 } }],
    });
    // Provider-native server routing preserved in extras.
    expect((started.extras as { codex_tool_servers?: unknown[] }).codex_tool_servers)
      .toEqual([{ id: 'c1', server: 'liftoff', tool: 'my_tool' }]);

    const completed = codexThreadItemToCanonical(
      { type: 'item.completed', item: { id: 'c1', type: 'mcp_tool_call', server: 'liftoff', tool: 'my_tool', arguments: { x: 1 }, status: 'completed', result: { content: [], structured_content: null } } },
      unknown,
    );
    expect(completed.message.role).toBe('user');
    expect(completed.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' });
    expect((completed.message.content[0] as { is_error?: boolean }).is_error).toBeUndefined();
  });

  it('flags a failed mcp_tool_call as an error tool_result', () => {
    const unknown = new Set<string>();
    const { message } = codexThreadItemToCanonical(
      { type: 'item.completed', item: { id: 'c2', type: 'mcp_tool_call', server: 'liftoff', tool: 'my_tool', arguments: {}, status: 'failed', error: { message: 'boom' } } },
      unknown,
    );
    expect(message.role).toBe('user');
    expect(message.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'c2', content: 'boom', is_error: true });
  });

  it('maps reasoning items to thinking blocks and web_search to server_tool_use', () => {
    const unknown = new Set<string>();
    const reasoning = codexThreadItemToCanonical(
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'let me think' } },
      unknown,
    );
    expect(reasoning.message.content[0]).toEqual({ type: 'thinking', thinking: 'let me think' });

    const search = codexThreadItemToCanonical(
      { type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'weather' } },
      unknown,
    );
    expect(search.message.content[0]).toEqual({ type: 'server_tool_use', id: 'w1', name: 'web_search', input: { query: 'weather' } });
  });

  // command_execution and file_change carry a canonical shape. Cross-engine
  // rebuild reads `messages` and cannot see `extras`, so leaving them in
  // `codex_unmapped` meant a Codex thread rebuilt elsewhere lost every command
  // the agent ran and every file it changed.
  it('maps a started command_execution to a tool_use', () => {
    const unknown = new Set<string>();
    const { message } = codexThreadItemToCanonical(
      { type: 'item.started', item: { id: 'x1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      unknown,
    );
    expect(message.role).toBe('assistant');
    expect(message.content[0]).toEqual({
      type: 'tool_use', id: 'x1', name: 'command_execution', input: { command: 'npm test' },
    });
  });

  it('maps a completed command_execution to a user tool_result carrying its output', () => {
    const unknown = new Set<string>();
    const { message } = codexThreadItemToCanonical(
      { type: 'item.completed', item: { id: 'x1', type: 'command_execution', aggregated_output: 'ok', status: 'completed' } },
      unknown,
    );
    expect(message.role).toBe('user');
    expect(message.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'x1', content: 'ok' });
  });

  it('marks a failed command_execution is_error', () => {
    const unknown = new Set<string>();
    const { message } = codexThreadItemToCanonical(
      { type: 'item.completed', item: { id: 'x1', type: 'command_execution', aggregated_output: '2 failing', status: 'failed' } },
      unknown,
    );
    expect(message.content[0]).toEqual({
      type: 'tool_result', tool_use_id: 'x1', content: '2 failing', is_error: true,
    });
  });

  it('maps a completed file_change to a tool_use carrying the changed paths', () => {
    const unknown = new Set<string>();
    const { message } = codexThreadItemToCanonical(
      { type: 'item.completed', item: { id: 'p1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } },
      unknown,
    );
    expect(message.content[0]).toEqual({
      type: 'tool_use', id: 'p1', name: 'file_change', input: { changes: [{ path: 'src/a.ts', kind: 'update' }] },
    });
  });

  // A to-do list and a non-fatal error item are narration, not conversation the
  // next engine has to reproduce, so they stay preserved-verbatim.
  it('preserves narration-only items (todo_list) verbatim in extras and flags the unknown set', () => {
    const unknown = new Set<string>();
    const { message, extras } = codexThreadItemToCanonical(
      { type: 'item.completed', item: { id: 'x1', type: 'todo_list', status: 'completed' } },
      unknown,
    );
    expect(message.content).toEqual([]);
    expect((extras as { codex_unmapped?: unknown[] }).codex_unmapped).toHaveLength(1);
    expect(unknown.has('codex:todo_list')).toBe(true);
  });

  it('yields no content for structural events and preserves a terminal thread error', () => {
    const unknown = new Set<string>();
    for (const type of ['thread.started', 'turn.started', 'turn.completed', 'item.updated']) {
      const { message, extras } = codexThreadItemToCanonical({ type }, unknown);
      expect(message.content).toEqual([]);
      expect(extras).toEqual({});
    }
    const err = codexThreadItemToCanonical({ type: 'error', message: 'upstream failed' }, unknown);
    expect(err.message.content).toEqual([]);
    expect((err.extras as { codex_unmapped?: unknown[] }).codex_unmapped).toHaveLength(1);
    expect(unknown.has('codex:error')).toBe(true);
  });

  it('does not throw on a malformed/empty event', () => {
    const unknown = new Set<string>();
    expect(() => codexThreadItemToCanonical({}, unknown)).not.toThrow();
    expect(() => codexThreadItemToCanonical(null, unknown)).not.toThrow();
  });

  it('preserves a turn.failed (cancellation/timeout) event in extras — ', () => {
    const unknown = new Set<string>();
    const { message, extras } = codexThreadItemToCanonical(
      { type: 'turn.failed', error: { message: 'aborted' } },
      unknown,
    );
    expect(message.content).toEqual([]);
    expect((extras as { codex_unmapped?: unknown[] }).codex_unmapped).toHaveLength(1);
    expect(unknown.has('codex:turn.failed')).toBe(true);
  });

  it('treats a resumed turn (thread.started with an existing thread id) as no-content — ', () => {
    const unknown = new Set<string>();
    const { message, extras } = codexThreadItemToCanonical({ type: 'thread.started', thread_id: 'thread-existing' }, unknown);
    expect(message.content).toEqual([]);
    expect(extras).toEqual({});
  });
});
