// POST /cleanup-oauth — the sweep's predicates.
//
// The sweep and the OAuth request paths share tables without ever waiting on
// each other because they touch disjoint rows: every request-path write
// carries its liveness predicate (src/oauth/transactions.ts, grant-lifecycle
// LIVE_PREDICATE) and the sweep deletes only rows dead for an hour or more.
// The hour is also the consent park window's outer bound, so a parked request
// the person is about to approve is never swept. This pins the sweep's half.

import express from 'express';

const mockAdminQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (client: { query: typeof mockAdminQuery }) => unknown) => fn({ query: mockAdminQuery })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/tenant-runtime-client', () => ({ tenantRuntimeClient: {} }));
jest.mock('../../team-provisioning/service', () => ({ teamProvisioningService: {} }));
jest.mock('../../byok-gateway/usage-recorder', () => ({ pruneGatewayRequests: jest.fn(), pruneGatewayTokens: jest.fn() }));
jest.mock('../vendor-balance-monitor', () => ({ monitorVendorBalances: jest.fn() }));

import { maintenanceRouter } from '../expire-agent-messages';

const TOKEN = 'service-token';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/maintenance', maintenanceRouter);
  return app;
}

async function post(app: express.Express, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/maintenance/cleanup-oauth`, { method: 'POST', headers })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: body as Record<string, unknown> });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  mockAdminQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterAll(() => {
  delete process.env.PLATFORM_CALLBACK_TOKEN;
});

describe('POST /cleanup-oauth', () => {
  it('deletes only rows dead for an hour or more (or revoked for seven days): the margin no request path writes inside', async () => {
    const res = await post(buildApp(), { 'x-service-auth': TOKEN });
    expect(res.status).toBe(200);
    const sqls = mockAdminQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
    const del = (table: string) => sqls.find((q) => q.startsWith(`DELETE FROM ${table} `))!;

    expect(del('oauth_authorization_requests')).toBe(
      "DELETE FROM oauth_authorization_requests WHERE expires_at < NOW() - INTERVAL '1 hour' OR consumed_at < NOW() - INTERVAL '1 hour'",
    );
    expect(del('oauth_authorization_codes')).toBe(
      "DELETE FROM oauth_authorization_codes WHERE expires_at < NOW() - INTERVAL '1 hour' OR used_at < NOW() - INTERVAL '1 hour'",
    );
    expect(del('oauth_device_codes')).toBe(
      "DELETE FROM oauth_device_codes WHERE expires_at < NOW() - INTERVAL '1 hour'",
    );
    expect(del('oauth_access_tokens')).toBe(
      "DELETE FROM oauth_access_tokens WHERE expires_at < NOW() - INTERVAL '1 hour' OR revoked_at < NOW() - INTERVAL '7 days'",
    );
    expect(del('oauth_refresh_tokens')).toBe(
      "DELETE FROM oauth_refresh_tokens WHERE expires_at < NOW() - INTERVAL '1 hour' OR revoked_at < NOW() - INTERVAL '7 days'",
    );

    // No OAuth sweep statement reaches a row inside the hour: none deletes on
    // a bare `expires_at < NOW()`, `consumed_at IS NOT NULL` or `used_at IS NOT NULL`.
    for (const q of sqls.filter((s) => s.startsWith('DELETE FROM oauth_'))) {
      expect(q).not.toMatch(/expires_at < NOW\(\)(?! - INTERVAL)/);
      expect(q).not.toContain('IS NOT NULL');
    }
    // Stale clients are only ever removed when no grant references them.
    expect(del('oauth_clients c')).toContain('NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)');
  });

  it('refuses a caller without the service token', async () => {
    const res = await post(buildApp(), { 'x-service-auth': 'wrong' });
    expect(res.status).toBe(401);
    expect(mockAdminQuery).not.toHaveBeenCalled();
  });
});
