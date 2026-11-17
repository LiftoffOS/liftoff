// Phase 0 + pre-pay: Billing Controls Internal Router
//
// Internal API for liftoff-billing → platform-backend state mutations.
// All endpoints authenticated with per-request HMAC-SHA256 signing:
//   X-Billing-Timestamp: unix epoch milliseconds
//   X-Billing-Signature: HMAC-SHA256(method + '\n' + path + '\n' + timestamp + '\n' + body)
//
// Replay window: 60 seconds (signatures older than 60s are rejected).
//
// Endpoints (called by liftoff-billing Stripe event processor):
//   POST /api/internal/billing/controls/:accountId/init
//   POST /api/internal/billing/controls/:accountId/threshold-succeeded
//   POST /api/internal/billing/controls/:accountId/threshold-failed
//   POST /api/internal/billing/controls/:accountId/recovery-succeeded
//   POST /api/internal/billing/controls/:accountId/period-reset
//   POST /api/internal/billing/controls/:accountId/prepaid-topped-up
//   POST /api/internal/billing/controls/:accountId/auto-reload-failed
//   POST /api/internal/billing/controls/:accountId/subscription-activated
//   POST /api/internal/billing/controls/:accountId/subscription-cancelled
//   POST /api/internal/billing/controls/:accountId/payment-failed
//   POST /api/internal/billing/controls/:accountId/payment-method-added
//   PUT  /api/internal/billing/controls/by-tenant/:tenantId/auto-reload-settings
//   GET  /api/internal/billing/controls/by-tenant/:tenantId/auto-reload-settings
//   POST /api/internal/billing/subscription-items/sync
//   POST /api/internal/billing/entitlements/:accountId/activate
//   POST /api/internal/billing/entitlements/:accountId/deactivate
//   POST /api/internal/billing/threshold-check   (called by Cloud Tasks)
//   GET  /api/internal/billing/controls/:accountId/status  (called by liftoff-billing current-usage)
//   POST /api/internal/billing/tenants/:tenantId/operating-units (called by liftoff-billing current-usage)

import { createHmac, timingSafeEqual } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible';
import { getPool, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { fireOuMeterEvent } from './ou-meter-event';
import { runThresholdCheck } from './threshold-charge-service';
import { invalidateExecutionCache } from './execution-guard';
import { getOperatingUnitsForPeriod } from './operating-unit-service';
import { syncSubscriptionItems, updatePlatformFeeQuantity } from './subscription-items-service';
import { activateAddon, deactivateAddon } from './addon-service';
import { getBillingAdminClient } from './billing-admin-client';
import {
  sendPaymentFailedEmail,
  sendSubscriptionConfirmationEmail,
  sendSubscriptionEndingEmail,
  sendSubscriptionEndedEmail,
  sendReceiptEmail,
  sendCardExpiringEmail,
} from '../infrastructure/email';
import { doPeriodReset } from '../jobs/annual-plan-allocation-reset';
import { composePlanDisplay, STANDARD_PLAN_JOIN_SQL, type PlanRow } from './plan-display';
import { EntitlementService } from '../entitlements/service';
import { publishBillingSuspensionChange } from './billing-suspension-publisher';

const entitlementService = new EntitlementService();

const BACKFILL_BATCH_LIMIT = 500;

async function backfillUnmeteredSpendEvents(accountId: string, stripeCustomerId: string): Promise<void> {
  // billing_spend_events is RLS-on (migration 200). This routine is the
  // billing-init flow: an internal endpoint keyed by accountId (not tenant)
  // that backfills meter events to Stripe for ALL tenants under the account.
  // It legitimately reads across tenants — admin scope is correct. Query is
  // naturally bound by account_id so admin bypass exposes only this account's
  // rows.
  const { rows } = await withAdminScope(
    {
      caller: 'billing.backfillUnmeteredSpendEvents',
      reason: 'internal billing-init: backfill spend events across an account',
      actor: `account:${accountId}`,
    },
    (client) =>
      client.query<{ invocation_id: string; cost_usd: string; processed_at: Date }>(
        `SELECT invocation_id, cost_usd, processed_at
         FROM billing_spend_events
         WHERE account_id = $1 AND stripe_metered_at IS NULL
         ORDER BY processed_at ASC
         LIMIT $2`,
        [accountId, BACKFILL_BATCH_LIMIT],
      ),
  );
  if (rows.length === 0) return;

  if (rows.length === BACKFILL_BATCH_LIMIT) {
    log.warn({ accountId }, 'billing.init: backfill truncated at 500 events — run backfill script for full history');
  }

  let metered = 0;
  for (const row of rows) {
    const ok = await fireOuMeterEvent({
      stripeCustomerId,
      costUsd: parseFloat(row.cost_usd),
      identifier: row.invocation_id,
      occurredAt: row.processed_at,
    });
    // If Stripe rejects (rate-limit, network), skip the mark-metered update so
    // the next backfill pass retries this row. Other rows in the batch still
    // get tried — Stripe's per-identifier idempotency makes per-row retries
    // safe.
    if (!ok) continue;
    await withAdminScope(
      {
        caller: 'billing.backfillUnmeteredSpendEvents.markMetered',
        reason: 'mark spend event as billed to Stripe',
        actor: `account:${accountId}`,
      },
      (client) =>
        client.query(
          `UPDATE billing_spend_events SET stripe_metered_at = NOW() WHERE invocation_id = $1`,
          [row.invocation_id],
        ),
    );
    metered++;
  }
  log.info({ accountId, total: rows.length, metered }, 'billing.init: backfilled unmetered spend events');
}

const router = Router();

// Rate limiter: 10 calls/minute per accountId — Postgres-backed so all Cloud Run
// instances share state. Prevents replay-flood across horizontal scale-out.
let _rateLimiter: RateLimiterPostgres | null = null;
function getRateLimiter(): RateLimiterPostgres {
  if (!_rateLimiter) {
    _rateLimiter = new RateLimiterPostgres({
      storeClient:  getPool(),
      points:       120,
      duration:     60,
      tableName:    'rate_limiter_billing_internal',
      tableCreated: true,
    });
  }
  return _rateLimiter;
}

// ── Payment failure notification helper ───────────────────────────────────────

async function notifyPaymentFailed(
  accountId: string,
  context: 'subscription_renewal' | 'auto_reload',
  params: {
    outstandingBalanceUsd?: number;
    amountUsd?: number;
    paymentMethodType?: 'card' | 'us_bank_account';
    paymentMethodLast4?: string;
  },
): Promise<void> {
  const pool = getPool();
  // Look up the primary contact email for this account (accounts.id = billing_controls.account_id)
  const row = await pool.query<{ email: string; first_name: string }>(
    `SELECT email, first_name FROM accounts WHERE id = $1`,
    [accountId],
  );
  if (row.rows.length === 0) {
    log.warn({ accountId }, 'billing.notify: no account found for payment failure notification');
    return;
  }
  const { email, first_name: firstName } = row.rows[0];
  await sendPaymentFailedEmail(email, firstName ?? 'there', context, params).catch((err: Error) =>
    log.warn({ error: err.message, accountId, context }, 'billing.notify: sendPaymentFailedEmail failed (non-fatal)'),
  );

  // Slack webhook alert (best-effort)
  const slackUrl = process.env.SLACK_BILLING_WEBHOOK_URL;
  if (slackUrl) {
    const slackAmount = params.outstandingBalanceUsd ?? params.amountUsd ?? 0;
    fetch(slackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `:warning: *Payment failed* (${context}) — account \`${accountId}\` amount $${slackAmount.toFixed(2)}. Agents suspended.`,
      }),
    }).catch((err: Error) => log.warn({ error: err.message, accountId }, 'billing.notify: slack webhook failed (non-fatal)'));
  }
}

// ── Subscription lifecycle notification helpers ───────────────────────────────
// Each helper does the standard JOIN itself (accounts + billing_controls +
// plan_catalog + enterprise_contracts) so trigger sites only need to pass
// event-specific context.

async function notifySubscriptionConfirmation(
  accountId: string,
  ctx: {
    isAnnualPlan: boolean;
    stripePeriodEnd: string | undefined;
    promoApplied?: { amountOffUsd: number; firstInvoiceTotalUsd: number };
  },
): Promise<void> {
  const { rows } = await getPool().query<PlanRow>(STANDARD_PLAN_JOIN_SQL, [accountId]);
  if (!rows[0]) return;
  const r = rows[0];
  const { planName, planPriceUsd } = composePlanDisplay(r);
  const monthlyAllocationOus = Number(r.plan_included_ous);
  await sendSubscriptionConfirmationEmail(r.email, r.first_name ?? 'there', {
    planName,
    monthlyAllocationOus,
    planPriceUsd,
    billingPeriod: ctx.isAnnualPlan ? 'year' : 'month',
    nextRenewalDate: ctx.stripePeriodEnd ? new Date(ctx.stripePeriodEnd) : new Date(Date.now() + 30 * 86400 * 1000),
    promoApplied: ctx.promoApplied,
  }).catch((err: Error) =>
    log.warn({ error: err.message, accountId }, 'sendSubscriptionConfirmationEmail failed (non-fatal)'),
  );
}

async function notifySubscriptionEnding(
  accountId: string,
  ctx: { accessEndsDate: Date },
): Promise<void> {
  const { rows } = await getPool().query<PlanRow>(STANDARD_PLAN_JOIN_SQL, [accountId]);
  if (!rows[0]) return;
  const r = rows[0];
  const { planName } = composePlanDisplay(r);
  await sendSubscriptionEndingEmail(r.email, r.first_name ?? 'there', {
    planName,
    accessEndsDate: ctx.accessEndsDate,
  }).catch((err: Error) =>
    log.warn({ error: err.message, accountId }, 'sendSubscriptionEndingEmail failed (non-fatal)'),
  );
}

async function notifyCardExpiring(
  accountId: string,
  ctx: { cardBrand: string; cardLast4: string; cardExpMonth: string; cardExpYear: string },
): Promise<void> {
  const pool = getPool();
  const row = await pool.query<{ email: string; first_name: string | null }>(
    `SELECT email, first_name FROM accounts WHERE id = $1`,
    [accountId],
  );
  if (row.rows.length === 0) {
    log.warn({ accountId }, 'billing.notify: no account found for card-expiring notification');
    return;
  }
  const { email, first_name: firstName } = row.rows[0];
  await sendCardExpiringEmail(email, firstName ?? 'there', ctx).catch((err: Error) =>
    log.warn({ error: err.message, accountId }, 'sendCardExpiringEmail failed (non-fatal)'),
  );
}

async function notifyReceipt(
  accountId: string,
  ctx: {
    context: 'subscription_renewal' | 'credit_reload';
    amountUsd: number;
    paymentMethodType: 'card' | 'us_bank_account';
    paymentMethodLast4: string;
  },
): Promise<void> {
  const { rows } = await getPool().query<PlanRow>(STANDARD_PLAN_JOIN_SQL, [accountId]);
  if (!rows[0]) return;
  const r = rows[0];
  const params: Parameters<typeof sendReceiptEmail>[3] = {
    amountUsd: ctx.amountUsd,
    paymentMethodType: ctx.paymentMethodType,
    paymentMethodLast4: ctx.paymentMethodLast4,
  };
  if (ctx.context === 'subscription_renewal') {
    const { planName } = composePlanDisplay(r);
    params.planName = planName;
    params.billingPeriod = r.is_annual_plan ? 'year' : 'month';
  }
  await sendReceiptEmail(r.email, r.first_name ?? 'there', ctx.context, params).catch((err: Error) =>
    log.warn({ error: err.message, accountId, receiptContext: ctx.context }, 'sendReceiptEmail failed (non-fatal)'),
  );
}

async function notifySubscriptionEnded(
  accountId: string,
  ctx: { accessEndedDate: Date },
): Promise<void> {
  const { rows } = await getPool().query<PlanRow>(STANDARD_PLAN_JOIN_SQL, [accountId]);
  if (!rows[0]) return;
  const r = rows[0];
  const { planName } = composePlanDisplay(r);
  await sendSubscriptionEndedEmail(r.email, r.first_name ?? 'there', {
    planName,
    accessEndedDate: ctx.accessEndedDate,
  }).catch((err: Error) =>
    log.warn({ error: err.message, accountId }, 'sendSubscriptionEndedEmail failed (non-fatal)'),
  );
}

// ── HMAC Middleware ────────────────────────────────────────────────────────────

// Exported so the referral programme's internal router authenticates the same
// way rather than growing a second copy of this. One implementation means one
// signing convention: a drift between two of them would show up as a 401 on
// exactly one endpoint, which is the kind of thing nobody finds for a month.
export function validateBillingHmac(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.BILLING_SERVICE_TOKEN;
  if (!token) {
    log.error({}, 'billing.internal: BILLING_SERVICE_TOKEN not configured');
    res.status(503).json({ error: 'misconfigured' });
    return;
  }

  const timestampHeader = req.headers['x-billing-timestamp'] as string | undefined;
  const signatureHeader = req.headers['x-billing-signature'] as string | undefined;

  if (!timestampHeader || !signatureHeader) {
    res.status(401).json({ error: 'missing_billing_signature_headers' });
    return;
  }

  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp) || Math.abs(Date.now() - timestamp) > 60_000) {
    res.status(401).json({ error: 'signature_expired' });
    return;
  }

  // Reconstruct body string for HMAC. Raw body is in req.body (already parsed JSON).
  // Use req.originalUrl (full path, no query string) so the signing convention is
  // consistent with outbound calls that use the full absolute path.
  const bodyStr = JSON.stringify(req.body ?? {});
  const signingString = `${req.method}\n${req.originalUrl.split('?')[0]}\n${timestamp}\n${bodyStr}`;
  const expected = createHmac('sha256', token).update(signingString).digest('hex');

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    log.warn({ path: req.path }, 'billing.internal: invalid HMAC signature');
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  next();
}

// Per-accountId rate limiter middleware (skips for non-account routes)
async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const accountId = req.params.accountId ?? 'global';
  try {
    await getRateLimiter().consume(`billing-internal:${accountId}`, 1);
    next();
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      log.warn({ accountId, path: req.path }, 'billing.internal: rate limit exceeded');
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next(err);
  }
}

// Apply HMAC validation to all routes in this router
router.use(validateBillingHmac);

// ── Stripe customer ID → account ID resolution ─────────────────────────────────
// liftoff-billing knows Stripe customer IDs (cus_xxx), not platform-backend
// account UUIDs. This param middleware transparently resolves cus_xxx to the
// actual account_id before any route handler sees it.
//
// Resolution order:
//   1. billing_controls.stripe_customer_id (works after init has been called).
//   2. tenants.account_id via body.tenantId (fallback for the init call itself,
//      where the billing_controls row may not exist yet).
//   3. (PR 2a — Gap F) tenants.account_id via body.metadata.tenant_id. PR 2b's
//      stripe-event-processor forwards sub.metadata.tenant_id under this path
//      so we can still resolve when billing_controls has lost track of the
//      Stripe customer (orphan-customer scenario).
//
// Cross-account safety: when the primary billing_controls lookup succeeds AND
// the body also carries metadata.tenant_id, we verify the metadata's tenant
// resolves to the same account_id. Mismatch → 409 (cross-account contamination
// — likely a spoofed or stale body).
//
// When all paths miss, we log `billing.internal.orphan_customer_no_resolution`
// at ERROR severity (escalated from no-log) and return 404. The
// `billing.internal.orphan_customer_*` log family is the operator's signal that
// PR 2a's safety nets are doing useful work; a quiet 404 hides the failure.
router.param('accountId', (req: Request, res: Response, next: NextFunction, accountId: string) => {
  if (!accountId.startsWith('cus_')) {
    next();
    return;
  }
  const pool = getPool();
  const stripeCustomerId = accountId;
  // Preserve the pre-resolution Stripe customer id for handlers that need to
  // know WHICH customer the webhook was about (e.g. /subscription-cancelled
  // verifies it against billing_controls.stripe_customer_id before
  // suspending). After this middleware runs, req.params.accountId only holds
  // the resolved account UUID and the original cus_ id is otherwise lost.
  res.locals.stripeCustomerIdFromPath = stripeCustomerId;
  (async () => {
    // 1. Primary path.
    const bcResult = await pool.query<{ account_id: string }>(
      `SELECT account_id FROM billing_controls WHERE stripe_customer_id = $1`,
      [stripeCustomerId],
    );

    // metadata.tenant_id (PR 2b populates this) — used both as a tertiary
    // resolution path AND as a cross-account safety check on the primary path.
    const metadataTenantId =
      (req.body?.metadata?.tenant_id as string | null | undefined) ?? undefined;

    if (bcResult.rows[0]) {
      const resolved = bcResult.rows[0].account_id;
      if (metadataTenantId) {
        const tenantResult = await pool.query<{ account_id: string }>(
          `SELECT account_id FROM tenants WHERE id = $1`,
          [metadataTenantId],
        );
        const metadataAccountId = tenantResult.rows[0]?.account_id ?? null;
        if (metadataAccountId && metadataAccountId !== resolved) {
          log.error(
            {
              stripeCustomerId,
              path: req.originalUrl,
              resolvedFromBillingControls: resolved,
              resolvedFromMetadataTenantId: metadataAccountId,
              metadataTenantId,
            },
            'billing.internal.orphan_customer_cross_account_mismatch',
          );
          res.status(409).json({ error: 'cross_account_metadata_mismatch' });
          return;
        }
      }
      req.params.accountId = resolved;
      next();
      return;
    }

    // 2. Fallback A: body.tenantId (existing).
    const bodyTenantId = req.body?.tenantId as string | undefined;
    if (bodyTenantId) {
      const tenantResult = await pool.query<{ account_id: string }>(
        `SELECT account_id FROM tenants WHERE id = $1`,
        [bodyTenantId],
      );
      if (tenantResult.rows[0]) {
        req.params.accountId = tenantResult.rows[0].account_id;
        next();
        return;
      }
    }

    // 3. Fallback B (PR 2a): body.metadata.tenant_id.
    if (metadataTenantId) {
      const tenantResult = await pool.query<{ account_id: string }>(
        `SELECT account_id FROM tenants WHERE id = $1`,
        [metadataTenantId],
      );
      if (tenantResult.rows[0]) {
        req.params.accountId = tenantResult.rows[0].account_id;
        next();
        return;
      }
    }

    // All paths miss — orphan customer with no recoverable tenant hint.
    log.error(
      {
        stripeCustomerId,
        path: req.originalUrl,
        body: req.body,
      },
      'billing.internal.orphan_customer_no_resolution',
    );
    res.status(404).json({ error: 'account_not_found_for_customer' });
  })().catch(next);
});

// ── Endpoint: GET /customers ──────────────────────────────────────────────────
// Full billing_controls customer→pointer listing. Consumed by liftoff-billing's
// daily subscription reconciliation so its sweep also covers Stripe customers
// that have no row in billing's local subscriptions table (e.g. a customer the
// account was re-provisioned away from) — a blind spot in which a stale
// subscription could otherwise bill unseen.

router.get('/customers', rateLimit, async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const { rows } = await pool.query<{
    account_id: string;
    stripe_customer_id: string;
    stripe_subscription_id: string | null;
    suspended: boolean;
  }>(
    `SELECT account_id, stripe_customer_id, stripe_subscription_id, suspended
       FROM billing_controls WHERE stripe_customer_id IS NOT NULL`,
  );
  res.status(200).json({
    customers: rows.map((r) => ({
      accountId: r.account_id,
      stripeCustomerId: r.stripe_customer_id,
      stripeSubscriptionId: r.stripe_subscription_id ?? null,
      // A suspended account's pointer legitimately references its dead sub —
      // the reconciliation pointer check skips those instead of alerting on
      // every churned account daily.
      suspended: r.suspended,
    })),
  });
});

// ── Endpoint: /init ────────────────────────────────────────────────────────────
// Called by customer.subscription.created webhook.
// Creates the billing_controls row if it doesn't exist yet.

router.post('/controls/:accountId/init', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { stripeCustomerId, billingPeriodStart, stripeSubscriptionId, stripePeriodStart, billingTier, currency, billingMode } = req.body;

  // Currency enforcement (DE-005): only USD is supported until FX handling ships.
  if (currency && currency !== 'usd') {
    log.warn({ accountId, currency }, 'billing.controls.init: non-USD currency rejected');
    res.status(422).json({
      error: 'currency_not_supported',
      message: `Non-USD subscriptions are not supported (currency: ${currency}).`,
    });
    return;
  }

  // Resolve billing mode in priority order:
  //   1. billingMode field in the request body (explicit override — e.g. post_pay)
  //   2. BILLING_DEFAULT_MODE env var
  //   3. 'pre_pay' if env var is unset — matches subscription-activated, which
  //      forcibly sets billing_mode='pre_pay' for every self-serve and enterprise
  //      subscription. Any other default leaves the row in a transient state that
  //      contradicts the activated subscription.
  const defaultMode = (process.env.BILLING_DEFAULT_MODE ?? 'pre_pay') as 'pre_pay' | 'post_pay';
  const resolvedMode = (billingMode ?? defaultMode) as 'pre_pay' | 'post_pay';
  // Pre-pay accounts start suspended (balance = 0 until funded)
  const startSuspended = resolvedMode === 'pre_pay';

  const pool = getPool();

  // Pre-read: detect first-time stripe_customer_id assignment to trigger backfill
  const before = await pool.query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM billing_controls WHERE account_id = $1`,
    [accountId],
  );
  const wasUnset = !before.rows[0]?.stripe_customer_id;

  await pool.query(
    `INSERT INTO billing_controls
       (account_id, stripe_customer_id, billing_period_start, stripe_subscription_id, stripe_period_start, billing_tier, currency, billing_mode, suspended, billing_exempt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             COALESCE((SELECT is_internal FROM accounts WHERE id = $1), FALSE))
     ON CONFLICT (account_id) DO UPDATE
       SET stripe_customer_id     = COALESCE(EXCLUDED.stripe_customer_id, billing_controls.stripe_customer_id),
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           stripe_period_start    = EXCLUDED.stripe_period_start,
           billing_period_start   = EXCLUDED.billing_period_start,
           billing_tier           = COALESCE(EXCLUDED.billing_tier, billing_controls.billing_tier),
           currency               = COALESCE(EXCLUDED.currency, billing_controls.currency),
           updated_at             = NOW()
           -- NOTE: billing_mode, suspended and billing_exempt are intentionally NOT in the
           -- ON CONFLICT SET clause. Re-init calls (e.g. subscription reactivation) must not
           -- reset mode, suspension state, or an exemption an operator set by hand.`,
    [
      accountId,
      stripeCustomerId ?? null,
      billingPeriodStart ? new Date(billingPeriodStart) : new Date(),
      stripeSubscriptionId ?? null,
      stripePeriodStart ? new Date(stripePeriodStart) : null,
      billingTier ?? 'standard',
      currency ?? 'usd',
      resolvedMode,
      startSuspended,
    ],
  );

  // Backfill unmetered spend events when stripe_customer_id is set for the first time.
  // Fires for both new workspaces (Phase 1) and existing tenants backfilled via Phase 6 script.
  if (wasUnset && stripeCustomerId) {
    void backfillUnmeteredSpendEvents(accountId, stripeCustomerId as string).catch((err: Error) =>
      log.warn({ accountId, error: err.message }, 'billing.init: backfill failed'),
    );
  }

  log.info({ accountId, resolvedMode }, 'billing.controls: init');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /threshold-succeeded ────────────────────────────────────────────
// Called by invoice.payment_succeeded (threshold type).
// Marks last_card_auth_at, optionally sets graduated_at (at $1,800 level).

router.post('/controls/:accountId/threshold-succeeded', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  // prepaidBalanceUsd was a USD-allocation field (dropped in Migration B). Any
  // legacy callers still sending it are silently ignored — billing wallets
  // are tracked exclusively via reload_balance_usd now.
  const { thresholdLevel, chargeAmount } = req.body;

  const isGraduationLevel = String(thresholdLevel) === '1800';

  const pool = getPool();
  // Also clears suspension if set — handles the recovery-after-failure scenario
  // transparently. If the account was not suspended, the outstanding_balance reset
  // is a no-op (0 = 0).
  await pool.query(
    `UPDATE billing_controls
     SET last_card_auth_at                  = NOW(),
         graduated_at                       = CASE WHEN $2 AND graduated_at IS NULL THEN NOW() ELSE graduated_at END,
         suspended                          = FALSE,
         suspended_reason                   = NULL,
         outstanding_balance_usd            = CASE WHEN suspended THEN 0 ELSE outstanding_balance_usd END,
         last_charge_failed_at              = NULL,
         threshold_charges_collected_usd    = threshold_charges_collected_usd + COALESCE($3, 0),
         updated_at                         = NOW()
     WHERE account_id = $1`,
    [accountId, isGraduationLevel, chargeAmount ?? null],
  );

  // Clear execution cache in case account was previously suspended
  invalidateExecutionCache(accountId);

  log.info({ accountId, thresholdLevel, isGraduationLevel }, 'billing.controls: threshold-succeeded');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /threshold-failed ───────────────────────────────────────────────
// Called by invoice.payment_failed.
// Suspends the account and records the outstanding balance.

router.post('/controls/:accountId/threshold-failed', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { thresholdLevel, outstandingBalanceUsd } = req.body;

  const pool = getPool();
  await pool.query(
    `UPDATE billing_controls
     SET outstanding_balance_usd = GREATEST(outstanding_balance_usd, $2),
         suspended               = TRUE,
         suspended_reason        = 'payment_failed',
         last_charge_failed_at   = NOW(),
         next_threshold_usd      = $3,
         updated_at              = NOW()
     WHERE account_id = $1`,
    [accountId, outstandingBalanceUsd ?? 0, thresholdLevel ?? 100],
  );

  // Invalidate execution cache so agents stop immediately, and tell every
  // tenant under the account so the runtime's gates refuse in seconds.
  invalidateExecutionCache(accountId);
  void publishBillingSuspensionChange(accountId, 'suspended', 'payment_failed');
  // Threshold-based billing is being phased out in favor of pre-pay; no user
  // email is sent for threshold failures. The account is still suspended via
  // the UPDATE above, and Slack alerting/manual recovery via CS continues.

  log.warn({ accountId, thresholdLevel, outstandingBalanceUsd }, 'billing.controls: threshold-failed — account suspended');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /recovery-succeeded ─────────────────────────────────────────────
// Called by invoice.payment_succeeded (recovery type, after prior failure).
// Clears suspension and outstanding balance.

router.post('/controls/:accountId/recovery-succeeded', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;

  const pool = getPool();
  await pool.query(
    `UPDATE billing_controls
     SET suspended               = FALSE,
         suspended_reason        = NULL,
         outstanding_balance_usd = 0,
         last_card_auth_at       = NOW(),
         updated_at              = NOW()
     WHERE account_id = $1`,
    [accountId],
  );

  // Execution cache doesn't cache suspended=TRUE, but invalidate anyway to clear
  // any stale state from before the suspension event was processed.
  invalidateExecutionCache(accountId);
  void publishBillingSuspensionChange(accountId, 'unsuspended', 'recovery_succeeded');

  log.info({ accountId }, 'billing.controls: recovery-succeeded — account unsuspended');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /admin/unsuspend-by-workspace (DEV ONLY) ──────────────────────────
// Manual admin endpoint to unsuspend an account by workspace ID.
// Used in test-mode environments to recover accounts after Stripe's test-mode 90-day data retention.
// Production should never need this — it can only occur in test mode.
// Requires BILLING_SERVICE_TOKEN authentication (same as other internal endpoints).

router.post('/admin/unsuspend-by-workspace', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { workspaceId } = req.body;

  if (!workspaceId || typeof workspaceId !== 'string') {
    res.status(400).json({ error: 'workspaceId_required' });
    return;
  }

  const pool = getPool();

  // Resolve workspace → account
  const tenantResult = await withAdminScope(
    {
      caller: 'billing.admin.unsuspendByWorkspace',
      reason: 'admin manual unsuspend by workspace',
    },
    (client) =>
      // `tenants` has no workspace_id column — no migration adds one — so a
      // query selecting on it fails with 'column "workspace_id" does not
      // exist'. "Workspace" is the product-side name for
      // what this database calls tenants.id.
      client.query<{ account_id: string }>(
        `SELECT t.account_id
         FROM tenants t
         WHERE t.id = $1
         LIMIT 1`,
        [workspaceId],
      ),
  );

  if (tenantResult.rows.length === 0) {
    res.status(404).json({ error: 'workspace_not_found' });
    return;
  }

  const accountId = tenantResult.rows[0].account_id;

  // Unsuspend (mirrors /recovery-succeeded logic)
  await pool.query(
    `UPDATE billing_controls
     SET suspended               = FALSE,
         suspended_reason        = NULL,
         outstanding_balance_usd = 0,
         updated_at              = NOW()
     WHERE account_id = $1`,
    [accountId],
  );

  invalidateExecutionCache(accountId);
  void publishBillingSuspensionChange(accountId, 'unsuspended', 'admin_unsuspend');

  log.warn(
    { workspaceId, accountId },
    'billing.controls: admin unsuspend via workspace',
  );

  res.status(200).json({ ok: true, accountId, workspaceId });
});

// ── Endpoint: /period-reset ────────────────────────────────────────────────────
// Called by invoice.paid (billing_reason = subscription_cycle, monthly renewal).
// Resets spend counter and advances period start.
// Graduated accounts reset to $1,000 threshold; non-graduated reset to $100.

router.post('/controls/:accountId/period-reset', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { billingPeriodStart, stripePeriodStart, stripeSubscriptionId } = req.body;

  if (!billingPeriodStart) {
    res.status(400).json({ error: 'billingPeriodStart_required' });
    return;
  }

  await doPeriodReset(accountId, {
    billingPeriodStart: new Date(billingPeriodStart),
    stripePeriodStart: stripePeriodStart ? new Date(stripePeriodStart) : null,
    stripeSubscriptionId: stripeSubscriptionId ?? null,
  });

  log.info({ accountId, billingPeriodStart }, 'billing.controls: period-reset');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /prepaid-topped-up ──────────────────────────────────────────────
// Called by liftoff-billing after a successful reload invoice payment.
// Adds amountUsd (delta) to reload_balance_usd. Delta-based (+=) to avoid
// concurrent reload races. Also unsuspends pre-pay accounts if the new balance
// brings them above zero. Returns { reloadBalanceUsd } so liftoff-billing can
// surface the new balance.
//
// (Pre-Migration B this also wrote prepaid_balance_usd; that column is dropped
// and reload_balance_usd is the sole user-paid credit field.)

router.post('/controls/:accountId/prepaid-topped-up', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { amountUsd } = req.body;

  if (amountUsd === undefined || amountUsd === null) {
    res.status(400).json({ error: 'amountUsd_required' });
    return;
  }

  const pool = getPool();
  const result = await pool.query<{ reload_balance_usd: string }>(
    `UPDATE billing_controls SET
       reload_balance_usd  = reload_balance_usd  + $2,
       suspended = CASE
         WHEN billing_mode = 'pre_pay' AND (reload_balance_usd + $2) > 0 THEN FALSE
         ELSE suspended
       END,
       suspended_reason = CASE
         WHEN billing_mode = 'pre_pay' AND (reload_balance_usd + $2) > 0 THEN NULL
         ELSE suspended_reason
       END,
       agents_stalled_notified_at = NULL,
       updated_at = NOW()
     WHERE account_id = $1
     RETURNING reload_balance_usd`,
    [accountId, amountUsd],
  );

  const reloadBalanceUsd = result.rows[0] ? parseFloat(result.rows[0].reload_balance_usd) : 0;

  // Funded credit clears a workspace to run, not just to stop being suspended.
  //
  // Subscription activation used to be the only thing that set
  // agent_execution_allowed, which left a workspace paying by the dollar with a
  // positive balance and the flag still FALSE — unsuspended above, refused by
  // every gate, and told it needed a plan.
  //
  // Guarded on a positive balance so a top-up that did not fund anything (no
  // billing_controls row, or a balance still negative after a clawback) does
  // not clear a workspace that remains unable to pay. AFTER the UPDATE above,
  // because the event this publishes carries `billingSuspended` read from that
  // table. A no-op once the flag is true, so repeat top-ups publish nothing.
  const failedTenants = reloadBalanceUsd > 0
    ? await enableExecutionForAccountTenants(accountId)
    : [];

  invalidateExecutionCache(accountId);
  // The enable above republishes only the tenants whose flag was FALSE; a
  // workspace that was merely suspended on balance learns of the funding here.
  if (reloadBalanceUsd > 0) void publishBillingSuspensionChange(accountId, 'unsuspended', 'prepaid_topped_up');

  // Before the 200, so a partial activation is retried rather than recorded as
  // a completed top-up over a workspace that still cannot run. Every write here
  // is idempotent, so the retry is free.
  if (respondIfExecutionEnableFailed(res, accountId, failedTenants)) return;

  log.info({ accountId, amountUsd, reloadBalanceUsd }, 'billing.controls: prepaid-topped-up');
  // Response retains the prepaidBalanceUsd alias for any in-flight billing
  // callers expecting the old field name; both keys point at reload_balance_usd
  // (the only credit field after Migration B).
  res.status(200).json({ reloadBalanceUsd, prepaidBalanceUsd: reloadBalanceUsd });
});

// ── Endpoint: /prepaid-clawback ───────────────────────────────────────────────
// Called by liftoff-billing when the payment for a prepaid top-up is taken back
// — refunded, or disputed and lost.
//
// The inverse of /prepaid-topped-up, and it has to exist for the same reason
// credit is non-refundable: the money bought Operating Units, so money going
// back out has to take the unspent units with it. Without this a top-up can be
// charged back after the compute is consumed and the customer keeps both.
//
// THE BALANCE MAY GO NEGATIVE, deliberately. Flooring at zero would forgive
// exactly the case worth catching — credit already spent — and hand back the
// compute for free. A negative balance suspends a pre-pay account under the
// same `zero_prepaid_balance` reason the reload drain uses, so the account
// stays stopped until the debt is settled, and the existing top-up path
// unsuspends it when it is.
//
// Not idempotent on its own, matching /prepaid-topped-up: both rely on the
// webhook ingress, where stripe_webhook_events takes the event id ON CONFLICT
// DO NOTHING, so a redelivery never reaches either endpoint twice.

router.post('/controls/:accountId/prepaid-clawback', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { amountUsd, reason } = req.body ?? {};

  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    res.status(400).json({ error: 'amountUsd_must_be_a_positive_number' });
    return;
  }

  const pool = getPool();
  const result = await pool.query<{ reload_balance_usd: string; suspended: boolean }>(
    `UPDATE billing_controls SET
       reload_balance_usd = reload_balance_usd - $2,
       suspended = CASE
         WHEN billing_mode = 'pre_pay' AND (reload_balance_usd - $2) < 0 THEN TRUE
         ELSE suspended
       END,
       suspended_reason = CASE
         WHEN billing_mode = 'pre_pay' AND (reload_balance_usd - $2) < 0 THEN 'zero_prepaid_balance'
         ELSE suspended_reason
       END,
       updated_at = NOW()
     WHERE account_id = $1
     RETURNING reload_balance_usd, suspended`,
    [accountId, amountUsd],
  );

  if (!result.rows[0]) {
    res.status(404).json({ error: 'account_not_found' });
    return;
  }

  invalidateExecutionCache(accountId);

  const reloadBalanceUsd = parseFloat(result.rows[0].reload_balance_usd);
  const suspended = result.rows[0].suspended;

  // Tell every tenant under the account, the way /payment-failed and
  // /recovery-succeeded do. A clawback can take the balance negative and
  // suspend the workspace, and the runtime admits work from a snapshot it
  // caches for up to a minute — so without this it keeps spending for that
  // minute on money that has just been taken back, which is the one case
  // where the spend is certainly unrecoverable. Only on a suspension the
  // clawback actually caused: a debit that left the balance positive changes
  // nothing the runtime needs to hear about.
  if (suspended) {
    void publishBillingSuspensionChange(accountId, 'suspended', `prepaid_clawback:${reason ?? 'unknown'}`);
  }

  log.warn(
    { accountId, amountUsd, reason: reason ?? null, reloadBalanceUsd, suspended },
    'billing.controls: prepaid-clawback',
  );
  res.status(200).json({ reloadBalanceUsd, suspended });
});

// ── Endpoint: /fraud-hold ─────────────────────────────────────────────────────
// Called by liftoff-billing on radar.early_fraud_warning.created: the issuer of
// a card that paid this account has reported the payment as fraud.
//
// One column, then one publish. The column is a term in
// prepaid-floor.billingStoppedSql, which is joined into the entitlement
// snapshot the tenant runtime's admission gates read, and it is checked by
// this service's execution guard, so setting it stops new work everywhere
// without touching agent_execution_allowed. Leaving that flag alone is the
// point: it is the "this workspace is cleared to run" fact that a top-up and a
// subscription both set, and a hold that flipped it would be undone by the
// next payment — which, on a stolen card, is exactly what is about to arrive.
//
// The publish is what makes it immediate. The snapshot is computed on read, so
// without it the runtime keeps its cached copy for up to a minute, and every
// run in flight keeps spending on a card the issuer has already called stolen.
//
// Idempotent: COALESCE keeps the first warning's timestamp and reference, so a
// redelivery changes nothing and republishes the same state.
//
// Nothing here touches the wallet. Credit leaves when money leaves
// (charge.refunded / charge.dispute.created); about 40% of warnings become
// disputes, and debiting here would take the credit twice on those and once
// too often on the rest.

router.post('/controls/:accountId/fraud-hold', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { ref, chargeId, invoiceId, fraudType } = req.body ?? {};

  if (typeof ref !== 'string' || ref.length === 0) {
    res.status(400).json({ error: 'ref_required' });
    return;
  }

  const pool = getPool();
  const result = await pool.query<{ fraud_hold_at: Date; fraud_hold_ref: string }>(
    `UPDATE billing_controls SET
       fraud_hold_at  = COALESCE(fraud_hold_at, NOW()),
       fraud_hold_ref = COALESCE(fraud_hold_ref, $2),
       updated_at     = NOW()
     WHERE account_id = $1
     RETURNING fraud_hold_at, fraud_hold_ref`,
    [accountId, ref],
  );

  if (!result.rows[0]) {
    res.status(404).json({ error: 'account_not_found' });
    return;
  }

  invalidateExecutionCache(accountId);
  // Awaited, unlike the money paths that fire this and move on: stopping the
  // workspace is the whole purpose of the request. The publisher swallows and
  // logs a per-tenant failure, so what an await actually catches is a failure
  // to LIST the account's tenants — the column is already written either way,
  // and the runtime's TTL refresh stays the backstop it has always been.
  await publishBillingSuspensionChange(accountId, 'suspended', 'fraud_hold');

  log.warn(
    {
      accountId,
      ref,
      chargeId: chargeId ?? null,
      invoiceId: invoiceId ?? null,
      fraudType: fraudType ?? null,
      heldAt: result.rows[0].fraud_hold_at,
      event: 'billing.controls.fraud_hold',
    },
    'billing.controls: fraud-hold',
  );
  res.status(200).json({ ok: true, heldAt: result.rows[0].fraud_hold_at, ref: result.rows[0].fraud_hold_ref });
});

// ── Endpoint: /referral-bonus ─────────────────────────────────────────────────
// Called by liftoff-billing when a referred workspace pays its first
// full-priced invoice. Grants the referee half of the programme: bonus
// Operating Units on the FIRST billing period, and never at signup — at signup
// they cost an attacker one email address and the programme becomes a
// free-compute faucet.
//
// The grant lands in an allowance column rather than as money off the invoice.
// A $20 discount would zero a $20 Core invoice, which would disqualify the
// referral under the full-price rule AND halve the cost of manufacturing one,
// since vesting would then need one paid month instead of two.
//
// One bonus per account, ever: referral_bonus_referral_id survives the period
// reset that zeroes the OUs, so a redelivered invoice — or a second referral
// somehow attributed to the same workspace — cannot grant another. The response
// says which happened so the caller can tell a fresh grant from a replay.

router.post('/controls/:accountId/referral-bonus', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { referralId, bonusOus } = req.body ?? {};

  if (typeof referralId !== 'string' || referralId.length === 0) {
    res.status(400).json({ error: 'referralId_required' });
    return;
  }
  const ous = Number(bonusOus);
  if (!Number.isFinite(ous) || ous <= 0) {
    res.status(400).json({ error: 'bonusOus_must_be_positive' });
    return;
  }

  const pool = getPool();
  const result = await pool.query<{ referral_bonus_ous: string; referral_bonus_referral_id: string }>(
    `UPDATE billing_controls SET
       referral_bonus_ous         = $3,
       referral_bonus_referral_id = $2,
       updated_at                 = NOW()
     WHERE account_id = $1
       AND referral_bonus_referral_id IS NULL
     RETURNING referral_bonus_ous, referral_bonus_referral_id`,
    [accountId, referralId, Math.trunc(ous)],
  );

  if (result.rows.length === 0) {
    // Either the account has no billing_controls row, or it already carries a
    // bonus. The second is the ordinary redelivery case and is not a fault.
    const { rows } = await pool.query<{ referral_bonus_referral_id: string | null }>(
      `SELECT referral_bonus_referral_id FROM billing_controls WHERE account_id = $1`,
      [accountId],
    );
    if (rows.length === 0) {
      log.warn({ accountId, referralId }, 'billing.controls: referral-bonus on an account with no controls row');
      res.status(404).json({ error: 'not_found' });
      return;
    }
    log.info(
      { accountId, referralId, existingReferralId: rows[0].referral_bonus_referral_id },
      'billing.controls: referral-bonus already granted — no second grant',
    );
    res.status(200).json({ granted: false, alreadyGranted: true });
    return;
  }

  // The allowance changed, so any cached admission decision for this account is
  // now describing the wrong capacity.
  invalidateExecutionCache(accountId);

  log.info({ accountId, referralId, bonusOus: Math.trunc(ous) }, 'billing.controls: referral-bonus granted');
  res.status(200).json({ granted: true, alreadyGranted: false, referralBonusOus: Math.trunc(ous) });
});

// ── Endpoint: /subscription-activated ────────────────────────────────────────
// Called by customer.subscription.updated when status transitions to active.
// Enables agent execution for all tenants belonging to this account.
// For enterprise pre-pay activations (billingTier === 'enterprise'): sets enterprise fields.
// For standard pre-pay activations (planType provided): also sets wallet/mode fields.
// For post-pay activations (planType null): only updates stripe metadata.

router.post('/controls/:accountId/subscription-activated', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const {
    planType, billingTier, includedOus, precommitExtraOus,
    includedRateUsdPerOu, precommitRateUsdPerOu, reloadRateUsdPerOu,
    isAnnualPlan,
    stripeSubscriptionId, stripePeriodStart, stripePeriodEnd,
    promoApplied,
  } = req.body as {
    planType?: 'core'|'growth'|'scale';
    billingTier?: string;
    includedOus?: number;
    precommitExtraOus?: number;
    includedRateUsdPerOu?: number;
    precommitRateUsdPerOu?: number;
    reloadRateUsdPerOu?: number;
    isAnnualPlan?: boolean;
    stripeSubscriptionId?: string;
    stripePeriodStart?: string;
    stripePeriodEnd?: string;
    promoApplied?: { amountOffUsd: number; firstInvoiceTotalUsd: number };
  };

  const pool = getPool();

  // The billing_controls row must exist before the UPDATEs below, and nothing
  // guarantees it does. liftoff-billing calls this endpoint and /controls/init
  // independently, and on a self-serve checkout activation can win. When it
  // does, the UPDATE matches ZERO rows and reports success. The plan, the OU
  // allowance, the rates and `suspended = FALSE` are all silently dropped, and
  // because init deliberately does not reset `suspended` on conflict, the
  // account is left paid-up and suspended with no way back. Ordering between two
  // independent callers is not something this endpoint can assume, so it stops
  // assuming: seed the row on the same defaults init uses, then let the UPDATE
  // below own the activation columns.
  //
  // Only for the two PRE-PAY branches, which are the ones that set the plan and
  // clear `suspended`. Seeding on the post-pay branch would mean guessing a mode
  // from an activation that did not state one, and a wrong guess sticks: init's
  // ON CONFLICT will not correct billing_mode or suspended afterwards. That
  // branch writes only Stripe pointers, which init writes too, so it keeps
  // today's behaviour exactly.
  const activatingPrePay =
    (billingTier === 'enterprise' && typeof includedOus === 'number') || Boolean(planType);
  if (activatingPrePay) await ensurePrePayBillingControlsRow(accountId);

  // Agent execution is enabled AFTER the billing writes below, not here. The
  // event that enable publishes carries `billingSuspended`, read from
  // billing_controls, so publishing it before the UPDATE that clears
  // `suspended` ships a snapshot saying SUSPENDED for an account being
  // unsuspended in this very request: `agentExecutionAllowed: true` alongside
  // `billingSuspended: true`, milliseconds stale. The runtime's handler happens
  // to discard the payload and refetch the entitlement; a subscriber that trusted the
  // payload would read a paying customer as suspended. An event describes state
  // that has already settled, so it is emitted once everything has.

  // Both pre-pay branches below zero the period counters, because a plan's
  // allowance has to start at the allowance. liftoff-billing also calls
  // /period-reset off the first invoice, but that call is fire-and-forget with
  // no retry, and a workspace arriving here may have consumed for a long time
  // without one: /period-reset fires on a paid subscription invoice, and a
  // workspace funding itself with credit has no subscription and therefore no
  // invoice, so its counters accumulate for its whole life. Resetting here
  // makes it a post-condition of the activation this endpoint already retries.
  // A no-op for a workspace whose counters were already zero.

  // Enterprise pre-pay — caller supplies all three negotiated rates from the contract.
  if (billingTier === 'enterprise' && typeof includedOus === 'number') {
    const entResult = await pool.query(
      `UPDATE billing_controls SET
         billing_mode              = 'pre_pay',
         billing_tier              = 'enterprise',
         plan_type                 = NULL,
         plan_included_ous         = $2,
         precommit_extra_ous       = $3,
         included_rate_usd_per_ou  = COALESCE($4, included_rate_usd_per_ou),
         precommit_rate_usd_per_ou = COALESCE($5, precommit_rate_usd_per_ou),
         reload_rate_usd_per_ou    = COALESCE($6, reload_rate_usd_per_ou),
         is_annual_plan            = COALESCE($7, is_annual_plan),
         suspended                 = FALSE,
         suspended_reason          = NULL,
         agents_stalled_notified_at = NULL,
         ous_consumed_this_period  = 0,
         current_period_spend_usd  = 0,
         referral_bonus_ous        = 0,
         updated_at                = NOW()
       WHERE account_id = $1`,
      [accountId, includedOus, precommitExtraOus ?? 0,
       includedRateUsdPerOu ?? null, precommitRateUsdPerOu ?? null, reloadRateUsdPerOu ?? null,
       isAnnualPlan ?? null],
    );
    assertActivationApplied(entResult.rowCount, accountId, 'enterprise');
    await mirrorSubscriptionActive(accountId, 'enterprise', stripeSubscriptionId, stripePeriodStart, stripePeriodEnd);
    const failedEnterprise = await enableExecutionForAccountTenants(accountId);
    // After both writes, so nothing can repopulate the cache from half-applied state.
    invalidateExecutionCache(accountId);
    if (respondIfExecutionEnableFailed(res, accountId, failedEnterprise)) return;
    log.info({ accountId, includedOus, precommitExtraOus, includedRateUsdPerOu, precommitRateUsdPerOu, reloadRateUsdPerOu },
      'billing.controls: subscription-activated — enterprise');
    res.status(200).json({ ok: true });
    return;
  }

  // Self-serve pre-pay (core/growth/scale) — rates come from plan_catalog
  // seeded values. liftoff-billing cannot query plan_catalog (different DB),
  // so it forwards plan_type only and we resolve the three rates here.
  if (planType) {
    let resolvedIncludedRate  = includedRateUsdPerOu  ?? null;
    let resolvedPrecommitRate = precommitRateUsdPerOu ?? null;
    let resolvedReloadRate    = reloadRateUsdPerOu    ?? null;
    if (resolvedIncludedRate == null || resolvedPrecommitRate == null || resolvedReloadRate == null) {
      const rateRows = await pool.query<{
        included_rate_usd_per_ou: string;
        precommit_rate_usd_per_ou: string;
        reload_rate_usd_per_ou: string;
      }>(
        `SELECT included_rate_usd_per_ou, precommit_rate_usd_per_ou, reload_rate_usd_per_ou
           FROM plan_catalog
          WHERE id = $1
            AND (effective_to IS NULL OR effective_to > NOW())
          ORDER BY effective_from DESC LIMIT 1`,
        [planType],
      );
      const r = rateRows.rows[0];
      if (!r) {
        log.error({ accountId, planType }, 'billing.controls: subscription-activated — no plan_catalog row');
        res.status(422).json({ error: 'plan_rates_missing', planType });
        return;
      }
      resolvedIncludedRate  = resolvedIncludedRate  ?? parseFloat(r.included_rate_usd_per_ou);
      resolvedPrecommitRate = resolvedPrecommitRate ?? parseFloat(r.precommit_rate_usd_per_ou);
      resolvedReloadRate    = resolvedReloadRate    ?? parseFloat(r.reload_rate_usd_per_ou);
      // plan_catalog lookup fired. This is the EXPECTED path for self-serve
      // subscriptions: liftoff-billing intentionally doesn't pass rates because
      // plan_catalog lives in PB's database, not billing's, and we don't want
      // billing to hold a duplicate copy. log.debug rather than log.info because
      // this fires on every self-serve /subscribe. (If rates ARE supplied — e.g.
      // by a future internal caller — they short-circuit this path entirely.)
      log.debug(
        { accountId, planType,
          included: resolvedIncludedRate, precommit: resolvedPrecommitRate, reload: resolvedReloadRate },
        'billing.controls.subscription-activated: rates resolved from plan_catalog',
      );
    }
    const selfServeResult = await pool.query(
      `UPDATE billing_controls SET
         billing_mode              = 'pre_pay',
         plan_type                 = $2,
         plan_included_ous         = $3,
         precommit_extra_ous       = $4,
         included_rate_usd_per_ou  = $5,
         precommit_rate_usd_per_ou = $6,
         reload_rate_usd_per_ou    = $7,
         is_annual_plan            = COALESCE($8, is_annual_plan),
         suspended                 = FALSE,
         suspended_reason          = NULL,
         agents_stalled_notified_at = NULL,
         ous_consumed_this_period  = 0,
         current_period_spend_usd  = 0,
         referral_bonus_ous        = 0,
         updated_at                = NOW()
       WHERE account_id = $1`,
      [accountId, planType, includedOus ?? 0, precommitExtraOus ?? 0,
       resolvedIncludedRate, resolvedPrecommitRate, resolvedReloadRate,
       isAnnualPlan ?? null],
    );
    assertActivationApplied(selfServeResult.rowCount, accountId, planType);
    await mirrorSubscriptionActive(accountId, planType, stripeSubscriptionId, stripePeriodStart, stripePeriodEnd);
  } else {
    // Post-pay (no plan_included_ous to set)
    await pool.query(
      `UPDATE billing_controls SET
         stripe_subscription_id = COALESCE($2, stripe_subscription_id),
         stripe_period_start    = COALESCE($3, stripe_period_start),
         updated_at             = NOW()
       WHERE account_id = $1`,
      [accountId, stripeSubscriptionId ?? null, stripePeriodStart ? new Date(stripePeriodStart) : null],
    );
    await mirrorSubscriptionActive(accountId, 'post_pay', stripeSubscriptionId, stripePeriodStart, stripePeriodEnd);
  }

  // Clear access_ends_at on (re)activation — a resubscribe cancels any pending
  // end-of-period termination.
  await pool.query(
    `UPDATE billing_controls SET access_ends_at = NULL WHERE account_id = $1 AND access_ends_at IS NOT NULL`,
    [accountId],
  );

  // Every billing_controls write for this account has now landed, so the
  // entitlement event this publishes describes settled state.
  const failedExecTenants = await enableExecutionForAccountTenants(accountId);

  // After both writes, so nothing can repopulate the cache from half-applied state.
  invalidateExecutionCache(accountId);

  // Before the confirmation email, so a retry does not send it twice.
  if (respondIfExecutionEnableFailed(res, accountId, failedExecTenants)) return;

  notifySubscriptionConfirmation(accountId, {
    isAnnualPlan: isAnnualPlan ?? false,
    stripePeriodEnd,
    promoApplied,
  }).catch((err: Error) => log.warn({ error: err.message, accountId }, 'notify failed (non-fatal)'));

  log.info({ accountId, planType: planType ?? null }, 'billing.controls: subscription-activated');
  res.status(200).json({ ok: true });
});

// Enable agent execution for every tenant under the account, returning the ids
// that failed rather than throwing.
//
// This used to be one blanket UPDATE across the account's tenants. It set the
// flag and nothing else: `version` did not move and no event fired, so the
// tenant runtime's cached entitlement kept saying execution was not allowed and
// had no way to find out otherwise. Per tenant through the service now — each
// write bumps the version and publishes tenant.entitlement.updated.
//
// CALL THIS LAST, after every billing_controls write for the account. The event
// carries `billingSuspended` read from that table, so calling it earlier
// publishes a suspended-looking snapshot of an account that is being unsuspended
// in the same request.
//
// entitlements is RLS-enabled and this internal webhook is keyed by accountId
// with no single tenant scope, so the tenant LIST is read under withAdminScope
// (bounded to this account, no cross-account exposure); each per-tenant write
// then runs in its own tenant scope inside the service.
//
// One tenant failing must not strand the others. It must not be swallowed
// either: this is the ONLY place agent_execution_allowed is flipped to TRUE, so
// a failure means a paying customer cannot run anything. Logging it and
// answering 200 would tell the caller the subscription was fully activated when
// the entitlement half had not happened at all, and a broken INSERT behind
// such a catch can sit unnoticed indefinitely. The caller answers 500 on a non-empty return so the sender retries; every write in
// this handler is idempotent, so a retry is free.
async function enableExecutionForAccountTenants(accountId: string): Promise<string[]> {
  const tenantIds = await withAdminScope(
    { caller: 'billing-controls.subscription-activated', reason: 'list the account\'s tenants to enable agent execution (no single tenant scope)' },
    async (client) => {
      // Filtered to the rows that would actually change: a webhook redelivery
      // must not re-publish an event and re-snapshot every tenant under the
      // account for a flag that is already TRUE.
      const r = await client.query<{ tenant_id: string }>(
        `SELECT e.tenant_id FROM entitlements e
           JOIN tenants t ON t.id = e.tenant_id
          WHERE t.account_id = $1
            AND e.agent_execution_allowed = FALSE`,
        [accountId],
      );
      return r.rows.map(row => row.tenant_id);
    },
  );

  const failed: string[] = [];
  for (const tenantId of tenantIds) {
    await entitlementService.enableAgentExecution(tenantId).catch((err: Error) => {
      failed.push(tenantId);
      log.error({ accountId, tenantId, err: err.message },
        'billing.controls: enabling agent execution failed for one tenant');
    });
  }
  return failed;
}

// Seed a pre-pay billing_controls row so an activation that arrives before
// /controls/init has something to UPDATE. Deliberately the SAME defaults init
// uses (`suspended` TRUE because a pre-pay balance is $0 until funded,
// `billing_exempt` from accounts.is_internal), and DO NOTHING on conflict, so
// whichever of the two callers lands first the row is identical and the second
// is a no-op. The activation UPDATE that follows owns the plan columns and
// clears `suspended`; init's own ON CONFLICT clause already refuses to reset
// mode, suspension or exemption, so it cannot undo that afterwards.
async function ensurePrePayBillingControlsRow(accountId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO billing_controls (account_id, billing_mode, suspended, billing_exempt)
     VALUES ($1, 'pre_pay', TRUE, COALESCE((SELECT is_internal FROM accounts WHERE id = $1), FALSE))
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  );
}

// A zero-row activation UPDATE means the money landed and the plan did not.
// It cannot happen now that ensureBillingControlsRow runs first, which is
// exactly why it is worth asserting: if a future change reintroduces the gap,
// this says so instead of returning 200 over a customer who paid and cannot run.
function assertActivationApplied(
  rowCount: number | null,
  accountId: string,
  planType: string,
): void {
  if (rowCount && rowCount > 0) return;
  log.error(
    { accountId, planType, event: 'billing.controls.activation_matched_no_row' },
    'billing.controls: subscription-activated UPDATE matched no billing_controls row — the plan, OU allowance and unsuspend were all dropped',
  );
}

// Answer 500 when the entitlement half of activation did not happen, so the
// caller retries rather than recording a fully-activated subscription over a
// tenant that still cannot execute. Returns true when it has answered.
function respondIfExecutionEnableFailed(
  res: Response,
  accountId: string,
  failedTenantIds: string[],
): boolean {
  if (failedTenantIds.length === 0) return false;
  log.error(
    { accountId, failedTenantIds, event: 'billing.controls.activation_exec_enable_failed' },
    'billing.controls: subscription-activated could not enable agent execution — answering 500 so the caller retries',
  );
  res.status(500).json({ error: 'agent_execution_enable_failed', tenantIds: failedTenantIds });
  return true;
}

// Idempotently mirror the active Stripe subscription into platform-backend's
// local `subscriptions` table. /api/subscriptions/account/:accountId/active
// reads from here, so the frontend's useActiveSubscription() (PricingPage,
// SettingsPage) sees the design immediately after activation without depending
// on liftoff-billing's tenant-scoped subscriptions table.
//
// Idempotent across calls: if an active row already exists for this account,
// it's updated in place (version bumped). Otherwise a new row is inserted.
async function mirrorSubscriptionActive(
  accountId: string,
  planId: string,
  stripeSubscriptionId: string | null | undefined,
  stripePeriodStart: string | Date | null | undefined,
  stripePeriodEnd: string | Date | null | undefined,
): Promise<void> {
  const pool = getPool();
  const periodStart = stripePeriodStart ? new Date(stripePeriodStart) : null;
  const periodEnd = stripePeriodEnd ? new Date(stripePeriodEnd) : null;
  const updateResult = await pool.query(
    `UPDATE subscriptions
       SET plan_id              = $2,
           stripe_subscription_id = COALESCE($3, stripe_subscription_id),
           current_period_start = COALESCE($4, current_period_start),
           current_period_end   = COALESCE($5, current_period_end),
           version              = version + 1,
           updated_at           = NOW()
     WHERE account_id = $1 AND status = 'active'
     RETURNING id`,
    [accountId, planId, stripeSubscriptionId ?? null, periodStart, periodEnd],
  );
  if (updateResult.rowCount && updateResult.rowCount > 0) return;
  await pool.query(
    `INSERT INTO subscriptions (account_id, plan_id, stripe_subscription_id, status, current_period_start, current_period_end)
     VALUES ($1, $2, $3, 'active', $4, $5)`,
    [accountId, planId, stripeSubscriptionId ?? null, periodStart, periodEnd],
  );
}

// Mark this account's cancelled mirror row. Used by /subscription-cancelled.
// Idempotent: a missing row is a no-op (e.g. activations that predate the mirror).
//
// When stripeSubscriptionId is provided, only the row for THAT subscription is
// cancelled — cancelling the account's blanket "active" row on a stale-sub
// webhook corrupts the mirror (the stale sub's cancellation flips the live
// sub's row to canceled). The
// blanket account-level form is kept for legacy callers that cannot say which
// subscription ended.
async function mirrorSubscriptionCanceled(accountId: string, stripeSubscriptionId?: string): Promise<void> {
  const pool = getPool();
  if (stripeSubscriptionId) {
    await pool.query(
      `UPDATE subscriptions
         SET status     = 'canceled',
             version    = version + 1,
             updated_at = NOW()
       WHERE account_id = $1 AND stripe_subscription_id = $2 AND status <> 'canceled'`,
      [accountId, stripeSubscriptionId],
    );
    return;
  }
  await pool.query(
    `UPDATE subscriptions
       SET status     = 'canceled',
           version    = version + 1,
           updated_at = NOW()
     WHERE account_id = $1 AND status = 'active'`,
    [accountId],
  );
}

// ── Endpoint: /subscription-cancelled ────────────────────────────────────────
// Called by customer.subscription.deleted.
//
// Suspends the account ONLY when the cancelled subscription is provably the
// one the account is currently billed on. The invariant: an account may only
// be suspended by the cancellation of the subscription it is currently billed
// on. Without this check, a stale sub on an abandoned Stripe customer —
// resolved onto the live account via the metadata.tenant_id fallback — could
// suspend an account whose real subscription is untouched.
//
// Match rules (each clause skipped when the caller cannot supply the datum,
// so legacy bodies and direct account-UUID invocations keep working):
//   - customer:   cancelled sub's customer (body.stripeCustomerId, falling
//                 back to the cus_ id from the URL path) must equal
//                 billing_controls.stripe_customer_id.
//   - subscription: body.subscriptionId must equal
//                 billing_controls.stripe_subscription_id, unless that
//                 column is NULL (pointer never set).
//
// On mismatch: log billing.controls.stale_subscription_cancel_ignored, still
// mirror the cancelled sub's own row (never the account's active row), touch
// nothing else. Idempotent in both directions under Pub/Sub redelivery.

router.post('/controls/:accountId/subscription-cancelled', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { subscriptionId, stripeCustomerId } = req.body as {
    subscriptionId?: string;
    stripeCustomerId?: string;
  };

  const pool = getPool();

  const cancelledCustomerId: string | null =
    stripeCustomerId
    ?? (res.locals.stripeCustomerIdFromPath as string | undefined)
    ?? null;

  const bc = await pool.query<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>(
    `SELECT stripe_customer_id, stripe_subscription_id FROM billing_controls WHERE account_id = $1`,
    [accountId],
  );
  const currentCustomerId = bc.rows[0]?.stripe_customer_id ?? null;
  const currentSubscriptionId = bc.rows[0]?.stripe_subscription_id ?? null;

  const customerMatches =
    cancelledCustomerId == null || currentCustomerId == null || cancelledCustomerId === currentCustomerId;
  const subscriptionMatches =
    subscriptionId == null || currentSubscriptionId == null || subscriptionId === currentSubscriptionId;

  if (!customerMatches || !subscriptionMatches) {
    // Stale/orphan cancellation — not the subscription this account currently
    // bills on. Record the cancelled sub's own mirror row if we know it, but
    // never flip the account's active row, never suspend, never notify.
    if (subscriptionId) await mirrorSubscriptionCanceled(accountId, subscriptionId);
    log.warn(
      {
        accountId,
        cancelledSubscriptionId: subscriptionId ?? null,
        cancelledCustomerId,
        currentSubscriptionId,
        currentCustomerId,
      },
      'billing.controls.stale_subscription_cancel_ignored',
    );
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  await pool.query(
    `UPDATE billing_controls SET
       suspended        = TRUE,
       suspended_reason = 'subscription_cancelled',
       updated_at       = NOW()
     WHERE account_id = $1`,
    [accountId],
  );

  await mirrorSubscriptionCanceled(accountId, subscriptionId);

  // Clear access_ends_at since the period has now ended (idempotent if not set).
  await pool.query(
    `UPDATE billing_controls SET access_ends_at = NULL WHERE account_id = $1`,
    [accountId],
  );

  invalidateExecutionCache(accountId);

  notifySubscriptionEnded(accountId, { accessEndedDate: new Date() }).catch((err: Error) =>
    log.warn({ error: err.message, accountId }, 'notify failed (non-fatal)'),
  );

  log.warn({ accountId }, 'billing.controls: subscription-cancelled — account suspended');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /card-expiring ─────────────────────────────────────────────────
// Pure notification fan-out fired by liftoff-billing's daily card-expiring
// scheduler. No DB mutation.

router.post('/controls/:accountId/card-expiring', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { cardBrand, cardLast4, cardExpMonth, cardExpYear } = req.body as {
    cardBrand?: string;
    cardLast4?: string;
    cardExpMonth?: string;
    cardExpYear?: string;
  };
  if (!cardBrand || !cardLast4 || !cardExpMonth || !cardExpYear) {
    res.status(400).json({ error: 'invalid_card_expiring_payload' });
    return;
  }

  notifyCardExpiring(accountId, { cardBrand, cardLast4, cardExpMonth, cardExpYear }).catch((err: Error) =>
    log.warn({ error: err.message, accountId }, 'card-expiring notify failed (non-fatal)'),
  );

  log.info({ accountId, cardExpMonth, cardExpYear }, 'billing.controls: card-expiring');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /receipt ───────────────────────────────────────────────────────
// Pure notification fan-out for successful charges (subscription renewals,
// credit reloads). No DB mutation. Unified across renewal + reload.

router.post('/controls/:accountId/receipt', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { context, amountUsd, paymentMethodType, paymentMethodLast4 } = req.body as {
    context?: 'subscription_renewal' | 'credit_reload';
    amountUsd?: number;
    paymentMethodType?: 'card' | 'us_bank_account';
    paymentMethodLast4?: string;
  };
  if (
    (context !== 'subscription_renewal' && context !== 'credit_reload') ||
    typeof amountUsd !== 'number' ||
    (paymentMethodType !== 'card' && paymentMethodType !== 'us_bank_account') ||
    typeof paymentMethodLast4 !== 'string'
  ) {
    res.status(400).json({ error: 'invalid_receipt_payload' });
    return;
  }

  notifyReceipt(accountId, { context, amountUsd, paymentMethodType, paymentMethodLast4 }).catch((err: Error) =>
    log.warn({ error: err.message, accountId }, 'receipt notify failed (non-fatal)'),
  );

  log.info({ accountId, receiptContext: context, amountUsd }, 'billing.controls: receipt');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /subscription-ending ───────────────────────────────────────────
// Called by customer.subscription.updated when cancel_at_period_end transitions
// from false → true (subscription scheduled to cancel at period end; access
// continues until accessEndsAt).

router.post('/controls/:accountId/subscription-ending', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { accessEndsAt } = req.body as { accessEndsAt?: number };
  if (typeof accessEndsAt !== 'number') {
    res.status(400).json({ error: 'accessEndsAt_required' });
    return;
  }
  const accessEndsDate = new Date(accessEndsAt * 1000);

  const pool = getPool();
  await pool.query(
    `UPDATE billing_controls SET access_ends_at = $2, updated_at = NOW() WHERE account_id = $1`,
    [accountId, accessEndsDate],
  );

  notifySubscriptionEnding(accountId, { accessEndsDate }).catch((err: Error) =>
    log.warn({ error: err.message, accountId }, 'notify failed (non-fatal)'),
  );

  log.info({ accountId, accessEndsAt: accessEndsDate.toISOString() }, 'billing.controls: subscription-ending');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /payment-failed ─────────────────────────────────────────────────
// Called by invoice.payment_failed for subscription_cycle and recovery invoice failures.
// Suspends account WITHOUT rolling back next_threshold_usd (the threshold schedule
// must be preserved so the graduated track isn't reset by a missed subscription payment).

router.post('/controls/:accountId/payment-failed', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { outstandingBalanceUsd } = req.body;

  const pool = getPool();
  await pool.query(
    `UPDATE billing_controls
     SET outstanding_balance_usd = GREATEST(outstanding_balance_usd, $2),
         suspended               = TRUE,
         suspended_reason        = 'payment_failed',
         last_charge_failed_at   = NOW(),
         updated_at              = NOW()
     WHERE account_id = $1`,
    [accountId, outstandingBalanceUsd ?? 0],
  );

  invalidateExecutionCache(accountId);
  void publishBillingSuspensionChange(accountId, 'suspended', 'payment_failed');
  notifyPaymentFailed(accountId, 'subscription_renewal', { outstandingBalanceUsd: outstandingBalanceUsd ?? 0 }).catch(() => {});

  log.warn({ accountId, outstandingBalanceUsd }, 'billing.controls: payment-failed — account suspended');
  // The liftoff-billing dispatcher calls this for both subscription_cycle and
  // recovery invoice failures; the precise invoice_class isn't propagated
  // here today, so report the upstream-grouped tag. Refine if it ever needs
  // separating in the funnel.
  res.status(200).json({ ok: true });
});

// ── Endpoint: /payment-method-added ──────────────────────────────────────────
// Called when a payment_method.attached or payment_method.updated event arrives.
// Sets has_payment_method = TRUE so the agent activation guard knows a card exists.

router.post('/controls/:accountId/payment-method-added', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;

  const pool = getPool();
  const updated = await pool.query<{
    suspended_reason: string | null;
    auto_reload_enabled: boolean;
    auto_reload_amount_usd: string | null;
    stripe_customer_id: string | null;
  }>(
    `UPDATE billing_controls SET
       has_payment_method = TRUE,
       suspended = CASE
         WHEN suspended_reason = 'no_payment_method' THEN FALSE
         ELSE suspended
       END,
       suspended_reason = CASE
         WHEN suspended_reason = 'no_payment_method' THEN NULL
         ELSE suspended_reason
       END,
       updated_at = NOW()
     WHERE account_id = $1
     RETURNING suspended_reason, auto_reload_enabled, auto_reload_amount_usd, stripe_customer_id`,
    [accountId],
  );

  invalidateExecutionCache(accountId);

  await retryFailedAutoReload(accountId, updated.rows[0]);

  log.info({ accountId }, 'billing.controls: payment-method-added');
  res.status(200).json({ ok: true });
});

// A workspace suspended for `auto_reload_failed` cannot recover on its own.
//
// Auto-reload only fires from applyReloadDrain, during cost attribution of an
// invocation, and a suspended workspace runs no invocations — so the one thing
// that would charge the new card never happens. Nothing else clears the reason
// either: the UPDATE above clears only `no_payment_method`, and doPeriodReset
// clears only `zero_prepaid_balance`, so it survives the monthly reset too.
// Attaching a card is therefore the moment to retry, and the only one.
//
// The charge, not the flag, is what unblocks them. Clearing `suspended` here
// would leave a workspace with an empty wallet, which the execution guard's
// pre-pay check refuses anyway — unsuspended and still stopped, with a worse
// reason. So this fires the same reload the spend path fires and lets the
// existing success path do the rest: liftoff-billing calls back
// /prepaid-topped-up, whose CASE clears both `suspended` and `suspended_reason`
// once the balance is positive. A second decline re-suspends with the same
// reason, so the next card attach tries again.
//
// Deliberately ignores `last_auto_reload_triggered_at`. That cooldown exists to
// stop runaway automatic charging while a workspace consumes; a person fixing a
// declined card is an explicit act, and this endpoint is rate limited.
//
// The `auto_reload_failed` condition is what keeps an ordinary card attach from
// charging anybody, and it clears itself on success.
async function retryFailedAutoReload(
  accountId: string,
  row: {
    suspended_reason: string | null;
    auto_reload_enabled: boolean;
    auto_reload_amount_usd: string | null;
    stripe_customer_id: string | null;
  } | undefined,
): Promise<void> {
  if (!row || row.suspended_reason !== 'auto_reload_failed') return;
  if (!row.auto_reload_enabled || !row.stripe_customer_id) return;

  const amountUsd = parseFloat(row.auto_reload_amount_usd ?? '');
  if (!(amountUsd > 0)) {
    log.warn({ accountId, raw: row.auto_reload_amount_usd },
      'billing.controls: auto-reload retry skipped — no positive reload amount configured');
    return;
  }

  // The reload invoice is attributed to a workspace, which is what later
  // resolves it — and any refund, dispute or fraud warning on its charge —
  // back to a tenant. An account funding itself with credit has no
  // subscription to be resolved by, so name its first workspace: the one the
  // credit is for. A null here is not fatal; it only leaves the invoice
  // unattributed, as every reload invoice was before.
  let tenantId: string | null = null;
  try {
    tenantId = (await withAdminScope(
      { caller: 'billing-controls.auto-reload-retry', reason: 'name a workspace for the reload invoice (account-keyed webhook, no single tenant scope)' },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM tenants WHERE account_id = $1 ORDER BY created_at ASC LIMIT 1`,
          [accountId],
        );
        return r.rows[0]?.id ?? null;
      },
    )) ?? null;
  } catch (err) {
    log.warn({ accountId, err: (err as Error).message },
      'billing.controls: could not name a workspace for the reload invoice');
  }

  try {
    await getBillingAdminClient().triggerAutoReload(row.stripe_customer_id, amountUsd, tenantId);
    log.info({ accountId, amountUsd },
      'billing.controls: retried auto-reload after a new payment method was attached');
  } catch (err) {
    // Not fatal to this endpoint, and not lost: the workspace stays in
    // `auto_reload_failed`, so the next card attach retries, and a manual
    // top-up still clears it.
    log.error(
      { accountId, amountUsd, err: (err as Error).message, event: 'billing.controls.auto_reload_retry_failed' },
      'billing.controls: auto-reload retry failed — workspace remains suspended',
    );
  }
}

// ── Endpoint: /subscription-items/sync ────────────────────────────────────────
// Called by liftoff-billing on customer.subscription.created/updated.
// Fetches the Stripe subscription, classifies each line item, and upserts into
// subscription_items so platform-backend can resolve stripe_subscription_item_id
// when updating agent quantities or reporting overage OUs.

router.post('/subscription-items/sync', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { subscriptionId } = req.body ?? {};
  if (!subscriptionId) {
    res.status(400).json({ error: 'subscriptionId_required' });
    return;
  }

  try {
    await syncSubscriptionItems(subscriptionId);
    res.status(200).json({ ok: true });
  } catch (err) {
    log.error({ error: (err as Error).message, subscriptionId }, 'billing.controls: subscription-items/sync failed');
    res.status(500).json({ error: 'sync_failed' });
  }
});

// ── Endpoint: /entitlements/:accountId/activate ───────────────────────────────
// Called by customer.subscription.updated when an add-on is added.
// Resolves the entitlement_field from addon_catalog and sets it TRUE on the
// entitlements row for all tenants belonging to this account.

router.post('/entitlements/:accountId/activate', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { entitlementKey } = req.body;

  if (!entitlementKey) {
    res.status(400).json({ error: 'entitlementKey_required' });
    return;
  }

  try {
    await activateAddon(accountId, entitlementKey);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('Unknown addon key')) {
      res.status(404).json({ error: 'unknown_addon_key', key: entitlementKey });
      return;
    }
    log.error({ error: msg, accountId, entitlementKey }, 'billing.entitlements: activate failed');
    res.status(500).json({ error: 'activate_failed' });
    return;
  }
  log.info({ accountId, entitlementKey }, 'billing.entitlements: activate');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /entitlements/:accountId/deactivate ────────────────────────────
// Called by customer.subscription.updated when an add-on is removed.
// Resolves the entitlement_field from addon_catalog and sets it FALSE.

router.post('/entitlements/:accountId/deactivate', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { entitlementKey } = req.body;

  if (!entitlementKey) {
    res.status(400).json({ error: 'entitlementKey_required' });
    return;
  }

  try {
    await deactivateAddon(accountId, entitlementKey);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('Unknown addon key')) {
      res.status(404).json({ error: 'unknown_addon_key', key: entitlementKey });
      return;
    }
    log.error({ error: msg, accountId, entitlementKey }, 'billing.entitlements: deactivate failed');
    res.status(500).json({ error: 'deactivate_failed' });
    return;
  }
  log.info({ accountId, entitlementKey }, 'billing.entitlements: deactivate');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /threshold-check ────────────────────────────────────────────────
// Called by Cloud Tasks (billing-threshold-checks queue).
// Runs the optimistic-locking threshold check and optionally triggers a Stripe charge.

router.post('/threshold-check', async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.body;
  if (!accountId) {
    res.status(400).json({ error: 'accountId_required' });
    return;
  }

  try {
    await runThresholdCheck(accountId);
    res.status(200).json({ ok: true });
  } catch (err) {
    log.error({ err: (err as Error).message, accountId }, 'billing.threshold_check: failed');
    // 500 → Cloud Tasks will retry with exponential backoff
    res.status(500).json({ error: 'threshold_check_failed' });
  }
});

// ── Endpoint: /controls/:accountId/status ────────────────────────────────────
// Called by liftoff-billing's GET /api/billing/accounts/:id/current-usage.
// Returns current billing_controls state for display to account owners.

router.get('/controls/:accountId/status', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;

  const pool = getPool();
  const result = await pool.query(
    `SELECT account_id, current_period_spend_usd, next_threshold_usd,
            outstanding_balance_usd, suspended, suspended_reason, billing_tier, graduated_at,
            billing_period_start, spend_updated_at,
            threshold_charges_collected_usd, has_payment_method,
            billing_mode, plan_type,
            plan_included_ous, precommit_extra_ous, referral_bonus_ous,
            ous_consumed_this_period,
            included_rate_usd_per_ou, precommit_rate_usd_per_ou, reload_rate_usd_per_ou,
            reload_balance_usd,
            auto_reload_enabled, auto_reload_threshold_usd, auto_reload_amount_usd,
            stripe_subscription_id
     FROM billing_controls WHERE account_id = $1`,
    [accountId],
  );
  if (result.rows.length === 0) { res.status(404).json({ error: 'not_found' }); return; }
  const row = result.rows[0];
  res.status(200).json({
    accountId:                      row.account_id,
    currentPeriodSpendUsd:          parseFloat(row.current_period_spend_usd),
    nextThresholdUsd:               parseFloat(row.next_threshold_usd),
    outstandingBalanceUsd:          parseFloat(row.outstanding_balance_usd),
    suspended:                      row.suspended,
    suspendedReason:                row.suspended_reason ?? null,
    billingTier:                    row.billing_tier,
    graduated:                      !!row.graduated_at,
    billingPeriodStart:             row.billing_period_start,
    spendUpdatedAt:                 row.spend_updated_at,
    thresholdChargesCollectedUsd:   parseFloat(row.threshold_charges_collected_usd),
    hasPaymentMethod:               row.has_payment_method,
    billingMode:                    row.billing_mode,
    planType:                       row.plan_type ?? null,
    planIncludedOus:                Number(row.plan_included_ous),
    precommitExtraOus:              Number(row.precommit_extra_ous),
    // Reported on its own rather than folded into precommitExtraOus, so this
    // endpoint keeps saying what the columns actually hold. liftoff-billing
    // adds the two together where it reports the allowance to the billing tab,
    // which is the one surface the referred workspace is ever told about the
    // bonus on.
    referralBonusOus:               Number(row.referral_bonus_ous),
    ousConsumedThisPeriod:          parseFloat(row.ous_consumed_this_period),
    includedRateUsdPerOu:           parseFloat(row.included_rate_usd_per_ou),
    precommitRateUsdPerOu:          parseFloat(row.precommit_rate_usd_per_ou),
    reloadRateUsdPerOu:             parseFloat(row.reload_rate_usd_per_ou),
    reloadBalanceUsd:               parseFloat(row.reload_balance_usd),
    autoReloadEnabled:              row.auto_reload_enabled,
    autoReloadThresholdUsd:         row.auto_reload_threshold_usd != null ? parseFloat(row.auto_reload_threshold_usd) : null,
    autoReloadAmountUsd:            row.auto_reload_amount_usd     != null ? parseFloat(row.auto_reload_amount_usd)    : null,
    // Current-subscription pointer — consumed by liftoff-billing's daily
    // subscription reconciliation to detect dangling/mismatched pointers.
    stripeSubscriptionId:           row.stripe_subscription_id ?? null,
  });
});

// ── POST /tenants/:tenantId/operating-units ───────────────────────────────────
// Called by liftoff-billing to fetch OU consumption for a billing period.
// Body: { since: ISO string, until: ISO string }
// Returns customer-visible OU data — no cost_usd, tokens, or model names exposed.

router.post('/tenants/:tenantId/operating-units', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req.params;
  const { since, until } = req.body ?? {};
  if (!since || !until) { res.status(400).json({ error: 'since and until are required' }); return; }
  const sinceDate = new Date(since as string);
  const untilDate = new Date(until as string);
  if (isNaN(sinceDate.getTime()) || isNaN(untilDate.getTime())) {
    res.status(400).json({ error: 'invalid since or until date' }); return;
  }
  const result = await getOperatingUnitsForPeriod(tenantId, sinceDate, untilDate);
  res.status(200).json({
    totalOusConsumed:             result.totalOusConsumed,
    platformAnalyticsOusConsumed: result.platformAnalyticsOusConsumed,
    byAgent: result.byAgent.map(a => ({ agentId: a.agentId, agentName: a.agentName, ousConsumed: a.ousConsumed })),
  });
});

// ── Endpoint: /accounts/:accountId/headcount ─────────────────────────────────
// Called by CS when a customer's company headcount changes.
// Updates accounts.headcount and syncs the platform fee subscription item in Stripe:
//   quantity = new headcount, price swapped if the account crossed a tier boundary.

router.post('/accounts/:accountId/headcount', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { headcount } = req.body;

  if (typeof headcount !== 'number' || !Number.isInteger(headcount) || headcount < 0) {
    res.status(400).json({ error: 'headcount must be a non-negative integer' });
    return;
  }

  const pool = getPool();
  await pool.query(
    `UPDATE accounts SET headcount = $2, updated_at = NOW() WHERE id = $1`,
    [accountId, headcount],
  );

  // Sync Stripe subscription item quantity and tier asynchronously — non-fatal if Stripe is down.
  updatePlatformFeeQuantity(accountId).catch((err: Error) =>
    log.warn({ error: err.message, accountId, headcount }, 'billing.headcount: updatePlatformFeeQuantity failed (non-fatal)'),
  );

  log.info({ accountId, headcount }, 'billing.accounts: headcount updated');
  res.status(200).json({ ok: true });
});

// ── Endpoint: /controls/:accountId/auto-reload-failed ────────────────────────
// Called by liftoff-billing when stripe.invoices.pay() fails during auto-reload flow.
// Suspends the account with suspended_reason = 'auto_reload_failed'.

router.post('/controls/:accountId/auto-reload-failed', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { accountId } = req.params;
  const { amountUsd, reason, paymentMethodType, paymentMethodLast4 } = req.body as {
    amountUsd?: number;
    reason?: string;
    paymentMethodType?: 'card' | 'us_bank_account';
    paymentMethodLast4?: string;
  };

  const pool = getPool();
  await pool.query(
    `UPDATE billing_controls SET
       suspended        = TRUE,
       suspended_reason = 'auto_reload_failed',
       updated_at       = NOW()
     WHERE account_id = $1`,
    [accountId],
  );

  invalidateExecutionCache(accountId);
  notifyPaymentFailed(accountId, 'auto_reload', {
    amountUsd: amountUsd ?? 0,
    paymentMethodType,
    paymentMethodLast4,
  }).catch(() => {});

  log.warn({ accountId, amountUsd, reason }, 'billing.controls: auto-reload-failed — account suspended');
  res.status(200).json({ ok: true });
});

// ── Endpoint: PUT /controls/by-tenant/:tenantId/auto-reload-settings ─────────
// Updates auto-reload settings for a pre-pay account identified by tenantId.
// Note: `:tenantId` param does NOT start with `cus_` so accountId middleware won't fire.

router.put('/controls/by-tenant/:tenantId/auto-reload-settings', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req.params;
  const { enabled, thresholdUsd, amountUsd } = req.body;

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled_required' });
    return;
  }
  if (enabled) {
    // Kept equal to the settings page and to migration 542's CHECK.
    if (typeof thresholdUsd !== 'number' || !Number.isFinite(thresholdUsd) || thresholdUsd < 1) {
      res.status(400).json({ error: 'thresholdUsd_must_be_at_least_1' });
      return;
    }
    if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 5) {
      res.status(400).json({ error: 'amountUsd_must_be_at_least_5' });
      return;
    }
  }

  const pool = getPool();

  // Resolve tenantId → accountId
  const tenantResult = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (!tenantResult.rows[0]) {
    res.status(404).json({ error: 'tenant_not_found' });
    return;
  }
  const accountId = tenantResult.rows[0].account_id;

  // Guard: only pre-pay accounts can have auto-reload settings
  const modeResult = await pool.query<{ billing_mode: string }>(
    `SELECT billing_mode FROM billing_controls WHERE account_id = $1`,
    [accountId],
  );
  if (!modeResult.rows[0] || modeResult.rows[0].billing_mode !== 'pre_pay') {
    res.status(400).json({ error: 'not_pre_pay' });
    return;
  }

  if (enabled) {
    await pool.query(
      `UPDATE billing_controls SET
         auto_reload_enabled       = TRUE,
         auto_reload_threshold_usd = $2,
         auto_reload_amount_usd    = $3,
         agents_stalled_notified_at = CASE
           WHEN auto_reload_enabled = FALSE THEN NULL
           ELSE agents_stalled_notified_at
         END,
         updated_at                = NOW()
       WHERE account_id = $1 AND billing_mode = 'pre_pay'`,
      [accountId, thresholdUsd, amountUsd],
    );
    log.info({ accountId, tenantId, thresholdUsd, amountUsd }, 'billing.controls: auto-reload-settings enabled');
  } else {
    await pool.query(
      `UPDATE billing_controls SET
         auto_reload_enabled = FALSE,
         updated_at          = NOW()
       WHERE account_id = $1 AND billing_mode = 'pre_pay'`,
      [accountId],
    );
    log.info({ accountId, tenantId }, 'billing.controls: auto-reload disabled');
  }
  res.status(200).json({ ok: true });
});

// ── Endpoint: GET /controls/by-tenant/:tenantId/auto-reload-settings ─────────
// Returns auto-reload settings for a tenantId (resolved to accountId internally).

router.get('/controls/by-tenant/:tenantId/auto-reload-settings', rateLimit, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req.params;
  const pool = getPool();

  // Resolve tenantId → accountId
  const tenantResult = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (!tenantResult.rows[0]) {
    res.status(404).json({ error: 'tenant_not_found' });
    return;
  }
  const accountId = tenantResult.rows[0].account_id;

  const result = await pool.query<{
    billing_mode: string;
    auto_reload_enabled: boolean;
    auto_reload_threshold_usd: string | null;
    auto_reload_amount_usd: string | null;
    reload_balance_usd: string;
  }>(
    `SELECT billing_mode, auto_reload_enabled, auto_reload_threshold_usd,
            auto_reload_amount_usd, reload_balance_usd
     FROM billing_controls WHERE account_id = $1`,
    [accountId],
  );

  if (!result.rows[0]) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const row = result.rows[0];
  // After Migration B, reload_balance_usd is the only credit field. Surface it
  // under both the new key and the legacy `prepaidBalanceUsd` alias for any
  // in-flight billing callers still expecting the old name.
  res.status(200).json({
    billingMode:       row.billing_mode,
    autoReloadEnabled: row.auto_reload_enabled,
    thresholdUsd:      row.auto_reload_threshold_usd != null ? parseFloat(row.auto_reload_threshold_usd) : null,
    amountUsd:         row.auto_reload_amount_usd != null ? parseFloat(row.auto_reload_amount_usd) : null,
    reloadBalanceUsd:  parseFloat(row.reload_balance_usd),
    prepaidBalanceUsd: parseFloat(row.reload_balance_usd),
  });
});

export { router as billingControlsInternalRouter };

// ─── Fused onboarding ──────────────────────────────────────────────────
// POST /restart-full-distill/:tenantId — REMOVED (ADR-050).
//
// The Stripe-webhook consumer in liftoff-billing called this on the first paid
// invoice to run the distill of whatever the customer had assembled during
// onboarding. That work only existed because the hire happened before the card;
// it now happens after onboarding, where the distill runs directly.
//
// Removed rather than left answering 200: the caller was deleted in the same
// change (liftoff-billing stripe-event-processor onInvoicePaid), so a shim here
// would guard nothing and would keep reading onboarding_hire_input — a column
// being dropped, which would then 42703 in the window between that migration
// and the new revision.
