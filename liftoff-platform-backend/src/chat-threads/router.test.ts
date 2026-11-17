// GET /api/chat-threads. The merge is mocked (service.test.ts covers it), so
// these assert the route: validation, the membership gate, and that the caller
// the service sees is the resolved one, role included.

import express from 'express';

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockResolveCaller = jest.fn();
jest.mock('../auth/resolve-caller', () => ({
  resolveCaller: (...args: unknown[]) => mockResolveCaller(...args),
}));

const mockListAll = jest.fn();
jest.mock('./service', () => ({
  listAllChatThreads: (...args: unknown[]) => mockListAll(...args),
}));

import { chatThreadsRouter } from './router';

const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';

function buildApp(userId?: string) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { ctx?: { userId: string } }).ctx = userId ? { userId } : undefined;
    next();
  });
  app.use('/api/chat-threads', chatThreadsRouter);
  return app;
}

function get(app: express.Express, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`)
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: body as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveCaller.mockResolvedValue({
    ok: true,
    caller: { accountId: ACCOUNT_ID, tenantId: TENANT_ID, role: 'admin' },
  });
  mockListAll.mockResolvedValue({ threads: [], nextCursor: null, hasMore: false });
});

describe('GET /api/chat-threads', () => {
  it('lists for the resolved caller, role included', async () => {
    const cursor = '2026-09-22T10:00:00.000Z';
    const res = await get(buildApp('uid-1'), `/api/chat-threads?tenantId=${TENANT_ID}&cursor=${cursor}&limit=10`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threads: [], nextCursor: null, hasMore: false });
    expect(mockResolveCaller).toHaveBeenCalledWith('uid-1', TENANT_ID);
    expect(mockListAll).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, accountId: ACCOUNT_ID, role: 'admin' },
      { cursor, limit: 10 },
    );
  });

  it('rejects a cursor that is not a timestamp', async () => {
    const res = await get(buildApp('uid-1'), `/api/chat-threads?tenantId=${TENANT_ID}&cursor=abc`);

    expect(res.status).toBe(400);
    expect(mockListAll).not.toHaveBeenCalled();
  });

  it('rejects a missing tenant', async () => {
    const res = await get(buildApp('uid-1'), '/api/chat-threads');

    expect(res.status).toBe(400);
  });

  it('answers a non-member with the resolver status', async () => {
    mockResolveCaller.mockResolvedValue({ ok: false, status: 404, error: 'Tenant not found' });

    const res = await get(buildApp('uid-1'), `/api/chat-threads?tenantId=${TENANT_ID}`);

    expect(res.status).toBe(404);
    expect(mockListAll).not.toHaveBeenCalled();
  });

  it('answers 500 when the listing fails', async () => {
    mockListAll.mockRejectedValue(new Error('db down'));

    const res = await get(buildApp('uid-1'), `/api/chat-threads?tenantId=${TENANT_ID}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to list threads' });
  });
});
