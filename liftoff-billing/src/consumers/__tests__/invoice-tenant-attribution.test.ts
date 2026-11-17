// Regression tests for invoice → tenant attribution.
//
// Invoices are attributed to the tenant of the SUBSCRIPTION that generated them
// (stable for an account's whole life), NOT the customer's latest subscription
// (the Stripe customer is reused across delete+re-signup lives, so a
// customer-based lookup leaks a prior life's invoice into the current tenant).
// When the subscription isn't synced yet, the event retries via Pub/Sub and
// DLQs after the cap; a truly unresolvable invoice throws rather than writing a
// sentinel-tenant row.

import { describe, it, expect, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type { EventEnvelope } from '@liftoffos/outbox';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const MAX_RETRY_ATTEMPTS_BEFORE_DLQ = 5; // mirrors stripe-event-processor.ts

function makeInvoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: `in_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    object: 'invoice',
    amount_due: 0,
    amount_paid: 0,
    amount_remaining: 0,
    subtotal: 0,
    total: 0,
    tax: 0,
    currency: 'usd',
    period_start: Math.floor(Date.now() / 1000) - 30 * 24 * 3600,
    period_end: Math.floor(Date.now() / 1000),
    created: Math.floor(Date.now() / 1000) - 1,
    status: 'paid',
    billing_reason: 'subscription_cycle',
    status_transitions: {},
    total_discount_amounts: [],
    // NB: no metadata.tenant_id — forces the consumer's resolution path.
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function makeEvent(inv: Stripe.Invoice, type = 'invoice.created') {
  return { id: `evt_${randomUUID().replace(/-/g, '').slice(0, 14)}`, type, data: { object: inv } };
}

function makeEnvelope(tenantId: string, stripeEventId: string, type = 'invoice.created'): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType: `billing.stripe.${type}`,
    schemaVersion: 1,
    tenantId, // sentinel-ish seed; consumer must re-resolve for invoices
    occurredAt: new Date(),
    sourceService: 'liftoff-billing',
    traceId: null,
    payload: { stripeEventId, stripeEventType: type },
  } as EventEnvelope;
}

const makeDeps = () => ({
  pool: {} as never,
  stripe: {} as never,
  pbClient: {} as never,
  stripeUsage: {
    attachOuPriceToSubscription: mockFn().mockResolvedValue(undefined),
    ingestOuEvent: mockFn().mockResolvedValue(undefined),
  } as never,
  log: { info: mockFn(), warn: mockFn(), error: mockFn() },
});

/**
 * Build a mocked PoolClient. `resolvers` controls what the SQL lookup functions
 * return; `upsertTenants` captures the tenant_id every upsert_invoice_record is
 * called with.
 */
function makeClient(
  event: { id: string },
  resolvers: { bySubscription?: string | null; byCustomer?: string | null },
  upsertTenants: string[],
  calls: { subscriptionLookups: number; customerLookups: number },
) {
  return {
    query: mockFn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM stripe_webhook_events')) {
        return { rows: [{ payload: event }] };
      }
      if (sql.includes('tenant_id_for_stripe_subscription')) {
        calls.subscriptionLookups += 1;
        return { rows: [{ tenant_id: resolvers.bySubscription ?? null }] };
      }
      if (sql.includes('tenant_id_for_stripe_customer')) {
        calls.customerLookups += 1;
        return { rows: [{ tenant_id: resolvers.byCustomer ?? null }] };
      }
      if (sql.includes('upsert_invoice_record')) {
        upsertTenants.push((params as unknown[])[0] as string);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO outbox_events') || sql.includes('enqueue')) {
        return { rows: [{ id: randomUUID() }] };
      }
      if (sql.includes('UPDATE stripe_webhook_events')) return { rows: [] };
      if (sql.includes('FROM processed_events')) return { rows: [] };
      if (sql.includes('INSERT INTO processed_events')) return { rows: [] };
      return { rows: [] };
    }),
  };
}

describe('invoice → tenant attribution', () => {
  it('attributes by subscription, not the customer\'s latest subscription (no cross-life leak)', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const TENANT_OLD = randomUUID();
    const TENANT_NEW = randomUUID();
    const inv = makeInvoice({ subscription: 'sub_old', customer: 'cus_shared' } as Partial<Stripe.Invoice>);
    const event = makeEvent(inv);
    const upsertTenants: string[] = [];
    const calls = { subscriptionLookups: 0, customerLookups: 0 };
    // Subscription resolves to the OLD life; customer (if wrongly used) would
    // resolve to the NEW life. Correct behavior: attribute to TENANT_OLD.
    const client = makeClient(event, { bySubscription: TENANT_OLD, byCustomer: TENANT_NEW }, upsertTenants, calls);

    await processStripeEvent(client as never, makeEnvelope(randomUUID(), event.id), makeDeps() as never);

    expect(upsertTenants).toEqual([TENANT_OLD]);
    expect(upsertTenants).not.toContain(TENANT_NEW);
    expect(calls.customerLookups).toBe(0); // never falls back to customer when a subscription exists
  });

  it('retries (throws) when the subscription is not synced yet, on early attempts', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const inv = makeInvoice({ subscription: 'sub_pending', customer: 'cus_x' } as Partial<Stripe.Invoice>);
    const event = makeEvent(inv);
    const upsertTenants: string[] = [];
    const calls = { subscriptionLookups: 0, customerLookups: 0 };
    const client = makeClient(event, { bySubscription: null, byCustomer: randomUUID() }, upsertTenants, calls);

    await expect(
      processStripeEvent(client as never, makeEnvelope(randomUUID(), event.id), makeDeps() as never, { deliveryAttempt: 1 }),
    ).rejects.toThrow('invoice_subscription_not_yet_synced');
    expect(upsertTenants).toEqual([]); // nothing written
    expect(calls.customerLookups).toBe(0); // never customer-falls-back for a sub invoice
  });

  it('DLQs (throws unresolved) once the retry cap is reached', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const inv = makeInvoice({ subscription: 'sub_pending', customer: 'cus_x' } as Partial<Stripe.Invoice>);
    const event = makeEvent(inv);
    const upsertTenants: string[] = [];
    const calls = { subscriptionLookups: 0, customerLookups: 0 };
    const client = makeClient(event, { bySubscription: null, byCustomer: randomUUID() }, upsertTenants, calls);

    await expect(
      processStripeEvent(client as never, makeEnvelope(randomUUID(), event.id), makeDeps() as never, {
        deliveryAttempt: MAX_RETRY_ATTEMPTS_BEFORE_DLQ,
      }),
    ).rejects.toThrow('invoice_subscription_unresolved');
    expect(upsertTenants).toEqual([]);
  });

  it('falls back to customer for a one-off invoice with no subscription', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const TENANT_C = randomUUID();
    const inv = makeInvoice({ subscription: null, customer: 'cus_oneoff', billing_reason: 'manual' } as Partial<Stripe.Invoice>);
    const event = makeEvent(inv);
    const upsertTenants: string[] = [];
    const calls = { subscriptionLookups: 0, customerLookups: 0 };
    const client = makeClient(event, { bySubscription: null, byCustomer: TENANT_C }, upsertTenants, calls);

    await processStripeEvent(client as never, makeEnvelope(randomUUID(), event.id), makeDeps() as never);

    expect(upsertTenants).toEqual([TENANT_C]);
    expect(calls.subscriptionLookups).toBe(0); // no subscription → no subscription lookup
  });

  it('throws (no silent sentinel) when neither subscription nor customer resolves', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const inv = makeInvoice({ subscription: null, customer: null, billing_reason: 'manual' } as Partial<Stripe.Invoice>);
    const event = makeEvent(inv);
    const upsertTenants: string[] = [];
    const calls = { subscriptionLookups: 0, customerLookups: 0 };
    const client = makeClient(event, { bySubscription: null, byCustomer: null }, upsertTenants, calls);

    await expect(
      processStripeEvent(client as never, makeEnvelope(randomUUID(), event.id), makeDeps() as never),
    ).rejects.toThrow('invoice_tenant_unresolved');
    expect(upsertTenants).toEqual([]);
  });
});
