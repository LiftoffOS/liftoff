// OAuth device authorization endpoint (RFC 8628 §3.1–3.2) — unit tests.
// Covers: the release gate, client resolution and the device-grant
// registration check, scope and resource validation (the one resource is
// assumed when omitted), the shape of the codes and of the response, what is
// persisted (the device code hashed, never raw), and the user-code retry on a
// collision.

import express from 'express';

const mockPoolQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  withAdminScope: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));

// Every request here comes from one loopback address; the limiter has its
// own suite.
jest.mock('../rate-limiter', () => ({
  ...jest.requireActual('../rate-limiter'),
  deviceAuthorizationRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { hashToken } from '../../tenant-members/tokens';
import { oauthDeviceRouter, mintUserCode, DEVICE_CODE_TTL_SECONDS, DEVICE_POLL_INTERVAL_SECONDS } from '../device-router';

const SITE = 'https://site-test.example.com';
const RESOURCE = 'https://api-test.example.com/mcp';
const CLIENT_ID = 'liftoff_oc_abc123';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function clientRow(grantTypes: string[] = ['refresh_token', DEVICE_GRANT]): Record<string, unknown> {
  return { client_name: 'Muse personal agent', redirect_uris: [], client_type: 'dcr', cimd_cached_until: null, grant_types: grantTypes };
}

function buildApp() {
  const app = express();
  app.use(oauthDeviceRouter);
  return app;
}

async function post(
  app: express.Express,
  form: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: body as Record<string, unknown>, headers: res.headers });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MCP_OAUTH_ENABLED = 'true';
  process.env.FRONTEND_URL = SITE;
  mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

afterAll(() => {
  delete process.env.MCP_OAUTH_ENABLED;
  delete process.env.FRONTEND_URL;
});

describe('mintUserCode', () => {
  it('is XXXX-XXXX from the RFC 8628 §6.1 alphabet: no vowels, no 0/O or 1/I look-alikes', () => {
    for (let i = 0; i < 200; i++) {
      expect(mintUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    }
  });
});

describe('POST /oauth/device_authorization', () => {
  it('404s when the release flag is off', async () => {
    process.env.MCP_OAUTH_ENABLED = 'false';
    const res = await post(buildApp(), { client_id: CLIENT_ID });
    expect(res.status).toBe(404);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('requires a client_id and refuses an unknown one', async () => {
    expect((await post(buildApp(), {})).body.error).toBe('invalid_request');
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const res = await post(buildApp(), { client_id: CLIENT_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    // A deprovisioned client is unknown at the lookup.
    expect(String(mockPoolQuery.mock.calls[0][0])).toContain('WHERE client_id = $1 AND deleted_at IS NULL');
  });

  // The insert is conditional on the client row, held FOR SHARE for the one
  // statement: a client deprovisioned between the lookup and the insert
  // inserts nothing and is answered as unknown.
  it('inserts off the client row FOR SHARE, taking the name from the row, and refuses when the client vanished meanwhile', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [clientRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // deleted since the lookup
    const res = await post(buildApp(), { client_id: CLIENT_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    const insert = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO oauth_device_codes'))!;
    const sql = String(insert[0]).replace(/\s+/g, ' ');
    expect(sql).toContain("SELECT $1, $2, c.client_id, c.client_name, 'mcp', $4, $5, NOW() + ($6::int * INTERVAL '1 second') FROM oauth_clients c WHERE c.client_id = $3 AND c.deleted_at IS NULL FOR SHARE");
    expect(insert[1]).toHaveLength(6);
    expect(insert[1][2]).toBe(CLIENT_ID);
  });

  it('refuses a client that did not register for the device grant, and says how to', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [clientRow(['authorization_code', 'refresh_token'])] });
    const res = await post(buildApp(), { client_id: CLIENT_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(String(res.body.error_description)).toContain(DEVICE_GRANT);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('refuses a scope other than mcp and a resource other than the one MCP server', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [clientRow()] });
    expect((await post(buildApp(), { client_id: CLIENT_ID, scope: 'mcp admin' })).body.error).toBe('invalid_scope');
    mockPoolQuery.mockResolvedValueOnce({ rows: [clientRow()] });
    expect((await post(buildApp(), { client_id: CLIENT_ID, resource: 'https://other.example/mcp' })).body.error).toBe('invalid_target');
    expect(mockPoolQuery.mock.calls.some((c) => String(c[0]).includes('INSERT INTO oauth_device_codes'))).toBe(false);
  });

  it('mints both codes, stores the device code hashed against the assumed resource, and answers RFC 8628 §3.2', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [clientRow()] });
    const res = await post(buildApp(), { client_id: CLIENT_ID });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const deviceCode = String(res.body.device_code);
    const userCode = String(res.body.user_code);
    expect(deviceCode).toMatch(/^liftoff_dc_[A-Za-z0-9_-]{43}$/);
    expect(userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(res.body.verification_uri).toBe(`${SITE}/activate`);
    expect(res.body.verification_uri_complete).toBe(`${SITE}/activate?code=${userCode}`);
    expect(res.body.expires_in).toBe(DEVICE_CODE_TTL_SECONDS);
    expect(res.body.interval).toBe(DEVICE_POLL_INTERVAL_SECONDS);

    const insert = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO oauth_device_codes'))!;
    expect(insert[1]).toEqual([hashToken(deviceCode), userCode, CLIENT_ID, RESOURCE, DEVICE_POLL_INTERVAL_SECONDS, DEVICE_CODE_TTL_SECONDS]);
    expect(JSON.stringify(insert[1])).not.toContain(deviceCode);
  });

  it('draws another user code when the first collides with a pending one', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [clientRow()] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await post(buildApp(), { client_id: CLIENT_ID });
    expect(res.status).toBe(200);
    const inserts = mockPoolQuery.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO oauth_device_codes'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1][1]).not.toBe(inserts[1][1][1]);
    expect(inserts[1][1][1]).toBe(res.body.user_code);
  });

  it('answers server_error on any other insert failure', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [clientRow()] })
      .mockRejectedValueOnce(new Error('connection reset'));
    const res = await post(buildApp(), { client_id: CLIENT_ID });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
  });
});
