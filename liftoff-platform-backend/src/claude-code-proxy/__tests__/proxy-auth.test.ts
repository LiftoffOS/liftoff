// Proxy Origin Guard Tests

import type { Request, Response, NextFunction } from 'express';
import { originGuard } from '../proxy-auth';

function mockReq(headers: Record<string, string> = {}): Partial<Request> {
  return { headers } as Partial<Request>;
}

function mockRes() {
  const state = { statusCode: 200, body: null as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(data: unknown) { state.body = data; return res; },
  } as Partial<Response>;
  return { res, state };
}

const ANTHROPIC_ERROR_SHAPE = {
  type: 'error',
  error: expect.objectContaining({ type: expect.any(String), message: expect.any(String) }),
};

describe('originGuard', () => {
  it('allows requests without Origin header', () => {
    const req = mockReq({});
    const { res } = mockRes();
    const next = jest.fn();
    originGuard(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('rejects requests with Origin header with 403', () => {
    const req = mockReq({ origin: 'https://evil.com' });
    const { res, state } = mockRes();
    const next = jest.fn();
    originGuard(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(403);
    expect(state.body).toMatchObject(ANTHROPIC_ERROR_SHAPE);
  });
});
