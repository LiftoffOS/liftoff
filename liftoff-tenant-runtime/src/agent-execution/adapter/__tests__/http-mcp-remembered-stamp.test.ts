// The HTTP MCP engines learn that a call was remembered from the result itself.
//
// Codex and opencode run in another process and reach the governed seam as a
// remote MCP server; their MCP client carries no model call id, and the
// finished event each later emits carries an id the bridge never saw. The
// proxy therefore dispatches under an id of its own and hands it back on the
// result's `_meta` — the id always, so a record the stream does redo lands on
// the same ledger row, and the outcome only when the bridge's observer said
// the record exists. Driven over the REAL proxy and the REAL MCP client, so
// the stamp is shown to survive the SDK's result schema, with the bridge
// replaced by a stand-in that keeps its one relevant contract: it awaits the
// observer, and marks the call under the id it was handed only on true.

const observer = jest.fn<Promise<boolean>, [unknown]>();
/** What the vendor's server answered, as the bridge would hand it back. */
let vendorResult: Record<string, unknown> = { content: [{ type: 'text', text: JSON.stringify({ number: 123 }) }], _meta: { vendor: 'kept' } };
jest.mock('../mcp-bridge', () => ({
  // The bridge's one relevant contract, kept exactly: await the observer,
  // mark under the id it was handed only on a true answer, never on a throw.
  dispatchFunctionCall: async (
    _catalog: unknown, name: string, args: Record<string, unknown>,
    context: { toolResultObserver?: (o: unknown) => Promise<boolean>; recordedCalls?: Set<string> },
    call?: { callId?: string },
  ) => {
    const result = vendorResult;
    try {
      const remembered = await context.toolResultObserver?.({ toolName: name, args, callId: call?.callId, result });
      if (remembered && call?.callId) context.recordedCalls?.add(call.callId);
    } catch {
      // the real bridge logs and proceeds
    }
    return result;
  },
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { exposeCatalogOverHttp } from '../tool-gateway-http-mcp';
import type { BridgeContext } from '../mcp-bridge';
import type { McpToolCatalog } from '../catalog-types';
import { CodexAdapter } from '../codex';
import { OpencodeAdapter } from '../opencode';
import { DISPATCH_CALL_ID_META, RECORDED_AT_DISPATCH_META } from '../remembered-stamp';

const catalog: McpToolCatalog = {
  servers: [],
  tools: [{ name: 'github-dd4c4689__pull_request_read', description: 'd', inputSchema: { type: 'object' }, serverId: 'github-dd4c4689' }],
};

async function callThroughProxy(): Promise<{ meta: Record<string, unknown> | undefined; metadata: unknown; recordedCalls: Set<string> }> {
  const recordedCalls = new Set<string>();
  const context = {
    tenantId: 't', invocationId: 'inv', hitlGate: null, anomalyHandler: null,
    toolResultObserver: (o: unknown) => observer(o), recordedCalls,
    pendingHitlGate: null, pendingDelegationPause: null, abort: () => undefined, onRecoveryInject: () => undefined,
  } as unknown as BridgeContext;
  const proxy = await exposeCatalogOverHttp(catalog, context);
  try {
    const client = new Client({ name: 'engine', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(proxy.url), {
      requestInit: { headers: { authorization: `Bearer ${proxy.bearerToken}` } },
    });
    await client.connect(transport);
    const result = await client.callTool({ name: 'github-dd4c4689__pull_request_read', arguments: { pullNumber: 123 } });
    await client.close();
    const r = result as { _meta?: Record<string, unknown>; metadata?: unknown };
    return { meta: r._meta, metadata: r.metadata, recordedCalls };
  } finally {
    await proxy.close();
  }
}

beforeEach(() => {
  observer.mockReset();
  vendorResult = { content: [{ type: 'text', text: JSON.stringify({ number: 123 }) }], _meta: { vendor: 'kept' } };
});

describe('the proxy serves a whole session', () => {
  it('answers the handshake, the listing and every call after it, over one connection', async () => {
    // A stateless transport answers one request; the SDK refuses a second
    // with "Stateless transport cannot be reused across requests", surfaced
    // as a bodiless 500. Built once for the proxy's lifetime, it answered
    // `initialize` and nothing after — every tool call on both engines
    // failed at the handshake, unnoticed for as long as neither ran.
    observer.mockResolvedValue(true);
    const recordedCalls = new Set<string>();
    const context = {
      tenantId: 't', invocationId: 'inv', hitlGate: null, anomalyHandler: null,
      toolResultObserver: (o: unknown) => observer(o), recordedCalls,
      pendingHitlGate: null, pendingDelegationPause: null, abort: () => undefined, onRecoveryInject: () => undefined,
    } as unknown as BridgeContext;
    const proxy = await exposeCatalogOverHttp(catalog, context);
    try {
      const client = new Client({ name: 'engine', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: { authorization: `Bearer ${proxy.bearerToken}` } },
      }));
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(['github-dd4c4689__pull_request_read']);
      const first = await client.callTool({ name: 'github-dd4c4689__pull_request_read', arguments: { pullNumber: 1 } });
      const second = await client.callTool({ name: 'github-dd4c4689__pull_request_read', arguments: { pullNumber: 2 } });
      expect((first as { isError?: boolean }).isError).toBeFalsy();
      expect((second as { isError?: boolean }).isError).toBeFalsy();
      expect(observer).toHaveBeenCalledTimes(2);
      await client.close();
    } finally {
      await proxy.close();
    }
  });

  it('refuses a caller without the bearer token', async () => {
    const proxy = await exposeCatalogOverHttp(catalog, {} as unknown as BridgeContext);
    try {
      const r = await fetch(proxy.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(401);
    } finally {
      await proxy.close();
    }
  });
});

describe('the proxy stamps the result', () => {
  it('with the id and the outcome when the record landed, keeping the vendor’s own _meta', async () => {
    observer.mockResolvedValue(true);
    const { meta, metadata, recordedCalls } = await callThroughProxy();
    expect(meta).toEqual({ vendor: 'kept', [DISPATCH_CALL_ID_META]: expect.any(String), [RECORDED_AT_DISPATCH_META]: true });
    // And the same stamp on the top-level key opencode forwards, through the
    // real client's result schema.
    expect(metadata).toEqual({ [DISPATCH_CALL_ID_META]: meta![DISPATCH_CALL_ID_META], [RECORDED_AT_DISPATCH_META]: true });
    // The bridge was handed the same id the stamp carries, and the mark was
    // consumed on the way back rather than left to grow.
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ callId: meta![DISPATCH_CALL_ID_META] }));
    expect(recordedCalls.size).toBe(0);
  });

  it('with the id ALONE when the record did not land', async () => {
    observer.mockResolvedValue(false);
    const { meta } = await callThroughProxy();
    expect(meta).toEqual({ vendor: 'kept', [DISPATCH_CALL_ID_META]: expect.any(String) });
    expect(meta).not.toHaveProperty(RECORDED_AT_DISPATCH_META);
  });
});

describe('a vendor cannot forge the stamp', () => {
  // The reserved keys are the proxy's alone. A server that answered with
  // `liftoff/recordedAtDispatch: true` on its own result — on `_meta`, on
  // `metadata`, or both — must come out unmarked whenever the observer did
  // not say the record exists, whatever it said and whether it said anything.
  const FORGED = { [DISPATCH_CALL_ID_META]: 'forged-id', [RECORDED_AT_DISPATCH_META]: true, vendor: 'kept' };
  beforeEach(() => {
    vendorResult = { content: [{ type: 'text', text: '{}' }], _meta: { ...FORGED }, metadata: { ...FORGED } };
  });

  it.each([
    ['answered false', () => observer.mockResolvedValue(false)],
    ['threw', () => observer.mockRejectedValue(new Error('store down'))],
    ['timed out and answered false late', () => observer.mockImplementation(() => new Promise((r) => setTimeout(() => r(false), 30)))],
  ])('when the observer %s: the id is the proxy’s and there is no outcome', async (_label, arrange) => {
    arrange();
    const { meta, metadata } = await callThroughProxy();
    for (const stamp of [meta, metadata as Record<string, unknown>]) {
      expect(stamp).toEqual({ vendor: 'kept', [DISPATCH_CALL_ID_META]: expect.any(String) });
      expect(stamp![DISPATCH_CALL_ID_META]).not.toBe('forged-id');
      expect(stamp).not.toHaveProperty(RECORDED_AT_DISPATCH_META);
    }
    // And the adapters, reading what arrived, mark nothing.
    const codex = new CodexAdapter() as unknown as { translateItem(item: unknown, phase: string): Array<Record<string, unknown>> };
    const ev = codex.translateItem({ type: 'mcp_tool_call', id: 'i', tool: 't', arguments: {}, result: { content: [], _meta: meta } }, 'item.completed')
      .find((e) => e.type === 'tool_call_finished')!;
    expect(ev.recordedAtDispatch).toBeUndefined();
  });

  it('when the observer answered true: the outcome is the proxy’s, under the proxy’s id', async () => {
    observer.mockResolvedValue(true);
    const { meta } = await callThroughProxy();
    expect(meta![RECORDED_AT_DISPATCH_META]).toBe(true);
    expect(meta![DISPATCH_CALL_ID_META]).not.toBe('forged-id');
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ callId: meta![DISPATCH_CALL_ID_META] }));
  });
});

describe('the adapters read the stamp off the engine’s finished event', () => {
  const stamped = { [DISPATCH_CALL_ID_META]: 'bridge-7', [RECORDED_AT_DISPATCH_META]: true };
  const idOnly = { [DISPATCH_CALL_ID_META]: 'bridge-8' };

  it('Codex: on the item’s result._meta', () => {
    const t = new CodexAdapter() as unknown as { translateItem(item: unknown, phase: string): Array<Record<string, unknown>> };
    const finished = (meta: unknown) => t.translateItem(
      { type: 'mcp_tool_call', id: 'item-1', tool: 'github-dd4c4689__pull_request_read', arguments: {}, result: { content: [], _meta: meta } },
      'item.completed',
    ).find((e) => e.type === 'tool_call_finished')!;
    expect(finished(stamped)).toMatchObject({ callId: 'item-1', dispatchCallId: 'bridge-7', recordedAtDispatch: true });
    const unmarked = finished(idOnly);
    expect(unmarked).toMatchObject({ callId: 'item-1', dispatchCallId: 'bridge-8' });
    expect(unmarked.recordedAtDispatch).toBeUndefined();
    const bare = finished(undefined);
    expect(bare.dispatchCallId).toBeUndefined();
    expect(bare.recordedAtDispatch).toBeUndefined();
  });

  it('opencode: flat on the completed state’s metadata, beside opencode’s own keys', () => {
    const t = new OpencodeAdapter() as unknown as { translateEvent(e: unknown): Array<Record<string, unknown>> };
    const finished = (meta: unknown) => t.translateEvent({
      type: 'message.part.updated',
      properties: { part: { type: 'tool', callID: 'call-1', tool: 'github-dd4c4689__pull_request_read', state: { status: 'completed', input: {}, output: '{"number":123}', metadata: { ...(meta as object ?? {}), truncated: false } } } },
    }).find((e) => e.type === 'tool_call_finished')!;
    expect(finished(stamped)).toMatchObject({ callId: 'call-1', dispatchCallId: 'bridge-7', recordedAtDispatch: true });
    expect(finished(idOnly).recordedAtDispatch).toBeUndefined();
    expect(finished(idOnly).dispatchCallId).toBe('bridge-8');
  });

  it('opencode: reports the catalog’s tool name, not its own server-prefixed one', () => {
    // opencode names a served tool `<server>_<tool>`; the stream seams resolve
    // names against the catalog, where the prefixed name matched nothing.
    const t = new OpencodeAdapter() as unknown as { translateEvent(e: unknown): Array<Record<string, unknown>> };
    const started = t.translateEvent({
      type: 'message.part.updated',
      properties: { part: { type: 'tool', callID: 'call-2', tool: 'liftoff_call_github_dd4c4689_tool', state: { status: 'running', input: { name: 'pull_request_read' } } } },
    }).find((e) => e.type === 'tool_call_started')!;
    expect(started.toolName).toBe('call_github_dd4c4689_tool');
  });
});
