// Generated Files Router — PATCH /:id RLS hardening tests
//
// Covers B1 audit finding: the PATCH endpoint is a Cloud Tasks callback with no
// tenant context in the request. tenant_id must be resolved server-side via
// withAdminScope (single SELECT-by-id) before any writes; all writes
// (generated_files, agent_chat_messages, agent_audit_logs) must run under
// withTenantScope so RLS is enforced.

import express from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockWithAdminScope = jest.fn();
const mockWithTenantScope = jest.fn();
const mockClientQuery = jest.fn();

jest.mock('../infrastructure/database', () => ({
  // getPool is still referenced by other handlers in the router; provide a stub.
  getPool: jest.fn(() => ({ query: jest.fn() })),
  withAdminScope: (
    ctx: { caller: string; reason?: string },
    fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>,
  ) => mockWithAdminScope(ctx, fn),
  withTenantScope: (
    tenantId: string,
    fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>,
  ) => mockWithTenantScope(tenantId, fn),
}));

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../infrastructure/middleware', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('./gcs-client', () => ({
  generatedFilesBucket: { file: jest.fn() },
}));

jest.mock('../agent-chat/chat-repository', () => ({}));
jest.mock('../agent-audit-logs/service', () => ({
  agentAuditLogsService: {},
}));
jest.mock('../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../tenant-members', () => ({ tenantMembersService: {} }));

process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test-token-123';

import { generatedFilesRouter } from './router';

// ── Test app ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/generated-files', generatedFilesRouter);
  return app;
}

function makeRequest(
  app: express.Express,
  method: 'PATCH',
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const FILE_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const CONNECTOR_ID = '33333333-3333-3333-3333-333333333333';
const VALID_BODY = {
  connectorId: CONNECTOR_ID,
  connectorFileId: 'cf_abc',
  connectorPath: '/Apps/Liftoff/foo.xlsx',
  webViewUrl: 'https://example.com/file/abc',
};

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockClientQuery.mockReset();
  // Default: admin lookup returns the tenant_id for the file.
  mockWithAdminScope.mockImplementation(async (_ctx, fn) =>
    fn({
      query: jest
        .fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ tenant_id: TENANT_ID }] }),
    }),
  );
  // Default: tenant scope runs the supplied fn against a fresh per-call
  // client that returns the appropriate queries.
  mockWithTenantScope.mockImplementation(async (_tenantId, fn) => {
    // For simplicity each tenant-scope invocation gets an independent client.
    return fn({ query: mockClientQuery });
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PATCH /api/generated-files/:id — RLS scoping', () => {
  it('resolves tenant_id via withAdminScope, then writes under withTenantScope', async () => {
    // First tenant-scope call: UPDATE generated_files → rowCount 1
    // Second tenant-scope call: bulk UPDATE chat-message attachments (M4 — single statement)
    // Third tenant-scope call: UPDATE agent_audit_logs
    mockClientQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: FILE_ID, tenant_id: TENANT_ID }] }) // UPDATE generated_files
      .mockResolvedValueOnce({ rowCount: 0 }) // bulk UPDATE chat-message attachments
      .mockResolvedValueOnce({ rowCount: 0 }); // UPDATE agent_audit_logs

    const app = buildApp();
    const res = await makeRequest(
      app,
      'PATCH',
      `/api/generated-files/${FILE_ID}`,
      VALID_BODY,
      { 'x-service-auth': 'test-token-123' },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Admin scope must be used exactly once — for the tenant_id lookup.
    expect(mockWithAdminScope).toHaveBeenCalledTimes(1);
    const adminCtx = mockWithAdminScope.mock.calls[0][0];
    expect(adminCtx.caller).toBe('generated-files.patch.resolveTenant');
    expect(adminCtx.reason).toContain('Cloud Tasks');

    // Tenant scope used for every subsequent write — 3 calls
    // (generated_files UPDATE, chat-messages SELECT+UPDATE, audit-log UPDATE).
    expect(mockWithTenantScope).toHaveBeenCalledTimes(3);
    expect(mockWithTenantScope.mock.calls[0][0]).toBe(TENANT_ID);
    expect(mockWithTenantScope.mock.calls[1][0]).toBe(TENANT_ID);
    expect(mockWithTenantScope.mock.calls[2][0]).toBe(TENANT_ID);
  });

  it('returns 404 when admin lookup finds no row', async () => {
    mockWithAdminScope.mockImplementationOnce(async (_ctx, fn) =>
      fn({ query: jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] }) }),
    );

    const app = buildApp();
    const res = await makeRequest(
      app,
      'PATCH',
      `/api/generated-files/${FILE_ID}`,
      VALID_BODY,
      { 'x-service-auth': 'test-token-123' },
    );

    expect(res.status).toBe(404);
    // No tenant-scope writes should have occurred.
    expect(mockWithTenantScope).not.toHaveBeenCalled();
  });

  it('skips chat/audit back-fill writes when webViewUrl is absent', async () => {
    mockClientQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: FILE_ID, tenant_id: TENANT_ID }],
    });

    const app = buildApp();
    const res = await makeRequest(
      app,
      'PATCH',
      `/api/generated-files/${FILE_ID}`,
      { ...VALID_BODY, webViewUrl: undefined },
      { 'x-service-auth': 'test-token-123' },
    );

    expect(res.status).toBe(200);
    // Only the UPDATE generated_files call should have used tenant scope.
    expect(mockWithTenantScope).toHaveBeenCalledTimes(1);
  });

  it('returns 401 without valid X-Service-Auth header', async () => {
    const app = buildApp();
    const res = await makeRequest(
      app,
      'PATCH',
      `/api/generated-files/${FILE_ID}`,
      VALID_BODY,
    );
    expect(res.status).toBe(401);
    expect(mockWithAdminScope).not.toHaveBeenCalled();
    expect(mockWithTenantScope).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid file id format', async () => {
    const app = buildApp();
    const res = await makeRequest(
      app,
      'PATCH',
      '/api/generated-files/not-a-uuid',
      VALID_BODY,
      { 'x-service-auth': 'test-token-123' },
    );
    expect(res.status).toBe(400);
    expect(mockWithAdminScope).not.toHaveBeenCalled();
  });
});
