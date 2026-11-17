// Verifies the cancel-scheduled transition detection in onSubscriptionUpdated:
//   • When cancel_at_period_end transitions from false → true, pbClient.subscriptionEnding
//     is called with the cancel_at (or current_period_end) timestamp.
//   • When cancel_at_period_end was already true (no transition), subscriptionEnding
//     is NOT called.
//   • Stripe's event.data.previous_attributes is the source of truth for the prior value.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type { EventEnvelope } from '@liftoffos/outbox';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const STRIPE_CUSTOMER_ID = 'cus_test_cancel_scheduled';

function makeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_test',
    object: 'subscription',
    customer: STRIPE_CUSTOMER_ID,
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    current_period_start: 1747756800,
    current_period_end: 1750435200,                                  // June 20, 2025 UTC
    items: { data: [{ price: { id: 'price_test' } }] },
    metadata: { tenant_id: 'tenant-test' },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function makeWebhookEventRow(sub: Stripe.Subscription, previousAttributes: Record<string, unknown>): Stripe.Event {
  return {
    id: `evt_${randomUUID().slice(0, 14)}`,
    type: 'customer.subscription.updated',
    data: {
      object: sub,
      previous_attributes: previousAttributes,
    },
  } as unknown as Stripe.Event;
}

function makeEnvelope(tenantId: string): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType: 'billing.stripe.customer.subscription.updated',
    schemaVersion: 1,
    tenantId,
    occurredAt: new Date(),
    sourceService: 'liftoff-billing',
    traceId: null,
    payload: { stripeEventId: 'evt_test', stripeEventType: 'customer.subscription.updated' },
  };
}

function makeClient(stripeEvent: Stripe.Event) {
  return {
    query: mockFn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM stripe_webhook_events')) {
        return { rows: [{ payload: stripeEvent }] };
      }
      if (sql.includes('FROM plans')) {
        return { rows: [{ id: 'plan-core' }] };
      }
      if (sql.includes('INSERT INTO subscriptions') || sql.includes('UPDATE subscriptions')) {
        return { rows: [{ xmax: '1' }] };
      }
      if (sql.includes('INSERT INTO outbox_events') || sql.includes('outbox')) {
        return { rows: [{ id: randomUUID() }] };
      }
      if (sql.includes('set_config')) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

interface MockedDeps {
  pool: unknown;
  stripe: unknown;
  stripeUsage: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pbClient: { [k: string]: any };
  log: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
}

function makeDeps(): MockedDeps {
  return {
    pool: {},
    stripe: {},
    stripeUsage: {
      attachOuPriceToSubscription: mockFn().mockResolvedValue(undefined),
      ingestOuEvent: mockFn().mockResolvedValue(undefined),
    },
    pbClient: {
      subscriptionEnding: mockFn().mockResolvedValue(undefined),
      subscriptionActivated: mockFn().mockResolvedValue(undefined),
      syncSubscriptionItems: mockFn().mockResolvedValue(undefined),
      subscriptionCancelled: mockFn().mockResolvedValue(undefined),
    },
    log: { info: mockFn(), warn: mockFn(), error: mockFn() },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('onSubscriptionUpdated — cancel-scheduled transition', () => {
  it('fires pbClient.subscriptionEnding when cancel_at_period_end transitions false → true', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription({
      cancel_at_period_end: true,
      cancel_at: 1750435200,                                       // June 20, 2025 UTC
    });
    const event = makeWebhookEventRow(sub, { cancel_at_period_end: false });
    const deps = makeDeps();
    const client = makeClient(event);

    await processStripeEvent(client as never, makeEnvelope("tenant-test"), deps as never);

    expect((deps.pbClient.subscriptionEnding as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((deps.pbClient.subscriptionEnding as unknown as jest.Mock).mock.calls[0]).toEqual([
      STRIPE_CUSTOMER_ID,
      { accessEndsAt: 1750435200 },
    ]);
  });

  it('falls back to current_period_end when cancel_at is null', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription({
      cancel_at_period_end: true,
      cancel_at: null,
      current_period_end: 1750435200,
    });
    const event = makeWebhookEventRow(sub, { cancel_at_period_end: false });
    const deps = makeDeps();
    const client = makeClient(event);

    await processStripeEvent(client as never, makeEnvelope("tenant-test"), deps as never);

    expect((deps.pbClient.subscriptionEnding as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((deps.pbClient.subscriptionEnding as unknown as jest.Mock).mock.calls[0][1]).toEqual({
      accessEndsAt: 1750435200,
    });
  });

  it('does NOT fire when cancel_at_period_end was already true (no transition)', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription({ cancel_at_period_end: true, cancel_at: 1750435200 });
    // previous_attributes lacks cancel_at_period_end → field did not change in this update
    const event = makeWebhookEventRow(sub, { metadata: { other_field: 'unrelated' } });
    const deps = makeDeps();
    const client = makeClient(event);

    await processStripeEvent(client as never, makeEnvelope("tenant-test"), deps as never);

    expect((deps.pbClient.subscriptionEnding as unknown as jest.Mock)).not.toHaveBeenCalled();
  });

  it('does NOT fire when cancel_at_period_end is currently false (cancel was un-scheduled)', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription({ cancel_at_period_end: false, cancel_at: null });
    const event = makeWebhookEventRow(sub, { cancel_at_period_end: true });
    const deps = makeDeps();
    const client = makeClient(event);

    await processStripeEvent(client as never, makeEnvelope("tenant-test"), deps as never);

    expect((deps.pbClient.subscriptionEnding as unknown as jest.Mock)).not.toHaveBeenCalled();
  });
});
