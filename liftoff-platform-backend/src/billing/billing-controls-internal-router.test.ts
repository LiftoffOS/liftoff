// Tests for the accountId param middleware in billing-controls-internal-router.
//
// PR 2a (Gap F) extends the existing fallback chain with:
//   - body.metadata.tenant_id resolution (when both billing_controls and
//     body.tenantId miss).
//   - Cross-account safety check on the primary path (billing_controls hit
//     plus metadata.tenant_id resolving to a different account = 409).
//   - ERROR-severity log `billing.internal.orphan_customer_no_resolution`
//     when every lookup misses (escalated from no-log).
//
// Unit-style mocks per Q4 — no real Postgres.

import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

jest.mock('rate-limiter-flexible', () => ({
  RateLimiterPostgres: jest.fn().mockImplementation(() => ({
    consume: jest.fn().mockResolvedValue({}),
  })),
  RateLimiterRes: class RateLimiterRes extends Error {},
}));

jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(),
  withAdminScope: jest.fn(),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../infrastructure/logging', () => ({ log: mockLog }));

// Silence external side-effects so we can hit `subscription-cancelled` without
// firing real notifications or downstream Stripe calls.
jest.mock('../infrastructure/email', () => ({
  sendPaymentFailedEmail: jest.fn().mockResolvedValue('email-id'),
  sendSubscriptionConfirmationEmail: jest.fn().mockResolvedValue('email-id'),
  sendSubscriptionEndingEmail: jest.fn().mockResolvedValue('email-id'),
  sendSubscriptionEndedEmail: jest.fn().mockResolvedValue('email-id'),
  sendReceiptEmail: jest.fn().mockResolvedValue('email-id'),
  sendCardExpiringEmail: jest.fn().mockResolvedValue('email-id'),
}));
jest.mock('./subscription-items-service', () => ({
  syncSubscriptionItems: jest.fn().mockResolvedValue(undefined),
  updatePlatformFeeQuantity: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./addon-service', () => ({
  activateAddon: jest.fn().mockResolvedValue(undefined),
  deactivateAddon: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./operating-unit-service', () => ({
  getOperatingUnitsForPeriod: jest.fn().mockResolvedValue({ totalOus: 0, byAgent: [] }),
}));
jest.mock('./execution-guard', () => ({
  invalidateExecutionCache: jest.fn(),
}));
jest.mock('./threshold-charge-service', () => ({
  runThresholdCheck: jest.fn(),
}));
// The only billing-admin call this router makes: retrying a declined auto-reload
// when a new card is attached.
const mockTriggerAutoReload = jest.fn();
jest.mock('./billing-admin-client', () => ({
  getBillingAdminClient: () => ({ triggerAutoReload: mockTriggerAutoReload }),
}));
jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn(async () => 'sk_test_dummy'),
}));

// `enableAgentExecution` is the only EntitlementService method this router uses.
const mockEnableAgentExecution = jest.fn();
jest.mock('../entitlements/service', () => ({
  EntitlementService: jest.fn().mockImplementation(() => ({
    enableAgentExecution: mockEnableAgentExecution,
  })),
}));

// Republishing every tenant's entitlement snapshot is the publisher's own job
// and has its own tests. Mocked here so a router test asserts THAT the router
// publishes, not how the publish is carried out.
const mockPublishBillingSuspensionChange = jest.fn().mockResolvedValue(undefined);
jest.mock('./billing-suspension-publisher', () => ({
  publishBillingSuspensionChange: (...args: unknown[]) => mockPublishBillingSuspensionChange(...args),
}));

import { getPool, withAdminScope } from '../infrastructure/database';
import { billingControlsInternalRouter } from './billing-controls-internal-router';

const BILLING_TOKEN = 'test-billing-service-token-32chars';
const STRIPE_CUSTOMER_ID = 'cus_test_orphan_001';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/billing', billingControlsInternalRouter);
  return app;
}

function sign(method: string, path: string, body: object): { timestamp: string; signature: string } {
  const timestamp = Date.now();
  const bodyStr = JSON.stringify(body);
  const signature = createHmac('sha256', BILLING_TOKEN)
    .update(`${method}\n${path}\n${timestamp}\n${bodyStr}`)
    .digest('hex');
  return { timestamp: String(timestamp), signature };
}

function signedPost(app: ReturnType<typeof buildApp>, path: string, body: object = {}) {
  const { timestamp, signature } = sign('POST', path, body);
  return request(app)
    .post(path)
    .set('X-Billing-Timestamp', timestamp)
    .set('X-Billing-Signature', signature)
    .send(body);
}

function signedGet(app: ReturnType<typeof buildApp>, path: string) {
  // GET bodies are empty; the HMAC convention signs '{}' (JSON.stringify of
  // the parsed empty body) — matches PlatformBackendClient's GET signing.
  const { timestamp, signature } = sign('GET', path, {});
  return request(app)
    .get(path)
    .set('X-Billing-Timestamp', timestamp)
    .set('X-Billing-Signature', signature);
}

// Wire up a fresh pool whose `query` returns the supplied responses in order.
// The middleware does up to 2 queries; the subscription-cancelled handler does
// 3 more after resolution. Anything past the programmed list defaults to an
// empty-rows OK response so the handler can run without erroring.
function mockPool(responses: Array<{ rows: unknown[]; rowCount?: number }>): jest.Mock {
  const query = jest.fn();
  for (const r of responses) {
    query.mockResolvedValueOnce({ rows: r.rows, rowCount: r.rowCount ?? r.rows.length });
  }
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  (getPool as jest.Mock).mockReturnValue({ query });
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BILLING_SERVICE_TOKEN = BILLING_TOKEN;
});

describe('accountId param middleware — resolution (PR 2a)', () => {
  it('resolves cus_* via billing_controls.stripe_customer_id (positive control)', async () => {
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // billing_controls hit
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${STRIPE_CUSTOMER_ID}/subscription-cancelled`;
    const res = await signedPost(app, path, {});

    expect(res.status).toBe(200);
    // First query is the billing_controls lookup.
    expect(query.mock.calls[0][0]).toMatch(/SELECT account_id FROM billing_controls/);
    expect(query.mock.calls[0][1]).toEqual([STRIPE_CUSTOMER_ID]);
    // Handler queries that follow use the resolved account_id, not the cus_*.
    const handlerCall = query.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('UPDATE billing_controls SET'),
    );
    expect(handlerCall).toBeDefined();
    expect(handlerCall?.[1]).toContain(ACCOUNT_ID_A);
  });

  it('falls back to body.tenantId when billing_controls lookup misses (regression — existing path)', async () => {
    const query = mockPool([
      { rows: [] }, // billing_controls miss
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // tenants lookup hits
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${STRIPE_CUSTOMER_ID}/subscription-cancelled`;
    const res = await signedPost(app, path, { tenantId: TENANT_ID });

    expect(res.status).toBe(200);
    expect(query.mock.calls[1][0]).toMatch(/SELECT account_id FROM tenants/);
    expect(query.mock.calls[1][1]).toEqual([TENANT_ID]);
  });

  it('falls back to body.metadata.tenant_id when both prior lookups miss (NEW)', async () => {
    const query = mockPool([
      { rows: [] }, // billing_controls miss
      // No body.tenantId so middleware skips that branch — next query is the
      // metadata.tenant_id lookup.
      { rows: [{ account_id: ACCOUNT_ID_A }] },
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${STRIPE_CUSTOMER_ID}/subscription-cancelled`;
    const res = await signedPost(app, path, { metadata: { tenant_id: TENANT_ID } });

    expect(res.status).toBe(200);
    expect(query.mock.calls[1][0]).toMatch(/SELECT account_id FROM tenants/);
    expect(query.mock.calls[1][1]).toEqual([TENANT_ID]);
  });

  it('logs ERROR (not info/warn) and 404s when every lookup misses (all three fallback paths exercised)', async () => {
    // Body carries BOTH body.tenantId AND body.metadata.tenant_id so every
    // fallback in the chain fires and misses. Order of pool queries:
    //   1. billing_controls.stripe_customer_id   → miss
    //   2. tenants.id WHERE id = body.tenantId   → miss
    //   3. tenants.id WHERE id = body.metadata.tenant_id → miss
    mockPool([
      { rows: [] }, // billing_controls miss
      { rows: [] }, // body.tenantId lookup miss
      { rows: [] }, // body.metadata.tenant_id lookup miss
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${STRIPE_CUSTOMER_ID}/subscription-cancelled`;
    const res = await signedPost(app, path, {
      tenantId: TENANT_ID,
      metadata: { tenant_id: TENANT_ID },
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'account_not_found_for_customer' });
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ stripeCustomerId: STRIPE_CUSTOMER_ID, path }),
      'billing.internal.orphan_customer_no_resolution',
    );
    // Critical: must not silently info/warn — operator visibility was the gap.
    expect(mockLog.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'billing.internal.orphan_customer_no_resolution',
    );
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'billing.internal.orphan_customer_no_resolution',
    );
  });

  it('subscription-cancelled with orphan customer + valid metadata.tenant_id flips local mirror to canceled', async () => {
    const query = mockPool([
      { rows: [] }, // billing_controls miss
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // metadata.tenant_id lookup hits
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${STRIPE_CUSTOMER_ID}/subscription-cancelled`;
    const res = await signedPost(app, path, { metadata: { tenant_id: TENANT_ID } });

    expect(res.status).toBe(200);
    // Verify mirrorSubscriptionCanceled UPDATE fired with the resolved account_id.
    const mirrorCall = query.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes("status     = 'canceled'"),
    );
    expect(mirrorCall).toBeDefined();
    expect(mirrorCall?.[1]).toEqual([ACCOUNT_ID_A]);
  });

  it('rejects with 409 when metadata.tenant_id resolves to a different account than the cus_* hint (cross-account safety)', async () => {
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // billing_controls says cus_* → A
      { rows: [{ account_id: ACCOUNT_ID_B }] }, // tenants says metadata.tenant_id → B
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${STRIPE_CUSTOMER_ID}/subscription-cancelled`;
    const res = await signedPost(app, path, { metadata: { tenant_id: TENANT_ID } });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'cross_account_metadata_mismatch' });
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeCustomerId: STRIPE_CUSTOMER_ID,
        resolvedFromBillingControls: ACCOUNT_ID_A,
        resolvedFromMetadataTenantId: ACCOUNT_ID_B,
        metadataTenantId: TENANT_ID,
      }),
      'billing.internal.orphan_customer_cross_account_mismatch',
    );
    // Handler must not have run — verify by absence of any UPDATE call.
    const ranHandler = query.mock.calls.some((c) =>
      typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE'),
    );
    expect(ranHandler).toBe(false);
  });

  it('accepts metadata.tenant_id that resolves to the SAME account as billing_controls (no cross-account false positive)', async () => {
    mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // billing_controls → A
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // tenants → A (match)
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${STRIPE_CUSTOMER_ID}/subscription-cancelled`;
    const res = await signedPost(app, path, { metadata: { tenant_id: TENANT_ID } });

    expect(res.status).toBe(200);
    expect(mockLog.error).not.toHaveBeenCalledWith(
      expect.anything(),
      'billing.internal.orphan_customer_cross_account_mismatch',
    );
  });

  it('bypasses resolution for non-cus_ accountId values', async () => {
    const query = mockPool([]); // no expected param-middleware queries

    const app = buildApp();
    const path = `/api/internal/billing/controls/${ACCOUNT_ID_A}/subscription-cancelled`;
    const res = await signedPost(app, path, {});

    expect(res.status).toBe(200);
    // Middleware should not have fired the billing_controls lookup — first
    // query (if any) belongs to the handler, not the resolver.
    if (query.mock.calls.length > 0) {
      expect(query.mock.calls[0][0]).not.toMatch(/SELECT account_id FROM billing_controls/);
    }
  });
});

describe('GET /customers — reconciliation customer listing', () => {
  it('returns every billing_controls customer with its pointers and suspension state', async () => {
    mockPool([
      {
        rows: [
          { account_id: ACCOUNT_ID_A, stripe_customer_id: 'cus_a', stripe_subscription_id: 'sub_a', suspended: false },
          { account_id: ACCOUNT_ID_B, stripe_customer_id: 'cus_b', stripe_subscription_id: null, suspended: true },
        ],
      },
    ]);

    const app = buildApp();
    const res = await signedGet(app, '/api/internal/billing/customers');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customers: [
        { accountId: ACCOUNT_ID_A, stripeCustomerId: 'cus_a', stripeSubscriptionId: 'sub_a', suspended: false },
        { accountId: ACCOUNT_ID_B, stripeCustomerId: 'cus_b', stripeSubscriptionId: null, suspended: true },
      ],
    });
  });

  it('rejects unsigned requests', async () => {
    mockPool([]);
    const app = buildApp();
    const res = await request(app).get('/api/internal/billing/customers');
    expect(res.status).toBe(401);
  });
});

describe('subscription-cancelled — stale-subscription guard', () => {
  const CURRENT_CUSTOMER = 'cus_current_live_00001';
  const STALE_CUSTOMER = 'cus_stale_abandoned_01';
  const CURRENT_SUB = 'sub_current_live_00001';
  const STALE_SUB = 'sub_stale_orphan_0001';

  // Pool responses for a request that resolves via the metadata.tenant_id
  // fallback (the stale-customer path): billing_controls lookup by the stale cus_
  // misses, tenants lookup hits, then the handler reads the account's
  // current billing_controls pointers.
  function mockStaleResolutionPool(pointers: { stripe_customer_id: string | null; stripe_subscription_id: string | null }) {
    return mockPool([
      { rows: [] }, // middleware: billing_controls miss for the stale cus_
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // middleware: tenants hit via metadata.tenant_id
      { rows: [pointers] }, // handler: current billing_controls pointers
    ]);
  }

  function suspendCall(query: jest.Mock) {
    return query.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes("suspended        = TRUE"),
    );
  }

  it('ignores a cancellation whose customer is not the account\'s current customer', async () => {
    const query = mockStaleResolutionPool({
      stripe_customer_id: CURRENT_CUSTOMER,
      stripe_subscription_id: CURRENT_SUB,
    });

    const app = buildApp();
    const path = `/api/internal/billing/controls/${STALE_CUSTOMER}/subscription-cancelled`;
    const res = await signedPost(app, path, {
      metadata: { tenant_id: TENANT_ID },
      subscriptionId: STALE_SUB,
      stripeCustomerId: STALE_CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ignored: true });
    expect(suspendCall(query)).toBeUndefined();
    // The stale sub's OWN mirror row is cancelled — targeted by sub id, never
    // the account-level active row.
    const mirrorCall = query.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('stripe_subscription_id = $2'),
    );
    expect(mirrorCall).toBeDefined();
    expect(mirrorCall?.[1]).toEqual([ACCOUNT_ID_A, STALE_SUB]);
    // No blanket active-row flip.
    const blanketCall = query.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes("status = 'active'") && (c[0] as string).startsWith('UPDATE'),
    );
    expect(blanketCall).toBeUndefined();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID_A,
        cancelledSubscriptionId: STALE_SUB,
        cancelledCustomerId: STALE_CUSTOMER,
        currentSubscriptionId: CURRENT_SUB,
        currentCustomerId: CURRENT_CUSTOMER,
      }),
      'billing.controls.stale_subscription_cancel_ignored',
    );
  });

  it('ignores a same-customer cancellation whose subscription id is not the current one (untracked orphan on the live customer)', async () => {
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // middleware: billing_controls hit (live customer)
      { rows: [{ stripe_customer_id: CURRENT_CUSTOMER, stripe_subscription_id: CURRENT_SUB }] }, // handler pointers
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${CURRENT_CUSTOMER}/subscription-cancelled`;
    const res = await signedPost(app, path, {
      subscriptionId: STALE_SUB,
      stripeCustomerId: CURRENT_CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ignored: true });
    expect(suspendCall(query)).toBeUndefined();
  });

  it('suspends when the cancelled subscription IS the account\'s current one', async () => {
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // middleware: billing_controls hit
      { rows: [{ stripe_customer_id: CURRENT_CUSTOMER, stripe_subscription_id: CURRENT_SUB }] }, // handler pointers
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${CURRENT_CUSTOMER}/subscription-cancelled`;
    const res = await signedPost(app, path, {
      subscriptionId: CURRENT_SUB,
      stripeCustomerId: CURRENT_CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(suspendCall(query)).toBeDefined();
    // Mirror flip is targeted at the cancelled sub's row.
    const mirrorCall = query.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('stripe_subscription_id = $2'),
    );
    expect(mirrorCall?.[1]).toEqual([ACCOUNT_ID_A, CURRENT_SUB]);
  });

  it('suspends when billing_controls.stripe_subscription_id is NULL (pointer never set — legacy tolerance)', async () => {
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // middleware: billing_controls hit
      { rows: [{ stripe_customer_id: CURRENT_CUSTOMER, stripe_subscription_id: null }] }, // handler pointers
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${CURRENT_CUSTOMER}/subscription-cancelled`;
    const res = await signedPost(app, path, {
      subscriptionId: CURRENT_SUB,
      stripeCustomerId: CURRENT_CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(suspendCall(query)).toBeDefined();
  });

  it('suspends on a legacy body (no subscriptionId/stripeCustomerId) when the URL customer matches — backwards compatible', async () => {
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] }, // middleware: billing_controls hit
      { rows: [{ stripe_customer_id: CURRENT_CUSTOMER, stripe_subscription_id: CURRENT_SUB }] }, // handler pointers
    ]);

    const app = buildApp();
    const path = `/api/internal/billing/controls/${CURRENT_CUSTOMER}/subscription-cancelled`;
    const res = await signedPost(app, path, {});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(suspendCall(query)).toBeDefined();
    // Legacy path cannot target a sub id — blanket active-row mirror flip.
    const blanketCall = query.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes("status = 'active'") && (c[0] as string).startsWith('UPDATE'),
    );
    expect(blanketCall).toBeDefined();
  });

  it('ignores a legacy body arriving via the stale-customer URL (URL-derived customer check still applies)', async () => {
    const query = mockStaleResolutionPool({
      stripe_customer_id: CURRENT_CUSTOMER,
      stripe_subscription_id: CURRENT_SUB,
    });

    const app = buildApp();
    const path = `/api/internal/billing/controls/${STALE_CUSTOMER}/subscription-cancelled`;
    const res = await signedPost(app, path, { metadata: { tenant_id: TENANT_ID } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ignored: true });
    expect(suspendCall(query)).toBeUndefined();
  });

  it('is idempotent under redelivery — a repeated stale cancellation ignores twice, a repeated current cancellation suspends twice', async () => {
    // Stale, delivered twice.
    for (let i = 0; i < 2; i++) {
      const query = mockStaleResolutionPool({
        stripe_customer_id: CURRENT_CUSTOMER,
        stripe_subscription_id: CURRENT_SUB,
      });
      const app = buildApp();
      const res = await signedPost(
        app,
        `/api/internal/billing/controls/${STALE_CUSTOMER}/subscription-cancelled`,
        { metadata: { tenant_id: TENANT_ID }, subscriptionId: STALE_SUB, stripeCustomerId: STALE_CUSTOMER },
      );
      expect(res.body).toEqual({ ok: true, ignored: true });
      expect(suspendCall(query)).toBeUndefined();
    }
    // Current, delivered twice — the suspend UPDATE is a no-op on repeat but
    // must fire (same terminal state) on every delivery.
    for (let i = 0; i < 2; i++) {
      const query = mockPool([
        { rows: [{ account_id: ACCOUNT_ID_A }] },
        { rows: [{ stripe_customer_id: CURRENT_CUSTOMER, stripe_subscription_id: CURRENT_SUB }] },
      ]);
      const app = buildApp();
      const res = await signedPost(
        app,
        `/api/internal/billing/controls/${CURRENT_CUSTOMER}/subscription-cancelled`,
        { subscriptionId: CURRENT_SUB, stripeCustomerId: CURRENT_CUSTOMER },
      );
      expect(res.body).toEqual({ ok: true });
      expect(suspendCall(query)).toBeDefined();
    }
  });
});

// ── POST /restart-full-distill/:tenantId — REMOVED (ADR-050) ───────────────
//
// The route is gone along with its only caller (liftoff-billing's Stripe
// webhook consumer). Asserted rather than simply deleted with the feature: an
// HMAC-authed route removed from under a cross-repo caller is exactly the kind
// of change that gets quietly reinstated, and the reinstated version would read
// onboarding_hire_input — a column being dropped.
describe('restart-full-distill — removed (ADR-050)', () => {
  it('404s: the route is no longer mounted', async () => {
    mockPool([]);
    const res = await signedPost(
      buildApp(),
      '/api/internal/billing/restart-full-distill/33333333-3333-3333-3333-333333333333',
    );
    expect(res.status).toBe(404);
  });

  it('the router source names no onboarding_ column', () => {
    // The whole point of removing it rather than stubbing it: nothing in this
    // router may write or read a column the follow-up migration drops.
    const src = readFileSync(join(__dirname, 'billing-controls-internal-router.ts'), 'utf8');
    const codeOnly = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(codeOnly).not.toMatch(/onboarding_/);
  });
});

// The activation/init race. A self-serve checkout can activate a couple of
// seconds before /controls/init creates the billing_controls row. The
// activation UPDATE then matches zero rows, dropping the plan, the OU
// allowance, the rates and `suspended = FALSE`; init then creates the row on
// its pre-pay default of suspended = TRUE and never resets it. If, in the same
// request, `enableAgentExecution` throws on a broken snapshot INSERT and is
// swallowed, the endpoint answers 200 to both, so a customer who has paid is
// left suspended with agent_execution_allowed = false and no retry pending.
describe('subscription-activated — activation must not depend on init having run', () => {
  const CUSTOMER = 'cus_activation_00001';

  // Pool responses in handler order for a resolved self-serve activation:
  // middleware billing_controls hit, the seeding INSERT, the plan_catalog rate
  // lookup, then the activation UPDATE (one row) and the mirror UPDATE.
  function mockActivationPool() {
    return mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [] },
      { rows: [{ included_rate_usd_per_ou: '0.025', precommit_rate_usd_per_ou: '0.02', reload_rate_usd_per_ou: '0.03' }] },
      { rows: [], rowCount: 1 },
      { rows: [{ id: 'sub-mirror-row' }], rowCount: 1 },
    ]);
  }

  function activate(body: object = {}) {
    return signedPost(
      buildApp(),
      `/api/internal/billing/controls/${CUSTOMER}/subscription-activated`,
      { planType: 'growth', includedOus: 2150, stripeSubscriptionId: 'sub_live_0001', ...body },
    );
  }

  beforeEach(() => {
    mockEnableAgentExecution.mockResolvedValue(undefined);
    (withAdminScope as jest.Mock).mockImplementation(
      async (_opts: unknown, cb: (client: { query: jest.Mock }) => Promise<unknown>) =>
        cb({ query: jest.fn().mockResolvedValue({ rows: [{ tenant_id: TENANT_ID }] }) }),
    );
  });

  it('seeds the billing_controls row before the activation UPDATE, so ordering against init cannot matter', async () => {
    const query = mockActivationPool();
    const res = await activate();
    expect(res.status).toBe(200);

    const sqls = query.mock.calls.map((c) => String(c[0]));
    const seedIdx = sqls.findIndex((s) => /INSERT INTO billing_controls[\s\S]*ON CONFLICT \(account_id\) DO NOTHING/.test(s));
    const updateIdx = sqls.findIndex((s) => s.includes('suspended                 = FALSE'));

    expect(seedIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(seedIdx).toBeLessThan(updateIdx);
    // Seeded on init's own defaults, so whichever caller lands first the row matches.
    expect(query.mock.calls[seedIdx][0]).toMatch(/'pre_pay', TRUE/);
    expect(query.mock.calls[seedIdx][1]).toEqual([ACCOUNT_ID_A]);
  });

  it('logs loudly when the activation UPDATE matches no row instead of reporting success', async () => {
    // rowCount 0 on the activation UPDATE.
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [] },
      { rows: [{ included_rate_usd_per_ou: '0.025', precommit_rate_usd_per_ou: '0.02', reload_rate_usd_per_ou: '0.03' }] },
      { rows: [], rowCount: 0 },
    ]);
    await activate();
    expect(query).toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing.controls.activation_matched_no_row' }),
      expect.stringContaining('matched no billing_controls row'),
    );
  });

  it('answers 500 when agent execution could not be enabled, so the caller retries', async () => {
    mockActivationPool();
    mockEnableAgentExecution.mockRejectedValue(new Error('INSERT has more target columns than expressions'));

    const res = await activate();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'agent_execution_enable_failed', tenantIds: [TENANT_ID] });
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing.controls.activation_exec_enable_failed' }),
      expect.stringContaining('answering 500'),
    );
  });

  it('enables execution only AFTER the unsuspend, so the published event is not stale', async () => {
    // enableAgentExecution publishes tenant.entitlement.updated, and that
    // payload carries billingSuspended read from billing_controls. Running it
    // before the UPDATE that clears `suspended` publishes "suspended" for an
    // account being unsuspended in the same request: agentExecutionAllowed true
    // beside billingSuspended true. Pin the order across both mocks.
    const query = mockActivationPool();
    let queriesIssuedWhenEnabled = -1;
    mockEnableAgentExecution.mockImplementation(async () => {
      queriesIssuedWhenEnabled = query.mock.calls.length;
    });

    const res = await activate();
    expect(res.status).toBe(200);

    const unsuspendIdx = query.mock.calls
      .map((c) => String(c[0]))
      .findIndex((s) => s.includes('suspended                 = FALSE'));

    expect(unsuspendIdx).toBeGreaterThanOrEqual(0);
    expect(queriesIssuedWhenEnabled).toBeGreaterThan(unsuspendIdx);
  });

  it('still answers 200 when every tenant is enabled', async () => {
    mockActivationPool();
    const res = await activate();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockEnableAgentExecution).toHaveBeenCalledWith(TENANT_ID);
  });
});


// ── /referral-bonus ─────────────────────────────────────────────────────────
//
// The referee half of the referral programme. Two properties matter and both
// are one-line-away from being wrong: the grant must be idempotent, because
// Stripe redelivers webhooks and a second grant would double a workspace's
// allowance for free; and it must refuse an account it has never provisioned
// rather than silently succeeding.

describe('referral-bonus — the referee grant', () => {
  const REFERRAL_ID = '77777777-7777-4777-8777-777777777777';

  it('grants once and says it did', async () => {
    const query = mockPool([
      // The UPDATE ... WHERE referral_bonus_referral_id IS NULL matched.
      { rows: [{ referral_bonus_ous: '800', referral_bonus_referral_id: REFERRAL_ID }] },
    ]);
    const res = await signedPost(
      buildApp(),
      `/api/internal/billing/controls/${ACCOUNT_ID_A}/referral-bonus`,
      { referralId: REFERRAL_ID, bonusOus: 800 },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ granted: true, alreadyGranted: false, referralBonusOus: 800 });
    expect(query.mock.calls[0][0]).toContain('referral_bonus_referral_id IS NULL');
  });

  it('refuses a second grant on a redelivered invoice', async () => {
    const query = mockPool([
      // The guarded UPDATE matched nothing...
      { rows: [] },
      // ...and the row exists, already carrying a bonus.
      { rows: [{ referral_bonus_referral_id: REFERRAL_ID }] },
    ]);
    const res = await signedPost(
      buildApp(),
      `/api/internal/billing/controls/${ACCOUNT_ID_A}/referral-bonus`,
      { referralId: REFERRAL_ID, bonusOus: 800 },
    );

    // 200 rather than an error: a redelivery is the ordinary case, and the
    // caller needs to tell "already done" from "failed".
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ granted: false, alreadyGranted: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('404s an account with no billing_controls row', async () => {
    mockPool([
      { rows: [] }, // guarded UPDATE matched nothing
      { rows: [] }, // and there is no row at all
    ]);
    const res = await signedPost(
      buildApp(),
      `/api/internal/billing/controls/${ACCOUNT_ID_A}/referral-bonus`,
      { referralId: REFERRAL_ID, bonusOus: 800 },
    );

    expect(res.status).toBe(404);
  });

  it('rejects a non-positive grant rather than writing it', async () => {
    const query = mockPool([]);
    const res = await signedPost(
      buildApp(),
      `/api/internal/billing/controls/${ACCOUNT_ID_A}/referral-bonus`,
      { referralId: REFERRAL_ID, bonusOus: 0 },
    );

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a call with no referral to attribute the grant to', async () => {
    const res = await signedPost(
      buildApp(),
      `/api/internal/billing/controls/${ACCOUNT_ID_A}/referral-bonus`,
      { bonusOus: 800 },
    );

    expect(res.status).toBe(400);
  });
});

describe('subscription-activated — the period counters start the period', () => {
  const CUSTOMER = 'cus_counters_00001';

  beforeEach(() => {
    mockEnableAgentExecution.mockResolvedValue(undefined);
    (withAdminScope as jest.Mock).mockImplementation(
      async (_opts: unknown, cb: (client: { query: jest.Mock }) => Promise<unknown>) =>
        cb({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
    );
  });

  // A workspace can arrive here with a long consumption history: /period-reset
  // fires on a paid subscription invoice, and one funding itself with credit has
  // neither. Carrying that forward would spend the plan allowance the customer
  // just bought, so activation resets rather than trusting the fire-and-forget
  // reset to land.
  function activationUpdateSql(query: jest.Mock): string {
    const sqls = query.mock.calls.map((c) => String(c[0]));
    return sqls.find((s) => s.includes('suspended                 = FALSE')) ?? '';
  }

  it('zeroes consumption, spend and the referral grant on the self-serve branch', async () => {
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [] },
      { rows: [{ included_rate_usd_per_ou: '0.025', precommit_rate_usd_per_ou: '0.028', reload_rate_usd_per_ou: '0.03125' }] },
      { rows: [], rowCount: 1 },
      { rows: [{ id: 'sub-mirror-row' }], rowCount: 1 },
    ]);

    const res = await signedPost(
      buildApp(),
      `/api/internal/billing/controls/${CUSTOMER}/subscription-activated`,
      { planType: 'core', includedOus: 800, stripeSubscriptionId: 'sub_live_counters' },
    );

    expect(res.status).toBe(200);
    const sql = activationUpdateSql(query);
    expect(sql).toMatch(/ous_consumed_this_period\s+= 0/);
    expect(sql).toMatch(/current_period_spend_usd\s+= 0/);
    expect(sql).toMatch(/referral_bonus_ous\s+= 0/);
  });

  it('zeroes them on the enterprise branch too', async () => {
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [] },
      { rows: [], rowCount: 1 },
      { rows: [{ id: 'sub-mirror-row' }], rowCount: 1 },
    ]);

    const res = await signedPost(
      buildApp(),
      `/api/internal/billing/controls/${CUSTOMER}/subscription-activated`,
      { billingTier: 'enterprise', includedOus: 50000, stripeSubscriptionId: 'sub_live_ent' },
    );

    expect(res.status).toBe(200);
    const sql = activationUpdateSql(query);
    expect(sql).toMatch(/ous_consumed_this_period\s+= 0/);
    expect(sql).toMatch(/current_period_spend_usd\s+= 0/);
    expect(sql).toMatch(/referral_bonus_ous\s+= 0/);
  });
});

describe('prepaid-topped-up — funded credit clears the workspace to run', () => {
  const CUSTOMER = 'cus_topup_00001';

  beforeEach(() => {
    mockEnableAgentExecution.mockResolvedValue(undefined);
    (withAdminScope as jest.Mock).mockImplementation(
      async (_opts: unknown, cb: (client: { query: jest.Mock }) => Promise<unknown>) =>
        cb({ query: jest.fn().mockResolvedValue({ rows: [{ tenant_id: TENANT_ID }] }) }),
    );
  });

  function topUp(amountUsd: number) {
    return signedPost(
      buildApp(),
      `/api/internal/billing/controls/${CUSTOMER}/prepaid-topped-up`,
      { amountUsd },
    );
  }

  it('enables agent execution once the balance is positive', async () => {
    mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [{ reload_balance_usd: '25.00' }], rowCount: 1 },
    ]);

    const res = await topUp(25);

    expect(res.status).toBe(200);
    expect(res.body.reloadBalanceUsd).toBe(25);
    expect(mockEnableAgentExecution).toHaveBeenCalledWith(TENANT_ID);
  });

  // A clawback can leave the balance negative. Topping up less than the debt
  // buys nothing, so it must not clear a workspace that still cannot pay.
  it('leaves execution alone when the balance is still not positive', async () => {
    mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [{ reload_balance_usd: '-4.00' }], rowCount: 1 },
    ]);

    const res = await topUp(10);

    expect(res.status).toBe(200);
    expect(mockEnableAgentExecution).not.toHaveBeenCalled();
  });

  it('answers 500 when the entitlement half fails, so the sender retries', async () => {
    mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [{ reload_balance_usd: '25.00' }], rowCount: 1 },
    ]);
    mockEnableAgentExecution.mockRejectedValue(new Error('snapshot insert failed'));

    const res = await topUp(25);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('agent_execution_enable_failed');
  });
});

// A card the issuer has reported as fraud stops the workspace, and no payment
// lifts it. The hold lives in its own column precisely so the money paths
// cannot: /prepaid-topped-up clears `suspended` and raises the balance in one
// statement, so a hold expressed through either would be released by the
// stolen card's own next top-up.
describe('fraud-hold — a reported card stops the workspace until an operator looks', () => {
  const CUSTOMER = 'cus_fraud_00001';
  const EFW_REF = 'issfr_1Test00000000';

  function placeHold(body: Record<string, unknown> = {}) {
    return signedPost(
      buildApp(),
      `/api/internal/billing/controls/${CUSTOMER}/fraud-hold`,
      { ref: EFW_REF, chargeId: 'ch_1', invoiceId: 'in_1', fraudType: 'fraudulent', ...body },
    );
  }

  it('holds the account and republishes every tenant snapshot', async () => {
    const heldAt = new Date('2026-09-23T10:00:00Z');
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [{ fraud_hold_at: heldAt, fraud_hold_ref: EFW_REF }], rowCount: 1 },
    ]);

    const res = await placeHold();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ref: EFW_REF });

    // The hold is written, and nothing else is: the wallet, the plan and
    // agent_execution_allowed are all untouched by a warning.
    const sql = query.mock.calls[1][0] as string;
    expect(sql).toContain('fraud_hold_at  = COALESCE(fraud_hold_at, NOW())');
    expect(sql).not.toMatch(/reload_balance_usd/);
    expect(mockEnableAgentExecution).not.toHaveBeenCalled();

    // Without the republish the runtime keeps its cached snapshot for up to a
    // minute, and every run in flight keeps spending on the reported card.
    expect(mockPublishBillingSuspensionChange).toHaveBeenCalledWith(
      ACCOUNT_ID_A, 'suspended', 'fraud_hold',
    );
  });

  // Stripe redelivers, and two warnings can name the same charge. The first
  // hold's timestamp is the one that matters, so COALESCE keeps it.
  it('keeps the first warning on a redelivery', async () => {
    const firstHeldAt = new Date('2026-09-23T10:00:00Z');
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [{ fraud_hold_at: firstHeldAt, fraud_hold_ref: EFW_REF }], rowCount: 1 },
    ]);

    const res = await placeHold({ ref: 'issfr_2Second00000' });

    expect(res.status).toBe(200);
    expect(res.body.ref).toBe(EFW_REF);
    const sql = query.mock.calls[1][0] as string;
    expect(sql).toContain('fraud_hold_ref = COALESCE(fraud_hold_ref, $2)');
  });

  it('refuses a hold with no warning reference, before touching the database', async () => {
    const query = mockPool([{ rows: [{ account_id: ACCOUNT_ID_A }] }]);

    const res = await placeHold({ ref: undefined });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ref_required');
    // Only the accountId resolver ran.
    expect(query).toHaveBeenCalledTimes(1);
    expect(mockPublishBillingSuspensionChange).not.toHaveBeenCalled();
  });

  it('answers 404 for an account with no billing row', async () => {
    mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [], rowCount: 0 },
    ]);

    const res = await placeHold();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('account_not_found');
    expect(mockPublishBillingSuspensionChange).not.toHaveBeenCalled();
  });

  // The property the separate column exists for.
  it('is not lifted by a top-up: the top-up writes nothing that names the hold', async () => {
    (withAdminScope as jest.Mock).mockImplementation(
      async (_opts: unknown, cb: (client: { query: jest.Mock }) => Promise<unknown>) =>
        cb({ query: jest.fn().mockResolvedValue({ rows: [{ tenant_id: TENANT_ID }] }) }),
    );
    mockEnableAgentExecution.mockResolvedValue(undefined);
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [{ reload_balance_usd: '500.00' }], rowCount: 1 },
    ]);

    const res = await signedPost(
      buildApp(),
      `/api/internal/billing/controls/${CUSTOMER}/prepaid-topped-up`,
      { amountUsd: 500 },
    );

    expect(res.status).toBe(200);
    const topUpSql = query.mock.calls[1][0] as string;
    expect(topUpSql).toContain('suspended = CASE');
    expect(topUpSql).not.toMatch(/fraud_hold/);
  });
});

// A refund or a dispute takes money back that the compute may already have
// spent. The debit can drive the balance negative, and a negative balance
// suspends the workspace — which the runtime only learns from its entitlement
// snapshot, cached for up to a minute.
describe('prepaid-clawback — a suspension it causes reaches the runtime at once', () => {
  const CUSTOMER = 'cus_clawback_00001';

  function clawback(balanceAfter: string, suspended: boolean) {
    mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [{ reload_balance_usd: balanceAfter, suspended }], rowCount: 1 },
    ]);
    return signedPost(
      buildApp(),
      `/api/internal/billing/controls/${CUSTOMER}/prepaid-clawback`,
      { amountUsd: 500, reason: 'dispute' },
    );
  }

  it('republishes when the debit suspends the workspace', async () => {
    const res = await clawback('-400.00', true);

    expect(res.status).toBe(200);
    expect(mockPublishBillingSuspensionChange).toHaveBeenCalledWith(
      ACCOUNT_ID_A, 'suspended', 'prepaid_clawback:dispute',
    );
  });

  // A debit the wallet could absorb changes nothing the runtime needs to hear,
  // and republishing every tenant's snapshot for it is pure noise.
  it('stays quiet when the balance is still positive', async () => {
    const res = await clawback('120.00', false);

    expect(res.status).toBe(200);
    expect(mockPublishBillingSuspensionChange).not.toHaveBeenCalled();
  });
});

describe('payment-method-added — a declined auto-reload can recover', () => {
  const CUSTOMER = 'cus_pma_00001';

  function attachCard(row: Record<string, unknown> | undefined) {
    mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: row ? [row] : [], rowCount: row ? 1 : 0 },
    ]);
    return signedPost(
      buildApp(),
      `/api/internal/billing/controls/${CUSTOMER}/payment-method-added`,
      {},
    );
  }

  // Auto-reload only fires from the spend path, and a suspended workspace
  // consumes nothing, so attaching a card is the only moment it can be retried.
  //
  // The reload invoice is named with a workspace: it is what resolves that
  // invoice, and later any refund, dispute or fraud warning on its charge,
  // back to a tenant. An account funding itself with credit has no
  // subscription to be resolved by instead.
  it('retries the reload for a workspace stuck on auto_reload_failed, naming the workspace', async () => {
    (withAdminScope as jest.Mock).mockImplementation(
      async (_opts: unknown, cb: (client: { query: jest.Mock }) => Promise<unknown>) =>
        cb({ query: jest.fn().mockResolvedValue({ rows: [{ id: TENANT_ID }] }) }),
    );

    const res = await attachCard({
      suspended_reason: 'auto_reload_failed',
      auto_reload_enabled: true,
      auto_reload_amount_usd: '100.00',
      stripe_customer_id: CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(mockTriggerAutoReload).toHaveBeenCalledWith(CUSTOMER, 100, TENANT_ID);
  });

  // An account with no workspace to name still gets its credit: an
  // unattributed invoice is what every reload invoice was before, and
  // refusing to fund the wallet over it would be the worse failure.
  it('still retries when no workspace can be named', async () => {
    (withAdminScope as jest.Mock).mockImplementation(
      async (_opts: unknown, cb: (client: { query: jest.Mock }) => Promise<unknown>) =>
        cb({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
    );

    const res = await attachCard({
      suspended_reason: 'auto_reload_failed',
      auto_reload_enabled: true,
      auto_reload_amount_usd: '100.00',
      stripe_customer_id: CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(mockTriggerAutoReload).toHaveBeenCalledWith(CUSTOMER, 100, null);
  });

  it('charges nobody when the workspace ran out of credit normally', async () => {
    const res = await attachCard({
      suspended_reason: 'zero_prepaid_balance',
      auto_reload_enabled: true,
      auto_reload_amount_usd: '100.00',
      stripe_customer_id: CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(mockTriggerAutoReload).not.toHaveBeenCalled();
  });

  it('charges nobody on an ordinary card attach', async () => {
    const res = await attachCard({
      suspended_reason: null,
      auto_reload_enabled: true,
      auto_reload_amount_usd: '100.00',
      stripe_customer_id: CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(mockTriggerAutoReload).not.toHaveBeenCalled();
  });

  it('does not retry when auto-reload was switched off', async () => {
    const res = await attachCard({
      suspended_reason: 'auto_reload_failed',
      auto_reload_enabled: false,
      auto_reload_amount_usd: '100.00',
      stripe_customer_id: CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(mockTriggerAutoReload).not.toHaveBeenCalled();
  });

  // The retry is best-effort: the workspace keeps the reason, so the next card
  // attach tries again and a manual top-up still clears it.
  it('still answers 200 when the retry itself fails', async () => {
    mockTriggerAutoReload.mockRejectedValueOnce(new Error('stripe declined again'));

    const res = await attachCard({
      suspended_reason: 'auto_reload_failed',
      auto_reload_enabled: true,
      auto_reload_amount_usd: '100.00',
      stripe_customer_id: CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing.controls.auto_reload_retry_failed' }),
      expect.any(String),
    );
  });
});

// The settings page, liftoff-billing and this route share one set of minimums:
// a $1 threshold and a $5 reload. Migration 542 holds the threshold's.
describe('auto-reload-settings — the minimums', () => {
  const PATH = `/api/internal/billing/controls/by-tenant/${TENANT_ID}/auto-reload-settings`;
  function signedPut(body: object) {
    const { timestamp, signature } = sign('PUT', PATH, body);
    return request(buildApp())
      .put(PATH)
      .set('X-Billing-Timestamp', timestamp)
      .set('X-Billing-Signature', signature)
      .send(body);
  }

  it('accepts a $1 threshold and a $5 reload', async () => {
    const query = mockPool([
      { rows: [{ account_id: ACCOUNT_ID_A }] },
      { rows: [{ billing_mode: 'pre_pay' }] },
      { rows: [], rowCount: 1 },
    ]);
    const res = await signedPut({ enabled: true, thresholdUsd: 1, amountUsd: 5 });
    expect(res.status).toBe(200);
    expect(query.mock.calls[2][1]).toEqual([ACCOUNT_ID_A, 1, 5]);
  });

  it('refuses a threshold under $1 and a reload under $5, saying which', async () => {
    mockPool([]);
    const low = await signedPut({ enabled: true, thresholdUsd: 0.5, amountUsd: 5 });
    expect(low.status).toBe(400);
    expect(low.body).toEqual({ error: 'thresholdUsd_must_be_at_least_1' });

    const small = await signedPut({ enabled: true, thresholdUsd: 1, amountUsd: 4.99 });
    expect(small.status).toBe(400);
    expect(small.body).toEqual({ error: 'amountUsd_must_be_at_least_5' });
  });
});
