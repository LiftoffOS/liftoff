// brandingResponseMiddleware contract (PR 1.3):
//   - wraps res.json so customer responses get translated through
//     liftoffifyJsonValue
//   - skips translation when shouldServeRaw returns true (admin ?raw=true)
//   - tags translated object responses with _rebrandVersion
//   - preserves array responses byte-for-byte (no _rebrandVersion injection
//     that would corrupt the array shape)

import type { Request, Response } from 'express';

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn() }),
}));

const { brandingResponseMiddleware } = require('../middleware');

function buildRes(): Response & { _captured?: unknown } {
  const res: Partial<Response> & { _captured?: unknown } = {
    statusCode: 200,
  };
  res.json = function (body: unknown) {
    (res as { _captured: unknown })._captured = body;
    return res as Response;
  };
  return res as Response & { _captured?: unknown };
}

function adminReq(): Request {
  return {
    isPlatformAdmin: true,
    adminAccountId: 'acct-admin',
    query: { raw: 'true' },
    headers: {},
  } as unknown as Request;
}

function customerReq(): Request {
  return {
    isPlatformAdmin: false,
    query: {},
    headers: {},
  } as unknown as Request;
}

describe('brandingResponseMiddleware', () => {
  it('translates an object response and adds _rebrandVersion for customer callers', () => {
    const req = customerReq();
    const res = buildRes();
    const next = jest.fn();
    brandingResponseMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();

    res.json({ tier: 'large', provider: 'anthropic' });
    expect(res._captured).toEqual({
      tier: 'hyperion',
      provider: 'liftoff',
      _rebrandVersion: 1,
    });
  });

  it('preserves array responses byte-for-byte (no _rebrandVersion injection)', () => {
    const req = customerReq();
    const res = buildRes();
    brandingResponseMiddleware(req, res, jest.fn());

    res.json([{ tier: 'large' }, { tier: 'small' }]);
    expect(res._captured).toEqual([{ tier: 'hyperion' }, { tier: 'eos' }]);
    expect(Array.isArray(res._captured)).toBe(true);
  });

  it('skips translation when ?raw=true and caller is admin', () => {
    const req = adminReq();
    const res = buildRes();
    brandingResponseMiddleware(req, res, jest.fn());

    res.json({ tier: 'large', provider: 'anthropic' });
    expect(res._captured).toEqual({ tier: 'large', provider: 'anthropic' });
  });

  it('still translates when raw=true but caller is NOT admin', () => {
    const req = {
      isPlatformAdmin: false,
      query: { raw: 'true' },
      headers: {},
    } as unknown as Request;
    const res = buildRes();
    brandingResponseMiddleware(req, res, jest.fn());

    res.json({ tier: 'large' });
    expect(res._captured).toEqual({ tier: 'hyperion', _rebrandVersion: 1 });
  });
});
