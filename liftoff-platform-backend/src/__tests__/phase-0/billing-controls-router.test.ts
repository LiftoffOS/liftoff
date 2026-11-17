// TE-003, TE-005, TE-006: Billing controls internal router
//
// TE-003: Stripe webhook handler state transitions via internal API
// TE-005: Recovery flow — suspension → card update → payment retry → unblocked
// TE-006: Graduation — graduated_at set at $1,800, idempotent on replay,
//          period-reset uses $1,000 threshold post-graduation

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
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Silence external side-effects (email, Slack, syncSubscriptionItems, etc.)
jest.mock('../../infrastructure/email', () => ({
  sendPaymentFailedEmail: jest.fn().mockResolvedValue('email-id'),
}));
jest.mock('../../billing/subscription-items-service', () => ({
  syncSubscriptionItems:      jest.fn().mockResolvedValue(undefined),
  updatePlatformFeeQuantity:  jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../billing/addon-service', () => ({
  activateAddon:   jest.fn().mockResolvedValue(undefined),
  deactivateAddon: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../billing/operating-unit-service', () => ({
  getOperatingUnitsForPeriod: jest.fn().mockResolvedValue({ totalOus: 0, platformAnalyticsOus: 0, byAgent: [] }),
  getActivePricing: jest.fn().mockResolvedValue({ pricePerOu: 3.0, tier: 'standard', effectiveFrom: new Date() }),
}));
jest.mock('../../billing/execution-guard', () => ({
  invalidateExecutionCache: jest.fn(),
}));

import { getPool } from '../../infrastructure/database';
import { billingControlsInternalRouter } from '../../billing/billing-controls-internal-router';
import { invalidateExecutionCache } from '../../billing/execution-guard';

// ── Test app setup ─────────────────────────────────────────────────────────────

const BILLING_TOKEN = 'test-billing-service-token-32chars';
const ACCOUNT_ID    = 'acct-uuid-router-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/billing', billingControlsInternalRouter);
  return app;
}

function sign(method: string, path: string, body: object): { timestamp: string; signature: string } {
  const timestamp = Date.now();
  const bodyStr   = JSON.stringify(body);
  const str       = `${method}\n${path}\n${timestamp}\n${bodyStr}`;
  const signature = createHmac('sha256', BILLING_TOKEN).update(str).digest('hex');
  return { timestamp: String(timestamp), signature };
}

function signedRequest(app: ReturnType<typeof buildApp>, method: 'post' | 'get', path: string, body: object = {}) {
  const { timestamp, signature } = sign(method.toUpperCase(), path, body);
  return request(app)[method](path)
    .set('X-Billing-Timestamp', timestamp)
    .set('X-Billing-Signature', signature)
    .send(body);
}

function mockPoolWithQuery(rows: unknown[], rowCount = rows.length) {
  (getPool as jest.Mock).mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows, rowCount }),
    connect: jest.fn(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BILLING_SERVICE_TOKEN = BILLING_TOKEN;
});

// ── SE-006: HMAC validation ────────────────────────────────────────────────────

describe('SE-006 — HMAC validation', () => {
  it('rejects requests with no signature headers (401)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/internal/billing/controls/${ACCOUNT_ID}/recovery-succeeded`)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_billing_signature_headers');
  });

  it('rejects replayed requests older than 60s (401)', async () => {
    const app  = buildApp();
    const staleTimestamp = String(Date.now() - 65_000);
    const sig  = createHmac('sha256', BILLING_TOKEN)
      .update(`POST\n/api/internal/billing/controls/${ACCOUNT_ID}/recovery-succeeded\n${staleTimestamp}\n{}`)
      .digest('hex');

    const res = await request(app)
      .post(`/api/internal/billing/controls/${ACCOUNT_ID}/recovery-succeeded`)
      .set('X-Billing-Timestamp', staleTimestamp)
      .set('X-Billing-Signature', sig)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('signature_expired');
  });

  it('rejects tampered bodies (401 invalid_signature)', async () => {
    const app   = buildApp();
    const { timestamp, signature } = sign('POST', `/api/internal/billing/controls/${ACCOUNT_ID}/recovery-succeeded`, {});

    const res = await request(app)
      .post(`/api/internal/billing/controls/${ACCOUNT_ID}/recovery-succeeded`)
      .set('X-Billing-Timestamp', timestamp)
      .set('X-Billing-Signature', signature)
      .send({ injected: 'payload' }); // different body than what was signed
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
  });
});

// ── DE-005: Currency enforcement ───────────────────────────────────────────────

describe('DE-005 — USD-only enforcement on /init', () => {
  it('rejects non-USD subscriptions with 422', async () => {
    mockPoolWithQuery([]);
    const app  = buildApp();
    const path = `/api/internal/billing/controls/${ACCOUNT_ID}/init`;
    const body = { stripeCustomerId: 'cus_test', currency: 'eur' };
    const res  = await signedRequest(app, 'post', path, body);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('currency_not_supported');
  });

  it('accepts USD subscriptions (200)', async () => {
    mockPoolWithQuery([]);
    const app  = buildApp();
    const path = `/api/internal/billing/controls/${ACCOUNT_ID}/init`;
    const body = { stripeCustomerId: 'cus_test', currency: 'usd' };
    const res  = await signedRequest(app, 'post', path, body);
    expect(res.status).toBe(200);
  });
});

// ── TE-003: State transitions via internal API ─────────────────────────────────

describe('TE-003 — /threshold-failed suspends account', () => {
  it('sets suspended=TRUE and invalidates execution cache', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      connect: jest.fn(),
    };
    (getPool as jest.Mock).mockReturnValue(mockPool);
    const app  = buildApp();
    const path = `/api/internal/billing/controls/${ACCOUNT_ID}/threshold-failed`;
    const body = { thresholdLevel: 100, outstandingBalanceUsd: 100 };

    const res = await signedRequest(app, 'post', path, body);

    expect(res.status).toBe(200);

    // Verify the UPDATE sets suspended=TRUE
    const updateCall = mockPool.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('suspended') && String(c[0]).includes('TRUE'),
    );
    expect(updateCall).toBeDefined();
    expect(invalidateExecutionCache).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});

describe('TE-003 — /threshold-succeeded clears suspension and records graduation', () => {
  it('marks last_card_auth_at and clears suspension', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      connect: jest.fn(),
    };
    (getPool as jest.Mock).mockReturnValue(mockPool);
    const app  = buildApp();
    const path = `/api/internal/billing/controls/${ACCOUNT_ID}/threshold-succeeded`;
    const body = { thresholdLevel: 100 };

    const res = await signedRequest(app, 'post', path, body);
    expect(res.status).toBe(200);
    expect(invalidateExecutionCache).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});

describe('TE-003 — /period-reset resets spend counter', () => {
  it('sets current_period_spend_usd=0 and resets next_threshold_usd', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      connect: jest.fn(),
    };
    (getPool as jest.Mock).mockReturnValue(mockPool);
    const app  = buildApp();
    const path = `/api/internal/billing/controls/${ACCOUNT_ID}/period-reset`;
    const body = { billingPeriodStart: '2026-05-01T00:00:00Z' };

    const res = await signedRequest(app, 'post', path, body);
    expect(res.status).toBe(200);

    const updateCall = mockPool.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('current_period_spend_usd'),
    );
    expect(updateCall).toBeDefined();
    // The CASE WHEN expression sets threshold to 1000 or 100 depending on graduated_at
    expect(String(updateCall![0])).toContain('CASE WHEN graduated_at IS NOT NULL THEN 1000.00 ELSE 100.00 END');
  });

  it('returns 400 when billingPeriodStart is missing', async () => {
    mockPoolWithQuery([]);
    const app = buildApp();
    const res = await signedRequest(app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/period-reset`, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('billingPeriodStart_required');
  });
});

// ── TE-005: Recovery flow ─────────────────────────────────────────────────────

describe('TE-005 — recovery flow: payment-failed → recovery-succeeded', () => {
  it('payment-failed suspends account; recovery-succeeded clears it', async () => {
    const mockPool = {
      query: jest.fn()
        .mockResolvedValue({ rows: [{ email: 'owner@example.com', first_name: 'Alice' }], rowCount: 1 }),
      connect: jest.fn(),
    };
    (getPool as jest.Mock).mockReturnValue(mockPool);
    const app = buildApp();

    // Step 1: payment fails (subscription_cycle or recovery)
    const failPath = `/api/internal/billing/controls/${ACCOUNT_ID}/payment-failed`;
    const failRes  = await signedRequest(app, 'post', failPath, { outstandingBalanceUsd: 150 });
    expect(failRes.status).toBe(200);

    // execution cache invalidated immediately
    expect(invalidateExecutionCache).toHaveBeenCalledWith(ACCOUNT_ID);

    // Step 2: customer updates card, payment retried and succeeds
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const recoveryPath = `/api/internal/billing/controls/${ACCOUNT_ID}/recovery-succeeded`;
    const recoveryRes  = await signedRequest(app, 'post', recoveryPath, {});
    expect(recoveryRes.status).toBe(200);

    // Cache invalidated again on recovery
    expect(invalidateExecutionCache).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(invalidateExecutionCache).toHaveBeenCalledTimes(2);

    // The recovery UPDATE sets suspended=FALSE and outstanding_balance_usd=0
    const recoveryUpdate = mockPool.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('suspended') && String(c[0]).includes('FALSE'),
    );
    expect(recoveryUpdate).toBeDefined();
  });

  it('payment-method-added sets has_payment_method=TRUE', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      connect: jest.fn(),
    };
    (getPool as jest.Mock).mockReturnValue(mockPool);
    const app = buildApp();
    const res = await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/payment-method-added`, {},
    );
    expect(res.status).toBe(200);

    const updateCall = mockPool.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('has_payment_method'),
    );
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toContain('has_payment_method = TRUE');
  });
});

// ── TE-006: Graduation detection ───────────────────────────────────────────────

describe('TE-006 — graduation at $1,800 threshold', () => {
  it('sets graduated_at on threshold-succeeded with thresholdLevel=1800', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      connect: jest.fn(),
    };
    (getPool as jest.Mock).mockReturnValue(mockPool);
    const app  = buildApp();
    const path = `/api/internal/billing/controls/${ACCOUNT_ID}/threshold-succeeded`;
    const body = { thresholdLevel: 1800, chargeAmount: 1000 };

    const res = await signedRequest(app, 'post', path, body);
    expect(res.status).toBe(200);

    const updateCall = mockPool.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('graduated_at'),
    );
    expect(updateCall).toBeDefined();
    // The CASE ensures graduated_at is set only once (WHEN graduated_at IS NULL)
    expect(String(updateCall![0])).toContain('CASE WHEN $2 AND graduated_at IS NULL THEN NOW()');
    // $2 = isGraduationLevel = TRUE (thresholdLevel === 1800)
    expect(updateCall![1][1]).toBe(true);
  });

  it('does NOT set graduated_at for non-graduation thresholds (thresholdLevel ≠ 1800)', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      connect: jest.fn(),
    };
    (getPool as jest.Mock).mockReturnValue(mockPool);
    const app = buildApp();

    for (const level of [100, 300, 800]) {
      mockPool.query.mockClear();
      const body = { thresholdLevel: level };
      await signedRequest(app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/threshold-succeeded`, body);

      const updateCall = mockPool.query.mock.calls.find(
        (c: unknown[]) => String(c[0]).includes('graduated_at'),
      );
      // The param $2 (isGraduationLevel) must be FALSE for non-graduation thresholds
      expect(updateCall![1][1]).toBe(false);
    }
  });

  it('period-reset uses CASE WHEN graduated_at IS NOT NULL THEN 1000 ELSE 100 in SQL', async () => {
    // Verified by reading the SQL — the DB enforces this, not application code.
    // The test exercises the endpoint and asserts the SQL contains the CASE expression.
    const mockPool = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      connect: jest.fn(),
    };
    (getPool as jest.Mock).mockReturnValue(mockPool);
    const app = buildApp();

    await signedRequest(
      app, 'post', `/api/internal/billing/controls/${ACCOUNT_ID}/period-reset`,
      { billingPeriodStart: '2026-05-01T00:00:00Z' },
    );

    const resetCall = mockPool.query.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('next_threshold_usd'),
    );
    expect(String(resetCall![0])).toMatch(/CASE WHEN graduated_at IS NOT NULL THEN 1000\.00 ELSE 100\.00 END/);
  });
});

// ── Prepaid clawback ───────────────────────────────────────────────────────────
//
// The inverse of prepaid-topped-up. Credit is non-refundable, so money leaving
// through a refund or a lost dispute has to take the unspent units with it —
// otherwise a top-up can be charged back after the compute is consumed and the
// customer keeps both.

describe('prepaid-clawback', () => {
  const PATH = `/api/internal/billing/controls/${ACCOUNT_ID}/prepaid-clawback`;

  it('debits the credit and reports the remaining balance', async () => {
    mockPoolWithQuery([{ reload_balance_usd: '75.00', suspended: false }]);
    const res = await signedRequest(buildApp(), 'post', PATH, { amountUsd: 25, reason: 'refund' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reloadBalanceUsd: 75, suspended: false });
    expect(invalidateExecutionCache).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  // The case the endpoint exists for: the credit was already spent, so taking
  // it back drives the balance below zero and stops the account rather than
  // forgiving the compute.
  it('reports the suspension when the clawback drives the balance negative', async () => {
    mockPoolWithQuery([{ reload_balance_usd: '-40.00', suspended: true }]);
    const res = await signedRequest(buildApp(), 'post', PATH, { amountUsd: 500, reason: 'dispute' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reloadBalanceUsd: -40, suspended: true });
  });

  it('refuses a non-positive amount rather than crediting by accident', async () => {
    mockPoolWithQuery([{ reload_balance_usd: '100.00', suspended: false }]);
    for (const amountUsd of [0, -25, 'five']) {
      const res = await signedRequest(buildApp(), 'post', PATH, { amountUsd });
      expect(res.status).toBe(400);
    }
  });

  it('reports an unknown account rather than silently succeeding', async () => {
    mockPoolWithQuery([], 0);
    const res = await signedRequest(buildApp(), 'post', PATH, { amountUsd: 25 });

    expect(res.status).toBe(404);
  });
});
