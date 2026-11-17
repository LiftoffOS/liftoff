// MCP Auth Middleware — unit tests
// Covers: origin guard, prefix-routed token lookup, 401 on all failure modes.

import express from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPoolQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // mcp-auth uses withAdminScope to look up tokens before tenant context is
  // established. Mock returns a fake client whose .query delegates to mockPoolQuery
  // so existing test assertions on mockPoolQuery still work.
  withAdminScope: jest.fn(async (_ctx, fn) => fn({ query: mockPoolQuery })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../tenant-members/tokens', () => ({
  hashToken: jest.fn((t: string) => `hash_${t}`),
}));

import { mcpOriginGuard, mcpAuthMiddleware } from '../mcp-auth';

// ── Test app ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(mcpOriginGuard);
  app.use(mcpAuthMiddleware);
  app.post('/', (req, res) => {
    res.json({ ok: true, mcpAuth: (req as unknown as { mcpAuth?: unknown }).mcpAuth });
  });
  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const SK_KEY = 'liftoff_sk_testkey123456';
const MCP_KEY = 'liftoff_mcp_testkey456789';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const KEY_ID = '33333333-3333-3333-3333-333333333333';

function makeRequest(
  app: express.Express,
  headers: Record<string, string> = {},
  body: unknown = { method: 'test' },
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: fire-and-forget last_used_at update resolves silently
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

// ── mcpOriginGuard ─────────────────────────────────────────────────────────

describe('mcpOriginGuard', () => {
  it('blocks requests with Origin header', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { Origin: 'https://app.example.com' });
    expect(res.status).toBe(403);
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32001);
  });

  it('allows requests without Origin header', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: KEY_ID, tenant_id: TENANT_ID, account_id: ACCOUNT_ID }],
    });
    const app = buildApp();
    const res = await makeRequest(app, { Authorization: `Bearer ${MCP_KEY}` });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── mcpAuthMiddleware ──────────────────────────────────────────────────────

describe('mcpAuthMiddleware', () => {
  describe('liftoff_sk_* (proxy key — removed in migration 132)', () => {
    it('returns 401 without querying the DB', async () => {
      const app = buildApp();
      const res = await makeRequest(app, { Authorization: `Bearer ${SK_KEY}` });
      expect(res.status).toBe(401);
      expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32001);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe('liftoff_mcp_* (collab-only token)', () => {
    it('resolves via mcp_tokens and sets keyType=collab', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: KEY_ID, tenant_id: TENANT_ID, account_id: ACCOUNT_ID }],
      });
      const app = buildApp();
      const res = await makeRequest(app, { Authorization: `Bearer ${MCP_KEY}` });

      expect(res.status).toBe(200);
      expect(res.body.mcpAuth).toEqual({
        tenantId: TENANT_ID, accountId: ACCOUNT_ID, keyId: KEY_ID, keyType: 'collab',
      });
      const firstCall = mockPoolQuery.mock.calls[0];
      expect(firstCall[0]).toContain('mcp_tokens');
    });

    it('returns 401 for expired or revoked liftoff_mcp_* token', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const app = buildApp();
      const res = await makeRequest(app, { Authorization: `Bearer ${MCP_KEY}` });
      expect(res.status).toBe(401);
    });

    it('only queries mcp_tokens table, no other tables', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const app = buildApp();
      await makeRequest(app, { Authorization: `Bearer ${MCP_KEY}` });
      const queriedTables = mockPoolQuery.mock.calls.map((c) => c[0] as string);
      expect(queriedTables.every((q) => q.includes('mcp_tokens'))).toBe(true);
    });
  });

  describe('invalid tokens', () => {
    it('returns 401 for unknown token prefix without querying DB', async () => {
      const app = buildApp();
      const res = await makeRequest(app, { Authorization: 'Bearer unknown_prefix_key' });
      expect(res.status).toBe(401);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization header is missing', async () => {
      const app = buildApp();
      const res = await makeRequest(app, {});
      expect(res.status).toBe(401);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('returns 401 for malformed Bearer header', async () => {
      const app = buildApp();
      const res = await makeRequest(app, { Authorization: 'Basic somebase64' });
      expect(res.status).toBe(401);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });
});
