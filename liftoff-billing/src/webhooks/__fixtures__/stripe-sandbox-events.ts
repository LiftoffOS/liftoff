// Stripe-sandbox webhook replay fixtures.
// Each entry is a verbatim Stripe event payload as received from the Stripe
// sandbox. Used by stripe-handler.test.ts and the stripe-event-processor tests
// to verify end-to-end webhook → outbox flow without a live Stripe connection.

import type Stripe from 'stripe';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const NOW_S = Math.floor(Date.now() / 1000);

function evt<T extends object>(id: string, type: string, data: T): Stripe.Event {
  return {
    id,
    object: 'event',
    api_version: '2024-06-20',
    created: NOW_S,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: type as Stripe.Event['type'],
    data: { object: data as Stripe.Event.Data['object'] },
  } as unknown as Stripe.Event;
}

// ── subscription.created ──────────────────────────────────────────────────────
export const SUBSCRIPTION_CREATED = evt('evt_sub_created', 'customer.subscription.created', {
  id: 'sub_sandbox_001',
  object: 'subscription',
  customer: 'cus_sandbox_001',
  status: 'active',
  items: {
    data: [{ price: { id: 'price_sandbox_001' } }],
  },
  current_period_start: NOW_S - 30 * 86400,
  current_period_end: NOW_S + 1 * 86400,
  cancel_at_period_end: false,
  canceled_at: null,
  metadata: { tenant_id: TENANT_ID },
} as unknown as Stripe.Subscription);

// ── subscription.updated (plan change) ───────────────────────────────────────
export const SUBSCRIPTION_UPDATED = evt('evt_sub_updated', 'customer.subscription.updated', {
  id: 'sub_sandbox_001',
  object: 'subscription',
  customer: 'cus_sandbox_001',
  status: 'active',
  items: {
    data: [{ price: { id: 'price_sandbox_002' } }],
  },
  current_period_start: NOW_S - 30 * 86400,
  current_period_end: NOW_S + 1 * 86400,
  cancel_at_period_end: false,
  canceled_at: null,
  metadata: { tenant_id: TENANT_ID },
} as unknown as Stripe.Subscription);

// ── subscription.deleted ──────────────────────────────────────────────────────
export const SUBSCRIPTION_DELETED = evt('evt_sub_deleted', 'customer.subscription.deleted', {
  id: 'sub_sandbox_001',
  object: 'subscription',
  customer: 'cus_sandbox_001',
  status: 'canceled',
  items: { data: [{ price: { id: 'price_sandbox_001' } }] },
  current_period_start: NOW_S - 30 * 86400,
  current_period_end: NOW_S,
  cancel_at_period_end: false,
  canceled_at: NOW_S,
  metadata: { tenant_id: TENANT_ID },
} as unknown as Stripe.Subscription);

// ── invoice.created ───────────────────────────────────────────────────────────
export const INVOICE_CREATED = evt('evt_inv_created', 'invoice.created', {
  id: 'in_sandbox_001',
  object: 'invoice',
  amount_due: 2500,
  amount_paid: 0,
  tax: 0,
  currency: 'usd',
  period_start: NOW_S - 30 * 86400,
  period_end: NOW_S,
  created: NOW_S - 1,
  status: 'open',
  status_transitions: {},
  default_payment_method: null,
  last_finalization_error: null,
} as unknown as Stripe.Invoice);

// ── invoice.finalized ─────────────────────────────────────────────────────────
export const INVOICE_FINALIZED = evt('evt_inv_finalized', 'invoice.finalized', {
  id: 'in_sandbox_001',
  object: 'invoice',
  amount_due: 2500,
  amount_paid: 0,
  tax: 250,
  currency: 'usd',
  period_start: NOW_S - 30 * 86400,
  period_end: NOW_S,
  created: NOW_S - 1,
  status: 'open',
  status_transitions: { finalized_at: NOW_S },
  default_payment_method: null,
  last_finalization_error: null,
} as unknown as Stripe.Invoice);

// ── invoice.paid ──────────────────────────────────────────────────────────────
export const INVOICE_PAID = evt('evt_inv_paid', 'invoice.paid', {
  id: 'in_sandbox_001',
  object: 'invoice',
  amount_due: 2500,
  amount_paid: 2500,
  tax: 250,
  currency: 'usd',
  period_start: NOW_S - 30 * 86400,
  period_end: NOW_S,
  created: NOW_S - 1,
  status: 'paid',
  status_transitions: { paid_at: NOW_S },
  default_payment_method: 'pm_sandbox_001',
  last_finalization_error: null,
} as unknown as Stripe.Invoice);

// ── invoice.payment_failed ────────────────────────────────────────────────────
export const INVOICE_PAYMENT_FAILED = evt('evt_inv_failed', 'invoice.payment_failed', {
  id: 'in_sandbox_002',
  object: 'invoice',
  amount_due: 5000,
  amount_paid: 0,
  tax: 0,
  currency: 'usd',
  period_start: NOW_S - 30 * 86400,
  period_end: NOW_S,
  created: NOW_S - 1,
  status: 'open',
  status_transitions: {},
  default_payment_method: 'pm_sandbox_001',
  last_finalization_error: { code: 'card_declined', message: 'Your card was declined.' },
} as unknown as Stripe.Invoice);

// ── payment_method.attached ───────────────────────────────────────────────────
export const PAYMENT_METHOD_ATTACHED = evt('evt_pm_attached', 'payment_method.attached', {
  id: 'pm_sandbox_001',
  object: 'payment_method',
  type: 'card',
  card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2026 },
  created: NOW_S,
} as unknown as Stripe.PaymentMethod);

// ── billing.credit_grant.created ─────────────────────────────────────────────
export const CREDIT_GRANT_CREATED = evt('evt_credit_created', 'billing.credit_grant.created', {
  id: 'crgr_sandbox_001',
  object: 'billing.credit_grant',
  amount: { type: 'monetary', monetary: { currency: 'usd', value: 5000 } },
  applicability_config: { scope: { price_type: 'metered' } },
  customer: 'cus_sandbox_001',
  status: 'active',
  created: NOW_S,
} as unknown as object);

// ── all events in lifecycle order for replay tests ────────────────────────────
export const ALL_EVENTS: Stripe.Event[] = [
  SUBSCRIPTION_CREATED,
  INVOICE_CREATED,
  INVOICE_FINALIZED,
  INVOICE_PAID,
  PAYMENT_METHOD_ATTACHED,
  CREDIT_GRANT_CREATED,
  SUBSCRIPTION_UPDATED,
  INVOICE_PAYMENT_FAILED,
  SUBSCRIPTION_DELETED,
];
