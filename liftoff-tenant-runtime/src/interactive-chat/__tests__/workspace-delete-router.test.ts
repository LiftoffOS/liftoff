/**
 * R5 Fix 9 workspace-delete-router tests.
 *
 * Plan-required scenarios:
 *   - Valid auth + ownership → 204
 *   - Missing auth → 401
 *   - Wrong tenant → 403 / 400 (header-body mismatch)
 *   - Invalid UUID → 400
 *   - Path traversal → 400
 *   - Rate limit (11/min) → 429
 */
import express from 'express';
import request from 'supertest';
import { buildWorkspaceDeleteRouter } from '../workspace-delete-router';

const UUID_A = '123e4567-e89b-12d3-a456-426614174000';
const UUID_B = '223e4567-e89b-12d3-a456-426614174001';
const UUID_AGENT = '323e4567-e89b-12d3-a456-426614174002';

interface MockClient {
  query: jest.Mock;
  release: jest.Mock;
}
interface MockPool {
  connect: jest.Mock<Promise<MockClient>>;
  query: jest.Mock;
}

function makeMockPool(): MockPool {
  const client: MockClient = {
    query: jest.fn(async () => ({ rowCount: 0, rows: [] })),
    release: jest.fn(),
  };
  return {
    connect: jest.fn(async () => client),
    query: jest.fn(async () => ({ rowCount: 0, rows: [] })),
  };
}

function makeApp(pool: MockPool): express.Express {
  const app = express();
  // Inject tenant context middleware (TR middleware normally does this from x-tenant-id)
  app.use((req: express.Request & { ctx?: { tenantId: string } }, _res, next) => {
    const h = req.headers['x-tenant-id'];
    if (typeof h === 'string') req.ctx = { tenantId: h };
    next();
  });
  app.use(buildWorkspaceDeleteRouter(pool as unknown as never));
  return app;
}

describe('workspace-delete-router', () => {
  const ORIG_TOKEN = process.env.TENANT_RUNTIME_SERVICE_TOKEN;

  beforeAll(() => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test-service-token';
  });
  afterAll(() => {
    if (ORIG_TOKEN) process.env.TENANT_RUNTIME_SERVICE_TOKEN = ORIG_TOKEN;
    else delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
  });

  it('missing auth → 401', async () => {
    const pool = makeMockPool();
    const app = makeApp(pool);
    const res = await request(app)
      .delete(`/api/interactive-chat/${UUID_AGENT}/threads/${UUID_B}/workspace`)
      .set('x-tenant-id', UUID_A);
    expect(res.status).toBe(401);
  });

  it('invalid tenant UUID → 400', async () => {
    const pool = makeMockPool();
    const app = makeApp(pool);
    const res = await request(app)
      .delete(`/api/interactive-chat/${UUID_AGENT}/threads/${UUID_B}/workspace`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('invalid thread UUID → 400', async () => {
    const pool = makeMockPool();
    const app = makeApp(pool);
    const res = await request(app)
      .delete(`/api/interactive-chat/${UUID_AGENT}/threads/not-a-uuid/workspace`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', UUID_A);
    expect(res.status).toBe(400);
  });

  it('invalid agent UUID → 400', async () => {
    const pool = makeMockPool();
    const app = makeApp(pool);
    const res = await request(app)
      .delete(`/api/interactive-chat/not-an-agent/threads/${UUID_B}/workspace`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', UUID_A);
    expect(res.status).toBe(400);
  });

  it('valid request under rate limit → 204', async () => {
    const pool = makeMockPool();
    const client: MockClient = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // DELETE expired
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ n: '0' }] }) // COUNT
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValue({ rowCount: 0, rows: [] }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);
    const app = makeApp(pool);
    const res = await request(app)
      .delete(`/api/interactive-chat/${UUID_AGENT}/threads/${UUID_B}/workspace`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', UUID_A);
    expect(res.status).toBe(204);
  });

  it('rate limit exceeded (11/min) → 429', async () => {
    const pool = makeMockPool();
    const client: MockClient = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // DELETE expired
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ n: '11' }] }) // COUNT above cap
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }), // ROLLBACK
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);
    const app = makeApp(pool);
    const res = await request(app)
      .delete(`/api/interactive-chat/${UUID_AGENT}/threads/${UUID_B}/workspace`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', UUID_A);
    expect(res.status).toBe(429);
  });
});
