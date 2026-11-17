// The agent -> tool-gateway call ends even when the gateway never answers.
//
// It had no deadline and no signal, and its body read was unbounded, so a
// request on a pooled connection left dead by a network reset held the tool
// call, and the turn with it, forever. Driven over a REAL socket to a server
// that accepts and never answers, through the real ServiceClient.

jest.mock('../../infrastructure/service-client-auth', () => ({
  withManagedServiceAuth: (_secret: string, options: Record<string, unknown>) => ({
    ...options,
    fetchImpl: (url: string, init?: RequestInit) => fetch(url, init),
  }),
}));

import http from 'http';
import type { AddressInfo } from 'net';
import { ServiceClient } from '@liftoffos/service-client';
import {
  ToolGatewayHttpClient,
  executeDeadlineMs,
  TOOL_GATEWAY_POOL_OPTIONS,
  toolGatewayDispatcher,
} from '../http-client';
import { DeadlineExceededError } from '../../infrastructure/deadline';
import { longestDispatchTimeoutMs } from '../../agent-execution/adapter/dispatch-timeout';
import type { ExecuteInput } from '../types';

const input = {
  tenantId: 't', agentId: 'a', instructionVersion: 1, traceId: 'tr', idempotencyKey: 'k',
  connector: 'github', entityType: 'repo', actionType: 'list_issues', payload: { repo: 'o/r' },
} as ExecuteInput;

async function hangingGateway(mode: 'no-headers' | 'no-body-end') {
  let open = 0;
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen += 1;
    open += 1;
    res.on('close', () => { open -= 1; });
    req.resume();
    if (mode === 'no-body-end') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"success":');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen: () => seen,
    open: () => open,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/**
 * Wait for something the SERVER does, rather than assuming it has happened by
 * the time the client gave up.
 *
 * The client's deadline here is 250 ms, and under a loaded run — twelve
 * thousand tests in one process — the deadline can fire before Node has even
 * dispatched the server's `request` event for a connection whose bytes are
 * already sent. Asserting on the server's counters the instant the client
 * throws made two properties race the event loop, and both blocked deploys
 * from unrelated branches.
 *
 * The properties are unchanged: exactly one request reached the gateway, and
 * the socket was released. Only the waiting is.
 */
async function until(what: () => boolean, budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!what()) {
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('ToolGatewayHttpClient deadlines', () => {
  let gw: Awaited<ReturnType<typeof hangingGateway>> | undefined;
  afterEach(async () => { await gw?.close(); gw = undefined; });

  it.each(['no-headers', 'no-body-end'] as const)(
    'execute fails with a typed timeout when the gateway %s, and releases the socket',
    async (mode) => {
      gw = await hangingGateway(mode);
      const client = new ToolGatewayHttpClient({ baseUrl: gw.url, deadlineMsOverride: 250 });

      const startedAt = Date.now();
      const err = await client.execute(input).catch((e: unknown) => e);

      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(err).toBeInstanceOf(DeadlineExceededError);
      expect((err as Error).message).toBe('tool-gateway execute timed out after 250ms');
      await until(() => gw!.seen() >= 1);
      expect(gw.seen()).toBe(1);
      await until(() => gw!.open() === 0);
      expect(gw.open()).toBe(0);
    },
  );

  it('the bookkeeping routes are bounded the same way', async () => {
    gw = await hangingGateway('no-headers');
    const client = new ToolGatewayHttpClient({ baseUrl: gw.url, deadlineMsOverride: 150 });
    await expect(client.preDispatchGuards(input)).rejects.toBeInstanceOf(DeadlineExceededError);
    await expect(client.getConflictPolicy('c', 'e', 'a')).rejects.toBeInstanceOf(DeadlineExceededError);
    // guardExternal fails open by contract: a timeout is "no hold", not a hang.
    await expect(client.guardExternal({} as never)).resolves.toBeNull();
  });
});

describe('executeDeadlineMs', () => {
  const floor = longestDispatchTimeoutMs();

  it('never undercuts the longest budget a caller waits for (code_session at its default)', () => {
    expect(floor).toBe(660_000);
    expect(executeDeadlineMs({ repo: 'o/r' })).toBe(floor + 30_000);
    expect(executeDeadlineMs(undefined)).toBe(floor + 30_000);
  });

  it('gives a call the longer budget it declares, in either unit', () => {
    expect(executeDeadlineMs({ timeout_seconds: 1_200 })).toBe(1_200_000 + 30_000);
    expect(executeDeadlineMs({ timeout_ms: 900_000 })).toBe(900_000 + 30_000);
    expect(executeDeadlineMs({ timeoutMs: 800_000 })).toBe(800_000 + 30_000);
  });

  it('ignores junk budgets', () => {
    expect(executeDeadlineMs({ timeout_seconds: 'soon', timeout_ms: -5 })).toBe(floor + 30_000);
  });
});

// @liftoffos/service-client 0.2 bounds every request at 300s by default, on an
// HTTP/1.1 pool whose headers/body timeouts are also 300s. A tool call answers
// only when the tool finishes, and code_session runs 600s by default, so either
// would cut a call the deadline allows.
describe('a tool call is not cut at the service client\'s 300s default', () => {
  it('the client is handed the call\'s own budget as its timeout', async () => {
    const seen: Array<number | undefined> = [];
    jest.spyOn(ServiceClient.prototype, 'fetch').mockImplementation(async (_k, _p, init) => {
      seen.push((init as { timeoutMs?: number }).timeoutMs);
      return new Response(JSON.stringify({ success: true, data: null, traceId: 'tr' }), { status: 200 });
    });
    const client = new ToolGatewayHttpClient({ baseUrl: 'http://tool-gateway.test' });
    await client.execute({ ...input, actionType: 'code_session', payload: { task: 't' } });
    await client.execute({ ...input, payload: { timeout_seconds: 1_200 } });
    expect(seen).toEqual([690_000, 1_230_000]);
  });

  it('its own pool leaves the bound to the call: no 300s headers/body timeout, idle sockets retired', () => {
    expect(TOOL_GATEWAY_POOL_OPTIONS).toMatchObject({ allowH2: false, headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 30_000 });
    expect(toolGatewayDispatcher()).toBe(toolGatewayDispatcher());
  });
});
