// How big are DIRECT MCP results?
//
// Nobody knew, and the reason is structural rather than careless: a
// vendor-hosted server (GitHub, Notion, Stripe) and a workspace's own custom
// MCP server dispatch over the Claude Agent SDK's own transport, so they never
// reach the in-process tool gateway where every other tool result is measured,
// parked and bounded. The PostToolUse hook is the one place on this engine that
// sees them.
//
// MEASURED ONLY, and deliberately: parking a vendor's envelope means deciding
// per server what is safe to replace, and that decision is worth taking with a
// live distribution in hand rather than by analogy with a path that carries
// different traffic. What these assert is that the two populations stay
// separable — the gateway's tools must NOT be measured twice, or the
// distribution the decision is read from is the wrong one.

// The adapter imports query/AbortError from @anthropic-ai/claude-agent-sdk,
// which is ESM and not transformed by jest. Nothing here invokes the SDK, but
// the import has to resolve.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
  AbortError: class AbortError extends Error {
    constructor() { super('aborted'); this.name = 'AbortError'; }
  },
}));

const observed: Array<[string, unknown, string | undefined]> = [];
jest.mock('../../../tool-gateway/observe-result-size', () => ({
  observeDirectMcpResultSize: (name: string, result: unknown, invocationId: string | undefined) => {
    observed.push([name, result, invocationId]);
  },
}));

import { AnthropicAdapter } from '../anthropic';
import type { InvocationInput } from '../types';
import type { McpToolCatalog } from '../catalog-types';

const makeCatalog = (): McpToolCatalog => ({ servers: [], tools: [] } as unknown as McpToolCatalog);

const makeInput = (): InvocationInput => ({
  messages: [],
  systemPrompt: 'system',
  model: 'claude-opus-5',
  provider: 'anthropic',
  tenantId: 't1',
  invocationId: 'inv-direct-1',
  maxTurns: 5,
} as unknown as InvocationInput);

function hookFor(adapter: AnthropicAdapter) {
  (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput();
  return (adapter as unknown as {
    makePostToolUseHook(): (
      input: { tool_name?: string; tool_response?: { is_error?: boolean; content?: unknown } },
      toolUseID: string | undefined,
    ) => Promise<unknown>;
  }).makePostToolUseHook();
}

beforeEach(() => {
  observed.length = 0;
});

describe('PostToolUse measures a direct MCP result', () => {
  it('measures a vendor-hosted server result, with the invocation it belongs to', async () => {
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog(makeCatalog());
    const response = { is_error: false, content: [{ type: 'text', text: 'z'.repeat(70_000) }] };
    await hookFor(adapter)({ tool_name: 'mcp__github__list_issues', tool_response: response }, 'tu-1');

    expect(observed).toEqual([['mcp__github__list_issues', response, 'inv-direct-1']]);
  });

  it('measures a workspace\'s own custom MCP server the same way', async () => {
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog(makeCatalog());
    await hookFor(adapter)({ tool_name: 'mcp__acme-internal__query', tool_response: { is_error: false, content: [] } }, 'tu-2');
    expect(observed.map((o) => o[0])).toEqual(['mcp__acme-internal__query']);
  });

  it('measures an ERROR result too: a size is a size', async () => {
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog(makeCatalog());
    await hookFor(adapter)({ tool_name: 'mcp__notion__search', tool_response: { is_error: true, content: 'nope' } }, 'tu-3');
    expect(observed.map((o) => o[0])).toEqual(['mcp__notion__search']);
  });
});

describe('PostToolUse does NOT measure what the gateway already measures', () => {
  it('leaves our own gateway\'s tools alone — they are measured, parked and bounded above the engine', async () => {
    // Counting them here as well would double the denominator the threshold is
    // calibrated from, and would put a result the gateway PARKED into a
    // population whose whole point is that nothing parks it.
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog(makeCatalog());
    await hookFor(adapter)({
      tool_name: 'mcp__liftoff-tool-gateway__slack-d77db9a0__send_message',
      tool_response: { is_error: false, content: [{ type: 'text', text: 'x'.repeat(70_000) }] },
    }, 'tu-4');
    expect(observed).toEqual([]);
  });

  it('leaves the SDK\'s built-in tools alone — they are not MCP at all', async () => {
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog(makeCatalog());
    await hookFor(adapter)({ tool_name: 'Bash', tool_response: { is_error: false, content: 'ok' } }, 'tu-5');
    expect(observed).toEqual([]);
  });
});
