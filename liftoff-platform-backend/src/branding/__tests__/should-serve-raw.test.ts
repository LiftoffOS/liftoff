// shouldServeRaw decision-matrix test (PR 1.3 #3).
//
// shouldServeRaw is the gate that lets admin and service callers receive
// untranslated responses via ?raw=true. The decision must be:
//
//   query.raw !== 'true' → always { raw: false }
//   raw=true + service token matches  → { raw: true, reason: 'service' }
//   raw=true + service token mismatch + isPlatformAdmin → { raw: true, reason: 'staff' }
//   raw=true + neither                → { raw: false }

import type { Request } from 'express';

const ORIGINAL_ENV = { ...process.env };

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn() }),
}));

const { shouldServeRaw } = require('../middleware');

function req(query: Record<string, string> = {}, headers: Record<string, string> = {}, isPlatformAdmin = false): Request {
  return { query, headers, isPlatformAdmin } as unknown as Request;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('shouldServeRaw', () => {
  it('returns { raw: false } when raw param is missing', () => {
    expect(shouldServeRaw(req())).toEqual({ raw: false, reason: null });
  });

  it('returns { raw: false } when raw param is not "true"', () => {
    expect(shouldServeRaw(req({ raw: '1' }))).toEqual({ raw: false, reason: null });
    expect(shouldServeRaw(req({ raw: 'yes' }))).toEqual({ raw: false, reason: null });
  });

  it('returns { raw: true, reason: "service" } when X-Service-Auth matches the configured token', () => {
    process.env['TENANT_RUNTIME_SERVICE_TOKEN'] = 'shared-secret';
    expect(
      shouldServeRaw(req({ raw: 'true' }, { 'x-service-auth': 'shared-secret' })),
    ).toEqual({ raw: true, reason: 'service' });
  });

  it('returns { raw: false } when X-Service-Auth is wrong AND caller is not admin', () => {
    process.env['TENANT_RUNTIME_SERVICE_TOKEN'] = 'shared-secret';
    expect(
      shouldServeRaw(req({ raw: 'true' }, { 'x-service-auth': 'wrong' }, false)),
    ).toEqual({ raw: false, reason: null });
  });

  it('returns { raw: true, reason: "staff" } when caller is admin and no valid service token', () => {
    expect(
      shouldServeRaw(req({ raw: 'true' }, {}, true)),
    ).toEqual({ raw: true, reason: 'staff' });
  });

  it('service-token path wins over staff path when both are present', () => {
    process.env['TENANT_RUNTIME_SERVICE_TOKEN'] = 'shared-secret';
    expect(
      shouldServeRaw(req({ raw: 'true' }, { 'x-service-auth': 'shared-secret' }, true)),
    ).toEqual({ raw: true, reason: 'service' });
  });

  it('uses constant-time compare semantics — token of different length never matches', () => {
    process.env['TENANT_RUNTIME_SERVICE_TOKEN'] = 'shared-secret';
    expect(
      shouldServeRaw(req({ raw: 'true' }, { 'x-service-auth': 'shared-secret-but-longer' }, false)),
    ).toEqual({ raw: false, reason: null });
  });
});
