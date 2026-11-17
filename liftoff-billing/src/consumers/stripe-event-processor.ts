// Phase 1c/1e — downstream processor for `billing.stripe.*` outbox
// events emitted by the webhook handler.
//
// Reads outbox rows, translates Stripe events into canonical Liftoff
// billing events (billing.invoice.created/finalized/paid, etc.),
// upserts state (subscriptions, invoices, payment methods, credit
// balances), and re-enqueues the canonical events onto the outbox.
// The publisher then routes them to `billing-events-${env}`.
//
// Flow:
//   Stripe webhook → stripe_webhook_events + outbox (billing.stripe.*)
//     ↓ publisher → billing-stripe-<type> Pub/Sub topic
//     ↓ this consumer receives
//     ↓ withOutboxConsumer (dedup on event_id)
//     ↓ upsert business state + enqueue billing.invoice.* / etc.
//
// The consumer mounts as a Pub/Sub push subscription on the billing
// service itself — the handler POST /consumer/stripe processes one
// message at a time and acks.

import Stripe from 'stripe';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { TenantScopedClient } from '@liftoffos/database';
import { asTenantScoped } from '../infrastructure/database.js';
import { randomUUID } from 'node:crypto';
import { enqueueOutboxEvent, withOutboxConsumer, type EventEnvelope } from '@liftoffos/outbox';
import type { PlatformBackendClient } from '../infrastructure/platform-backend-client.js';
import type { StripeUsageClient } from '../infrastructure/metronome-client.js';
import { OU_METER_EVENT_NAME } from '../infrastructure/metronome-client.js';
import { lookupDefaultPaymentMethod } from './payment-method-lookup.js';
import type { ReferralCreditService } from '../referrals/service.js';

// Plan allocation map — keyed by Stripe price ID (flat-fee plan prices only).
// Used to pass planType/monthlyAllocationUsd/isAnnualPlan to platform-backend
// when a subscription transitions to active.
// PLAN_ALLOCATIONS removed in PR 1 — plan_catalog (platform-backend DB) is the
// canonical source of per-OU rates and base prices. We no longer mirror them here.

const PRICE_ID_TO_PLAN_TYPE: Record<string, 'core' | 'growth' | 'scale'> = {
  ...(process.env.STRIPE_PLAN_CORE_MONTHLY_PRICE_ID   && { [process.env.STRIPE_PLAN_CORE_MONTHLY_PRICE_ID]:   'core'   as const }),
  ...(process.env.STRIPE_PLAN_CORE_ANNUAL_PRICE_ID    && { [process.env.STRIPE_PLAN_CORE_ANNUAL_PRICE_ID]:    'core'   as const }),
  ...(process.env.STRIPE_PLAN_GROWTH_MONTHLY_PRICE_ID && { [process.env.STRIPE_PLAN_GROWTH_MONTHLY_PRICE_ID]: 'growth' as const }),
  ...(process.env.STRIPE_PLAN_GROWTH_ANNUAL_PRICE_ID  && { [process.env.STRIPE_PLAN_GROWTH_ANNUAL_PRICE_ID]:  'growth' as const }),
  ...(process.env.STRIPE_PLAN_SCALE_MONTHLY_PRICE_ID  && { [process.env.STRIPE_PLAN_SCALE_MONTHLY_PRICE_ID]:  'scale'  as const }),
  ...(process.env.STRIPE_PLAN_SCALE_ANNUAL_PRICE_ID   && { [process.env.STRIPE_PLAN_SCALE_ANNUAL_PRICE_ID]:   'scale'  as const }),
};

const ANNUAL_PRICE_IDS = new Set([
  process.env.STRIPE_PLAN_CORE_ANNUAL_PRICE_ID,
  process.env.STRIPE_PLAN_GROWTH_ANNUAL_PRICE_ID,
  process.env.STRIPE_PLAN_SCALE_ANNUAL_PRICE_ID,
].filter(Boolean));

export interface StripeProcessorDeps {
  pool: Pool;
  stripe: Stripe;
  pbClient: PlatformBackendClient;
  stripeUsage: StripeUsageClient;
  // The referral programme's money half. Injected rather than constructed here
  // so the processor's tests can drive it, and so the one instance the server
  // builds is the one the scheduled maintenance job also uses.
  referrals: ReferralCreditService;
  log: { info: (msg: string, meta?: object) => void; warn: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void };
}

// SE-004: Cross-validate metadata.type against Stripe-native billing_reason.
// metadata.type can be set by application code and could be incorrect or forged;
// billing_reason is set by Stripe and cannot be overridden by the application.
// Mismatch → reject immediately rather than processing against the wrong billing path.
type InvoiceClass = 'threshold' | 'recovery' | 'subscription_cycle' | 'prepaid_reload' | 'unknown';

export function classifyInvoice(inv: Stripe.Invoice, log: StripeProcessorDeps['log']): InvoiceClass {
  const metaType = inv.metadata?.type;
  const billingReason = inv.billing_reason;

  if (metaType === 'prepaid_reload') {
    if (billingReason === 'subscription_cycle') {
      log.error('billing.invoice.type_mismatch: prepaid_reload metadata on subscription_cycle invoice — rejecting',
        { invoiceId: inv.id, billingReason });
      throw new Error(`Invoice ${inv.id}: metadata.type=prepaid_reload conflicts with billing_reason=subscription_cycle`);
    }
    return 'prepaid_reload';
  }

  if (metaType === 'threshold') {
    if (billingReason === 'subscription_cycle') {
      log.error('billing.invoice.type_mismatch: threshold metadata on subscription_cycle invoice — rejecting',
        { invoiceId: inv.id, billingReason });
      throw new Error(`Invoice ${inv.id}: metadata.type=threshold conflicts with billing_reason=subscription_cycle`);
    }
    const level = parseFloat(inv.metadata?.threshold_level ?? '');
    if (isNaN(level) || level <= 0) {
      log.error('billing.invoice.invalid_threshold_level', { invoiceId: inv.id, raw: inv.metadata?.threshold_level });
      throw new Error(`Invoice ${inv.id}: invalid or missing threshold_level in metadata`);
    }
    return 'threshold';
  }

  if (metaType === 'recovery') {
    if (billingReason === 'subscription_cycle') {
      log.error('billing.invoice.type_mismatch: recovery metadata on subscription_cycle invoice — rejecting',
        { invoiceId: inv.id, billingReason });
      throw new Error(`Invoice ${inv.id}: metadata.type=recovery conflicts with billing_reason=subscription_cycle`);
    }
    return 'recovery';
  }

  // All three of Stripe's subscription-driven billing reasons map to the same
  // user-facing bucket. `subscription_create` is the FIRST invoice the
  // customer ever sees (a subtotal + promo + total breakdown for the first
  // period), `subscription_cycle` is a recurring renewal, and
  // `subscription_update` is a proration after a plan change. They all
  // represent "your subscription was billed" and the customer expects every
  // one of them in the invoices list.
  //
  // Treating only `subscription_cycle` as user-visible meant a newly-onboarded
  // tenant's $0-after-promo first invoice (billing_reason
  // `subscription_create`) was silently stored as `unknown` and excluded
  // from /invoices. The migration that ships with this commit backfills the
  // existing `unknown` rows.
  if (
    billingReason === 'subscription_cycle' ||
    billingReason === 'subscription_create' ||
    billingReason === 'subscription_update'
  ) {
    return 'subscription_cycle';
  }
  return 'unknown';
}

// PR 2b — threshold at which we emit the billing.mirror.update_failed outbox
// event. Configured to match the Pub/Sub subscription's maxDeliveryAttempts
// so the outbox alert fires immediately before Pub/Sub gives up and sends the
// message to its native dead-letter topic.
const MAX_RETRY_ATTEMPTS_BEFORE_DLQ = 5;

// Stripe events whose object names a CHARGE rather than an invoice or a
// subscription, and which therefore carry no tenant of their own.
const CHARGE_FAMILY_EVENTS = new Set<string>([
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.funds_reinstated',
  'radar.early_fraud_warning.created',
]);

interface ChargeContext {
  chargeId: string;
  charge: Stripe.Charge;
  invoiceId: string | null;
}

/**
 * The charge behind one of the events above, with the invoice it paid.
 *
 * `charge.refunded` IS the charge; a dispute and an early fraud warning carry
 * its id and need a retrieve. Resolved once per event and passed down, so the
 * handlers do not each make the same Stripe call.
 */
async function chargeForEvent(event: Stripe.Event, deps: StripeProcessorDeps): Promise<ChargeContext> {
  const obj = event.data.object as Stripe.Charge | Stripe.Dispute | Stripe.Radar.EarlyFraudWarning;

  let charge: Stripe.Charge;
  if (obj.object === 'charge') {
    charge = obj;
    // NEVER trust the payload's shape for the invoice link.
    //
    // A webhook payload is serialised at the ENDPOINT's API version, which is
    // set in the Stripe dashboard and is not the version this SDK pins.
    // `Charge.invoice` was removed in later versions: an endpoint on
    // 2026-02-25.clover omits the field, while the SDK reads 2024-06-20, where
    // it is still populated. Trusting the payload, a refund logs
    // `charge_without_invoice` and claws back nothing, which is the same
    // silence this whole path exists to end.
    //
    // Re-reading through the SDK costs one call on a rare event and makes the
    // resolution depend on the version we pin rather than the one an operator
    // happened to pick in the dashboard.
    if (!charge.invoice) {
      charge = await deps.stripe.charges.retrieve(charge.id);
    }
  } else {
    const chargeId = typeof obj.charge === 'string' ? obj.charge : obj.charge.id;
    charge = await deps.stripe.charges.retrieve(chargeId);
  }

  const invoiceId = typeof charge.invoice === 'string'
    ? charge.invoice
    : (charge.invoice as Stripe.Invoice | null)?.id ?? null;

  return { chargeId: charge.id, charge, invoiceId };
}

export function registerStripeEventProcessor(
  app: FastifyInstance,
  deps: StripeProcessorDeps,
): void {
  // Pub/Sub push format: { message: { data: <base64 json>, attributes: {...} },
  // subscription: "...", deliveryAttempt?: <int> }.
  // `deliveryAttempt` is set by Pub/Sub when the subscription has a dead-letter
  // policy configured; it starts at 1 on the initial delivery and increments
  // on each redelivery.
  app.post(
    '/consumer/stripe',
    async (
      req: FastifyRequest<{
        Body: {
          message?: { data?: string; attributes?: Record<string, string> };
          subscription?: string;
          deliveryAttempt?: number;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const pushed = req.body?.message;
      if (!pushed?.data) return reply.code(400).send({ error: 'no_message_data' });
      const rawEnvelope = Buffer.from(pushed.data, 'base64').toString('utf-8');
      let envelope: EventEnvelope;
      try {
        envelope = JSON.parse(rawEnvelope);
        envelope.occurredAt = new Date(envelope.occurredAt);
      } catch {
        return reply.code(400).send({ error: 'bad_envelope' });
      }

      const deliveryAttempt = req.body?.deliveryAttempt ?? 1;

      try {
        const result = await withOutboxConsumer(deps.pool, envelope, async (client, env) => {
          // RLS on subscriptions/invoices/etc requires app.current_tenant_id per transaction.
          // SET LOCAL doesn't support $1 params; use set_config with is_local=true instead.
          await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', env.tenantId]);
          await processStripeEvent(asTenantScoped(client), env, deps, { deliveryAttempt });
        });
        return reply.code(200).send({ alreadyProcessed: result.alreadyProcessed });
      } catch (err) {
        deps.log.error('stripe.consumer.processing_failed', {
          eventId: envelope.eventId,
          error: err instanceof Error ? err.message : String(err),
          deliveryAttempt,
        });
        // 500 → Pub/Sub retries per the ack-deadline; DLQ after max redelivery.
        return reply.code(500).send({ error: 'processing_failed' });
      }
    },
  );
}

/**
 * Translate one `billing.stripe.<type>` envelope into canonical
 * Liftoff state writes + outbox events. Runs inside the consumer's
 * transaction (via withOutboxConsumer) so business-state writes +
 * outbox rows commit atomically.
 */
export async function processStripeEvent(
  client: TenantScopedClient,
  envelope: EventEnvelope,
  deps: StripeProcessorDeps,
  ctx: { deliveryAttempt?: number } = {},
): Promise<void> {
  const deliveryAttempt = ctx.deliveryAttempt ?? 1;
  // billing.stripe_usage.ingest_failed is an internal retry event — it is NOT a Stripe
  // webhook and has no stripeEventId. Dispatch it before the stripeEventId guard below,
  // which only applies to webhook-origin events.
  if (envelope.eventType === 'billing.stripe_usage.ingest_failed') {
    const p = envelope.payload as { requestId: string; quantity: string; error: string };
    const { rows } = await client.query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM subscriptions
       WHERE tenant_id = $1 AND status IN ('active','trialing','past_due','incomplete')
       ORDER BY updated_at DESC LIMIT 1`,
      [envelope.tenantId],
    );
    const cid = rows[0]?.stripe_customer_id;
    if (!cid) {
      deps.log.warn('billing.stripe_usage.retry: no customer yet — will retry via Pub/Sub', { tenantId: envelope.tenantId });
      throw new Error('no_stripe_customer_for_retry');
    }
    await deps.stripe.billing.meterEvents.create({
      event_name: OU_METER_EVENT_NAME,
      payload: { value: p.quantity, stripe_customer_id: cid },
      identifier: p.requestId,
      timestamp: Math.floor(envelope.occurredAt.getTime() / 1000),
    });
    return;
  }

  const payload = envelope.payload as { stripeEventId: string; stripeEventType: string };
  if (!payload?.stripeEventId) return;

  // Load the original Stripe payload from stripe_webhook_events —
  // it's the authoritative source; the outbox payload was a marker.
  const row = await client.query<{ payload: Stripe.Event }>( // rls-fence: allow (stripe_webhook_events carries no row-level security)
    `SELECT payload FROM stripe_webhook_events WHERE stripe_event_id = $1`,
    [payload.stripeEventId],
  );
  if (row.rows.length === 0) {
    deps.log.warn('stripe.consumer.event_not_found', { stripeEventId: payload.stripeEventId });
    return;
  }
  const event = row.rows[0].payload;

  // Re-extract real tenantId from Stripe event metadata. The webhook handler may
  // have emitted a sentinel randomUUID() when metadata.tenant_id was absent at
  // receive time (e.g. race before subscription metadata was populated). For
  // subscription events, metadata.tenant_id IS present — always use it.
  const resolvedFromMeta = resolveEventTenantId(event);
  let effectiveTenantId = resolvedFromMeta ?? envelope.tenantId;

  // Invoice events lack tenant_id in Stripe metadata. Attribute each invoice to
  // the tenant of the SUBSCRIPTION that generated it (stable for the account's
  // whole life), NOT the customer's latest subscription — the Stripe customer is
  // reused across delete+re-signup lives (each life gets a fresh tenant_id), so a
  // customer-based lookup leaks a prior life's invoice into the current tenant.
  // The lookup uses a SECURITY DEFINER function (billing_migrate is table owner
  // → bypasses RLS on subscriptions).
  if (resolvedFromMeta === null && event.type.startsWith('invoice.')) {
    const inv = event.data.object as Stripe.Invoice;
    const subId = typeof inv.subscription === 'string' ? inv.subscription : null;
    let invoiceTenant: string | null = null;

    if (subId) {
      const lookup = await client.query<{ tenant_id: string | null }>(
        `SELECT tenant_id_for_stripe_subscription($1) AS tenant_id`,
        [subId],
      );
      invoiceTenant = lookup.rows[0]?.tenant_id ?? null;
      if (!invoiceTenant) {
        // invoice.created can beat customer.subscription.created. Retry via
        // Pub/Sub redelivery until the subscription row exists; never fall back
        // to a customer lookup (that would cross-attribute across lives).
        if (deliveryAttempt < MAX_RETRY_ATTEMPTS_BEFORE_DLQ) {
          deps.log.warn('stripe.consumer.invoice_subscription_not_yet_synced',
            { stripeInvoiceId: inv.id, subId, deliveryAttempt });
          throw new Error('invoice_subscription_not_yet_synced');
        }
        deps.log.error('stripe.consumer.invoice_subscription_unresolved',
          { stripeInvoiceId: inv.id, subId, deliveryAttempt });
        throw new Error('invoice_subscription_unresolved'); // → DLQ, loudly
      }
    } else {
      // No subscription on the invoice (rare one-off; reload/threshold invoices
      // carry metadata.tenant_id and are resolved above). Customer lookup is an
      // acceptable last resort here.
      const customerId = typeof inv.customer === 'string'
        ? inv.customer
        : (inv.customer as Stripe.Customer | null)?.id ?? null;
      if (customerId) {
        const lookup = await client.query<{ tenant_id: string | null }>(
          `SELECT tenant_id_for_stripe_customer($1) AS tenant_id`,
          [customerId],
        );
        invoiceTenant = lookup.rows[0]?.tenant_id ?? null;
      }
    }

    if (invoiceTenant) {
      effectiveTenantId = invoiceTenant;
    } else {
      // Unresolvable (no subscription, no customer match). Do NOT write a
      // sentinel-tenant row that would be invisible to the real tenant — throw
      // so the event retries / DLQs instead of being silently lost.
      deps.log.error('stripe.consumer.invoice_tenant_unresolved', { stripeInvoiceId: inv.id });
      throw new Error('invoice_tenant_unresolved');
    }
  }

  // The charge family carries no tenant either, and unlike an invoice these
  // objects do not even name one: a dispute and a fraud warning name a charge.
  // Resolve charge → invoice → tenant once, here, and hand the charge to the
  // handler so it is not retrieved a second time.
  //
  // This is what makes the clawback work at all. Before it, the envelope's
  // sentinel tenant was bound as app.current_tenant_id and every one of these
  // handlers read `invoices` under it — a strict-RLS table with no
  // cross-tenant lane — so the lookup matched nothing and the handler returned
  // having done nothing, for every refund and every dispute. Unresolvable is
  // therefore an error rather than a skip: a miss means the invoice row never
  // landed, and silence is the exact failure this block exists to end.
  let chargeCtx: ChargeContext | null = null;
  if (resolvedFromMeta === null && CHARGE_FAMILY_EVENTS.has(event.type)) {
    chargeCtx = await chargeForEvent(event, deps);
    if (!chargeCtx.invoiceId) {
      // A charge of ours is always an invoice payment. One without an invoice
      // is not something this service issued.
      deps.log.warn('stripe.consumer.charge_without_invoice',
        { eventType: event.type, chargeId: chargeCtx.chargeId });
      return;
    }
    const lookup = await client.query<{ tenant_id: string | null }>( // rls-fence: allow (cross-tenant resolution via SECURITY DEFINER fn; no direct table access)
      `SELECT tenant_id_for_stripe_invoice($1) AS tenant_id`,
      [chargeCtx.invoiceId],
    );
    const chargeTenant = lookup.rows[0]?.tenant_id ?? null;
    if (!chargeTenant) {
      deps.log.error('stripe.consumer.charge_invoice_tenant_unresolved', {
        eventType: event.type,
        chargeId: chargeCtx.chargeId,
        invoiceId: chargeCtx.invoiceId,
        deliveryAttempt,
      });
      throw new Error('charge_invoice_tenant_unresolved'); // retry, then DLQ, loudly
    }
    effectiveTenantId = chargeTenant;
  }

  if (effectiveTenantId !== envelope.tenantId) {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', effectiveTenantId]);
  }

  switch (event.type as string) {
    case 'invoice.created':
      await onInvoiceCreated(client, effectiveTenantId, event, deps);
      break;
    case 'invoice.finalized':
      await onInvoiceFinalized(client, effectiveTenantId, event, deps);
      break;
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      await onInvoicePaid(client, effectiveTenantId, event, deps);
      break;
    case 'invoice.payment_failed':
      await onPaymentFailed(client, effectiveTenantId, event, deps);
      break;
    case 'customer.subscription.created':
      await onSubscriptionCreated(client, effectiveTenantId, event, deps);
      break;
    case 'customer.subscription.updated':
      await onSubscriptionUpdated(client, effectiveTenantId, event, deps);
      break;
    case 'customer.subscription.deleted':
      await onSubscriptionCanceled(client, effectiveTenantId, event, deps, { deliveryAttempt });
      break;
    case 'payment_method.attached':
    case 'payment_method.updated':
      await onPaymentMethodChanged(client, effectiveTenantId, event, deps);
      break;
    case 'customer.balance_transaction.created':
      await onCustomerBalanceTransaction(client, effectiveTenantId, event, deps);
      break;
    case 'customer.balance_funded':
    case 'billing.credit_grant.created':
    case 'billing.credit_grant.updated':
      await onCreditBalanceChanged(client, effectiveTenantId, event);
      break;
    // A refund or dispute of a payment that earned referral credit reverses
    // that credit. Handled here rather than only on invoice.voided because the
    // money can be taken back long after the invoice settled: a card dispute
    // can be filed up to 120 days after the transaction, while the 60 day
    // vesting hold only covers the first half of that window.
    case 'charge.refunded':
      await onChargeRefunded(client, chargeCtx ?? await chargeForEvent(event, deps), deps);
      break;
    case 'charge.dispute.created':
      await onChargeDisputed(client, chargeCtx ?? await chargeForEvent(event, deps), event, deps);
      break;
    // The issuer of a card that paid this account has reported the payment as
    // fraud, days before any dispute. A hold, never a clawback — see the
    // handler.
    case 'radar.early_fraud_warning.created':
      await onEarlyFraudWarning(client, chargeCtx ?? await chargeForEvent(event, deps), event, deps);
      break;
    // A dispute decided in our favour gives the money back, so the credit its
    // filing reversed has to come back with it. Without this the reversal is
    // permanent on a payment that was never lost.
    case 'charge.dispute.funds_reinstated':
      await onChargeDisputeFundsReinstated(client, chargeCtx ?? await chargeForEvent(event, deps), event, deps);
      break;
    default:
      // Unknown / uninteresting Stripe event — mark the webhook row
      // processed and skip.
      break;
  }

  await client.query( // rls-fence: allow (client pre-scoped via set_config-in-tx (outbox consumer))
    `UPDATE stripe_webhook_events SET processed_at = NOW() WHERE stripe_event_id = $1`,
    [payload.stripeEventId],
  );
}

// ── Handlers ──────────────────────────────────────────────────────────

async function onInvoiceCreated(client: TenantScopedClient, tenantId: string, event: Stripe.Event, deps: StripeProcessorDeps): Promise<void> {
  const inv = event.data.object as Stripe.Invoice;
  let invoiceType: 'subscription_cycle' | 'prepaid_reload' | 'threshold' | 'recovery' | 'unknown' = 'unknown';
  try { invoiceType = classifyInvoice(inv, deps.log); } catch { invoiceType = 'unknown'; }
  await upsertInvoice(client, tenantId, inv, undefined, invoiceType);
  await enqueueOutboxEvent(client, makeEnvelope(tenantId, 'billing.invoice.created', {
    invoiceId: inv.id,
    stripeInvoiceId: inv.id,
    amountDueCents: String(BigInt(inv.amount_due ?? 0)),
    currency: inv.currency,
    periodStart: new Date((inv.period_start ?? 0) * 1000).toISOString(),
    periodEnd: new Date((inv.period_end ?? 0) * 1000).toISOString(),
  }));

  // BE-011: On subscription_cycle invoices, create a negative Stripe InvoiceItem
  // to offset threshold charges already pre-collected this period.
  // This prevents double-charging: threshold charges are collected during the month,
  // so the monthly invoice must be reduced by that amount.
  const stripeCustomerId = extractStripeCustomerId(inv);
  if (stripeCustomerId && inv.billing_reason === 'subscription_cycle' && inv.status === 'draft') {
    try {
      const status = await deps.pbClient.getControlsStatus(stripeCustomerId);
      const collected = status?.thresholdChargesCollectedUsd ?? 0;
      if (collected > 0) {
        const offsetCents = -Math.round(collected * 100); // negative cents
        await deps.stripe.invoiceItems.create({
          customer: stripeCustomerId,
          invoice: inv.id,
          amount: offsetCents,
          currency: inv.currency ?? 'usd',
          description: `Threshold charges pre-collected this period ($${collected.toFixed(2)})`,
        });
        deps.log.info('billing.invoice.threshold_offset_applied',
          { invoiceId: inv.id, stripeCustomerId, collected, offsetCents });
      }
    } catch (err) {
      // Non-fatal — if the offset fails, the invoice will be higher than expected.
      // Ops can correct manually via Stripe dashboard.
      deps.log.error('billing.invoice.threshold_offset_failed',
        { invoiceId: inv.id, stripeCustomerId, error: (err as Error).message });
    }
  }

  // Referral credit is applied here, on the DRAFT subscription invoice, because
  // Stripe draws the customer balance down when an invoice finalizes — which
  // makes the monthly and annual cases one code path and is why the balance is
  // the mechanism. Credit reduces the recurring plan charge and nothing else,
  // so threshold, recovery and reload invoices are left alone.
  //
  // Non-fatal. A failure here leaves the credit unspent and still `granted`, so
  // the next invoice picks it up; letting it throw would fail the whole event
  // and retry every other side effect above alongside it.
  if (inv.billing_reason === 'subscription_cycle' || inv.billing_reason === 'subscription_create') {
    try {
      await deps.referrals.applyToInvoice(tenantId, inv);
    } catch (err) {
      deps.log.error('billing.invoice.referral_credit_apply_failed',
        { invoiceId: inv.id, tenantId, error: (err as Error).message });
    }
  }
}

async function onInvoiceFinalized(client: TenantScopedClient, tenantId: string, event: Stripe.Event, deps: StripeProcessorDeps): Promise<void> {
  const inv = event.data.object as Stripe.Invoice;
  let invoiceType: 'subscription_cycle' | 'prepaid_reload' | 'threshold' | 'recovery' | 'unknown' = 'unknown';
  try { invoiceType = classifyInvoice(inv, deps.log); } catch { invoiceType = 'unknown'; }
  await upsertInvoice(client, tenantId, inv, 'finalized', invoiceType);
  await enqueueOutboxEvent(client, makeEnvelope(tenantId, 'billing.invoice.finalized', {
    invoiceId: inv.id,
    stripeInvoiceId: inv.id,
    amountDueCents: String(BigInt(inv.amount_due ?? 0)),
    amountPaidCents: String(BigInt(inv.amount_paid ?? 0)),
    currency: inv.currency,
    issuedAt: new Date().toISOString(),
  }));
}

async function onInvoicePaid(client: TenantScopedClient, tenantId: string, event: Stripe.Event, deps: StripeProcessorDeps): Promise<void> {
  const inv = event.data.object as Stripe.Invoice;
  let invoiceType: 'subscription_cycle' | 'prepaid_reload' | 'threshold' | 'recovery' | 'unknown' = 'unknown';
  try { invoiceType = classifyInvoice(inv, deps.log); } catch { invoiceType = 'unknown'; }
  await upsertInvoice(client, tenantId, inv, 'paid', invoiceType);
  await enqueueOutboxEvent(client, makeEnvelope(tenantId, 'billing.payment.succeeded', {
    invoiceId: inv.id,
    amountCents: String(BigInt(inv.amount_paid ?? 0)),
    paymentMethodId: (inv.default_payment_method as string | null) ?? null,
  }));

  const stripeCustomerId = extractStripeCustomerId(inv);
  if (!stripeCustomerId) {
    // Credit ledger only — no billing_controls state to update.
    if (inv.amount_paid && inv.amount_paid > 0) {
      await adjustCreditBalance(client, tenantId, BigInt(inv.amount_paid), 'invoice_paid');
    }
    return;
  }

  // SE-004: Cross-validate metadata.type against Stripe-native billing_reason before dispatching.
  let invoiceClass: InvoiceClass;
  try {
    invoiceClass = classifyInvoice(inv, deps.log);
  } catch (err) {
    deps.log.error('billing.invoice.classification_failed — skipping billing_controls update',
      { invoiceId: inv.id, error: (err as Error).message });
    return;
  }

  if (invoiceClass === 'threshold') {
    // Threshold charge succeeded. Clears suspension if set (recovery path merged in).
    // Migration B dropped prepaid_balance_usd; the PB handler no longer accepts
    // a balance hint, so we don't fetch the Stripe Customer Balance here.
    // Customer-balance sync still happens via the customer.balance_transaction.created
    // webhook (handled by onCustomerBalanceTransaction → prepaidToppedUp).
    const thresholdLevel = inv.metadata!.threshold_level!;

    deps.pbClient.thresholdSucceeded(stripeCustomerId, { thresholdLevel })
      .catch((err: Error) =>
        deps.log.warn('stripe.consumer.threshold_succeeded_call_failed',
          { error: err.message, stripeCustomerId }),
      );

  } else if (invoiceClass === 'recovery') {
    // CS-initiated recovery invoice paid — clear suspension and outstanding balance.
    deps.pbClient.recoverySucceeded(stripeCustomerId).catch((err: Error) =>
      deps.log.warn('stripe.consumer.recovery_succeeded_call_failed', { error: err.message, stripeCustomerId }),
    );

  } else if (invoiceClass === 'prepaid_reload') {
    // Two producers of prepaid_reload invoices, one crediting each.
    //
    // Auto-reload (/api/internal/auto-reload) pays off-session and credits the
    // wallet synchronously, and its invoices carry no `source`. A MANUAL
    // top-up is confirmed in the customer's browser so the card's issuer can
    // authenticate it, which means nothing server-side is present when it
    // settles — this event is the only place that sees it.
    //
    // Stripe sends both invoice.paid and invoice.payment_succeeded for one
    // payment, and Pub/Sub may redeliver either, so the mark is what makes the
    // credit fire once. The ingress dedupe does not cover it: those are two
    // different Stripe events with two different ids. Taking the mark inside
    // the consumer's transaction, and rethrowing a platform-backend failure,
    // keeps the mark and the credit from ever disagreeing.
    if (inv.metadata?.source === 'manual' && inv.amount_paid && inv.amount_paid > 0) {
      const marked = await client.query<{ id: string }>( // rls-fence: allow (client pre-scoped via set_config-in-tx (outbox consumer))
        `UPDATE invoices SET wallet_credited_at = NOW()
          WHERE stripe_invoice_id = $1 AND wallet_credited_at IS NULL
          RETURNING id`,
        [inv.id],
      );

      if (marked.rows.length > 0) {
        const amountUsd = inv.amount_paid / 100;
        await deps.pbClient.prepaidToppedUp(stripeCustomerId, amountUsd);

        // Receipt, as the auto-reload path sends one. Best-effort there and
        // here: a missing receipt is not worth replaying a credit for.
        const pm = await lookupDefaultPaymentMethod(client, tenantId);
        if (pm) {
          deps.pbClient.receipt(stripeCustomerId, {
            context: 'credit_reload',
            amountUsd,
            paymentMethodType: pm.type,
            paymentMethodLast4: pm.last4,
          }).catch((err: Error) =>
            deps.log.warn('stripe.consumer.receipt_reload_call_failed', { error: err.message, stripeCustomerId }),
          );
        }

        deps.log.info('stripe.consumer.manual_top_up_credited',
          { invoiceId: inv.id, amountUsd, stripeCustomerId });
      }
    }
    // No credit-ledger row for a wallet top-up, which is what the fall-through
    // below did for this class before it had a branch of its own.
    return;

  } else if (invoiceClass === 'subscription_cycle') {
    // Monthly renewal — reset the spend counter for the new period.
    // Use subscription.current_period_start (the NEW period start) not invoice.period_start
    // (which is the OLD period being invoiced) — BE-009 fix.
    const subscriptionId = typeof inv.subscription === 'string' ? inv.subscription : null;
    let periodStart: string;
    if (subscriptionId) {
      try {
        const sub = await deps.stripe.subscriptions.retrieve(subscriptionId);
        periodStart = new Date((subPeriodStart(sub) ?? 0) * 1000).toISOString();
      } catch (err) {
        deps.log.warn('stripe.consumer.subscription_retrieve_failed — falling back to invoice.period_end',
          { subscriptionId, error: (err as Error).message });
        // period_end of the paid invoice = start of the new period
        periodStart = inv.period_end ? new Date(inv.period_end * 1000).toISOString() : new Date().toISOString();
      }
    } else {
      periodStart = inv.period_end ? new Date(inv.period_end * 1000).toISOString() : new Date().toISOString();
    }

    deps.pbClient.periodReset(stripeCustomerId, {
      billingPeriodStart: periodStart,
      stripePeriodStart: periodStart,
      stripeSubscriptionId: subscriptionId,
    }).catch((err: Error) =>
      deps.log.warn('stripe.consumer.period_reset_call_failed', { error: err.message, stripeCustomerId }),
    );

    // The fused-onboarding kick-off that used to fire here is gone. It called
    // platform-backend's /restart-full-distill on the first subscription
    // invoice, to run the distill of whatever the customer had assembled
    // during onboarding — work that had to be deferred because the hire
    // happened before the card. The hire now happens after onboarding, where
    // the distill runs directly, so there is nothing to resume and the
    // endpoint has been removed. See platform-backend ADR-050.

    // Receipt email — skip the very first cycle invoice (covered by
    // subscription-confirmation Template 1). For genuine renewals, look up
    // the default payment method from the local table and fire the unified
    // receipt notification.
    if (inv.billing_reason !== 'subscription_create') {
      const pm = await lookupDefaultPaymentMethod(client, tenantId);
      if (pm) {
        deps.pbClient.receipt(stripeCustomerId, {
          context: 'subscription_renewal',
          amountUsd: (inv.amount_paid ?? 0) / 100,
          paymentMethodType: pm.type,
          paymentMethodLast4: pm.last4,
        }).catch((err: Error) =>
          deps.log.warn('stripe.consumer.receipt_renewal_call_failed', { error: err.message, stripeCustomerId }),
        );
      }
    }

    // The referral programme's earning event. A referred workspace's FIRST
    // full-priced paid invoice is what earns the referrer credit and grants the
    // referee's bonus Operating Units — not the subscription record, which is
    // free to fake, and not the signup, at which the bonus would cost an
    // attacker one email address.
    //
    // Deliberately NOT swallowed. Every write it makes is idempotent (the
    // credit is UNIQUE on referral_id and the bonus grant refuses a second
    // one), so letting a platform-backend failure 500 the event costs a
    // Pub/Sub retry, whereas catching it would silently lose the referral and
    // leave a referrer permanently unpaid with nothing recorded anywhere.
    await deps.referrals.onReferredInvoicePaid(client, tenantId, inv);

    // Monthly invoices go to the credit ledger.
    if (inv.amount_paid && inv.amount_paid > 0) {
      await adjustCreditBalance(client, tenantId, BigInt(inv.amount_paid), 'invoice_paid');
    }
    return; // credit ledger already handled above; skip the catch-all below
  }

  // Credit ledger — skip for threshold and recovery advance collections.
  if (invoiceClass === 'unknown' && inv.amount_paid && inv.amount_paid > 0) {
    await adjustCreditBalance(client, tenantId, BigInt(inv.amount_paid), 'invoice_paid');
  }
}

async function onPaymentFailed(client: TenantScopedClient, tenantId: string, event: Stripe.Event, deps: StripeProcessorDeps): Promise<void> {
  const inv = event.data.object as Stripe.Invoice;
  await enqueueOutboxEvent(client, makeEnvelope(tenantId, 'billing.payment.failed', {
    invoiceId: inv.id,
    amountCents: String(BigInt(inv.amount_due ?? 0)),
    paymentMethodId: (inv.default_payment_method as string | null) ?? null,
    failureCode: inv.last_finalization_error?.code ?? 'unknown',
    failureMessage: inv.last_finalization_error?.message ?? 'unknown',
  }));

  const stripeCustomerId = extractStripeCustomerId(inv);
  if (!stripeCustomerId) return;

  // SE-004: Cross-validate metadata.type before dispatching to billing_controls.
  let invoiceClass: InvoiceClass;
  try {
    invoiceClass = classifyInvoice(inv, deps.log);
  } catch (err) {
    deps.log.error('billing.invoice.classification_failed — skipping thresholdFailed',
      { invoiceId: inv.id, error: (err as Error).message });
    return;
  }

  const outstandingBalanceUsd = (inv.amount_due ?? 0) / 100;

  if (invoiceClass === 'threshold') {
    const thresholdLevel = inv.metadata!.threshold_level!;
    deps.pbClient.thresholdFailed(stripeCustomerId, {
      thresholdLevel,
      outstandingBalanceUsd,
    }).catch((err: Error) =>
      deps.log.warn('stripe.consumer.threshold_failed_call_failed', { error: err.message, stripeCustomerId }),
    );
  } else if (invoiceClass === 'subscription_cycle' || invoiceClass === 'recovery') {
    // Subscription renewal or recovery invoice failed — suspend the account.
    // Use paymentFailed (not thresholdFailed) to avoid rolling back next_threshold_usd.
    deps.pbClient.paymentFailed(stripeCustomerId, { outstandingBalanceUsd }).catch((err: Error) =>
      deps.log.warn('stripe.consumer.payment_failed_call_failed', { error: err.message, stripeCustomerId, invoiceClass }),
    );
  }
}

// In Stripe's "flexible" billing_mode (latest API without a pinned version), current_period_start/end
// live on items[0] rather than at the subscription top level. Fall back to items when null.
function subPeriodStart(sub: Stripe.Subscription): number | null {
  if (sub.current_period_start) return sub.current_period_start;
  const item0 = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_start?: number }) | undefined;
  return item0?.current_period_start ?? null;
}
function subPeriodEnd(sub: Stripe.Subscription): number | null {
  if (sub.current_period_end) return sub.current_period_end;
  const item0 = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
  return item0?.current_period_end ?? null;
}

export async function upsertSubscription(client: TenantScopedClient, tenantId: string, sub: Stripe.Subscription, planId: string): Promise<void> {
  await upsertSubscriptionReturningInserted(client, tenantId, sub, planId);
}

// Returns true if the row was actually INSERTed (xmax='0'); false if UPDATEd.
// PR 2 uses this in onSubscriptionCreated to detect webhook backfills (a row
// the synchronous provision path failed to write) and emit a metric.
export async function upsertSubscriptionReturningInserted(
  client: TenantScopedClient, tenantId: string, sub: Stripe.Subscription, planId: string,
): Promise<boolean> {
  const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as Stripe.Customer | null)?.id ?? null;
  const r = await client.query<{ xmax: string }>(
    `INSERT INTO subscriptions (id, tenant_id, stripe_subscription_id, stripe_customer_id,
                                status, plan_id, current_period_start, current_period_end,
                                cancel_at_period_end, canceled_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8, $9, NOW())
     ON CONFLICT (stripe_subscription_id) DO UPDATE
       SET stripe_customer_id   = EXCLUDED.stripe_customer_id,
           status               = EXCLUDED.status,
           plan_id              = EXCLUDED.plan_id,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end   = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           canceled_at          = EXCLUDED.canceled_at,
           updated_at           = NOW()
     RETURNING xmax::text`,
    [tenantId, sub.id, stripeCustomerId, sub.status, planId,
     subPeriodStart(sub), subPeriodEnd(sub), sub.cancel_at_period_end,
     sub.canceled_at ? new Date(sub.canceled_at * 1000) : null],
  );
  // xmax = '0' for an actual INSERT (a fresh row); non-zero for the UPDATE branch.
  return r.rows[0]?.xmax === '0';
}

async function onSubscriptionCreated(client: TenantScopedClient, tenantId: string, event: Stripe.Event, deps: StripeProcessorDeps): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;
  const isAutoProvisioned = sub.metadata?.provisioning_source === 'auto';

  if (!isAutoProvisioned) {
    const { rows: existing } = await client.query<{ stripe_subscription_id: string }>(
      `SELECT stripe_subscription_id FROM subscriptions
       WHERE tenant_id = $1 AND status NOT IN ('canceled','incomplete_expired')`,
      [tenantId],
    );
    if (existing.length > 0) {
      void (async () => {
        for (const row of existing) {
          try {
            const existingSub = await deps.stripe.subscriptions.retrieve(row.stripe_subscription_id);
            if (existingSub.metadata?.provisioning_source === 'auto') {
              await deps.stripe.subscriptions.cancel(row.stripe_subscription_id, { prorate: false });
              deps.log.info('billing: canceled auto-provisioned subscription on checkout', { tenantId, canceledSubId: row.stripe_subscription_id });
            }
          } catch (err) {
            deps.log.warn('billing: failed to cancel auto-provisioned subscription', { tenantId, subId: row.stripe_subscription_id, err });
          }
        }
      })();
    }
  }

  const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as Stripe.Customer | null)?.id ?? null;
  const planId = await resolveSubscriptionPlanId(client, sub);
  if (!planId) {
    deps.log.warn('stripe.consumer.subscription_created_plan_not_resolved', {
      subscriptionId: sub.id,
      priceId: sub.items.data[0]?.price.id,
    });
    return;
  }

  const inserted = await upsertSubscriptionReturningInserted(client, tenantId, sub, planId);
  if (inserted) {
    deps.log.warn('subscriptions.row_backfill_from_webhook',
      { tenantId, subscriptionId: sub.id });
  }
  await enqueueOutboxEvent(client, makeEnvelope(tenantId, 'billing.subscription.updated', {
    subscriptionId: sub.id,
    planId,
    status: sub.status,
    currentPeriodEnd: new Date((subPeriodEnd(sub) ?? 0) * 1000).toISOString(),
  }));

  // Initialize billing_controls row in platform-backend, then sync subscription items.
  // initControls must complete before syncSubscriptionItems — the sync reads
  // billing_controls.stripe_subscription_id written by initControls.
  if (stripeCustomerId) {
    const stripePeriodStart = new Date((subPeriodStart(sub) ?? 0) * 1000).toISOString();
    try {
      await deps.pbClient.initControls(stripeCustomerId, {
        tenantId,
        stripeSubscriptionId: sub.id,
        stripePeriodStart,
        currency: sub.currency ?? 'usd',
      });
    } catch (err) {
      deps.log.warn('stripe.consumer.init_controls_failed', { error: (err as Error).message, tenantId });
      return;
    }
    deps.pbClient.syncSubscriptionItems(sub.id).catch((err: Error) =>
      deps.log.warn('stripe.consumer.sync_subscription_items_failed', { error: err.message }),
    );

    // Attach OU metered price to subscription for Stripe-native usage billing.
    // Non-fatal: failure logged; subscription state is already committed.
    deps.stripeUsage.attachOuPriceToSubscription(sub.id).then(() => {
      deps.log.info('billing.stripe_usage.attached', { tenantId, subscriptionId: sub.id });
    }).catch((err: Error) => {
      deps.log.error('billing.stripe_usage.attach_failed', { tenantId, subscriptionId: sub.id, error: err.message });
    });
  }
}

async function onSubscriptionUpdated(client: TenantScopedClient, tenantId: string, event: Stripe.Event, deps: StripeProcessorDeps): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;

  // Plan resolution uses metadata.plan_id as the primary signal for
  // self-serve subs (their ad-hoc price isn't in the plans table). Only
  // upsertSubscription + the billing.subscription.updated outbox event
  // depend on this. The cancel/sync/status handlers below DO NOT — bailing
  // here would silently swallow the cancel-at-period-end transition for
  // every self-serve sub, so pbClient.subscriptionEnding would never fire
  // and the subscription-ending confirmation email would never be sent.
  const planId = await resolveSubscriptionPlanId(client, sub);
  if (planId) {
    await upsertSubscription(client, tenantId, sub, planId);
    await enqueueOutboxEvent(client, makeEnvelope(tenantId, 'billing.subscription.updated', {
      subscriptionId: sub.id,
      planId,
      status: sub.status,
      currentPeriodEnd: new Date((subPeriodEnd(sub) ?? 0) * 1000).toISOString(),
    }));
  } else {
    deps.log.warn('stripe.consumer.subscription_updated_plan_not_resolved', {
      subscriptionId: sub.id,
      priceId: sub.items.data[0]?.price.id,
    });
  }

  // Detect cancel_at_period_end transition (false → true): subscription was just
  // scheduled to cancel at period end. Stripe carries the OLD value on
  // event.data.previous_attributes (only set when the field actually changed).
  const prevAttrs = event.data.previous_attributes as { cancel_at_period_end?: boolean } | undefined;
  const cancelScheduledTransition =
    sub.cancel_at_period_end === true && prevAttrs?.cancel_at_period_end === false;
  if (cancelScheduledTransition) {
    const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as Stripe.Customer | null)?.id;
    if (stripeCustomerId) {
      const accessEndsAt = sub.cancel_at ?? subPeriodEnd(sub) ?? null;
      if (accessEndsAt) {
        deps.pbClient.subscriptionEnding(stripeCustomerId, { accessEndsAt }).catch((err: Error) =>
          deps.log.warn('stripe.consumer.subscription_ending_call_failed', { error: err.message, stripeCustomerId }),
        );
      }
    }
  }

  // Sync subscription items and addon entitlements (syncSubscriptionItems calls
  // syncAddonEntitlements internally after upserting items).
  deps.pbClient.syncSubscriptionItems(sub.id).catch((err: Error) =>
    deps.log.warn('stripe.consumer.sync_subscription_items_failed', { error: err.message }),
  );

  // Enable agents when subscription transitions to active (e.g. incomplete → active after card added).
  const prevStatus = (event.data.previous_attributes as { status?: string } | undefined)?.status;
  if (sub.status === 'active' && prevStatus !== undefined && prevStatus !== 'active') {
    const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as Stripe.Customer | null)?.id;
    if (stripeCustomerId) {
      // Use subscription metadata as primary plan type source (set by self-serve subscribe/change-plan),
      // falling back to PLAN_ALLOCATIONS price ID lookup (for admin-provisioned subscriptions).
      const priceId = sub.items.data[0]?.price.id ?? '';
      const metadataPlanType = sub.metadata?.plan_type as 'core' | 'growth' | 'scale' | undefined;
      const resolvedPlanType = metadataPlanType ?? PRICE_ID_TO_PLAN_TYPE[priceId];

      // Period bounds live on the subscription item, not the subscription itself.
      const item0 = sub.items.data[0] as (typeof sub.items.data[0] & { current_period_start?: number; current_period_end?: number }) | undefined;
      const stripePeriodStart = item0?.current_period_start ? new Date(item0.current_period_start * 1000).toISOString() : undefined;
      const stripePeriodEnd = item0?.current_period_end ? new Date(item0.current_period_end * 1000).toISOString() : undefined;

      if (resolvedPlanType) {
        // Self-serve: included/precommit OUs come from sub.metadata. Rates are
        // looked up by platform-backend from plan_catalog when it processes the
        // subscriptionActivated call (it falls back to existing rate columns if
        // the planType row is current). We forward the OU counts only.
        const includedOus = parseInt(sub.metadata?.included_ous ?? '0', 10);
        const precommitExtraOus = parseInt(sub.metadata?.precommit_extra_ous ?? '0', 10);
        const isAnnualPlan = ANNUAL_PRICE_IDS.has(priceId) || sub.metadata?.billing_period === 'yearly';
        deps.pbClient.subscriptionActivated(stripeCustomerId, {
          planType: resolvedPlanType,
          includedOus,
          precommitExtraOus,
          isAnnualPlan,
          stripeSubscriptionId: sub.id,
          stripePeriodStart,
          stripePeriodEnd,
        }).catch((err: Error) =>
          deps.log.warn('stripe.consumer.subscription_activated_call_failed', { error: err.message, stripeCustomerId }),
        );
      } else {
        const subBillingTier = sub.metadata?.billing_tier;

        if (subBillingTier === 'enterprise') {
          // Enterprise rates carried in metadata by this service's
          // /api/internal/provision-enterprise (called by platform-backend's
          // POST /api/admin/accounts/:accountId/enterprise-provisioning).
          const includedOusEnt        = parseInt(sub.metadata?.included_ous            ?? '0', 10);
          const precommitExtraOusEnt  = parseInt(sub.metadata?.precommit_extra_ous     ?? '0', 10);
          const includedRateEnt       = parseFloat(sub.metadata?.included_rate_usd_per_ou  ?? '0');
          const precommitRateEnt      = parseFloat(sub.metadata?.precommit_rate_usd_per_ou ?? '0');
          const reloadRateEnt         = parseFloat(sub.metadata?.reload_rate_usd_per_ou    ?? '0');
          const isAnnualEnt           = sub.metadata?.is_annual_plan === 'true' || sub.metadata?.billing_period === 'yearly';
          deps.pbClient.subscriptionActivated(stripeCustomerId, {
            billingTier:           'enterprise',
            includedOus:           includedOusEnt,
            precommitExtraOus:     precommitExtraOusEnt,
            includedRateUsdPerOu:  includedRateEnt,
            precommitRateUsdPerOu: precommitRateEnt,
            reloadRateUsdPerOu:    reloadRateEnt,
            isAnnualPlan:          isAnnualEnt,
            stripeSubscriptionId:  sub.id,
            stripePeriodStart,
            stripePeriodEnd,
          }).catch((err: Error) =>
            deps.log.warn('stripe.consumer.subscription_activated_call_failed_enterprise', { error: err.message, stripeCustomerId }),
          );
        } else {
          deps.pbClient.subscriptionActivated(stripeCustomerId, {
            stripeSubscriptionId: sub.id,
            stripePeriodStart,
            stripePeriodEnd,
          }).catch((err: Error) =>
            deps.log.warn('stripe.consumer.subscription_activated_call_failed', { error: err.message, stripeCustomerId }),
          );
        }
      }
    }
  }
}

async function onSubscriptionCanceled(
  client: TenantScopedClient,
  tenantId: string,
  event: Stripe.Event,
  deps: StripeProcessorDeps,
  ctx: { deliveryAttempt?: number } = {},
): Promise<void> {
  // PR 2b — idempotency contract:
  //
  // This function MUST stay idempotent under Pub/Sub redelivery. Specifically:
  //   - The UPDATE on `subscriptions` is conditional via `WHERE stripe_subscription_id = $1`
  //     and sets a terminal state; running it twice on the same row yields the
  //     same end state.
  //   - The outbox INSERT is deduped at the @liftoffos/outbox layer (idempotency
  //     key on envelope.eventId).
  //   - The PB-side `/subscription-cancelled` handler is idempotent (UPDATE
  //     billing_controls SET suspended=TRUE ... is a no-op on repeat).
  //
  // Any new side effect added here must preserve idempotency, otherwise a
  // single transient PB failure → Pub/Sub retry could double-mutate state.
  const deliveryAttempt = ctx.deliveryAttempt ?? 1;
  const sub = event.data.object as Stripe.Subscription;
  const isAutoProvisioned = sub.metadata?.provisioning_source === 'auto';
  const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as Stripe.Customer | null)?.id ?? null;
  await client.query( // rls-fence: allow (client pre-scoped via set_config-in-tx (outbox consumer))
    `UPDATE subscriptions
       SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
       WHERE stripe_subscription_id = $1`,
    [sub.id],
  );

  await enqueueOutboxEvent(client, makeEnvelope(tenantId, 'billing.subscription.canceled', {
    subscriptionId: sub.id,
    canceledAt: new Date().toISOString(),
  }));

  // Suspension policy: only notify PB when no other active billing
  // relationship survives. Two skip conditions:
  //
  //   1. Auto-provisioned subscription. onSubscriptionCreated programmatically
  //      cancels these when a real Checkout subscription arrives; suspending
  //      here would block an account that just paid.
  //
  //   2. Other active-ish subs remain for the same TENANT — across every
  //      Stripe customer the tenant has ever billed through, not just the
  //      cancelled sub's customer. An account can migrate to a new Stripe
  //      customer (re-provisioning) and leave live-but-stale subs behind on
  //      the old one; a tenant can also hold multiple Stripe subs from
  //      duplicate provisioning, historic e2e/test runs, or admin-side
  //      enterprise provisioning that bypassed the dedup index. Cancelling
  //      one of those dangling subs must not suspend the canonical active
  //      sub. Customer-scoping this check would wrongly suspend: the stale
  //      sub's customer has no other subs, so a healthy account suspends.
  //
  //      This is best-effort only — the local table is blind to Stripe subs
  //      that never produced a tracked row. The authoritative gate is PB-side: the handler
  //      compares the cancelled sub against billing_controls' current
  //      customer + subscription pointers and ignores stale cancellations.
  if (stripeCustomerId && !isAutoProvisioned) {
    const { rows } = await client.query<{ n: string }>(
      `SELECT 1 AS n FROM subscriptions
        WHERE tenant_id = $1
          AND stripe_subscription_id <> $2
          AND status IN ('active', 'trialing', 'past_due', 'incomplete')
        LIMIT 1`,
      [tenantId, sub.id],
    );
    if (rows.length > 0) {
      deps.log.info('stripe.consumer.subscription_canceled_skip_suspend_other_active', {
        stripeCustomerId, tenantId, canceledSubId: sub.id,
      });
      return;
    }

    // Unspent referral credit is forfeited on cancellation, with no grace
    // period. Credit is not money: cancelling, closing the workspace or asking
    // for a refund does not convert it into any, and there is nothing to
    // return. An earlier draft proposed a six month reinstatement window,
    // dropped as over-engineering — with a 90 day timer already running it is
    // mostly unreachable.
    //
    // Placed HERE, behind both skip conditions, and not at the top of this
    // function. Those conditions exist because a cancellation is not always a
    // churn: an auto-provisioned subscription is cancelled programmatically the
    // moment a real one arrives, and a tenant can leave live-but-stale
    // subscriptions behind on an old Stripe customer. Forfeiting on either
    // would take credit from an account that is still paying — a wrongful
    // suspension, in money the customer earned rather than in access.
    //
    // Idempotent, per the contract at the top of this function: the reversal
    // only touches rows that are neither already reversed nor ever applied, so
    // a redelivery is a no-op. Non-fatal, because a lost forfeiture is a $20
    // overpayment while a throw here would retry every other side effect of the
    // cancellation alongside it.
    try {
      await deps.referrals.onSubscriptionCancelled(tenantId);
    } catch (err) {
      deps.log.error('stripe.consumer.referral_forfeit_failed', {
        tenantId,
        subscriptionId: sub.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // PR 2b — synchronous mirror call with retry-on-failure semantics.
    //
    // Pre-PR-2b this was `pbClient.subscriptionCancelled(...).catch(log.warn)`,
    // a fire-and-forget that left the mirror stale on any transient PB
    // failure. The new behavior: await the call; on throw, log at ERROR with
    // full context, optionally emit a DLQ-imminent outbox alert, then rethrow.
    // The rethrow propagates out of withOutboxConsumer's transaction —
    // Pub/Sub NACKs the message and redelivers with backoff.
    //
    // metadata.tenant_id is forwarded so PB-side's billing-controls-internal
    // router (PR 2a) can fall back to tenant-based resolution when
    // billing_controls has lost track of the Stripe customer.
    // subscriptionId identifies WHICH sub was cancelled so PB can refuse to
    // suspend when it is not the account's current subscription.
    try {
      await deps.pbClient.subscriptionCancelled(stripeCustomerId, {
        metadata: { tenant_id: sub.metadata?.tenant_id ?? null },
        subscriptionId: sub.id,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      deps.log.error('stripe.consumer.pb_mirror_failed_will_retry', {
        error: errMsg,
        stripeCustomerId,
        subscriptionId: sub.id,
        tenantIdFromMetadata: sub.metadata?.tenant_id ?? null,
        deliveryAttempt,
      });

      // DLQ-imminent signal. The Cloud Logging alert
      // `billing_mirror_update_failed_dlq` (PR 0 Terraform) keys on this
      // outbox event so operators see the failure before Pub/Sub gives up.
      // It MUST be written in a NEW transaction — the rethrow below aborts
      // the consumer transaction and would roll back any outbox row written
      // through `client`.
      if (deliveryAttempt >= MAX_RETRY_ATTEMPTS_BEFORE_DLQ) {
        const alertClient = await deps.pool.connect();
        try {
          await alertClient.query('BEGIN');
          await alertClient.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
          await enqueueOutboxEvent(alertClient, makeEnvelope(tenantId, 'billing.mirror.update_failed', {
            subscriptionId: sub.id,
            stripeCustomerId,
            kind: 'cancellation',
            metadata: sub.metadata ?? null,
            attempt: deliveryAttempt,
          }));
          await alertClient.query('COMMIT');
          // Structured log so the PR-0 Cloud Logging alert
          // (billing_mirror_update_failed_dlq) can fire on the DLQ-imminent
          // condition. The alert filters on jsonPayload.event_type — the
          // outbox row itself isn't a log entry, so without this emission
          // the alert would never trip.
          deps.log.warn('billing.mirror.update_failed', {
            event_type: 'billing.mirror.update_failed',
            subscriptionId: sub.id,
            stripeCustomerId,
            kind: 'cancellation',
            attempt: deliveryAttempt,
          });
        } catch (alertErr) {
          await alertClient.query('ROLLBACK').catch(() => undefined);
          deps.log.error('stripe.consumer.pb_mirror_dlq_event_emit_failed', {
            error: alertErr instanceof Error ? alertErr.message : String(alertErr),
            stripeCustomerId,
            subscriptionId: sub.id,
          });
          // Do not swallow — fall through to the rethrow below so the
          // original failure is still surfaced.
        } finally {
          alertClient.release();
        }
      }

      throw err;
    }
  }
}

/**
 * A refund of a payment that earned referral credit.
 *
 * Takes the credit back if it is still `pending` or vested-but-unspent, and
 * ABSORBS it if it was already applied to an invoice — no negative balance, no
 * re-billing. Automatic clawback against future earnings was considered and
 * rejected: it misses fraudsters, because a negative balance is only
 * collectable from somebody who intends to keep earning, and it is a griefing
 * vector, because referral links are public by design and one chargeback can
 * drive an innocent referrer's balance negative.
 *
 * Partial refunds count. The rule is "the payment that earned it was taken
 * back", and a referral whose qualifying month has been partly refunded is no
 * longer a full-priced paid month.
 */
async function onChargeRefunded(client: TenantScopedClient, ctx: ChargeContext, deps: StripeProcessorDeps): Promise<void> {
  const { charge, invoiceId } = ctx;
  if (!invoiceId) return;
  await deps.referrals.onEarningPaymentReversed(invoiceId, 'refund');
  await settlePrepaidCredit(client, invoiceId, charge, charge.amount_refunded ?? 0, 'refund', deps);

  // The single writer of amount_refunded_cents. `charge.amount_refunded` is the
  // CUMULATIVE total for the charge, so this SETS rather than adds — and being
  // on the webhook rather than in the refund endpoint is what makes it cover a
  // refund issued from the Stripe dashboard, which is how every refund happened
  // before the endpoint existed. amount_paid_cents is never reduced: what was
  // paid is one fact and what came back is another.
  await client.query( // rls-fence: allow (client pre-scoped via set_config-in-tx (outbox consumer))
    `UPDATE invoices
        SET amount_refunded_cents = LEAST(amount_paid_cents, $2::bigint)
      WHERE stripe_invoice_id = $1`,
    [invoiceId, charge.amount_refunded ?? 0],
  );
}

/**
 * Move prepaid credit when the payment that bought it moves.
 *
 * Credit is non-refundable, which only holds if money leaving takes the unspent
 * units with it. Without this a top-up can be charged back after the compute is
 * consumed and the customer keeps both.
 *
 * Only prepaid top-up invoices are touched. A refunded subscription invoice
 * bought a plan, not credit, and debiting the wallet for one would take money
 * the customer still owns.
 *
 * `direction` follows the money: a refund or a filed dispute has already left
 * the balance, and a dispute decided in our favour puts it back.
 */
async function settlePrepaidCredit(
  client: TenantScopedClient,
  invoiceId: string,
  charge: Stripe.Charge,
  amountCents: number,
  reason: 'refund' | 'dispute' | 'reinstated',
  deps: StripeProcessorDeps,
): Promise<void> {
  if (!(amountCents > 0)) return;

  const stripeCustomerId = typeof charge.customer === 'string'
    ? charge.customer
    : (charge.customer as Stripe.Customer | null)?.id ?? null;
  if (!stripeCustomerId) return;

  const { rows } = await client.query<{ type: string }>( // rls-fence: allow (client pre-scoped via set_config-in-tx (outbox consumer))
    `SELECT type::text AS type FROM invoices WHERE stripe_invoice_id = $1`,
    [invoiceId],
  );
  if (rows[0]?.type !== 'prepaid_reload') return;

  const amountUsd = amountCents / 100;
  try {
    if (reason === 'reinstated') {
      await deps.pbClient.prepaidToppedUp(stripeCustomerId, amountUsd);
    } else {
      await deps.pbClient.prepaidClawback(stripeCustomerId, amountUsd, reason);
    }
    deps.log.info('stripe.consumer.prepaid_credit_settled', { invoiceId, reason, amountUsd });
  } catch (err) {
    // Rethrow: the consumer 500s and Pub/Sub retries. Swallowing would leave
    // the customer holding compute they have taken the money back for.
    deps.log.error('stripe.consumer.prepaid_credit_settle_failed', {
      invoiceId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * A dispute of a payment that earned referral credit.
 *
 * The same reversal as a refund, and the reason the 60 day hold does not
 * replace it: a card dispute can be filed up to 120 days after the transaction
 * under most Visa and Mastercard reason codes, so a payment made on day one can
 * be disputed on day one hundred — after the credit vested, and usually after
 * it was spent, because automatic application makes the absorb path the
 * default rather than the exception.
 *
 * The dispute object carries a charge, not an invoice, so the charge is
 * retrieved to find the invoice the credit was booked against.
 */
async function onChargeDisputed(client: TenantScopedClient, ctx: ChargeContext, event: Stripe.Event, deps: StripeProcessorDeps): Promise<void> {
  const { invoiceId, charge } = ctx;
  if (!invoiceId) return;
  await deps.referrals.onEarningPaymentReversed(invoiceId, 'dispute');
  const dispute = event.data.object as Stripe.Dispute;
  await settlePrepaidCredit(client, invoiceId, charge, dispute.amount ?? 0, 'dispute', deps);
}

/**
 * A dispute closed in our favour, with the funds returned.
 *
 * Stripe raises this only when the money actually comes back, which is why it
 * is the signal used rather than `charge.dispute.closed`: that fires on every
 * outcome, including the ones where the reversal should stand.
 */
async function onChargeDisputeFundsReinstated(client: TenantScopedClient, ctx: ChargeContext, event: Stripe.Event, deps: StripeProcessorDeps): Promise<void> {
  const { invoiceId, charge } = ctx;
  if (!invoiceId) return;
  await deps.referrals.onEarningPaymentReinstated(invoiceId);
  const dispute = event.data.object as Stripe.Dispute;
  await settlePrepaidCredit(client, invoiceId, charge, dispute.amount ?? 0, 'reinstated', deps);
}

/**
 * The issuer of a card that paid this account has reported the payment as
 * fraud.
 *
 * A hold, not a clawback, and the distinction is the whole design. Credit
 * leaves when money leaves — charge.refunded and charge.dispute.created above
 * already do exactly that — and a warning moves no money. About 40% of them
 * become disputes, so taking the credit here would debit the wallet twice on
 * those and once too often on the rest, and a wrongly flagged customer cannot
 * be given back compute they were refused. What a warning does justify is
 * stopping the spend, which it buys days earlier than the dispute would.
 *
 * `actionable` is false when the charge has already been refunded or
 * disputed; those paths own it, and acting again here would double up.
 *
 * Sent whatever the invoice bought. The signal is about the card, so a
 * subscription invoice earns the same hold as a wallet top-up.
 */
async function onEarlyFraudWarning(
  client: TenantScopedClient,
  ctx: ChargeContext,
  event: Stripe.Event,
  deps: StripeProcessorDeps,
): Promise<void> {
  const efw = event.data.object as Stripe.Radar.EarlyFraudWarning;

  if (!efw.actionable) {
    deps.log.info('stripe.consumer.early_fraud_warning_not_actionable',
      { efwId: efw.id, chargeId: ctx.chargeId });
    return;
  }

  const stripeCustomerId = typeof ctx.charge.customer === 'string'
    ? ctx.charge.customer
    : (ctx.charge.customer as Stripe.Customer | null)?.id ?? null;
  if (!stripeCustomerId) {
    // The hold is keyed by customer; without one there is nothing to hold, and
    // silently dropping a fraud report is the failure this whole path exists
    // to prevent.
    deps.log.error('stripe.consumer.early_fraud_warning_no_customer',
      { efwId: efw.id, chargeId: ctx.chargeId });
    throw new Error('early_fraud_warning_no_customer');
  }

  if (ctx.invoiceId) {
    await client.query( // rls-fence: allow (client pre-scoped via set_config-in-tx (outbox consumer))
      `UPDATE invoices
          SET fraud_warning_at  = COALESCE(fraud_warning_at, NOW()),
              fraud_warning_ref = COALESCE(fraud_warning_ref, $2)
        WHERE stripe_invoice_id = $1`,
      [ctx.invoiceId, efw.id],
    );
  }

  // Deliberately not swallowed. The consumer 500s and Pub/Sub retries; a hold
  // that did not land leaves the compute running on a card the issuer has
  // already called stolen. The endpoint is idempotent, so the retry is free.
  await deps.pbClient.fraudHold(stripeCustomerId, {
    ref: efw.id,
    chargeId: ctx.chargeId,
    invoiceId: ctx.invoiceId,
    fraudType: efw.fraud_type,
  });

  deps.log.warn('stripe.consumer.early_fraud_warning_hold_placed', {
    efwId: efw.id,
    chargeId: ctx.chargeId,
    invoiceId: ctx.invoiceId,
    fraudType: efw.fraud_type,
    stripeCustomerId,
  });
}

async function onPaymentMethodChanged(client: TenantScopedClient, tenantId: string, event: Stripe.Event, deps: StripeProcessorDeps): Promise<void> {
  const pm = event.data.object as Stripe.PaymentMethod;
  await client.query( // rls-fence: allow (client pre-scoped via set_config-in-tx (outbox consumer))
    `INSERT INTO payment_methods (id, tenant_id, stripe_payment_method_id, brand, last4, exp_month, exp_year, is_default)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, FALSE)
     ON CONFLICT (stripe_payment_method_id) DO UPDATE
       SET brand = EXCLUDED.brand, last4 = EXCLUDED.last4,
           exp_month = EXCLUDED.exp_month, exp_year = EXCLUDED.exp_year`,
    [
      tenantId,
      pm.id,
      pm.card?.brand ?? 'unknown',
      pm.card?.last4 ?? '0000',
      pm.card?.exp_month ?? 0,
      pm.card?.exp_year ?? 0,
    ],
  );

  // Notify platform-backend so it can set has_payment_method = TRUE on billing_controls.
  // The payment method may be attached to a Stripe customer; resolve from the PM object.
  const stripeCustomerId = typeof pm.customer === 'string' ? pm.customer
    : (pm.customer as Stripe.Customer | null)?.id ?? null;
  if (stripeCustomerId) {
    deps.pbClient.paymentMethodAdded(stripeCustomerId).catch((err: Error) =>
      deps.log.warn('stripe.consumer.payment_method_added_call_failed', { error: err.message, stripeCustomerId }),
    );
  }

  // Promo-abuse signal: record this card's fingerprint against the customer.
  // Re-signups under a different email can reuse the same card; the eligibility
  // helper (Phase 7) consults this table to block promo redemption when a
  // fingerprint was previously seen on a soft-deleted customer.
  if (pm.card?.fingerprint && stripeCustomerId) {
    await client.query( // rls-fence: allow (client pre-scoped via set_config-in-tx (outbox consumer))
      `INSERT INTO payment_method_fingerprints_seen (fingerprint, stripe_customer_id, customer_status, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'active', NOW(), NOW())
       ON CONFLICT (fingerprint, stripe_customer_id)
       DO UPDATE SET last_seen_at = NOW(), customer_status = 'active'`,
      [pm.card.fingerprint, stripeCustomerId],
    );
  }
}

async function onCreditBalanceChanged(client: TenantScopedClient, tenantId: string, event: Stripe.Event): Promise<void> {
  // Credit grants / customer balance events — the exact shape depends
  // on the Stripe product version. We emit the canonical event with
  // the delta information Stripe provides.
  const obj = event.data.object as { amount?: number; currency?: string };
  const delta = BigInt(obj.amount ?? 0);
  await adjustCreditBalance(client, tenantId, delta, event.type);
}

async function onCustomerBalanceTransaction(client: TenantScopedClient, tenantId: string, event: Stripe.Event, deps: StripeProcessorDeps): Promise<void> {
  // customer.balance_transaction.created fires when a customer's balance changes
  // (top-up via Customer Balance, or when a threshold charge consumes credit).
  // ending_balance is in cents; negative = credit available.
  const tx = event.data.object as Stripe.CustomerBalanceTransaction;
  const stripeCustomerId = typeof tx.customer === 'string' ? tx.customer : (tx.customer as Stripe.Customer | null)?.id ?? null;
  if (!stripeCustomerId) return;

  // tx.amount is the delta in Stripe's convention (negative cents = credit added).
  // Convert to a positive USD delta to pass as the top-up amount.
  const amountUsd = -(tx.amount ?? 0) / 100;
  if (amountUsd <= 0) return; // debits / zero-amount transactions are not top-ups
  deps.pbClient.prepaidToppedUp(stripeCustomerId, amountUsd).catch((err: Error) =>
    deps.log.warn('stripe.consumer.prepaid_topped_up_call_failed', {
      error: err.message,
      stripeCustomerId,
      tenantId,
    }),
  );

  // Receipt email for the credit reload. Payment method is the default PM on
  // file (kept in sync via payment_method.attached/updated webhooks).
  const pm = await lookupDefaultPaymentMethod(client, tenantId);
  if (pm) {
    deps.pbClient.receipt(stripeCustomerId, {
      context: 'credit_reload',
      amountUsd,
      paymentMethodType: pm.type,
      paymentMethodLast4: pm.last4,
    }).catch((err: Error) =>
      deps.log.warn('stripe.consumer.receipt_reload_call_failed', { error: err.message, stripeCustomerId }),
    );
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function resolveEventTenantId(event: Stripe.Event): string | null {
  const obj = event.data.object as { metadata?: Record<string, string>; client_reference_id?: string | null };
  const tid = obj?.metadata?.tenant_id ?? (obj?.client_reference_id as string | null | undefined) ?? null;
  return tid && tid.length > 0 ? tid : null;
}

function extractStripeCustomerId(inv: Stripe.Invoice): string | null {
  if (typeof inv.customer === 'string') return inv.customer;
  return (inv.customer as Stripe.Customer | null)?.id ?? null;
}

export async function upsertInvoice(
  client: TenantScopedClient,
  tenantId: string,
  inv: Stripe.Invoice,
  statusOverride?: 'finalized' | 'paid',
  invoiceType: 'subscription_cycle' | 'prepaid_reload' | 'threshold' | 'recovery' | 'unknown' = 'unknown',
): Promise<void> {
  const status = statusOverride ?? invoiceStatusFromStripe(inv.status);
  // total_discount_amounts is the per-discount breakdown Stripe attaches
  // when a coupon or promo zeroes (or partly zeroes) the invoice. Summing
  // the `amount` field gives the cents removed by all discounts on this
  // invoice. A $20-off promo on a $20 Core monthly invoice surfaces as
  // [{ amount: 2000, discount: '...' }]. Stored locally so /invoices can
  // distinguish a "real $20 → $0 via promo" billing event from a phantom
  // $0/$0 stub.
  const discountCents = (inv.total_discount_amounts ?? []).reduce(
    (sum, d) => sum + (d.amount ?? 0),
    0,
  );
  await client.query( // rls-fence: allow (client pre-scoped via set_config-in-tx (outbox consumer))
    `SELECT upsert_invoice_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      tenantId, inv.id, status,
      BigInt(inv.amount_due ?? 0), BigInt(inv.amount_paid ?? 0), BigInt(inv.tax ?? 0),
      inv.currency ?? 'usd',
      inv.period_start ?? 0, inv.period_end ?? 0,
      inv.created,
      inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000) : null,
      invoiceType,
      inv.hosted_invoice_url ?? null,
      inv.invoice_pdf ?? null,
      BigInt(inv.subtotal ?? 0),
      BigInt(discountCents),
    ],
  );
}

function invoiceStatusFromStripe(s: Stripe.Invoice.Status | null | undefined): string {
  if (!s) return 'draft';
  if (s === 'uncollectible') return 'uncollectible';
  if (s === 'void') return 'void';
  if (s === 'paid') return 'paid';
  if (s === 'open') return 'open';
  return 'draft';
}

async function resolvePlanIdForPriceId(client: TenantScopedClient, priceId: string): Promise<string | null> {
  if (!priceId) return null;
  const { rows } = await client.query<{ id: string }>( // rls-fence: allow (plans carries no row-level security)
    `SELECT id FROM plans WHERE stripe_price_id = $1`,
    [priceId],
  );
  return rows[0]?.id ?? null;
}

// Resolves the plan_id for a Stripe subscription using two strategies:
//   1. sub.metadata.plan_id — populated by provisionForTenant for every
//      self-serve subscribe. Self-serve subs use an ad-hoc per-customer
//      price (created inline by /subscribe) that is NOT in the plans table,
//      so the price-id lookup always returns null for them.
//   2. price-id lookup against the plans table — covers legacy / admin /
//      catalog-mapped subs whose price IS in the plans table.
//
// Returns null only when neither path resolves, in which case callers should
// log + skip the plan-tied state writes but MUST NOT abort handlers that
// don't care about plan_id (e.g. the cancel-at-period-end transition that
// drives the subscription-ending email).
async function resolveSubscriptionPlanId(client: TenantScopedClient, sub: Stripe.Subscription): Promise<string | null> {
  const metadataPlanId = sub.metadata?.plan_id;
  if (metadataPlanId) return metadataPlanId;
  return resolvePlanIdForPriceId(client, sub.items.data[0]?.price.id ?? '');
}

async function adjustCreditBalance(
  client: TenantScopedClient,
  tenantId: string,
  deltaCents: bigint,
  reason: string,
): Promise<void> {
  const { rows } = await client.query<{ available_cents: string; reserved_cents: string }>(
    `INSERT INTO credit_balances (tenant_id, available_cents, reserved_cents, as_of)
     VALUES ($1, $2, 0, NOW())
     ON CONFLICT (tenant_id) DO UPDATE
       SET available_cents = credit_balances.available_cents + $2,
           as_of = NOW()
     RETURNING available_cents, reserved_cents`,
    [tenantId, String(deltaCents)],
  );
  await enqueueOutboxEvent(client, makeEnvelope(tenantId, 'billing.credit_balance.changed', {
    availableCents: rows[0].available_cents,
    reservedCents: rows[0].reserved_cents,
    deltaCents: String(deltaCents),
    reason,
  }));
}

export function makeEnvelope<T>(tenantId: string, eventType: string, payload: T): EventEnvelope<T> {
  return {
    eventId: randomUUID(),
    eventType,
    schemaVersion: 1,
    tenantId,
    occurredAt: new Date(),
    sourceService: 'liftoff-billing',
    traceId: null,
    payload,
  };
}
