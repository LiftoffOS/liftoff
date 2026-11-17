// Daily Stripe↔local subscription reconciliation.
//
// Behavior verified:
//   (a) untracked active Stripe sub → billing.reconciliation.untracked_stripe_subscription
//   (b) local active row canceled/missing in Stripe → billing.reconciliation.local_active_stripe_canceled
//   (c) billing_controls pointer not active in Stripe → billing.reconciliation.bc_pointer_mismatch
//   - clean customer → zero findings
//   - one failing customer does not abort the run

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type Stripe from 'stripe';

import { registerSubscriptionReconciliationRouter } from '../subscription-reconciliation.js';
import type { PlatformBackendClient } from '../../infrastructure/platform-backend-client.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const TOKEN = 'test-billing-service-token';
const CUSTOMER = 'cus_recon_test_01';

function makeStripeSub(id: string, status: string, tenantId = 'tenant-1'): Stripe.Subscription {
  return {
    id,
    object: 'subscription',
    status,
    customer: CUSTOMER,
    created: 1747756800,
    metadata: { tenant_id: tenantId },
  } as unknown as Stripe.Subscription;
}

function makeStripe(subsByCustomer: Record<string, Stripe.Subscription[]>): Stripe {
  return {
    subscriptions: {
      list: mockFn().mockImplementation((params: { customer: string }) => ({
        async *[Symbol.asyncIterator]() {
          for (const s of subsByCustomer[params.customer] ?? []) yield s;
        },
      })),
    },
  } as unknown as Stripe;
}

// pool.query responses: first call is the DISTINCT customer list; each
// customer then triggers one local-rows query.
function makePool(customerIds: string[], localRowsByCustomer: Record<string, unknown[]>): Pool {
  return {
    query: mockFn().mockImplementation((sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('DISTINCT stripe_customer_id')) {
        return Promise.resolve({
          rows: customerIds.map((id) => ({ stripe_customer_id: id })),
          rowCount: customerIds.length,
        });
      }
      const customer = params?.[0] as string;
      const rows = localRowsByCustomer[customer] ?? [];
      return Promise.resolve({ rows, rowCount: rows.length });
    }),
  } as unknown as Pool;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makePb(
  pointer: string | null,
  opts?: { pbCustomers?: Array<{ accountId: string; stripeCustomerId: string; stripeSubscriptionId: string | null; suspended?: boolean }> },
): { client: PlatformBackendClient; getControlsStatus: any; listBillingCustomers: any } {
  const getControlsStatus = mockFn().mockResolvedValue(
    pointer === null ? null : { accountId: 'acc-1', stripeSubscriptionId: pointer },
  );
  const listBillingCustomers = mockFn().mockResolvedValue(opts?.pbCustomers ?? []);
  return {
    client: { getControlsStatus, listBillingCustomers } as unknown as PlatformBackendClient,
    getControlsStatus,
    listBillingCustomers,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function buildApp(args: { stripe: Stripe; pool: Pool; pbClient: PlatformBackendClient }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerSubscriptionReconciliationRouter(app, {
    stripe: args.stripe,
    pool: args.pool,
    pbClient: args.pbClient,
    billingServiceToken: TOKEN,
  });
  await app.ready();
  return app;
}

function post(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/api/internal/jobs/subscription-reconciliation',
    headers: { 'x-service-auth': TOKEN },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/internal/jobs/subscription-reconciliation', () => {
  it('rejects without the service token', async () => {
    const app = await buildApp({
      stripe: makeStripe({}),
      pool: makePool([], {}),
      pbClient: makePb(null).client,
    });
    const res = await app.inject({ method: 'POST', url: '/api/internal/jobs/subscription-reconciliation' });
    expect(res.statusCode).toBe(401);
  });

  it('reports zero findings for a fully consistent customer', async () => {
    const app = await buildApp({
      stripe: makeStripe({ [CUSTOMER]: [makeStripeSub('sub_ok', 'active')] }),
      pool: makePool([CUSTOMER], {
        [CUSTOMER]: [{ stripe_subscription_id: 'sub_ok', status: 'active', tenant_id: 'tenant-1' }],
      }),
      pbClient: makePb(null, {
        pbCustomers: [{ accountId: 'acc-1', stripeCustomerId: CUSTOMER, stripeSubscriptionId: 'sub_ok' }],
      }).client,
    });
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      customersChecked: 1,
      untracked: 0,
      localActiveStripeCanceled: 0,
      pointerMismatch: 0,
    });
  });

  it('(a) flags an active Stripe sub with no local row — drift that leaves a stray sub billing', async () => {
    const app = await buildApp({
      stripe: makeStripe({
        [CUSTOMER]: [makeStripeSub('sub_tracked', 'active'), makeStripeSub('sub_ghost', 'active')],
      }),
      pool: makePool([CUSTOMER], {
        [CUSTOMER]: [{ stripe_subscription_id: 'sub_tracked', status: 'active', tenant_id: 'tenant-1' }],
      }),
      pbClient: makePb('sub_tracked').client,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ untracked: 1, localActiveStripeCanceled: 0, pointerMismatch: 0 });
  });

  it('(b) flags a local active row whose Stripe sub is canceled or missing', async () => {
    const app = await buildApp({
      stripe: makeStripe({ [CUSTOMER]: [makeStripeSub('sub_dead', 'canceled')] }),
      pool: makePool([CUSTOMER], {
        [CUSTOMER]: [
          { stripe_subscription_id: 'sub_dead', status: 'active', tenant_id: 'tenant-1' },
          { stripe_subscription_id: 'sub_vanished', status: 'active', tenant_id: 'tenant-1' },
        ],
      }),
      pbClient: makePb(null).client,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ localActiveStripeCanceled: 2 });
  });

  it('(c) skips the pointer check for SUSPENDED accounts — a churned account\'s dead pointer is expected state, not drift', async () => {
    const app = await buildApp({
      stripe: makeStripe({ [CUSTOMER]: [makeStripeSub('sub_churned', 'canceled')] }),
      pool: makePool([CUSTOMER], {
        [CUSTOMER]: [{ stripe_subscription_id: 'sub_churned', status: 'canceled', tenant_id: 'tenant-1' }],
      }),
      pbClient: makePb(null, {
        pbCustomers: [{ accountId: 'acc-1', stripeCustomerId: CUSTOMER, stripeSubscriptionId: 'sub_churned', suspended: true }],
      }).client,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ customersChecked: 1, pointerMismatch: 0 });
  });

  it('(c) flags a billing_controls pointer at a sub that is not active in Stripe (dangling pointer)', async () => {
    const app = await buildApp({
      stripe: makeStripe({ [CUSTOMER]: [makeStripeSub('sub_real', 'active')] }),
      pool: makePool([CUSTOMER], {
        [CUSTOMER]: [{ stripe_subscription_id: 'sub_real', status: 'active', tenant_id: 'tenant-1' }],
      }),
      pbClient: makePb(null, {
        pbCustomers: [{ accountId: 'acc-1', stripeCustomerId: CUSTOMER, stripeSubscriptionId: 'sub_hard_deleted' }],
      }).client,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ pointerMismatch: 1 });
  });

  it('sweeps customers known ONLY to PB billing_controls (no local subscriptions row) — superseded-customer coverage', async () => {
    const PB_ONLY_CUSTOMER = 'cus_superseded_01';
    const pb = makePb('sub_gone', {
      pbCustomers: [{ accountId: 'acc-1', stripeCustomerId: PB_ONLY_CUSTOMER, stripeSubscriptionId: 'sub_gone' }],
    });
    const app = await buildApp({
      // The PB-only customer still carries a live untracked sub in Stripe —
      // a stale subscription the local table cannot see.
      stripe: makeStripe({ [PB_ONLY_CUSTOMER]: [makeStripeSub('sub_ghost', 'active')] }),
      pool: makePool([], {}),
      pbClient: pb.client,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ customers: 1, untracked: 1, pointerMismatch: 1 });
  });

  it('aborts the run loudly (502) when the PB customer listing fails — never silently shrinks coverage', async () => {
    const pb = makePb('sub_ok');
    pb.listBillingCustomers.mockRejectedValue(new Error('PB down'));
    const app = await buildApp({
      stripe: makeStripe({}),
      pool: makePool([CUSTOMER], {}),
      pbClient: pb.client,
    });
    const res = await post(app);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'pb_customer_listing_failed' });
  });

  it('(d) flags a local active row with NULL stripe_subscription_id', async () => {
    const app = await buildApp({
      stripe: makeStripe({ [CUSTOMER]: [] }),
      pool: makePool([CUSTOMER], {
        [CUSTOMER]: [{ stripe_subscription_id: null, status: 'active', tenant_id: 'tenant-1' }],
      }),
      pbClient: makePb(null).client,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ localActiveMissingSubId: 1 });
  });

  it('does NOT probe PB per customer — a local-only (superseded) customer produces no pointer check and no PB call', async () => {
    const pb = makePb(null); // empty PB listing: customer is local-only
    const app = await buildApp({
      stripe: makeStripe({ [CUSTOMER]: [makeStripeSub('sub_dead_old', 'canceled')] }),
      pool: makePool([CUSTOMER], {
        [CUSTOMER]: [{ stripe_subscription_id: 'sub_dead_old', status: 'canceled', tenant_id: 'tenant-1' }],
      }),
      pbClient: pb.client,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ customersChecked: 1, pointerMismatch: 0 });
    // The daily orphan-404 noise class: getControlsStatus must never fire.
    expect(pb.getControlsStatus).not.toHaveBeenCalled();
  });

  it('continues past a customer whose Stripe lookup throws', async () => {
    const stripe = {
      subscriptions: {
        list: mockFn().mockImplementation((params: { customer: string }) => ({
          async *[Symbol.asyncIterator]() {
            if (params.customer === 'cus_boom') throw new Error('stripe down');
            yield makeStripeSub('sub_ok', 'active');
          },
        })),
      },
    } as unknown as Stripe;
    const app = await buildApp({
      stripe,
      pool: makePool(['cus_boom', CUSTOMER], {
        [CUSTOMER]: [{ stripe_subscription_id: 'sub_ok', status: 'active', tenant_id: 'tenant-1' }],
      }),
      pbClient: makePb('sub_ok').client,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ customersChecked: 1, customersFailed: 1 });
  });
});
