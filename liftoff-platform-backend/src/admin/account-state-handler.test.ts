// Tests for GET /api/admin/accounts/:accountId/state — PR 3 / Gap A.
//
// Handler-level tests via adminRouter.stack lookup (same pattern as
// cascade-delete-route.test.ts) for the success / 4xx / envelope-shape
// checks, plus a router-mounted supertest for the admin-auth gate (verifies
// 401 when no Firebase token is presented).

const mockReadAccountState = jest.fn();
const mockInferHealthIssues = jest.fn();
jest.mock('./account-state-service', () => {
  const actual = jest.requireActual<typeof import('./account-state-service')>(
    './account-state-service',
  );
  return {
    ...actual,
    readAccountState: mockReadAccountState,
    inferHealthIssues: mockInferHealthIssues,
  };
});

jest.mock('../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({})),
  AccountNotFoundError: class extends Error {
    accountId: string;
    constructor(accountId: string) {
      super('not found');
      this.name = 'AccountNotFoundError';
      this.accountId = accountId;
    }
  },
}));

const mockPoolQuery = jest.fn();
jest.mock('../infrastructure/database', () => ({
  withAdminScope: jest.fn(),
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
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
import { AccountNotFoundError } from '../accounts/service';
import type { Request, Response } from 'express';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

interface RouteLayer {
  route?: {
    path: string;
    methods: { [method: string]: boolean };
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>;
  };
}

function findRoute(method: string, path: string): RouteLayer['route'] {
  const stack = (adminRouter as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      return layer.route;
    }
  }
  throw new Error(`route ${method} ${path} not found`);
}

function getHandler(
  method: string,
  path: string,
): (req: Request, res: Response, next: (err?: unknown) => void) => Promise<unknown> {
  const route = findRoute(method, path)!;
  const handlers = route.stack;
  return handlers[handlers.length - 1].handle as (
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ) => Promise<unknown>;
}

function getMiddleware(
  method: string,
  path: string,
): (req: Request, res: Response, next: (err?: unknown) => void) => void {
  const route = findRoute(method, path)!;
  return route.stack[0].handle as (
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ) => void;
}

function mockReqRes(paramId: string = ACCOUNT_ID) {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const req = {
    params: { accountId: paramId },
    query: {},
    ctx: { adminId: 'admin-1' },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    adminAccount: { id: 'admin_acct_1', email: 'admin@example.com' },
  } as unknown as Request;
  return { req, res };
}

function fakeSnapshot(overrides: Record<string, unknown> = {}): unknown {
  return {
    account: {
      id: ACCOUNT_ID,
      email: 'admin@example.com',
      stripeCustomerId: 'cus_test',
      isPlatformAdmin: false,
    },
    tenants: [],
    entitlements: [],
    billingControls: null,
    contract: null,
    subscriptions: [],
    stripe: {
      activeSubscription: null,
      allSubscriptions: [],
      orphanSubscriptions: [],
      searchAvailable: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default audit-insert mock: RETURNING id, created_at.
  mockPoolQuery.mockResolvedValue({
    rows: [{ id: 'audit_state_1', created_at: new Date('2026-05-17T12:00:00Z') }],
  });
  mockInferHealthIssues.mockReturnValue([]);
});

describe('GET /api/admin/accounts/:accountId/state — handler', () => {
  it('returns the full snapshot wrapped in the admin envelope', async () => {
    const snapshot = fakeSnapshot();
    mockReadAccountState.mockResolvedValueOnce(snapshot);

    const handler = getHandler('get', '/accounts/:accountId/state');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: snapshot,
        audit: expect.objectContaining({ action: 'account.state.read' }),
        healthCheck: { ok: true, issues: [] },
      }),
    );
  });

  it('response.data matches the AccountStateSnapshot shape (top-level keys)', async () => {
    const snapshot = fakeSnapshot();
    mockReadAccountState.mockResolvedValueOnce(snapshot);

    const handler = getHandler('get', '/accounts/:accountId/state');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    const payload = res.json.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(payload.data).sort()).toEqual(
      ['account', 'billingControls', 'contract', 'entitlements', 'stripe', 'subscriptions', 'tenants'].sort(),
    );
  });

  it('response.audit.action equals "account.state.read"', async () => {
    mockReadAccountState.mockResolvedValueOnce(fakeSnapshot());

    const handler = getHandler('get', '/accounts/:accountId/state');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    const payload = res.json.mock.calls[0][0] as { audit: { action: string } };
    expect(payload.audit.action).toBe('account.state.read');
  });

  it('response.healthCheck.issues is non-empty when state has inconsistencies (e.g. orphan sub)', async () => {
    mockReadAccountState.mockResolvedValueOnce(
      fakeSnapshot({
        stripe: {
          activeSubscription: null,
          allSubscriptions: [],
          orphanSubscriptions: [{ id: 'sub_orphan', status: 'active', customer: 'cus_other', metadata: {} }],
          searchAvailable: true,
        },
      }),
    );
    mockInferHealthIssues.mockReturnValueOnce(['stripe_orphan_subscriptions_present']);

    const handler = getHandler('get', '/accounts/:accountId/state');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    const payload = res.json.mock.calls[0][0] as { healthCheck: { ok: boolean; issues: string[] } };
    expect(payload.healthCheck.ok).toBe(false);
    expect(payload.healthCheck.issues).toContain('stripe_orphan_subscriptions_present');
  });

  it('writes audit log via logAdminAction', async () => {
    mockReadAccountState.mockResolvedValueOnce(fakeSnapshot());

    const handler = getHandler('get', '/accounts/:accountId/state');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    // Find the INSERT INTO admin_action_audit call.
    const auditCall = mockPoolQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO admin_action_audit'),
    );
    expect(auditCall).toBeDefined();
    // Params: [adminId, action, targetType, targetId, details, ipAddress, userAgent]
    expect(auditCall?.[1][1]).toBe('account.state.read');
    expect(auditCall?.[1][2]).toBe('account');
    expect(auditCall?.[1][3]).toBe(ACCOUNT_ID);
  });

  it('returns 404 account_not_found when readAccountState throws AccountNotFoundError', async () => {
    mockReadAccountState.mockRejectedValueOnce(new AccountNotFoundError(ACCOUNT_ID));

    const handler = getHandler('get', '/accounts/:accountId/state');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'account_not_found' }),
    );
  });

  it('Zod params validation rejects non-UUID accountId with 400 invalid_request', () => {
    // Hit the Zod middleware directly (first entry in the route stack) so the
    // handler is bypassed.
    const middleware = getMiddleware('get', '/accounts/:accountId/state');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const req = {
      params: { accountId: 'not-a-uuid' },
      query: {},
      originalUrl: '/api/admin/accounts/not-a-uuid/state',
    } as unknown as Request;
    const next = jest.fn();

    middleware(req, res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_request', field: 'accountId' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('requires admin auth — GET without a Firebase token returns 401', async () => {
    // Real behavioral test: mount the admin router on an Express app and hit
    // the endpoint with no auth header. adminAuthMiddleware reads req.user?.uid
    // (set by the upstream Firebase middleware); without it, the middleware
    // short-circuits with 401 before the handler runs.
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRouter);

    const res = await request(app).get(`/api/admin/accounts/${ACCOUNT_ID}/state`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'Unauthorized' }),
    );
  });

  it('is registered outside the public-state bypass whitelist (defense-in-depth check)', () => {
    // Belt-and-braces complement to the behavioural 401 test above: confirm
    // the path does NOT match isPublicStateEndpoint's whitelist, so any
    // future refactor of that predicate can't silently un-gate this route.
    const route = findRoute('get', '/accounts/:accountId/state');
    expect(route).toBeDefined();
    expect(route!.path).toMatch(/^\/accounts\/:accountId\/state$/);
    expect(route!.path).not.toMatch(/\/(platform|connectors|workflow-types)\//);
  });
});
