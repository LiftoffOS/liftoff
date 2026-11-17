// Harvest Router — runtime-url resolution tests.
//
// Contract under test: harvest nacks on any non-200 and the outbox-ack
// reconciler republishes until it acknowledges, so the runtime-url endpoint
// must resolve a URL for every EXISTING tenant (tenants.runtime_url may be
// NULL on shared-hosting tenants — the env fallback via resolveRuntimeBaseUrl
// covers that). 404 is reserved for a genuinely unknown tenant.

import express from 'express';

const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (client: { query: typeof mockPoolQuery }) => unknown) => {
    return fn({ query: mockPoolQuery });
  }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockResolveRuntimeBaseUrl = jest.fn();
jest.mock('../../connectors/tenant-runtime-url', () => ({
  resolveRuntimeBaseUrl: (...args: unknown[]) => mockResolveRuntimeBaseUrl(...args),
}));

import { harvestInternalRouter } from '../harvest-router';

const VALID_TOKEN = 'test-harvest-token-1234';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function buildApp() {
  const app = express();
  app.use('/api/internal', harvestInternalRouter);
  return app;
}

function getUrl(path: string): Promise<{ status: number; body: unknown }> {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        headers: { 'X-Service-Auth': VALID_TOKEN },
      })
        .then(async (res) => {
          const body = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('GET /api/internal/tenants/:tenantId/runtime-url', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HARVEST_SERVICE_TOKEN = VALID_TOKEN;
  });

  afterEach(() => {
    delete process.env.HARVEST_SERVICE_TOKEN;
  });

  it('404s only for a genuinely unknown tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const res = await getUrl(`/api/internal/tenants/${TENANT_ID}/runtime-url`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Tenant not found' });
    expect(mockResolveRuntimeBaseUrl).not.toHaveBeenCalled();
  });

  it('resolves via resolveRuntimeBaseUrl when the column is NULL (env fallback, no 404)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ runtime_url: null }] });
    mockResolveRuntimeBaseUrl.mockResolvedValueOnce('https://agent-service-dev.example.run.app');

    const res = await getUrl(`/api/internal/tenants/${TENANT_ID}/runtime-url`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://agent-service-dev.example.run.app' });
    expect(mockResolveRuntimeBaseUrl).toHaveBeenCalledWith(TENANT_ID);
  });

  it('returns the resolved URL for a tenant with the column populated', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ runtime_url: 'https://tenant-runtime.example.com' }] });
    mockResolveRuntimeBaseUrl.mockResolvedValueOnce('https://tenant-runtime.example.com');

    const res = await getUrl(`/api/internal/tenants/${TENANT_ID}/runtime-url`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://tenant-runtime.example.com' });
  });

  it('rejects a non-UUID tenant id with 400', async () => {
    const res = await getUrl('/api/internal/tenants/not-a-uuid/runtime-url');
    expect(res.status).toBe(400);
  });
});
