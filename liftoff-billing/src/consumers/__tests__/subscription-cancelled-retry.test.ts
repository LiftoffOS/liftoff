// Tests for PR 2b — synchronous PB mirror call with retry-on-failure + DLQ
// outbox-event bridge in onSubscriptionCanceled.
//
// Behavior verified:
//   - Awaits pbClient.subscriptionCancelled (no fire-and-forget).
//   - Forwards sub.metadata.tenant_id in the PB call's opts arg.
//   - Rethrows PB call failure so the consumer's transaction aborts and
//     Pub/Sub redelivers.
//   - Emits the billing.mirror.update_failed outbox event ONLY when
//     deliveryAttempt >= threshold (5) — and emits it via a NEW connection
//     so it survives the rethrow that rolls back the consumer transaction.
//   - Does NOT emit the DLQ outbox event on first-attempt failure.
//   - Idempotent under redelivery (re-running yields identical final state).

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type { EventEnvelope } from '@liftoffos/outbox';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const STRIPE_CUSTOMER_ID = 'cus_test_pr2b';
const TENANT_ID = 'tenant-test-pr2b';
const SUB_ID = 'sub_test_pr2b';

// Track enqueueOutboxEvent calls — used to assert in-transaction outbox writes.
// The DLQ outbox event flows through a NEW connection (alertClient below) so it
// shows up here too via the makeEnvelope/enqueueOutboxEvent call surface.
const mockEnqueueOutboxEvent = mockFn().mockResolvedValue(undefined);

jest.mock('@liftoffos/outbox', () => {
  const actual = jest.requireActual<typeof import('@liftoffos/outbox')>('@liftoffos/outbox');
  return {
    ...actual,
    enqueueOutboxEvent: mockEnqueueOutboxEvent,
  };
});

function makeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: SUB_ID,
    object: 'subscription',
    customer: STRIPE_CUSTOMER_ID,
    status: 'canceled',
    canceled_at: 1747756800,
    metadata: { tenant_id: TENANT_ID },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function makeStripeEvent(sub: Stripe.Subscription): Stripe.Event {
  return {
    id: `evt_${randomUUID().slice(0, 14)}`,
    type: 'customer.subscription.deleted',
    data: { object: sub },
  } as unknown as Stripe.Event;
}

function makeEnvelope(): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType: 'billing.stripe.customer.subscription.deleted',
    schemaVersion: 1,
    tenantId: TENANT_ID,
    occurredAt: new Date(),
    sourceService: 'liftoff-billing',
    traceId: null,
    payload: { stripeEventId: 'evt_test', stripeEventType: 'customer.subscription.deleted' },
  };
}

// Primary (in-transaction) client. Programs the lookups that
// processStripeEvent + onSubscriptionCanceled perform:
//   - SELECT FROM stripe_webhook_events → returns the cancellation event
//   - UPDATE subscriptions (sets status='canceled') → harmless rowCount
//   - SELECT 1 FROM subscriptions WHERE stripe_customer_id... → empty
//     (no other active sibling sub, so we proceed to the PB call)
function makeClient(stripeEvent: Stripe.Event) {
  return {
    query: mockFn().mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM stripe_webhook_events')) {
        return { rows: [{ payload: stripeEvent }] };
      }
      if (typeof sql === 'string' && sql.includes('UPDATE subscriptions')) {
        return { rows: [], rowCount: 1 };
      }
      if (typeof sql === 'string' && sql.includes('SELECT 1 AS n FROM subscriptions')) {
        return { rows: [] }; // No other active sub
      }
      if (typeof sql === 'string' && sql.includes('set_config')) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

// The "alert" client used by the catch-block to emit the DLQ outbox event in
// a fresh transaction. We need pool.connect() to return one of these.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAlertClient(): { query: any; release: any } {
  return {
    query: mockFn().mockResolvedValue({ rows: [] }),
    release: mockFn().mockReturnValue(undefined),
  };
}

interface MockedDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool: { connect: any };
  stripe: unknown;
  stripeUsage: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pbClient: { [k: string]: any };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  referrals: { [k: string]: any };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: { info: any; warn: any; error: any };
  __alertClient: ReturnType<typeof makeAlertClient>;
}

function makeDeps(): MockedDeps {
  const alertClient = makeAlertClient();
  return {
    pool: {
      connect: mockFn().mockResolvedValue(alertClient),
    },
    stripe: {},
    stripeUsage: {},
    pbClient: {
      subscriptionCancelled: mockFn().mockResolvedValue(undefined),
      subscriptionEnding: mockFn().mockResolvedValue(undefined),
      subscriptionActivated: mockFn().mockResolvedValue(undefined),
      paymentMethodAdded: mockFn().mockResolvedValue(undefined),
    },
    referrals: {
      onSubscriptionCancelled: mockFn().mockResolvedValue({ forfeited: 0 }),
      onReferredInvoicePaid: mockFn().mockResolvedValue(undefined),
      applyToInvoice: mockFn().mockResolvedValue({ appliedUsd: 0 }),
      onEarningPaymentReversed: mockFn().mockResolvedValue({ reversed: 0, absorbed: 0 }),
    },
    log: { info: mockFn(), warn: mockFn(), error: mockFn() },
    __alertClient: alertClient,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnqueueOutboxEvent.mockResolvedValue(undefined);
});

describe('onSubscriptionCanceled — PR 2b synchronous mirror + DLQ bridge', () => {
  it('awaits pbClient.subscriptionCancelled (no fire-and-forget)', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const event = makeStripeEvent(sub);
    const deps = makeDeps();
    const client = makeClient(event);

    await processStripeEvent(client as never, makeEnvelope(), deps as never);

    expect(deps.pbClient.subscriptionCancelled).toHaveBeenCalledTimes(1);
  });

  it('forwards sub.metadata.tenant_id AND the cancelled subscriptionId to PB in the opts arg', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const event = makeStripeEvent(sub);
    const deps = makeDeps();
    const client = makeClient(event);

    await processStripeEvent(client as never, makeEnvelope(), deps as never);

    expect(deps.pbClient.subscriptionCancelled).toHaveBeenCalledWith(
      STRIPE_CUSTOMER_ID,
      { metadata: { tenant_id: TENANT_ID }, subscriptionId: SUB_ID },
    );
  });

  it('scopes the surviving-sub guard to the TENANT, not the cancelled sub\'s customer', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const event = makeStripeEvent(sub);
    const deps = makeDeps();
    const client = makeClient(event);

    await processStripeEvent(client as never, makeEnvelope(), deps as never);

    const guardCall = client.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT 1 AS n FROM subscriptions'),
    );
    expect(guardCall).toBeDefined();
    // Customer-scoping this lookup would wrongly suspend: a live sub on the
    // tenant's OTHER customer would give no protection. The guard must key
    // on tenant_id.
    expect(guardCall?.[0]).toMatch(/WHERE tenant_id = \$1/);
    expect(guardCall?.[0]).not.toMatch(/stripe_customer_id/);
    expect(guardCall?.[1]).toEqual([TENANT_ID, SUB_ID]);
  });

  it('skips the PB call when a live sub survives on a DIFFERENT customer of the same tenant', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const event = makeStripeEvent(sub);
    const deps = makeDeps();
    // Sibling lookup returns a row — representing an active sub on another
    // Stripe customer belonging to the same tenant. Pre-fix, the
    // customer-scoped query could not see this row.
    const client = {
      query: mockFn().mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM stripe_webhook_events')) {
          return { rows: [{ payload: event }] };
        }
        if (typeof sql === 'string' && sql.includes('SELECT 1 AS n FROM subscriptions')) {
          return { rows: [{ n: 1 }] };
        }
        return { rows: [] };
      }),
    };

    await processStripeEvent(client as never, makeEnvelope(), deps as never);

    expect(deps.pbClient.subscriptionCancelled).not.toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith(
      'stripe.consumer.subscription_canceled_skip_suspend_other_active',
      expect.objectContaining({ tenantId: TENANT_ID, canceledSubId: SUB_ID }),
    );
  });

  it('rethrows PB call failure so Pub/Sub redelivers (no swallow)', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const event = makeStripeEvent(sub);
    const deps = makeDeps();
    deps.pbClient.subscriptionCancelled.mockRejectedValueOnce(new Error('PB unreachable'));
    const client = makeClient(event);

    await expect(processStripeEvent(client as never, makeEnvelope(), deps as never))
      .rejects.toThrow('PB unreachable');

    expect(deps.log.error).toHaveBeenCalledWith(
      'stripe.consumer.pb_mirror_failed_will_retry',
      expect.objectContaining({
        error: 'PB unreachable',
        stripeCustomerId: STRIPE_CUSTOMER_ID,
        subscriptionId: SUB_ID,
        tenantIdFromMetadata: TENANT_ID,
        deliveryAttempt: 1,
      }),
    );
  });

  it('does NOT emit billing.mirror.update_failed outbox event on first-attempt failure', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const event = makeStripeEvent(sub);
    const deps = makeDeps();
    deps.pbClient.subscriptionCancelled.mockRejectedValueOnce(new Error('PB unreachable'));
    const client = makeClient(event);

    await expect(
      processStripeEvent(client as never, makeEnvelope(), deps as never, { deliveryAttempt: 1 }),
    ).rejects.toThrow('PB unreachable');

    const dlqCalls = mockEnqueueOutboxEvent.mock.calls.filter(
      (c: unknown[]) => (c[1] as { eventType?: string })?.eventType === 'billing.mirror.update_failed',
    );
    expect(dlqCalls).toHaveLength(0);
    // pool.connect should not have been called (no DLQ emission path).
    expect(deps.pool.connect).not.toHaveBeenCalled();
  });

  it('emits billing.mirror.update_failed outbox event ONCE when deliveryAttempt >= threshold (5)', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const event = makeStripeEvent(sub);
    const deps = makeDeps();
    deps.pbClient.subscriptionCancelled.mockRejectedValueOnce(new Error('PB still down'));
    const client = makeClient(event);

    await expect(
      processStripeEvent(client as never, makeEnvelope(), deps as never, { deliveryAttempt: 5 }),
    ).rejects.toThrow('PB still down');

    // Outbox emission goes via the fresh alertClient (pool.connect()).
    expect(deps.pool.connect).toHaveBeenCalledTimes(1);
    expect(deps.__alertClient.query).toHaveBeenCalledWith('BEGIN');
    expect(deps.__alertClient.query).toHaveBeenCalledWith('COMMIT');
    expect(deps.__alertClient.release).toHaveBeenCalledTimes(1);

    // enqueueOutboxEvent invoked with the DLQ event on the alertClient.
    const dlqCalls = mockEnqueueOutboxEvent.mock.calls.filter(
      (c: unknown[]) => (c[1] as { eventType?: string })?.eventType === 'billing.mirror.update_failed',
    );
    expect(dlqCalls).toHaveLength(1);
    const envelope = dlqCalls[0][1] as { tenantId: string; payload: Record<string, unknown> };
    expect(envelope.tenantId).toBe(TENANT_ID);
    expect(envelope.payload).toMatchObject({
      subscriptionId: SUB_ID,
      stripeCustomerId: STRIPE_CUSTOMER_ID,
      kind: 'cancellation',
      attempt: 5,
    });
    // Structured log emission so PR 0's billing_mirror_update_failed_dlq
    // Cloud Logging alert fires. The alert filters on jsonPayload.event_type
    // — the outbox row isn't a log entry, so this companion log is what the
    // alert actually keys on.
    expect(deps.log.warn).toHaveBeenCalledWith(
      'billing.mirror.update_failed',
      expect.objectContaining({
        event_type: 'billing.mirror.update_failed',
        subscriptionId: SUB_ID,
        stripeCustomerId: STRIPE_CUSTOMER_ID,
        attempt: 5,
      }),
    );
  });

  it('emits the DLQ outbox event in a NEW transaction (survives the rethrow that rolls back the consumer txn)', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const event = makeStripeEvent(sub);
    const deps = makeDeps();
    deps.pbClient.subscriptionCancelled.mockRejectedValueOnce(new Error('PB still down'));
    const client = makeClient(event);

    await expect(
      processStripeEvent(client as never, makeEnvelope(), deps as never, { deliveryAttempt: 6 }),
    ).rejects.toThrow('PB still down');

    // The alertClient call sequence MUST be: BEGIN → set_config (RLS) →
    // enqueueOutboxEvent's INSERT (mocked → no DB call here, but mockEnqueue
    // was called with the alertClient) → COMMIT.
    const alertCalls = deps.__alertClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(alertCalls[0]).toBe('BEGIN');
    expect(alertCalls).toContain('COMMIT');

    // The enqueueOutboxEvent invocation passed the alertClient (not the
    // consumer-transaction client).
    const dlqCall = mockEnqueueOutboxEvent.mock.calls.find(
      (c: unknown[]) => (c[1] as { eventType?: string })?.eventType === 'billing.mirror.update_failed',
    );
    expect(dlqCall).toBeDefined();
    expect(dlqCall?.[0]).toBe(deps.__alertClient);
  });

  it('is idempotent — running twice on the same canceled event yields identical final mutations', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const event = makeStripeEvent(sub);

    const deps1 = makeDeps();
    const client1 = makeClient(event);
    await processStripeEvent(client1 as never, makeEnvelope(), deps1 as never);

    const deps2 = makeDeps();
    const client2 = makeClient(event);
    await processStripeEvent(client2 as never, makeEnvelope(), deps2 as never);

    // Both runs hit UPDATE subscriptions with the same parameters and both
    // called pbClient.subscriptionCancelled with the same args.
    const update1 = client1.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE subscriptions'),
    );
    const update2 = client2.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE subscriptions'),
    );
    expect(update1?.[1]).toEqual(update2?.[1]);

    expect(deps1.pbClient.subscriptionCancelled.mock.calls[0])
      .toEqual(deps2.pbClient.subscriptionCancelled.mock.calls[0]);
  });

  it('skips PB call entirely when an active sibling sub still exists for the same customer', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const event = makeStripeEvent(sub);
    const deps = makeDeps();
    // Override the sibling-sub lookup to return a row.
    const client = {
      query: mockFn().mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM stripe_webhook_events')) {
          return { rows: [{ payload: event }] };
        }
        if (typeof sql === 'string' && sql.includes('SELECT 1 AS n FROM subscriptions')) {
          return { rows: [{ n: 1 }] }; // sibling exists
        }
        return { rows: [] };
      }),
    };

    await processStripeEvent(client as never, makeEnvelope(), deps as never);

    expect(deps.pbClient.subscriptionCancelled).not.toHaveBeenCalled();
  });
});

// ── Referral-credit forfeiture ──────────────────────────────────────────────
//
// Cancelling forfeits unspent referral credit, and WHERE that happens in this
// function is the whole point. A cancellation is not always a churn: an
// auto-provisioned subscription is cancelled programmatically the moment a real
// one arrives, and a tenant can leave live-but-stale subscriptions behind on an
// old Stripe customer. Forfeiting on either would take credit from an account
// that is still paying — a wrongful suspension, in money the customer earned
// rather than in access.

describe('onSubscriptionCanceled — referral credit forfeiture', () => {
  it('forfeits on a real cancellation', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const deps = makeDeps();

    await processStripeEvent(makeClient(makeStripeEvent(sub)) as never, makeEnvelope(), deps as never);

    expect(deps.referrals.onSubscriptionCancelled).toHaveBeenCalledWith(TENANT_ID);
  });

  it('does NOT forfeit when another active subscription survives', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const deps = makeDeps();
    // A sibling subscription is still live for this tenant — the cancelled one
    // is a dangling or duplicate sub, not the end of the relationship.
    const client = {
      query: mockFn().mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM stripe_webhook_events')) {
          return { rows: [{ payload: makeStripeEvent(sub) }] };
        }
        if (typeof sql === 'string' && sql.includes('SELECT 1 AS n FROM subscriptions')) {
          return { rows: [{ n: '1' }] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await processStripeEvent(client as never, makeEnvelope(), deps as never);

    expect(deps.referrals.onSubscriptionCancelled).not.toHaveBeenCalled();
  });

  it('does NOT forfeit when the cancelled subscription was auto-provisioned', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    // onSubscriptionCreated cancels these itself when a real Checkout
    // subscription arrives, so this fires for an account that has just paid.
    const sub = makeSubscription({
      metadata: { tenant_id: TENANT_ID, provisioning_source: 'auto' },
    } as never);
    const deps = makeDeps();

    await processStripeEvent(makeClient(makeStripeEvent(sub)) as never, makeEnvelope(), deps as never);

    expect(deps.referrals.onSubscriptionCancelled).not.toHaveBeenCalled();
  });

  it('does not fail the cancellation when forfeiture throws', async () => {
    const { processStripeEvent } = await import('../stripe-event-processor.js');
    const sub = makeSubscription();
    const deps = makeDeps();
    deps.referrals.onSubscriptionCancelled.mockRejectedValue(new Error('db down'));

    // A lost forfeiture is a $20 overpayment; a throw here would retry every
    // other side effect of the cancellation alongside it.
    await expect(
      processStripeEvent(makeClient(makeStripeEvent(sub)) as never, makeEnvelope(), deps as never),
    ).resolves.toBeUndefined();
    expect(deps.pbClient.subscriptionCancelled).toHaveBeenCalled();
  });
});
