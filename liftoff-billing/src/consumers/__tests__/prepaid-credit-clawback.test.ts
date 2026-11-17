// Moving prepaid credit when the payment that bought it moves.
//
// Credit is non-refundable, which only means anything if money leaving takes
// the unspent Operating Units with it. Before this, a top-up could be charged
// back after the compute was consumed and the customer kept both.
//
// The property worth guarding is the NEGATIVE one: only a prepaid top-up
// invoice may be clawed back. A refunded subscription invoice bought a plan,
// not credit, and debiting the wallet for one takes money the customer still
// owns — a bug that would be invisible until somebody complained.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@liftoffos/outbox';
import { processStripeEvent } from '../stripe-event-processor';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const CUSTOMER = 'cus_prepaid_clawback';
const INVOICE = 'in_prepaid_clawback';

function makeCharge(overrides: Record<string, unknown> = {}) {
  return {
    id: `ch_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    object: 'charge',
    invoice: INVOICE,
    customer: CUSTOMER,
    amount: 5000,
    amount_refunded: 5000,
    ...overrides,
  };
}

function makeEnvelope(stripeEventId: string, type: string): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType: `billing.stripe.${type}`,
    schemaVersion: 1,
    tenantId: randomUUID(),
    occurredAt: new Date(),
    sourceService: 'liftoff-billing',
    traceId: null,
    payload: { stripeEventId, stripeEventType: type },
  } as EventEnvelope;
}

const RESOLVED_TENANT = '33333333-3333-4333-8333-333333333333';

/** A client whose invoice lookup reports `invoiceType`.
 *
 *  `tenantResolves` is the charge-family resolution added with migration 030:
 *  these events carry no tenant, so the consumer looks one up from the charge's
 *  invoice before any handler runs. Defaulting it to true keeps every existing
 *  case about what it was about; the false case has its own test below. */
function makeClient(
  event: { id: string; type: string; data: unknown },
  invoiceType: string,
  tenantResolves = true,
) {
  return {
    query: mockFn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM stripe_webhook_events')) return { rows: [{ payload: event }] };
      if (sql.includes('tenant_id_for_stripe_invoice')) {
        return { rows: [{ tenant_id: tenantResolves ? RESOLVED_TENANT : null }] };
      }
      if (sql.includes('FROM invoices WHERE stripe_invoice_id')) return { rows: [{ type: invoiceType }] };
      return { rows: [], rowCount: 0 };
    }),
  } as never;
}

const prepaidClawback = mockFn();
const prepaidToppedUp = mockFn();

function makeDeps() {
  return {
    pool: {} as never,
    stripe: { charges: { retrieve: mockFn().mockResolvedValue(makeCharge()) } } as never,
    pbClient: { prepaidClawback, prepaidToppedUp } as never,
    stripeUsage: {} as never,
    referrals: {
      onEarningPaymentReversed: mockFn().mockResolvedValue({ reversed: 0, absorbed: 0 }),
      onEarningPaymentReinstated: mockFn().mockResolvedValue({ restored: 0 }),
    } as never,
    log: { info: mockFn(), warn: mockFn(), error: mockFn() },
  };
}

beforeEach(() => {
  prepaidClawback.mockReset();
  prepaidClawback.mockResolvedValue(undefined);
  prepaidToppedUp.mockReset();
  prepaidToppedUp.mockResolvedValue(undefined);
});

describe('a refunded top-up', () => {
  it('debits the credit it bought', async () => {
    const event = { id: 'evt_1', type: 'charge.refunded', data: { object: makeCharge() } };
    await processStripeEvent(makeClient(event, 'prepaid_reload'), makeEnvelope('evt_1', 'charge.refunded'), makeDeps() as never);

    expect(prepaidClawback).toHaveBeenCalledWith(CUSTOMER, 50, 'refund');
  });

  // The guard. A subscription invoice bought a plan, not credit.
  it('leaves the credit alone when the refund was a subscription invoice', async () => {
    const event = { id: 'evt_2', type: 'charge.refunded', data: { object: makeCharge() } };
    await processStripeEvent(makeClient(event, 'subscription_cycle'), makeEnvelope('evt_2', 'charge.refunded'), makeDeps() as never);

    expect(prepaidClawback).not.toHaveBeenCalled();
  });

  it('does nothing when no money actually moved', async () => {
    const charge = makeCharge({ amount_refunded: 0 });
    const event = { id: 'evt_3', type: 'charge.refunded', data: { object: charge } };
    await processStripeEvent(makeClient(event, 'prepaid_reload'), makeEnvelope('evt_3', 'charge.refunded'), makeDeps() as never);

    expect(prepaidClawback).not.toHaveBeenCalled();
  });
});

describe('a disputed top-up', () => {
  it('debits on the filing, because the money has already left', async () => {
    const dispute = { id: 'dp_1', object: 'dispute', charge: 'ch_1', amount: 2500 };
    const event = { id: 'evt_4', type: 'charge.dispute.created', data: { object: dispute } };
    await processStripeEvent(makeClient(event, 'prepaid_reload'), makeEnvelope('evt_4', 'charge.dispute.created'), makeDeps() as never);

    expect(prepaidClawback).toHaveBeenCalledWith(CUSTOMER, 25, 'dispute');
  });

  it('puts the credit back when the dispute is decided in our favour', async () => {
    const dispute = { id: 'dp_2', object: 'dispute', charge: 'ch_2', amount: 2500 };
    const event = { id: 'evt_5', type: 'charge.dispute.funds_reinstated', data: { object: dispute } };
    await processStripeEvent(makeClient(event, 'prepaid_reload'), makeEnvelope('evt_5', 'charge.dispute.funds_reinstated'), makeDeps() as never);

    expect(prepaidToppedUp).toHaveBeenCalledWith(CUSTOMER, 25);
    expect(prepaidClawback).not.toHaveBeenCalled();
  });
});

// The endpoint's API version is not the SDK's.
//
// A webhook payload is serialised at the version configured on the Stripe
// endpoint, and `Charge.invoice` is absent in later ones — an endpoint on
// 2026-02-25.clover omits it, while this SDK pins 2024-06-20, where it is
// present. Trusting the payload, a refund logs `charge_without_invoice` and
// claws back nothing: the money goes back and the Operating Units stay.
// Re-reading the charge through the SDK is what makes the link depend on the
// version we pin rather than the one an operator picked in a dashboard.
describe('a refund whose event payload omits the invoice link', () => {
  it('re-reads the charge through the SDK and still claws the credit back', async () => {
    const payloadCharge = makeCharge({ invoice: null });   // as the newer API version sends it
    const event = { id: 'evt_8', type: 'charge.refunded', data: { object: payloadCharge } };

    const deps = makeDeps();
    // The SDK's pinned version still carries the invoice link.
    (deps.stripe as unknown as { charges: { retrieve: ReturnType<typeof mockFn> } })
      .charges.retrieve = mockFn().mockResolvedValue(makeCharge());

    await processStripeEvent(
      makeClient(event, 'prepaid_reload'),
      makeEnvelope('evt_8', 'charge.refunded'),
      deps as never,
    );

    expect(prepaidClawback).toHaveBeenCalledWith(CUSTOMER, 50, 'refund');
  });
});

// The regression these tests could not see, because they mock the lookup they
// were asserting through.
//
// A charge event carries no tenant. The webhook receiver seeds the outbox
// envelope with a sentinel UUID, the consumer binds it as
// app.current_tenant_id, and `invoices` is strict-RLS — so under the sentinel
// the `SELECT type FROM invoices` matches zero rows, settlePrepaidCredit
// returns having done nothing, and refunds and disputes claw back nothing at
// all. Resolving the tenant from the charge's invoice
// first is the fix; refusing to proceed without one is what keeps the silence
// from coming back.
describe('a charge event whose tenant cannot be resolved', () => {
  it('throws rather than running the handler under a sentinel tenant', async () => {
    const event = { id: 'evt_6', type: 'charge.refunded', data: { object: makeCharge() } };

    await expect(
      processStripeEvent(
        makeClient(event, 'prepaid_reload', false),
        makeEnvelope('evt_6', 'charge.refunded'),
        makeDeps() as never,
      ),
    ).rejects.toThrow('charge_invoice_tenant_unresolved');

    // Nothing was clawed back under the wrong scope — the event retries, then
    // dead-letters loudly, which is recoverable. A silent no-op is not.
    expect(prepaidClawback).not.toHaveBeenCalled();
    expect(prepaidToppedUp).not.toHaveBeenCalled();
  });

  // A charge with no invoice on the re-read either is genuinely not ours —
  // not a payload the endpoint's API version stripped the link from.
  it('ignores a charge that never belonged to an invoice of ours', async () => {
    const charge = makeCharge({ invoice: null });
    const event = { id: 'evt_7', type: 'charge.refunded', data: { object: charge } };

    const deps = makeDeps();
    (deps.stripe as unknown as { charges: { retrieve: ReturnType<typeof mockFn> } })
      .charges.retrieve = mockFn().mockResolvedValue(makeCharge({ invoice: null }));

    await processStripeEvent(
      makeClient(event, 'prepaid_reload'),
      makeEnvelope('evt_7', 'charge.refunded'),
      deps as never,
    );

    expect(prepaidClawback).not.toHaveBeenCalled();
  });
});
