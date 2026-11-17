/**
 * A REAL MCP client, against the REAL proxy, over a real socket.
 *
 * This is the gate that was missing. Five changes to this seam shipped green —
 * unit tests, source-contract tests, lint, typecheck, build, and the deploy's
 * own fault-injection and canary steps — and each one failed on the first thing
 * a person did:
 *
 *   - the transport moved from buffered JSON to SSE, and nothing here had ever
 *     spoken the protocol to check a client could still call a tool;
 *   - a dispatcher went onto a `fetch` that cannot take a `Request`, silenced
 *     with `as never`, and a source test confirmed the words were present while
 *     the code could not run at all.
 *
 * A source test reads the file. This one speaks MCP: initialize, tools/list,
 * tools/call, and reads what comes back. It fails if the proxy stops being a
 * server its clients can use, whatever the source happens to say.
 */
const dispatched: Array<{ name: string; args: unknown }> = [];
let dispatchImpl: (name: string, args: unknown) => Promise<unknown> = async (name) => ({
  content: [{ type: 'text', text: `ran ${name}` }],
});
jest.mock('../mcp-bridge', () => ({
  dispatchFunctionCall: (_catalog: unknown, name: string, args: unknown) => {
    dispatched.push({ name, args });
    return dispatchImpl(name, args);
  },
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { exposeCatalogOverHttp, type ToolGatewayHttpMcp } from '../tool-gateway-http-mcp';
import type { BridgeContext } from '../mcp-bridge';
import type { McpToolCatalog } from '../catalog-types';

const catalog: McpToolCatalog = {
  servers: [],
  tools: [{ name: 'web_fetch_advanced', description: 'read a page', inputSchema: { type: 'object' }, serverId: 'web' }],
};
const context = {
  tenantId: 't', invocationId: 'inv', hitlGate: null, anomalyHandler: null, recordedCalls: new Set<string>(),
  pendingHitlGate: null, pendingDelegationPause: null, abort: () => undefined, onRecoveryInject: () => undefined,
} as unknown as BridgeContext;

/** A client connected the way a subprocess engine connects. */
async function connect(proxy: ToolGatewayHttpMcp) {
  const client = new Client({ name: 'test-engine', version: '1' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(proxy.url), {
    requestInit: { headers: { Authorization: `Bearer ${proxy.bearerToken}` } },
  });
  await client.connect(transport);
  return { client, close: () => client.close().catch(() => undefined) };
}

describe('the proxy is a server its clients can actually use', () => {
  let proxy: ToolGatewayHttpMcp;

  beforeEach(async () => {
    dispatched.length = 0;
    dispatchImpl = async (name) => ({ content: [{ type: 'text', text: `ran ${name}` }] });
    // Short enough that a test can observe a heartbeat; 15 s in production.
    process.env.TOOL_PROGRESS_INTERVAL_MS = '50';
    proxy = await exposeCatalogOverHttp(catalog, context);
  });
  afterEach(async () => { delete process.env.TOOL_PROGRESS_INTERVAL_MS; await proxy.close(); });

  it('lists the catalog', async () => {
    const { client, close } = await connect(proxy);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain('web_fetch_advanced');
    } finally { await close(); }
  });

  it('calls a tool and returns its result', async () => {
    // The end-to-end property: a client speaks the protocol, the bridge runs,
    // and the answer comes back. The SSE switch changed how this is delivered
    // and nothing checked a client could still read it.
    const { client, close } = await connect(proxy);
    try {
      const res = await client.callTool({ name: 'web_fetch_advanced', arguments: { url: 'https://example.test' } });
      expect(dispatched).toEqual([{ name: 'web_fetch_advanced', args: { url: 'https://example.test' } }]);
      expect(JSON.stringify(res.content)).toContain('ran web_fetch_advanced');
    } finally { await close(); }
  });

  it('a slow call reports progress to the client while it runs', async () => {
    // THE REASON THE TRANSPORT IS SSE, and the assertion that actually pins it.
    //
    // A buffered JSON response holds every message until the end, so a progress
    // notification has nowhere to go. An engine waiting on a long call then has
    // no signal and falls back to a flat timeout — which is the defect the SSE
    // switch exists for. An earlier version of this test only checked that the
    // RESULT came back, which is true in either mode, so it passed against the
    // very regression it was written to catch.
    const progress: unknown[] = [];
    dispatchImpl = async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { content: [{ type: 'text', text: 'slow result' }] };
    };
    const { client, close } = await connect(proxy);
    try {
      const res = await client.callTool(
        { name: 'web_fetch_advanced', arguments: {} },
        undefined,
        { onprogress: (p: unknown) => progress.push(p) },
      );
      expect(JSON.stringify(res.content)).toContain('slow result');
      expect(progress.length).toBeGreaterThan(0);
    } finally { await close(); }
  });

  it('an error from the bridge reaches the client as a tool error, not a dead socket', async () => {
    dispatchImpl = async () => ({ error: 'refused by the gate' });
    const { client, close } = await connect(proxy);
    try {
      const res = await client.callTool({ name: 'web_fetch_advanced', arguments: {} });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('refused by the gate');
    } finally { await close(); }
  });
});
