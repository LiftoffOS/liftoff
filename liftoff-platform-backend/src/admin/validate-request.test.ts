// Tests for the validateRequest Express middleware factory.

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../infrastructure/logging', () => ({ log: mockLog }));

import { z } from 'zod';
import type { Request, Response } from 'express';
import { validateRequest } from './validate-request';

function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

describe('validateRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects malformed body with 400 + standard error envelope', () => {
    const mw = validateRequest({
      body: z.object({ count: z.number() }),
    });
    const req = { body: { count: 'not-a-number' }, originalUrl: '/x' } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'invalid_request',
        field: 'count',
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects malformed params with 400', () => {
    const mw = validateRequest({
      params: z.object({ accountId: z.string().uuid() }),
    });
    const req = { params: { accountId: 'not-uuid' }, originalUrl: '/x' } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_request', field: 'accountId' }),
    );
  });

  it('rejects malformed query with 400', () => {
    const mw = validateRequest({
      query: z.object({ tenantId: z.string().uuid() }),
    });
    const req = { query: { tenantId: '' }, originalUrl: '/x' } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_request', field: 'tenantId' }),
    );
  });

  it('attaches parsed result to req.validated on success', () => {
    const mw = validateRequest({
      body: z.object({ count: z.number() }),
      params: z.object({ id: z.string() }),
    });
    const req = {
      body: { count: 7 },
      params: { id: 'abc' },
      originalUrl: '/x',
    } as unknown as Request & { validated: { body: unknown; params: unknown } };
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.validated).toEqual({ body: { count: 7 }, params: { id: 'abc' } });
  });

  it('preserves Zod issue paths in the field property (nested)', () => {
    const mw = validateRequest({
      body: z.object({ user: z.object({ email: z.string().email() }) }),
    });
    const req = { body: { user: { email: 'invalid' } }, originalUrl: '/x' } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_request', field: 'user.email' }),
    );
  });

  it('logs a structured validation_failed event on rejection', () => {
    const mw = validateRequest({
      body: z.object({ x: z.number() }),
    });
    const req = { body: { x: 'oops' }, originalUrl: '/test' } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'admin.api.validation_failed', where: 'body', field: 'x' }),
      expect.any(String),
    );
  });

  it('runs all three sections (body, params, query) when all schemas provided', () => {
    const mw = validateRequest({
      body: z.object({ a: z.number() }),
      params: z.object({ b: z.string() }),
      query: z.object({ c: z.string().optional() }),
    });
    const req = {
      body: { a: 1 },
      params: { b: 'two' },
      query: {},
      originalUrl: '/x',
    } as unknown as Request & { validated: unknown };
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as unknown as { validated: unknown }).validated).toEqual({
      body: { a: 1 },
      params: { b: 'two' },
      query: {},
    });
  });

  it('applies Zod defaults to req.body so handlers reading req.body see them', () => {
    // Regression: handlers read `req.body`, not `req.validated.body`. If the
    // middleware only attaches the parsed result to req.validated, defaults
    // declared via z.X.default(...) never reach the handler.
    const mw = validateRequest({
      body: z.object({
        cancelExisting: z.boolean().default(true),
        notes: z.string().optional(),
      }),
    });
    const req = { body: { notes: 'hi' }, originalUrl: '/x' } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ cancelExisting: true, notes: 'hi' });
  });

  it('applies Zod coercions to req.params so handlers reading req.params see them', () => {
    const mw = validateRequest({
      params: z.object({ count: z.coerce.number() }),
    });
    const req = { params: { count: '42' }, originalUrl: '/x' } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.params.count).toBe(42);
  });
});
