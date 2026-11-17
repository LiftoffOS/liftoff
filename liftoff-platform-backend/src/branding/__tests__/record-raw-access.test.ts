// recordRawAccess audit-write test (PR 1.3 #4).
//
// When an admin opts out of brand translation via ?raw=true, the middleware
// fires a fire-and-forget INSERT into admin_action_audit so the access is
// observable. The write must:
//   - run only when reason === 'staff' AND adminAccountId is set
//   - never run for service-token raw access
//   - capture admin id, action='audit.raw_access', the request path,
//     ip (from x-forwarded-for first hop, else socket), and user-agent

import type { Request, Response } from 'express';

const query = jest.fn().mockResolvedValue({ rows: [] });

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query }),
}));

const { brandingResponseMiddleware } = require('../middleware');

function res(): Response & { _captured?: unknown } {
  const r: Partial<Response> & { _captured?: unknown } = {};
  r.json = function (body: unknown) {
    (r as { _captured: unknown })._captured = body;
    return r as Response;
  };
  return r as Response & { _captured?: unknown };
}

beforeEach(() => {
  query.mockClear();
});

describe('recordRawAccess (via brandingResponseMiddleware)', () => {
  it('writes one admin_action_audit row when staff opts out via ?raw=true', async () => {
    const req = {
      isPlatformAdmin: true,
      adminAccountId: 'acct-admin',
      query: { raw: 'true' },
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1', 'user-agent': 'curl/8' },
      socket: { remoteAddress: '10.0.0.2' },
      originalUrl: '/api/internal-agents/abc?raw=true',
    } as unknown as Request;
    const response = res();
    brandingResponseMiddleware(req, response, jest.fn());
    response.json({ tier: 'large' });
    // The insert is fire-and-forget; let the microtask flush.
    await new Promise(r => setImmediate(r));
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO admin_action_audit/);
    expect(params[0]).toBe('acct-admin');
    expect(params[1]).toBe('audit.raw_access');
    expect(params[2]).toBe('response');
    expect(JSON.parse(params[4])).toEqual({ path: '/api/internal-agents/abc?raw=true' });
    expect(params[5]).toBe('203.0.113.1');
    expect(params[6]).toBe('curl/8');
  });

  it('falls back to socket.remoteAddress when x-forwarded-for is absent', async () => {
    const req = {
      isPlatformAdmin: true,
      adminAccountId: 'acct-admin',
      query: { raw: 'true' },
      headers: { 'user-agent': 'curl/8' },
      socket: { remoteAddress: '198.51.100.5' },
      originalUrl: '/api/x',
    } as unknown as Request;
    const r = res();
    brandingResponseMiddleware(req, r, jest.fn());
    r.json({});
    await new Promise(setImmediate);
    expect(query.mock.calls.at(-1)?.[1][5]).toBe('198.51.100.5');
  });

  it('does NOT write an audit row for service-token raw access', async () => {
    process.env['TENANT_RUNTIME_SERVICE_TOKEN'] = 'shared-secret';
    const req = {
      isPlatformAdmin: false,
      adminAccountId: null,
      query: { raw: 'true' },
      headers: { 'x-service-auth': 'shared-secret' },
      socket: { remoteAddress: '10.0.0.1' },
      originalUrl: '/api/x',
    } as unknown as Request;
    const r = res();
    brandingResponseMiddleware(req, r, jest.fn());
    r.json({ tier: 'large' });
    await new Promise(setImmediate);
    expect(query).not.toHaveBeenCalled();
    // Body must be raw (untranslated) for the service caller.
    expect(r._captured).toEqual({ tier: 'large' });
  });

  it('does NOT write an audit row when admin opts out without an adminAccountId', async () => {
    const req = {
      isPlatformAdmin: true,
      adminAccountId: null,
      query: { raw: 'true' },
      headers: {},
      socket: {},
      originalUrl: '/api/x',
    } as unknown as Request;
    const r = res();
    brandingResponseMiddleware(req, r, jest.fn());
    r.json({});
    await new Promise(setImmediate);
    expect(query).not.toHaveBeenCalled();
  });
});
