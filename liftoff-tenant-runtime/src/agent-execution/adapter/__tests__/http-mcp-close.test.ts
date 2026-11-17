// Shutdown of an external-process engine does not wait on its own connections.
//
// On the first opencode run on a fresh instance, closing after an approval
// pause took ~300s, twice. The local MCP server's close() waited for every open
// connection to end, and the engine held one with a call parked on the
// approval: an in-flight request that only Node's own 300s request timeout
// ended. The close now drops those connections, and each shutdown step is
// bounded besides. Driven with a REAL server and a real client connection that
// is kept alive with a request in flight.

let parked: Array<() => void> = [];
jest.mock('../mcp-bridge', () => ({
  // A call parked on an approval: it does not return until someone answers.
  dispatchFunctionCall: () => new Promise((resolve) => { parked.push(() => resolve({ content: [] })); }),
}));
const mockWarn = jest.fn();
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), error: jest.fn(), debug: jest.fn() },
}));

import http from 'http';
import { exposeCatalogOverHttp } from '../tool-gateway-http-mcp';
import { settleShutdownStep, SHUTDOWN_STEP_GRACE_MS } from '../opencode';
import type { BridgeContext } from '../mcp-bridge';
import type { McpToolCatalog } from '../catalog-types';

const catalog: McpToolCatalog = {
  servers: [],
  tools: [{ name: 'github__merge_pull_request', description: 'd', inputSchema: { type: 'object' }, serverId: 'github' }],
};
const context = {
  tenantId: 't', invocationId: 'inv', hitlGate: null, anomalyHandler: null, recordedCalls: new Set<string>(),
  pendingHitlGate: null, pendingDelegationPause: null, abort: () => undefined, onRecoveryInject: () => undefined,
} as unknown as BridgeContext;

/** POST one tools/call on a keep-alive connection and leave it in flight. */
function parkACall(url: string, token: string, agent: http.Agent): { closedByServer: Promise<void> } {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'github__merge_pull_request', arguments: {} },
  });
  const req = http.request(url, {
    method: 'POST',
    agent,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': Buffer.byteLength(body),
    },
  });
  const closedByServer = new Promise<void>((resolve) => {
    req.on('error', () => resolve());
    req.on('response', (res) => { res.resume(); res.on('close', () => resolve()); });
    req.on('close', () => resolve());
  });
  req.end(body);
  return { closedByServer };
}

describe('the local MCP server closes with a call still in flight', () => {
  afterEach(() => {
    for (const release of parked) release();
    parked = [];
  });

  it('returns promptly and drops the held connection instead of waiting ~300s on it', async () => {
    const proxy = await exposeCatalogOverHttp(catalog, context);
    const agent = new http.Agent({ keepAlive: true });
    try {
      const { closedByServer } = parkACall(proxy.url, proxy.bearerToken, agent);
      // The call reaches the bridge and parks there.
      for (let i = 0; i < 100 && parked.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(parked).toHaveLength(1);

      const startedAt = Date.now();
      await proxy.close();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await closedByServer; // the engine's connection was closed, not left dangling
    } finally {
      agent.destroy();
    }
  });
});

describe('settleShutdownStep', () => {
  beforeEach(() => mockWarn.mockReset());

  it('stops waiting on a step that hangs, and says so', async () => {
    const startedAt = Date.now();
    await settleShutdownStep('event stream close', () => new Promise(() => undefined), { invocationId: 'inv' }, 100);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'event stream close', graceMs: 100, invocationId: 'inv' }),
      'opencode shutdown step overran its bound; no longer waiting on it',
    );
  });

  it('waits for a prompt step, and swallows a failing one quietly', async () => {
    const done = jest.fn();
    await settleShutdownStep('ok', async () => { done(); }, {});
    await settleShutdownStep('fails', async () => { throw new Error('already closed'); }, {});
    await settleShutdownStep('no-op', () => undefined, {});
    expect(done).toHaveBeenCalledTimes(1);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('the production bound is a few seconds', () => {
    expect(SHUTDOWN_STEP_GRACE_MS).toBe(5_000);
  });
});
