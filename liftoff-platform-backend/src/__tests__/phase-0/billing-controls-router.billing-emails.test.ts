// Tests for the new billing-email-coverage endpoints + notify wiring on
// existing endpoints. Mirrors the style of billing-controls-router.test.ts:
// silence side-effects, mock the pool, sign HMAC requests with supertest.

import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';

jest.mock('rate-limiter-flexible', () => ({
  RateLimiterPostgres: jest.fn().mockImplementation(() => ({
    consume: jest.fn().mockResolvedValue({}),
  })),
  RateLimiterRes: class RateLimiterRes extends Error {},
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(),
  withAdminScope: jest.fn((_opts: unknown, fn: (c: unknown) => unknown) =>
    fn({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  ),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const sendPaymentFailedEmail              = jest.fn().mockResolvedValue('email-1');
const sendSubscriptionConfirmationEmail   = jest.fn().mockResolvedValue('email-2');
const sendSubscriptionEndingEmail         = jest.fn().mockResolvedValue('email-3');
const sendSubscriptionEndedEmail          = jest.fn().mockResolvedValue('email-4');
const sendReceiptEmail                    = jest.fn().mockResolvedValue('email-5');
const sendCardExpiringEmail               = jest.fn().mockResolvedValue('email-6');

jest.mock('../../infrastructure/email', () => ({
  sendPaymentFailedEmail,
  sendSubscriptionConfirmationEmail,
  sendSubscriptionEndingEmail,
  sendSubscriptionEndedEmail,
  sendReceiptEmail,
  sendCardExpiringEmail,
}));

jest.mock('../../billing/subscription-items-service', () => ({
  syncSubscriptionItems:     jest.fn().mockResolvedValue(undefined),
  updatePlatformFeeQuantity: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../billing/addon-service', () => ({
  activateAddon:   jest.fn().mockResolvedValue(undefined),
  deactivateAddon: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../billing/execution-guard', () => ({
  invalidateExecutionCache: jest.fn(),
}));
jest.mock('../../jobs/annual-plan-allocation-reset', () => ({
  doPeriodReset: jest.fn().mockResolvedValue(undefined),
  annualPlanAllocationResetRouter: { use: jest.fn() },
}));

import { getPool } from '../../infrastructure/database';
import { billingControlsInternalRouter } from '../../billing/billing-controls-internal-router';

const BILLING_TOKEN = 'test-billing-service-token-32chars';
const ACCOUNT_ID    = 'acct-uuid-emails-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/billing', billingControlsInternalRouter);
  return app;
}

function sign(method: string, path: string, body: object) {
  const timestamp = Date.now();
  const bodyStr   = JSON.stringify(body);
  const str       = `${method}\n${path}\n${timestamp}\n${bodyStr}`;
  return { timestamp: String(timestamp), signature: createHmac('sha256', BILLING_TOKEN).update(str).digest('hex') };
}
function signedRequest(app: ReturnType<typeof buildApp>, method: 'post' | 'get', path: string, body: object = {}) {
  const { timestamp, signature } = sign(method.toUpperCase(), path, body);
  return request(app)[method](path)
    .set('X-Billing-Timestamp', timestamp)
    .set('X-Billing-Signature', signature)
    .send(body);
}

/**
 * Mock implementation of getPool() that returns sequential responses for
 * successive query() calls. Useful when an endpoint runs N queries in a
 * known order.
 */
function mockPoolSequential(responses: Array<{ rows: unknown[]; rowCount?: number }>) {
  let i = 0;
  (getPool as jest.Mock).mockReturnValue({
    query: jest.fn().mockImplementation(() => {
      const r = responses[i] ?? { rows: [], rowCount: 0 };
      i++;
      return Promise.resolve({ rows: r.rows, rowCount: r.rowCount ?? r.rows.length });
    }),
    connect: jest.fn(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BILLING_SERVICE_TOKEN = BILLING_TOKEN;
});

// ─── /subscription-ending (new) ───────────────────────────────────────────────

describe('POST /controls/:accountId/subscription-ending', () => {
  it('400 when accessEndsAt missing or not a number', async () => {
    mockPoolSequential([]);
    const app = buildApp();
    const res = await signedRequest(app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/subscription-ending`, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('accessEndsAt_required');
  });

  it('writes access_ends_at + fires notifySubscriptionEnding (200)', async () => {
    mockPoolSequential([
      { rows: [], rowCount: 1 },                                    // UPDATE billing_controls
      { rows: [{                                                    // notify helper JOIN
        email: 'ada@example.com', first_name: 'Ada',
        plan_type: 'core', billing_tier: 'standard',
        plan_included_ous: 800, is_annual_plan: false,
        self_serve_display_name: 'Core', self_serve_price_cents: 2000,
        enterprise_annual_cents: null, enterprise_included_ous: null,
        enterprise_included_rate: null, enterprise_precommit_ous: null,
        enterprise_precommit_rate: null,
      }] },
    ]);
    const app = buildApp();
    // June 1, 2026 00:00:00 UTC
    const accessEndsAt = 1748736000;
    const res = await signedRequest(
      app, 'post',
      `/api/internal/billing/controls/${ACCOUNT_ID}/subscription-ending`,
      { accessEndsAt },
    );
    expect(res.status).toBe(200);
    // Allow the fire-and-forget notify chain to settle before asserting.
    await new Promise((r) => setImmediate(r));
    expect(sendSubscriptionEndingEmail).toHaveBeenCalledTimes(1);
    expect(sendSubscriptionEndingEmail.mock.calls[0][0]).toBe('ada@example.com');
    expect(sendSubscriptionEndingEmail.mock.calls[0][1]).toBe('Ada');
    expect(sendSubscriptionEndingEmail.mock.calls[0][2]).toMatchObject({
      planName: 'Core',
      accessEndsDate: new Date(accessEndsAt * 1000),
    });
  });
});

// ─── /receipt (new) ───────────────────────────────────────────────────────────

describe('POST /controls/:accountId/receipt', () => {
  it('400 on missing or invalid fields', async () => {
    mockPoolSequential([]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/receipt`,
      { context: 'nope', amountUsd: 'string', paymentMethodType: 'card' },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_receipt_payload');
  });

  it('subscription_renewal: notify resolves planName + billingPeriod via JOIN', async () => {
    mockPoolSequential([
      { rows: [{
        email: 'ada@example.com', first_name: 'Ada',
        plan_type: 'growth', billing_tier: 'standard',
        plan_included_ous: 2150, is_annual_plan: true,
        self_serve_display_name: 'Growth', self_serve_price_cents: 5000,
        enterprise_annual_cents: null, enterprise_included_ous: null,
        enterprise_included_rate: null, enterprise_precommit_ous: null,
        enterprise_precommit_rate: null,
      }] },
    ]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/receipt`,
      { context: 'subscription_renewal', amountUsd: 50, paymentMethodType: 'card', paymentMethodLast4: '4242' },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(sendReceiptEmail).toHaveBeenCalledTimes(1);
    expect(sendReceiptEmail.mock.calls[0][2]).toBe('subscription_renewal');
    expect(sendReceiptEmail.mock.calls[0][3]).toMatchObject({
      amountUsd: 50,
      paymentMethodType: 'card',
      paymentMethodLast4: '4242',
      planName: 'Growth',
      billingPeriod: 'year',     // is_annual_plan = true
    });
  });

  it('credit_reload: notify omits plan fields', async () => {
    mockPoolSequential([
      { rows: [{
        email: 'ada@example.com', first_name: 'Ada',
        plan_type: 'core', billing_tier: 'standard',
        plan_included_ous: 800, is_annual_plan: false,
        self_serve_display_name: 'Core', self_serve_price_cents: 2000,
        enterprise_annual_cents: null, enterprise_included_ous: null,
        enterprise_included_rate: null, enterprise_precommit_ous: null,
        enterprise_precommit_rate: null,
      }] },
    ]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/receipt`,
      { context: 'credit_reload', amountUsd: 25, paymentMethodType: 'us_bank_account', paymentMethodLast4: '6789' },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(sendReceiptEmail).toHaveBeenCalledTimes(1);
    expect(sendReceiptEmail.mock.calls[0][2]).toBe('credit_reload');
    const callParams = sendReceiptEmail.mock.calls[0][3] as Record<string, unknown>;
    expect(callParams.planName).toBeUndefined();
    expect(callParams.billingPeriod).toBeUndefined();
    expect(callParams.paymentMethodType).toBe('us_bank_account');
    expect(callParams.paymentMethodLast4).toBe('6789');
  });
});

// ─── /card-expiring (new) ─────────────────────────────────────────────────────

describe('POST /controls/:accountId/card-expiring', () => {
  it('400 on missing card fields', async () => {
    mockPoolSequential([]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/card-expiring`,
      { cardBrand: 'Visa' /* missing rest */ },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_card_expiring_payload');
  });

  it('200 on valid payload + fires sendCardExpiringEmail with the account email', async () => {
    mockPoolSequential([
      { rows: [{ email: 'ada@example.com', first_name: 'Ada' }] },
    ]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/card-expiring`,
      { cardBrand: 'Visa', cardLast4: '4242', cardExpMonth: '06', cardExpYear: '2026' },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(sendCardExpiringEmail).toHaveBeenCalledTimes(1);
    expect(sendCardExpiringEmail.mock.calls[0][0]).toBe('ada@example.com');
    expect(sendCardExpiringEmail.mock.calls[0][2]).toMatchObject({
      cardBrand: 'Visa', cardLast4: '4242', cardExpMonth: '06', cardExpYear: '2026',
    });
  });
});

// ─── /auto-reload-failed: new payment method passthrough ──────────────────────

describe('POST /controls/:accountId/auto-reload-failed', () => {
  it('fires sendPaymentFailedEmail with auto_reload context + PM fields', async () => {
    mockPoolSequential([
      { rows: [], rowCount: 1 },                                    // UPDATE billing_controls
      { rows: [{ email: 'ada@example.com', first_name: 'Ada' }] },  // notifyPaymentFailed JOIN
    ]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/auto-reload-failed`,
      { amountUsd: 50, reason: 'insufficient_funds', paymentMethodType: 'card', paymentMethodLast4: '4242' },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(sendPaymentFailedEmail).toHaveBeenCalledTimes(1);
    expect(sendPaymentFailedEmail.mock.calls[0][2]).toBe('auto_reload');
    expect(sendPaymentFailedEmail.mock.calls[0][3]).toMatchObject({
      amountUsd: 50,
      paymentMethodType: 'card',
      paymentMethodLast4: '4242',
    });
  });
});

// ─── /payment-failed: subscription_renewal context ────────────────────────────

describe('POST /controls/:accountId/payment-failed', () => {
  it('fires sendPaymentFailedEmail with subscription_renewal context', async () => {
    mockPoolSequential([
      { rows: [], rowCount: 1 },
      { rows: [{ email: 'ada@example.com', first_name: 'Ada' }] },
    ]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/payment-failed`,
      { outstandingBalanceUsd: 19.99 },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(sendPaymentFailedEmail).toHaveBeenCalledTimes(1);
    expect(sendPaymentFailedEmail.mock.calls[0][2]).toBe('subscription_renewal');
    expect(sendPaymentFailedEmail.mock.calls[0][3]).toMatchObject({
      outstandingBalanceUsd: 19.99,
    });
  });
});

// ─── /threshold-failed: silent (no email) ─────────────────────────────────────

describe('POST /controls/:accountId/threshold-failed', () => {
  it('does NOT send a user-facing email (threshold billing is being phased out)', async () => {
    mockPoolSequential([
      { rows: [], rowCount: 1 },
    ]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/threshold-failed`,
      { thresholdLevel: 100, outstandingBalanceUsd: 100 },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(sendPaymentFailedEmail).not.toHaveBeenCalled();
  });
});

// ─── /subscription-cancelled: notifySubscriptionEnded + clears access_ends_at ──

describe('POST /controls/:accountId/subscription-cancelled', () => {
  it('clears access_ends_at + fires notifySubscriptionEnded', async () => {
    mockPoolSequential([
      { rows: [], rowCount: 0 },                                    // stale-cancel guard: bc pointer SELECT (no row → legacy suspend path)
      { rows: [], rowCount: 1 },                                    // UPDATE billing_controls suspend
      { rows: [], rowCount: 1 },                                    // mirrorSubscriptionCanceled UPDATE
      { rows: [], rowCount: 1 },                                    // UPDATE access_ends_at = NULL
      { rows: [{                                                    // notify helper JOIN
        email: 'ada@example.com', first_name: 'Ada',
        plan_type: 'core', billing_tier: 'standard',
        plan_included_ous: 800, is_annual_plan: false,
        self_serve_display_name: 'Core', self_serve_price_cents: 2000,
        enterprise_annual_cents: null, enterprise_included_ous: null,
        enterprise_included_rate: null, enterprise_precommit_ous: null,
        enterprise_precommit_rate: null,
      }] },
    ]);
    const app = buildApp();
    const res = await signedRequest(app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/subscription-cancelled`);
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(sendSubscriptionEndedEmail).toHaveBeenCalledTimes(1);
    expect(sendSubscriptionEndedEmail.mock.calls[0][2].planName).toBe('Core');
  });
});

// ─── /subscription-activated: notifySubscriptionConfirmation + clears stall flag ──

describe('POST /controls/:accountId/subscription-activated', () => {
  it('fires notifySubscriptionConfirmation for self-serve activation', async () => {
    // Sequence for a self-serve (planType: 'core') activation. NOTE: the
    // UPDATE entitlements (agent_execution_allowed) now runs under
    // withAdminScope (RLS-force), so it no longer consumes a getPool slot —
    // the getPool sequence:
    //  1. INSERT billing_controls … ON CONFLICT DO NOTHING (seeds the row)
    //  2. SELECT plan_catalog rates (resolvedPrecommitRate already set, but path runs lookup)
    //  3. UPDATE billing_controls (planType branch)
    //  4. mirrorSubscriptionActive UPDATE
    //  5. mirrorSubscriptionActive INSERT (since UPDATE returned 0 rows in mock)
    //  6. UPDATE billing_controls SET access_ends_at = NULL
    //  7. notify helper JOIN
    mockPoolSequential([
      // ensurePrePayBillingControlsRow: seeds the row so the activation UPDATE
      // further down cannot match zero rows. ON CONFLICT DO NOTHING, so on an
      // account that already has a row it affects none.
      { rows: [], rowCount: 0 },
      { rows: [{
        included_rate_usd_per_ou: '0.10',
        precommit_rate_usd_per_ou: '0.08',
        reload_rate_usd_per_ou: '0.12',
      }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },                                    // mirror UPDATE → 0 rows
      { rows: [], rowCount: 1 },                                    // mirror INSERT
      { rows: [], rowCount: 1 },                                    // clear access_ends_at
      { rows: [{                                                    // notify JOIN
        email: 'ada@example.com', first_name: 'Ada',
        plan_type: 'core', billing_tier: 'standard',
        plan_included_ous: 800, is_annual_plan: false,
        self_serve_display_name: 'Core', self_serve_price_cents: 2000,
        enterprise_annual_cents: null, enterprise_included_ous: null,
        enterprise_included_rate: null, enterprise_precommit_ous: null,
        enterprise_precommit_rate: null,
      }] },
    ]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/subscription-activated`,
      {
        planType: 'core',
        includedOus: 800,
        isAnnualPlan: false,
        stripeSubscriptionId: 'sub_test',
        stripePeriodEnd: '2026-07-01T00:00:00.000Z',
      },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(sendSubscriptionConfirmationEmail).toHaveBeenCalledTimes(1);
    const params = sendSubscriptionConfirmationEmail.mock.calls[0][2] as Record<string, unknown>;
    expect(params.planName).toBe('Core');
    expect(params.monthlyAllocationOus).toBe(800);
    expect(params.planPriceUsd).toBeCloseTo(20.0);
    expect(params.billingPeriod).toBe('month');
    expect(params.nextRenewalDate).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    // Regression for the no-promo path: promoApplied must NOT be set on
    // activations that did not include a promo body field.
    expect(params.promoApplied).toBeUndefined();
  });

  it('forwards promoApplied through to sendSubscriptionConfirmationEmail', async () => {
    // entitlements UPDATE runs under withAdminScope (off the getPool sequence).
    mockPoolSequential([
      // ensurePrePayBillingControlsRow: seeds the row so the activation UPDATE
      // further down cannot match zero rows. ON CONFLICT DO NOTHING, so on an
      // account that already has a row it affects none.
      { rows: [], rowCount: 0 },
      { rows: [{
        included_rate_usd_per_ou: '0.10',
        precommit_rate_usd_per_ou: '0.08',
        reload_rate_usd_per_ou: '0.12',
      }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{
        email: 'ada@example.com', first_name: 'Ada',
        plan_type: 'core', billing_tier: 'standard',
        plan_included_ous: 800, is_annual_plan: false,
        self_serve_display_name: 'Core', self_serve_price_cents: 2000,
        enterprise_annual_cents: null, enterprise_included_ous: null,
        enterprise_included_rate: null, enterprise_precommit_ous: null,
        enterprise_precommit_rate: null,
      }] },
    ]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/subscription-activated`,
      {
        planType: 'core',
        includedOus: 800,
        isAnnualPlan: false,
        stripeSubscriptionId: 'sub_test',
        stripePeriodEnd: '2026-07-01T00:00:00.000Z',
        promoApplied: { amountOffUsd: 20.0, firstInvoiceTotalUsd: 0 },
      },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(sendSubscriptionConfirmationEmail).toHaveBeenCalledTimes(1);
    const params = sendSubscriptionConfirmationEmail.mock.calls[0][2] as Record<string, unknown>;
    expect(params.promoApplied).toEqual({ amountOffUsd: 20.0, firstInvoiceTotalUsd: 0 });
  });

  it('passes billingPeriod: year through when is_annual_plan is true', async () => {
    // notifySubscriptionConfirmation reads ctx.isAnnualPlan (from the activation
    // request body) rather than r.is_annual_plan from the JOIN, so even though
    // billing's UPDATE writes is_annual_plan, the email's billingPeriod is
    // taken directly from the request. Regression guard against either source
    // drifting. (entitlements UPDATE runs under withAdminScope, off the sequence.)
    mockPoolSequential([
      // ensurePrePayBillingControlsRow: seeds the row so the activation UPDATE
      // further down cannot match zero rows. ON CONFLICT DO NOTHING, so on an
      // account that already has a row it affects none.
      { rows: [], rowCount: 0 },
      { rows: [{
        included_rate_usd_per_ou: '0.10',
        precommit_rate_usd_per_ou: '0.08',
        reload_rate_usd_per_ou: '0.12',
      }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{
        email: 'ada@example.com', first_name: 'Ada',
        plan_type: 'core', billing_tier: 'standard',
        plan_included_ous: 800, is_annual_plan: true,
        self_serve_display_name: 'Core', self_serve_price_cents: 2000,
        enterprise_annual_cents: null, enterprise_included_ous: null,
        enterprise_included_rate: null, enterprise_precommit_ous: null,
        enterprise_precommit_rate: null,
      }] },
    ]);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/subscription-activated`,
      {
        planType: 'core',
        includedOus: 800,
        isAnnualPlan: true,
        stripeSubscriptionId: 'sub_test',
        stripePeriodEnd: '2027-05-17T00:00:00.000Z',
      },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    const params = sendSubscriptionConfirmationEmail.mock.calls[0][2] as Record<string, unknown>;
    expect(params.billingPeriod).toBe('year');
  });
});
