// Crediting a wallet top-up that the customer's browser paid for.
//
// The charge is confirmed in the browser so the card's issuer can authenticate
// it, which means no server call is in flight when it settles: this webhook is
// the only thing that sees it. That moves the credit here, and it brings a
// duplicate-credit hazard with it — Stripe sends BOTH invoice.paid and
// invoice.payment_succeeded for one payment, and Pub/Sub may redeliver either.
// They are separate Stripe events with separate ids, so the ingress dedupe
// does not cover them. `wallet_credited_at` is what does.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@liftoffos/outbox';
import { processStripeEvent } from '../stripe-event-processor';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const CUSTOMER = 'cus_topup_00001';
const INVOICE = 'in_topup_00001';
const TENANT = '55555555-5555-4555-8555-555555555555';

function manualTopUpInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    object: 'invoice',
    customer: CUSTOMER,
    amount_paid: 5000,
    amount_due: 5000,
    currency: 'usd',
    status: 'paid',
    billing_reason: 'manual',
    period_start: 1_756_000_000,
    period_end: 1_758_000_000,
    created: 1_756_000_000,
    metadata: { type: 'prepaid_reload', tenant_id: TENANT, source: 'manual' },
    ...overrides,
  };
}

function makeEnvelope(stripeEventId: string, type: string): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType: `billing.stripe.${type}`,
    schemaVersion: 1,
    tenantId: TENANT,
    occurredAt: new Date(),
    sourceService: 'liftoff-billing',
    traceId: null,
    payload: { stripeEventId, stripeEventType: type },
  } as EventEnvelope;
}

/** `alreadyCredited` stands in for the row the mark has already claimed: the
 *  UPDATE ... WHERE wallet_credited_at IS NULL returns nothing second time. */
function makeClient(event: { id: string; type: string; data: unknown }, alreadyCredited = false) {
  return {
    query: mockFn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM stripe_webhook_events')) return { rows: [{ payload: event }] };
      if (sql.includes('wallet_credited_at = NOW()')) {
        return alreadyCredited ? { rows: [], rowCount: 0 } : { rows: [{ id: 'row-1' }], rowCount: 1 };
      }
      if (sql.includes('FROM payment_methods')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }),
  } as never;
}

const prepaidToppedUp = mockFn();
const receipt = mockFn();

function makeDeps() {
  return {
    pool: {} as never,
    stripe: { subscriptions: { retrieve: mockFn() }, charges: { retrieve: mockFn() } } as never,
    pbClient: { prepaidToppedUp, receipt, periodReset: mockFn(), thresholdSucceeded: mockFn(), recoverySucceeded: mockFn() } as never,
    stripeUsage: {} as never,
    referrals: {
      onReferredInvoicePaid: mockFn().mockResolvedValue(undefined),
    } as never,
    log: { info: mockFn(), warn: mockFn(), error: mockFn() },
  };
}

beforeEach(() => {
  prepaidToppedUp.mockReset();
  prepaidToppedUp.mockResolvedValue(undefined);
  receipt.mockReset();
  receipt.mockResolvedValue(undefined);
});

describe('a manual wallet top-up', () => {
  it('credits the wallet once the payment settles', async () => {
    const event = { id: 'evt_1', type: 'invoice.paid', data: { object: manualTopUpInvoice() } };

    await processStripeEvent(makeClient(event), makeEnvelope('evt_1', 'invoice.paid'), makeDeps() as never);

    expect(prepaidToppedUp).toHaveBeenCalledWith(CUSTOMER, 50);
  });

  // Stripe's two events for one payment. Without the mark this credits twice,
  // and a double credit is silent — nothing downstream would ever flag it.
  it('does not credit again when the second of Stripe\'s two events arrives', async () => {
    const event = {
      id: 'evt_2',
      type: 'invoice.payment_succeeded',
      data: { object: manualTopUpInvoice() },
    };

    await processStripeEvent(
      makeClient(event, true),
      makeEnvelope('evt_2', 'invoice.payment_succeeded'),
      makeDeps() as never,
    );

    expect(prepaidToppedUp).not.toHaveBeenCalled();
  });
});

describe('an auto-reload top-up', () => {
  // Auto-reload pays off-session and credits synchronously in
  // /api/internal/auto-reload, because nobody is present to authenticate it.
  // Its invoices carry `tenant_id` but no `source`, and crediting them here as
  // well would double every automatic reload.
  it('is left alone, because its own path already credited it', async () => {
    const event = {
      id: 'evt_3',
      type: 'invoice.paid',
      data: { object: manualTopUpInvoice({ metadata: { type: 'prepaid_reload', tenant_id: TENANT } }) },
    };

    await processStripeEvent(makeClient(event), makeEnvelope('evt_3', 'invoice.paid'), makeDeps() as never);

    expect(prepaidToppedUp).not.toHaveBeenCalled();
  });

  // Why the auto-reload path now names a tenant on the invoice it creates.
  // Without `tenant_id` in metadata, an invoice with no subscription behind it
  // — which is every reload on a workspace that funds itself with credit —
  // falls through to a customer lookup that finds nothing, and the event
  // dead-letters instead of being processed.
  it('cannot be attributed at all when the invoice names no workspace', async () => {
    const event = {
      id: 'evt_4',
      type: 'invoice.paid',
      data: { object: manualTopUpInvoice({ metadata: { type: 'prepaid_reload' }, subscription: null }) },
    };

    await expect(
      processStripeEvent(makeClient(event), makeEnvelope('evt_4', 'invoice.paid'), makeDeps() as never),
    ).rejects.toThrow('invoice_tenant_unresolved');
  });
});
