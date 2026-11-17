import {
  anthropicServerToolType,
  extractWebFetchRequests,
  toAnthropicTools,
} from '../anthropic-shared';

describe('toAnthropicTools server tool versioning', () => {
  it('gives a dynamic-filtering model the 2026 tools', () => {
    const out = toAnthropicTools(undefined, [{ name: 'web_search' }, { name: 'web_fetch' }], {
      model: 'claude-opus-5',
    });
    expect(out).toEqual([
      { type: 'web_search_20260209', name: 'web_search' },
      { type: 'web_fetch_20260209', name: 'web_fetch' },
    ]);
  });

  // Haiku 4.5 is what the `small` tier resolves to, and it is NOT a
  // dynamic-filtering model. A blanket version bump would have sent it a tool
  // it cannot run.
  it('gives a model without dynamic filtering the basic tools', () => {
    const out = toAnthropicTools(undefined, [{ name: 'web_search' }, { name: 'web_fetch' }], {
      model: 'claude-haiku-4-5',
    });
    expect(out).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
      { type: 'web_fetch_20250910', name: 'web_fetch' },
    ]);
  });

  it('an unknown model falls back to the basic tools, never the newer ones', () => {
    const out = toAnthropicTools(undefined, [{ name: 'web_search' }], {
      model: 'some-future-model',
    });
    expect(out).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
  });

  // These two cases used to assert the VERTEX platform's narrower surface:
  // Claude over Google Vertex carried the basic search and no fetch at all, so
  // the fetch was dropped rather than sent under a type it would reject. That
  // provider is retired and the platform parameter went with it — every caller
  // is first-party now. What survives is the null contract itself, which is
  // still how an unofferable tool is refused.
  it('anthropicServerToolType reports null for a tool it does not know', () => {
    expect(anthropicServerToolType('not_a_server_tool', 'claude-opus-5')).toBeNull();
  });

  it('respects an explicit `type` override for unknown server tools', () => {
    const out = toAnthropicTools(undefined, [{ name: 'custom_tool', type: 'custom_v1' }]);
    expect(out).toEqual([{ type: 'custom_v1', name: 'custom_tool' }]);
  });

  it('merges user tools with server tools', () => {
    const out = toAnthropicTools(
      [{ name: 'lookup', description: 'd', input_schema: { type: 'object', properties: {} } }],
      [{ name: 'web_fetch' }],
    );
    expect(out).toHaveLength(2);
    expect((out as any[])[0].name).toBe('lookup');
    expect((out as any[])[1].name).toBe('web_fetch');
  });

  it('returns undefined when both arrays empty', () => {
    expect(toAnthropicTools(undefined, undefined)).toBeUndefined();
    expect(toAnthropicTools([], [])).toBeUndefined();
  });
});

describe('extractWebFetchRequests', () => {
  it('reads server_tool_use.web_fetch_requests', () => {
    expect(
      extractWebFetchRequests({ server_tool_use: { web_fetch_requests: 3 } }),
    ).toBe(3);
  });

  it('returns 0 when absent', () => {
    expect(extractWebFetchRequests(undefined)).toBe(0);
    expect(extractWebFetchRequests({})).toBe(0);
    expect(extractWebFetchRequests({ server_tool_use: {} })).toBe(0);
  });

  it('returns 0 for non-numeric value', () => {
    expect(
      extractWebFetchRequests({ server_tool_use: { web_fetch_requests: 'x' } }),
    ).toBe(0);
  });
});
