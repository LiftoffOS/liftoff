// Dev-only test-subscription refresh job — re-provisions test-mode subs
// approaching Stripe's 90-day retention auto-cancel through the normal
// replaceSubscriptionForTenant path.
//
// Behavior verified:
//   - Hard-gated: refuses to act when isTestMode is false (live key).
//   - Refreshes a tenant whose newest active sub is older than 85 days,
//     rebuilding ProvisionOpts from the sub's provisioning metadata.
//   - Skips young subs, skips (with a log, never silently) subs whose
//     metadata cannot be rebuilt, and counts unattributed subs.
//   - One replace call per tenant even when the tenant has several subs.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import type Stripe from 'stripe';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const mockReplace = mockFn().mockResolvedValue({ alreadyExists: false, stripeSubscriptionId: 'sub_new' });
jest.mock('../../routes/subscription-replace.js', () => ({
  replaceSubscriptionForTenant: mockReplace,
}));

import { registerTestSubscriptionRefreshRouter, provisionOptsFromSubscription, REFRESH_AGE_DAYS } from '../test-subscription-refresh.js';
import type { PlatformBackendClient } from '../../infrastructure/platform-backend-client.js';

const TOKEN = 'test-billing-service-token';
const NOW_S = Math.floor(Date.now() / 1000);
const OLD_CREATED = NOW_S - (REFRESH_AGE_DAYS + 1) * 24 * 3600;
const YOUNG_CREATED = NOW_S - 10 * 24 * 3600;

function makeSub(overrides: {
  id: string;
  created: number;
  tenantId?: string | null;
  metadata?: Record<string, string>;
}): Stripe.Subscription {
  return {
    id: overrides.id,
    object: 'subscription',
    created: overrides.created,
    customer: 'cus_test_refresh',
    status: 'active',
    metadata: {
      ...(overrides.tenantId ? { tenant_id: overrides.tenantId } : {}),
      plan_id: 'growth',
      plan_type: 'growth',
      included_ous: '1000',
      precommit_extra_ous: '0',
      committed_ous: '1000',
      billing_period: 'monthly',
      provisioning_source: 'self_serve',
      ...(overrides.metadata ?? {}),
    },
    items: { data: [{ price: { id: 'price_base' }, quantity: 1 }, { price: { id: 'price_ou_meter' } }] },
  } as unknown as Stripe.Subscription;
}

// Async-iterable Stripe list mock (the handler uses `for await`).
function makeStripe(subs: Stripe.Subscription[]): Stripe {
  return {
    subscriptions: {
      list: mockFn().mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          for (const s of subs) yield s;
        },
      })),
    },
  } as unknown as Stripe;
}

async function buildApp(args: { stripe: Stripe; isTestMode: boolean }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerTestSubscriptionRefreshRouter(app, {
    stripe: args.stripe,
    pbClient: {} as PlatformBackendClient,
    billingServiceToken: TOKEN,
    isTestMode: args.isTestMode,
  });
  await app.ready();
  return app;
}

function post(app: FastifyInstance, token: string | null = TOKEN) {
  return app.inject({
    method: 'POST',
    url: '/api/internal/jobs/test-subscription-refresh',
    ...(token ? { headers: { 'x-service-auth': token } } : {}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReplace.mockResolvedValue({ alreadyExists: false, stripeSubscriptionId: 'sub_new' });
});

describe('POST /api/internal/jobs/test-subscription-refresh', () => {
  it('rejects without the service token', async () => {
    const app = await buildApp({ stripe: makeStripe([]), isTestMode: true });
    const res = await post(app, null);
    expect(res.statusCode).toBe(401);
  });

  it('refuses to act in live mode — never lists or replaces', async () => {
    const stripe = makeStripe([makeSub({ id: 'sub_old', created: OLD_CREATED, tenantId: 't1' })]);
    const app = await buildApp({ stripe, isTestMode: false });
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ skipped: 'live_mode' });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((stripe.subscriptions.list as any)).not.toHaveBeenCalled();
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('re-provisions a tenant whose newest active sub is past the refresh age, via the normal replace path', async () => {
    const app = await buildApp({
      stripe: makeStripe([makeSub({ id: 'sub_old', created: OLD_CREATED, tenantId: 't1' })]),
      isTestMode: true,
    });
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ refreshed: 1, failed: 0 });
    expect(mockReplace).toHaveBeenCalledTimes(1);
    const [opts] = mockReplace.mock.calls[0];
    expect(opts).toMatchObject({
      tenantId: 't1',
      stripeCustomerId: 'cus_test_refresh',
      planId: 'growth',
      includedOus: 1000,
      precommitExtraOus: 0,
      billingPeriod: 'monthly',
      provisioningSource: 'self_serve',
    });
    // Item shape: licensed price keeps its quantity, metered price omits it.
    expect(opts.priceItems).toEqual([
      { price: 'price_base', quantity: 1 },
      { price: 'price_ou_meter' },
    ]);
  });

  it('skips young subs and does not call replace for them', async () => {
    const app = await buildApp({
      stripe: makeStripe([makeSub({ id: 'sub_young', created: YOUNG_CREATED, tenantId: 't1' })]),
      isTestMode: true,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ refreshed: 0, skipped: 1 });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does NOT refresh a tenant whose newest sub is young, even when an older duplicate exists', async () => {
    const app = await buildApp({
      stripe: makeStripe([
        makeSub({ id: 'sub_old_dup', created: OLD_CREATED, tenantId: 't1' }),
        makeSub({ id: 'sub_fresh', created: YOUNG_CREATED, tenantId: 't1' }),
      ]),
      isTestMode: true,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ refreshed: 0, skipped: 1 });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('counts unattributed subs (no metadata.tenant_id) without failing the run', async () => {
    const app = await buildApp({
      stripe: makeStripe([
        makeSub({ id: 'sub_unattributed', created: OLD_CREATED, tenantId: null }),
        makeSub({ id: 'sub_ok', created: OLD_CREATED, tenantId: 't2' }),
      ]),
      isTestMode: true,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ refreshed: 1, unattributed: 1 });
  });

  it('continues past a failing tenant and reports it in `failed`', async () => {
    mockReplace
      .mockRejectedValueOnce(new Error('stripe exploded'))
      .mockResolvedValueOnce({ alreadyExists: false, stripeSubscriptionId: 'sub_new2' });
    const app = await buildApp({
      stripe: makeStripe([
        makeSub({ id: 'sub_a', created: OLD_CREATED, tenantId: 'tA' }),
        makeSub({ id: 'sub_b', created: OLD_CREATED, tenantId: 'tB' }),
      ]),
      isTestMode: true,
    });
    const res = await post(app);
    expect(res.json()).toMatchObject({ refreshed: 1, failed: 1 });
    expect(mockReplace).toHaveBeenCalledTimes(2);
  });
});

describe('provisionOptsFromSubscription', () => {
  it('skips (with reason) when plan cannot be resolved', async () => {
    const sub = makeSub({ id: 'sub_x', created: OLD_CREATED, tenantId: 't1', metadata: { plan_id: '', plan_type: '' } });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (sub.metadata as any).plan_id = 'nonsense';
    (sub.metadata as any).plan_type = 'nonsense';
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const out = provisionOptsFromSubscription(sub);
    expect('skipReason' in out && out.skipReason).toMatch(/unresolvable_plan_id/);
  });

  it('resolves enterprise plan from billing_tier when plan_id/plan_type are absent (admin-provisioned May-era subs)', async () => {
    const sub = makeSub({ id: 'sub_ent', created: OLD_CREATED, tenantId: 't1' });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    delete (sub.metadata as any).plan_id;
    delete (sub.metadata as any).plan_type;
    (sub.metadata as any).billing_tier = 'enterprise';
    (sub.metadata as any).committed_ous = '100000000';
    delete (sub.metadata as any).included_ous;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const out = provisionOptsFromSubscription(sub);
    expect('opts' in out).toBe(true);
    if ('opts' in out) {
      expect(out.opts.planId).toBe('enterprise');
      expect(out.opts.includedOus).toBe(100000000);
    }
  });
});
