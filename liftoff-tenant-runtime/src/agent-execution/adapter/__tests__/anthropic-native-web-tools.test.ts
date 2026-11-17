// PR-A audit fix #2/#3: native Anthropic web search/fetch wiring.
// Asserts the shared constant AND that the adapter passes WebSearch/WebFetch
// into query()'s allowedTools — so dropping them at the call site fails CI.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  AbortError: class AbortError extends Error {},
  // Empty async-iterable Query; methods are no-ops in case the adapter touches them.
  query: jest.fn(() => {
    const it = (async function* () { /* no messages */ })();
    return Object.assign(it, { interrupt: jest.fn(), setPermissionMode: jest.fn() });
  }),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { AnthropicAdapter } from '../anthropic';
import { ANTHROPIC_NATIVE_WEB_TOOLS } from '../anthropic/native-web-tools';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput } from '../types';

function makeInput(): InvocationInput {
  return { messages: [], systemPrompt: 's', model: 'claude-x', provider: 'anthropic', tenantId: 't1', invocationId: 'inv1', maxTurns: 5 };
}

describe('ANTHROPIC_NATIVE_WEB_TOOLS', () => {
  it('is exactly the SDK built-in web tool names', () => {
    expect(ANTHROPIC_NATIVE_WEB_TOOLS).toEqual(['WebSearch', 'WebFetch']);
  });
});

describe('AnthropicAdapter — query allowedTools wiring (call site)', () => {
  it('passes WebSearch and WebFetch into allowedTools', async () => {
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog({ servers: [], tools: [] } as McpToolCatalog);
    try {
      for await (const _ of adapter.invoke(makeInput(), new AbortController().signal)) { void _; }
    } catch { /* post-stream behavior is irrelevant; query() was already called */ }

    expect((query as jest.Mock)).toHaveBeenCalled();
    const opts = (query as jest.Mock).mock.calls[0][0].options;
    expect(opts.allowedTools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
  });

  it('pins adaptive thinking WITH an effort level (Claude 5+ reject enabled-without-effort)', async () => {
    // claude-opus-5 rejects `thinking.type.enabled` and demands
    // `thinking.type.adaptive` + `output_config.effort` (the SDK `effort`
    // option). Dropping either silently makes every opus-5 run emit the API
    // error as its assistant text — so both must be pinned at the call site.
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog({ servers: [], tools: [] } as McpToolCatalog);
    try {
      for await (const _ of adapter.invoke(makeInput(), new AbortController().signal)) { void _; }
    } catch { /* post-stream behavior irrelevant; query() options already captured */ }

    const opts = (query as jest.Mock).mock.calls[0][0].options;
    expect(opts.thinking).toEqual({ type: 'adaptive' });
    expect(opts.effort).toBe('medium');
  });
});
