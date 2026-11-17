// Unit tests for the shared validateServiceAuth helper (plan §10a:
// "validateServiceAuth missing/wrong token → 500/401").

import type { Request, Response } from 'express';
import { validateServiceAuth } from '../../jobs/_serviceAuth';

function makeReq(headerValue?: string): Request {
  return { headers: { 'x-service-auth': headerValue } } as unknown as Request;
}

function makeRes(): Response & { _status?: number; _body?: unknown } {
  const res: { _status?: number; _body?: unknown; status: (n: number) => Response; json: (b: unknown) => Response } = {
    _status: undefined,
    _body: undefined,
    status(n: number) {
      res._status = n;
      return res as unknown as Response;
    },
    json(b: unknown) {
      res._body = b;
      return res as unknown as Response;
    },
  };
  return res as unknown as Response & { _status?: number; _body?: unknown };
}

describe('validateServiceAuth', () => {
  const ORIGINAL_TOKEN = process.env.PLATFORM_CALLBACK_TOKEN;

  afterEach(() => {
    process.env.PLATFORM_CALLBACK_TOKEN = ORIGINAL_TOKEN;
  });

  it('returns 500 when PLATFORM_CALLBACK_TOKEN is unset', () => {
    delete process.env.PLATFORM_CALLBACK_TOKEN;
    const res = makeRes();
    expect(validateServiceAuth(makeReq('anything'), res)).toBe(false);
    expect(res._status).toBe(500);
  });

  it('returns 401 when header is missing', () => {
    process.env.PLATFORM_CALLBACK_TOKEN = 'correct-token-12345';
    const res = makeRes();
    expect(validateServiceAuth(makeReq(undefined), res)).toBe(false);
    expect(res._status).toBe(401);
  });

  it('returns 401 when header is wrong', () => {
    process.env.PLATFORM_CALLBACK_TOKEN = 'correct-token-12345';
    const res = makeRes();
    expect(validateServiceAuth(makeReq('wrong-token'), res)).toBe(false);
    expect(res._status).toBe(401);
  });

  it('returns 401 when header length differs (timing-safe guard)', () => {
    process.env.PLATFORM_CALLBACK_TOKEN = 'correct-token-12345';
    const res = makeRes();
    expect(validateServiceAuth(makeReq('short'), res)).toBe(false);
    expect(res._status).toBe(401);
  });

  it('returns true when the header matches', () => {
    process.env.PLATFORM_CALLBACK_TOKEN = 'correct-token-12345';
    const res = makeRes();
    expect(validateServiceAuth(makeReq('correct-token-12345'), res)).toBe(true);
    expect(res._status).toBeUndefined();
  });
});
