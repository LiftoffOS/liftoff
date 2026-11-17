// Billing accounts REST endpoints — all /api/billing/accounts/:tenantId/* routes.
//
// Auth is handled upstream: platform-backend's billing proxy verifies tenant
// membership before forwarding.
//
// Defense-in-depth: all routes in this router additionally validate the
// X-Service-Auth header against billingServiceToken.  PB's billing-proxy always
// sends this header (serviceAuthEnvVar: 'BILLING_SERVICE_TOKEN').  This catches
// requests that bypass GCP OIDC (e.g. metadata server failures).

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import Stripe from 'stripe';
import type { Pool } from 'pg';
import { withTenantScope } from '@liftoffos/database';
import type { TenantScopedClient } from '@liftoffos/database';
import { PlatformBackendClient, PlatformBackendError, validateInboundBillingHmac } from './infrastructure/platform-backend-client.js';
import { provisionForTenant } from './routes/provision.js';
import { replaceSubscriptionForTenant, SubscriptionCancelTimeoutError } from './routes/subscription-replace.js';
import { checkPromoEligibility } from './promo-eligibility.js';
import { classifyInvoice, upsertInvoice } from './consumers/stripe-event-processor.js';

// Self-serve plan configuration: base OU allocations and monthly prices.
//
// THIS IS THE ALLOWANCE AUTHORITY, not platform-backend's `plan_catalog`.
// `basePlanOus` is stamped into the Stripe subscription's `included_ous`
// metadata; the event processor reads it back off the subscription and forwards
// it to platform-backend's `subscription-activated`, which writes
// `billing_controls.plan_included_ous` from the forwarded value. Platform-backend
// reads only the three RATES from `plan_catalog` and never its `included_ous`.
// Changing that table alone cannot reprice anyone, and is reverted the next time
// a `customer.subscription.updated` event re-reads this metadata.
//
// The pair is what sets gross margin, and the ALLOWANCE is the half that moves.
// One OU costs the platform one cent, so margin at full consumption is
// `(basePlanCents - basePlanOus) / basePlanCents` — 30% / 27% / 24% as these
// stand. Repricing by raising the allowance against a fixed `basePlanCents`
// keeps every Stripe price object valid; repricing by moving `basePlanCents`
// means creating new ones, because Stripe prices are immutable.
export const SELF_SERVE_PLANS = {
  core:   { basePlanOus: 1400,  basePlanCents: 2000  },
  growth: { basePlanOus: 3650,  basePlanCents: 5000  },
  scale:  { basePlanOus: 15200, basePlanCents: 20000 },
} as const;

/** What one PRECOMMIT Operating Unit adds to the monthly fee, in cents — the
 *  slider's "extra OUs" above a plan's base allowance, baked into the
 *  subscription price rather than drawn from the prepaid wallet.
 *
 *  The cent form of `plan_catalog.precommit_rate_usd_per_ou` in platform-backend
 *  and of `EXTRA_OU_PRICE` on liftoff-react's pricing page. The three are one
 *  number in three planes and must be changed together.
 *
 *  It has to stay BELOW the reload rate (1.6129 cents). Precommit exists to buy
 *  a discount for committing in advance; at or above the uncommitted rate the
 *  slider sells a worse deal than doing nothing.
 *
 *  And it has to be a ROUND FRACTION OF A DOLLAR. A whole dollar of precommit
 *  buys 100/this many Operating Units, so at 1.5 cents a thousand units cost
 *  exactly $15.00 and every slider stop carries a whole-dollar price. At
 *  1.5217 a whole dollar bought 65.72 units and no round quantity had a round
 *  price. */
const PRECOMMIT_CENTS_PER_OU = 1.5;

// Resolves the persistent Stripe product ID for a (plan, billing period) pair
// by retrieving the configured persistent price and reading its product.
// Cached at module scope: product IDs are stable and never re-keyed.
const PERSISTENT_PRODUCT_ID_CACHE = new Map<string, string>();

async function getPersistentProductId(
  stripe: Stripe,
  planId: 'core' | 'growth' | 'scale',
  billingPeriod: 'monthly' | 'yearly',
): Promise<string | null> {
  const key = `${planId}:${billingPeriod}`;
  const cached = PERSISTENT_PRODUCT_ID_CACHE.get(key);
  if (cached) return cached;
  const envVar = `STRIPE_PLAN_${planId.toUpperCase()}_${billingPeriod === 'monthly' ? 'MONTHLY' : 'ANNUAL'}_PRICE_ID`;
  const priceId = process.env[envVar];
  if (!priceId) return null;
  const price = await stripe.prices.retrieve(priceId);
  const productId = typeof price.product === 'string' ? price.product : price.product.id;
  PERSISTENT_PRODUCT_ID_CACHE.set(key, productId);
  return productId;
}

// Shared promo-code validator used by /subscribe (submit-time, defense-in-depth)
// and /promo/lookup (frontend blur-time affirmation). Mirrors what Stripe would
// decide at subscription create time: rejects unknown / inactive / expired /
// non-`once` coupons, and surfaces the `applies_to.products` scope so a code
// scoped to one plan doesn't silently apply $0 on another.
//
// `expand: ['data.coupon.applies_to']` is critical — Stripe omits `applies_to`
// from the default Coupon shape, so without the fully-qualified nested expand
// `coupon.applies_to` is `undefined` at runtime and the product-scope check
// silently bypasses.
type PromoLookupResult =
  | { kind: 'invalid_promo_code' }
  | { kind: 'promo_code_not_applicable' }
  | { kind: 'valid'; promotionCodeId: string; amountOffCents: number | null };

// Predicate for /subscribe's promo-discount catch: only label a
// StripeInvalidRequestError as `invalid_promo_code` when the failure actually
// concerns the discount/coupon/promotion_code surface. Without this guard the
// catch swallowed unrelated rejections (e.g. an unsupported invoice_settings
// param) and reported them as a bad promo, which sent users to re-check a
// valid code. Matches both the param-path (Stripe's `param`) and the message
// substrings used by Stripe for promo/coupon validation failures.
function isPromoRelatedStripeError(err: Stripe.errors.StripeError): boolean {
  const param = err.param ?? '';
  if (param.startsWith('discounts') || param.startsWith('coupon') || param.startsWith('promotion_code')) {
    return true;
  }
  const message = (err.message ?? '').toLowerCase();
  return message.includes('coupon') || message.includes('promotion code') || message.includes('promotion_code');
}

async function lookupPromotionCode(
  stripe: Stripe,
  code: string,
  persistentProductId: string,
): Promise<PromoLookupResult> {
  const matches = await stripe.promotionCodes.list({
    code,
    active: true,
    limit: 1,
    expand: ['data.coupon.applies_to'],
  });
  const promo = matches.data[0];
  if (!promo) return { kind: 'invalid_promo_code' };
  const coupon = promo.coupon;
  if (coupon?.duration !== 'once') return { kind: 'invalid_promo_code' };
  const allowedProductIds = coupon.applies_to?.products;
  if (allowedProductIds && allowedProductIds.length > 0 && !allowedProductIds.includes(persistentProductId)) {
    return { kind: 'promo_code_not_applicable' };
  }
  return {
    kind: 'valid',
    promotionCodeId: promo.id,
    amountOffCents: coupon.amount_off ?? null,
  };
}

export interface BillingAccountsDeps {
  pool: Pool;
  stripe: Stripe;
  pbClient: PlatformBackendClient;
  billingServiceToken: string;
  log: { info: (msg: string, meta?: object) => void; warn: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void };
}

// Sets app.current_tenant_id in a transaction-scoped context then runs fn.
// Required before any query on RLS-enabled tables (subscriptions, invoices, etc.).
//
// Delegates rather than reimplementing. This was a third hand-written copy of
// BEGIN / set_config / COMMIT, after the shared withTenantScope and billing's
// own withBillingTenant. Three copies of one rule is three places for it to
// drift, and this one passed the RLS fence only because its name happens to
// match a default wrapper — a coincidence, not a decision. The signature is
// kept so its eight call sites and their tests are untouched; only the body
// is gone.
async function withTenantContext<T>(pool: Pool, tenantId: string, fn: (client: TenantScopedClient) => Promise<T>): Promise<T> {
  return withTenantScope(pool, tenantId, { rlsVariableName: 'app.current_tenant_id' }, fn);
}

// Resolve stripeCustomerId from tenant — subscriptions table keyed by tenant_id.
//
// Returns the customer regardless of subscription status. The stripe_customer_id
// is stable across a tenant's lifetime — every subscription created for the
// same tenant is billed to the same customer — so filtering by status would
// leave the resolver blind during transient "no active sub" windows. Those
// windows are now reachable:
//
//   * A /subscribe call cancels an auto-provisioned sub before creating the
//     real one (the self_serve auto-replace branch in provisionForTenant). If
//     the create fails, the tenant is left with only a canceled row. The
//     next /subscribe retry needs to find the customer to recreate.
//   * A user cancels their plan and later resubscribes via /subscribe.
//
// Callers that specifically want the "active subscription customer" should
// query the subscriptions table directly with a status filter rather than
// repurposing this helper.
async function resolveStripeCustomer(pool: Pool, tenantId: string): Promise<string | null> {
  return withTenantContext(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ stripe_customer_id: string }>(
      `SELECT stripe_customer_id FROM subscriptions
       WHERE tenant_id = $1
       ORDER BY updated_at DESC LIMIT 1`,
      [tenantId],
    );
    return rows[0]?.stripe_customer_id ?? null;
  });
}

/**
 * The account's Stripe customer, for routes that must work before any
 * subscription exists.
 *
 * `resolveStripeCustomer` reads this service's own `subscriptions` table, which
 * is empty for a workspace funding itself with credit instead of subscribing.
 * platform-backend's proxy forwards the customer id from the account itself on
 * these routes, so falling back to the header is what lets such a workspace buy
 * credit, see its balance and show the card it already has on file — rather
 * than being answered as though billing were not set up.
 *
 * Only for routes where that is the right answer. A route that operates ON a
 * subscription should keep refusing when there is none.
 */
async function resolveCustomerForUnsubscribed(
  pool: Pool,
  tenantId: string,
  req: FastifyRequest,
): Promise<string | null> {
  return (
    (await resolveStripeCustomer(pool, tenantId)) ??
    (req.headers['x-account-stripe-customer-id'] as string | undefined) ??
    null
  );
}

// Allowed returnUrl origins for the Customer Portal (SE-003 fix — prevent open redirect).
const ALLOWED_RETURN_URL_PREFIXES = [
  'https://example.com',
  'https://app.example.com',
  'https://liftoff-react-YOUR_PROJECT_HASH-uw.a.run.app',
  'http://localhost:5173',  // local dev
];

function isAllowedReturnUrl(url: string): boolean {
  return ALLOWED_RETURN_URL_PREFIXES.some(p => url.startsWith(p));
}

export function registerBillingAccountsRouter(app: FastifyInstance, deps: BillingAccountsDeps): void {
  const { pool, stripe, pbClient, billingServiceToken, log } = deps;

  // Validate X-Service-Auth for all routes owned by this router.
  // PB's billing-proxy always sends this header (serviceAuthEnvVar: 'BILLING_SERVICE_TOKEN').
  // Defense-in-depth: rejects requests that bypass GCP OIDC (e.g. metadata server failures).
  //
  // NOTE: this router is registered directly on the top-level app (not in an encapsulated
  // plugin scope), so addHook would apply globally.  We guard by URL prefix to avoid
  // interfering with /api/internal/*, /stripe/*, /health, /ready, and RPC routes.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/billing/')) return;
    const token = req.headers['x-service-auth'];
    if (!token || token !== billingServiceToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // HMAC preHandler for inbound PB→billing calls on /api/internal/billing/*
  // routes registered below. Mirrors the pattern in routes/subscription-replace.ts.
  const hmacPre = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const method = req.method;
    const path = req.url.split('?')[0];
    const body = JSON.stringify((req.body as object) ?? {});
    const headers = {
      timestamp: req.headers['x-billing-timestamp'] as string | undefined,
      signature: req.headers['x-billing-signature'] as string | undefined,
    };
    if (!validateInboundBillingHmac(method, path, body, headers, billingServiceToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  // ── GET /api/billing/accounts/:tenantId/overview ───────────────────────────
  // Combined subscription + billing controls + payment method status.
  app.get<{ Params: { tenantId: string } }>(
    '/api/billing/accounts/:tenantId/overview',
    async (req, reply) => {
      const { tenantId } = req.params;
      try {
        const stripeCustomerId = await resolveCustomerForUnsubscribed(pool, tenantId, req);
        if (!stripeCustomerId) {
          // Tenant exists but billing isn't set up yet (e.g., synchronous
          // provisionSubscription failed and the outbox is retrying, or the
          // tenant was created before the auto-provision chain ran). Return
          // 200 with safe defaults so the dashboard renders cleanly. No
          // banner is shown — the dashboard only acts on executionBlocked.
          return reply.code(200).send({
            subscription: null,
            currentPeriodSpendUsd: 0,
            nextThresholdUsd: 100,
            outstandingBalanceUsd: 0,
            executionBlocked: false,
            billingTier: 'standard',
            graduated: false,
            billingPeriodStart: null,
            hasPaymentMethod: false,
            billingMode: 'post_pay',
            planType: null,
            // After Migration B: USD allocation no longer exists. Surface the
            // OU-native allotment + consumption fields so callers that want a
            // "remaining capacity" can compute it themselves.
            planIncludedOus: 0,
            precommitExtraOus: 0,
            ousConsumedThisPeriod: 0,
            reloadBalanceUsd: 0,
            suspendedReason: null,
          });
        }

        const [subRow, controls, pmResult] = await Promise.all([
          withTenantContext(pool, tenantId, (client) => client.query<{
            stripe_subscription_id: string;
            status: string;
            plan_id: string;
            current_period_end: string;
            cancel_at_period_end: boolean;
          }>(
            `SELECT stripe_subscription_id, status, plan_id, current_period_end, cancel_at_period_end
             FROM subscriptions WHERE tenant_id = $1 AND stripe_customer_id = $2
             ORDER BY updated_at DESC LIMIT 1`,
            [tenantId, stripeCustomerId],
          )),
          pbClient.getControlsStatus(stripeCustomerId),
          stripe.customers.listPaymentMethods(stripeCustomerId, { limit: 1 }).catch(() => ({ data: [] as Stripe.PaymentMethod[] })),
        ]);

        const sub = subRow.rows[0] ?? null;
        return reply.code(200).send({
          subscription: sub ? {
            stripeSubscriptionId: sub.stripe_subscription_id,
            status: sub.status,
            planId: sub.plan_id,
            currentPeriodEnd: sub.current_period_end,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          } : null,
          currentPeriodSpendUsd: controls?.currentPeriodSpendUsd ?? 0,
          nextThresholdUsd: controls?.nextThresholdUsd ?? 100,
          outstandingBalanceUsd: controls?.outstandingBalanceUsd ?? 0,
          executionBlocked: controls?.suspended ?? false,
          billingTier: controls?.billingTier ?? 'standard',
          graduated: controls?.graduated ?? false,
          billingPeriodStart: controls?.billingPeriodStart ?? null,
          hasPaymentMethod: pmResult.data.length > 0,
          billingMode: controls?.billingMode ?? 'post_pay',
          planType: controls?.planType ?? null,
          // OU-native allotment + consumption (replaces the dropped USD-based
          // allocationBalanceUsd computation that depended on prepaid_balance_usd).
          planIncludedOus:       controls?.planIncludedOus ?? 0,
          // The referee half of the referral programme is folded in here rather
          // than reported beside it. The billing tab renders one allowance —
          // planIncludedOus + precommitExtraOus — and a bonus in a bucket that
          // page does not read means the referred workspace is never told it
          // was granted, so the share message's promise of bonus usage is never
          // visibly kept. This is the only surface the referred party gets, by
          // decision, which is what makes the fold load-bearing rather than
          // cosmetic.
          precommitExtraOus:     (controls?.precommitExtraOus ?? 0) + (controls?.referralBonusOus ?? 0),
          ousConsumedThisPeriod: controls?.ousConsumedThisPeriod ?? 0,
          reloadBalanceUsd: controls?.reloadBalanceUsd ?? 0,
          suspendedReason: controls?.suspendedReason ?? null,
        });
      } catch (err) {
        log.error('billing.accounts.overview: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'overview_failed' });
      }
    },
  );

  // ── GET /api/billing/accounts/:tenantId/invoices ───────────────────────────
  // Reads from local invoices table (PR 4) — no longer hits Stripe per request.
  //
  // Filter rationale: show every real billing event, INCLUDING $0 ones.
  // A $0 invoice (e.g. an enterprise/comped plan, or a 100%-off promo) is a
  // legitimate record the customer needs — it's their proof, per billing
  // period, that they were billed and charged nothing, and what they hand to
  // their finance team. We previously hid $0/$0/$0 invoices behind an
  // `amount > 0` filter; that wrongly suppressed entire billing histories for
  // comped accounts. Removed.
  //
  // Scope is the type filter only: subscription cycles (incl.
  // subscription_create + subscription_update — see classifyInvoice in
  // stripe-event-processor.ts) and prepaid reloads — i.e. customer-facing
  // billing periods. Threshold/recovery/unknown remain hidden from the
  // standard list.
  app.get<{
    Params: { tenantId: string };
    Querystring: { limit?: string; cursor?: string };
  }>(
    '/api/billing/accounts/:tenantId/invoices',
    async (req, reply) => {
      const { tenantId } = req.params;
      const limit  = Math.min(parseInt(req.query.limit ?? '10', 10), 100);
      const cursor = req.query.cursor;     // ISO timestamp now
      try {
        const result = await withTenantContext(pool, tenantId, (client) => client.query<{
          id: string;
          stripe_invoice_id: string;
          status: string;
          amount_due_cents: string;
          amount_paid_cents: string;
          subtotal_cents: string;
          discount_cents: string;
          currency: string;
          period_end: Date | null;
          issued_at: Date;
          paid_at: Date | null;
          type: string;
          hosted_invoice_url: string | null;
          invoice_pdf: string | null;
        }>(
          `SELECT id, stripe_invoice_id, status, amount_due_cents, amount_paid_cents,
                  subtotal_cents, discount_cents,
                  currency, period_end, issued_at, paid_at, type,
                  hosted_invoice_url, invoice_pdf
             FROM invoices
            WHERE tenant_id = $1
              AND type IN ('subscription_cycle','prepaid_reload')
              ${cursor ? 'AND issued_at < $3' : ''}
            ORDER BY issued_at DESC
            LIMIT $2`,
          cursor ? [tenantId, limit + 1, new Date(cursor)] : [tenantId, limit + 1],
        ));

        const rows = result.rows;
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);

        return reply.code(200).send({
          invoices: page.map(r => ({
            id: r.id,
            number: r.stripe_invoice_id,
            amountDue: Number(r.amount_due_cents),
            amountPaid: Number(r.amount_paid_cents),
            subtotal: Number(r.subtotal_cents),
            discount: Number(r.discount_cents),
            status: r.status,
            created: Math.floor(r.issued_at.getTime() / 1000),
            periodEnd: r.period_end ? Math.floor(r.period_end.getTime() / 1000) : null,
            hostedInvoiceUrl: r.hosted_invoice_url,
            invoicePdf:       r.invoice_pdf,
            planType: null,
            allocatedOus: null,
            billingPeriod: null,
            type: r.type,
          })),
          hasMore,
          nextCursor: hasMore ? page[page.length - 1].issued_at.toISOString() : null,
        });
      } catch (err) {
        log.error('billing.accounts.invoices: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'invoices_failed' });
      }
    },
  );

  // ── GET /api/billing/accounts/:tenantId/upcoming-invoice ──────────────────
  // Returns 200 with `null` body for unprovisioned tenants (or when Stripe has
  // no upcoming invoice), per implementation plan §3.2 — all four billing
  // overview endpoints serve safe defaults so the dashboard renders cleanly
  // during the brief window between tenant creation and provisionSubscription.
  app.get<{ Params: { tenantId: string } }>(
    '/api/billing/accounts/:tenantId/upcoming-invoice',
    async (req, reply) => {
      const { tenantId } = req.params;
      try {
        const stripeCustomerId = await resolveStripeCustomer(pool, tenantId);
        if (!stripeCustomerId) {
          return reply.code(200).send(null);
        }
        try {
          const upcoming = await stripe.invoices.retrieveUpcoming({ customer: stripeCustomerId });
          return reply.code(200).send({
            amountDue: upcoming.amount_due,
            periodEnd: upcoming.period_end,
            nextPaymentAttempt: upcoming.next_payment_attempt,
          });
        } catch (stripeErr: unknown) {
          const stripeCode = (stripeErr as Stripe.errors.StripeError).statusCode;
          if (stripeCode === 404) {
            return reply.code(200).send(null);
          }
          throw stripeErr;
        }
      } catch (err) {
        log.error('billing.accounts.upcoming-invoice: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'upcoming_invoice_failed' });
      }
    },
  );

  // ── GET /api/billing/accounts/:tenantId/payment-methods ───────────────────
  app.get<{ Params: { tenantId: string } }>(
    '/api/billing/accounts/:tenantId/payment-methods',
    async (req, reply) => {
      const { tenantId } = req.params;
      try {
        const stripeCustomerId = await resolveCustomerForUnsubscribed(pool, tenantId, req);
        if (!stripeCustomerId) {
          return reply.code(200).send({ paymentMethods: [] });
        }
        const [pmList, customer] = await Promise.all([
          stripe.customers.listPaymentMethods(stripeCustomerId),
          stripe.customers.retrieve(stripeCustomerId),
        ]);
        const defaultPmId = (!customer.deleted && typeof customer.invoice_settings?.default_payment_method === 'string')
          ? customer.invoice_settings.default_payment_method
          : null;
        return reply.code(200).send({
          paymentMethods: pmList.data.map(pm => ({
            id: pm.id,
            brand: pm.card?.brand ?? 'unknown',
            last4: pm.card?.last4 ?? '****',
            expMonth: pm.card?.exp_month ?? 0,
            expYear: pm.card?.exp_year ?? 0,
            isDefault: pm.id === defaultPmId,
          })),
        });
      } catch (err) {
        log.error('billing.accounts.payment-methods: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'payment_methods_failed' });
      }
    },
  );

  // ── GET /api/billing/accounts/:tenantId/current-usage ─────────────────────
  // Defaults for unprovisioned tenants — all rates 0 because the tenant has no plan yet.
  // The frontend shows no Plan Usage / Credit Balance sections when planIncludedOus=0
  // and billingMode='post_pay'.
  const NO_USAGE_DEFAULT = {
    accountId: '',
    currentPeriodSpendUsd: 0,
    nextThresholdUsd: 100,
    outstandingBalanceUsd: 0,
    suspended: false,
    executionBlocked: false,
    billingTier: 'standard',
    graduated: false,
    billingPeriodStart: null,
    spendUpdatedAt: null,
    thresholdChargesCollectedUsd: 0,
    hasPaymentMethod: false,
    billingMode: 'post_pay' as const,
    planType: null,
    planIncludedOus: 0,
    precommitExtraOus: 0,
    ousConsumedThisPeriod: 0,
    includedRateUsdPerOu:  0,
    precommitRateUsdPerOu: 0,
    reloadRateUsdPerOu:    0,
    reloadBalanceUsd: 0,
    autoReloadEnabled: false,
    autoReloadThresholdUsd: null,
    autoReloadAmountUsd: null,
    suspendedReason: null,
  };

  app.get<{ Params: { tenantId: string } }>(
    '/api/billing/accounts/:tenantId/current-usage',
    async (req, reply) => {
      const { tenantId } = req.params;
      try {
        const stripeCustomerId = await resolveCustomerForUnsubscribed(pool, tenantId, req);
        if (!stripeCustomerId) return reply.code(200).send(NO_USAGE_DEFAULT);

        const [controls, pmResult] = await Promise.all([
          pbClient.getControlsStatus(stripeCustomerId),
          stripe.customers.listPaymentMethods(stripeCustomerId, { limit: 1 })
            .catch(() => ({ data: [] as Stripe.PaymentMethod[] })),
        ]);
        if (!controls) {
          return reply.code(200).send({ ...NO_USAGE_DEFAULT, hasPaymentMethod: pmResult.data.length > 0 });
        }
        return reply.code(200).send({
          ...controls,
          // Same fold as /overview, and this is the endpoint that actually
          // matters for it: SettingsPage reads allocatedOus from
          // currentUsage.planIncludedOus + currentUsage.precommitExtraOus.
          precommitExtraOus: (controls.precommitExtraOus ?? 0) + (controls.referralBonusOus ?? 0),
          executionBlocked: controls.suspended,
          hasPaymentMethod: pmResult.data.length > 0,
        });
      } catch (err) {
        log.error('billing.accounts.current-usage: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'current_usage_failed' });
      }
    },
  );

  // ── GET /api/billing/accounts/:tenantId/live-state (SSE) ─────────────────
  // Sends current billing state immediately on connect, polls every 10s for
  // changes, heartbeats every 30s. Frontend falls back to 60s refetchInterval
  // when the SSE connection drops.
  app.get<{ Params: { tenantId: string } }>(
    '/api/billing/accounts/:tenantId/live-state',
    async (req, reply) => {
      const { tenantId } = req.params;

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.hijack();

      let closed = false;
      req.raw.on('close', () => { closed = true; });

      const sendState = async (): Promise<void> => {
        if (closed || reply.raw.destroyed) return;
        const stripeCustomerId = await resolveStripeCustomer(pool, tenantId).catch(() => null);
        if (!stripeCustomerId) return;
        const controls = await pbClient.getControlsStatus(stripeCustomerId).catch(() => null);
        if (!controls) return;
        if (closed || reply.raw.destroyed) return;
        const payload = JSON.stringify({
          currentPeriodSpendUsd: controls.currentPeriodSpendUsd,
          outstandingBalanceUsd: controls.outstandingBalanceUsd,
          suspended: controls.suspended,
          nextThresholdUsd: controls.nextThresholdUsd,
        });
        reply.raw.write(`event: billing_state\ndata: ${payload}\n\n`);
      };

      // Send initial state immediately
      await sendState().catch(() => {});

      const pollInterval = setInterval(() => {
        if (closed || reply.raw.destroyed) { clearInterval(pollInterval); return; }
        sendState().catch(() => {});
      }, 10_000);

      const heartbeat = setInterval(() => {
        if (closed || reply.raw.destroyed) { clearInterval(heartbeat); return; }
        reply.raw.write(': heartbeat\n\n');
      }, 30_000);

      req.raw.on('close', () => {
        clearInterval(pollInterval);
        clearInterval(heartbeat);
        if (!reply.raw.destroyed) reply.raw.end();
      });

      // Return the raw reply so Fastify doesn't auto-send anything
      return reply;
    },
  );

  // ── POST /api/billing/accounts/:tenantId/setup-intent ────────────────────
  // Creates a Stripe SetupIntent so the frontend can collect a new payment
  // method inline without redirecting to the Customer Portal.
  app.post<{ Params: { tenantId: string } }>(
    '/api/billing/accounts/:tenantId/setup-intent',
    async (req, reply) => {
      const { tenantId } = req.params;
      try {
        const stripeCustomerId =
          (await resolveStripeCustomer(pool, tenantId)) ??
          (req.headers['x-account-stripe-customer-id'] as string | undefined) ??
          null;
        if (!stripeCustomerId) {
          return reply.code(404).send({ error: 'no_active_subscription' });
        }
        const intent = await stripe.setupIntents.create({
          customer: stripeCustomerId,
          // Both card and ACH so the frontend PaymentElement can offer either.
          // ACH for US bank account must also be enabled in the Stripe
          // Dashboard for this account; if it isn't, Stripe ignores the
          // additional type and only card surfaces in the iframe.
          payment_method_types: ['card', 'us_bank_account'],
        });
        return reply.code(200).send({ clientSecret: intent.client_secret });
      } catch (err) {
        log.error('billing.accounts.setup-intent: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'setup_intent_failed' });
      }
    },
  );

  // ── POST /api/billing/accounts/:tenantId/retry-outstanding-charge ─────────
  // Creates a recovery Stripe invoice for the outstanding balance on a suspended account.
  // The invoice.payment_succeeded webhook will call pbClient.recoverySucceeded() to
  // clear the suspension if payment succeeds.
  app.post<{ Params: { tenantId: string } }>(
    '/api/billing/accounts/:tenantId/retry-outstanding-charge',
    async (req, reply) => {
      const { tenantId } = req.params;
      try {
        const stripeCustomerId = await resolveStripeCustomer(pool, tenantId);
        if (!stripeCustomerId) {
          return reply.code(404).send({ error: 'no_active_subscription' });
        }

        const controls = await pbClient.getControlsStatus(stripeCustomerId);
        if (!controls) {
          return reply.code(404).send({ error: 'billing_controls_not_found' });
        }
        if (!controls.suspended || controls.outstandingBalanceUsd <= 0) {
          return reply.code(400).send({ error: 'no_outstanding_balance' });
        }

        const amountCents = Math.round(controls.outstandingBalanceUsd * 100);

        // The recovery Invoice FIRST, then its line item bound to it by id.
        // metadata.type='recovery' is required so classifyInvoice() in
        // stripe-event-processor.ts routes it correctly.
        //
        // Creating the item first relies on `pending_invoice_items_behavior`,
        // which defaults to `exclude` on this account, so the invoice came out
        // with no lines and a $0 total — a recovery that collects nothing on an
        // account that owes money.
        const invoice = await stripe.invoices.create({
          customer: stripeCustomerId,
          metadata: { type: 'recovery', tenant_id: tenantId },
          auto_advance: false,
        });

        await stripe.invoiceItems.create({
          customer: stripeCustomerId,
          invoice: invoice.id,
          amount: amountCents,
          currency: 'usd',
          description: `Outstanding balance recovery ($${controls.outstandingBalanceUsd.toFixed(2)})`,
        });

        await stripe.invoices.finalizeInvoice(invoice.id);
        // pay() will attempt collection immediately; failure is non-fatal from our
        // perspective — the webhook handlers will update billing_controls accordingly.
        await stripe.invoices.pay(invoice.id).catch((err: unknown) => {
          const stripeErr = err as import('stripe').default.errors.StripeError;
          // card_declined / insufficient_funds are expected — the webhook will fire
          // invoice.payment_failed and keep the account suspended.
          if (stripeErr.type !== 'StripeCardError') throw err;
        });

        return reply.code(200).send({ ok: true, invoiceId: invoice.id });
      } catch (err) {
        log.error('billing.accounts.retry-outstanding-charge: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'retry_charge_failed' });
      }
    },
  );

  // ── POST /api/billing/accounts/:tenantId/credits ──────────────────────────
  // Customer-initiated wallet top-up: the "Add to Balance" button on
  // /dashboard/settings/billing.
  //
  // WHY THIS EXISTS. The button has always POSTed here and nothing has ever
  // answered. `/api/billing/*` is proxied verbatim from platform-backend, so
  // the request reached this service and 404'd, and the modal showed "Failed
  // to add credits." Auto-reload was the only way a wallet could be funded --
  // and it only fires from the real-time spend-subscriber path, so a customer
  // with auto-reload off had no way at all to add credit before consumption
  // drove `reload_balance_usd` negative and suspended them.
  //
  // This is the manual twin of POST /api/internal/auto-reload. It deliberately
  // uses the SAME Stripe shape -- invoice item, invoice with
  // metadata.type='prepaid_reload', finalize, pay -- so `classifyInvoice()`
  // routes it identically and it appears in the customer's invoice list beside
  // its automatic sibling. The wallet credit is applied by calling
  // `prepaidToppedUp` directly after payment, exactly as auto-reload does:
  // `onInvoicePaid` dispatches wallet state only for 'threshold', 'recovery'
  // and 'subscription_cycle', so a 'prepaid_reload' invoice credits once, here,
  // and never twice.
  //
  // The $5 floor matches the minimum the modal enforces client-side; it is
  // repeated here because a client-side minimum is not a minimum.
  //
  // Reachable without a subscription. The customer is resolved from the account
  // when this service's `subscriptions` table has no row, which is what lets a
  // workspace fund itself with credit instead of subscribing. The 404 below now
  // fires only for an account with no Stripe customer at all — every account
  // gets one at signup, so it is a guard rather than a path.
  app.post<{
    Params: { tenantId: string };
    Body: { amountUsd: number };
  }>(
    '/api/billing/accounts/:tenantId/credits',
    async (req, reply) => {
      const { tenantId } = req.params;
      const { amountUsd } = req.body ?? {};

      if (typeof amountUsd !== 'number' || !isFinite(amountUsd) || amountUsd < 5) {
        return reply.code(400).send({ error: 'invalid_amount', message: 'amountUsd must be a number >= 5' });
      }

      try {
        const stripeCustomerId = await resolveCustomerForUnsubscribed(pool, tenantId, req);
        if (!stripeCustomerId) {
          return reply.code(404).send({ error: 'no_active_subscription' });
        }

        // The card the PaymentIntent will be confirmed with. Resolved here so
        // the browser does not have to know it, and refused here when there is
        // none: finalizing an invoice nothing can pay leaves an open invoice
        // behind for nothing.
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        const defaultPm = (customer as import('stripe').default.Customer)
          .invoice_settings?.default_payment_method;
        const paymentMethodId = typeof defaultPm === 'string' ? defaultPm : defaultPm?.id ?? null;
        if (!paymentMethodId) {
          return reply.code(402).send({ error: 'no_payment_method' });
        }

        const amountCents = Math.round(amountUsd * 100);

        // The invoice FIRST, then the line item bound to it by id.
        //
        // Creating the item first and letting the invoice sweep it up relies on
        // `pending_invoice_items_behavior`, which defaults to `exclude` on this
        // account: the invoice comes out with NO lines, totalling $0, unless the
        // item is bound explicitly.
        //
        // Passing `include` would fix the total and introduce a worse bug: it
        // sweeps EVERY pending item for the customer, so two top-ups in flight
        // at once merge into one invoice and the person is charged for both at
        // once (two $5 items become one $10 invoice). Binding by id is the only
        // shape that cannot do that.
        const invoice = await stripe.invoices.create({
          customer: stripeCustomerId,
          auto_advance: false,
          default_payment_method: paymentMethodId,
          metadata: { type: 'prepaid_reload', tenant_id: tenantId, source: 'manual' },
          // 3D Secure on every top-up, not only where Radar's risk rules ask
          // for it. 'any' prefers the frictionless flow, so most customers see
          // nothing; what it buys is that an authenticated payment later
          // disputed as fraud is the issuer's loss rather than ours. That is
          // what lets a top-up be any size at all.
          payment_settings: {
            payment_method_options: { card: { request_three_d_secure: 'any' } },
          },
        });

        await stripe.invoiceItems.create({
          customer: stripeCustomerId,
          invoice: invoice.id,
          amount: amountCents,
          currency: 'usd',
          description: 'Wallet top-up',
        });

        // NOT paid here. invoices.pay() charges off-session, and an
        // off-session payment can never be challenged by the issuer, so it
        // carries no authentication and no liability shift. The invoice's
        // PaymentIntent goes back to the browser instead, where the person is
        // present to answer the challenge. The wallet is credited by
        // invoice.paid once the payment settles.
        const finalized = await stripe.invoices.finalizeInvoice(invoice.id, {
          expand: ['payment_intent'],
        });
        const pi = finalized.payment_intent;
        const clientSecret = typeof pi === 'string' ? null : pi?.client_secret ?? null;
        if (!clientSecret) {
          log.error('billing.accounts.credits: finalized invoice has no payment intent',
            { tenantId, invoiceId: invoice.id });
          await stripe.invoices.voidInvoice(invoice.id).catch(() => { /* best-effort tidy */ });
          return reply.code(500).send({ error: 'credit_purchase_failed' });
        }

        log.info('billing.accounts.credits: top-up awaiting confirmation',
          { tenantId, amountUsd, invoiceId: invoice.id });
        return reply.code(200).send({
          status: 'requires_confirmation',
          invoiceId: invoice.id,
          clientSecret,
          paymentMethodId,
        });
      } catch (err) {
        // No card-error branch any more: the charge happens in the browser, so
        // a decline is reported to the person by Stripe.js rather than here.
        log.error('billing.accounts.credits: failed', { tenantId, amountUsd, error: (err as Error).message });
        return reply.code(500).send({ error: 'credit_purchase_failed' });
      }
    },
  );

  // ── PATCH /api/billing/accounts/:tenantId/default-payment-method ──────────
  // Sets a payment method as the customer's default after a successful
  // SetupIntent. Verifies the PM belongs to the customer before updating.
  app.patch<{
    Params: { tenantId: string };
    Body: { paymentMethodId: string };
  }>(
    '/api/billing/accounts/:tenantId/default-payment-method',
    async (req, reply) => {
      const { tenantId } = req.params;
      const { paymentMethodId } = req.body ?? {};
      if (!paymentMethodId) {
        return reply.code(400).send({ error: 'paymentMethodId is required' });
      }
      try {
        const stripeCustomerId =
          (await resolveStripeCustomer(pool, tenantId)) ??
          (req.headers['x-account-stripe-customer-id'] as string | undefined) ??
          null;
        if (!stripeCustomerId) {
          return reply.code(404).send({ error: 'no_active_subscription' });
        }
        // Verify the PM actually belongs to this customer before setting default
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
        if (pm.customer !== stripeCustomerId) {
          return reply.code(403).send({ error: 'payment_method_not_owned' });
        }
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });
        return reply.code(200).send({ success: true });
      } catch (err) {
        log.error('billing.accounts.default-payment-method: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'set_default_failed' });
      }
    },
  );

  // ── GET /api/billing/accounts/:tenantId/auto-reload ──────────────────────
  app.get<{ Params: { tenantId: string } }>(
    '/api/billing/accounts/:tenantId/auto-reload',
    async (req, reply) => {
      const { tenantId } = req.params;
      try {
        const settings = await pbClient.getAutoReloadSettings(tenantId);
        return reply.code(200).send(settings);
      } catch (err) {
        log.error('billing.accounts.auto-reload.get: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'auto_reload_get_failed' });
      }
    },
  );

  // ── PUT /api/billing/accounts/:tenantId/auto-reload ───────────────────────
  app.put<{
    Params: { tenantId: string };
    Body: { thresholdUsd: number; reloadAmountUsd: number };
  }>(
    '/api/billing/accounts/:tenantId/auto-reload',
    async (req, reply) => {
      const { tenantId } = req.params;
      const { thresholdUsd, reloadAmountUsd } = req.body ?? {};
      if (typeof thresholdUsd !== 'number' || typeof reloadAmountUsd !== 'number') {
        return reply.code(400).send({ error: 'thresholdUsd and reloadAmountUsd are required' });
      }
      try {
        await pbClient.updateAutoReloadSettings(tenantId, {
          enabled: true,
          thresholdUsd,
          amountUsd: reloadAmountUsd,
        });
        return reply.code(200).send({ ok: true });
      } catch (err) {
        // A value under platform-backend's minimum is the customer's to fix,
        // and its reason (e.g. thresholdUsd_must_be_at_least_1) says how.
        if (err instanceof PlatformBackendError && err.status === 400) {
          return reply.code(400).send({ error: platformBackendErrorCode(err.body) ?? 'auto_reload_settings_invalid' });
        }
        log.error('billing.accounts.auto-reload.put: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'auto_reload_put_failed' });
      }
    },
  );

  // ── DELETE /api/billing/accounts/:tenantId/auto-reload ────────────────────
  app.delete<{ Params: { tenantId: string } }>(
    '/api/billing/accounts/:tenantId/auto-reload',
    async (req, reply) => {
      const { tenantId } = req.params;
      try {
        await pbClient.updateAutoReloadSettings(tenantId, {
          enabled: false,
          thresholdUsd: 0,
          amountUsd: 0,
        });
        return reply.code(200).send({ ok: true });
      } catch (err) {
        log.error('billing.accounts.auto-reload.delete: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'auto_reload_delete_failed' });
      }
    },
  );

  // ── POST /api/billing/accounts/:tenantId/promo/lookup ─────────────────────
  // Validates a promo code WITHOUT redeeming it. Used by the onboarding payment
  // panel on blur to surface a "Promo code applied" / "Invalid promo code" toast
  // and a green check before the user submits. Shares lookupPromotionCode() with
  // /subscribe so the affirmation here and the submit-time enforcement there
  // can never disagree. No DB reads — pure Stripe API wrapping.
  app.post<{
    Params: { tenantId: string };
    Body: { code?: string; planId?: string; billingPeriod?: string };
  }>(
    '/api/billing/accounts/:tenantId/promo/lookup',
    async (req, reply) => {
      const { tenantId } = req.params;
      const code = req.body?.code?.trim();
      const { planId, billingPeriod } = req.body ?? {};
      if (!code) return reply.code(400).send({ error: 'missing_code' });
      if (!planId || !(planId in SELF_SERVE_PLANS)) {
        return reply.code(400).send({ error: 'invalid_plan_id' });
      }
      if (billingPeriod !== 'monthly' && billingPeriod !== 'yearly') {
        return reply.code(400).send({ error: 'invalid_billing_period' });
      }
      try {
        const persistentProductId = await getPersistentProductId(
          stripe, planId as 'core' | 'growth' | 'scale', billingPeriod,
        );
        if (!persistentProductId) {
          return reply.code(500).send({ error: 'plan_price_not_configured' });
        }

        // Abuse-prevention: silent-deny promo when the signup matches a
        // previously-deleted account. Surfaces upstream as the same
        // invalid_promo_code toast the user sees for any unredeemable code.
        // Requires a customer + payment method to compute the signals; if
        // neither is on file yet (e.g. tenant hasn't reached the payment
        // step), skip the check and let normal validation proceed.
        const stripeCustomerId = await resolveStripeCustomer(pool, tenantId);
        if (stripeCustomerId) {
          const pmList = await stripe.customers.listPaymentMethods(stripeCustomerId, { limit: 1 });
          if (pmList.data.length > 0) {
            const eligibility = await checkPromoEligibility(
              { stripe, pool, pbClient },
              { stripeCustomerId, paymentMethodId: pmList.data[0].id },
            );
            if (!eligibility.eligible) {
              log.info('billing.accounts.promo.lookup: eligibility denied', { tenantId, signals: eligibility.signals });
              return reply.code(400).send({ error: 'invalid_promo_code' });
            }
          }
        }

        const lookup = await lookupPromotionCode(stripe, code, persistentProductId);
        if (lookup.kind !== 'valid') {
          return reply.code(400).send({ error: lookup.kind });
        }
        return reply.code(200).send({
          valid: true,
          amountOffUsd: lookup.amountOffCents != null ? lookup.amountOffCents / 100 : null,
        });
      } catch (err) {
        log.error('billing.accounts.promo.lookup: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'promo_lookup_failed' });
      }
    },
  );

  // ── POST /api/billing/accounts/:tenantId/subscribe ───────────────────────
  // Creates a new self-serve subscription via provisionForTenant (PR 2).
  app.post<{
    Params: { tenantId: string };
    Body: { planId: string; billingPeriod: string; committedOus?: number; promoCode?: string };
  }>(
    '/api/billing/accounts/:tenantId/subscribe',
    async (req, reply) => {
      const { tenantId } = req.params;
      const { planId, billingPeriod, committedOus } = req.body ?? {};
      if (!planId || !(planId in SELF_SERVE_PLANS)) return reply.code(400).send({ error: 'invalid_plan_id' });
      const validPlanId = planId as 'core' | 'growth' | 'scale';
      const config = SELF_SERVE_PLANS[validPlanId];
      if (billingPeriod !== 'monthly' && billingPeriod !== 'yearly') return reply.code(400).send({ error: 'invalid_billing_period' });

      try {
        // resolveStripeCustomer queries the subscriptions table — for a
        // first-time self-serve subscription there's no row there yet, so we
        // fall back to the x-account-stripe-customer-id header that
        // platform-backend's billing-proxy injects from accounts.stripe_customer_id
        // (same pattern as /setup-intent above). Without this fallback,
        // every first-time subscriber on the fused-onboarding flow gets
        // no_stripe_customer even though their SetupIntent succeeded.
        const stripeCustomerId =
          (await resolveStripeCustomer(pool, tenantId)) ??
          (req.headers['x-account-stripe-customer-id'] as string | undefined) ??
          null;
        if (!stripeCustomerId) return reply.code(400).send({ error: 'no_stripe_customer' });

        const pmList = await stripe.customers.listPaymentMethods(stripeCustomerId, { limit: 1 });
        if (pmList.data.length === 0) return reply.code(402).send({ error: 'no_payment_method' });

        const effectiveOus    = committedOus ?? config.basePlanOus;
        const extraOus        = Math.max(0, effectiveOus - config.basePlanOus);
        const extraCostCents  = Math.round(extraOus * PRECOMMIT_CENTS_PER_OU);
        const monthlyTotalCents = config.basePlanCents + extraCostCents;
        const totalCents = billingPeriod === 'yearly' ? monthlyTotalCents * 10 : monthlyTotalCents;

        const persistentProductId = await getPersistentProductId(stripe, validPlanId, billingPeriod as 'monthly' | 'yearly');
        if (!persistentProductId) return reply.code(500).send({ error: 'plan_price_not_configured' });

        // Promo code lookup (placed after no_payment_method for minor
        // anti-enumeration hardening). Shared with /promo/lookup so the
        // blur-time UI affirmation and the submit-time validation can never
        // disagree.
        let promotionCodeId: string | undefined;
        let promoCouponAmountOffCents: number | null = null;
        const trimmedCode = req.body?.promoCode?.trim();
        if (trimmedCode) {
          // Abuse-prevention gate (Phase 7): silently deny promo when the
          // re-signing-up user matches a previously-deleted account
          // (fingerprint OR email-hash signal). Returned upstream as the
          // same invalid_promo_code toast the user sees for any other
          // unredeemable code.
          const eligibility = await checkPromoEligibility(
            { stripe, pool, pbClient },
            { stripeCustomerId, paymentMethodId: pmList.data[0].id },
          );
          if (!eligibility.eligible) {
            log.info('billing.subscribe: promo eligibility denied', { tenantId, signals: eligibility.signals });
            return reply.code(400).send({ error: 'invalid_promo_code' });
          }

          const lookup = await lookupPromotionCode(stripe, trimmedCode, persistentProductId);
          if (lookup.kind !== 'valid') return reply.code(400).send({ error: lookup.kind });
          promotionCodeId = lookup.promotionCodeId;
          promoCouponAmountOffCents = lookup.amountOffCents;
        }

        const discounts: Stripe.SubscriptionCreateParams['discounts'] | undefined =
          promotionCodeId ? [{ promotion_code: promotionCodeId }] : undefined;

        const combinedPrice = await stripe.prices.create({
          currency: 'usd',
          product: persistentProductId,
          unit_amount: totalCents,
          recurring: { interval: billingPeriod === 'monthly' ? 'month' : 'year' },
        });

        // Surface the "Monthly Operating Units: N OUs/month" line on every
        // invoice from this customer. Stripe does NOT accept
        // invoice_settings.custom_fields on subscription create or update
        // (verified via direct API probe — parameter_unknown across all
        // current API versions). The supported location is the CUSTOMER's
        // invoice_settings, which Stripe inherits onto every invoice this
        // customer is billed.
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: {
            custom_fields: [
              { name: 'Monthly Operating Units', value: `${effectiveOus.toLocaleString()} OUs/month` },
            ],
          },
        });

        const extraMetadata: Record<string, string> | undefined = (trimmedCode && promotionCodeId)
          ? { promo_code: trimmedCode, promotion_code_id: promotionCodeId }
          : undefined;

        let result;
        try {
          result = await provisionForTenant({
            tenantId, stripeCustomerId,
            planId: validPlanId,
            includedOus: config.basePlanOus,
            precommitExtraOus: extraOus,
            billingPeriod: billingPeriod as 'monthly' | 'yearly',
            provisioningSource: 'self_serve',
            priceItems: [{ price: combinedPrice.id }],
            discounts,
            extraMetadata,
            // When a promo is applied, force 'error_if_incomplete' so a card
            // decline doesn't create a stuck-incomplete sub that burns the
            // redemption and blocks retry via the dedup guard.
            paymentBehavior: discounts ? 'error_if_incomplete' : undefined,
          }, { stripe, pbClient, log });
        } catch (provisionErr) {
          const stripeErr = provisionErr as Stripe.errors.StripeError;
          // Narrow the misattribution: only treat a Stripe invalid_request as
          // a promo failure when the rejected parameter actually belongs to
          // the discount/coupon surface. Without this guard a totally
          // unrelated rejection (e.g. an unsupported invoice_settings field)
          // was being labelled `invalid_promo_code`, sending users back to
          // re-check a perfectly valid code.
          if (stripeErr?.type === 'StripeInvalidRequestError' && discounts && isPromoRelatedStripeError(stripeErr)) {
            log.warn('billing.accounts.subscribe: stripe rejected promo discount', {
              tenantId, error: stripeErr.message, code: stripeErr.code, param: stripeErr.param,
            });
            return reply.code(400).send({ error: 'invalid_promo_code' });
          }
          throw provisionErr;
        }

        // Idempotency: an already-active subscription on this tenant returns
        // 200 with the existing subscription id instead of 409. The previous
        // 409 path stranded the fused-onboarding flow when a user's first
        // /subscribe succeeded but a downstream step (e.g. provisioning
        // loader) got stuck — every retry would create a Stripe subscription,
        // get classified as already-active, and bounce with no recovery.
        // Plan-changes go through /replace-subscription, not /subscribe, so
        // there is no legitimate reason to require a fresh sub here.
        if (result.alreadyExists) {
          return reply.code(200).send({
            alreadyActive: true,
            stripeSubscriptionId: result.stripeSubscriptionId,
          });
        }

        // promoApplied is set only when a discount was actually applied. After
        // the applies_to.products pre-check above, this is guaranteed whenever
        // `discounts` is set AND the coupon uses amount_off. percent_off
        // coupons would need a separate computation (extend the shape when a
        // future campaign uses them).
        const promoApplied = (discounts && promoCouponAmountOffCents != null)
          ? {
              amountOffUsd: promoCouponAmountOffCents / 100,
              firstInvoiceTotalUsd: Math.max(0, (totalCents - promoCouponAmountOffCents) / 100),
            }
          : undefined;

        // Per-OU rates are not passed in: plan_catalog lives in platform-backend's
        // database (not billing's), so PB resolves them from planType during the
        // subscription-activated handler. Keeping plan_catalog as the single source
        // of truth avoids drift between billing's hardcoded rates and PB's catalog.
        await pbClient.subscriptionActivated(stripeCustomerId, {
          planType: validPlanId,
          includedOus: config.basePlanOus,
          precommitExtraOus: extraOus,
          isAnnualPlan: billingPeriod === 'yearly',
          tenantId,
          promoApplied,
        });
        return reply.code(200).send({ success: true });
      } catch (err) {
        log.error('billing.accounts.subscribe: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'subscribe_failed' });
      }
    },
  );

  // ── POST /api/billing/accounts/:tenantId/replace-subscription ──────────────
  // PR 2: replace the tenant's existing active subscription with a fresh one
  // on a different plan/billing-period. Cancels the old sub, waits for the
  // local row to reflect canceled, then provisions the replacement. The frontend
  // PricingPage submit handler hits this endpoint when useActiveSubscription()
  // says a sub exists (otherwise it hits /subscribe).
  app.post<{
    Params: { tenantId: string };
    Body: { planId: string; billingPeriod: string; committedOus?: number };
  }>(
    '/api/billing/accounts/:tenantId/replace-subscription',
    async (req, reply) => {
      const { tenantId } = req.params;
      const { planId, billingPeriod, committedOus } = req.body ?? {};
      if (!planId || !(planId in SELF_SERVE_PLANS)) return reply.code(400).send({ error: 'invalid_plan_id' });
      const validPlanId = planId as 'core' | 'growth' | 'scale';
      const config = SELF_SERVE_PLANS[validPlanId];
      if (billingPeriod !== 'monthly' && billingPeriod !== 'yearly') return reply.code(400).send({ error: 'invalid_billing_period' });

      try {
        const stripeCustomerId = await resolveStripeCustomer(pool, tenantId);
        if (!stripeCustomerId) return reply.code(400).send({ error: 'no_stripe_customer' });

        const pmList = await stripe.customers.listPaymentMethods(stripeCustomerId, { limit: 1 });
        if (pmList.data.length === 0) return reply.code(402).send({ error: 'no_payment_method' });

        const effectiveOus      = committedOus ?? config.basePlanOus;
        const extraOus          = Math.max(0, effectiveOus - config.basePlanOus);
        const extraCostCents    = Math.round(extraOus * PRECOMMIT_CENTS_PER_OU);
        const monthlyTotalCents = config.basePlanCents + extraCostCents;
        const totalCents        = billingPeriod === 'yearly' ? monthlyTotalCents * 10 : monthlyTotalCents;

        const persistentProductId = await getPersistentProductId(stripe, validPlanId, billingPeriod as 'monthly' | 'yearly');
        if (!persistentProductId) return reply.code(500).send({ error: 'plan_price_not_configured' });

        const combinedPrice = await stripe.prices.create({
          currency: 'usd',
          product: persistentProductId,
          unit_amount: totalCents,
          recurring: { interval: billingPeriod === 'monthly' ? 'month' : 'year' },
        });

        // See /subscribe — Stripe rejects invoice_settings.custom_fields on
        // subscription create/update across all current API versions. Set the
        // custom field on the CUSTOMER so it appears on every invoice billed
        // to this customer instead.
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: {
            custom_fields: [
              { name: 'Monthly Operating Units', value: `${effectiveOus.toLocaleString()} OUs/month` },
            ],
          },
        });

        const result = await replaceSubscriptionForTenant({
          tenantId, stripeCustomerId,
          planId: validPlanId,
          includedOus: config.basePlanOus,
          precommitExtraOus: extraOus,
          billingPeriod: billingPeriod as 'monthly' | 'yearly',
          provisioningSource: 'self_serve',
          priceItems: [{ price: combinedPrice.id }],
        }, { stripe, pbClient, log });

        await pbClient.subscriptionActivated(stripeCustomerId, {
          planType: validPlanId,
          includedOus: config.basePlanOus,
          precommitExtraOus: extraOus,
          isAnnualPlan: billingPeriod === 'yearly',
          tenantId,
        });

        return reply.code(200).send({ stripeSubscriptionId: result.stripeSubscriptionId });
      } catch (err) {
        if (err instanceof SubscriptionCancelTimeoutError) {
          log.warn('billing.accounts.replace-subscription: cancel poll timeout',
            { tenantId, waitedMs: err.waitedMs });
          return reply.code(504).send({
            error: 'subscription_cancel_poll_timeout',
            detail: 'Stripe cancellation did not propagate to the local subscriptions table within the polling window. Retry in a few seconds.',
          });
        }
        log.error('billing.accounts.replace-subscription: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'replace_subscription_failed' });
      }
    },
  );

  // ── POST /api/billing/accounts/:tenantId/checkout-session ────────────────
  // Creates a Stripe Checkout Session in embedded UI mode for the onboarding
  // flow. Returns { clientSecret } for use with @stripe/react-stripe-js's
  // <EmbeddedCheckoutProvider />. On completion, Stripe creates the
  // subscription via Checkout's own subscription mode; the existing
  // customer.subscription.created webhook then upserts the local row.
  app.post<{
    Params: { tenantId: string };
    Body: {
      planId: string;
      billingPeriod: string;
      committedOus?: number;
      returnUrl: string;
      // Dev-only escape hatch: when ENVIRONMENT=dev AND replaceExisting=true,
      // an existing subscription is cancelled before opening the new checkout
      // session so a developer can iterate on the onboarding flow against the
      // same test tenant without manually clearing state. PRODUCTION IGNORES
      // THIS FIELD — the strict 409 always fires there.
      replaceExisting?: boolean;
    };
  }>(
    '/api/billing/accounts/:tenantId/checkout-session',
    async (req, reply) => {
      const { tenantId } = req.params;
      const { planId, billingPeriod, committedOus, returnUrl, replaceExisting } = req.body ?? {};

      // Validate planId
      if (!planId || !(planId in SELF_SERVE_PLANS)) {
        return reply.code(400).send({ error: 'invalid_plan_id' });
      }
      const validPlanId = planId as 'core' | 'growth' | 'scale';
      const config = SELF_SERVE_PLANS[validPlanId];

      // Validate billingPeriod
      if (billingPeriod !== 'monthly' && billingPeriod !== 'yearly') {
        return reply.code(400).send({ error: 'invalid_billing_period' });
      }

      // Validate returnUrl
      if (!returnUrl || typeof returnUrl !== 'string') {
        return reply.code(400).send({ error: 'invalid_return_url' });
      }
      if (!isAllowedReturnUrl(returnUrl)) {
        return reply.code(400).send({ error: 'return_url_not_allowed' });
      }

      try {
        // Customer ID comes from the platform-backend billing-proxy via
        // x-account-stripe-customer-id (resolved from billing_controls or
        // accounts).  Falls back to the legacy resolveStripeCustomer query.
        const headerCustomerId = req.headers['x-account-stripe-customer-id'];
        let stripeCustomerId: string | null =
          typeof headerCustomerId === 'string' ? headerCustomerId : null;
        if (!stripeCustomerId) {
          stripeCustomerId = await resolveStripeCustomer(pool, tenantId);
        }
        if (!stripeCustomerId) {
          return reply.code(400).send({ error: 'no_stripe_customer' });
        }

        // Backfill email on the Stripe customer if it's missing. Without an
        // email, Stripe's Embedded Checkout renders an editable email field
        // (since subscriptions require one), which is confusing for already-
        // signed-in users.  The platform-backend proxy injects x-account-email
        // from accounts.email so we can patch the customer here once and the
        // field becomes read-only in checkout.
        const headerEmail = req.headers['x-account-email'];
        const email = typeof headerEmail === 'string' && headerEmail.length > 0 ? headerEmail : null;
        if (email) {
          const customer = await stripe.customers.retrieve(stripeCustomerId);
          const hasEmail = !customer.deleted && (customer as Stripe.Customer).email;
          if (!hasEmail) {
            await stripe.customers.update(stripeCustomerId, { email });
          }
        }

        // Reject if the tenant is already subscribed — this endpoint is for
        // first-time onboarding only.  Plan changes go through /change-plan.
        // Dev-only escape hatch (replaceExisting=true) cancels the existing
        // subscription so the developer can re-run the onboarding flow.
        const existingSub = await withTenantContext(pool, tenantId, (client) =>
          client.query<{ stripe_subscription_id: string }>(
            `SELECT stripe_subscription_id FROM subscriptions
             WHERE tenant_id = $1 AND stripe_customer_id = $2
               AND status NOT IN ('canceled','incomplete_expired')
             ORDER BY updated_at DESC LIMIT 1`,
            [tenantId, stripeCustomerId],
          ),
        );
        if (existingSub.rows.length > 0) {
          const canReplace = process.env.ENVIRONMENT === 'dev' && replaceExisting === true;
          if (!canReplace) {
            return reply.code(409).send({ error: 'already_subscribed' });
          }
          // Cancel the existing Stripe subscription. customer.subscription.deleted
          // webhook will mark the local row 'canceled'; the new sub created by
          // the upcoming Checkout will then be upserted via subscription.created.
          await stripe.subscriptions.cancel(existingSub.rows[0].stripe_subscription_id);
          log.info('billing.accounts.checkout-session: cancelled existing sub for dev re-run', {
            tenantId,
            cancelledSubscriptionId: existingSub.rows[0].stripe_subscription_id,
          });
        }

        // Pricing: mirrors the /subscribe ad-hoc-price formula.
        // Yearly is monthly × 10 (≈17% discount, matching the /pricing UI).
        const effectiveOus = committedOus ?? config.basePlanOus;
        const extraOus = Math.max(0, effectiveOus - config.basePlanOus);
        const extraCostCents = Math.round(extraOus * PRECOMMIT_CENTS_PER_OU);
        const monthlyTotalCents = config.basePlanCents + extraCostCents;
        const periodTotalCents =
          billingPeriod === 'yearly' ? monthlyTotalCents * 10 : monthlyTotalCents;

        const persistentProductId = await getPersistentProductId(stripe, validPlanId, billingPeriod as 'monthly' | 'yearly');
        if (!persistentProductId) {
          return reply.code(500).send({ error: 'plan_price_not_configured' });
        }

        const combinedPrice = await stripe.prices.create({
          currency: 'usd',
          product: persistentProductId,
          unit_amount: periodTotalCents,
          recurring: { interval: billingPeriod === 'monthly' ? 'month' : 'year' },
        });

        const subscriptionMetadata = {
          tenant_id: tenantId,
          plan_type: validPlanId,
          billing_period: billingPeriod,
          committed_ous: String(effectiveOus),
          included_ous: String(config.basePlanOus),
          precommit_extra_ous: String(extraOus),
          provisioning_source: 'self_serve',
        };

        const session = await stripe.checkout.sessions.create({
          customer: stripeCustomerId,
          // Lock customer-attached fields so the embedded form doesn't prompt
          // for name / address re-entry; the signed-in user already provided
          // them at signup and Stripe will reuse what's on the customer.
          customer_update: { name: 'never', address: 'never' },
          mode: 'subscription',
          ui_mode: 'embedded',
          line_items: [{ price: combinedPrice.id, quantity: 1 }],
          return_url: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
          client_reference_id: tenantId,
          metadata: subscriptionMetadata,
          subscription_data: { metadata: subscriptionMetadata },
        });

        if (!session.client_secret) {
          log.error('billing.accounts.checkout-session: missing client_secret', { tenantId });
          return reply.code(500).send({ error: 'checkout_session_failed' });
        }

        return reply.code(200).send({ clientSecret: session.client_secret });
      } catch (err) {
        log.error('billing.accounts.checkout-session: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'checkout_session_failed' });
      }
    },
  );

  // ── POST /api/billing/accounts/:tenantId/change-plan ─────────────────────
  // Updates an existing subscription to a new plan and/or committed OU count.
  app.post<{
    Params: { tenantId: string };
    Body: { planId: string; billingPeriod: string; committedOus?: number };
  }>(
    '/api/billing/accounts/:tenantId/change-plan',
    async (req, reply) => {
      const { tenantId } = req.params;
      const { planId, billingPeriod, committedOus } = req.body ?? {};

      // Validate planId
      if (!planId || !(planId in SELF_SERVE_PLANS)) {
        return reply.code(400).send({ error: 'invalid_plan_id' });
      }
      const validPlanId = planId as 'core' | 'growth' | 'scale';
      const config = SELF_SERVE_PLANS[validPlanId];

      // Validate billingPeriod
      if (billingPeriod !== 'monthly' && billingPeriod !== 'yearly') {
        return reply.code(400).send({ error: 'invalid_billing_period' });
      }

      try {
        const stripeCustomerId = await resolveStripeCustomer(pool, tenantId);
        if (!stripeCustomerId) {
          return reply.code(400).send({ error: 'no_stripe_customer' });
        }

        // Find existing subscription
        const subRow = await withTenantContext(pool, tenantId, (client) =>
          client.query<{ stripe_subscription_id: string }>(
            `SELECT stripe_subscription_id FROM subscriptions
             WHERE tenant_id = $1 AND stripe_customer_id = $2
               AND status NOT IN ('canceled','incomplete_expired')
             ORDER BY updated_at DESC LIMIT 1`,
            [tenantId, stripeCustomerId],
          ),
        );
        if (subRow.rows.length === 0) {
          return reply.code(404).send({ error: 'no_subscription' });
        }
        const stripeSubId = subRow.rows[0].stripe_subscription_id;

        // Retrieve current Stripe subscription with expanded items
        const currentSub = await stripe.subscriptions.retrieve(stripeSubId, {
          expand: ['items.data.price'],
        });

        // Compute extra OU cost
        const effectiveOus = committedOus ?? config.basePlanOus;
        const extraOus = Math.max(0, effectiveOus - config.basePlanOus);
        const extraCostCents = Math.round(extraOus * PRECOMMIT_CENTS_PER_OU);

        // Build single line item — delete all existing items and add one new ad-hoc price.
        // Yearly is monthly × 10 (≈17% discount, matching the /pricing UI).
        const monthlyTotalCents = config.basePlanCents + extraCostCents;
        const totalCents = billingPeriod === 'yearly' ? monthlyTotalCents * 10 : monthlyTotalCents;

        const persistentProductId = await getPersistentProductId(stripe, validPlanId, billingPeriod as 'monthly' | 'yearly');
        if (!persistentProductId) return reply.code(500).send({ error: 'plan_price_not_configured' });

        const combinedPrice = await stripe.prices.create({
          currency: 'usd',
          product: persistentProductId,
          unit_amount: totalCents,
          recurring: { interval: billingPeriod === 'monthly' ? 'month' : 'year' },
        });

        const updateItems: Stripe.SubscriptionUpdateParams.Item[] = [
          // delete all existing items
          ...currentSub.items.data.map(item => ({ id: item.id, deleted: true as const })),
          // add single new item
          { price: combinedPrice.id },
        ];

        // See /subscribe — Stripe doesn't accept invoice_settings.custom_fields
        // on subscription create/update. Set on the CUSTOMER so it appears on
        // every invoice billed to this customer.
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: {
            custom_fields: [
              { name: 'Monthly Operating Units', value: `${effectiveOus.toLocaleString()} OUs/month` },
            ],
          },
        });

        // Update the Stripe subscription
        await stripe.subscriptions.update(stripeSubId, {
          items: updateItems,
          proration_behavior: 'none',
          metadata: {
            ...currentSub.metadata,
            plan_type: validPlanId,
            billing_period: billingPeriod,
            committed_ous: String(effectiveOus),
            included_ous: String(config.basePlanOus),
            precommit_extra_ous: String(extraOus),
          },
        });

        // Notify platform-backend with tenantId for the accountId fallback path.
        await pbClient.subscriptionActivated(stripeCustomerId, {
          planType: validPlanId,
          includedOus:       config.basePlanOus,
          precommitExtraOus: extraOus,
          isAnnualPlan: billingPeriod === 'yearly',
          tenantId,
        });

        return reply.code(200).send({ success: true });
      } catch (err) {
        log.error('billing.accounts.change-plan: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'change_plan_failed' });
      }
    },
  );

  // ── POST /api/billing/portal-session ──────────────────────────────────────
  app.post<{
    Body: { tenantId: string; returnUrl: string };
  }>(
    '/api/billing/portal-session',
    async (req, reply) => {
      const { tenantId, returnUrl } = req.body ?? {};
      if (!tenantId || !returnUrl) {
        return reply.code(400).send({ error: 'tenantId and returnUrl are required' });
      }
      if (!isAllowedReturnUrl(returnUrl)) {
        return reply.code(400).send({ error: 'invalid_return_url' });
      }
      try {
        const stripeCustomerId = await resolveStripeCustomer(pool, tenantId);
        if (!stripeCustomerId) {
          return reply.code(404).send({ error: 'no_active_subscription' });
        }
        const session = await stripe.billingPortal.sessions.create({
          customer: stripeCustomerId,
          return_url: returnUrl,
        });
        return reply.code(200).send({ url: session.url });
      } catch (err) {
        log.error('billing.portal-session: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'portal_session_failed' });
      }
    },
  );

  // ── POST /api/billing/accounts/:tenantId/cancel-subscription ─────────────
  // Schedules the tenant's active self-serve subscription for cancellation at
  // the end of the current billing period — Stripe `cancel_at_period_end: true`.
  // We don't end the sub immediately because the dashboard tells the user
  // "subscription will remain active until the end of your current billing
  // period," matching the standard self-serve cancel UX.
  //
  // Side effects:
  //   * Local subscriptions row's cancel_at_period_end is mirrored
  //     synchronously so /overview reflects the cancel-scheduled state
  //     immediately.
  //   * `pbClient.subscriptionEnding` is invoked synchronously so PB sets
  //     `billing_controls.access_ends_at` AND fires the subscription-ending
  //     confirmation email right away. Doing this in-process (rather than
  //     relying on the customer.subscription.updated webhook chain) means
  //     the email is guaranteed even when the webhook-side handler trips on
  //     a code path that doesn't apply to self-serve subs.
  //   * The customer.subscription.updated webhook still fires and the
  //     consumer's cancel-transition handler still notifies PB — that's
  //     idempotent with this synchronous call.
  //   * When the period actually ends, customer.subscription.deleted fires and
  //     status transitions to canceled.
  app.post<{ Params: { tenantId: string } }>(
    '/api/billing/accounts/:tenantId/cancel-subscription',
    async (req, reply) => {
      const { tenantId } = req.params;
      try {
        const stripeCustomerId = await resolveStripeCustomer(pool, tenantId);
        if (!stripeCustomerId) return reply.code(404).send({ error: 'no_active_subscription' });

        // Find the active sub. status filter mirrors provisionForTenant's
        // alreadyExists guard — we only want subs that are billable right now.
        const subRow = await withTenantContext(pool, tenantId, (client) =>
          client.query<{ stripe_subscription_id: string }>(
            `SELECT stripe_subscription_id FROM subscriptions
             WHERE tenant_id = $1 AND stripe_customer_id = $2
               AND status NOT IN ('canceled','incomplete_expired')
             ORDER BY updated_at DESC LIMIT 1`,
            [tenantId, stripeCustomerId],
          ),
        );
        if (subRow.rows.length === 0) {
          return reply.code(404).send({ error: 'no_active_subscription' });
        }
        const stripeSubId = subRow.rows[0].stripe_subscription_id;

        const updated = await stripe.subscriptions.update(stripeSubId, {
          cancel_at_period_end: true,
        });

        // Mirror the flag in the local row immediately so /overview reflects
        // the cancel-scheduled state without waiting for the webhook. The
        // webhook will arrive shortly and upsert the same fields plus
        // current_period_end — that's idempotent with this write.
        await withTenantContext(pool, tenantId, (client) =>
          client.query(
            `UPDATE subscriptions
                SET cancel_at_period_end = TRUE, updated_at = NOW()
              WHERE stripe_subscription_id = $1`,
            [stripeSubId],
          ),
        );

        // Notify PB synchronously so the subscription-ending confirmation
        // email goes out without depending on the webhook chain. The
        // customer.subscription.updated handler in stripe-event-processor
        // also calls this, which makes the PB-side handler idempotent: PB
        // just updates billing_controls.access_ends_at and fires the email
        // each time. (Future hardening: PB should dedupe so duplicate
        // notifies don't double-send the email — not critical right now.)
        const accessEndsAt = updated.cancel_at ?? null;
        if (accessEndsAt) {
          await pbClient.subscriptionEnding(stripeCustomerId, { accessEndsAt }).catch((err: Error) =>
            log.warn('billing.accounts.cancel-subscription: subscriptionEnding notify failed (non-fatal)', {
              tenantId, stripeCustomerId, error: err.message,
            }),
          );
        }

        log.info('billing.accounts.cancel-subscription: scheduled', {
          tenantId,
          stripeSubscriptionId: stripeSubId,
          cancelAt: updated.cancel_at ?? null,
        });
        return reply.code(200).send({
          success: true,
          cancelAtPeriodEnd: true,
          cancelAt: updated.cancel_at ?? null,
        });
      } catch (err) {
        log.error('billing.accounts.cancel-subscription: failed', { tenantId, error: (err as Error).message });
        return reply.code(500).send({ error: 'cancel_subscription_failed' });
      }
    },
  );

  // ── POST /api/billing/accounts/:tenantId/admin/invoices/:invoiceId/resync ─
  // One-shot re-fetch of a Stripe invoice into the local invoices table. Used
  // by operators to backfill rows that were stored before a classifier or
  // schema fix (migration 021 added subtotal_cents + discount_cents; the
  // upsert path was extended at the same time to populate them).
  //
  // Unlike the consumer path, this does NOT touch stripe_webhook_events or
  // the outbox-consumer dedup, so it can re-process an event that was
  // already processed by the old code. Direct Stripe.invoices.retrieve →
  // classifyInvoice → upsertInvoice.
  //
  // Auth: same X-Service-Auth gate as the rest of /api/billing/*. Intended
  // for `curl --header "X-Service-Auth: $BILLING_SERVICE_TOKEN"` from an
  // operator's shell. Not exposed via PB's billing-proxy regex (the
  // membership guard would reject because operators aren't tenant members).
  app.post<{ Params: { tenantId: string; invoiceId: string } }>(
    '/api/billing/accounts/:tenantId/admin/invoices/:invoiceId/resync',
    async (req, reply) => {
      const { tenantId, invoiceId } = req.params;
      try {
        const inv = await stripe.invoices.retrieve(invoiceId);
        let type: 'subscription_cycle' | 'prepaid_reload' | 'threshold' | 'recovery' | 'unknown' = 'unknown';
        try { type = classifyInvoice(inv, log); } catch { type = 'unknown'; }
        await withTenantContext(pool, tenantId, async (client) => {
          await upsertInvoice(client, tenantId, inv, undefined, type);
        });
        log.info('billing.accounts.admin.invoice-resync', {
          tenantId, invoiceId, type,
          subtotalCents: inv.subtotal ?? 0,
          discountCents: (inv.total_discount_amounts ?? []).reduce((s, d) => s + (d.amount ?? 0), 0),
        });
        return reply.code(200).send({
          ok: true,
          invoiceId: inv.id,
          type,
          subtotalCents: inv.subtotal ?? 0,
          discountCents: (inv.total_discount_amounts ?? []).reduce((s, d) => s + (d.amount ?? 0), 0),
          amountDueCents: inv.amount_due ?? 0,
          amountPaidCents: inv.amount_paid ?? 0,
        });
      } catch (err) {
        log.error('billing.accounts.admin.invoice-resync: failed', {
          tenantId, invoiceId, error: (err as Error).message,
        });
        return reply.code(500).send({ error: 'invoice_resync_failed' });
      }
    },
  );

  // ── POST /api/internal/billing/accounts/:stripeCustomerId/scrub ──────────
  // Soft-scrubs a Stripe customer on account deletion:
  //   1. Strip PII on the Stripe customer (email/name/phone/address null),
  //      preserve identity hashes in metadata for abuse detection.
  //   2. Mark all payment-method fingerprints associated with the customer
  //      as customer_status='deleted'.
  //   3. DELETE billing-local payment_methods rows for the given tenantIds
  //      (caller passes the full list of tenants the account owned). Other
  //      billing tables (invoices, subscriptions, meter_events) are RETAINED
  //      per the retention policy.
  //   4. Defensive: cancel any active Stripe subscription on the customer
  //      (the PB preflight should have blocked this, but if it slipped
  //      through we don't want a billable sub on a stripped customer).
  app.post<{
    Params: { stripeCustomerId: string };
    Body: {
      emailHash: string;
      phoneHash?: string;
      accountId: string;
      tenantIds: string[];
    };
  }>(
    '/api/internal/billing/accounts/:stripeCustomerId/scrub',
    { preHandler: hmacPre },
    async (req, reply) => {
      const { stripeCustomerId } = req.params;
      const { emailHash, phoneHash, accountId, tenantIds } = req.body ?? ({} as {
        emailHash?: string; phoneHash?: string; accountId?: string; tenantIds?: string[];
      });
      if (!emailHash || !accountId || !Array.isArray(tenantIds)) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      try {
        // 1. Stripe PII strip + hash metadata. Stripe's REST API accepts
        // empty strings to clear scalar fields, and explicit `null` to clear
        // address. The Node SDK's CustomerUpdateParams types these as
        // `string | undefined`, so we cast through `unknown` to send the
        // wire-level clearing values.
        await stripe.customers.update(stripeCustomerId, {
          email: '',
          name: '',
          phone: '',
          address: null as unknown as Stripe.AddressParam,
          metadata: {
            email_sha256: emailHash,
            ...(phoneHash ? { phone_sha256: phoneHash } : {}),
            deleted_at: new Date().toISOString(),
            accountId,
          },
        });

        // 2. Mark fingerprints deleted
        const fpResult = await pool.query( // rls-fence: allow (cross-tenant account-deletion path)
          `UPDATE payment_method_fingerprints_seen
              SET customer_status = 'deleted', last_seen_at = NOW()
            WHERE stripe_customer_id = $1
            RETURNING fingerprint`,
          [stripeCustomerId],
        );

        // 3. Delete billing-local payment_methods rows scoped to the
        // account's tenants. payment_methods.tenant_id is the scope here
        // (Stripe customer can host multiple tenants).
        let pmDeleted = 0;
        if (tenantIds.length > 0) {
          const r = await pool.query( // rls-fence: allow (cross-tenant account-deletion path)
            `DELETE FROM payment_methods WHERE tenant_id = ANY($1::uuid[])`,
            [tenantIds],
          );
          pmDeleted = r.rowCount ?? 0;
        }

        // 4. Defensive sub cancel
        const subs = await stripe.subscriptions.list({ customer: stripeCustomerId, status: 'active', limit: 100 });
        for (const sub of subs.data) {
          await stripe.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false }).catch((err) => {
            log.warn('billing.scrub: defensive subscription.cancel failed', { stripeCustomerId, subId: sub.id, error: (err as Error).message });
          });
        }

        log.info('billing.scrub: customer scrubbed', {
          stripeCustomerId,
          accountId,
          fingerprintsMarked: fpResult.rowCount ?? 0,
          paymentMethodsDeleted: pmDeleted,
          subsCancelled: subs.data.length,
        });
        return reply.code(200).send({
          scrubbed: true,
          fingerprintsMarked: fpResult.rowCount ?? 0,
          paymentMethodsDeleted: pmDeleted,
          subsCancelled: subs.data.length,
        });
      } catch (err) {
        log.error('billing.scrub: failed', { stripeCustomerId, error: (err as Error).message });
        return reply.code(500).send({ error: 'scrub_failed' });
      }
    },
  );

  // ── POST /api/internal/billing/accounts/preflight-deletion ───────────────
  // Called by platform-backend before initiating user-initiated account
  // deletion. Reports whether any of the account's owned tenants has an
  // active subscription or outstanding invoice — the PB self-delete route
  // blocks deletion when either is true.
  app.post<{ Body: { tenantIds: string[] } }>(
    '/api/internal/billing/accounts/preflight-deletion',
    { preHandler: hmacPre },
    async (req, reply) => {
      const { tenantIds } = req.body ?? ({} as { tenantIds?: string[] });
      if (!Array.isArray(tenantIds)) return reply.code(400).send({ error: 'invalid_body' });
      if (tenantIds.length === 0) {
        return reply.code(200).send({ hasActiveSubscription: false, hasOutstandingInvoice: false });
      }

      const subQ = await pool.query( // rls-fence: allow (cross-tenant account-deletion path)
        `SELECT 1 FROM subscriptions
          WHERE tenant_id = ANY($1::uuid[])
            AND status IN ('active','trialing','past_due','incomplete')
          LIMIT 1`,
        [tenantIds],
      );
      const invQ = await pool.query( // rls-fence: allow (cross-tenant account-deletion path)
        `SELECT 1 FROM invoices
          WHERE tenant_id = ANY($1::uuid[])
            AND status IN ('open','past_due')
            AND amount_due_cents > 0
          LIMIT 1`,
        [tenantIds],
      );
      return reply.code(200).send({
        hasActiveSubscription: (subQ.rowCount ?? 0) > 0,
        hasOutstandingInvoice: (invQ.rowCount ?? 0) > 0,
      });
    },
  );
}

function platformBackendErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}
