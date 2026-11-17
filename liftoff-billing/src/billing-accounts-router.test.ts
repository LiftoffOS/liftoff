// billing-accounts-router — unit tests for the no-stripe-customer 200 paths
// and the happy-path 200 responses when a real stripe customer is provisioned.
//
// Subscribe/change-plan/replace-subscription tests require STRIPE_PLAN_*_PRICE_ID
// env vars (used by getPersistentProductId) — set in beforeAll below.
//
// Verifies that /overview, /invoices, and /current-usage return 200 with safe
// defaults when resolveStripeCustomer returns null (tenant exists but billing
// hasn't been provisioned yet). Previously these returned 404, which produced
// console errors on the dashboard for new signups during the brief window
// between tenant creation and the synchronous provisionSubscription completing.
//
// Also covers the populated-controls happy path (executionBlocked reflects
// `controls.suspended`) and an /invoices happy path with real invoice data.
//
// /upcoming-invoice also returns 200 with `null` body for unprovisioned
// tenants, per plan §3.2. /payment-methods already returned 200 with empty
// array; untouched.

import { beforeAll, describe, it, expect, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type Stripe from 'stripe';

// PR 2: provisionForTenant now wraps work in withBillingTenant, which calls
// the module-scoped getPool() to acquire a real pg pool. In unit tests we
// don't have a real DB; redirect both to a per-test mock pool that the suite
// installs via setBillingTestPool() before each request. withBillingTenant is
// stubbed to just call the callback with a connected client (no RLS
// SET set_config — RLS isn't exercised by these unit tests; integration tests
// cover that path).
let __testPool: Pool | null = null;
function setBillingTestPool(p: Pool): void { __testPool = p; }
jest.mock('./infrastructure/database.js', () => ({
  getPool: () => {
    if (!__testPool) throw new Error('billing-accounts-router test pool not set');
    return __testPool;
  },
  withBillingTenant: async (_tenantId: string, fn: (client: PoolClient) => Promise<unknown>) => {
    if (!__testPool) throw new Error('billing-accounts-router test pool not set');
    const client = await __testPool.connect();
    try { return await fn(client); } finally { client.release(); }
  },
  closePool: async () => undefined,
}));

import { registerBillingAccountsRouter } from './billing-accounts-router';
import { PlatformBackendError, type PlatformBackendClient } from './infrastructure/platform-backend-client.js';

// `@jest/globals`' jest.fn() is strictly typed; for these unit tests we just
// want a loose mock that returns whatever we ask it to. `mockFn` is the
// type-erased escape hatch used throughout this file.
/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

type SubscriptionRow = {
  stripe_subscription_id: string;
  status: string;
  plan_id: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
};

// Synthesize a pg.Pool that returns predictable rowsets for the `subscriptions`
// SELECTs used by resolveStripeCustomer and /overview.
function mockPool(opts: {
  stripeCustomerId: string | null;
  subscription?: SubscriptionRow | null;
  // Rows returned for the `SELECT ... FROM invoices` read in GET /invoices.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoiceRows?: any[];
  // When set, the SELECT stripe_subscription_id ... Layer 1 dedup query returns
  // empty on the first call and a row on every subsequent call. Used by the
  // double-click idempotency test to simulate two concurrent /subscribe POSTs
  // racing through Layer 1.
  layer1FlipsAfterFirstCall?: boolean;
}): Pool {
  let layer1Calls = 0;
  const queryFn = mockFn().mockImplementation((sql: string) => {
    if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (sql.includes('SELECT set_config')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    // GET /invoices reads the local invoices table.
    if (sql.includes('FROM invoices')) {
      const rows = opts.invoiceRows ?? [];
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    // subscription-replace.ts polls `SELECT id FROM subscriptions WHERE
    // tenant_id = ... AND status NOT IN ('canceled','incomplete_expired')`
    // every 500ms for up to 30s. Returning empty rows lets the poll exit
    // immediately (representing the "cancel webhook landed" case) so replace
    // tests don't hang for the full window.
    if (sql.includes('FROM subscriptions') && /SELECT\s+id\s+FROM\s+subscriptions/i.test(sql)) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (sql.includes('FROM subscriptions')) {
      // The /overview handler issues two distinct SELECTs against subscriptions.
      // resolveStripeCustomer selects only stripe_customer_id; the second query
      // selects the full subscription row.  Differentiate by the projection.
      if (sql.includes('stripe_subscription_id')) {
        if (opts.layer1FlipsAfterFirstCall) {
          const callIdx = layer1Calls++;
          if (callIdx === 0) return Promise.resolve({ rows: [], rowCount: 0 });
          return Promise.resolve({
            rows: [{ stripe_subscription_id: 'sub_first_caller' }],
            rowCount: 1,
          });
        }
        const sub = opts.subscription;
        return Promise.resolve(
          sub ? { rows: [sub], rowCount: 1 } : { rows: [], rowCount: 0 },
        );
      }
      return Promise.resolve(
        opts.stripeCustomerId
          ? { rows: [{ stripe_customer_id: opts.stripeCustomerId }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      );
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  return {
    connect: mockFn().mockResolvedValue({
      query: queryFn,
      release: mockFn(),
    }),
    query: queryFn,
  } as unknown as Pool;
}

type StripeOverrides = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoicesList?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retrieveUpcoming?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listPaymentMethods?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customersRetrieve?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paymentMethodsRetrieve?: any;
};

function mockStripe(overrides: StripeOverrides = {}): Stripe {
  return {
    invoices: {
      list: overrides.invoicesList ?? mockFn().mockResolvedValue({ data: [], has_more: false }),
      retrieveUpcoming: overrides.retrieveUpcoming ?? mockFn(),
    },
    customers: {
      listPaymentMethods: overrides.listPaymentMethods ?? mockFn().mockResolvedValue({ data: [] }),
      // Default customer has no email_sha256 metadata → eligibility helper's
      // email-deletion signal short-circuits as a non-match.
      retrieve: overrides.customersRetrieve ?? mockFn().mockResolvedValue({ deleted: false, invoice_settings: {}, metadata: {} }),
    },
    paymentMethods: {
      // Default PM has a clean fingerprint → eligibility fingerprint signal
      // short-circuits as a non-match (the pool mock returns rowCount: 0).
      retrieve: overrides.paymentMethodsRetrieve ?? mockFn().mockResolvedValue({ id: 'pm_test', card: { fingerprint: 'fp_clean' } }),
    },
  } as unknown as Stripe;
}

type ControlsStatus = NonNullable<Awaited<ReturnType<PlatformBackendClient['getControlsStatus']>>>;

function mockPbClient(controls: ControlsStatus | null = null): PlatformBackendClient {
  return {
    getControlsStatus: mockFn().mockResolvedValue(controls),
    // Phase 7 eligibility helper consults PB for the email-hash deletion ledger.
    // Default to non-match so existing /subscribe tests don't hit eligibility denial.
    checkDeletionHistory: mockFn().mockResolvedValue({ matched: false }),
  } as unknown as PlatformBackendClient;
}

function buildControls(overrides: Partial<ControlsStatus> = {}): ControlsStatus {
  return {
    accountId: 'acct_test',
    currentPeriodSpendUsd: 12.5,
    nextThresholdUsd: 50,
    outstandingBalanceUsd: 3.25,
    suspended: false,
    billingTier: 'standard',
    graduated: false,
    billingPeriodStart: '2026-05-01T00:00:00.000Z',
    spendUpdatedAt: '2026-05-12T00:00:00.000Z',
    thresholdChargesCollectedUsd: 0,
    hasPaymentMethod: true,
    billingMode: 'post_pay',
    planType: 'core',
    // OU-native fixture (replaces monthlyAllocationUsd / prepaidBalanceUsd
    // which are gone after Migration B). 800 OUs is the Core base allotment.
    planIncludedOus: 800,
    precommitExtraOus: 0,
    ousConsumedThisPeriod: 540,
    includedRateUsdPerOu: 0.025,
    precommitRateUsdPerOu: 0.028,
    reloadRateUsdPerOu: 0.03125,
    reloadBalanceUsd: 2,
    autoReloadEnabled: false,
    autoReloadThresholdUsd: null,
    autoReloadAmountUsd: null,
    suspendedReason: null,
    ...overrides,
  };
}

async function buildApp(args: {
  stripeCustomerId: string | null;
  subscription?: SubscriptionRow | null;
  pbClient?: PlatformBackendClient;
  stripe?: Stripe;
  layer1FlipsAfterFirstCall?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoiceRows?: any[];
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const pool = mockPool({
    stripeCustomerId: args.stripeCustomerId,
    subscription: args.subscription ?? null,
    layer1FlipsAfterFirstCall: args.layer1FlipsAfterFirstCall,
    invoiceRows: args.invoiceRows,
  });
  // Make the same pool the source for both deps.pool (used by direct queries
  // in the router) and the module-scoped getPool() used by provisionForTenant.
  setBillingTestPool(pool);
  registerBillingAccountsRouter(app, {
    pool,
    stripe: args.stripe ?? mockStripe(),
    pbClient: args.pbClient ?? mockPbClient(),
    billingServiceToken: 'test-token',
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await app.ready();
  return app;
}

const VALID_TENANT = '11111111-1111-1111-1111-111111111111';
const STRIPE_CUSTOMER = 'cus_test_123';
const AUTH_HEADERS = { 'x-service-auth': 'test-token' };

// Persistent-product test fixtures. Each plan/period maps to a stable price ID
// (set on env vars before any test runs) which in turn maps to a product ID
// returned by the mocked stripe.prices.retrieve.
const TEST_PRICE_IDS: Record<string, string> = {
  STRIPE_PLAN_CORE_MONTHLY_PRICE_ID:   'price_core_monthly_test',
  STRIPE_PLAN_CORE_ANNUAL_PRICE_ID:    'price_core_annual_test',
  STRIPE_PLAN_GROWTH_MONTHLY_PRICE_ID: 'price_growth_monthly_test',
  STRIPE_PLAN_GROWTH_ANNUAL_PRICE_ID:  'price_growth_annual_test',
  STRIPE_PLAN_SCALE_MONTHLY_PRICE_ID:  'price_scale_monthly_test',
  STRIPE_PLAN_SCALE_ANNUAL_PRICE_ID:   'price_scale_annual_test',
};
const TEST_PRODUCT_IDS: Record<string, string> = {
  price_core_monthly_test:   'prod_core_monthly_test',
  price_core_annual_test:    'prod_core_annual_test',
  price_growth_monthly_test: 'prod_growth_monthly_test',
  price_growth_annual_test:  'prod_growth_annual_test',
  price_scale_monthly_test:  'prod_scale_monthly_test',
  price_scale_annual_test:   'prod_scale_annual_test',
};

beforeAll(() => {
  for (const [envVar, priceId] of Object.entries(TEST_PRICE_IDS)) {
    process.env[envVar] = priceId;
  }
});

describe('GET /api/billing/accounts/:tenantId/overview', () => {
  it('returns 200 with safe defaults when tenant has no stripe_customer_id', async () => {
    const app = await buildApp({ stripeCustomerId: null });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/overview`,
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Decision B (locked-in plan §1444): no `provisioningState` discriminator
      // on the wire. Unprovisioned tenants are signaled by subscription=null +
      // executionBlocked=false; the dashboard renders normally.
      expect(body.provisioningState).toBeUndefined();
      expect(body.subscription).toBeNull();
      expect(body.executionBlocked).toBe(false);
      expect(body.hasPaymentMethod).toBe(false);
      expect(body.currentPeriodSpendUsd).toBe(0);
      expect(body.outstandingBalanceUsd).toBe(0);
      expect(body.billingTier).toBe('standard');
      expect(body.billingMode).toBe('post_pay');
      expect(body.planType).toBeNull();
      // OU-native fields replace allocationBalanceUsd (which depended on
      // dropped prepaid_balance_usd). Unprovisioned tenant has no allotment.
      expect(body.planIncludedOus).toBe(0);
      expect(body.precommitExtraOus).toBe(0);
      expect(body.ousConsumedThisPeriod).toBe(0);
      expect(body.reloadBalanceUsd).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns 200 with subscription + controls populated and executionBlocked=false when not suspended', async () => {
    const subscription: SubscriptionRow = {
      stripe_subscription_id: 'sub_abc',
      status: 'active',
      plan_id: 'price_core_monthly',
      current_period_end: '2026-06-01T00:00:00.000Z',
      cancel_at_period_end: false,
    };
    const controls = buildControls({ suspended: false });
    const pbClient = mockPbClient(controls);
    const stripe = mockStripe({
      listPaymentMethods: mockFn().mockResolvedValue({ data: [{ id: 'pm_1' }] }),
    });
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      subscription,
      pbClient,
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/overview`,
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.provisioningState).toBeUndefined();
      expect(body.subscription).toEqual({
        stripeSubscriptionId: 'sub_abc',
        status: 'active',
        planId: 'price_core_monthly',
        currentPeriodEnd: '2026-06-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
      });
      expect(body.executionBlocked).toBe(false);
      expect(body.hasPaymentMethod).toBe(true);
      expect(body.currentPeriodSpendUsd).toBe(controls.currentPeriodSpendUsd);
      expect(body.outstandingBalanceUsd).toBe(controls.outstandingBalanceUsd);
      expect(body.billingTier).toBe(controls.billingTier);
      expect(body.billingMode).toBe(controls.billingMode);
      expect(body.planType).toBe(controls.planType);
      // OU-native fields surfaced from billing_controls (replaces the dropped
      // allocationBalanceUsd computation that depended on prepaid_balance_usd).
      expect(body.planIncludedOus).toBe(controls.planIncludedOus);
      expect(body.precommitExtraOus).toBe(controls.precommitExtraOus);
      expect(body.ousConsumedThisPeriod).toBe(controls.ousConsumedThisPeriod);
      expect(body.reloadBalanceUsd).toBe(controls.reloadBalanceUsd);
      expect(body.suspendedReason).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns 200 with executionBlocked=true when controls.suspended is true', async () => {
    const subscription: SubscriptionRow = {
      stripe_subscription_id: 'sub_susp',
      status: 'past_due',
      plan_id: 'price_core_monthly',
      current_period_end: '2026-06-01T00:00:00.000Z',
      cancel_at_period_end: false,
    };
    const controls = buildControls({
      suspended: true,
      suspendedReason: 'outstanding_balance',
      outstandingBalanceUsd: 25.5,
    });
    const pbClient = mockPbClient(controls);
    const stripe = mockStripe({
      listPaymentMethods: mockFn().mockResolvedValue({ data: [{ id: 'pm_1' }] }),
    });
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      subscription,
      pbClient,
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/overview`,
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.provisioningState).toBeUndefined();
      expect(body.executionBlocked).toBe(true);
      expect(body.suspendedReason).toBe('outstanding_balance');
      expect(body.outstandingBalanceUsd).toBe(25.5);
      expect(body.subscription?.status).toBe('past_due');
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/billing/accounts/:tenantId/invoices', () => {
  it('returns 200 with empty list when tenant has no stripe_customer_id', async () => {
    const app = await buildApp({ stripeCustomerId: null });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/invoices`,
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      // PR 4: /invoices reads from the local invoices table (not Stripe).
      // Empty tenant returns empty list with cursor pagination metadata.
      expect(res.json()).toEqual({ invoices: [], hasMore: false, nextCursor: null });
    } finally {
      await app.close();
    }
  });

  // A $0/$0/$0 invoice (enterprise/comped plan, or a 100%-off promo) is a real
  // billing record the customer needs — it must NOT be filtered out. Guards
  // against re-introducing an `amount > 0` WHERE clause.
  it('returns $0 invoices (does not filter by amount)', async () => {
    const zeroInvoice = {
      id: 'inv_zero_1',
      stripe_invoice_id: 'in_zero_1',
      status: 'paid',
      amount_due_cents: '0',
      amount_paid_cents: '0',
      subtotal_cents: '0',
      discount_cents: '0',
      currency: 'usd',
      period_end: new Date('2026-06-12T00:00:00Z'),
      issued_at: new Date('2026-06-12T00:00:00Z'),
      paid_at: new Date('2026-06-12T00:00:00Z'),
      type: 'subscription_cycle',
      hosted_invoice_url: 'https://invoice.stripe.com/i/zero',
      invoice_pdf: 'https://invoice.stripe.com/i/zero/pdf',
    };
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, invoiceRows: [zeroInvoice] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/invoices`,
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.invoices).toHaveLength(1);
      expect(body.invoices[0]).toMatchObject({
        number: 'in_zero_1',
        amountDue: 0,
        subtotal: 0,
        discount: 0,
        type: 'subscription_cycle',
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/zero',
      });
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/billing/accounts/:tenantId/current-usage', () => {
  it('returns 200 with safe defaults when tenant has no stripe_customer_id', async () => {
    const app = await buildApp({ stripeCustomerId: null });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/current-usage`,
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.currentPeriodSpendUsd).toBe(0);
      expect(body.outstandingBalanceUsd).toBe(0);
      expect(body.executionBlocked).toBe(false);
      expect(body.hasPaymentMethod).toBe(false);
      expect(body.billingTier).toBe('standard');
      expect(body.billingMode).toBe('post_pay');
      expect(body.planType).toBeNull();
      // OU-native fields (replaces the dropped totalOus/pricePerOu pair).
      // Unprovisioned tenant has zero allotment and zero consumption.
      expect(body.planIncludedOus).toBe(0);
      expect(body.precommitExtraOus).toBe(0);
      expect(body.ousConsumedThisPeriod).toBe(0);
      expect(body.includedRateUsdPerOu).toBe(0);
      expect(body.precommitRateUsdPerOu).toBe(0);
      expect(body.reloadRateUsdPerOu).toBe(0);
      expect(body.billingPeriodStart).toBeNull();
      expect(body.suspendedReason).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('rejects requests without X-Service-Auth (401)', async () => {
    const app = await buildApp({ stripeCustomerId: null });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/current-usage`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/billing/accounts/:tenantId/upcoming-invoice (no stripe customer)', () => {
  it('returns 200 with null body when tenant has no stripe_customer_id (plan §3.2)', async () => {
    const app = await buildApp({ stripeCustomerId: null });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/upcoming-invoice`,
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('auth defense-in-depth', () => {
  it('rejects requests without X-Service-Auth on /overview', async () => {
    const app = await buildApp({ stripeCustomerId: null });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/overview`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects requests with wrong X-Service-Auth on /overview', async () => {
    const app = await buildApp({ stripeCustomerId: null });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/overview`,
        headers: { 'x-service-auth': 'wrong-token' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects requests without X-Service-Auth on /invoices', async () => {
    const app = await buildApp({ stripeCustomerId: null });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/invoices`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects requests without X-Service-Auth on /upcoming-invoice', async () => {
    const app = await buildApp({ stripeCustomerId: null });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/accounts/${VALID_TENANT}/upcoming-invoice`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// Stripe mock for subscribe/change-plan flows. Returns trackable jest mocks
// for prices.create and subscriptions.create/update so individual tests can
// assert the exact unit_amount and recurring.interval sent to Stripe.
function mockStripeForSubscribe(opts: {
  existingSub?: Stripe.Subscription;
  promotionCode?: Stripe.PromotionCode | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscriptionsCreateImpl?: any;
} = {}) {
  const pricesCreate = mockFn().mockImplementation((args: Stripe.PriceCreateParams) =>
    Promise.resolve({ id: `price_test_${Math.random().toString(36).slice(2, 8)}`, ...args }),
  );
  const pricesRetrieve = mockFn().mockImplementation((priceId: string) => {
    const productId = TEST_PRODUCT_IDS[priceId];
    if (!productId) return Promise.reject(new Error(`unmocked price: ${priceId}`));
    return Promise.resolve({ id: priceId, product: productId });
  });
  const subscriptionsCreate = opts.subscriptionsCreateImpl ?? mockFn().mockResolvedValue({
    id: 'sub_test_created',
    customer: STRIPE_CUSTOMER,
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [] },
  });
  const subscriptionsUpdate = mockFn().mockResolvedValue({
    id: 'sub_test_updated',
    customer: STRIPE_CUSTOMER,
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [] },
  });
  const subscriptionsRetrieve = mockFn().mockResolvedValue(opts.existingSub ?? {
    id: 'sub_test_existing',
    customer: STRIPE_CUSTOMER,
    status: 'active',
    items: { data: [{ id: 'si_old', price: { id: 'price_old', product: 'prod_old' } }] },
  });
  const subscriptionsCancel = mockFn().mockResolvedValue({ id: 'sub_test_cancelled' });
  // Layer 2 of provisionForTenant lists active Stripe subs to detect webhook-lag
  // backfills. With no pre-existing sub on the test tenant, return empty.
  const subscriptionsList = mockFn().mockResolvedValue({ data: [], has_more: false });
  const promotionCodesList = mockFn().mockImplementation(() => Promise.resolve({
    data: opts.promotionCode ? [opts.promotionCode] : [],
    has_more: false,
  }));
  const customersUpdate = mockFn().mockResolvedValue({ id: STRIPE_CUSTOMER });
  const stripe = {
    customers: {
      listPaymentMethods: mockFn().mockResolvedValue({ data: [{ id: 'pm_1' }] }),
      // Phase 7 eligibility helper consults customer metadata; default to
      // empty so the email_sha256 signal short-circuits as a non-match.
      retrieve: mockFn().mockResolvedValue({ id: STRIPE_CUSTOMER, metadata: {} }),
      // The "Monthly Operating Units" custom field is now set on the customer
      // (not the subscription) — Stripe rejects invoice_settings.custom_fields
      // on subscription create/update across all current API versions.
      update: customersUpdate,
    },
    paymentMethods: {
      // Phase 7 eligibility helper retrieves the PM for its fingerprint.
      // Clean fingerprint + pool mock returning rowCount: 0 → non-match.
      retrieve: mockFn().mockResolvedValue({ id: 'pm_1', card: { fingerprint: 'fp_clean' } }),
    },
    prices: { create: pricesCreate, retrieve: pricesRetrieve },
    subscriptions: {
      create: subscriptionsCreate,
      update: subscriptionsUpdate,
      retrieve: subscriptionsRetrieve,
      cancel: subscriptionsCancel,
      list: subscriptionsList,
    },
    promotionCodes: { list: promotionCodesList },
  } as unknown as Stripe;
  return { stripe, pricesCreate, pricesRetrieve, subscriptionsCreate, subscriptionsUpdate, customersUpdate, promotionCodesList };
}

// Build a fake Stripe PromotionCode for the test harness.
function fakePromoCode(opts: {
  id?: string;
  code?: string;
  duration?: Stripe.Coupon.Duration;
  amountOff?: number | null;
  appliesToProducts?: string[] | null;
}): Stripe.PromotionCode {
  return {
    id: opts.id ?? 'promo_test_123',
    code: opts.code ?? 'LIFTOFF-TEST',
    active: true,
    coupon: {
      id: 'coupon_test',
      duration: opts.duration ?? 'once',
      amount_off: opts.amountOff ?? 2000,
      ...(opts.appliesToProducts ? { applies_to: { products: opts.appliesToProducts } } : {}),
    },
  } as unknown as Stripe.PromotionCode;
}

function mockPbClientWithActivation(): PlatformBackendClient {
  return {
    getControlsStatus: mockFn().mockResolvedValue(null),
    subscriptionActivated: mockFn().mockResolvedValue(undefined),
    subscriptionEnding: mockFn().mockResolvedValue(undefined),
  } as unknown as PlatformBackendClient;
}

// Variant that exposes the subscriptionActivated mock so a test can inspect
// the args passed to the activation callback (e.g. asserting promoApplied).
function mockPbClientWithActivationCapture(): {
  pbClient: PlatformBackendClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscriptionActivated: any;
} {
  const subscriptionActivated = mockFn().mockResolvedValue(undefined);
  const pbClient = {
    getControlsStatus: mockFn().mockResolvedValue(null),
    subscriptionActivated,
  } as unknown as PlatformBackendClient;
  return { pbClient, subscriptionActivated };
}

describe('POST /api/billing/accounts/:tenantId/subscribe', () => {
  // Regression coverage for yearly pricing: /subscribe must not charge yearly
  // subscriptions the monthly amount once per year (e.g. $20/yr for Core
  // instead of $200/yr). The frontend display, the /checkout-session endpoint,
  // and the /pricing UI all use a ×10 multiplier for yearly; /subscribe and
  // /change-plan must apply it too.

  it('charges Core monthly at base price ($20.00)', async () => {
    const { stripe, pricesCreate, subscriptionsCreate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      expect(pricesCreate).toHaveBeenCalledTimes(1);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.unit_amount).toBe(2000);
      expect(priceArgs.recurring.interval).toBe('month');
      expect(subscriptionsCreate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('charges Core yearly at base × 10 ($200.00) — regression for yearly pricing bug', async () => {
    const { stripe, pricesCreate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'yearly' },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.unit_amount).toBe(20000); // $200 — bug would have been 2000
      expect(priceArgs.recurring.interval).toBe('year');
    } finally {
      await app.close();
    }
  });

  it('charges Core yearly with committed OUs at (base + extras) × 10', async () => {
    const { stripe, pricesCreate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      // Core base = 1,400 OUs at $20. committedOus=2400 (the slider's second stop)
      // → extraOus=1000 → extra cost = 1000 × 1.5 = 1500 cents. monthlyTotal =
      // 2000 + 1500 = 3500. Yearly = ×10 = 35000.
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'yearly', committedOus: 2400 },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.unit_amount).toBe(35000); // $350
      expect(priceArgs.recurring.interval).toBe('year');
    } finally {
      await app.close();
    }
  });

  it('does not apply multiplier on monthly with committed OUs', async () => {
    const { stripe, pricesCreate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      // Growth base = 3,650 OUs at $50. committedOus=4650 (the slider's second stop)
      // → extraOus=1000 → extra cost = 1000 × 1.5 = 1500 cents. monthlyTotal =
      // 5000 + 1500 = 6500. Monthly = no multiplier = 6500.
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'growth', billingPeriod: 'monthly', committedOus: 4650 },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.unit_amount).toBe(6500); // $65
      expect(priceArgs.recurring.interval).toBe('month');
    } finally {
      await app.close();
    }
  });

  it('charges Scale yearly at base × 10 ($2,000)', async () => {
    const { stripe, pricesCreate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'scale', billingPeriod: 'yearly' },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.unit_amount).toBe(200000); // $2,000 — bug would have been 20000
    } finally {
      await app.close();
    }
  });

  // ── persistent-product / promo / custom_fields coverage ──────────────────
  // Plan §"Backend tests": each numbered comment matches the plan's test list.

  it('(1) attaches ad-hoc price to the persistent product (not product_data)', async () => {
    const { stripe, pricesCreate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.product).toBe(TEST_PRODUCT_IDS[TEST_PRICE_IDS.STRIPE_PLAN_CORE_MONTHLY_PRICE_ID]);
      expect(priceArgs.product_data).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('(2) applies valid promo on Core monthly', async () => {
    const promo = fakePromoCode({
      id: 'promo_abc', code: 'LIFTOFF-ALICE',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const { stripe, subscriptionsCreate, promotionCodesList } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'LIFTOFF-ALICE' },
      });
      expect(res.statusCode).toBe(200);
      expect(subscriptionsCreate).toHaveBeenCalledTimes(1);
      const subArgs = subscriptionsCreate.mock.calls[0][0];
      expect(subArgs.discounts).toEqual([{ promotion_code: 'promo_abc' }]);
      // Pin the expand path. Stripe omits `coupon.applies_to` from the default
      // Coupon shape — `expand: ['data.coupon']` alone yields
      // `applies_to: undefined` at runtime, silently skipping the
      // promo_code_not_applicable pre-check. The fully-qualified
      // `data.coupon.applies_to` is required.
      const listArgs = promotionCodesList.mock.calls[0][0];
      expect(listArgs.expand).toEqual(['data.coupon.applies_to']);
    } finally {
      await app.close();
    }
  });

  it('(3) applies valid promo on Core yearly', async () => {
    const promo = fakePromoCode({
      id: 'promo_xyz', code: 'LIFTOFF-BOB',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_annual_test],
    });
    const { stripe, subscriptionsCreate } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'yearly', promoCode: 'LIFTOFF-BOB' },
      });
      expect(res.statusCode).toBe(200);
      const subArgs = subscriptionsCreate.mock.calls[0][0];
      expect(subArgs.discounts).toEqual([{ promotion_code: 'promo_xyz' }]);
    } finally {
      await app.close();
    }
  });

  it('(4) rejects promo when applies_to.products does not include line item product', async () => {
    const promo = fakePromoCode({
      id: 'promo_core_only', code: 'LIFTOFF-CORE',
      appliesToProducts: [
        TEST_PRODUCT_IDS.price_core_monthly_test,
        TEST_PRODUCT_IDS.price_core_annual_test,
      ],
    });
    const { stripe, subscriptionsCreate } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'growth', billingPeriod: 'monthly', promoCode: 'LIFTOFF-CORE' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('promo_code_not_applicable');
      expect(subscriptionsCreate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('(5) accepts unscoped coupon (no applies_to.products) on any plan', async () => {
    const promo = fakePromoCode({ id: 'promo_open', code: 'OPEN', appliesToProducts: null });
    const { stripe, subscriptionsCreate } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'growth', billingPeriod: 'monthly', promoCode: 'OPEN' },
      });
      expect(res.statusCode).toBe(200);
      const subArgs = subscriptionsCreate.mock.calls[0][0];
      expect(subArgs.discounts).toEqual([{ promotion_code: 'promo_open' }]);
    } finally {
      await app.close();
    }
  });

  it('(6) rejects unknown promo code', async () => {
    const { stripe, subscriptionsCreate } = mockStripeForSubscribe({ promotionCode: null });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'NOPE' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_promo_code');
      expect(subscriptionsCreate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("(7) rejects coupon with duration: 'forever'", async () => {
    const promo = fakePromoCode({ id: 'promo_forever', code: 'FOREVER', duration: 'forever' });
    const { stripe, subscriptionsCreate } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'FOREVER' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_promo_code');
      expect(subscriptionsCreate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("(8) rejects coupon with duration: 'repeating'", async () => {
    const promo = fakePromoCode({ id: 'promo_repeat', code: 'REPEAT', duration: 'repeating' });
    const { stripe, subscriptionsCreate } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'REPEAT' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_promo_code');
      expect(subscriptionsCreate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('(9) sets invoice custom_fields with OU allocation on the CUSTOMER (Stripe rejects it on the subscription)', async () => {
    const { stripe, subscriptionsCreate, customersUpdate } = mockStripeForSubscribe();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', committedOus: 1500 },
      });
      expect(res.statusCode).toBe(200);
      // custom_fields lives on the customer — Stripe doesn't accept it on
      // subscription create/update (parameter_unknown across all API versions
      // as of 2025-05). All invoices billed to this customer inherit the
      // field.
      expect(customersUpdate).toHaveBeenCalledWith(STRIPE_CUSTOMER, {
        invoice_settings: {
          custom_fields: [{ name: 'Monthly Operating Units', value: '1,500 OUs/month' }],
        },
      });
      // Subscription create must NOT carry the field (regression: doing so
      // surfaced as a 400 invalid_promo_code via the over-broad catch).
      const subArgs = subscriptionsCreate.mock.calls[0][0];
      expect(subArgs.invoice_settings).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('(10) sets extraMetadata.promo_code / promotion_code_id when promo applied; absent without promo', async () => {
    const promo = fakePromoCode({
      id: 'promo_meta', code: 'LIFTOFF-METADATA',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const harness = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe: harness.stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'LIFTOFF-METADATA' },
      });
      expect(res.statusCode).toBe(200);
      const subArgs = harness.subscriptionsCreate.mock.calls[0][0];
      expect(subArgs.metadata.promo_code).toBe('LIFTOFF-METADATA');
      expect(subArgs.metadata.promotion_code_id).toBe('promo_meta');
    } finally {
      await app.close();
    }

    // Without a promo, the two metadata fields are absent.
    const harness2 = mockStripeForSubscribe();
    const app2 = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe: harness2.stripe });
    try {
      const res = await app2.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      const subArgs = harness2.subscriptionsCreate.mock.calls[0][0];
      expect(subArgs.metadata.promo_code).toBeUndefined();
      expect(subArgs.metadata.promotion_code_id).toBeUndefined();
    } finally {
      await app2.close();
    }
  });

  it("(11) sets paymentBehavior 'error_if_incomplete' when promo applied; defaults otherwise", async () => {
    const promo = fakePromoCode({
      id: 'promo_pb', code: 'LIFTOFF-PB',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const harness = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe: harness.stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'LIFTOFF-PB' },
      });
      expect(res.statusCode).toBe(200);
      const subArgs = harness.subscriptionsCreate.mock.calls[0][0];
      expect(subArgs.payment_behavior).toBe('error_if_incomplete');
    } finally {
      await app.close();
    }

    const harness2 = mockStripeForSubscribe();
    const app2 = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe: harness2.stripe });
    try {
      const res = await app2.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      const subArgs = harness2.subscriptionsCreate.mock.calls[0][0];
      expect(subArgs.payment_behavior).toBe('allow_incomplete');
    } finally {
      await app2.close();
    }
  });

  it('(12) calls subscriptionActivated with promoApplied (Core monthly base → $0 first invoice)', async () => {
    const promo = fakePromoCode({
      id: 'promo_pa1', code: 'LIFTOFF-FREEM',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo });
    const { pbClient, subscriptionActivated } = mockPbClientWithActivationCapture();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'LIFTOFF-FREEM' },
      });
      expect(res.statusCode).toBe(200);
      const opts = subscriptionActivated.mock.calls[0][1];
      expect(opts.promoApplied).toEqual({ amountOffUsd: 20.00, firstInvoiceTotalUsd: 0 });
    } finally {
      await app.close();
    }
  });

  it('(12b) calls subscriptionActivated with promoApplied (Core annual base → $180 first invoice)', async () => {
    const promo = fakePromoCode({
      id: 'promo_pa2', code: 'LIFTOFF-ANN',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_annual_test],
    });
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo });
    const { pbClient, subscriptionActivated } = mockPbClientWithActivationCapture();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'yearly', promoCode: 'LIFTOFF-ANN' },
      });
      expect(res.statusCode).toBe(200);
      const opts = subscriptionActivated.mock.calls[0][1];
      expect(opts.promoApplied).toEqual({ amountOffUsd: 20.00, firstInvoiceTotalUsd: 180.00 });
    } finally {
      await app.close();
    }
  });

  it('(12c) calls subscriptionActivated with promoApplied (Core monthly committed → $15)', async () => {
    const promo = fakePromoCode({
      id: 'promo_pa3', code: 'LIFTOFF-PART',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo });
    const { pbClient, subscriptionActivated } = mockPbClientWithActivationCapture();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient, stripe });
    try {
      // committedOus=2400 → extras=1000 × 1.5 = 1500. monthlyTotal=2000+1500=3500. After $20 off = 1500c.
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', committedOus: 2400, promoCode: 'LIFTOFF-PART' },
      });
      expect(res.statusCode).toBe(200);
      const opts = subscriptionActivated.mock.calls[0][1];
      expect(opts.promoApplied).toEqual({ amountOffUsd: 20.00, firstInvoiceTotalUsd: 15.00 });
    } finally {
      await app.close();
    }
  });

  it('(12d) calls subscriptionActivated with promoApplied (Core annual committed → $330)', async () => {
    const promo = fakePromoCode({
      id: 'promo_pa4', code: 'LIFTOFF-ANN-COMM',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_annual_test],
    });
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo });
    const { pbClient, subscriptionActivated } = mockPbClientWithActivationCapture();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient, stripe });
    try {
      // committedOus=2400 → extras=1000 × 1.5 = 1500. monthlyTotal=3500. Yearly=×10=35000.
      // After $20 off = 33000c → $330.
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'yearly', committedOus: 2400, promoCode: 'LIFTOFF-ANN-COMM' },
      });
      expect(res.statusCode).toBe(200);
      const opts = subscriptionActivated.mock.calls[0][1];
      expect(opts.promoApplied).toEqual({ amountOffUsd: 20.00, firstInvoiceTotalUsd: 330.00 });
    } finally {
      await app.close();
    }
  });

  it('(13) calls subscriptionActivated without promoApplied when no promo provided', async () => {
    const { stripe } = mockStripeForSubscribe();
    const { pbClient, subscriptionActivated } = mockPbClientWithActivationCapture();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      const opts = subscriptionActivated.mock.calls[0][1];
      expect(opts.promoApplied).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('(14) maps late Stripe rejection from promo discount to 400 invalid_promo_code', async () => {
    const promo = fakePromoCode({
      id: 'promo_late', code: 'LATE',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const stripeError: Stripe.errors.StripeError = Object.assign(new Error('No such promotion code'), {
      type: 'StripeInvalidRequestError' as const,
      code: 'resource_missing',
      param: 'discounts',
    }) as unknown as Stripe.errors.StripeError;
    const throwingCreate = mockFn().mockRejectedValue(stripeError);
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo, subscriptionsCreateImpl: throwingCreate });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'LATE' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_promo_code');
    } finally {
      await app.close();
    }
  });

  it('(14b) does NOT mislabel a non-promo Stripe rejection as invalid_promo_code (regression: invoice_settings rejection appeared as bad promo)', async () => {
    // A Stripe error whose param is unrelated to the promo surface must bubble
    // up as a 500 — not get swallowed as invalid_promo_code by the catch. The
    // user-visible bug was: a valid promo + a Stripe-rejected
    // invoice_settings.custom_fields param landed as "The promo code is
    // invalid or expired." in the UI, sending users to re-check a valid code.
    const promo = fakePromoCode({
      id: 'promo_ok', code: 'GOOD',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const unrelatedError: Stripe.errors.StripeError = Object.assign(
      new Error('Received unknown parameter: invoice_settings[custom_fields]'),
      {
        type: 'StripeInvalidRequestError' as const,
        code: 'parameter_unknown',
        param: 'invoice_settings[custom_fields]',
      },
    ) as unknown as Stripe.errors.StripeError;
    const throwingCreate = mockFn().mockRejectedValue(unrelatedError);
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo, subscriptionsCreateImpl: throwingCreate });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'GOOD' },
      });
      // Generic failure — NOT invalid_promo_code.
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe('subscribe_failed');
    } finally {
      await app.close();
    }
  });

  it('(15) card decline under error_if_incomplete surfaces as a normal failure, leaves no local row, and is retryable with the same code', async () => {
    const promo = fakePromoCode({
      id: 'promo_decline', code: 'DECLINE',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const cardError: Stripe.errors.StripeError = Object.assign(new Error('Your card was declined.'), {
      type: 'StripeCardError' as const,
      code: 'card_declined',
    }) as unknown as Stripe.errors.StripeError;
    const throwingCreate = mockFn().mockRejectedValue(cardError);
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo, subscriptionsCreateImpl: throwingCreate });
    const { pbClient, subscriptionActivated } = mockPbClientWithActivationCapture();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'DECLINE' },
      });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe('subscribe_failed');
      // subscriptions.create is the only thing that throws; everything downstream
      // (upsertSubscription writing the local row, subscriptionActivated firing
      // the PB callback + welcome email) must not run. Asserting via the
      // post-create hook keeps the contract observable from the harness.
      expect(subscriptionActivated).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }

    // Retry path: a clean Stripe mock + a fresh pbClient. The promo code is
    // unchanged on Stripe (no redemption was consumed under
    // payment_behavior: 'error_if_incomplete'), so the same code applies on
    // the next attempt. We use a fresh mock harness because the mock pool is
    // built per-app and we don't model cross-app state.
    const { stripe: stripe2 } = mockStripeForSubscribe({ promotionCode: promo });
    const { pbClient: pbClient2, subscriptionActivated: subscriptionActivated2 } = mockPbClientWithActivationCapture();
    const retryApp = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: pbClient2, stripe: stripe2 });
    try {
      const res = await retryApp.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'DECLINE' },
      });
      expect(res.statusCode).toBe(200);
      expect(subscriptionActivated2).toHaveBeenCalledTimes(1);
    } finally {
      await retryApp.close();
    }
  });

  it('(16) trims whitespace from the submitted promo code before lookup', async () => {
    const promo = fakePromoCode({
      id: 'promo_trim', code: 'LIFTOFF-TRIM',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const { stripe, promotionCodesList } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, pbClient: mockPbClientWithActivation(), stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: '  LIFTOFF-TRIM  ' },
      });
      expect(res.statusCode).toBe(200);
      expect(promotionCodesList).toHaveBeenCalledWith(expect.objectContaining({ code: 'LIFTOFF-TRIM' }));
    } finally {
      await app.close();
    }
  });

  it('(17) idempotent under double-click — one Stripe sub created, one redemption consumed, second caller gets 409', async () => {
    const promo = fakePromoCode({
      id: 'promo_dbl', code: 'LIFTOFF-DOUBLE',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const { stripe, subscriptionsCreate } = mockStripeForSubscribe({ promotionCode: promo });
    // layer1FlipsAfterFirstCall: first Layer-1 read returns no row, every
    // subsequent read returns the row "written by the first caller". The mock
    // pool isn't truly serializing — it's modelling the OUTCOME of the
    // pg_advisory_xact_lock + INSERT + SELECT chain so we can assert the
    // user-visible contract (one Stripe create, both responses 200 — the
    // losing caller reads the existing sub via alreadyExists and returns
    // idempotently rather than 409'ing the user).
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      pbClient: mockPbClientWithActivation(),
      stripe,
      layer1FlipsAfterFirstCall: true,
    });
    try {
      const fire = () => app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'LIFTOFF-DOUBLE' },
      });
      const [a, b] = await Promise.all([fire(), fire()]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      const losing = [a, b].find(r => JSON.parse(r.body).alreadyActive === true);
      expect(losing).toBeDefined();
      expect(JSON.parse(losing!.body)).toMatchObject({ alreadyActive: true });
      expect(subscriptionsCreate).toHaveBeenCalledTimes(1);
      // The discount only flows on the call that reached subscriptions.create.
      const subArgs = subscriptionsCreate.mock.calls[0][0];
      expect(subArgs.discounts).toEqual([{ promotion_code: 'promo_dbl' }]);
    } finally {
      await app.close();
    }
  });

  // ── Phase 7: promo eligibility (re-signup abuse prevention) ───────────────
  // Eligibility check fires before lookupPromotionCode when a promoCode is
  // present. Two signals can deny: customer.metadata.email_sha256 matched in
  // the deletion ledger, OR the card's fingerprint already exists on a
  // soft-deleted customer (different stripe_customer_id, customer_status =
  // 'deleted'). Either denial surfaces as the same invalid_promo_code error.

  it('returns 400 invalid_promo_code when promo is valid but checkDeletionHistory matches', async () => {
    const promo = fakePromoCode({ id: 'promo_e1', code: 'LIFTOFF-DENIED', appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test] });
    const { stripe, promotionCodesList } = mockStripeForSubscribe({ promotionCode: promo });
    // Make the customer carry an email_sha256 metadata so the helper queries PB.
    (stripe.customers.retrieve as ReturnType<typeof mockFn>).mockResolvedValue({ id: STRIPE_CUSTOMER, metadata: { email_sha256: 'h_deleted' } });
    const pbClient = mockPbClient();
    (pbClient.checkDeletionHistory as ReturnType<typeof mockFn>).mockResolvedValue({ matched: true, deletedAt: '2026-01-01T00:00:00.000Z' });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe, pbClient });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'LIFTOFF-DENIED' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_promo_code');
      // lookupPromotionCode must NOT have been called — eligibility denied first.
      expect(promotionCodesList).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 400 invalid_promo_code when fingerprint matches a soft-deleted customer', async () => {
    const promo = fakePromoCode({ id: 'promo_e2', code: 'LIFTOFF-FPDENIED', appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test] });
    const { stripe, promotionCodesList } = mockStripeForSubscribe({ promotionCode: promo });
    // Pool returns a row for the deleted-fingerprint SELECT.
    const pool = mockPool({ stripeCustomerId: STRIPE_CUSTOMER });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseQuery = (pool as any).query as ReturnType<typeof mockFn>;
    baseQuery.mockImplementation((sql: string) => {
      if (sql.includes('payment_method_fingerprints_seen')) {
        return Promise.resolve({ rows: [{}], rowCount: 1 });
      }
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK') || sql.includes('SELECT set_config')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes('FROM subscriptions') && sql.includes('stripe_customer_id')) {
        return Promise.resolve({ rows: [{ stripe_customer_id: STRIPE_CUSTOMER }], rowCount: 1 });
      }
      if (sql.includes('FROM subscriptions')) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    setBillingTestPool(pool);
    const app = Fastify({ logger: false });
    registerBillingAccountsRouter(app, { pool, stripe, pbClient: mockPbClient(), billingServiceToken: 'test-token', log: { info: () => {}, warn: () => {}, error: () => {} } });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/subscribe`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', promoCode: 'LIFTOFF-FPDENIED' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_promo_code');
      expect(promotionCodesList).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/billing/accounts/:tenantId/promo/lookup', () => {
  // Pure Stripe-API wrapping endpoint. No DB reads. Shares lookupPromotionCode()
  // with /subscribe so these tests mirror /subscribe's promo cases (2/4/5/6/7/8)
  // plus the new endpoint-specific shape assertions.

  it('returns valid=true with amountOffUsd for a code that applies to the chosen plan', async () => {
    const promo = fakePromoCode({
      id: 'promo_ok', code: 'LIFTOFF-OK',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
      amountOff: 2000,
    });
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'LIFTOFF-OK', planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ valid: true, amountOffUsd: 20 });
    } finally {
      await app.close();
    }
  });

  it('returns 400 promo_code_not_applicable when applies_to.products excludes the chosen plan', async () => {
    const promo = fakePromoCode({
      id: 'promo_core_only', code: 'LIFTOFF-CORE',
      appliesToProducts: [
        TEST_PRODUCT_IDS.price_core_monthly_test,
        TEST_PRODUCT_IDS.price_core_annual_test,
      ],
    });
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'LIFTOFF-CORE', planId: 'growth', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('promo_code_not_applicable');
    } finally {
      await app.close();
    }
  });

  it('returns 400 invalid_promo_code for unknown / inactive / expired codes (empty Stripe response)', async () => {
    const { stripe } = mockStripeForSubscribe({ promotionCode: null });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'TYPO', planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_promo_code');
    } finally {
      await app.close();
    }
  });

  it("returns 400 invalid_promo_code for duration: 'forever'", async () => {
    const promo = fakePromoCode({ id: 'p', code: 'F', duration: 'forever' });
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'F', planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_promo_code');
    } finally {
      await app.close();
    }
  });

  it("returns 400 invalid_promo_code for duration: 'repeating'", async () => {
    const promo = fakePromoCode({ id: 'p', code: 'R', duration: 'repeating' });
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'R', planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_promo_code');
    } finally {
      await app.close();
    }
  });

  it('accepts an unscoped coupon (no applies_to.products) on any plan', async () => {
    const promo = fakePromoCode({ id: 'p', code: 'OPEN', appliesToProducts: null, amountOff: 1500 });
    const { stripe } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'OPEN', planId: 'growth', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ valid: true, amountOffUsd: 15 });
    } finally {
      await app.close();
    }
  });

  it('trims whitespace before lookup', async () => {
    const promo = fakePromoCode({
      id: 'promo_trim', code: 'LIFTOFF-TRIM',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const { stripe, promotionCodesList } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: '  LIFTOFF-TRIM  ', planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      expect(promotionCodesList).toHaveBeenCalledWith(expect.objectContaining({ code: 'LIFTOFF-TRIM' }));
    } finally {
      await app.close();
    }
  });

  it('uses the fully-qualified expand path so applies_to is populated at runtime', async () => {
    // Regression: `expand: ['data.coupon']` alone leaves coupon.applies_to
    // undefined, which would silently bypass the applies_to.products
    // pre-check. The endpoint must use the nested `data.coupon.applies_to`
    // expand — identical to /subscribe's helper. This pins it.
    const promo = fakePromoCode({
      id: 'p', code: 'X',
      appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test],
    });
    const { stripe, promotionCodesList } = mockStripeForSubscribe({ promotionCode: promo });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'X', planId: 'core', billingPeriod: 'monthly' },
      });
      expect(promotionCodesList.mock.calls[0][0].expand).toEqual(['data.coupon.applies_to']);
    } finally {
      await app.close();
    }
  });

  it('returns 400 missing_code when the body omits or blanks the code', async () => {
    const { stripe } = mockStripeForSubscribe();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: '   ', planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('missing_code');
    } finally {
      await app.close();
    }
  });

  it('returns 400 invalid_plan_id / invalid_billing_period for bad inputs', async () => {
    const { stripe } = mockStripeForSubscribe();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const bad1 = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'X', planId: 'bogus', billingPeriod: 'monthly' },
      });
      expect(bad1.statusCode).toBe(400);
      expect(JSON.parse(bad1.body).error).toBe('invalid_plan_id');

      const bad2 = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'X', planId: 'core', billingPeriod: 'biennial' },
      });
      expect(bad2.statusCode).toBe(400);
      expect(JSON.parse(bad2.body).error).toBe('invalid_billing_period');
    } finally {
      await app.close();
    }
  });

  it('rejects requests without X-Service-Auth (401)', async () => {
    const { stripe } = mockStripeForSubscribe();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        payload: { code: 'X', planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ── Phase 7: promo eligibility on /promo/lookup ────────────────────────────
  // /promo/lookup is the blur-time affirmation. Eligibility check fires when
  // the tenant already has a Stripe customer + payment method; otherwise it
  // is skipped (the user hasn't entered card details yet).

  it('returns 400 invalid_promo_code when checkDeletionHistory matches the email hash', async () => {
    const promo = fakePromoCode({ id: 'promo_lk1', code: 'LIFTOFF-LKDENIED', appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test] });
    const { stripe, promotionCodesList } = mockStripeForSubscribe({ promotionCode: promo });
    (stripe.customers.retrieve as ReturnType<typeof mockFn>).mockResolvedValue({ id: STRIPE_CUSTOMER, metadata: { email_sha256: 'h_deleted_lk' } });
    const pbClient = mockPbClient();
    (pbClient.checkDeletionHistory as ReturnType<typeof mockFn>).mockResolvedValue({ matched: true, deletedAt: '2026-01-01T00:00:00.000Z' });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe, pbClient });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'LIFTOFF-LKDENIED', planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_promo_code');
      expect(promotionCodesList).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('skips eligibility check (no customer/PM yet) and validates normally', async () => {
    const promo = fakePromoCode({ id: 'promo_lk2', code: 'LIFTOFF-NOPM', appliesToProducts: [TEST_PRODUCT_IDS.price_core_monthly_test] });
    const { stripe, promotionCodesList } = mockStripeForSubscribe({ promotionCode: promo });
    (stripe.customers.listPaymentMethods as ReturnType<typeof mockFn>).mockResolvedValue({ data: [] });
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/promo/lookup`,
        headers: AUTH_HEADERS,
        payload: { code: 'LIFTOFF-NOPM', planId: 'core', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      expect(promotionCodesList).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/billing/accounts/:tenantId/replace-subscription', () => {
  // Smoke coverage that the persistent-product switch and the OU custom_fields
  // mirror /subscribe. No promo logic here — replace-subscription is plan-change,
  // not acquisition. The mock pool returns empty rows for the cancel-poll's
  // `SELECT id FROM subscriptions` query, so the 30s wait collapses to a no-op.

  it('(18) attaches ad-hoc price to the persistent product', async () => {
    const { stripe, pricesCreate, subscriptionsCreate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/replace-subscription`,
        headers: AUTH_HEADERS,
        payload: { planId: 'growth', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.product).toBe(TEST_PRODUCT_IDS.price_growth_monthly_test);
      expect(priceArgs.product_data).toBeUndefined();
      // Replace flow proceeded into provisionForTenant; subscriptions.create
      // received the same persistent-product-attach ad-hoc price.
      expect(subscriptionsCreate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('(19) sets invoice custom_fields with OU allocation on the CUSTOMER (replacement path)', async () => {
    const { stripe, subscriptionsCreate, customersUpdate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/replace-subscription`,
        headers: AUTH_HEADERS,
        payload: { planId: 'growth', billingPeriod: 'monthly', committedOus: 3000 },
      });
      expect(res.statusCode).toBe(200);
      expect(customersUpdate).toHaveBeenCalledWith(STRIPE_CUSTOMER, {
        invoice_settings: {
          custom_fields: [{ name: 'Monthly Operating Units', value: '3,000 OUs/month' }],
        },
      });
      const subArgs = subscriptionsCreate.mock.calls[0][0];
      // Subscription create no longer carries invoice_settings.custom_fields.
      expect(subArgs.invoice_settings).toBeUndefined();
      // Replace path does not plumb promos.
      expect(subArgs.discounts).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/billing/accounts/:tenantId/change-plan', () => {
  // Same pricing bug as /subscribe — the /change-plan handler was also missing
  // the ×10 multiplier for yearly. These regression tests guard the fix.

  const EXISTING_SUB: SubscriptionRow = {
    stripe_subscription_id: 'sub_existing',
    status: 'active',
    plan_id: 'price_old',
    current_period_end: '2026-06-01T00:00:00.000Z',
    cancel_at_period_end: false,
  };

  it('applies × 10 multiplier when switching to yearly', async () => {
    const { stripe, pricesCreate, subscriptionsUpdate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      subscription: EXISTING_SUB,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      // Core base 800 OUs, yearly. Expected unit_amount = 2000 × 10 = 20000.
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/change-plan`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'yearly' },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.unit_amount).toBe(20000);
      expect(priceArgs.recurring.interval).toBe('year');
      expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('does not apply multiplier when switching to monthly', async () => {
    const { stripe, pricesCreate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      subscription: EXISTING_SUB,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      // Growth base 2,150 OUs, monthly. Expected unit_amount = 5000 (no multiplier).
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/change-plan`,
        headers: AUTH_HEADERS,
        payload: { planId: 'growth', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.unit_amount).toBe(5000);
      expect(priceArgs.recurring.interval).toBe('month');
    } finally {
      await app.close();
    }
  });

  it('charges (base + committed extras) × 10 on yearly plan change', async () => {
    const { stripe, pricesCreate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      subscription: EXISTING_SUB,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      // Scale yearly with committedOus=17200 → extraOus=2000 → extra cost =
      // 2000 × 1.5 = 3000 cents. monthlyTotal = 20000 + 3000 = 23000. Yearly = ×10 = 230000.
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/change-plan`,
        headers: AUTH_HEADERS,
        payload: { planId: 'scale', billingPeriod: 'yearly', committedOus: 17200 },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.unit_amount).toBe(230000);
    } finally {
      await app.close();
    }
  });

  it('attaches the ad-hoc price to the persistent product (not product_data)', async () => {
    const { stripe, pricesCreate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      subscription: EXISTING_SUB,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/change-plan`,
        headers: AUTH_HEADERS,
        payload: { planId: 'growth', billingPeriod: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.product).toBe(TEST_PRODUCT_IDS.price_growth_monthly_test);
      expect(priceArgs.product_data).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('sets invoice custom_fields with the new OU allocation on the CUSTOMER (plan change)', async () => {
    const { stripe, subscriptionsUpdate, customersUpdate } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      subscription: EXISTING_SUB,
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/change-plan`,
        headers: AUTH_HEADERS,
        payload: { planId: 'growth', billingPeriod: 'monthly', committedOus: 3000 },
      });
      expect(res.statusCode).toBe(200);
      expect(customersUpdate).toHaveBeenCalledWith(STRIPE_CUSTOMER, {
        invoice_settings: {
          custom_fields: [{ name: 'Monthly Operating Units', value: '3,000 OUs/month' }],
        },
      });
      // Subscription update no longer carries invoice_settings.custom_fields.
      const updateArgs = subscriptionsUpdate.mock.calls[0][1];
      expect(updateArgs.invoice_settings).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/billing/accounts/:tenantId/cancel-subscription', () => {
  // Schedules cancel-at-period-end on the active Stripe sub and mirrors the
  // flag onto the local row so /overview reflects "ending soon" without
  // waiting for the customer.subscription.updated webhook.

  const ACTIVE_SUB: SubscriptionRow = {
    stripe_subscription_id: 'sub_user_active',
    status: 'active',
    plan_id: 'price_core',
    current_period_end: '2026-06-01T00:00:00.000Z',
    cancel_at_period_end: false,
  };

  it('returns 200, sets cancel_at_period_end on Stripe, mirrors the flag locally, and notifies PB synchronously', async () => {
    const { stripe, subscriptionsUpdate } = mockStripeForSubscribe();
    subscriptionsUpdate.mockResolvedValue({
      id: 'sub_user_active', cancel_at_period_end: true, cancel_at: 1779177777,
    });
    const subscriptionEnding = mockFn().mockResolvedValue(undefined);
    const pbClient = {
      getControlsStatus: mockFn().mockResolvedValue(null),
      subscriptionActivated: mockFn().mockResolvedValue(undefined),
      subscriptionEnding,
    } as unknown as PlatformBackendClient;
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      subscription: ACTIVE_SUB,
      pbClient,
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/cancel-subscription`,
        headers: AUTH_HEADERS,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        success: true, cancelAtPeriodEnd: true, cancelAt: 1779177777,
      });
      expect(subscriptionsUpdate).toHaveBeenCalledWith('sub_user_active', {
        cancel_at_period_end: true,
      });
      // Synchronous PB notify — guarantees the subscription-ending email
      // fires without depending on the customer.subscription.updated
      // webhook chain (which can be skipped by code paths that don't apply
      // to self-serve subs).
      expect(subscriptionEnding).toHaveBeenCalledWith(STRIPE_CUSTOMER, {
        accessEndsAt: 1779177777,
      });
    } finally {
      await app.close();
    }
  });

  it('returns 404 when there is no active subscription to cancel', async () => {
    const { stripe } = mockStripeForSubscribe();
    const app = await buildApp({
      stripeCustomerId: STRIPE_CUSTOMER,
      // No subscription row → resolveStripeCustomer returns null after
      // recent fix? No — resolveStripeCustomer was relaxed to find the
      // customer regardless of status, but the subRow lookup inside the
      // handler still filters by status. With no row at all, both
      // resolveStripeCustomer AND subRow miss; the explicit
      // `no_active_subscription` branch handles it.
      pbClient: mockPbClientWithActivation(),
      stripe,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/cancel-subscription`,
        headers: AUTH_HEADERS,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('no_active_subscription');
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/billing/accounts/:tenantId/checkout-session', () => {
  // /checkout-session is a separate ingress (Stripe's embedded Checkout) from
  // /subscribe. The persistent-product switch here keeps every self-serve
  // entrypoint pointing at the same six stable products, so invoice line text
  // and any future product-scoped promo work stays consistent.

  function mockStripeForCheckoutSession() {
    const pricesCreate = mockFn().mockImplementation((args: Stripe.PriceCreateParams) =>
      Promise.resolve({ id: `price_test_${Math.random().toString(36).slice(2, 8)}`, ...args }),
    );
    const pricesRetrieve = mockFn().mockImplementation((priceId: string) => {
      const productId = TEST_PRODUCT_IDS[priceId];
      if (!productId) return Promise.reject(new Error(`unmocked price: ${priceId}`));
      return Promise.resolve({ id: priceId, product: productId });
    });
    const sessionsCreate = mockFn().mockResolvedValue({
      id: 'cs_test_123', client_secret: 'cs_test_secret_abc',
    });
    const customersRetrieve = mockFn().mockResolvedValue({ deleted: false, email: 'u@example.com' });
    const stripe = {
      customers: { retrieve: customersRetrieve },
      prices: { create: pricesCreate, retrieve: pricesRetrieve },
      checkout: { sessions: { create: sessionsCreate } },
    } as unknown as Stripe;
    return { stripe, pricesCreate, sessionsCreate };
  }

  it('attaches the ad-hoc price to the persistent product (not product_data)', async () => {
    const { stripe, pricesCreate } = mockStripeForCheckoutSession();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/checkout-session`,
        headers: AUTH_HEADERS,
        payload: { planId: 'core', billingPeriod: 'monthly', returnUrl: 'http://localhost:5173/onboarding' },
      });
      expect(res.statusCode).toBe(200);
      const priceArgs = pricesCreate.mock.calls[0][0];
      expect(priceArgs.product).toBe(TEST_PRODUCT_IDS.price_core_monthly_test);
      expect(priceArgs.product_data).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/billing/accounts/:tenantId/credits ────────────────────────────
// The manual wallet top-up behind "Add to Balance" on /dashboard/settings/billing.
// Until this route existed the button POSTed into a 404 and the only way to fund
// a wallet was auto-reload, which fires solely from the real-time spend path.
//
// The invariant these tests protect is the credit happening EXACTLY once, and
// only after Stripe confirms payment: `onInvoicePaid` deliberately does not
// dispatch wallet state for 'prepaid_reload', so `prepaidToppedUp` here is the
// single crediting call. A decline must leave the wallet untouched.
function mockStripeForCredits(opts: { defaultPaymentMethod?: string | null; noPaymentIntent?: boolean } = {}) {
  const defaultPm = opts.defaultPaymentMethod === undefined ? 'pm_default' : opts.defaultPaymentMethod;
  const invoiceItemsCreate = mockFn().mockResolvedValue({ id: 'ii_test' });
  const invoicesCreate     = mockFn().mockResolvedValue({ id: 'in_test' });
  const finalizeInvoice    = mockFn().mockResolvedValue(
    opts.noPaymentIntent
      ? { id: 'in_test' }
      : { id: 'in_test', payment_intent: { id: 'pi_test', client_secret: 'pi_test_secret' } },
  );
  const pay = mockFn().mockResolvedValue({ id: 'in_test', status: 'paid' });
  const voidInvoice = mockFn().mockResolvedValue({ id: 'in_test', status: 'void' });
  const stripe = {
    invoiceItems: { create: invoiceItemsCreate },
    invoices: { create: invoicesCreate, finalizeInvoice, pay, voidInvoice, list: mockFn().mockResolvedValue({ data: [] }) },
    customers: {
      retrieve: mockFn().mockResolvedValue({
        deleted: false,
        invoice_settings: { default_payment_method: defaultPm },
        metadata: {},
      }),
    },
  } as unknown as Stripe;
  return { stripe, invoiceItemsCreate, invoicesCreate, finalizeInvoice, pay, voidInvoice };
}

function mockPbClientForCredits() {
  const prepaidToppedUp = mockFn().mockResolvedValue(undefined);
  const pbClient = {
    getControlsStatus: mockFn().mockResolvedValue(null),
    checkDeletionHistory: mockFn().mockResolvedValue({ matched: false }),
    prepaidToppedUp,
  } as unknown as PlatformBackendClient;
  return { pbClient, prepaidToppedUp };
}

describe('POST /api/billing/accounts/:tenantId/credits', () => {
  // The invoice is prepared, not paid. Paying it here would charge the card
  // off-session, and an off-session payment can never be challenged by the
  // issuer — so no 3D Secure, and every fraudulent dispute on a top-up is ours
  // to lose. The browser confirms it instead.
  it('prepares the payment for the browser and charges nothing itself', async () => {
    const { stripe, invoiceItemsCreate, invoicesCreate, pay } = mockStripeForCredits();
    const { pbClient, prepaidToppedUp } = mockPbClientForCredits();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe, pbClient });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/credits`,
        headers: AUTH_HEADERS,
        payload: { amountUsd: 50 },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: 'requires_confirmation',
        invoiceId: 'in_test',
        clientSecret: 'pi_test_secret',
        paymentMethodId: 'pm_default',
      });

      // The right amount, in cents.
      expect(invoiceItemsCreate).toHaveBeenCalledTimes(1);
      expect(invoiceItemsCreate.mock.calls[0][0]).toMatchObject({
        customer: STRIPE_CUSTOMER, amount: 5000, currency: 'usd',
      });

      // metadata.type stays 'prepaid_reload' so classifyInvoice routes it like
      // its automatic twin; `source: 'manual'` is what tells onInvoicePaid this
      // is the one it must credit, since auto-reload credits its own.
      expect(invoicesCreate.mock.calls[0][0]).toMatchObject({
        customer: STRIPE_CUSTOMER,
        metadata: { type: 'prepaid_reload', tenant_id: VALID_TENANT, source: 'manual' },
      });

      // 3D Secure on every top-up, not only where Radar asks for it: an
      // authenticated payment disputed as fraud is the issuer's loss, which is
      // what lets a top-up be any size.
      expect(invoicesCreate.mock.calls[0][0]).toMatchObject({
        payment_settings: { payment_method_options: { card: { request_three_d_secure: 'any' } } },
      });

      // Neither charged nor credited here. The wallet is credited by
      // invoice.paid, once the person is through the issuer's challenge.
      expect(pay).not.toHaveBeenCalled();
      expect(prepaidToppedUp).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // The line item must be bound to THIS invoice by id.
  //
  // Creating the item first and letting the invoice sweep it up depends on
  // `pending_invoice_items_behavior`, which defaults to `exclude`: the invoice
  // comes out with no lines and a $0 total, so the customer is charged nothing
  // and either gets free credit or an error. Passing `include` instead sweeps
  // EVERY pending item for the customer, so two top-ups in flight merge into
  // one charge. Binding by id is the only shape with neither failure — and it
  // is invisible to a mocked Stripe unless the order is asserted.
  it('binds the line item to the invoice it created, in that order', async () => {
    const { stripe, invoiceItemsCreate, invoicesCreate } = mockStripeForCredits();
    const { pbClient } = mockPbClientForCredits();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe, pbClient });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/credits`,
        headers: AUTH_HEADERS,
        payload: { amountUsd: 50 },
      });
      expect(res.statusCode).toBe(200);

      // The invoice is created before the item exists...
      expect(invoicesCreate.mock.invocationCallOrder[0])
        .toBeLessThan(invoiceItemsCreate.mock.invocationCallOrder[0]);

      // ...and the item names it, rather than being swept up as a pending one.
      expect(invoiceItemsCreate.mock.calls[0][0]).toMatchObject({
        customer: STRIPE_CUSTOMER,
        invoice: 'in_test',
        amount: 5000,
      });

      // Never the sweep, whose behaviour depends on the account's API version
      // and which merges concurrent top-ups.
      expect(invoicesCreate.mock.calls[0][0]).not.toHaveProperty('pending_invoice_items_behavior');
    } finally {
      await app.close();
    }
  });

  // Finalizing an invoice nothing can pay leaves an open invoice behind for
  // nothing, and the browser has no card to confirm with.
  it('refuses before creating anything when the customer has no card on file', async () => {
    const { stripe, invoiceItemsCreate, invoicesCreate } = mockStripeForCredits({ defaultPaymentMethod: null });
    const { pbClient } = mockPbClientForCredits();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe, pbClient });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/credits`,
        headers: AUTH_HEADERS,
        payload: { amountUsd: 50 },
      });
      expect(res.statusCode).toBe(402);
      expect(JSON.parse(res.body).error).toBe('no_payment_method');
      expect(invoiceItemsCreate).not.toHaveBeenCalled();
      expect(invoicesCreate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // No secret means the browser cannot confirm and the money would never be
  // taken, so the invoice must not be left open against the customer.
  it('voids the invoice when it finalizes without a payment intent', async () => {
    const { stripe, voidInvoice } = mockStripeForCredits({ noPaymentIntent: true });
    const { pbClient, prepaidToppedUp } = mockPbClientForCredits();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe, pbClient });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/credits`,
        headers: AUTH_HEADERS,
        payload: { amountUsd: 50 },
      });
      expect(res.statusCode).toBe(500);
      expect(voidInvoice).toHaveBeenCalledWith('in_test');
      expect(prepaidToppedUp).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects amounts below the $5 floor without touching Stripe', async () => {
    const { stripe, invoiceItemsCreate } = mockStripeForCredits();
    const { pbClient, prepaidToppedUp } = mockPbClientForCredits();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe, pbClient });
    try {
      for (const amountUsd of [4.99, 0, -10]) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/billing/accounts/${VALID_TENANT}/credits`,
          headers: AUTH_HEADERS,
          payload: { amountUsd },
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe('invalid_amount');
      }
      // A client-side minimum is not a minimum; nothing may reach Stripe.
      expect(invoiceItemsCreate).not.toHaveBeenCalled();
      expect(prepaidToppedUp).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a non-numeric amount', async () => {
    const { stripe, invoiceItemsCreate } = mockStripeForCredits();
    const { pbClient } = mockPbClientForCredits();
    const app = await buildApp({ stripeCustomerId: STRIPE_CUSTOMER, stripe, pbClient });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/credits`,
        headers: AUTH_HEADERS,
        payload: { amountUsd: 'fifty' },
      });
      expect(res.statusCode).toBe(400);
      expect(invoiceItemsCreate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('404s when the tenant has no Stripe customer', async () => {
    const { stripe, invoiceItemsCreate } = mockStripeForCredits();
    const { pbClient, prepaidToppedUp } = mockPbClientForCredits();
    const app = await buildApp({ stripeCustomerId: null, stripe, pbClient });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/credits`,
        headers: AUTH_HEADERS,
        payload: { amountUsd: 50 },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('no_active_subscription');
      expect(invoiceItemsCreate).not.toHaveBeenCalled();
      expect(prepaidToppedUp).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // A workspace funding itself with credit instead of subscribing has no row in
  // this service's `subscriptions` table, so the customer cannot be resolved
  // from it. platform-backend forwards the account's own customer id on this
  // route, and that fallback is the whole reason credit is buyable without a
  // subscription.
  it('buys credit without a subscription, using the customer the proxy forwards', async () => {
    const { stripe, invoiceItemsCreate } = mockStripeForCredits();
    const { pbClient, prepaidToppedUp } = mockPbClientForCredits();
    const app = await buildApp({ stripeCustomerId: null, stripe, pbClient });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/credits`,
        headers: { ...AUTH_HEADERS, 'x-account-stripe-customer-id': STRIPE_CUSTOMER },
        payload: { amountUsd: 50 },
      });
      expect(res.statusCode).toBe(200);
      expect(invoiceItemsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: STRIPE_CUSTOMER, amount: 5000 }),
      );
      // The payment is prepared against the forwarded customer; the wallet is
      // credited later, by invoice.paid, once the browser has confirmed it.
      expect(JSON.parse(res.body)).toMatchObject({ status: 'requires_confirmation' });
      expect(prepaidToppedUp).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // The routes that operate ON a subscription must keep refusing when there is
  // none; the fallback is only for the ones that have to work before one exists.
  it('does not extend the fallback to cancelling a subscription', async () => {
    const { stripe } = mockStripeForCredits();
    const { pbClient } = mockPbClientForCredits();
    const app = await buildApp({ stripeCustomerId: null, stripe, pbClient });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/billing/accounts/${VALID_TENANT}/cancel-subscription`,
        headers: { ...AUTH_HEADERS, 'x-account-stripe-customer-id': STRIPE_CUSTOMER },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// Platform-backend owns the auto-reload minimums ($1 threshold, $5 reload).
// A value under them is the customer's to fix, so its reason reaches the
// settings page instead of a bare 500.
describe('PUT /api/billing/accounts/:tenantId/auto-reload', () => {
  async function put(updateAutoReloadSettings: unknown) {
    const pbClient = { ...mockPbClient(), updateAutoReloadSettings } as unknown as PlatformBackendClient;
    const app = await buildApp({ stripeCustomerId: null, pbClient });
    try {
      return await app.inject({
        method: 'PUT',
        url: `/api/billing/accounts/${VALID_TENANT}/auto-reload`,
        headers: AUTH_HEADERS,
        payload: { thresholdUsd: 0.5, reloadAmountUsd: 5 },
      });
    } finally {
      await app.close();
    }
  }

  it('passes a platform-backend 400 on with its reason', async () => {
    const body = JSON.stringify({ error: 'thresholdUsd_must_be_at_least_1' });
    const res = await put(mockFn().mockRejectedValue(new PlatformBackendError('platform-backend PUT → 400', 400, body)));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'thresholdUsd_must_be_at_least_1' });
  });

  it('still answers 500 when platform-backend fails', async () => {
    const res = await put(mockFn().mockRejectedValue(new PlatformBackendError('platform-backend PUT → 503', 503, '')));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'auto_reload_put_failed' });
  });
});
