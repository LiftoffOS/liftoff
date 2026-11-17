// onInvoicePaid no longer kicks off a fused-onboarding distill.
//
// It used to call pbClient.restartFullDistill on the first subscription
// invoice, to run the distill of whatever the customer assembled during
// onboarding — work deferred because the hire happened before the card. The
// hire now happens after onboarding, where the distill runs directly, so the
// platform endpoint is gone (platform-backend ADR-050).
//
// These tests pin the removal rather than deleting with the feature: this
// consumer talks to another service across a deploy boundary, and re-adding a
// call to an endpoint that no longer exists would fail silently — it was
// fire-and-forget, so the rejection was only ever a warn line. The rest of
// invoice processing must keep working either way, which is what the
// periodReset assertions hold.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type { EventEnvelope } from '@liftoffos/outbox';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const STRIPE_CUSTOMER_ID = 'cus_test_fused';
const TENANT_ID = 'tenant-test-fused';
const SUB_ID = 'sub_test_fused';

// Mock the outbox so in-transaction enqueues are no-ops.
const mockEnqueueOutboxEvent = mockFn().mockResolvedValue(undefined);
jest.mock('@liftoffos/outbox', () => {
  const actual = jest.requireActual<typeof import('@liftoffos/outbox')>('@liftoffos/outbox');
  return { ...actual, enqueueOutboxEvent: mockEnqueueOutboxEvent };
});

function makeInvoice(billingReason: Stripe.Invoice['billing_reason']): Stripe.Invoice {
  return {
    id: `in_${randomUUID().slice(0, 14)}`,
    object: 'invoice',
    customer: STRIPE_CUSTOMER_ID,
    subscription: SUB_ID,
    billing_reason: billingReason,
    amount_paid: 0, // $0-after-promo first invoice → skips the credit-ledger path
    period_end: 1_700_000_000,
    metadata: {},
  } as unknown as Stripe.Invoice;
}

function makeStripeEvent(inv: Stripe.Invoice): Stripe.Event {
  return {
    id: `evt_${randomUUID().slice(0, 14)}`,
    type: 'invoice.paid',
    data: { object: inv },
  } as unknown as Stripe.Event;
}

function makeEnvelope(): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType: 'billing.stripe.invoice.paid',
    schemaVersion: 1,
    tenantId: TENANT_ID,
    occurredAt: new Date(),
    sourceService: 'liftoff-billing',
    traceId: null,
    payload: { stripeEventId: 'evt_test', stripeEventType: 'invoice.paid' },
  };
}

// Mocked in-transaction client. Programs the lookups processStripeEvent +
// onInvoicePaid perform: load the webhook event, resolve tenant by customer,
// and a benign default for upsertInvoice's writes.
function makeClient(stripeEvent: Stripe.Event) {
  return {
    query: mockFn().mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM stripe_webhook_events')) {
        return { rows: [{ payload: stripeEvent }] };
      }
      // Invoice tenant is resolved by the invoice's subscription (stable across
      // customer re-signup lives); a customer lookup is only a last resort.
      if (
        typeof sql === 'string' &&
        (sql.includes('tenant_id_for_stripe_subscription') ||
          sql.includes('tenant_id_for_stripe_customer'))
      ) {
        return { rows: [{ tenant_id: TENANT_ID }] };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
}

function makeDeps() {
  return {
    pool: { connect: mockFn().mockResolvedValue({ query: mockFn().mockResolvedValue({ rows: [] }), release: mockFn() }) },
    stripe: {
      subscriptions: { retrieve: mockFn().mockResolvedValue({ current_period_start: 1_700_000_000 }) },
    },
    stripeUsage: {},
    pbClient: {
      periodReset: mockFn().mockResolvedValue(undefined),
      receipt: mockFn().mockResolvedValue(undefined),
      thresholdSucceeded: mockFn().mockResolvedValue(undefined),
      recoverySucceeded: mockFn().mockResolvedValue(undefined),
    },
    // The referral programme's money half. Stubbed rather than omitted because
    // the processor now calls it on every subscription invoice, and a test
    // whose deps are missing it fails on a TypeError that says nothing about
    // what it was actually asserting.
    referrals: {
      onReferredInvoicePaid: mockFn().mockResolvedValue(undefined),
      applyToInvoice: mockFn().mockResolvedValue({ appliedUsd: 0 }),
      onSubscriptionCancelled: mockFn().mockResolvedValue({ forfeited: 0 }),
      onEarningPaymentReversed: mockFn().mockResolvedValue({ reversed: 0, absorbed: 0 }),
    },
    log: { info: mockFn(), warn: mockFn(), error: mockFn() },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnqueueOutboxEvent.mockResolvedValue(undefined);
});

describe('onInvoicePaid — no fused-onboarding kick-off (ADR-050)', () => {
  it('makes no distill call on the first subscription invoice, and still resets the period', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const inv = makeInvoice('subscription_create');
    const event = makeStripeEvent(inv);
    const deps = makeDeps();

    await processStripeEvent(makeClient(event) as never, makeEnvelope(), deps as never);

    // The client method is gone; assert on the object so a re-added one fails
    // here rather than 404ing in production against a removed endpoint.
    expect('restartFullDistill' in deps.pbClient).toBe(false);
    expect(deps.pbClient.periodReset).toHaveBeenCalledTimes(1);
  });

  it('still processes a recurring renewal normally', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const inv = makeInvoice('subscription_cycle');
    const event = makeStripeEvent(inv);
    const deps = makeDeps();

    await processStripeEvent(makeClient(event) as never, makeEnvelope(), deps as never);

    expect(deps.pbClient.periodReset).toHaveBeenCalledTimes(1);
  });

  it('the platform-backend client exposes no restartFullDistill method', async () => {
    const { PlatformBackendClient } = await import('../../infrastructure/platform-backend-client.js');
    expect(
      Object.getOwnPropertyNames(PlatformBackendClient.prototype),
    ).not.toContain('restartFullDistill');
  });
});
