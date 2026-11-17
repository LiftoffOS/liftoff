// OAuth consent router — unit tests.
//
// The resumable block for an owner whose workspace is not set up: the request
// is PARKED (409 setup_required, not consumed, parked_for_onboarding_at set) and
// approves when they come back; only a live request can be parked; the parked
// window is sixty minutes; members of an incomplete workspace approve as usual.

import express from 'express';

const mockPoolQuery = jest.fn();
const mockScopedQuery = jest.fn();
// withTenantScope is one transaction: what runs inside it is a transactions.ts
// function (approveConsentTx / approveDeviceCodeTx), mocked here; the scoped
// client is what the route hands over.
const scopedClient = { query: mockScopedQuery };
const mockWithTenantScope = jest.fn(async (_tenantId: string, fn: (client: typeof scopedClient) => unknown) => fn(scopedClient));

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  withTenantScope: (tenantId: string, fn: never) => mockWithTenantScope(tenantId, fn),
}));

const mockApproveConsent = jest.fn();
const mockApproveDevice = jest.fn();
jest.mock('../transactions', () => ({
  ...jest.requireActual('../transactions'),
  approveConsentTx: (...args: unknown[]) => mockApproveConsent(...args),
  approveDeviceCodeTx: (...args: unknown[]) => mockApproveDevice(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../infrastructure/audit-context', () => ({
  auditCtx: (_req: unknown, extra: Record<string, unknown>) => extra,
}));

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));

const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: jest.fn().mockResolvedValue({ id: ACCOUNT_ID }),
  })),
}));

const mockGetMembership = jest.fn();
jest.mock('../../tenant-members', () => ({
  tenantMembersService: { getMembership: (...args: unknown[]) => mockGetMembership(...args) },
}));

// The limiters have their own tests; here the address limiter is a
// pass-through and the per-account guess budget is a switch.
const mockCheckWindow = jest.fn(() => ({ allowed: true, retryAfterSec: 0 }));
jest.mock('../rate-limiter', () => ({
  deviceLookupRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  checkWindow: (...args: unknown[]) => mockCheckWindow(...(args as [])),
}));

import { hashToken } from '../../tenant-members/tokens';
import { oauthConsentRouter } from '../consent-router';
import { logAudit } from '../../infrastructure/logging';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const REQUEST_ID = 'req_abc';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { uid: string } }).user = { uid: 'firebase-uid' };
    next();
  });
  app.use('/api/oauth', oauthConsentRouter);
  return app;
}

async function post(app: express.Express, body: unknown, path = '/api/oauth/consent'): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

async function get(app: express.Express, requestId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/oauth/consent/${requestId}`)
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

const CLAIMED_ROW = {
  client_id: 'liftoff_oc_abc', redirect_uri: 'http://localhost:9999/cb', state: 's1',
  code_challenge: 'c', resource: 'https://api-test.example.com/mcp', client_name: 'Claude Code',
};

function scriptApproveHappyPath(): void {
  // Claim succeeds, then the scoped consent transaction builds the grant and
  // the code (approveConsentTx; its statements are transactions.test.ts's).
  mockPoolQuery.mockResolvedValueOnce({ rows: [CLAIMED_ROW] });
  mockApproveConsent.mockResolvedValueOnce('grant-1');
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MCP_OAUTH_ENABLED = 'true';
  mockGetMembership.mockResolvedValue({ role: 'member' });
  mockCheckWindow.mockReturnValue({ allowed: true, retryAfterSec: 0 });
});

describe('POST /api/oauth/consent/park — the page parks before any picker', () => {
  it('an owner of an unfinished workspace parks a live request: 200, stamped, nothing consumed', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ onboarding_completed_at: null }] })   // tenants gate
      .mockResolvedValueOnce({ rows: [{ request_id: REQUEST_ID }] });          // park UPDATE
    mockGetMembership.mockResolvedValue({ role: 'owner' });

    const res = await post(buildApp(), { requestId: REQUEST_ID, tenantId: TENANT_ID }, '/api/oauth/consent/park');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parked: true, onboardingUrl: '/onboarding' });
    const park = mockPoolQuery.mock.calls[1];
    expect(String(park[0])).toContain('SET parked_for_onboarding_at = COALESCE(r.parked_for_onboarding_at, NOW())');
    expect(String(park[0])).toContain('r.consumed_at IS NULL');
    expect(park[1]).toEqual([REQUEST_ID]);
    expect(mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('SET consumed_at = NOW()'))).toBeUndefined();
    expect(mockWithTenantScope).not.toHaveBeenCalled();
  });

  it('an expired request cannot be parked (410); a finished workspace or a non-owner is not parkable (400)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ onboarding_completed_at: null }] })
      .mockResolvedValueOnce({ rows: [] });                                     // park UPDATE: no live row
    mockGetMembership.mockResolvedValue({ role: 'owner' });
    expect((await post(buildApp(), { requestId: REQUEST_ID, tenantId: TENANT_ID }, '/api/oauth/consent/park')).status).toBe(410);

    mockPoolQuery.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: new Date() }] });
    expect((await post(buildApp(), { requestId: REQUEST_ID, tenantId: TENANT_ID }, '/api/oauth/consent/park')).body).toEqual({ error: 'not_parkable' });

    mockPoolQuery.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: null }] });
    mockGetMembership.mockResolvedValue({ role: 'member' });
    expect((await post(buildApp(), { requestId: REQUEST_ID, tenantId: TENANT_ID }, '/api/oauth/consent/park')).body).toEqual({ error: 'not_parkable' });
    expect(mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('parked_for_onboarding_at = COALESCE') && c !== mockPoolQuery.mock.calls[1])).toBeUndefined();
  });
});

describe('POST /api/oauth/consent — the same rule on Approve, for a client that skipped the park', () => {
  it('owner + incomplete workspace → 409 setup_required; request parked, not consumed', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ onboarding_completed_at: null }] })   // tenants gate
      .mockResolvedValueOnce({ rows: [{ request_id: REQUEST_ID }] });          // park UPDATE
    mockGetMembership.mockResolvedValue({ role: 'owner' });

    const res = await post(buildApp(), { requestId: REQUEST_ID, tenantId: TENANT_ID, approve: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'setup_required', onboardingUrl: '/onboarding' });
    const park = mockPoolQuery.mock.calls[1];
    expect(String(park[0])).toContain('SET parked_for_onboarding_at = COALESCE(r.parked_for_onboarding_at, NOW())');
    expect(String(park[0])).toContain('r.consumed_at IS NULL');
    // The park only touches a live request: the same predicate the claim uses.
    expect(String(park[0])).toContain("r.parked_for_onboarding_at > NOW() - INTERVAL '60 minutes'");
    expect(park[1]).toEqual([REQUEST_ID]);
    // Nothing consumed, nothing granted.
    const consumed = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('SET consumed_at = NOW()'));
    expect(consumed).toBeUndefined();
    expect(mockWithTenantScope).not.toHaveBeenCalled();
  });

  it('the same request approves after onboarding completes (30 minutes later, inside the parked window)', async () => {
    // Gate now reads a completed workspace; the claim's liveness predicate
    // admits the parked request.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: new Date() }] });
    scriptApproveHappyPath();
    mockGetMembership.mockResolvedValue({ role: 'owner' });

    const res = await post(buildApp(), { requestId: REQUEST_ID, tenantId: TENANT_ID, approve: true });

    expect(res.status).toBe(200);
    expect(String(res.body.redirectTo)).toContain('code=liftoff_ac_');
    const claim = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('SET consumed_at = NOW()'));
    expect(claim).toBeDefined();
    expect(String(claim![0])).toContain("(r.expires_at > NOW() OR (r.parked_for_onboarding_at IS NOT NULL AND r.parked_for_onboarding_at > NOW() - INTERVAL '60 minutes'))");
    // The claim only admits a client that is still registered.
    expect(String(claim![0])).toContain('c.client_id = r.client_id AND c.deleted_at IS NULL');
    // The approval is one tenant-scoped transaction, given the claimed request
    // and the code it will insert under the grant lock.
    expect(mockWithTenantScope).toHaveBeenCalledTimes(1);
    expect(mockWithTenantScope.mock.calls[0][0]).toBe(TENANT_ID);
    const code = new URL(String(res.body.redirectTo)).searchParams.get('code')!;
    expect(mockApproveConsent).toHaveBeenCalledWith(scopedClient, expect.objectContaining({
      subject: { tenantId: TENANT_ID, accountId: ACCOUNT_ID, clientId: 'liftoff_oc_abc', clientName: 'Claude Code', resource: CLAIMED_ROW.resource },
      codeHash: hashToken(code),
      redirectUri: CLAIMED_ROW.redirect_uri,
      codeChallenge: 'c',
      resource: CLAIMED_ROW.resource,
    }));
    expect(mockApproveConsent.mock.calls[0][1].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // RFC 7592: a client that deprovisioned itself between the claim and the
  // approval gets no grant; the person's page says the request is over.
  it('answers 410 request_expired when the client was deprovisioned meanwhile (approveConsentTx null)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: new Date() }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [CLAIMED_ROW] });
    mockApproveConsent.mockResolvedValueOnce(null);
    mockGetMembership.mockResolvedValue({ role: 'owner' });

    const res = await post(buildApp(), { requestId: REQUEST_ID, tenantId: TENANT_ID, approve: true });

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'request_expired' });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('an ALREADY-EXPIRED request from an incomplete owner → 410, and parked_for_onboarding_at stays null', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ onboarding_completed_at: null }] })   // tenants gate
      .mockResolvedValueOnce({ rows: [] });                                    // park UPDATE matches nothing (expired)
    mockGetMembership.mockResolvedValue({ role: 'owner' });

    const res = await post(buildApp(), { requestId: REQUEST_ID, tenantId: TENANT_ID, approve: true });

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'request_expired' });
    // Exactly the guarded UPDATE ran; there is no unconditional write that
    // could stamp an expired row.
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    expect(String(mockPoolQuery.mock.calls[1][0])).toContain('r.consumed_at IS NULL AND (r.expires_at > NOW() OR');
  });

  it('a parked request older than 60 minutes → 410 at the claim', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ onboarding_completed_at: new Date() }] }) // gate: done now
      .mockResolvedValueOnce({ rows: [] });                                        // claim: liveness predicate misses
    mockGetMembership.mockResolvedValue({ role: 'owner' });

    const res = await post(buildApp(), { requestId: REQUEST_ID, tenantId: TENANT_ID, approve: true });

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'request_expired' });
  });

  it('member + incomplete workspace → approves as usual', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: null }] });
    scriptApproveHappyPath();
    mockGetMembership.mockResolvedValue({ role: 'member' });

    const res = await post(buildApp(), { requestId: REQUEST_ID, tenantId: TENANT_ID, approve: true });

    expect(res.status).toBe(200);
    const park = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('parked_for_onboarding_at = COALESCE'));
    expect(park).toBeUndefined();
  });

  it('deny never consults the gate and never parks', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [CLAIMED_ROW] });
    const res = await post(buildApp(), { requestId: REQUEST_ID, approve: false });
    expect(res.status).toBe(200);
    expect(String(res.body.redirectTo)).toContain('error=access_denied');
    expect(mockGetMembership).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/oauth/consent/:requestId — liveness', () => {
  it('serves a parked request inside its window as live, joined to a client still registered', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ request_id: REQUEST_ID, redirect_uri: 'http://localhost:1/cb', scope: 'mcp', expires_at: new Date(0), consumed_at: null, client_name: 'Claude Code', live: true }],
    });
    const res = await get(buildApp(), REQUEST_ID);
    expect(res.status).toBe(200);
    expect(res.body.clientName).toBe('Claude Code');
    expect(String(mockPoolQuery.mock.calls[0][0])).toContain('AS live');
    expect(String(mockPoolQuery.mock.calls[0][0])).toContain('JOIN oauth_clients c ON c.client_id = r.client_id AND c.deleted_at IS NULL');
  });

  it('410s a request the predicate says is no longer live', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ request_id: REQUEST_ID, redirect_uri: 'http://localhost:1/cb', scope: 'mcp', expires_at: new Date(0), consumed_at: null, client_name: 'Claude Code', live: false }],
    });
    const res = await get(buildApp(), REQUEST_ID);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'request_expired' });
  });
});

describe('GET /api/oauth/consent/:requestId — client identity', () => {
  const liveRow = (over: Record<string, unknown>) => ({
    request_id: REQUEST_ID, redirect_uri: 'http://localhost:1/cb', scope: 'mcp', expires_at: new Date(0), consumed_at: null, live: true, ...over,
  });

  it('names a known client by its slug and product label', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [liveRow({ client_name: 'Gemini CLI MCP Client' })] });
    const res = await get(buildApp(), REQUEST_ID);
    expect(res.body).toMatchObject({ clientName: 'Gemini CLI MCP Client', clientSlug: 'gemini-cli', clientLabel: 'Gemini CLI' });
  });

  it('carries an unknown client with no slug and its registered name as the label', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [liveRow({ client_name: 'Muse personal agent' })] });
    const res = await get(buildApp(), REQUEST_ID);
    expect(res.body).toMatchObject({ clientName: 'Muse personal agent', clientSlug: null, clientLabel: 'Muse personal agent' });
  });

  // The host is the page's phishing signal and names a web destination only:
  // a private-use scheme is the desktop app itself, like loopback.
  it('reports no redirect host for a private-use redirect scheme', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [liveRow({ client_name: 'Cursor', redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback' })] });
    const res = await get(buildApp(), REQUEST_ID);
    expect(res.body.redirectHost).toBe('');
    expect(res.body.clientSlug).toBe('cursor');
  });

  it('reports the host for a web redirect', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [liveRow({ client_name: 'Visual Studio Code', redirect_uri: 'https://vscode.dev/redirect' })] });
    const res = await get(buildApp(), REQUEST_ID);
    expect(res.body.redirectHost).toBe('vscode.dev');
    expect(res.body).toMatchObject({ clientSlug: 'vscode', clientLabel: 'VS Code' });
  });
});

// ── Device flow (RFC 8628): the /activate page ────────────────────────

describe('POST /api/oauth/device/lookup', () => {
  const PENDING = { client_name: 'Codex', expires_at: new Date(Date.now() + 60_000).toISOString(), status: 'pending' };

  it('answers the branded client for a pending code, whatever case or hyphen the person typed', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [PENDING] });
    const res = await post(buildApp(), { userCode: 'dmcdxkpt' }, '/api/oauth/device/lookup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clientName: 'Codex', clientSlug: 'codex', clientLabel: 'Codex', expiresAt: PENDING.expires_at });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['DMCD-XKPT']);
    expect(String(mockPoolQuery.mock.calls[0][0])).toContain("status = 'pending'");
  });

  it('404s an unknown code, 410s an expired one, and never queries for a malformed one', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect((await post(buildApp(), { userCode: 'DMCD-XKPT' }, '/api/oauth/device/lookup')).status).toBe(404);

    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...PENDING, expires_at: new Date(Date.now() - 1000).toISOString() }] });
    const expired = await post(buildApp(), { userCode: 'DMCD-XKPT' }, '/api/oauth/device/lookup');
    expect(expired.status).toBe(410);
    expect(expired.body.error).toBe('code_expired');

    mockPoolQuery.mockClear();
    const bad = await post(buildApp(), { userCode: 'DMCD-XK' }, '/api/oauth/device/lookup');
    expect(bad.status).toBe(404);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('429s once the account has spent its guess budget, before any lookup (RFC 8628 §5.1)', async () => {
    mockCheckWindow.mockReturnValue({ allowed: false, retryAfterSec: 30 });
    const res = await post(buildApp(), { userCode: 'DMCD-XKPT' }, '/api/oauth/device/lookup');
    expect(res.status).toBe(429);
    expect(mockCheckWindow).toHaveBeenCalledWith('device-lookup-account', ACCOUNT_ID, 20, 10 * 60 * 1000);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/device', () => {
  it('approves in one tenant-scoped transaction (approveDeviceCodeTx) and audits the approval', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: '2026-01-01T00:00:00Z' }] }); // tenants gate
    mockApproveDevice.mockResolvedValueOnce({ clientName: 'Codex', resource: 'https://api-test.example.com/mcp', workspaceName: 'Acme' });
    const res = await post(buildApp(), { userCode: 'DMCD-XKPT', tenantId: TENANT_ID, approve: true }, '/api/oauth/device');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approved: true, workspaceName: 'Acme' });

    expect(mockWithTenantScope).toHaveBeenCalledTimes(1);
    expect(mockWithTenantScope.mock.calls[0][0]).toBe(TENANT_ID);
    expect(mockApproveDevice).toHaveBeenCalledWith(scopedClient, { userCode: 'DMCD-XKPT', tenantId: TENANT_ID, accountId: ACCOUNT_ID });
    expect(logAudit).toHaveBeenCalledWith('mcp_oauth.device_approved', expect.objectContaining({ tenantId: TENANT_ID, userId: ACCOUNT_ID }), expect.objectContaining({ clientName: 'Codex' }));
  });

  it('a code that is no longer pending, has expired, or whose client was deprovisioned answers 410 and audits nothing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: '2026-01-01T00:00:00Z' }] });
    mockApproveDevice.mockResolvedValueOnce(null);
    const res = await post(buildApp(), { userCode: 'DMCD-XKPT', tenantId: TENANT_ID, approve: true }, '/api/oauth/device');
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('code_expired');
    expect(mockWithTenantScope).toHaveBeenCalledTimes(1);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a non-member is refused without learning whether the workspace exists', async () => {
    mockGetMembership.mockResolvedValue(null);
    const res = await post(buildApp(), { userCode: 'DMCD-XKPT', tenantId: TENANT_ID, approve: true }, '/api/oauth/device');
    expect(res.status).toBe(403);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockWithTenantScope).not.toHaveBeenCalled();
  });

  it('an owner of an unfinished workspace is sent to onboarding and the code is left exactly as it was', async () => {
    mockGetMembership.mockResolvedValue({ role: 'owner' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: null }] });
    const res = await post(buildApp(), { userCode: 'DMCD-XKPT', tenantId: TENANT_ID, approve: true }, '/api/oauth/device');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'setup_required', onboardingUrl: '/onboarding' });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockWithTenantScope).not.toHaveBeenCalled();
  });

  it('approving without a workspace is a validation error before any lookup', async () => {
    const res = await post(buildApp(), { userCode: 'DMCD-XKPT', approve: true }, '/api/oauth/device');
    expect(res.status).toBe(400);
    expect(mockGetMembership).not.toHaveBeenCalled();
  });

  it('deny marks a live pending code denied under the same predicate, without a workspace or a membership', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ client_name: 'Codex' }] });
    const res = await post(buildApp(), { userCode: 'DMCD-XKPT', approve: false }, '/api/oauth/device');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approved: false });
    const denied = mockPoolQuery.mock.calls[0];
    expect(String(denied[0])).toContain("SET status = 'denied'");
    expect(String(denied[0])).toContain("status = 'pending' AND expires_at > NOW()");
    expect(denied[1]).toEqual(['DMCD-XKPT']);
    expect(mockGetMembership).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith('mcp_oauth.device_denied', expect.anything(), { clientName: 'Codex' });

    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect((await post(buildApp(), { userCode: 'DMCD-XKPT', approve: false }, '/api/oauth/device')).status).toBe(410);
  });

  it('the guess budget brakes decisions too', async () => {
    mockCheckWindow.mockReturnValue({ allowed: false, retryAfterSec: 30 });
    const res = await post(buildApp(), { userCode: 'DMCD-XKPT', tenantId: TENANT_ID, approve: true }, '/api/oauth/device');
    expect(res.status).toBe(429);
    expect(mockGetMembership).not.toHaveBeenCalled();
  });
});
