// In-memory OAuth endpoint rate limiter — unit tests.

import type { Request, Response } from 'express';
import { tokenRateLimit, devicePollRateLimit, deviceAuthorizationRateLimit, deviceLookupRateLimit, clientConfigRateLimit, checkWindow } from '../rate-limiter';

function fakeRes(): Response & { statusCode?: number; headers: Record<string, string>; body?: unknown } {
  const res = {
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { res.headers[k] = v; },
    status(code: number) { res.statusCode = code; return res; },
    json(b: unknown) { res.body = b; return res; },
  };
  return res as unknown as Response & { statusCode?: number; headers: Record<string, string>; body?: unknown };
}

describe('tokenRateLimit', () => {
  it('allows up to 30/min per IP then 429s with Retry-After', () => {
    const req = { ip: `ip-${Date.now()}` } as unknown as Request;
    let passed = 0;
    for (let i = 0; i < 30; i++) {
      tokenRateLimit(req, fakeRes(), () => { passed++; });
    }
    expect(passed).toBe(30);

    const res = fakeRes();
    let called = false;
    tokenRateLimit(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
  });
});

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

describe('device polls under tokenRateLimit', () => {
  it('a device poll never counts against the 30/min token window, and never sees rate_limited', () => {
    const ip = `ip-${Date.now()}-poll`;
    const codeReq = { ip, body: { grant_type: 'authorization_code' } } as unknown as Request;
    const pollReq = { ip, body: { grant_type: DEVICE_GRANT } } as unknown as Request;
    for (let i = 0; i < 30; i++) tokenRateLimit(codeReq, fakeRes(), () => undefined);
    const blocked = fakeRes();
    tokenRateLimit(codeReq, blocked, () => undefined);
    expect(blocked.statusCode).toBe(429);

    let passed = 0;
    for (let i = 0; i < 100; i++) tokenRateLimit(pollReq, fakeRes(), () => { passed++; });
    expect(passed).toBe(100);
  });

  it('a runaway poller is answered slow_down (400, no-store), the error a client must honour, past 120/min', () => {
    const req = { ip: `ip-${Date.now()}-runaway` } as unknown as Request;
    let passed = 0;
    for (let i = 0; i < 120; i++) devicePollRateLimit(req, fakeRes(), () => { passed++; });
    expect(passed).toBe(120);
    const res = fakeRes();
    let called = false;
    devicePollRateLimit(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'slow_down' });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});

describe('clientConfigRateLimit (RFC 7592 registration_client_uri)', () => {
  it('allows 10/min per IP and 429s the 11th', () => {
    const req = { ip: `ip-${Date.now()}-config` } as unknown as Request;
    let passed = 0;
    for (let i = 0; i < 10; i++) clientConfigRateLimit(req, fakeRes(), () => { passed++; });
    expect(passed).toBe(10);
    const res = fakeRes();
    let called = false;
    clientConfigRateLimit(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
  });
});

describe('device authorization and lookup limiters', () => {
  it('device_authorization allows 10/min per IP', () => {
    const req = { ip: `ip-${Date.now()}-authz` } as unknown as Request;
    let passed = 0;
    for (let i = 0; i < 10; i++) deviceAuthorizationRateLimit(req, fakeRes(), () => { passed++; });
    expect(passed).toBe(10);
    const res = fakeRes();
    deviceAuthorizationRateLimit(req, res, () => undefined);
    expect(res.statusCode).toBe(429);
  });

  it('the user-code lookup allows 10/min per IP', () => {
    const req = { ip: `ip-${Date.now()}-lookup` } as unknown as Request;
    let passed = 0;
    for (let i = 0; i < 10; i++) deviceLookupRateLimit(req, fakeRes(), () => { passed++; });
    expect(passed).toBe(10);
    const res = fakeRes();
    deviceLookupRateLimit(req, res, () => undefined);
    expect(res.statusCode).toBe(429);
  });

  it('checkWindow counts any key the same way, so a per-account guess budget shares the machinery', () => {
    const key = `acct-${Date.now()}`;
    for (let i = 0; i < 3; i++) expect(checkWindow('test-window', key, 3, 60_000).allowed).toBe(true);
    const fourth = checkWindow('test-window', key, 3, 60_000);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBeGreaterThan(0);
    expect(checkWindow('test-window', `${key}-other`, 3, 60_000).allowed).toBe(true);
  });
});
