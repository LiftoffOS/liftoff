// Tests for DELETE /api/admin/accounts/:id query parsing.
//
// Specifically covers N5 from the PR2 polish audit: dryRun and cascade query
// parameters must be parsed case-insensitively. Strict-equality parsing was a
// footgun — `?dryRun=True` (capital R + T) would silently trigger a real
// delete instead of a dry-run, defeating the two-stage safety flow.

const mockCascadeDelete = jest.fn();
const mockAccountService = jest.fn().mockImplementation(() => ({
  cascadeDelete: mockCascadeDelete,
}));

jest.mock('../accounts/service', () => ({
  AccountService: mockAccountService,
  AccountNotFoundError: class extends Error {
    accountId: string;
    constructor(accountId: string) {
      super('not found');
      this.accountId = accountId;
    }
  },
}));

jest.mock('../infrastructure/database', () => ({
  withAdminScope: jest.fn(),
  getPool: jest.fn(() => ({ query: jest.fn() })),
}));

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));

jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn(async () => 'sk_test_dummy'),
}));

jest.mock('../billing/billing-admin-client', () => ({
  getBillingAdminClient: jest.fn(() => ({})),
}));

jest.mock('./service', () => ({
  AdminService: jest.fn().mockImplementation(() => ({})),
}));

import { adminRouter } from './router';
import type { Request, Response } from 'express';

interface RouteLayer {
  route?: {
    path: string;
    methods: { [method: string]: boolean };
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>;
  };
}

function getHandler(method: string, path: string): (req: Request, res: Response, next: (err?: unknown) => void) => Promise<unknown> {
  const stack = (adminRouter as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      const handlers = layer.route.stack;
      return handlers[handlers.length - 1].handle as (
        req: Request,
        res: Response,
        next: (err?: unknown) => void,
      ) => Promise<unknown>;
    }
  }
  throw new Error(`route ${method} ${path} not found`);
}

function mockReqRes(query: Record<string, string>) {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const accountId = '11111111-1111-1111-1111-111111111111';
  const req = {
    params: { id: accountId },
    query,
    ctx: { adminId: 'admin-1' },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
  return { req, res, accountId };
}

describe('DELETE /api/admin/accounts/:id — case-insensitive query parsing (N5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCascadeDelete.mockResolvedValue({
      accountId: '11111111-1111-1111-1111-111111111111',
      tenantsAffected: 0,
      memberRowsAcrossOtherTenants: 0,
      stripeCustomerDeleted: false,
      firebaseUserDeleted: false,
      accountRowDeleted: false,
    });
  });

  // Run the handler with the given dryRun string and capture the dryRun value
  // that the route propagated to AccountService.cascadeDelete.
  async function callWithDryRun(dryRunValue: string): Promise<boolean> {
    const handler = getHandler('delete', '/accounts/:id');
    const { req, res } = mockReqRes({ cascade: 'true', dryRun: dryRunValue });
    await handler(req, res as unknown as Response, () => undefined);
    expect(mockCascadeDelete).toHaveBeenCalledTimes(1);
    const opts = mockCascadeDelete.mock.calls[0][2] as { dryRun: boolean };
    return opts.dryRun;
  }

  it('dryRun=true, dryRun=True, and dryRun=TRUE all parse to true identically', async () => {
    const lower = await callWithDryRun('true');
    mockCascadeDelete.mockClear();
    const mixed = await callWithDryRun('True');
    mockCascadeDelete.mockClear();
    const upper = await callWithDryRun('TRUE');

    expect(lower).toBe(true);
    expect(mixed).toBe(true);
    expect(upper).toBe(true);
  });

  it('dryRun missing or non-truthy parses to false (real delete)', async () => {
    const handler = getHandler('delete', '/accounts/:id');

    const { req: req1, res: res1 } = mockReqRes({ cascade: 'true' });
    await handler(req1, res1 as unknown as Response, () => undefined);
    expect((mockCascadeDelete.mock.calls[0][2] as { dryRun: boolean }).dryRun).toBe(false);

    mockCascadeDelete.mockClear();
    const { req: req2, res: res2 } = mockReqRes({ cascade: 'true', dryRun: 'false' });
    await handler(req2, res2 as unknown as Response, () => undefined);
    expect((mockCascadeDelete.mock.calls[0][2] as { dryRun: boolean }).dryRun).toBe(false);
  });

  it('cascade is also parsed case-insensitively', async () => {
    const handler = getHandler('delete', '/accounts/:id');

    for (const cascade of ['true', 'True', 'TRUE']) {
      mockCascadeDelete.mockClear();
      const { req, res } = mockReqRes({ cascade, dryRun: 'true' });
      await handler(req, res as unknown as Response, () => undefined);
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(mockCascadeDelete).toHaveBeenCalledTimes(1);
    }
  });

  it('returns 400 when cascade is missing or not truthy (regardless of casing)', async () => {
    const handler = getHandler('delete', '/accounts/:id');

    for (const cascade of ['', 'false', 'False', 'yes']) {
      mockCascadeDelete.mockClear();
      const { req, res } = mockReqRes({ cascade, dryRun: 'true' });
      await handler(req, res as unknown as Response, () => undefined);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'cascade_required' }),
      );
      expect(mockCascadeDelete).not.toHaveBeenCalled();
    }
  });

  it('wraps successful response in the PR-0 admin envelope (data + audit)', async () => {
    // Mock logAdminAction's INSERT (returns id + created_at via RETURNING).
    const { getPool } = jest.requireMock('../infrastructure/database') as {
      getPool: jest.Mock;
    };
    const poolQuery = jest.fn().mockResolvedValue({
      rows: [{ id: 'audit_xyz', created_at: new Date('2026-05-17T00:00:00Z') }],
    });
    getPool.mockReturnValue({ query: poolQuery });

    const handler = getHandler('delete', '/accounts/:id');
    const { req, res } = mockReqRes({ cascade: 'true', dryRun: 'true' });
    await handler(req, res as unknown as Response, () => undefined);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantsAffected: 0,
          memberRowsAcrossOtherTenants: 0,
        }),
        audit: expect.objectContaining({
          action: 'account.cascade_delete',
        }),
      }),
    );
  });

  it('Zod params validation rejects non-UUID :id with 400 invalid_request', async () => {
    // The handler is reached only after validateRequest({ params: idParam })
    // succeeds. Pull the *middleware* (first entry in the route stack) so we
    // can verify the Zod gate independently of the handler.
    type RouterStack = { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }> } }> };
    const stack = (adminRouter as unknown as RouterStack).stack;
    const layer = stack.find(
      (l) => l.route?.path === '/accounts/:id' && l.route?.methods.delete,
    );
    if (!layer?.route) throw new Error('DELETE /accounts/:id not registered');
    const middleware = layer.route.stack[0].handle;

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const req = {
      params: { id: 'not-a-uuid' },
      query: {},
      originalUrl: '/api/admin/accounts/not-a-uuid',
    } as unknown as Request;
    const next = jest.fn();

    middleware(req, res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_request', field: 'id' }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
