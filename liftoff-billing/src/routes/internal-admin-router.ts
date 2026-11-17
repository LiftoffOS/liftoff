import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import { validateInboundBillingHmac, PlatformBackendClient } from '../infrastructure/platform-backend-client.js';
import { withBillingTenant } from '../infrastructure/database.js';
import { provisionForTenant } from './provision.js';
import { computeRefundEligibility, type RefundEligibility } from './refund-eligibility.js';
import { lookupDefaultPaymentMethod } from '../consumers/payment-method-lookup.js';
// The Core allowance is READ from the plan config, never restated here: this
// endpoint auto-provisions Core at signup, and a literal would be a second
// authority for a number that has exactly one.
import { SELF_SERVE_PLANS } from '../billing-accounts-router.js';

/**
 * True when Stripe rejected a subscription create because the customer has no
 * payment method attached. Stripe reports this as
 * `resource_missing` + "This customer has no attached payment source or default
 * payment method", NOT as a dedicated error code.
 *
 * Both halves are required. `resource_missing` on its own covers any absent
 * object — a deleted price, an unknown customer — and treating those as
 * "no payment method" would silently stop retrying real failures.
 *
 * Note this is genuinely reachable only when the invoice has an amount due:
 * provision-test-account attaches a permanent 100%-off coupon, the invoice
 * draws to $0, and Stripe accepts the create with no card at all. That is why
 * the discriminator is the error rather than a listPaymentMethods pre-check,
 * which would break comped provisioning.
 */
function isMissingPaymentMethodStripeError(err: Stripe.errors.StripeError): boolean {
  if (err?.type !== 'StripeInvalidRequestError') return false;
  if (err.code !== 'resource_missing') return false;
  return (err.message ?? '')
    .toLowerCase()
    .includes('no attached payment source or default payment method');
}

export function registerInternalAdminRouter(
  app: FastifyInstance,
  deps: { stripe: Stripe; pool: Pool; billingServiceToken: string; ouPriceId: string; pbClient: PlatformBackendClient },
): void {
  // Route-scoped preHandler so HMAC validation only covers /api/internal/* routes
  // registered in this function and doesn't interfere with other app routes.
  const hmacPreHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const method = req.method;
    const path = req.url.split('?')[0];
    const body = JSON.stringify((req.body as object) ?? {});
    const headers = {
      timestamp: req.headers['x-billing-timestamp'] as string | undefined,
      signature: req.headers['x-billing-signature'] as string | undefined,
    };
    const valid = validateInboundBillingHmac(method, path, body, headers, deps.billingServiceToken);
    if (!valid) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  app.post(
    '/api/internal/provision-subscription',
    { preHandler: hmacPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId, stripeCustomerId } = req.body as { tenantId: string; stripeCustomerId: string };
      if (!tenantId || !stripeCustomerId) return reply.code(400).send({ error: 'missing_required_fields' });

      // Deterministically provision the real Core monthly plan. Previously this
      // endpoint ran `SELECT … FROM plans WHERE active = TRUE ORDER BY created_at
      // ASC LIMIT 1` and labelled the result `planId: 'core'`, which silently
      // attached whatever ad-hoc row happened to be oldest in the `plans` table
      // (such as a stale placeholder plan). The real
      // source of truth for the self-serve Core monthly Stripe price is the
      // STRIPE_PLAN_CORE_MONTHLY_PRICE_ID env var the rest of the service uses
      // (see /subscribe in billing-accounts-router.ts and the price→plan_id
      // mapping in stripe-event-processor.ts). Pick from that, no DB lookup.
      const corePriceId = process.env.STRIPE_PLAN_CORE_MONTHLY_PRICE_ID;
      if (!corePriceId) return reply.code(500).send({ error: 'core_plan_not_configured' });

      const priceIds = [...new Set([corePriceId, deps.ouPriceId].filter(Boolean))];
      let result: Awaited<ReturnType<typeof provisionForTenant>>;
      try {
        result = await provisionForTenant({
          tenantId, stripeCustomerId,
          planId: 'core',
          includedOus: SELF_SERVE_PLANS.core.basePlanOus,
          precommitExtraOus: 0,
          billingPeriod: 'monthly',
          provisioningSource: 'auto',
          priceItems: priceIds.map(price => ({ price })),
        }, { stripe: deps.stripe, pbClient: deps.pbClient, log: { info: console.log, warn: console.warn } });
      } catch (provisionErr) {
        // The customer has no card yet. platform-backend calls this endpoint
        // from TenantService.activate() at signup, while the fused-onboarding
        // wizard does not collect payment until step 7, so this is the NORMAL
        // outcome for a self-serve signup rather than a fault. Answer with the
        // same typed 402 /replace-subscription uses, so the caller can tell
        // "not yet" apart from "provisioning is broken" and skip its retry
        // budget accordingly. Left as a raw Stripe 400, it is indistinguishable
        // from a transient failure and gets retried for two days.
        //
        // Narrow deliberately, in the spirit of isPromoRelatedStripeError:
        // resource_missing is Stripe's code for ANY absent object, so the
        // payment-source phrase must be present too. A genuinely missing price
        // must keep surfacing as a failure.
        const stripeErr = provisionErr as Stripe.errors.StripeError;
        if (isMissingPaymentMethodStripeError(stripeErr)) {
          console.warn('billing.internal.provision-subscription: deferred — customer has no payment method', {
            tenantId, stripeCustomerId, code: stripeErr.code,
          });
          return reply.code(402).send({ error: 'no_payment_method' });
        }
        throw provisionErr;
      }

      // Populate billing_controls on the platform-backend side with the full
      // Core plan state (plan_type, included_ous, per-OU rates, billing_mode).
      // /subscribe makes the same call after provisionForTenant — without it,
      // billing_controls keeps the default ('post_pay', planType=NULL,
      // planIncludedOus=0) and the dashboard shows the "Active plan"
      // placeholder + hides the Plan usage meter. Per-OU rates aren't passed:
      // platform-backend's subscription-activated handler resolves them from
      // plan_catalog using planType. Skip on alreadyExists — the controls
      // were initialized on first provision and shouldn't be reset on retry.
      if (!result.alreadyExists) {
        await deps.pbClient.subscriptionActivated(stripeCustomerId, {
          planType: 'core',
          includedOus: SELF_SERVE_PLANS.core.basePlanOus,
          precommitExtraOus: 0,
          isAnnualPlan: false,
          tenantId,
          stripeSubscriptionId: result.stripeSubscriptionId,
        });
      }

      return reply.code(200).send({
        alreadyExists: result.alreadyExists,
        stripeSubscriptionId: result.stripeSubscriptionId,
      });
    },
  );

  // ── POST /api/internal/auto-reload ────────────────────────────────────────
  // Creates and immediately pays a prepaid wallet reload invoice, then notifies
  // platform-backend of the delta top-up. On Stripe payment error, signals
  // auto-reload failure to platform-backend and returns 402.
  app.post(
    '/api/internal/auto-reload',
    { preHandler: hmacPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { stripeCustomerId, amountUsd, tenantId } = req.body as { stripeCustomerId: string; amountUsd: number; tenantId?: string };

      if (!stripeCustomerId || typeof amountUsd !== 'number' || amountUsd <= 0) {
        return reply.code(400).send({ error: 'missing_required_fields' });
      }

      const amountCents = Math.round(amountUsd * 100);

      try {
        // The invoice FIRST, then the item bound to it by id. Creating the
        // item first relies on `pending_invoice_items_behavior`, which
        // defaults to `exclude` on this account, so the invoice came out with
        // no lines and a $0 total — an auto-reload that charges nothing.
        // `include` is not the fix: it sweeps every pending item for the
        // customer, merging concurrent reloads into one charge.
        const invoice = await deps.stripe.invoices.create({
          customer: stripeCustomerId,
          auto_advance: false,
          // tenant_id when the caller names one. It is what resolves this
          // invoice — and later any refund, dispute or fraud warning on its
          // charge — back to a workspace. An account with no subscription has
          // nothing else to be resolved by, so without it those events reach
          // no row at all.
          metadata: { type: 'prepaid_reload', ...(tenantId ? { tenant_id: tenantId } : {}) },
        });

        await deps.stripe.invoiceItems.create({
          customer: stripeCustomerId,
          invoice: invoice.id,
          amount: amountCents,
          currency: 'usd',
          description: 'Prepaid wallet reload',
        });

        await deps.stripe.invoices.finalizeInvoice(invoice.id);
        await deps.stripe.invoices.pay(invoice.id);

        // Notify platform-backend of the delta top-up amount.
        await deps.pbClient.prepaidToppedUp(stripeCustomerId, amountUsd);

        // Receipt email for the successful auto-reload — same shape as the
        // manual reload path (onCustomerBalanceTransaction). Look up the
        // default payment method that was just charged.
        // tenant_id_for_stripe_customer (migration 015) rather than the same
        // SELECT open-coded. `subscriptions` is RLS-fenced on
        // current_setting('app.current_tenant_id', false) and this pool carries no
        // scope, because resolving the tenant is the whole point — the raw read
        // would raise, not return nothing. The function is SECURITY DEFINER, so it
        // runs as the table owner and the policy does not apply.
        // webhooks/stripe-handler.ts already resolves tenants this way.
        //
        // Note the null check moved from the ROW to the VALUE: `SELECT fn()`
        // always returns exactly one row, so `rows[0]` is now always truthy and
        // testing it would pass a null tenant id downstream.
        //
        // The caller's `tenantId` first. tenant_id_for_stripe_customer reads
        // `subscriptions`, which is EMPTY for a workspace that funds itself
        // with credit instead of subscribing — so for exactly the customers
        // auto-reload exists to serve, the lookup returned null and the
        // receipt was silently skipped. The lookup stays as the fallback for
        // callers that name no workspace.
        let resolvedTenantId = tenantId ?? null;
        if (!resolvedTenantId) {
          const tidRow = await deps.pool.query<{ tenant_id: string | null }>( // rls-fence: allow (cross-tenant resolution via SECURITY DEFINER fn; no direct table access)
            `SELECT tenant_id_for_stripe_customer($1) AS tenant_id`,
            [stripeCustomerId],
          );
          resolvedTenantId = tidRow.rows[0]?.tenant_id ?? null;
        }
        const pm = resolvedTenantId
          ? await lookupDefaultPaymentMethod(deps.pool, resolvedTenantId)
          : null;
        if (pm) {
          await deps.pbClient.receipt(stripeCustomerId, {
            context: 'credit_reload',
            amountUsd,
            paymentMethodType: pm.type,
            paymentMethodLast4: pm.last4,
          }).catch(() => { /* best-effort */ });
        }

        return reply.code(200).send({ ok: true, invoiceId: invoice.id });
      } catch (err) {
        const stripeErr = err as import('stripe').default.errors.StripeError;
        if (stripeErr.type === 'StripeCardError' || stripeErr.statusCode === 402) {
          // Resolve tenant_id (auto-reload handler only has stripeCustomerId) so we
          // can look up the default payment method for the failure email.
          // Same as the success path above: SECURITY DEFINER lookup rather than a
          // raw read of an RLS-fenced table from an unscoped pool, and the null
          // check is on the value because `SELECT fn()` always yields a row.
          const tidRow = await deps.pool.query<{ tenant_id: string | null }>( // rls-fence: allow (cross-tenant resolution via SECURITY DEFINER fn; no direct table access)
            `SELECT tenant_id_for_stripe_customer($1) AS tenant_id`,
            [stripeCustomerId],
          );
          const resolvedTenantId = tidRow.rows[0]?.tenant_id ?? null;
          const pm = resolvedTenantId
            ? await lookupDefaultPaymentMethod(deps.pool, resolvedTenantId)
            : null;
          // Payment failed — notify platform-backend so it can mark auto-reload as failed.
          await deps.pbClient.autoReloadFailed(stripeCustomerId, {
            amountUsd,
            reason: stripeErr.message ?? 'payment_failed',
            paymentMethodType: pm?.type,
            paymentMethodLast4: pm?.last4,
          }).catch(() => { /* best-effort */ });
          return reply.code(402).send({ error: 'payment_failed', reason: stripeErr.message });
        }
        throw err;
      }
    },
  );

  // ── POST /api/internal/provision-enterprise ───────────────────────────────
  // Provisions an enterprise account with a $0/month Stripe subscription and
  // a custom monthly allocation. Goes through Stripe end-to-end so the full
  // webhook/event pipeline is exercised.
  // ── Refunds ────────────────────────────────────────────────────────────────
  //
  // Money leaving the building, so it goes out as a CREDIT NOTE against the
  // invoice rather than a bare charge refund. A charge refund never touches the
  // invoice, which is how the local mirror and Stripe drifted apart in the first
  // place; a credit note adjusts the invoice, produces a document accounting can
  // use, and refuses to exceed what the invoice can still credit.
  //
  // Two routes over one eligibility function, so a quote and the refund that
  // follows it can never disagree about the number.

  /** Invoice, plan facts and the resulting eligibility for one tenant. */
  async function loadRefundContext(
    tenantId: string,
    stripeInvoiceId: string,
  ): Promise<
    | { ok: true; eligibility: RefundEligibility; stripeCustomerId: string; amountPaidCents: number }
    | { ok: false; status: number; error: string }
  > {
    const invoice = await withBillingTenant(tenantId, async (client) => {
      const { rows } = await client.query<{
        type: string;
        amount_paid_cents: string;
        amount_refunded_cents: string;
        paid_at: Date | null;
        period_start: Date;
        period_end: Date;
      }>(
        `SELECT type::text AS type, amount_paid_cents, amount_refunded_cents, paid_at,
                period_start, period_end
           FROM invoices WHERE stripe_invoice_id = $1`,
        [stripeInvoiceId],
      );
      return rows[0] ?? null;
    });
    if (!invoice) return { ok: false, status: 404, error: 'invoice_not_found' };

    const stripeCustomerId = await withBillingTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ stripe_customer_id: string }>(
        `SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
        [tenantId],
      );
      return rows[0]?.stripe_customer_id ?? null;
    });
    if (!stripeCustomerId) return { ok: false, status: 404, error: 'no_stripe_customer_for_tenant' };

    // Plan shape and consumption both come from platform-backend, which owns
    // billing_controls. Nothing here is recomputed locally: a second opinion on
    // what a plan includes is a second pricing authority.
    const controls = await deps.pbClient.getControlsStatus(stripeCustomerId);
    if (!controls) return { ok: false, status: 404, error: 'billing_controls_not_found' };

    const amountPaidCents = Number(invoice.amount_paid_cents);
    const eligibility = computeRefundEligibility({
      invoiceType: invoice.type,
      amountPaidCents,
      amountRefundedCents: Number(invoice.amount_refunded_cents),
      paidAt: invoice.paid_at,
      periodStart: invoice.period_start,
      // Read off the INVOICE's own term, not the plan's current flag. An
      // invoice is refunded against what it actually bought, and a plan that has
      // since switched interval must not change how an older one is prorated.
      // The 300-day line separates a year from a month with room to spare for
      // short months and proration.
      isAnnual:
        (new Date(invoice.period_end).getTime() - new Date(invoice.period_start).getTime()) >
        300 * 24 * 60 * 60 * 1000,
      planIncludedOus: controls.planIncludedOus,
      includedRateUsdPerOu: controls.includedRateUsdPerOu,
      ousConsumedThisPeriod: controls.ousConsumedThisPeriod,
      now: new Date(),
    });

    return { ok: true, eligibility, stripeCustomerId, amountPaidCents };
  }

  app.post(
    '/api/internal/refund-quote',
    { preHandler: hmacPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId, stripeInvoiceId } = req.body as { tenantId?: string; stripeInvoiceId?: string };
      if (!tenantId || !stripeInvoiceId) return reply.code(400).send({ error: 'missing_required_fields' });

      const ctx = await loadRefundContext(tenantId, stripeInvoiceId);
      if (!ctx.ok) return reply.code(ctx.status).send({ error: ctx.error });

      return reply.send({
        refundableCents: ctx.eligibility.refundableCents,
        refusal: ctx.eligibility.refusal,
        monthsStarted: ctx.eligibility.monthsStarted ?? null,
        monthlyListCents: ctx.eligibility.monthlyListCents ?? null,
        amountPaidCents: ctx.amountPaidCents,
      });
    },
  );

  app.post(
    '/api/internal/refund',
    { preHandler: hmacPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId, stripeInvoiceId, amountCents, reason, idempotencyKey } = req.body as {
        tenantId?: string;
        stripeInvoiceId?: string;
        amountCents?: number;
        reason?: string;
        idempotencyKey?: string;
      };
      if (!tenantId || !stripeInvoiceId || !reason || !idempotencyKey) {
        return reply.code(400).send({ error: 'missing_required_fields' });
      }
      if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
        return reply.code(400).send({ error: 'amount_must_be_a_positive_integer' });
      }

      const ctx = await loadRefundContext(tenantId, stripeInvoiceId);
      if (!ctx.ok) return reply.code(ctx.status).send({ error: ctx.error });

      if (ctx.eligibility.refusal) {
        return reply.code(409).send({ error: ctx.eligibility.refusal });
      }
      // The ceiling is enforced rather than advisory. Discretion belongs in
      // "do we refund at all", never in "can we beat the formula"; a genuine
      // exception goes through the Stripe dashboard, where it is visible as one.
      if (amountCents > ctx.eligibility.refundableCents) {
        return reply.code(409).send({
          error: 'amount_exceeds_refundable',
          refundableCents: ctx.eligibility.refundableCents,
        });
      }

      try {
        // Credit note FIRST. Stripe's idempotency key makes a replay return the
        // original rather than issue a second, and on a fully paid invoice the
        // whole note is post-payment, so refund_amount must equal amount.
        const creditNote = await deps.stripe.creditNotes.create(
          {
            invoice: stripeInvoiceId,
            amount: amountCents,
            refund_amount: amountCents,
            reason: 'order_change',
            memo: reason.slice(0, 500),
            metadata: { tenant_id: tenantId, idempotency_key: idempotencyKey },
          },
          { idempotencyKey },
        );

        // Then the subscription, because the Terms say a refund ends access at
        // once. On annual this is load-bearing rather than tidy: the monthly
        // allowance reset would otherwise keep granting units for months that
        // have just been refunded. Ordered after the credit note deliberately —
        // a cancellation with no refund is far worse than the reverse.
        let cancelledSubscriptionId: string | null = null;
        const subId = (await withBillingTenant(tenantId, async (client) => {
          const { rows } = await client.query<{ stripe_subscription_id: string | null }>(
            `SELECT stripe_subscription_id FROM subscriptions
              WHERE tenant_id = $1 AND status IN ('active','trialing','past_due')
              ORDER BY updated_at DESC LIMIT 1`,
            [tenantId],
          );
          return rows[0]?.stripe_subscription_id ?? null;
        })) as string | null;
        if (subId) {
          await deps.stripe.subscriptions.cancel(subId, { prorate: false });
          cancelledSubscriptionId = subId;
        }

        // Record the document, not the amount. `charge.refunded` carries the
        // CUMULATIVE refunded total for the charge and is the single writer of
        // `amount_refunded_cents` — it has to be, because it is the only thing
        // that sees a refund issued from the Stripe dashboard. Adding here as
        // well would double-count every refund this route issues.
        await withBillingTenant(tenantId, async (client) => {
          await client.query(
            `UPDATE invoices
                SET credit_note_ids = array_append(credit_note_ids, $2)
              WHERE stripe_invoice_id = $1
                AND NOT ($2 = ANY(credit_note_ids))`,
            [stripeInvoiceId, creditNote.id],
          );
        });

        return reply.send({
          creditNoteId: creditNote.id,
          refundedCents: amountCents,
          cancelledSubscriptionId,
        });
      } catch (err) {
        const error = err as Error;
        console.error('refund: failed', { tenantId, stripeInvoiceId, error: error.message });
        return reply.code(502).send({ error: 'refund_failed', detail: error.message.slice(0, 200) });
      }
    },
  );

  app.post(
    '/api/internal/provision-enterprise',
    { preHandler: hmacPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const {
        tenantId,
        stripeCustomerId: stripeCustomerIdFromBody,
        includedOus,
        precommitExtraOus,
        includedRateUsdPerOu,
        precommitRateUsdPerOu,
        reloadRateUsdPerOu,
        stripeBilled,
        isAnnualPlan,
        annualTotalUsdCents,
        cleanOrphanState,
      } = req.body as {
        tenantId: string;
        stripeCustomerId?: string;
        includedOus: number;
        precommitExtraOus?: number;
        includedRateUsdPerOu: number;
        precommitRateUsdPerOu: number;
        reloadRateUsdPerOu: number;
        stripeBilled: boolean;
        isAnnualPlan: boolean;
        annualTotalUsdCents: number | null;
        // PR 4 — opt-in cleanup pre-step. Default false (backwards-compatible
        // with existing admin callers that don't yet set this flag).
        cleanOrphanState?: boolean;
      };

      if (!tenantId || !(includedOus > 0)
        || !(includedRateUsdPerOu > 0)
        || !(precommitRateUsdPerOu > 0)
        || !(reloadRateUsdPerOu > 0)) {
        return reply.code(400).send({ error: 'missing_required_fields' });
      }

      let stripeCustomerId!: string;
      if (stripeCustomerIdFromBody) {
        stripeCustomerId = stripeCustomerIdFromBody;
      } else {
        try {
          await withBillingTenant(tenantId, async (client) => {
            const { rows } = await client.query<{ stripe_customer_id: string }>(
              `SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
              [tenantId],
            );
            if (!rows[0]?.stripe_customer_id) {
              throw Object.assign(new Error('no_stripe_customer_for_tenant'), { notFound: true });
            }
            stripeCustomerId = rows[0].stripe_customer_id;
          });
        } catch (err) {
          const error = err as Error & { notFound?: boolean };
          if (error.notFound) return reply.code(404).send({ error: 'no_stripe_customer_for_tenant' });
          console.error('provision-enterprise: failed to resolve stripeCustomerId', { tenantId, error: error.message });
          return reply.code(500).send({ error: 'internal_error' });
        }
      }

      try {
        // Stripe price: $0 for internal tenants; computed monthly/annual fee for real paying ones.
        const monthlyFeeUsd = (includedOus * includedRateUsdPerOu)
          + ((precommitExtraOus ?? 0) * precommitRateUsdPerOu);
        const stripeUnitAmountCents = !stripeBilled
          ? 0
          : isAnnualPlan
            ? (annualTotalUsdCents ?? Math.round(monthlyFeeUsd * 100 * 10))
            : Math.round(monthlyFeeUsd * 100);
        const stripeInterval: 'month' | 'year' = isAnnualPlan ? 'year' : 'month';
        const priceName = stripeBilled
          ? `Enterprise — ${includedOus.toLocaleString()} included + ${(precommitExtraOus ?? 0).toLocaleString()} precommit OUs / ${isAnnualPlan ? 'yr' : 'mo'}`
          : `Enterprise (internal) — ${includedOus.toLocaleString()} included + ${(precommitExtraOus ?? 0).toLocaleString()} precommit OUs / ${isAnnualPlan ? 'yr' : 'mo'} (Stripe $0)`;

        const price = await deps.stripe.prices.create({
          currency: 'usd',
          unit_amount: stripeUnitAmountCents,
          product_data: { name: priceName },
          recurring: { interval: stripeInterval },
        });

        // PR 2: route through provisionForTenant for advisory lock + Stripe-side
        // dedup. Note that provisionForTenant builds its own metadata; the
        // enterprise-specific rate metadata is patched in via stripe.subscriptions.update
        // afterward so subscription.updated webhooks can re-deliver rates if needed.
        const result = await provisionForTenant({
          tenantId,
          stripeCustomerId,
          planId: 'enterprise',
          includedOus,
          precommitExtraOus: precommitExtraOus ?? 0,
          billingPeriod: isAnnualPlan ? 'yearly' : 'monthly',
          provisioningSource: 'admin_enterprise',
          priceItems: [{ price: price.id }],
          // PR 4 — forwarded from request body. Default false preserves the
          // pre-PR-4 behavior of this endpoint for any caller that omits it.
          cleanOrphanState: cleanOrphanState === true,
        }, { stripe: deps.stripe, pbClient: deps.pbClient, log: { info: console.log, warn: console.warn } });

        // Always refresh metadata, even when alreadyExists=true. Re-running
        // /api/internal/provision-enterprise on an existing sub is the path
        // ops uses to re-sync rates after a contract amendment that didn't
        // go through the admin syncRatesToBillingAndStripe path. Without
        // this refresh, a
        // later customer.subscription.updated webhook would feed stale rates
        // back to platform-backend via the metadata-driven reconcile path.
        await deps.stripe.subscriptions.update(result.stripeSubscriptionId, {
          metadata: {
            tenant_id: tenantId,
            billing_tier: 'enterprise',
            stripe_billed: String(stripeBilled),
            included_ous: String(includedOus),
            precommit_extra_ous: String(precommitExtraOus ?? 0),
            included_rate_usd_per_ou:  String(includedRateUsdPerOu),
            precommit_rate_usd_per_ou: String(precommitRateUsdPerOu),
            reload_rate_usd_per_ou:    String(reloadRateUsdPerOu),
            is_annual_plan: String(isAnnualPlan),
            billing_period: isAnnualPlan ? 'yearly' : 'monthly',
            provisioning_source: 'admin_enterprise',
          },
        });

        const liveSub = await deps.stripe.subscriptions.retrieve(result.stripeSubscriptionId);
        const subItem = liveSub.items.data[0] as (typeof liveSub.items.data[0] & { current_period_start?: number; current_period_end?: number }) | undefined;
        await deps.pbClient.subscriptionActivated(stripeCustomerId, {
          billingTier: 'enterprise',
          includedOus,
          precommitExtraOus: precommitExtraOus ?? 0,
          includedRateUsdPerOu,
          precommitRateUsdPerOu,
          reloadRateUsdPerOu,
          isAnnualPlan,
          stripeSubscriptionId: result.stripeSubscriptionId,
          stripePeriodStart: subItem?.current_period_start ? new Date(subItem.current_period_start * 1000).toISOString() : undefined,
          stripePeriodEnd: subItem?.current_period_end ? new Date(subItem.current_period_end * 1000).toISOString() : undefined,
        });

        return reply.code(200).send({ subscriptionId: result.stripeSubscriptionId, alreadyExists: result.alreadyExists });
      } catch (err) {
        const error = err as Error;
        console.error('provision-enterprise failed', { stripeCustomerId, tenantId, error: error.message });
        return reply.code(500).send({ error: 'internal_error' });
      }
    },
  );

  // /api/internal/billing-mode REMOVED in PR 2 — mode is set once at provision
  // time and is immutable for the life of the subscription.
}
