import { collapseHistory, buildInputFromItems } from '../handoff-utils';
import type { AgentRunItem } from '../run-state/types';

// Helpers to build typed items
const msg = (role: 'assistant' | 'user', content: string, turn = 0): AgentRunItem =>
  ({ type: 'message_output', role, content, turn, timestamp: '2026-01-01T00:00:00Z' });

const toolCall = (name: string, callId = 'c1', input: unknown = {}, turn = 0): AgentRunItem =>
  ({ type: 'tool_call', toolName: name, callId, input, turn, timestamp: '2026-01-01T00:00:00Z' });

const toolResult = (callId = 'c1', output: unknown = 'ok', turn = 0): AgentRunItem =>
  ({ type: 'tool_result', callId, output, turn, timestamp: '2026-01-01T00:00:00Z' });

const toolError = (callId = 'c1', err = 'fail', turn = 0): AgentRunItem =>
  ({ type: 'tool_result', callId, output: null, error: err, turn, timestamp: '2026-01-01T00:00:00Z' });

const hitlItem = (callId = 'c1'): AgentRunItem =>
  ({ type: 'hitl_approval', callId, toolName: 'send_email', decision: 'approved', decidedBy: 'alice', turn: 0, timestamp: '2026-01-01T00:00:00Z' });

const handoffItem = (): AgentRunItem =>
  ({ type: 'handoff', fromAgentId: 'a1', toAgentId: 'a2', turn: 0, timestamp: '2026-01-01T00:00:00Z' });

describe('collapseHistory', () => {
  it('returns empty string for empty items list', async () => {
    expect(await collapseHistory([])).toBe('');
  });

  it('wraps output in default CONVERSATION HISTORY tag', async () => {
    const result = await collapseHistory([msg('user', 'hello')]);
    expect(result).toMatch(/^<CONVERSATION HISTORY>/);
    expect(result).toMatch(/<\/CONVERSATION HISTORY>$/);
  });

  it('respects custom wrapperTag', async () => {
    const result = await collapseHistory([msg('user', 'hi')], { wrapperTag: 'CONTEXT' });
    expect(result).toMatch(/^<CONTEXT>/);
    expect(result).toMatch(/<\/CONTEXT>$/);
  });

  it('includes message_output items with role prefix', async () => {
    const result = await collapseHistory([
      msg('user', 'Hello agent'),
      msg('assistant', 'Hello human'),
    ]);
    expect(result).toContain('[user]: Hello agent');
    expect(result).toContain('[assistant]: Hello human');
  });

  it('includes tool_call items with tool name', async () => {
    const result = await collapseHistory([toolCall('send_email', 'c1', { to: 'test@example.com' })]);
    expect(result).toContain('[tool_call: send_email]');
  });

  it('includes tool_result items with callId', async () => {
    const result = await collapseHistory([toolResult('c1', { status: 'sent' })]);
    expect(result).toContain('[tool_result for c1]');
  });

  it('includes error in tool_result when present', async () => {
    const result = await collapseHistory([toolError('c1', 'Connection refused')]);
    expect(result).toContain('error: Connection refused');
  });

  it('filters out hitl_approval items', async () => {
    const result = await collapseHistory([
      msg('user', 'do it'),
      hitlItem(),
      msg('assistant', 'done'),
    ]);
    expect(result).not.toContain('hitl_approval');
    expect(result).not.toContain('approved');
    expect(result).toContain('[user]: do it');
    expect(result).toContain('[assistant]: done');
  });

  it('filters out handoff items', async () => {
    const result = await collapseHistory([
      msg('user', 'question'),
      handoffItem(),
      msg('assistant', 'answer'),
    ]);
    expect(result).not.toContain('handoff');
    expect(result).toContain('[user]: question');
  });

  it('filters out tool_results when includeToolResults=false', async () => {
    const result = await collapseHistory(
      [toolCall('send_email'), toolResult('c1', 'ok')],
      { includeToolResults: false },
    );
    expect(result).toContain('[tool_call: send_email]');
    expect(result).not.toContain('[tool_result for c1]');
  });

  it('truncates content over 500 chars', async () => {
    const longContent = 'x'.repeat(600);
    const result = await collapseHistory([msg('assistant', longContent)]);
    // Should contain truncated content with ellipsis
    expect(result).toContain('x'.repeat(500) + '…');
    expect(result).not.toContain('x'.repeat(501) + 'x');
  });

  it('respects maxItems cap by taking the last N items', async () => {
    const items: AgentRunItem[] = Array.from({ length: 10 }, (_, i) =>
      msg('user', `message ${i}`),
    );
    const result = await collapseHistory(items, { maxItems: 3 });
    expect(result).toContain('message 7');
    expect(result).toContain('message 8');
    expect(result).toContain('message 9');
    expect(result).not.toContain('message 0');
  });

  it('returns empty string if all items are filtered out', async () => {
    const result = await collapseHistory([hitlItem(), handoffItem()]);
    expect(result).toBe('');
  });
});

describe('buildInputFromItems', () => {
  it('returns empty string for empty array', () => {
    expect(buildInputFromItems([])).toBe('');
  });

  it('formats message_output as "role: content"', () => {
    const result = buildInputFromItems([msg('user', 'hello'), msg('assistant', 'world')]);
    expect(result).toContain('user: hello');
    expect(result).toContain('assistant: world');
  });

  it('formats tool_call as [tool_call: name]', () => {
    const result = buildInputFromItems([toolCall('search_web')]);
    expect(result).toContain('[tool_call: search_web]');
  });

  it('formats tool_result as [tool_result: ...]', () => {
    const result = buildInputFromItems([toolResult('c1', { answer: 42 })]);
    expect(result).toContain('[tool_result:');
    expect(result).toContain('42');
  });

  it('truncates tool_result output to 200 chars', () => {
    const bigOutput = { data: 'x'.repeat(300) };
    const result = buildInputFromItems([toolResult('c1', bigOutput)]);
    // The JSON.stringify slice is 200 chars
    expect(result.length).toBeLessThan(300);
  });

  it('omits hitl_approval and handoff items (returns empty strings filtered out)', () => {
    const result = buildInputFromItems([hitlItem(), handoffItem()]);
    expect(result).toBe('');
  });

  it('joins items with newline', () => {
    const result = buildInputFromItems([msg('user', 'a'), msg('assistant', 'b')]);
    expect(result).toBe('user: a\nassistant: b');
  });
});
