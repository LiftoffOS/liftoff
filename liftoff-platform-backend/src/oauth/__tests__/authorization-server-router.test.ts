// OAuth 2.1 Authorization Server — unit tests (plan v6.1 gates)
// Covers: DCR validation and the RFC 7592 fields it issues, authorize error
// routing (plain-400 vs redirect) and the conditional request insert, the
// three token grants' HTTP contract over the mocked transactions (the
// statement sequences live in transactions.test.ts), the client last_used_at
// stamp after the scope, RFC 7009 revoke, RFC 7592 DELETE / 405, RFC error
// bodies, no-store headers, and the MCP_OAUTH_ENABLED gate.

import crypto from 'crypto';
import express from 'express';

const mockAdminQuery = jest.fn();
// withAdminScope is one transaction: what runs inside it is a transactions.ts
// function, mocked here; the mock client is what the route hands over.
const scopedClient = { query: mockAdminQuery };
const mockWithAdminScope = jest.fn(async (_ctx: unknown, fn: (client: typeof scopedClient) => unknown) => fn(scopedClient));

jest.mock('../../infrastructure/database', () => ({
  withAdminScope: (ctx: unknown, fn: never) => mockWithAdminScope(ctx, fn),
  // register/authorize touch only non-RLS tables and use the default pool
  // (audit BUG-5); route it to the same scripted mock.
  pool: { query: (...args: unknown[]) => mockAdminQuery(...args) },
}));

const mockRedeemCode = jest.fn();
const mockRefresh = jest.fn();
const mockRedeemDevice = jest.fn();
const mockRevoke = jest.fn();
const mockDeprovision = jest.fn();
jest.mock('../transactions', () => ({
  ...jest.requireActual('../transactions'),
  redeemAuthorizationCodeTx: (...args: unknown[]) => mockRedeemCode(...args),
  refreshTx: (...args: unknown[]) => mockRefresh(...args),
  redeemDeviceCodeTx: (...args: unknown[]) => mockRedeemDevice(...args),
  revokeTokenTx: (...args: unknown[]) => mockRevoke(...args),
  deprovisionClientTx: (...args: unknown[]) => mockDeprovision(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));

// Registration is limited to five per minute per IP and every request here
// comes from the same loopback address; the limiters have their own suite.
jest.mock('../rate-limiter', () => ({
  ...jest.requireActual('../rate-limiter'),
  registerRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  clientConfigRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { hashToken } from '../../tenant-members/tokens';
import { log } from '../../infrastructure/logging';
import { oauthAuthorizationServerRouter } from '../authorization-server-router';

const RESOURCE = 'https://api-test.example.com/mcp';
const CLIENT_ID = 'liftoff_oc_abc123';

function buildApp() {
  const app = express();
  app.use(oauthAuthorizationServerRouter);
  return app;
}

async function call(
  app: express.Express,
  path: string,
  init: { method?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers; text: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const opts: RequestInit = { method: init.method ?? 'GET', redirect: 'manual', headers: init.headers };
      if (init.form) {
        opts.method = 'POST';
        opts.headers = { ...init.headers, 'Content-Type': 'application/x-www-form-urlencoded' };
        opts.body = new URLSearchParams(init.form).toString();
      } else if (init.json !== undefined) {
        opts.method = 'POST';
        opts.headers = { ...init.headers, 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(init.json);
      }
      fetch(`http://127.0.0.1:${addr.port}${path}`, opts)
        .then(async (res) => {
          const text = await res.text();
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(text); } catch { /* empty or non-JSON body */ }
          server.close();
          resolve({ status: res.status, body, headers: res.headers, text });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

// A verifier + its S256 challenge, computed the same way the server does.
const VERIFIER = 'a'.repeat(43);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');

const TOKENS = { accessRaw: 'liftoff_oat_minted', refreshRaw: 'liftoff_ort_minted' };

const lastUsedStamps = () => mockAdminQuery.mock.calls.filter((c) => String(c[0]).includes('SET last_used_at = NOW()'));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MCP_OAUTH_ENABLED = 'true';
  // Default: any un-scripted write succeeds.
  mockAdminQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

afterAll(() => {
  delete process.env.MCP_OAUTH_ENABLED;
});

describe('MCP_OAUTH_ENABLED gate', () => {
  it('404s every endpoint when the flag is off', async () => {
    process.env.MCP_OAUTH_ENABLED = 'false';
    const app = buildApp();
    const res = await call(app, '/oauth/token', { form: { grant_type: 'authorization_code' } });
    expect(res.status).toBe(404);
    expect((await call(app, `/oauth/register/${CLIENT_ID}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('POST /oauth/register', () => {
  it('registers a public client with loopback + https redirect URIs', async () => {
    const app = buildApp();
    const res = await call(app, '/oauth/register', {
      json: { client_name: 'Claude Code', redirect_uris: ['http://localhost:33418/callback', 'https://example.com/cb'] },
    });
    expect(res.status).toBe(201);
    expect(String(res.body.client_id)).toMatch(/^liftoff_oc_/);
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // RFC 7592: the answer carries the one credential that can deprovision the
  // registration and the address to send it to; the row stores its hash.
  it('issues a registration access token and the registration_client_uri, and stores the token hashed', async () => {
    const app = buildApp();
    const res = await call(app, '/oauth/register', {
      json: { client_name: 'Muse personal agent', grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'] },
    });
    expect(res.status).toBe(201);
    const token = String(res.body.registration_access_token);
    expect(token).toMatch(/^liftoff_rat_[A-Za-z0-9_-]{43}$/);
    expect(res.body.registration_client_uri).toBe(`https://api-test.example.com/oauth/register/${res.body.client_id}`);
    const insert = mockAdminQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO oauth_clients'))!;
    expect(String(insert[0])).toContain('registration_access_token_hash');
    expect(insert[1][5]).toBe(hashToken(token));
    expect(JSON.stringify(insert[1])).not.toContain(token);
  });

  it('rejects non-HTTPS non-loopback redirect URIs', async () => {
    const app = buildApp();
    const res = await call(app, '/oauth/register', {
      json: { client_name: 'X', redirect_uris: ['http://example.com/cb'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  // Cursor registers a loopback URI and its own private-use scheme in one
  // request. A registration is all-or-nothing, so refusing the second entry
  // refused Cursor entirely (400 before the consent page could open).
  it('registers a private-use redirect scheme alongside loopback (RFC 8252 §7.1)', async () => {
    const app = buildApp();
    const res = await call(app, '/oauth/register', {
      json: {
        client_name: 'Cursor',
        redirect_uris: ['http://127.0.0.1:54321/callback', 'cursor://anysphere.cursor-mcp/oauth/callback'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(res.status).toBe(201);
    const stored = JSON.parse(mockAdminQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO oauth_clients'))![1][2]);
    expect(stored).toEqual([
      { uri: 'http://127.0.0.1:54321/callback', loopback_port_wildcard: true },
      { uri: 'cursor://anysphere.cursor-mcp/oauth/callback', loopback_port_wildcard: false },
    ]);
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,x'],
    ['file:///etc/passwd'],
    ['blob:https://example.com/x'],
    ['cursor://anysphere.cursor-mcp/oauth/callback#fragment'],
  ])('rejects %s as a redirect URI', async (uri) => {
    const app = buildApp();
    const res = await call(app, '/oauth/register', {
      json: { client_name: 'X', redirect_uris: [uri] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('rejects confidential clients', async () => {
    const app = buildApp();
    const res = await call(app, '/oauth/register', {
      json: { client_name: 'X', redirect_uris: ['https://example.com/cb'], token_endpoint_auth_method: 'client_secret_post' },
    });
    expect(res.status).toBe(400);
  });

  // RFC 7591: what is persisted, what is echoed and what the token endpoint
  // later reads are one list. A client that names no grants gets the pair
  // every client got before the device grant existed.
  it('persists and echoes today\'s grant pair when none are requested', async () => {
    const app = buildApp();
    const res = await call(app, '/oauth/register', {
      json: { client_name: 'Claude Code', redirect_uris: ['http://localhost:33418/callback'] },
    });
    expect(res.status).toBe(201);
    expect(res.body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(res.body.response_types).toEqual(['code']);
    const insert = mockAdminQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO oauth_clients'))!;
    expect(JSON.parse(insert[1][4])).toEqual(['authorization_code', 'refresh_token']);
  });

  it('registers a device-only client with no redirect URI, and says so back', async () => {
    const app = buildApp();
    const res = await call(app, '/oauth/register', {
      json: { client_name: 'Muse personal agent', grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'], token_endpoint_auth_method: 'none' },
    });
    expect(res.status).toBe(201);
    expect(res.body.grant_types).toEqual(['refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']);
    expect(res.body.response_types).toEqual([]);
    expect(res.body.redirect_uris).toEqual([]);
    const insert = mockAdminQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO oauth_clients'))!;
    expect(JSON.parse(insert[1][2])).toEqual([]);
    expect(JSON.parse(insert[1][4])).toEqual(['refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']);
  });

  it('still requires a redirect URI for a client not registering for the device grant', async () => {
    const app = buildApp();
    const res = await call(app, '/oauth/register', {
      json: { client_name: 'X', grant_types: ['authorization_code'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('refuses a registration naming only grants we do not serve', async () => {
    const app = buildApp();
    const res = await call(app, '/oauth/register', {
      json: { client_name: 'X', redirect_uris: ['https://example.com/cb'], grant_types: ['implicit'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });
});

// ── RFC 7592: DELETE /oauth/register/:client_id ───────────────────────

describe('DELETE /oauth/register/:client_id (RFC 7592)', () => {
  const RAT = 'liftoff_rat_the-registration-token';

  it('deprovisions inside one admin scope with the hashed Bearer token, and answers 204 no-store', async () => {
    mockDeprovision.mockResolvedValueOnce({ authorized: true, grants: 2 });
    const res = await call(buildApp(), `/oauth/register/${CLIENT_ID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${RAT}` } });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(mockWithAdminScope).toHaveBeenCalledTimes(1);
    expect((mockWithAdminScope.mock.calls[0][0] as { caller: string }).caller).toBe('oauth.register.delete');
    expect(mockDeprovision).toHaveBeenCalledWith(scopedClient, { clientId: CLIENT_ID, bearerHash: hashToken(RAT) });
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'oauth_client_deprovisioned', clientId: CLIENT_ID, grants: 2 }), expect.any(String));
  });

  // RFC 6750 §3: a request with no Bearer credential is challenged without
  // an error code; a Bearer credential that is malformed is invalid_token.
  // Neither opens a scope.
  it.each([
    ['no Authorization header', undefined, 'Bearer'],
    ['a non-Bearer scheme', 'Basic abc', 'Bearer'],
    ['an empty Bearer', 'Bearer ', 'Bearer error="invalid_token"'],
    ['a Bearer with more than one token', 'Bearer a b', 'Bearer error="invalid_token"'],
  ])('answers a bodiless 401 for %s, without opening a scope', async (_label, header, challenge) => {
    const res = await call(buildApp(), `/oauth/register/${CLIENT_ID}`, { method: 'DELETE', headers: header ? { Authorization: header } : undefined });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(challenge);
    expect(res.text).toBe('');
    expect(mockWithAdminScope).not.toHaveBeenCalled();
    expect(mockDeprovision).not.toHaveBeenCalled();
  });

  it('answers the same invalid_token 401 when the transaction refuses the token (wrong token, unknown, deleted or CIMD client)', async () => {
    mockDeprovision.mockResolvedValueOnce({ authorized: false });
    const res = await call(buildApp(), `/oauth/register/${CLIENT_ID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${RAT}` } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(res.text).toBe('');
    expect(log.info).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'oauth_client_deprovisioned' }), expect.any(String));
  });

  it('answers server_error when the transaction fails', async () => {
    mockDeprovision.mockRejectedValueOnce(new Error('connection reset'));
    const res = await call(buildApp(), `/oauth/register/${CLIENT_ID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${RAT}` } });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
  });

  it.each(['GET', 'PUT', 'PATCH', 'POST'])('%s answers 405 with Allow: DELETE', async (method) => {
    const res = await call(buildApp(), `/oauth/register/${CLIENT_ID}`, { method, headers: { Authorization: `Bearer ${RAT}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('DELETE');
    expect(mockDeprovision).not.toHaveBeenCalled();
  });
});

describe('GET /oauth/authorize', () => {
  const REGISTERED = JSON.stringify([{ uri: 'http://localhost:7777/callback', loopback_port_wildcard: true }]);

  it('plain-400s an unknown client (no redirect), and a deleted one is unknown', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await call(app, `/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent('http://localhost:7777/callback')}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    expect(String(mockAdminQuery.mock.calls[0][0])).toContain('WHERE client_id = $1 AND deleted_at IS NULL');
  });

  it('redirects PKCE problems back to the validated redirect_uri', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [{ client_name: 'CC', redirect_uris: JSON.parse(REGISTERED) }] });
    const app = buildApp();
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: 'http://localhost:9999/callback', // loopback port-wildcard match
      response_type: 'code',
      code_challenge: 'too-short',
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const res = await call(app, `/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
  });

  it('rejects unknown scopes with invalid_scope (no silent downgrade)', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [{ client_name: 'CC', redirect_uris: JSON.parse(REGISTERED) }] });
    const app = buildApp();
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: 'http://localhost:7777/callback',
      response_type: 'code',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      scope: 'mcp admin',
    });
    const res = await call(app, `/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') as string).searchParams.get('error')).toBe('invalid_scope');
  });

  it('assumes the one resource when the request names none', async () => {
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [{ client_name: 'CC', redirect_uris: JSON.parse(REGISTERED) }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // request insert
    const app = buildApp();
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: 'http://localhost:7777/callback',
      response_type: 'code',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    const res = await call(app, `/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') as string).pathname).toBe('/oauth/consent');
    const insert = mockAdminQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO oauth_authorization_requests'))!;
    expect(insert[1][5]).toBe(RESOURCE);
  });

  it('parks the request and redirects to the frontend consent page', async () => {
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [{ client_name: 'CC', redirect_uris: JSON.parse(REGISTERED) }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // request insert
    const app = buildApp();
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: 'http://localhost:7777/callback',
      response_type: 'code',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      state: 'xyz',
    });
    const res = await call(app, `/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.pathname).toBe('/oauth/consent');
    expect(loc.searchParams.get('request_id')).toBeTruthy();
  });

  // The insert is conditional on the client row, held FOR SHARE for the one
  // statement: a client deprovisioned between the lookup and the insert
  // inserts nothing and is answered as unknown, never redirected.
  it('inserts the request off the client row FOR SHARE, and plain-400s when the client vanished meanwhile', async () => {
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [{ client_name: 'CC', redirect_uris: JSON.parse(REGISTERED) }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // deleted since the lookup
    const app = buildApp();
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: 'http://localhost:7777/callback',
      response_type: 'code',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const res = await call(app, `/oauth/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    const insert = mockAdminQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO oauth_authorization_requests'))!;
    const sql = String(insert[0]).replace(/\s+/g, ' ');
    expect(sql).toContain("SELECT $1, c.client_id, $3, $4, $5, $6, 'mcp' FROM oauth_clients c WHERE c.client_id = $2 AND c.deleted_at IS NULL FOR SHARE");
    expect(insert[1][1]).toBe(CLIENT_ID);
  });
});

describe('POST /oauth/token — authorization_code', () => {
  const FORM = {
    grant_type: 'authorization_code',
    code: 'the-code',
    code_verifier: VERIFIER,
    redirect_uri: 'http://localhost:7777/callback',
    client_id: CLIENT_ID,
    resource: RESOURCE,
  };

  it('redeems inside one admin scope, answers the pair, and stamps the client after the scope', async () => {
    mockRedeemCode.mockResolvedValueOnce({ tokens: TOKENS });
    const app = buildApp();
    const res = await call(app, '/oauth/token', { form: FORM });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe(TOKENS.accessRaw);
    expect(res.body.refresh_token).toBe(TOKENS.refreshRaw);
    expect(res.body.expires_in).toBe(3600);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(mockRedeemCode).toHaveBeenCalledWith(scopedClient, {
      codeHash: hashToken('the-code'), clientId: CLIENT_ID, redirectUri: FORM.redirect_uri, resource: RESOURCE, verifier: VERIFIER,
    });
    // The stamp runs on the pool, after withAdminScope returned.
    expect(mockWithAdminScope).toHaveBeenCalledTimes(1);
    const stamps = lastUsedStamps();
    expect(stamps).toHaveLength(1);
    expect(stamps[0][1]).toEqual([CLIENT_ID]);
    expect(mockWithAdminScope.mock.invocationCallOrder[0]).toBeLessThan(mockAdminQuery.mock.invocationCallOrder[0]);
  });

  it('assumes the one resource when the redemption names none', async () => {
    mockRedeemCode.mockResolvedValueOnce({ tokens: TOKENS });
    const app = buildApp();
    const { resource: _omitted, ...form } = FORM;
    const res = await call(app, '/oauth/token', { form });
    expect(res.status).toBe(200);
    expect(mockRedeemCode.mock.calls[0][1].resource).toBe(RESOURCE);
  });

  it('answers invalid_grant from the transaction and stamps nothing', async () => {
    mockRedeemCode.mockResolvedValueOnce({ error: 'invalid_grant' });
    const app = buildApp();
    const res = await call(app, '/oauth/token', { form: FORM });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastUsedStamps()).toHaveLength(0);
  });

  it('rejects a malformed verifier and a wrong resource before any transaction', async () => {
    const app = buildApp();
    expect((await call(app, '/oauth/token', { form: { ...FORM, code_verifier: 'short' } })).body.error).toBe('invalid_grant');
    const res = await call(app, '/oauth/token', { form: { ...FORM, resource: 'https://evil.example/mcp' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');
    expect(mockRedeemCode).not.toHaveBeenCalled();
    expect(mockWithAdminScope).not.toHaveBeenCalled();
  });

  it('answers server_error when the transaction throws', async () => {
    mockRedeemCode.mockRejectedValueOnce(new Error('deadlock detected'));
    const res = await call(buildApp(), '/oauth/token', { form: FORM });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(lastUsedStamps()).toHaveLength(0);
  });
});

describe('POST /oauth/token — refresh_token', () => {
  const FORM = {
    grant_type: 'refresh_token',
    refresh_token: 'the-refresh',
    client_id: CLIENT_ID,
    resource: RESOURCE,
  };

  it('rotates inside one admin scope and stamps the client after it', async () => {
    mockRefresh.mockResolvedValueOnce({ tokens: TOKENS });
    const app = buildApp();
    const res = await call(app, '/oauth/token', { form: FORM });
    expect(res.status).toBe(200);
    expect(res.body.refresh_token).toBe(TOKENS.refreshRaw);
    expect(mockRefresh).toHaveBeenCalledWith(scopedClient, { tokenHash: hashToken('the-refresh'), clientId: CLIENT_ID, resource: RESOURCE });
    expect(lastUsedStamps()).toHaveLength(1);
  });

  it('a stale replay is logged as a revocation event and answered invalid_grant, with no stamp', async () => {
    mockRefresh.mockResolvedValueOnce({ theft: true });
    const app = buildApp();
    const res = await call(app, '/oauth/token', { form: FORM });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'oauth_refresh_replay_revocation', clientId: CLIENT_ID }), expect.any(String));
    expect(lastUsedStamps()).toHaveLength(0);
  });

  it('a concurrent loser is answered invalid_grant without the event', async () => {
    mockRefresh.mockResolvedValueOnce({ error: 'invalid_grant' });
    const res = await call(buildApp(), '/oauth/token', { form: FORM });
    expect(res.body.error).toBe('invalid_grant');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('enforces resource on refresh too', async () => {
    const app = buildApp();
    const res = await call(app, '/oauth/token', { form: { ...FORM, resource: 'https://evil.example/mcp' } });
    expect(res.body.error).toBe('invalid_target');
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('POST /oauth/token — device_code (RFC 8628)', () => {
  const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
  const FORM = { grant_type: DEVICE_GRANT, device_code: 'liftoff_dc_test', client_id: CLIENT_ID };

  it.each(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_grant', 'unauthorized_client'])(
    'relays %s as a 400 with no stamp', async (error) => {
      mockRedeemDevice.mockResolvedValueOnce({ error });
      const res = await call(buildApp(), '/oauth/token', { form: FORM });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(error);
      expect(mockRedeemDevice).toHaveBeenCalledWith(scopedClient, { deviceCodeHash: hashToken('liftoff_dc_test'), clientId: CLIENT_ID });
      expect(lastUsedStamps()).toHaveLength(0);
    },
  );

  it('answers the pair against an approved code and stamps the client after the scope', async () => {
    mockRedeemDevice.mockResolvedValueOnce({ tokens: TOKENS });
    const res = await call(buildApp(), '/oauth/token', { form: FORM });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe(TOKENS.accessRaw);
    expect(lastUsedStamps()).toHaveLength(1);
  });

  it('requires device_code and client_id before any transaction', async () => {
    const res = await call(buildApp(), '/oauth/token', { form: { grant_type: DEVICE_GRANT, client_id: CLIENT_ID } });
    expect(res.body.error).toBe('invalid_request');
    expect(mockRedeemDevice).not.toHaveBeenCalled();
  });
});

describe('POST /oauth/revoke', () => {
  it('always 200s, revoking inside one admin scope bound to the presenting client', async () => {
    mockRevoke.mockResolvedValueOnce({ identified: false });
    const app = buildApp();
    const res = await call(app, '/oauth/revoke', { form: { token: 'whatever', client_id: CLIENT_ID, token_type_hint: 'access_token' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockRevoke).toHaveBeenCalledWith(scopedClient, { tokenHash: hashToken('whatever'), clientId: CLIENT_ID, hint: 'access_token' });
    expect(log.info).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'oauth_revoke_retired_grant' }), expect.any(String));
  });

  it('logs oauth_revoke_retired_grant when the revocation retired the connection', async () => {
    mockRevoke.mockResolvedValueOnce({ identified: true, retired: true });
    const res = await call(buildApp(), '/oauth/revoke', { form: { token: 'the-refresh', client_id: CLIENT_ID } });
    expect(res.status).toBe(200);
    expect(mockRevoke.mock.calls[0][1].hint).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'oauth_revoke_retired_grant', clientId: CLIENT_ID }), expect.any(String));
  });

  it('requires token and client_id', async () => {
    const res = await call(buildApp(), '/oauth/revoke', { form: { token: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
