// Part 6 §D — Anthropic per-vendor mapper.

import { anthropicSDKMessageToCanonical } from '../../per-vendor/anthropic';

describe('anthropicSDKMessageToCanonical', () => {
  it('maps text + thinking + tool_use blocks on assistant turns', () => {
    const unknown = new Set<string>();
    const { message, extras } = anthropicSDKMessageToCanonical({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'consider X', signature: 'sig1' },
        { type: 'text', text: 'the answer is Y' },
        { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 42 } },
      ],
    }, unknown);

    expect(message.role).toBe('assistant');
    expect(message.content[0]).toEqual({ type: 'thinking', thinking: 'consider X', signature: 'sig1' });
    expect(message.content[1]).toEqual({ type: 'text', text: 'the answer is Y', citations: undefined });
    expect(message.content[2]).toEqual({ type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 42 } });
    expect(extras).toEqual({});
    expect(unknown.size).toBe(0);
  });

  it('preserves redacted_thinking + server_tool_use + web_search_tool_result', () => {
    const unknown = new Set<string>();
    const { message } = anthropicSDKMessageToCanonical({
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: 'encrypted-blob' },
        { type: 'server_tool_use', id: 'st1', name: 'web_search', input: { query: 'x' } },
        { type: 'web_search_tool_result', tool_use_id: 'st1', content: { hits: [] } },
      ],
    }, unknown);

    expect(message.content[0]).toEqual({ type: 'redacted_thinking', data: 'encrypted-blob' });
    expect(message.content[1]).toEqual({ type: 'server_tool_use', id: 'st1', name: 'web_search', input: { query: 'x' } });
    expect(message.content[2]).toEqual({ type: 'web_search_tool_result', tool_use_id: 'st1', content: { hits: [] } });
    expect(unknown.size).toBe(0);
  });

  it('captures tool_result on user-role messages with is_error fidelity', () => {
    const unknown = new Set<string>();
    const { message } = anthropicSDKMessageToCanonical({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'denied', is_error: true },
      ],
    }, unknown);

    expect(message.role).toBe('user');
    expect(message.content[0]).toEqual({
      type: 'tool_result', tool_use_id: 'tu1', content: 'denied', is_error: true,
    });
  });

  it('preserves unknown block types in extras.unknown_blocks and flags the metric set', () => {
    const unknown = new Set<string>();
    const { message, extras } = anthropicSDKMessageToCanonical({
      role: 'assistant',
      content: [
        { type: 'mcp_tool_use', id: 'mcp1' },                     // not in canonical schema
        { type: 'container_upload', name: 'volumes' },
      ],
    }, unknown);

    expect(message.content).toEqual([]);
    const unknownBlocks = (extras as { unknown_blocks?: Array<{ type: string }> }).unknown_blocks;
    expect(unknownBlocks).toHaveLength(2);
    expect(unknownBlocks!.map(b => b.type)).toEqual(['mcp_tool_use', 'container_upload']);
    expect(unknown.has('mcp_tool_use')).toBe(true);
    expect(unknown.has('container_upload')).toBe(true);
  });
});
