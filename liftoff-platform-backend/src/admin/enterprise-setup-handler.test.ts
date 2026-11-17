// Tests for POST /api/admin/accounts/:accountId/enterprise-setup — PR 5.
//
// Unit-style mocks per Q4 — readAccountState, the contract helpers,
// billing-admin-client, getPool, and Stripe are all mocked at module level
// so each test isolates the orchestration logic in handleEnterpriseSetup.

const mockReadAccountState = jest.fn();
const mockUpsertEnterpriseContract = jest.fn();
const mockSyncRatesToBillingAndStripe = jest.fn();
jest.mock('./account-state-service', () => {
  const actual = jest.requireActual<typeof import('./account-state-service')>(
    './account-state-service',
  );
  return {
    ...actual,
    readAccountState: mockReadAccountState,
  };
});
jest.mock('./enterprise-contract-handler', () => {
  const actual = jest.requireActual<typeof import('./enterprise-contract-handler')>(
    './enterprise-contract-handler',
  );
  return {
    ...actual,
    upsertEnterpriseContract: mockUpsertEnterpriseContract,
    syncRatesToBillingAndStripe: mockSyncRatesToBillingAndStripe,
  };
});

const mockProvisionEnterprise = jest.fn();
jest.mock('../billing/billing-admin-client', () => ({
  getBillingAdminClient: jest.fn(() => ({ provisionEnterprise: mockProvisionEnterprise })),
}));

const mockSubscriptionsCancel = jest.fn();
jest.mock('stripe', () => {
  const RealStripe = jest.requireActual('stripe');
  const mockInstance = {
    subscriptions: { cancel: mockSubscriptionsCancel },
  };
  const MockStripe = jest.fn(() => mockInstance) as unknown as {
    (...args: unknown[]): typeof mockInstance;
    errors: typeof RealStripe.errors;
  };
  MockStripe.errors = RealStripe.errors;
  return { __esModule: true, default: MockStripe };
});

jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn(async () => 'sk_test_dummy'),
}));

const mockPoolQuery = jest.fn();
jest.mock('../infrastructure/database', () => ({
  withAdminScope: jest.fn(),
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../infrastructure/logging', () => ({
  log: mockLog,
  logAudit: jest.fn(),
  createLogger: jest.fn(() => mockLog),
}));

jest.mock('./service', () => ({ AdminService: jest.fn().mockImplementation(() => ({})) }));

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

import { adminRouter } from './router';
import { AccountNotFoundError } from '../accounts/service';
import type { Request, Response } from 'express';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const CUSTOMER_ID = 'cus_test_setup';
const SUB_ID = 'sub_test_setup';

interface RouteLayer {
  route?: {
    path: string;
    methods: { [m: string]: boolean };
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

function getHandler(method: string, path: string) {
  const route = findRoute(method, path)!;
  return route.stack[route.stack.length - 1].handle as (
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ) => Promise<unknown>;
}

function getMiddleware(method: string, path: string) {
  const route = findRoute(method, path)!;
  return route.stack[0].handle as (
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ) => void;
}

function fakeSnapshot(overrides: Record<string, unknown> = {}): unknown {
  return {
    account: { id: ACCOUNT_ID, email: 'a@x.com', stripeCustomerId: CUSTOMER_ID, isPlatformAdmin: false },
    tenants: [{ id: TENANT_ID, name: 'Primary', status: 'active', gcpProjectId: null, databaseName: null, role: 'owner', createdAt: '2026-01-01T00:00:00Z' }],
    entitlements: [],
    billingControls: { accountId: ACCOUNT_ID, billingTier: 'enterprise', stripeCustomerId: CUSTOMER_ID, stripeSubscriptionId: SUB_ID, suspended: false, suspendedReason: null, currentPeriodSpendUsd: '0', prepaidBalanceUsd: '0', updatedAt: '2026-05-18T00:00:00Z' },
    contract: null,
    subscriptions: [],
    stripe: {
      activeSubscription: { id: SUB_ID, status: 'active', customer: CUSTOMER_ID, metadata: { tenant_id: TENANT_ID } },
      allSubscriptions: [{ id: SUB_ID, status: 'active', customer: CUSTOMER_ID, metadata: { tenant_id: TENANT_ID } }],
      orphanSubscriptions: [],
      searchAvailable: true,
    },
    ...overrides,
  };
}

function snapshotWithNoActiveSub(): unknown {
  return fakeSnapshot({
    billingControls: { accountId: ACCOUNT_ID, billingTier: 'standard', stripeCustomerId: CUSTOMER_ID, stripeSubscriptionId: null, suspended: false, suspendedReason: null, currentPeriodSpendUsd: '0', prepaidBalanceUsd: '0', updatedAt: '2026-05-18T00:00:00Z' },
    stripe: { activeSubscription: null, allSubscriptions: [], orphanSubscriptions: [], searchAvailable: true },
  });
}

// Snapshot for plan test #2 — the prior sub is self-serve (billingTier =
// 'standard'), and the active Stripe sub on the canonical customer is the
// self-serve sub. Step A must still cancel it (different from test #3 which
// covers the Q6 enterprise-override case).
function snapshotWithActiveSelfServeSub(): unknown {
  return fakeSnapshot({
    billingControls: {
      accountId: ACCOUNT_ID,
      billingTier: 'standard', // self-serve tier
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
      suspended: false,
      suspendedReason: null,
      currentPeriodSpendUsd: '0',
      prepaidBalanceUsd: '0',
      updatedAt: '2026-05-18T00:00:00Z',
    },
    subscriptions: [
      {
        id: 'local_sub_self_serve',
        planId: 'core', // self-serve plan, not 'enterprise'
        stripeSubscriptionId: SUB_ID,
        status: 'active',
        currentPeriodStart: '2026-05-01T00:00:00Z',
        currentPeriodEnd: '2026-06-01T00:00:00Z',
        updatedAt: '2026-05-18T00:00:00Z',
      },
    ],
    // active Stripe sub is the self-serve one (same SUB_ID).
  });
}

const baseBody = {
  includedOus: 1_000_000,
  precommitExtraOus: 0,
  includedRateUsdPerOu: 0.02,
  precommitRateUsdPerOu: 0.02,
  reloadRateUsdPerOu: 0.02,
  stripeBilled: true,
  isAnnualPlan: false,
  annualTotalUsdCents: null,
  cancelExistingSubscription: true,
};

function mockReqRes(body: object = baseBody, paramId: string = ACCOUNT_ID) {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const req = {
    params: { accountId: paramId },
    body,
    query: {},
    ctx: { adminId: 'admin-1' },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    adminAccount: { id: 'admin_acct_1', email: 'admin@example.com' },
  } as unknown as Request;
  return { req, res };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default audit insert: logAdminAction expects RETURNING id, created_at.
  mockPoolQuery.mockResolvedValue({ rows: [{ id: 'audit_setup_1', created_at: new Date('2026-05-18T12:00:00Z') }] });
  // Default mutations succeed.
  mockUpsertEnterpriseContract.mockResolvedValue(undefined);
  mockSyncRatesToBillingAndStripe.mockResolvedValue(undefined);
  mockProvisionEnterprise.mockResolvedValue(undefined);
  mockSubscriptionsCancel.mockResolvedValue(undefined);
});

describe('POST /api/admin/accounts/:accountId/enterprise-setup', () => {
  // ── Happy path + Zod ───────────────────────────────────────────────────

  it('writes contract + provisions sub + returns snapshot with healthCheck.ok=true on fresh account', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithNoActiveSub()) // pre
      .mockResolvedValueOnce(snapshotWithNoActiveSub()); // post

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUpsertEnterpriseContract).toHaveBeenCalledTimes(1);
    expect(mockSyncRatesToBillingAndStripe).toHaveBeenCalledTimes(1);
    expect(mockProvisionEnterprise).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0] as { audit: { status: string }; healthCheck: { ok: boolean } };
    expect(payload.audit.status).toBe('success');
    expect(payload.healthCheck.ok).toBe(true);
  });

  it('with cancelExistingSubscription=true cancels the prior self-serve sub via Stripe (P5-C)', async () => {
    // Pre-snapshot has a SELF-SERVE active sub (billingTier='standard',
    // planId='core'). Step A must still cancel it — distinct from test #3
    // which tests the Q6 override against an enterprise sub.
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithActiveSelfServeSub())
      .mockResolvedValueOnce(snapshotWithNoActiveSub()); // post-cancel
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT status FROM subscriptions')) {
        return { rows: [{ status: 'canceled' }] };
      }
      return { rows: [{ id: 'audit_x', created_at: new Date() }] };
    });

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(mockSubscriptionsCancel).toHaveBeenCalledWith(SUB_ID, { prorate: false });
  });

  it('with cancelExistingSubscription=true ALSO cancels existing enterprise sub even when rates match (Q6 override)', async () => {
    // Snapshot already reflects an enterprise sub on the canonical customer.
    mockReadAccountState
      .mockResolvedValueOnce(fakeSnapshot())
      .mockResolvedValueOnce(fakeSnapshot());
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT status FROM subscriptions')) {
        return { rows: [{ status: 'canceled' }] };
      }
      return { rows: [{ id: 'audit_x', created_at: new Date() }] };
    });

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    // Body rates match the existing enterprise sub — Q6 says still cancel.
    const { req, res } = mockReqRes(baseBody);
    await handler(req, res as unknown as Response, () => undefined);

    expect(mockSubscriptionsCancel).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith(SUB_ID, { prorate: false });
  });

  it('with cancelExistingSubscription=false skips the cancel step (preserves operator opt-out)', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(fakeSnapshot())
      .mockResolvedValueOnce(fakeSnapshot());

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes({ ...baseBody, cancelExistingSubscription: false });
    await handler(req, res as unknown as Response, () => undefined);

    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    // The other steps still ran.
    expect(mockUpsertEnterpriseContract).toHaveBeenCalledTimes(1);
    expect(mockProvisionEnterprise).toHaveBeenCalledTimes(1);
  });

  it('falls back to direct DB flip when webhook mirror lags >10s, with mirror_wait_timeout warning', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(fakeSnapshot())
      .mockResolvedValueOnce(snapshotWithNoActiveSub());

    // Mirror NEVER flips — every poll returns status='active'.
    let updateCalled = false;
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT status FROM subscriptions')) {
        return { rows: [{ status: 'active' }] };
      }
      if (typeof sql === 'string' && sql.includes('UPDATE subscriptions') && sql.includes("status     = 'canceled'")) {
        updateCalled = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [{ id: 'audit_x', created_at: new Date() }] };
    });

    // Speed the poll: dynamically import the handler module and monkey-patch
    // setTimeout via jest.useFakeTimers would be cleaner, but the simplest
    // path is to short-circuit via a mocked global setTimeout.
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as NodeJS.Timeout;
    });

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(updateCalled).toBe(true);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID, subscriptionId: SUB_ID }),
      'admin.enterprise_setup.mirror_wait_timeout',
    );

    (global.setTimeout as unknown as jest.SpyInstance).mockRestore?.();
  });

  it('forwards cleanOrphanState=true to billing-admin-client.provisionEnterprise', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithNoActiveSub())
      .mockResolvedValueOnce(snapshotWithNoActiveSub());

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(mockProvisionEnterprise).toHaveBeenCalledTimes(1);
    expect(mockProvisionEnterprise.mock.calls[0][0]).toEqual(
      expect.objectContaining({ cleanOrphanState: true }),
    );
  });

  it('is idempotent — second invocation cancels what the first created, then re-creates (Q6)', async () => {
    // First run: pre = no active sub, post = has new sub.
    // Second run: pre = has active sub (from run 1), post = has another new sub.
    // Both runs must complete + log success.
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithNoActiveSub())  // run 1 pre
      .mockResolvedValueOnce(fakeSnapshot())              // run 1 post
      .mockResolvedValueOnce(fakeSnapshot())              // run 2 pre (has sub)
      .mockResolvedValueOnce(fakeSnapshot());             // run 2 post
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT status FROM subscriptions')) {
        return { rows: [{ status: 'canceled' }] };
      }
      return { rows: [{ id: 'audit_x', created_at: new Date() }] };
    });

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req: req1, res: res1 } = mockReqRes();
    await handler(req1, res1 as unknown as Response, () => undefined);
    expect(res1.status).toHaveBeenCalledWith(200);
    expect(mockProvisionEnterprise).toHaveBeenCalledTimes(1);

    const { req: req2, res: res2 } = mockReqRes();
    await handler(req2, res2 as unknown as Response, () => undefined);
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(mockSubscriptionsCancel).toHaveBeenCalledTimes(1); // Run 2 cancels run-1's sub.
    expect(mockProvisionEnterprise).toHaveBeenCalledTimes(2);
  });

  it('Zod rejects missing required fields with 400 invalid_request', () => {
    const middleware = getMiddleware('post', '/accounts/:accountId/enterprise-setup');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const req = {
      params: { accountId: ACCOUNT_ID },
      body: { /* missing includedOus etc. */ },
      query: {},
      originalUrl: `/api/admin/accounts/${ACCOUNT_ID}/enterprise-setup`,
    } as unknown as Request;
    const next = jest.fn();

    middleware(req, res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_request' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('writes audit log with full body details + cancelExistingSubscription via logAdminAction', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithNoActiveSub())
      .mockResolvedValueOnce(snapshotWithNoActiveSub());

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    const auditInsert = mockPoolQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO admin_action_audit'),
    );
    expect(auditInsert).toBeDefined();
    expect(auditInsert?.[1][1]).toBe('billing.enterprise.setup');
    expect(auditInsert?.[1][2]).toBe('account');
    expect(auditInsert?.[1][3]).toBe(ACCOUNT_ID);
    const details = JSON.parse(auditInsert?.[1][4] as string);
    expect(details).toEqual(
      expect.objectContaining({
        includedOus: baseBody.includedOus,
        includedRateUsdPerOu: baseBody.includedRateUsdPerOu,
        cancelExistingSubscription: true,
        failedStep: null,
      }),
    );
  });

  it('surfaces healthCheck.issues[] in the response when post-mutation state still has inconsistencies', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithNoActiveSub())
      .mockResolvedValueOnce(
        fakeSnapshot({
          stripe: {
            activeSubscription: null,
            allSubscriptions: [],
            orphanSubscriptions: [{ id: 'sub_orphan', status: 'active', customer: 'cus_other', metadata: {} }],
            searchAvailable: true,
          },
        }),
      );

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    const payload = res.json.mock.calls[0][0] as { audit: { status: string }; healthCheck: { ok: boolean; issues: string[] } };
    // Plan-literal: healthCheck.ok tracks the MUTATION outcome (failedStep ===
    // null), not whether inferHealthIssues returned anything. The two are
    // separate signals: `ok=true + issues non-empty` means "the operation
    // succeeded but post-mutation state still has curated inconsistencies."
    expect(payload.audit.status).toBe('success');
    expect(payload.healthCheck.ok).toBe(true);
    expect(payload.healthCheck.issues).toContain('stripe_orphan_subscriptions_present');
  });

  // ── Partial-failure tests (Q15) ─────────────────────────────────────────

  it('returns 200 + partial_failure when Step A (cancel existing) throws — response includes snapshot + failedStep', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(fakeSnapshot())
      .mockResolvedValueOnce(fakeSnapshot());
    mockSubscriptionsCancel.mockRejectedValueOnce(new Error('Stripe down'));

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0] as {
      audit: { status: string; failedStep: string };
      healthCheck: { ok: boolean; issues: string[] };
    };
    expect(payload.audit.status).toBe('partial_failure');
    expect(payload.audit.failedStep).toBe('cancel_existing');
    expect(payload.healthCheck.ok).toBe(false);
    expect(payload.healthCheck.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('step:cancel_existing failed:')]),
    );
  });

  it('returns 200 + partial_failure when Step B (upsert contract) throws', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithNoActiveSub())
      .mockResolvedValueOnce(snapshotWithNoActiveSub());
    mockUpsertEnterpriseContract.mockRejectedValueOnce(new Error('DB locked'));

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0] as { audit: { failedStep: string } };
    expect(payload.audit.failedStep).toBe('upsert_contract');
  });

  it('returns 200 + partial_failure when Step C (sync rates) throws', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithNoActiveSub())
      .mockResolvedValueOnce(snapshotWithNoActiveSub());
    mockSyncRatesToBillingAndStripe.mockRejectedValueOnce(new Error('Stripe rate-update failed'));

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0] as { audit: { failedStep: string } };
    expect(payload.audit.failedStep).toBe('sync_rates');
  });

  it('returns 200 + partial_failure when Step D (provision) throws', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithNoActiveSub())
      .mockResolvedValueOnce(snapshotWithNoActiveSub());
    mockProvisionEnterprise.mockRejectedValueOnce(new Error('billing 503'));

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0] as { audit: { failedStep: string } };
    expect(payload.audit.failedStep).toBe('provision_enterprise');
  });

  it('returns 404 when account not found (pre-mutation snapshot fails)', async () => {
    mockReadAccountState.mockRejectedValueOnce(new AccountNotFoundError(ACCOUNT_ID));

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'account_not_found' }),
    );
    // No mutation steps fired.
    expect(mockUpsertEnterpriseContract).not.toHaveBeenCalled();
    expect(mockSyncRatesToBillingAndStripe).not.toHaveBeenCalled();
    expect(mockProvisionEnterprise).not.toHaveBeenCalled();
  });

  it('audit log captures failedStep + failureError on partial failure', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithNoActiveSub())
      .mockResolvedValueOnce(snapshotWithNoActiveSub());
    mockSyncRatesToBillingAndStripe.mockRejectedValueOnce(new Error('rate-sync boom'));

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    const auditInsert = mockPoolQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO admin_action_audit'),
    );
    expect(auditInsert).toBeDefined();
    const details = JSON.parse(auditInsert?.[1][4] as string);
    expect(details.failedStep).toBe('sync_rates');
    expect(details.failureError).toBe('rate-sync boom');
  });

  it('short-circuits — when Step A fails, Steps B/C/D are NOT attempted', async () => {
    mockReadAccountState
      .mockResolvedValueOnce(fakeSnapshot())
      .mockResolvedValueOnce(fakeSnapshot());
    mockSubscriptionsCancel.mockRejectedValueOnce(new Error('Stripe down'));

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    await handler(req, res as unknown as Response, () => undefined);

    expect(mockUpsertEnterpriseContract).not.toHaveBeenCalled();
    expect(mockSyncRatesToBillingAndStripe).not.toHaveBeenCalled();
    expect(mockProvisionEnterprise).not.toHaveBeenCalled();
  });

  it('writes the audit row BEFORE the post-snapshot read — audit preserved when post-snapshot fails (P5-B + P5-D)', async () => {
    // Pre-snapshot succeeds; mutations succeed; POST-snapshot throws.
    // Expected: audit row IS written (capturing the mutation work), then
    // next(err) propagates the snapshot failure to the Express error handler.
    const snapshotErr = new Error('post-snapshot read failed');
    mockReadAccountState
      .mockResolvedValueOnce(snapshotWithNoActiveSub()) // pre OK
      .mockRejectedValueOnce(snapshotErr);              // post throws

    const handler = getHandler('post', '/accounts/:accountId/enterprise-setup');
    const { req, res } = mockReqRes();
    const next = jest.fn();
    await handler(req, res as unknown as Response, next);

    // next(err) was called with the snapshot failure.
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBe(snapshotErr);
    // Response was NOT sent (we deferred to the Express error handler).
    expect(res.status).not.toHaveBeenCalled();
    // CRITICAL: the audit row WAS written despite the snapshot failure.
    const auditInsert = mockPoolQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO admin_action_audit'),
    );
    expect(auditInsert).toBeDefined();
    expect(auditInsert?.[1][1]).toBe('billing.enterprise.setup');
    // Mutations ran successfully — audit captures that (failedStep=null).
    const details = JSON.parse(auditInsert?.[1][4] as string);
    expect(details.failedStep).toBeNull();
  });
});
