// Tests for provisionForTenant — PR 4 / Gap C (cleanOrphanState pre-step).
//
// Unit-style mocks per Q4 — no real Postgres, no real Stripe.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type Stripe from 'stripe';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const TENANT_ID = 'tenant-test-pr4';
const CANONICAL_CUSTOMER = 'cus_canonical';
const ORPHAN_CUSTOMER_A = 'cus_orphan_A';
const ORPHAN_CUSTOMER_B = 'cus_orphan_B';

// Mock withBillingTenant: invoke the callback directly with our mock client.
const mockClientQuery = mockFn();
const mockClient = { query: mockClientQuery };
jest.mock('../infrastructure/database.js', () => ({
  withBillingTenant: jest.fn((_tenantId: string, fn: (client: unknown) => Promise<unknown>) =>
    fn(mockClient),
  ),
}));

// Mock upsertSubscription + makeEnvelope (the real makeEnvelope is fine, but
// we have to re-export it so jest.mock can intercept). makeEnvelope is a pure
// function that builds an EventEnvelope object; using the real one keeps the
// outbox-event assertion realistic.
const mockUpsertSubscription = mockFn().mockResolvedValue(undefined);
jest.mock('../consumers/stripe-event-processor.js', () => {
  const actual =
    jest.requireActual<typeof import('../consumers/stripe-event-processor.js')>(
      '../consumers/stripe-event-processor.js',
    );
  return {
    ...actual,
    upsertSubscription: mockUpsertSubscription,
  };
});

// Mock enqueueOutboxEvent so we can introspect the audit event.
const mockEnqueueOutboxEvent = mockFn().mockResolvedValue(undefined);
jest.mock('@liftoffos/outbox', () => {
  const actual = jest.requireActual<typeof import('@liftoffos/outbox')>('@liftoffos/outbox');
  return {
    ...actual,
    enqueueOutboxEvent: mockEnqueueOutboxEvent,
  };
});

import { provisionForTenant, type ProvisionOpts, type ProvisionDeps } from './provision.js';

// Stripe sub fixture helper.
function makeStripeSub(
  id: string,
  customer: string,
  status: Stripe.Subscription.Status = 'active',
  metadata: Record<string, string> = { tenant_id: TENANT_ID },
): Stripe.Subscription {
  return { id, customer, status, metadata } as unknown as Stripe.Subscription;
}

function baseOpts(overrides: Partial<ProvisionOpts> = {}): ProvisionOpts {
  return {
    tenantId: TENANT_ID,
    stripeCustomerId: CANONICAL_CUSTOMER,
    planId: 'enterprise',
    includedOus: 1_000_000,
    precommitExtraOus: 0,
    billingPeriod: 'monthly',
    provisioningSource: 'admin_enterprise',
    priceItems: [{ price: 'price_test' }],
    ...overrides,
  };
}

interface MockDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stripe: { subscriptions: { search: any; cancel: any; list: any; create: any; retrieve: any } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pbClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: { info: any; warn: any };
}

function makeDeps(): MockDeps {
  return {
    stripe: {
      subscriptions: {
        search: mockFn().mockResolvedValue({ data: [], has_more: false }),
        cancel: mockFn().mockResolvedValue(undefined),
        list: mockFn().mockResolvedValue({ data: [] }),
        create: mockFn().mockResolvedValue(makeStripeSub('sub_new', CANONICAL_CUSTOMER)),
        // Default existing sub has no provisioning_source metadata → Layer 1's
        // auto-replace branch falls through to the standard alreadyExists
        // return (the prior contract). Tests that exercise the auto-replace
        // path override this with a sub whose metadata.provisioning_source
        // equals 'auto'.
        retrieve: mockFn().mockResolvedValue({ id: 'sub_existing', metadata: {} }),
      },
    },
    pbClient: {},
    log: { info: mockFn(), warn: mockFn() },
  };
}

// Default in-transaction client behaviour: Layer 1 lookup returns no rows
// (no existing local sub for this tenant). Tests that need other behaviour
// override mockClientQuery directly.
function defaultClientResponses(): void {
  mockClientQuery.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
      return { rows: [] };
    }
    if (typeof sql === 'string' && sql.includes('FROM subscriptions') && sql.includes('SELECT stripe_subscription_id')) {
      return { rows: [] }; // Layer 1: no local sub
    }
    if (typeof sql === 'string' && sql.includes('UPDATE subscriptions')) {
      return { rows: [], rowCount: 0 }; // cleanup UPDATE: no rows to flip by default
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  defaultClientResponses();
});

describe('provisionForTenant — PR 4 cleanOrphanState', () => {
  it('without cleanOrphanState preserves Layer-1 short-circuit on stale row (self-serve safety regression)', async () => {
    // Local sub exists → Layer 1 returns alreadyExists = true.
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('FROM subscriptions')) {
        return { rows: [{ stripe_subscription_id: 'sub_existing' }] };
      }
      return { rows: [], rowCount: 0 };
    });
    const deps = makeDeps();

    const result = await provisionForTenant(baseOpts({ provisioningSource: 'self_serve' }), deps as unknown as ProvisionDeps);

    expect(result).toEqual({ alreadyExists: true, stripeSubscriptionId: 'sub_existing' });
    // Cleanup pre-step MUST NOT have fired.
    expect(deps.stripe.subscriptions.search).not.toHaveBeenCalled();
    expect(deps.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(mockEnqueueOutboxEvent).not.toHaveBeenCalled();
  });

  it('with cleanOrphanState=true cancels orphan Stripe subs on different customers', async () => {
    const deps = makeDeps();
    deps.stripe.subscriptions.search.mockResolvedValueOnce({
      data: [
        makeStripeSub('sub_orphan_1', ORPHAN_CUSTOMER_A),
        makeStripeSub('sub_orphan_2', ORPHAN_CUSTOMER_B),
      ],
      has_more: false,
    });

    await provisionForTenant(baseOpts({ cleanOrphanState: true }), deps as unknown as ProvisionDeps);

    // Both orphans cancelled with prorate:false.
    expect(deps.stripe.subscriptions.cancel).toHaveBeenCalledTimes(2);
    expect(deps.stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_orphan_1', { prorate: false });
    expect(deps.stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_orphan_2', { prorate: false });
    // Per-cancel structured log fired.
    expect(deps.log.info).toHaveBeenCalledWith(
      'provision.clean_orphan.stripe_canceled',
      expect.objectContaining({ tenantId: TENANT_ID, subscriptionId: 'sub_orphan_1', customer: ORPHAN_CUSTOMER_A }),
    );
    expect(deps.log.info).toHaveBeenCalledWith(
      'provision.clean_orphan.stripe_canceled',
      expect.objectContaining({ tenantId: TENANT_ID, subscriptionId: 'sub_orphan_2', customer: ORPHAN_CUSTOMER_B }),
    );
  });

  it('with cleanOrphanState=true cancels local stale rows then creates new sub', async () => {
    // Cleanup UPDATE returns 1 row id; Layer 1 SELECT (after cleanup) returns
    // no rows so we fall through to Layer 3 create.
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('UPDATE subscriptions')) {
        return { rows: [{ stripe_subscription_id: 'sub_old_local' }], rowCount: 1 };
      }
      if (typeof sql === 'string' && sql.includes('FROM subscriptions')) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });
    const deps = makeDeps();

    const result = await provisionForTenant(
      baseOpts({ cleanOrphanState: true }),
      deps as unknown as ProvisionDeps,
    );

    expect(result.alreadyExists).toBe(false);
    expect(result.stripeSubscriptionId).toBe('sub_new');
    expect(deps.log.info).toHaveBeenCalledWith(
      'provision.clean_orphan.local_canceled',
      expect.objectContaining({ tenantId: TENANT_ID, stripeSubscriptionIds: ['sub_old_local'] }),
    );
    // New Stripe sub created after cleanup.
    expect(deps.stripe.subscriptions.create).toHaveBeenCalledTimes(1);
  });

  it('with cleanOrphanState=true is a no-op when state is already clean', async () => {
    const deps = makeDeps();
    // Empty search, empty local UPDATE.
    deps.stripe.subscriptions.search.mockResolvedValueOnce({ data: [], has_more: false });

    await provisionForTenant(baseOpts({ cleanOrphanState: true }), deps as unknown as ProvisionDeps);

    expect(deps.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    // The outbox event still fires — it's the audit trail — but with empty arrays.
    expect(mockEnqueueOutboxEvent).toHaveBeenCalledTimes(1);
    const env = mockEnqueueOutboxEvent.mock.calls[0][1] as {
      eventType: string;
      payload: { orphanStripeSubsCancelled: string[]; localRowsCancelled: string[] };
    };
    expect(env.eventType).toBe('billing.provision.orphan_state_cleaned');
    expect(env.payload.orphanStripeSubsCancelled).toEqual([]);
    expect(env.payload.localRowsCancelled).toEqual([]);
    // Plan-literal: provision.clean_orphan.local_canceled is logged
    // unconditionally — empty array on the no-op path proves the cleanup
    // actually ran. (P4-B fix.)
    expect(deps.log.info).toHaveBeenCalledWith(
      'provision.clean_orphan.local_canceled',
      expect.objectContaining({ tenantId: TENANT_ID, stripeSubscriptionIds: [] }),
    );
    // Pagination warning must NOT fire on the empty path.
    expect(deps.log.warn).not.toHaveBeenCalledWith(
      'provision.clean_orphan.has_more_paginated',
      expect.anything(),
    );
  });

  it('with cleanOrphanState=true does NOT cancel matching-customer subs (only orphans)', async () => {
    const deps = makeDeps();
    deps.stripe.subscriptions.search.mockResolvedValueOnce({
      data: [
        makeStripeSub('sub_canonical', CANONICAL_CUSTOMER), // same customer — NOT an orphan
        makeStripeSub('sub_orphan', ORPHAN_CUSTOMER_A),     // different customer — orphan
      ],
      has_more: false,
    });

    await provisionForTenant(baseOpts({ cleanOrphanState: true }), deps as unknown as ProvisionDeps);

    expect(deps.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(deps.stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_orphan', { prorate: false });
    expect(deps.stripe.subscriptions.cancel).not.toHaveBeenCalledWith('sub_canonical', expect.anything());
  });

  it('with cleanOrphanState=true emits billing.provision.orphan_state_cleaned outbox event', async () => {
    const deps = makeDeps();
    deps.stripe.subscriptions.search.mockResolvedValueOnce({
      data: [makeStripeSub('sub_orphan_1', ORPHAN_CUSTOMER_A)],
      has_more: false,
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('UPDATE subscriptions')) {
        return { rows: [{ stripe_subscription_id: 'sub_old_local' }], rowCount: 1 };
      }
      if (typeof sql === 'string' && sql.includes('FROM subscriptions')) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });

    await provisionForTenant(baseOpts({ cleanOrphanState: true }), deps as unknown as ProvisionDeps);

    expect(mockEnqueueOutboxEvent).toHaveBeenCalledTimes(1);
    const [, envelope] = mockEnqueueOutboxEvent.mock.calls[0];
    const env = envelope as {
      eventType: string;
      tenantId: string;
      payload: {
        tenantId: string;
        stripeCustomerIdIntended: string;
        orphanStripeSubsCancelled: string[];
        localRowsCancelled: string[];
      };
    };
    expect(env.eventType).toBe('billing.provision.orphan_state_cleaned');
    expect(env.tenantId).toBe(TENANT_ID);
    expect(env.payload).toEqual({
      tenantId: TENANT_ID,
      stripeCustomerIdIntended: CANONICAL_CUSTOMER,
      orphanStripeSubsCancelled: ['sub_orphan_1'],
      localRowsCancelled: ['sub_old_local'],
    });
  });

  it('with cleanOrphanState=true paginates through ALL orphan subs when has_more=true (P4-A)', async () => {
    const deps = makeDeps();
    // First page: 100 orphans + has_more=true + next_page cursor.
    deps.stripe.subscriptions.search.mockResolvedValueOnce({
      data: Array.from({ length: 100 }, (_, i) => makeStripeSub(`sub_orphan_page1_${i}`, ORPHAN_CUSTOMER_A)),
      has_more: true,
      next_page: 'cursor_page2',
    });
    // Second page: 50 more orphans, has_more=false.
    deps.stripe.subscriptions.search.mockResolvedValueOnce({
      data: Array.from({ length: 50 }, (_, i) => makeStripeSub(`sub_orphan_page2_${i}`, ORPHAN_CUSTOMER_B)),
      has_more: false,
      next_page: null,
    });

    await provisionForTenant(baseOpts({ cleanOrphanState: true }), deps as unknown as ProvisionDeps);

    // BOTH active pages were fetched, then one trialing page (which falls
    // through to the default empty `mockResolvedValue` set in makeDeps).
    // Total: 2 active + 1 trialing = 3 calls.
    expect(deps.stripe.subscriptions.search).toHaveBeenCalledTimes(3);
    // Second call passed the cursor returned by the first response.
    expect(deps.stripe.subscriptions.search.mock.calls[1][0]).toEqual(
      expect.objectContaining({ page: 'cursor_page2' }),
    );
    // All 150 orphans were cancelled.
    expect(deps.stripe.subscriptions.cancel).toHaveBeenCalledTimes(150);
    // Pagination warning fired with the full processed count.
    expect(deps.log.warn).toHaveBeenCalledWith(
      'provision.clean_orphan.has_more_paginated',
      expect.objectContaining({ tenantId: TENANT_ID, totalProcessed: 150 }),
    );
  });

  it('with cleanOrphanState=true does NOT log has_more_paginated when first page is the only page (P4-A)', async () => {
    const deps = makeDeps();
    deps.stripe.subscriptions.search.mockResolvedValueOnce({
      data: [makeStripeSub('sub_orphan', ORPHAN_CUSTOMER_A)],
      has_more: false,
      next_page: null,
    });

    await provisionForTenant(baseOpts({ cleanOrphanState: true }), deps as unknown as ProvisionDeps);

    // 1 active call + 1 trialing call (trialing falls through to the default
    // empty mockResolvedValue in makeDeps) = 2 calls total.
    expect(deps.stripe.subscriptions.search).toHaveBeenCalledTimes(2);
    expect(deps.log.warn).not.toHaveBeenCalledWith(
      'provision.clean_orphan.has_more_paginated',
      expect.anything(),
    );
  });

  it('runs cleanup BEFORE Layer 1 — call-ORDER asserted via mock.invocationCallOrder (P4-C)', async () => {
    // Track every invocation so we can assert relative ORDER, not just
    // outcome. Layer 1's SELECT must fire AFTER the cleanup UPDATE.
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('UPDATE subscriptions')) {
        return { rows: [{ stripe_subscription_id: 'sub_stale_local' }], rowCount: 1 };
      }
      if (typeof sql === 'string' && sql.includes('FROM subscriptions')) {
        return { rows: [] }; // post-cleanup view
      }
      return { rows: [], rowCount: 0 };
    });
    const deps = makeDeps();

    const result = await provisionForTenant(
      baseOpts({ cleanOrphanState: true }),
      deps as unknown as ProvisionDeps,
    );

    expect(result.alreadyExists).toBe(false);
    expect(deps.stripe.subscriptions.create).toHaveBeenCalledTimes(1);

    // ── Call-order assertion ────────────────────────────────────────────
    // Find the global invocationCallOrder for the cleanup UPDATE and the
    // Layer-1 SELECT. The UPDATE must precede the SELECT.
    const calls = mockClientQuery.mock.calls as unknown as Array<[string, unknown[]?]>;
    const order = mockClientQuery.mock.invocationCallOrder as number[];

    const updateIdx = calls.findIndex(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE subscriptions'),
    );
    const selectIdx = calls.findIndex(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('SELECT stripe_subscription_id') &&
        c[0].includes('FROM subscriptions'),
    );
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(order[updateIdx]).toBeLessThan(order[selectIdx]);
  });
});

describe('provisionForTenant — auto-provisioned sub replacement', () => {
  // Regression coverage for the onboarding 409 bug. PB's TenantService.activate
  // synchronously calls billing's auto-provision on every tenant activation, so
  // /subscribe during /onboarding would always observe an existing sub via
  // Layer 1 and return 409 — making the promo-code path impossible to redeem.
  // Layer 1 now distinguishes auto from self_serve/admin_enterprise existing
  // subs: an auto sub is cancelled in place so the self-serve provision can
  // proceed.

  it('cancels an existing auto-provisioned sub and proceeds to create when self_serve provision is requested', async () => {
    // Layer 1 SELECT first returns the existing auto-provisioned row; after
    // the UPDATE (which Layer 1 issues to flip status to canceled), subsequent
    // Layer 1-shaped reads return empty so the create path proceeds cleanly.
    let layer1Calls = 0;
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('SELECT stripe_subscription_id') && sql.includes('FROM subscriptions')) {
        if (layer1Calls++ === 0) {
          return { rows: [{ stripe_subscription_id: 'sub_auto_existing' }] };
        }
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('UPDATE subscriptions')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const deps = makeDeps();
    deps.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      makeStripeSub('sub_auto_existing', CANONICAL_CUSTOMER, 'active', {
        tenant_id: TENANT_ID,
        provisioning_source: 'auto',
      }),
    );

    const result = await provisionForTenant(
      baseOpts({ provisioningSource: 'self_serve', planId: 'core' }),
      deps as unknown as ProvisionDeps,
    );

    // The auto sub was cancelled on Stripe.
    expect(deps.stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_auto_existing', {
      invoice_now: false,
      prorate: false,
    });
    // Layer 3 created a new sub — alreadyExists is false.
    expect(deps.stripe.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(result.alreadyExists).toBe(false);
    // Structured log emitted so the swap is observable in production.
    expect(deps.log.info).toHaveBeenCalledWith(
      'subscription.auto_replaced_on_subscribe',
      expect.objectContaining({ tenantId: TENANT_ID, canceledSubId: 'sub_auto_existing' }),
    );
  });

  it('still returns alreadyExists when the existing sub is self_serve (genuine conflict)', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('FROM subscriptions')) {
        return { rows: [{ stripe_subscription_id: 'sub_user_active' }] };
      }
      return { rows: [], rowCount: 0 };
    });

    const deps = makeDeps();
    deps.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      makeStripeSub('sub_user_active', CANONICAL_CUSTOMER, 'active', {
        tenant_id: TENANT_ID,
        provisioning_source: 'self_serve',
      }),
    );

    const result = await provisionForTenant(
      baseOpts({ provisioningSource: 'self_serve' }),
      deps as unknown as ProvisionDeps,
    );

    expect(result).toEqual({ alreadyExists: true, stripeSubscriptionId: 'sub_user_active' });
    expect(deps.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(deps.stripe.subscriptions.create).not.toHaveBeenCalled();
  });

  it('does not auto-replace when provisioningSource is auto (the auto-provision call itself must short-circuit)', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('FROM subscriptions')) {
        return { rows: [{ stripe_subscription_id: 'sub_auto_existing' }] };
      }
      return { rows: [], rowCount: 0 };
    });

    const deps = makeDeps();
    // Even though metadata says auto, the caller is also auto — we must NOT
    // cancel-and-recreate (that would loop the tenant-activation auto-provision
    // on every retry). Idempotent short-circuit is the correct semantic.
    deps.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      makeStripeSub('sub_auto_existing', CANONICAL_CUSTOMER, 'active', {
        tenant_id: TENANT_ID,
        provisioning_source: 'auto',
      }),
    );

    const result = await provisionForTenant(
      baseOpts({ provisioningSource: 'auto' }),
      deps as unknown as ProvisionDeps,
    );

    expect(result).toEqual({ alreadyExists: true, stripeSubscriptionId: 'sub_auto_existing' });
    expect(deps.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(deps.stripe.subscriptions.create).not.toHaveBeenCalled();
  });
});
