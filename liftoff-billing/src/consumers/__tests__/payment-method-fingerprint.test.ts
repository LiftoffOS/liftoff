// Verifies the fingerprint upsert side-effect wired into onPaymentMethodChanged
// for the user-deletion / promo-abuse plan (Phase 2.2). A payment_method.attached
// webhook should UPSERT the (fingerprint, stripe_customer_id) pair into
// payment_method_fingerprints_seen with customer_status='active'.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { asTenantScoped } from '../../infrastructure/database.js';
import type { PoolClient } from 'pg';
import type Stripe from 'stripe';

import { processStripeEvent, type StripeProcessorDeps } from '../stripe-event-processor.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const STRIPE_CUSTOMER = 'cus_fp_test';
const STRIPE_EVENT_ID = 'evt_fp_test';

interface ClientCall {
  sql: string;
  params: unknown[] | undefined;
}

function makeClient(stripeEvent: Stripe.Event): { client: PoolClient; calls: ClientCall[] } {
  const calls: ClientCall[] = [];
  const query = mockFn().mockImplementation((sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes('FROM stripe_webhook_events')) {
      return Promise.resolve({ rows: [{ payload: stripeEvent }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return {
    client: { query, release: mockFn() } as unknown as PoolClient,
    calls,
  };
}

function makeDeps(): StripeProcessorDeps {
  return {
    stripe: {
      billing: { meterEvents: { create: mockFn().mockResolvedValue({}) } },
    } as unknown as Stripe,
    pbClient: {
      paymentMethodAdded: mockFn().mockResolvedValue(undefined),
    } as unknown as StripeProcessorDeps['pbClient'],
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as StripeProcessorDeps;
}

describe('processStripeEvent: payment_method.attached fingerprint upsert', () => {
  let deps: StripeProcessorDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('UPSERTs payment_method_fingerprints_seen with active status when fingerprint + customer present', async () => {
    const event = {
      id: STRIPE_EVENT_ID,
      type: 'payment_method.attached',
      data: {
        object: {
          id: 'pm_fp_test',
          customer: STRIPE_CUSTOMER,
          card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, fingerprint: 'fp_xyz_unique' },
          metadata: { tenant_id: TENANT_ID },
        },
      },
    } as unknown as Stripe.Event;

    const { client, calls } = makeClient(event);
    await processStripeEvent(
      // Stands in for the client withOutboxConsumer hands over, which the
      // consumer scopes before dispatch — the same claim production makes.
      asTenantScoped(client as never),
      {
        envelopeId: 'env_1',
        tenantId: TENANT_ID,
        eventType: 'billing.stripe.payment_method.attached',
        entityType: 'payment_method',
        entityId: 'pm_fp_test',
        entityVersion: 1,
        eventVersion: 1,
        payload: { stripeEventId: STRIPE_EVENT_ID, stripeEventType: 'payment_method.attached' },
        occurredAt: new Date(),
      } as unknown as Parameters<typeof processStripeEvent>[1],
      deps,
    );

    const fpCall = calls.find(c => c.sql.includes('INSERT INTO payment_method_fingerprints_seen'));
    expect(fpCall).toBeDefined();
    expect(fpCall!.sql).toContain("'active'");
    expect(fpCall!.params).toEqual(['fp_xyz_unique', STRIPE_CUSTOMER]);
  });

  it('skips the fingerprint upsert when card has no fingerprint', async () => {
    const event = {
      id: STRIPE_EVENT_ID,
      type: 'payment_method.attached',
      data: {
        object: {
          id: 'pm_fp_test',
          customer: STRIPE_CUSTOMER,
          card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
          metadata: { tenant_id: TENANT_ID },
        },
      },
    } as unknown as Stripe.Event;

    const { client, calls } = makeClient(event);
    await processStripeEvent(
      // Stands in for the client withOutboxConsumer hands over, which the
      // consumer scopes before dispatch — the same claim production makes.
      asTenantScoped(client as never),
      {
        envelopeId: 'env_2',
        tenantId: TENANT_ID,
        eventType: 'billing.stripe.payment_method.attached',
        entityType: 'payment_method',
        entityId: 'pm_fp_test',
        entityVersion: 1,
        eventVersion: 1,
        payload: { stripeEventId: STRIPE_EVENT_ID, stripeEventType: 'payment_method.attached' },
        occurredAt: new Date(),
      } as unknown as Parameters<typeof processStripeEvent>[1],
      deps,
    );

    expect(calls.find(c => c.sql.includes('payment_method_fingerprints_seen'))).toBeUndefined();
  });
});
