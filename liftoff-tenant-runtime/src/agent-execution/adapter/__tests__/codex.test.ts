// CodexAdapter unit tests. @openai/codex-sdk is mocked so no live CLI runs; the
// thread yields synthetic ThreadEvents and we assert the mapping, session id,
// usage, and HITL pause (driven via the shared BridgeContext the http-mcp proxy
// mock exposes).

const mockRunStreamed = jest.fn();
let capturedBridgeCtx: { pendingHitlGate: unknown; pendingDelegationPause: unknown; abort?: () => void } | null = null;

// The adapter loads @openai/codex-sdk via esmImport (dynamic ESM import); mock
// that loader so the Codex class is our stub.
let capturedCodexOpts: unknown = null;
let capturedThreadOpts: unknown = null;
jest.mock('../esm-import', () => {
  class Codex {
    constructor(public opts: unknown) { capturedCodexOpts = opts; }
    startThread(opts: unknown) { capturedThreadOpts = opts; return { id: 'thread-1', runStreamed: (...a: unknown[]) => mockRunStreamed(...a) }; }
    resumeThread(_id: string, opts: unknown) { capturedThreadOpts = opts; return { id: 'thread-1', runStreamed: (...a: unknown[]) => mockRunStreamed(...a) }; }
  }
  return { esmImport: async () => ({ Codex }) };
});
jest.mock('../tool-gateway-http-mcp', () => ({
  exposeCatalogOverHttp: jest.fn(async (_cat: unknown, ctx: never) => {
    capturedBridgeCtx = ctx;
    return { url: 'http://127.0.0.1:1/mcp', bearerToken: 'tok', close: jest.fn().mockResolvedValue(undefined) };
  }),
}));
jest.mock('../mcp-client-pool', () => ({ getMcpClientPool: () => ({ releaseAll: jest.fn().mockResolvedValue(undefined) }) }));

import { CodexAdapter } from '../codex';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, InvocationEvent } from '../types';
import { makeRecorder, releaseBuffer } from '../../../trajectories/recorder';

function makeCatalog(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'srv', config: {} } as McpToolCatalog['servers'][number]],
    tools: [{ name: 'my_tool', description: 'd', inputSchema: { type: 'object' }, serverId: 'srv' }],
  };
}
function makeInput(): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    systemPrompt: 'sys', model: 'gpt-5-codex', provider: 'openai', tenantId: 't1', invocationId: 'inv1',
  };
}
async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
function events(...evs: unknown[]) {
  return { events: (async function* () { for (const e of evs) yield e; })() };
}

beforeEach(() => { mockRunStreamed.mockReset(); capturedBridgeCtx = null; capturedThreadOpts = null; });

describe('CodexAdapter', () => {
  it('registers the governed server with Codex’s own tool approval switched off', async () => {
    // Codex asks for approval of any MCP call whose tool is not annotated
    // read-only when the sandbox is read-only — even under approvalPolicy
    // 'never' — and an SDK thread has nobody to answer: every call resolved
    // to Abort, "user cancelled MCP tool call", on the first live run in a
    // month. Our gate judges every call before it dispatches; Codex's prompt
    // is a second question nobody can answer.
    mockRunStreamed.mockReturnValue(events({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
    const adapter = new CodexAdapter();
    adapter.registerToolCatalog(makeCatalog());
    await drain(adapter.invoke(makeInput(), new AbortController().signal));
    const servers = (capturedCodexOpts as { config: { mcp_servers: Record<string, Record<string, unknown>> } }).config.mcp_servers;
    expect(servers.liftoff).toEqual({
      url: 'http://127.0.0.1:1/mcp',
      http_headers: { Authorization: 'Bearer tok' },
      default_tools_approval_mode: 'approve',
    });
  });

  it('maps Codex ThreadEvents to InvocationEvents and completes', async () => {
    mockRunStreamed.mockResolvedValueOnce(events(
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'hello' } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3, cached_input_tokens: 0, reasoning_output_tokens: 0 } },
    ));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const types = out.map((e) => e.type);
    expect(types).toContain('session_started');
    expect(types).toContain('assistant_message');
    expect(types).toContain('usage');
    expect(out[out.length - 1].type).toBe('completion');
    expect((out[out.length - 1] as { outcome: string }).outcome).toBe('success');
  });

  it('emits tool_call events for mcp_tool_call items', async () => {
    mockRunStreamed.mockResolvedValueOnce(events(
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.started', item: { id: 'c1', type: 'mcp_tool_call', server: 'liftoff', tool: 'my_tool', arguments: { x: 1 }, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'c1', type: 'mcp_tool_call', server: 'liftoff', tool: 'my_tool', arguments: { x: 1 }, status: 'completed', result: { content: [], structured_content: null } } },
    ));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out.find((e) => e.type === 'tool_call_started')).toBeTruthy();
    expect(out.find((e) => e.type === 'tool_call_finished')).toBeTruthy();
  });

  it('sink enabled: recording codex_thread_item events never turns the turn into an error', async () => {
    mockRunStreamed.mockResolvedValueOnce(events(
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'hello' } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3, cached_input_tokens: 0, reasoning_output_tokens: 0 } },
    ));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    const input = makeInput();
    // Registering the real recorder makes the adapter tap recordRaw with
    // rawKind 'codex_thread_item' for every ThreadEvent. Before the
    // recorder threw on that kind and the outer catch yielded completion:error.
    a.registerTrajectoryRecorder(makeRecorder(input.invocationId));
    const out = await drain(a.invoke(input, new AbortController().signal));
    const last = out[out.length - 1];
    expect(last.type).toBe('completion');
    expect((last as { outcome: string }).outcome).toBe('success');
    releaseBuffer(input.invocationId);
  });

  it('surfaces a provider error event as completion error, never empty success (usage/billing)', async () => {
    mockRunStreamed.mockResolvedValueOnce(events(
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'error', message: 'upstream 500' },
    ));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1] as { type: string; outcome: string; reason?: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('error');
    expect(last.reason).toContain('upstream 500');
    // No assistant_message was emitted → this is a real failure, not zero-cost success.
    expect(out.some((e) => e.type === 'assistant_message')).toBe(false);
  });

  it('pauses on HITL when the proxy sets pendingHitlGate mid-stream', async () => {
    mockRunStreamed.mockImplementationOnce(async () => ({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-1' };
        // Proxy dispatch (elsewhere) trips the gate on the shared bridge ctx.
        if (capturedBridgeCtx) capturedBridgeCtx.pendingHitlGate = { gateReason: 'approve me', pendingToolCalls: [] };
        yield { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'x' } };
      })(),
    }));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1];
    expect(last.type).toBe('pause_requested');
    expect((last as { reason: string }).reason).toBe('hitl_gate');
  });

  it('pauses on HITL when the bridge aborts the stream the moment it gates, and the SDK throws before another event', async () => {
    // What the bridge actually does (mcp-bridge.ts): stash the gate AND call
    // context.abort(), so the SDK's stream rejects with an AbortError before
    // any further event arrives. If only the per-event check reads the stash,
    // that abort reaches the loop as "codex invoke failed: The operation was
    // aborted" — a failed turn and no approval row.
    mockRunStreamed.mockImplementationOnce(async (_input: unknown, opts: { signal: AbortSignal }) => ({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-1' };
        if (capturedBridgeCtx) {
          capturedBridgeCtx.pendingHitlGate = { gateReason: 'contract_deviation', pendingToolCalls: [] };
          capturedBridgeCtx.abort?.();
        }
        if (opts.signal.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        yield { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'never reached' } };
      })(),
    }));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1];
    expect(last.type).toBe('pause_requested');
    expect((last as { reason: string; gateContext: { gateReason: string } }).reason).toBe('hitl_gate');
    expect((last as { gateContext: { gateReason: string } }).gateContext.gateReason).toBe('contract_deviation');
    expect(out.some((e) => e.type === 'completion')).toBe(false);
    // Consumed: a second read of the stash finds nothing.
    expect(capturedBridgeCtx?.pendingHitlGate).toBeNull();
  });

  it('a stream that ends in an error event after the bridge gated still pauses rather than failing', async () => {
    mockRunStreamed.mockImplementationOnce(async () => ({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-1' };
        if (capturedBridgeCtx) capturedBridgeCtx.pendingHitlGate = { gateReason: 'sensitive_work', pendingToolCalls: [] };
        yield { type: 'error', message: 'The operation was aborted' };
      })(),
    }));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out[out.length - 1].type).toBe('pause_requested');
    expect(out.some((e) => e.type === 'completion')).toBe(false);
  });

  it('an abort with nothing stashed is still the error it always was', async () => {
    mockRunStreamed.mockImplementationOnce(async () => ({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-1' };
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      })(),
    }));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out[out.length - 1]).toMatchObject({ type: 'completion', outcome: 'error', reason: 'The operation was aborted' });
  });
});

// OpenAI's own hosted search, live and counted — the rule every engine
// follows (grounding-cost.ts). Two things fail silently here: leaving the
// mode to the CLI runs its `cached` index instead of the live search the wire
// offers, and not counting the items bills every search at $0 on our side.
describe('Codex web search is OpenAI\'s own, live, and counted', () => {
  it('pins live search on a fresh thread and on a resumed one', async () => {
    mockRunStreamed.mockReturnValue(events({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(capturedThreadOpts).toEqual(expect.objectContaining({ webSearchMode: 'live', sandboxMode: 'read-only', networkAccessEnabled: false }));

    capturedThreadOpts = null;
    const token = { adapterKind: 'codex', serialized: JSON.stringify({ reason: 'ask_user', input: makeInput(), threadId: 'thread-1' }) };
    await drain(a.resume(token, { text: 'go' }, new AbortController().signal));
    expect(capturedThreadOpts).toEqual(expect.objectContaining({ webSearchMode: 'live' }));
  });

  it('counts each completed web_search item onto the turn\'s usage event', async () => {
    mockRunStreamed.mockResolvedValueOnce(events(
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.started', item: { id: 'ws1', type: 'web_search', query: 'liftoff pricing' } },
      { type: 'item.completed', item: { id: 'ws1', type: 'web_search', query: 'liftoff pricing' } },
      { type: 'item.completed', item: { id: 'ws2', type: 'web_search', query: 'liftoff founders' } },
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'found it' } },
      { type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 20, cached_input_tokens: 0 } },
    ));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const usage = out.find((e) => e.type === 'usage') as { usage: { webSearchRequests?: number } };
    expect(usage.usage.webSearchRequests).toBe(2);
    // Surfaced the way the wire surfaces its own: a started/finished pair
    // named web_search, so the search is visible in the run.
    const started = out.filter((e) => e.type === 'tool_call_started') as Array<{ toolName: string; args: Record<string, unknown> }>;
    expect(started.map((e) => e.toolName)).toEqual(['web_search']);
    expect(started[0].args).toEqual({ query: 'liftoff pricing' });
    expect(out.filter((e) => e.type === 'tool_call_finished')).toHaveLength(2);
  });

  it('reports no count at all on a turn that searched nothing, rather than zero', async () => {
    mockRunStreamed.mockResolvedValueOnce(events(
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3, cached_input_tokens: 0 } },
    ));
    const a = new CodexAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const usage = out.find((e) => e.type === 'usage') as { usage: { webSearchRequests?: number } };
    expect(usage.usage.webSearchRequests).toBeUndefined();
  });
});
