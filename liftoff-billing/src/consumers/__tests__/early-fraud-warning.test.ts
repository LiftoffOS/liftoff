// An issuer reporting a card that paid us as fraudulent.
//
// Stripe sends this days before the dispute it usually becomes — about 40% of
// the time. Acting on it is worth those days of compute, but only in one
// direction: STOP the spend, do not take the credit. The money has not moved
// yet, so a clawback here would debit the wallet twice on the warnings that do
// become disputes, and once too often on the ones that do not. Credit follows
// money; admission follows risk.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@liftoffos/outbox';
import { processStripeEvent } from '../stripe-event-processor';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const CUSTOMER = 'cus_efw_00001';
const INVOICE = 'in_efw_00001';
const CHARGE = 'ch_efw_00001';
const TENANT = '44444444-4444-4444-8444-444444444444';

function makeCharge(overrides: Record<string, unknown> = {}) {
  return {
    id: CHARGE,
    object: 'charge',
    invoice: INVOICE,
    customer: CUSTOMER,
    amount: 5000,
    ...overrides,
  };
}

function makeWarning(overrides: Record<string, unknown> = {}) {
  return {
    id: 'issfr_1Test00000000',
    object: 'radar.early_fraud_warning',
    actionable: true,
    charge: CHARGE,
    fraud_type: 'made_with_stolen_card',
    ...overrides,
  };
}

function makeEnvelope(stripeEventId: string): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType: 'billing.stripe.radar.early_fraud_warning.created',
    schemaVersion: 1,
    tenantId: randomUUID(), // the sentinel the receiver seeds; never the real one
    occurredAt: new Date(),
    sourceService: 'liftoff-billing',
    traceId: null,
    payload: { stripeEventId, stripeEventType: 'radar.early_fraud_warning.created' },
  } as EventEnvelope;
}

const queries: string[] = [];

function makeClient(event: { id: string; type: string; data: unknown }, tenantResolves = true) {
  return {
    query: mockFn().mockImplementation(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM stripe_webhook_events')) return { rows: [{ payload: event }] };
      if (sql.includes('tenant_id_for_stripe_invoice')) {
        return { rows: [{ tenant_id: tenantResolves ? TENANT : null }] };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as never;
}

const fraudHold = mockFn();
const prepaidClawback = mockFn();
const prepaidToppedUp = mockFn();

function makeDeps(charge: Record<string, unknown> = makeCharge()) {
  return {
    pool: {} as never,
    stripe: { charges: { retrieve: mockFn().mockResolvedValue(charge) } } as never,
    pbClient: { fraudHold, prepaidClawback, prepaidToppedUp } as never,
    stripeUsage: {} as never,
    referrals: {
      onEarningPaymentReversed: mockFn().mockResolvedValue({ reversed: 0, absorbed: 0 }),
      onEarningPaymentReinstated: mockFn().mockResolvedValue({ restored: 0 }),
    } as never,
    log: { info: mockFn(), warn: mockFn(), error: mockFn() },
  };
}

beforeEach(() => {
  queries.length = 0;
  fraudHold.mockReset();
  fraudHold.mockResolvedValue(undefined);
  prepaidClawback.mockReset();
  prepaidToppedUp.mockReset();
});

describe('an actionable early fraud warning', () => {
  it('holds the customer and records the warning against the invoice', async () => {
    const event = { id: 'evt_1', type: 'radar.early_fraud_warning.created', data: { object: makeWarning() } };

    await processStripeEvent(makeClient(event), makeEnvelope('evt_1'), makeDeps() as never);

    expect(fraudHold).toHaveBeenCalledWith(CUSTOMER, {
      ref: 'issfr_1Test00000000',
      chargeId: CHARGE,
      invoiceId: INVOICE,
      fraudType: 'made_with_stolen_card',
    });
    expect(queries.some((q) => q.includes('fraud_warning_at'))).toBe(true);
  });

  // The property that separates this from the dispute path.
  it('takes no credit back, because no money has moved', async () => {
    const event = { id: 'evt_2', type: 'radar.early_fraud_warning.created', data: { object: makeWarning() } };

    await processStripeEvent(makeClient(event), makeEnvelope('evt_2'), makeDeps() as never);

    expect(prepaidClawback).not.toHaveBeenCalled();
    expect(prepaidToppedUp).not.toHaveBeenCalled();
  });

  // The signal is about the card, so what the invoice bought is irrelevant.
  it('holds on a subscription invoice too, not only a wallet top-up', async () => {
    const event = { id: 'evt_3', type: 'radar.early_fraud_warning.created', data: { object: makeWarning() } };

    await processStripeEvent(makeClient(event), makeEnvelope('evt_3'), makeDeps() as never);

    expect(fraudHold).toHaveBeenCalled();
  });

  // A hold that did not land leaves the compute running on a card the issuer
  // has already called stolen, so the consumer must 500 and Pub/Sub retry.
  it('throws when the hold cannot be placed', async () => {
    const event = { id: 'evt_4', type: 'radar.early_fraud_warning.created', data: { object: makeWarning() } };
    fraudHold.mockRejectedValue(new Error('platform-backend 503'));

    await expect(
      processStripeEvent(makeClient(event), makeEnvelope('evt_4'), makeDeps() as never),
    ).rejects.toThrow('platform-backend 503');
  });
});

describe('a warning that is not actionable', () => {
  // `actionable: false` means the charge is already refunded or disputed.
  // Those paths own it, and holding again would be acting twice on one event.
  it('does nothing at all', async () => {
    const event = {
      id: 'evt_5',
      type: 'radar.early_fraud_warning.created',
      data: { object: makeWarning({ actionable: false }) },
    };

    await processStripeEvent(makeClient(event), makeEnvelope('evt_5'), makeDeps() as never);

    expect(fraudHold).not.toHaveBeenCalled();
    expect(queries.some((q) => q.includes('fraud_warning_at'))).toBe(false);
  });
});
