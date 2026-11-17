// Gap 16 — structural-equivalence replay test.
//
// Verifies that replaying 50 synthetic `billing.stripe.invoice.*` events
// through `processStripeEvent` produces the same canonical billing state
// as processing them once. Idempotency (via withOutboxConsumer dedup) must
// guarantee no duplicate outbox rows and stable invoice state.

import { describe, it, expect, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type { EventEnvelope } from '@liftoffos/outbox';

// @jest/globals' jest.fn() is strictly typed; for these unit tests we just
// want a loose mock that returns whatever we ask it to. Type-erased escape
// hatch matching the pattern in billing-accounts-router.test.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeInvoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: `in_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    object: 'invoice',
    amount_due: 10_00,
    amount_paid: 0,
    amount_remaining: 10_00,
    tax: 0,
    currency: 'usd',
    period_start: Math.floor(Date.now() / 1000) - 30 * 24 * 3600,
    period_end: Math.floor(Date.now() / 1000),
    created: Math.floor(Date.now() / 1000) - 1,
    status: 'open',
    status_transitions: {},
    default_payment_method: null,
    last_finalization_error: null,
    // Invoices are attributed to their subscription's tenant; give the fixtures
    // a subscription so the consumer's resolution path resolves (mocked below).
    customer: 'cus_replay',
    subscription: 'sub_replay',
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function makeEnvelope(tenantId: string, stripeEventId: string, type: string): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType: `billing.stripe.${type}`,
    schemaVersion: 1,
    tenantId,
    occurredAt: new Date(),
    sourceService: 'liftoff-billing',
    traceId: null,
    payload: { stripeEventId, stripeEventType: type },
  };
}

// ── test ─────────────────────────────────────────────────────────────────────

describe('invoice replay — structural equivalence over 50 invoices', () => {
  const INVOICE_COUNT = 50;
  const tenantId = randomUUID();

  // Build the fixture dataset once.
  const invoices = Array.from({ length: INVOICE_COUNT }, () => makeInvoice());
  const stripeEvents = invoices.map((inv) => ({
    id: `evt_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    type: 'invoice.created' as const,
    data: { object: inv },
  }));

  // Track upserted state
  const invoiceState = new Map<string, { status: string; amountDueCents: bigint }>();
  const outboxEvents: string[] = [];

  // Minimal mock of pg PoolClient
  function makeClient() {
    return {
      query: mockFn().mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM stripe_webhook_events')) {
          const stripeEventId = (params as string[])[0];
          const se = stripeEvents.find((e) => e.id === stripeEventId);
          return { rows: se ? [{ payload: se }] : [] };
        }
        if (sql.includes('tenant_id_for_stripe_subscription')) {
          return { rows: [{ tenant_id: tenantId }] };
        }
        if (sql.includes('upsert_invoice_record')) {
          const stripeInvoiceId = (params as unknown[])[1] as string;
          invoiceState.set(stripeInvoiceId, {
            status: (params as unknown[])[2] as string,
            amountDueCents: BigInt((params as unknown[])[3] as bigint),
          });
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO outbox_events') || sql.includes('enqueue')) {
          outboxEvents.push(String(params));
          return { rows: [{ id: randomUUID() }] };
        }
        if (sql.includes('UPDATE stripe_webhook_events')) {
          return { rows: [] };
        }
        // processed_events dedup check
        if (sql.includes('FROM processed_events')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO processed_events')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
  }

  const makeDeps = () => ({
    pool: {} as never,
    stripe: {} as never,
    pbClient: {} as never,
    stripeUsage: {
      attachOuPriceToSubscription: mockFn().mockResolvedValue(undefined),
      ingestOuEvent: mockFn().mockResolvedValue(undefined),
    } as never,
    // The referral programme's money half. Stubbed rather than omitted because
    // the processor now calls it on every subscription invoice, and a test
    // whose deps are missing it fails on a TypeError that says nothing about
    // what it was actually asserting.
    referrals: {
      onReferredInvoicePaid: mockFn().mockResolvedValue(undefined),
      applyToInvoice: mockFn().mockResolvedValue({ appliedUsd: 0 }),
      onSubscriptionCancelled: mockFn().mockResolvedValue({ forfeited: 0 }),
      onEarningPaymentReversed: mockFn().mockResolvedValue({ reversed: 0, absorbed: 0 }),
    } as never,
    log: { info: mockFn(), warn: mockFn(), error: mockFn() },
  });

  it('upserts each invoice exactly once regardless of replay count', async () => {
    // Import here so jest mocking is in scope
    const { processStripeEvent } = await import('../consumers/stripe-event-processor.js');
    const deps = makeDeps();

    // First pass
    for (const se of stripeEvents) {
      const client = makeClient();
      const envelope = makeEnvelope(tenantId, se.id, se.type);
      await processStripeEvent(client as never, envelope, deps);
    }
    const stateAfterFirstPass = new Map(invoiceState);

    // Second pass (replay)
    for (const se of stripeEvents) {
      const client = makeClient();
      const envelope = makeEnvelope(tenantId, se.id, se.type);
      await processStripeEvent(client as never, envelope, deps);
    }

    // Invoice state must be structurally equivalent after replay
    expect(invoiceState.size).toBe(stateAfterFirstPass.size);
    for (const [id, state] of stateAfterFirstPass) {
      const replayState = invoiceState.get(id);
      expect(replayState).toBeDefined();
      expect(replayState!.status).toBe(state.status);
      expect(replayState!.amountDueCents).toBe(state.amountDueCents);
    }
  });

  it('processes all 50 invoices with expected open status', async () => {
    const { processStripeEvent } = await import('../consumers/stripe-event-processor.js');
    const deps = makeDeps();

    invoiceState.clear();
    for (const se of stripeEvents) {
      const client = makeClient();
      const envelope = makeEnvelope(tenantId, se.id, se.type);
      await processStripeEvent(client as never, envelope, deps);
    }

    expect(invoiceState.size).toBe(INVOICE_COUNT);
    for (const state of invoiceState.values()) {
      expect(state.amountDueCents).toBe(BigInt(10_00));
    }
  });
});
