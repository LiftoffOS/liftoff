// attachAdminStatus contract (PR 1.3, M4):
//   - never blocks the request
//   - sets req.isPlatformAdmin=false on missing uid
//   - sets req.isPlatformAdmin=true only when accounts.is_platform_admin=true
//   - degrades to false on DB error (never throws)

import type { Request, Response, NextFunction } from 'express';

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn();
  return { getPool: () => ({ query }), __query: query };
});

const dbModule = require('../../infrastructure/database');
const query: jest.Mock = dbModule.__query;

const { attachAdminStatus } = require('../admin-status-middleware');

function buildReq(uid?: string): Request {
  return { user: uid ? { uid } : undefined } as unknown as Request;
}

describe('attachAdminStatus', () => {
  beforeEach(() => query.mockReset());

  it('passes through when req.user.uid is missing, defaults isPlatformAdmin=false', async () => {
    const req = buildReq();
    const next: NextFunction = jest.fn();
    await attachAdminStatus(req, {} as Response, next);
    expect(req.isPlatformAdmin).toBe(false);
    expect(req.adminAccountId).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('sets isPlatformAdmin=true when accounts.is_platform_admin=true', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acct-1', is_platform_admin: true }] });
    const req = buildReq('firebase-uid-1');
    const next: NextFunction = jest.fn();
    await attachAdminStatus(req, {} as Response, next);
    expect(req.isPlatformAdmin).toBe(true);
    expect(req.adminAccountId).toBe('acct-1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves isPlatformAdmin=false when accounts row is not admin', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acct-1', is_platform_admin: false }] });
    const req = buildReq('firebase-uid-1');
    const next: NextFunction = jest.fn();
    await attachAdminStatus(req, {} as Response, next);
    expect(req.isPlatformAdmin).toBe(false);
    expect(req.adminAccountId).toBeNull();
  });

  it('degrades to non-admin and still calls next() on DB error', async () => {
    query.mockRejectedValueOnce(new Error('pool exhausted'));
    const req = buildReq('firebase-uid-1');
    const next: NextFunction = jest.fn();
    await attachAdminStatus(req, {} as Response, next);
    expect(req.isPlatformAdmin).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
