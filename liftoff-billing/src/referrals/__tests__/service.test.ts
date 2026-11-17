// The referral programme's money half.
//
// These lock the rules that decide whether $20 moves, and every one of them is
// a rule somebody could plausibly "simplify" into being wrong:
//
//   - the full-price test, because a promo code is the cheapest path to $20 of
//     credit and no hold period closes that;
//   - the first-invoice test, because a referral earns once and not on every
//     renewal for the life of the subscription;
//   - the expiry floor, because Liftoff sells annual billing and a bare 90 day
//     timer would expire an annual subscriber's credit before it could ever be
//     applied;
//   - nearest-expiry-first spending, because each grant ages separately;
//   - and the absorb rule, because spent credit that is later disputed must
//     never produce a negative balance.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fn = (impl?: any): any => (jest.fn as any)(impl);
/* eslint-enable @typescript-eslint/no-explicit-any */

// withBillingTenant is the tenant scope every write goes through, so these
// tests stand in for it and record WHICH tenant each statement ran under. That
// is not incidental: the earning write has to run under the REFERRER's context
// rather than the referred workspace whose invoice triggered it, and nothing
// else would catch the two being swapped.
const mockWithBillingTenant = fn();
// The second door. Cross-tenant work names itself now, so a test can assert
// WHICH lane a query took instead of inferring it from a raw pool stub.
const mockWithCrossTenant = fn();

/** Stubs the cross-tenant door to yield `rows`. Replaces the old raw-pool stub:
 *  the service no longer accepts a Pool, so there is nothing else to stub. */
function crossTenantReturning(rows: Row[]): void {
  mockWithCrossTenant.mockImplementation(async (_reason: unknown, cb: unknown) =>
    (cb as (c: unknown) => unknown)({ query: fn(async () => ({ rows })) }),
  );
}

/**
 * Every tenant a scope was opened for, in order.
 *
 * The brand introduced in @liftoffos/database 0.1.6 proves a connection IS
 * scoped. It cannot prove it is scoped to the RIGHT tenant — a swap type-checks
 * perfectly. This list is the only thing that can, which makes it the more
 * valuable of the two guards, and it was previously asserted in exactly two
 * places out of thirteen scope openings in this service.
 */
const scopedTenants: string[] = [];

/**
 * Asserts the complete set of tenants scoped during a call, not merely that one
 * of them appeared.
 *
 * `toHaveBeenCalledWith(REFERRER, ...)` passes if the referrer was scoped at any
 * point, and stays green if the code ALSO opened a scope for the referred
 * workspace and wrote the credit there. That is precisely the swap this file's
 * header says nothing else would catch, so it has to be an exact set.
 */
function expectScopedExactly(...tenants: string[]): void {
  expect([...new Set(scopedTenants)].sort()).toEqual([...new Set(tenants)].sort());
}

jest.mock('../../infrastructure/database.js', () => ({
  withBillingTenant: (tenantId: string, cb: (client: unknown) => unknown) => {
    scopedTenants.push(tenantId);
    return mockWithBillingTenant(tenantId, cb);
  },
  withCrossTenant: (reason: string, cb: (client: unknown) => unknown) =>
    mockWithCrossTenant(reason, cb),
  getPool: fn(),
  getOutboxPool: fn(),
  closePool: fn(),
}));

/** The module under test, imported inside each test so jest's mocking is in
 *  scope — the pattern the rest of this repo's consumer tests use. */
async function load() {
  return import('../service.js');
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const REFERRER = '22222222-2222-4222-8222-222222222222';
const REFERRAL_ID = '55555555-5555-4555-8555-555555555555';

type Row = Record<string, unknown>;

/** A client whose queries answer from a queue, in call order. */
function makeClient(results: Row[][]) {
  let i = 0;
  return {
    query: fn(async () => {
      const rows = results[i] ?? [];
      i += 1;
      return { rows, rowCount: rows.length };
    }),
  };
}

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_1',
    customer: 'cus_referrer',
    currency: 'usd',
    amount_due: 2000,
    amount_paid: 2000,
    starting_balance: 0,
    total_discount_amounts: [],
    status_transitions: { paid_at: 1_700_000_000 },
    ...overrides,
  };
}

function makeLog() {
  return { info: fn(), warn: fn(), error: fn() };
}

function makePb(overrides: Record<string, unknown> = {}) {
  return {
    referralLookup: fn(async () => ({
      referralId: REFERRAL_ID,
      referrerTenantId: REFERRER,
      referrerAccountId: 'acct_referrer',
      referrerStripeCustomerId: 'cus_referrer',
      referredAccountId: 'acct_referred',
      referredStripeCustomerId: 'cus_referred',
      signedUpAt: '2026-01-01T00:00:00.000Z',
      subscribedAt: null,
      status: 'signed_up',
      ineligibleReason: null,
    })),
    referralSubscribed: fn(async () => undefined),
    referralIneligible: fn(async () => undefined),
    referralBonus: fn(async () => ({ granted: true })),
    ...overrides,
  };
}

/** Two customers whose cards do not match. */
function distinctCards() {
  let call = 0;
  return {
    customers: {
      listPaymentMethods: fn(async () => {
        call += 1;
        return { data: [{ card: { fingerprint: call === 1 ? 'fp_a' : 'fp_b' } }] };
      }),
    },
  };
}

beforeEach(() => {
  scopedTenants.length = 0;
  jest.clearAllMocks();
  // Default: the tenant-scoped callback runs against a client that answers
  // nothing, and returns whatever the callback returns.
  mockWithBillingTenant.mockImplementation(
    async (_tenantId: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)(makeClient([])),
  );
});

// ── Full price ───────────────────────────────────────────────────────────────

describe('isFullPricedInvoice', () => {
  it('accepts an invoice paid at list', async () => {
    const { isFullPricedInvoice } = await load();
    expect(isFullPricedInvoice(makeInvoice() as never)).toBe(true);
  });

  it('rejects one a promo code reduced', async () => {
    const { isFullPricedInvoice } = await load();
    expect(
      isFullPricedInvoice(makeInvoice({ total_discount_amounts: [{ amount: 2000 }] }) as never),
    ).toBe(false);
  });

  it('rejects one an existing customer balance paid down', async () => {
    // Including referral credit itself, so a chain cannot bootstrap off its own
    // rewards.
    const { isFullPricedInvoice } = await load();
    expect(isFullPricedInvoice(makeInvoice({ starting_balance: -2000 }) as never)).toBe(false);
  });

  it('rejects one where nothing was actually collected', async () => {
    const { isFullPricedInvoice } = await load();
    expect(isFullPricedInvoice(makeInvoice({ amount_paid: 0 }) as never)).toBe(false);
  });
});

// ── Earning ──────────────────────────────────────────────────────────────────

describe('earning on the referred workspace first paid invoice', () => {
  it('writes a pending credit and grants the referee bonus, together', async () => {
    const { ReferralCreditService, REFEREE_BONUS_OUS } = await load();
    const pb = makePb();
    mockWithBillingTenant.mockImplementation(
      async (_t: unknown, cb: unknown) =>
        (cb as (c: unknown) => unknown)(makeClient([[{ ok: true }]])),
    );

    const svc = new ReferralCreditService(distinctCards() as never, pb as never, makeLog(),
    );
    // No other subscription invoice exists → this is the first.
    await svc.onReferredInvoicePaid(
      makeClient([[{ count: '0' }]]) as never, TENANT, makeInvoice() as never,
    );

    expect(pb.referralSubscribed).toHaveBeenCalled();
    expect(pb.referralIneligible).not.toHaveBeenCalled();
    // The credit is written under the REFERRER's context, not the referred
    // workspace's — the credit belongs to the referrer. Asserted as the ONLY
    // scope opened: the previous `toHaveBeenCalledWith` form stayed green if the
    // code also scoped the referred workspace and wrote the credit there, which
    // is the swap this file's header claims nothing else would catch.
    expectScopedExactly(REFERRER);
    expect(pb.referralBonus).toHaveBeenCalledWith('cus_referred', {
      referralId: REFERRAL_ID,
      bonusOus: REFEREE_BONUS_OUS,
    });
  });

  it('earns nothing on a renewal, only on the first invoice', async () => {
    const { ReferralCreditService } = await load();
    const pb = makePb();
    const svc = new ReferralCreditService(distinctCards() as never, pb as never, makeLog(),
    );

    // A prior subscription invoice exists.
    await svc.onReferredInvoicePaid(
      makeClient([[{ count: '3' }]]) as never, TENANT, makeInvoice() as never,
    );

    expect(pb.referralSubscribed).not.toHaveBeenCalled();
    expect(pb.referralBonus).not.toHaveBeenCalled();
  });

  it('records the conversion but disqualifies a discounted first invoice', async () => {
    const { ReferralCreditService } = await load();
    const pb = makePb();
    const svc = new ReferralCreditService(distinctCards() as never, pb as never, makeLog(),
    );

    await svc.onReferredInvoicePaid(
      makeClient([[{ count: '0' }]]) as never,
      TENANT,
      makeInvoice({ total_discount_amounts: [{ amount: 1500 }] }) as never,
    );

    // Subscribed is still recorded — they DID subscribe; only the credit is
    // withheld, and with a reason the referrer can read.
    expect(pb.referralSubscribed).toHaveBeenCalled();
    expect(pb.referralIneligible).toHaveBeenCalledWith(REFERRAL_ID, 'discounted_signup');
    expect(pb.referralBonus).not.toHaveBeenCalled();
  });

  it('disqualifies when both sides are funded by the same card', async () => {
    const { ReferralCreditService } = await load();
    const pb = makePb();
    const sameCard = {
      customers: {
        listPaymentMethods: fn(async () => ({ data: [{ card: { fingerprint: 'fp_same' } }] })),
      },
    };
    const svc = new ReferralCreditService(sameCard as never, pb as never, makeLog());

    await svc.onReferredInvoicePaid(
      makeClient([[{ count: '0' }]]) as never, TENANT, makeInvoice() as never,
    );

    expect(pb.referralIneligible).toHaveBeenCalledWith(REFERRAL_ID, 'self_referral');
    expect(pb.referralBonus).not.toHaveBeenCalled();
  });

  it('does nothing at all for a workspace nobody referred', async () => {
    const { ReferralCreditService } = await load();
    const pb = makePb({ referralLookup: fn(async () => null) });
    const svc = new ReferralCreditService(distinctCards() as never, pb as never, makeLog(),
    );

    await svc.onReferredInvoicePaid(makeClient([]) as never, TENANT, makeInvoice() as never);

    expect(pb.referralSubscribed).not.toHaveBeenCalled();
  });

  it('leaves a referral already disqualified at binding alone', async () => {
    const { ReferralCreditService } = await load();
    const pb = makePb({
      referralLookup: fn(async () => ({
        referralId: REFERRAL_ID,
        referrerTenantId: REFERRER,
        referrerAccountId: 'acct_referrer',
        referrerStripeCustomerId: 'cus_referrer',
        referredAccountId: 'acct_referred',
        referredStripeCustomerId: 'cus_referred',
        signedUpAt: '2026-01-01T00:00:00.000Z',
        subscribedAt: null,
        status: 'signed_up',
        ineligibleReason: 'existing_account',
      })),
    });
    const svc = new ReferralCreditService(distinctCards() as never, pb as never, makeLog(),
    );

    await svc.onReferredInvoicePaid(makeClient([]) as never, TENANT, makeInvoice() as never);

    expect(pb.referralSubscribed).not.toHaveBeenCalled();
    expect(pb.referralBonus).not.toHaveBeenCalled();
  });

  it('lets a platform-backend failure surface, so Pub/Sub retries', async () => {
    const { ReferralCreditService } = await load();
    const pb = makePb({
      referralLookup: fn(async () => {
        throw new Error('platform-backend unreachable');
      }),
    });
    const svc = new ReferralCreditService(distinctCards() as never, pb as never, makeLog(),
    );

    // Swallowing would lose the referral permanently; every write it makes is
    // idempotent, so a retry is the cheap and correct answer.
    await expect(
      svc.onReferredInvoicePaid(makeClient([]) as never, TENANT, makeInvoice() as never),
    ).rejects.toThrow('platform-backend unreachable');
  });
});

// ── Vesting ──────────────────────────────────────────────────────────────────

describe('vesting', () => {
  const AVAILABLE_AT = new Date('2026-03-01T00:00:00.000Z');
  /** available_at + 90 days. */
  const TIMER_EXPIRY = new Date('2026-05-30T00:00:00.000Z');

  /** The cross-tenant sweep read. Returns the rows the sweep should find. */
  function sweepReturning(pending: Row[]) {
    mockWithCrossTenant.mockImplementation(async (_reason: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)({ query: fn(async () => ({ rows: pending })) }),
    );
  }

  /** Captures the expires_at the vesting UPDATE stamps. */
  function captureStamp(nextInvoice: Row[] = []): { value?: Date } {
    const captured: { value?: Date } = {};
    mockWithBillingTenant.mockImplementation(async (_t: unknown, cb: unknown) => {
      const client = {
        query: fn(async (sql: unknown, params: unknown) => {
          // The expiry floor's `subscriptions` read is tenant-scoped now, so it
          // arrives here rather than on the raw pool.
          if (String(sql).includes('FROM subscriptions')) return { rows: nextInvoice };
          captured.value = (params as unknown[])[1] as Date;
          return { rows: [], rowCount: 1 };
        }),
      };
      return (cb as (c: unknown) => unknown)(client);
    });
    return captured;
  }

  it('stamps the 90 day timer for a monthly subscriber, where the floor never binds', async () => {
    const { ReferralCreditService } = await load();
    sweepReturning([{ id: 'c1', tenant_id: TENANT, available_at: AVAILABLE_AT }]);
    const stamped = captureStamp([{ current_period_end: new Date('2026-03-15T00:00:00.000Z') }]);

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());
    const { vested } = await svc.runVesting();

    expect(vested).toBe(1);
    expect(stamped.value?.toISOString()).toBe(TIMER_EXPIRY.toISOString());
  });

  it('pushes the expiry out to an annual subscriber next invoice', async () => {
    const { ReferralCreditService } = await load();
    const nextInvoice = new Date('2026-12-01T00:00:00.000Z');
    sweepReturning([{ id: 'c1', tenant_id: TENANT, available_at: AVAILABLE_AT }]);
    const stamped = captureStamp([{ current_period_end: nextInvoice }]);

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());
    await svc.runVesting();

    // Without this floor, credit an annual subscriber paid more for up front
    // would expire before their next invoice could ever consume it.
    expect(stamped.value?.toISOString()).toBe(nextInvoice.toISOString());
  });
});

// ── Application ──────────────────────────────────────────────────────────────

describe('applying credit to an invoice', () => {
  /**
   * Drives applyToInvoice against a scripted client, recording the order and
   * parameters of every statement it runs.
   */
  function applyHarness(spendable: Row[], claimedRowCount = 1) {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    mockWithBillingTenant.mockImplementation(async (_t: unknown, cb: unknown) => {
      const client = {
        query: fn(async (sql: unknown, params: unknown) => {
          statements.push({ sql: String(sql), params: (params ?? []) as unknown[] });
          if (String(sql).includes('SELECT')) {
            return { rows: spendable, rowCount: spendable.length };
          }
          if (String(sql).includes('applied_invoice_id = $2')) {
            return { rows: [], rowCount: claimedRowCount };
          }
          return { rows: [], rowCount: 1 };
        }),
      };
      return (cb as (c: unknown) => unknown)(client);
    });
    return statements;
  }

  it('spends nearest expiry first, and never more than the invoice', async () => {
    const { ReferralCreditService, REFERRAL_REWARD_USD } = await load();
    const statements = applyHarness([
      { id: 'c_soon', amount_usd: '20.00' },
      { id: 'c_later', amount_usd: '20.00' },
    ]);
    const stripe = {
      customers: { createBalanceTransaction: fn(async () => ({ id: 'cbtxn_1' })) },
    };

    const svc = new ReferralCreditService(stripe as never, {} as never, makeLog());
    // A $20 invoice can only absorb one $20 grant.
    const { appliedUsd } = await svc.applyToInvoice(
      TENANT, makeInvoice({ amount_due: 2000 }) as never,
    );

    expect(appliedUsd).toBe(REFERRAL_REWARD_USD);
    expect(stripe.customers.createBalanceTransaction).toHaveBeenCalledWith(
      'cus_referrer',
      expect.objectContaining({ amount: -2000 }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('c_soon') }),
    );
    // The nearest-expiry grant is the one spent; the query orders them.
    const claim = statements.find(s => s.sql.includes('applied_invoice_id = $2'));
    expect(claim?.params[0]).toEqual(['c_soon']);
  });

  it('claims the grants BEFORE crediting Stripe', async () => {
    const { ReferralCreditService } = await load();
    const statements = applyHarness([{ id: 'c1', amount_usd: '20.00' }]);
    const order: string[] = [];
    const stripe = {
      customers: {
        createBalanceTransaction: fn(async () => {
          order.push('stripe');
          return { id: 'cbtxn_1' };
        }),
      },
    };

    const svc = new ReferralCreditService(stripe as never, {} as never, makeLog());
    await svc.applyToInvoice(TENANT, makeInvoice() as never);

    // Crediting first would leave a window where the balance has moved and the
    // grants still read as unspent, so the NEXT invoice spends them again — and
    // again, with nothing to stop it.
    const claimIndex = statements.findIndex(s => s.sql.includes('applied_invoice_id = $2'));
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(order).toEqual(['stripe']);
    expect(statements[claimIndex].sql).toContain('applied_invoice_id IS NULL');
  });

  it('gives the grants back when Stripe refuses the credit', async () => {
    const { ReferralCreditService } = await load();
    const statements = applyHarness([{ id: 'c1', amount_usd: '20.00' }]);
    const stripe = {
      customers: {
        createBalanceTransaction: fn(async () => {
          throw new Error('stripe down');
        }),
      },
    };

    const svc = new ReferralCreditService(stripe as never, {} as never, makeLog());

    await expect(svc.applyToInvoice(TENANT, makeInvoice() as never)).rejects.toThrow('stripe down');
    // A grant marked spent that Stripe never received is credit the customer
    // can never use, so the claim is undone.
    const release = statements.find(s => s.sql.includes('applied_invoice_id = NULL'));
    expect(release).toBeDefined();
    expect(release?.params[0]).toEqual(['c1']);
  });

  it('takes none of them when a concurrent invoice took some', async () => {
    const { ReferralCreditService } = await load();
    // Two grants selected, only one still unclaimed by the time the UPDATE ran.
    const statements = applyHarness(
      [{ id: 'c1', amount_usd: '20.00' }, { id: 'c2', amount_usd: '20.00' }],
      1,
    );
    const stripe = { customers: { createBalanceTransaction: fn() } };

    const svc = new ReferralCreditService(stripe as never, {} as never, makeLog());
    const { appliedUsd } = await svc.applyToInvoice(
      TENANT, makeInvoice({ amount_due: 4000 }) as never,
    );

    expect(appliedUsd).toBe(0);
    expect(stripe.customers.createBalanceTransaction).not.toHaveBeenCalled();
    expect(statements.some(s => s.sql.includes('applied_invoice_id = NULL'))).toBe(true);
  });

  it('does nothing when there is nothing vested', async () => {
    const { ReferralCreditService } = await load();
    const stripe = { customers: { createBalanceTransaction: fn() } };
    const svc = new ReferralCreditService(stripe as never, {} as never, makeLog());

    const { appliedUsd } = await svc.applyToInvoice(TENANT, makeInvoice() as never);

    expect(appliedUsd).toBe(0);
    expect(stripe.customers.createBalanceTransaction).not.toHaveBeenCalled();
  });

  it('does nothing on a zero-amount invoice', async () => {
    const { ReferralCreditService } = await load();
    const stripe = { customers: { createBalanceTransaction: fn() } };
    const svc = new ReferralCreditService(stripe as never, {} as never, makeLog());

    const { appliedUsd } = await svc.applyToInvoice(
      TENANT, makeInvoice({ amount_due: 0 }) as never,
    );

    expect(appliedUsd).toBe(0);
  });
});

// ── Reversal ─────────────────────────────────────────────────────────────────

describe('reversing the credit an earning payment produced', () => {
  it('takes back what was never spent', async () => {
    const { ReferralCreditService } = await load();
    crossTenantReturning([{ id: 'c1', tenant_id: TENANT, applied_invoice_id: null, status: 'granted' }]);
    mockWithBillingTenant.mockImplementation(async (_t: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)({ query: fn(async () => ({ rows: [], rowCount: 1 })) }),
    );

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());

    expect(await svc.onEarningPaymentReversed('in_1', 'dispute')).toEqual({
      reversed: 1,
      absorbed: 0,
    });
  });

  it('absorbs what was already applied — no negative balance, no re-billing', async () => {
    const { ReferralCreditService } = await load();
    crossTenantReturning([{ id: 'c1', tenant_id: TENANT, applied_invoice_id: 'in_next', status: 'granted' }]);
    const updated = fn(async () => ({ rows: [], rowCount: 1 }));
    mockWithBillingTenant.mockImplementation(async (_t: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)({ query: updated }),
    );

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());

    expect(await svc.onEarningPaymentReversed('in_1', 'refund')).toEqual({
      reversed: 0,
      absorbed: 1,
    });
    // Nothing is written: the credit stays applied and the loss is taken.
    expect(updated).not.toHaveBeenCalled();
  });

  it('does nothing for an invoice that earned no credit', async () => {
    const { ReferralCreditService } = await load();
    crossTenantReturning([]);
    const svc = new ReferralCreditService({} as never, {} as never, makeLog());

    expect(await svc.onEarningPaymentReversed('in_unrelated', 'refund')).toEqual({
      reversed: 0,
      absorbed: 0,
    });
  });
});

// ── Reinstatement ────────────────────────────────────────────────────────────

describe('restoring the credit a won dispute had reversed', () => {
  it('puts a dispute reversal back as pending, for vesting to re-grant', async () => {
    const { ReferralCreditService } = await load();
    crossTenantReturning([{ id: 'c1', tenant_id: TENANT }]);
    const updated = fn(async () => ({ rows: [], rowCount: 1 }));
    mockWithBillingTenant.mockImplementation(async (_t: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)({ query: updated }),
    );

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());

    expect(await svc.onEarningPaymentReinstated('in_1')).toEqual({ restored: 1 });

    // Restored to pending rather than granted: vesting is the one thing that
    // stamps expires_at, and a credit handed back as granted without one would
    // never expire.
    const sql = String((updated as jest.Mock).mock.calls[0][0]);
    expect(sql).toContain("status          = 'pending'");
    expect(sql).toContain('reversed_reason = NULL');
  });

  // The selection is the whole safety property: a refund, an expiry, a
  // cancellation and a disqualification are all decisions that stand.
  it('reads only dispute reversals, never the other reasons', async () => {
    const { ReferralCreditService } = await load();
    const selected = fn(async () => ({ rows: [] }));
    mockWithCrossTenant.mockImplementation(async (_reason: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)({ query: selected }),
    );
    const svc = new ReferralCreditService({} as never, {} as never, makeLog());

    await svc.onEarningPaymentReinstated('in_1');

    const sql = String((selected as jest.Mock).mock.calls[0][0]);
    expect(sql).toContain("status            = 'reversed'");
    expect(sql).toContain("reversed_reason   = 'dispute'");
  });

  it('does nothing for an invoice whose credit was never reversed', async () => {
    const { ReferralCreditService } = await load();
    crossTenantReturning([]);
    const billingTenant = fn();
    mockWithBillingTenant.mockImplementation(billingTenant);

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());

    expect(await svc.onEarningPaymentReinstated('in_unrelated')).toEqual({ restored: 0 });
    expect(billingTenant).not.toHaveBeenCalled();
  });
});

// ── The summary ──────────────────────────────────────────────────────────────

describe('the programme summary', () => {
  function totals(row: Row, subscriptionCount: string) {
    mockWithBillingTenant.mockImplementation(async (_t: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)({
        query: fn(async (sql: unknown) =>
          String(sql).includes('FROM subscriptions')
            ? { rows: [{ count: subscriptionCount }] }
            : { rows: [row] },
        ),
      }),
    );
    // The old version of this helper returned a throwing pool, to catch a revert
    // to `this.pool.query`. That guard is now structural rather than a test
    // fixture: the service takes no Pool, so there is no unscoped read to write.
    // If either of summary's reads escaped its scope it would have to go through
    // withCrossTenant, which is asserted against below.
    mockWithCrossTenant.mockImplementation(async () => {
      throw new Error('summary must not take the cross-tenant lane');
    });
  }

  it('keeps earned = applied + available, which the page renders side by side', async () => {
    const { ReferralCreditService } = await load();
    totals({ applied: '20', available: '20', converted: '2' }, '1');

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());
    const summary = await svc.summary(TENANT);

    expect(summary.creditEarnedUsd).toBe(40);
    expect(summary.creditAppliedUsd).toBe(20);
    expect(summary.creditAvailableUsd).toBe(20);
    expect(summary.creditEarnedUsd).toBe(summary.creditAppliedUsd + summary.creditAvailableUsd);
    expect(summary.convertedCount).toBe(2);
    expect(summary.subscriptionActive).toBe(true);
  });

  // The `subscriptions` read used to run on the raw pool. That table is
  // RLS-fenced on `current_setting('app.current_tenant_id', false)::uuid`, and a
  // recycled connection carries that setting as '' rather than unset, so the
  // cast threw 22P02. `summary` runs its two reads in a Promise.all, so the
  // throw failed the whole route and the control plane's catch served
  // `subscriptionActive: false` — telling every workspace it had no
  // subscription and hiding the invite control.
  it('reads subscriptions inside the tenant scope, never the raw pool', async () => {
    const { ReferralCreditService } = await load();
    totals({ applied: '0', available: '0', converted: '0' }, '1');

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());
    const summary = await svc.summary(TENANT);

    expect(summary.subscriptionActive).toBe(true);
    // Both reads are tenant-scoped; neither takes the cross-tenant lane.
    expect(mockWithCrossTenant).not.toHaveBeenCalled();
    expect(mockWithBillingTenant).toHaveBeenCalledWith(TENANT, expect.anything());
  });

  it('holds the identity while a conversion is still vesting', async () => {
    const { ReferralCreditService } = await load();
    // One conversion, its credit still pending: nothing applied, nothing
    // vested, and — because the count and the amount are rendered as one
    // sentence — nothing counted either. "$0 earned from 1 subscriber" reads as
    // a bug rather than as a hold working correctly; the row carries the truth,
    // as `pending` with the date it lands.
    totals({ applied: '0', available: '0', converted: '0' }, '0');

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());
    const summary = await svc.summary(TENANT);

    expect(summary.creditEarnedUsd).toBe(0);
    expect(summary.creditAvailableUsd).toBe(0);
    expect(summary.creditEarnedUsd).toBe(summary.creditAppliedUsd + summary.creditAvailableUsd);
    expect(summary.convertedCount).toBe(0);
    expect(summary.subscriptionActive).toBe(false);
  });

  it('counts exactly the conversions that make up the earned figure', async () => {
    const { ReferralCreditService } = await load();
    let captured = '';
    mockWithBillingTenant.mockImplementation(async (_t: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)({
        query: fn(async (sql: unknown) => {
          // Both reads are scoped, so keep the credits one rather than
          // whichever of the two the Promise.all happened to finish last.
          if (String(sql).includes('FROM subscriptions')) return { rows: [{ count: '1' }] };
          captured = String(sql);
          return { rows: [{ applied: '20', available: '20', converted: '2' }] };
        }),
      }),
    );
    crossTenantReturning([]);

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());
    await svc.summary(TENANT);

    // The count's predicate has to be the union of applied and available, or
    // the sentence the page renders stops being true.
    expect(captured).toContain('COUNT(*) FILTER');
    expect(captured).toContain("applied_invoice_id IS NOT NULL\n                                     OR (status = 'granted'");
  });

  it('holds the identity in the window between expiry and the sweep', async () => {
    const { ReferralCreditService } = await load();
    // A grant past its expires_at is already excluded from `available` by the
    // query, hours before the daily sweep reverses it. An independently summed
    // `earned` would still count it and the page would show three numbers that
    // do not add up.
    totals({ applied: '20', available: '0', converted: '2' }, '1');

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());
    const summary = await svc.summary(TENANT);

    expect(summary.creditEarnedUsd).toBe(20);
    expect(summary.creditEarnedUsd).toBe(summary.creditAppliedUsd + summary.creditAvailableUsd);
  });
});


// ── Enforcement ──────────────────────────────────────────────────────────────
//
// The investigate-and-disqualify clause, which is what REPLACES automatic
// clawback. Both levers stop at the same wall as every other reversal: spent
// credit is absorbed, never reclaimed, so neither can produce a negative
// balance.

describe('disqualifying one referral', () => {
  it('takes back credit that was never spent', async () => {
    const { ReferralCreditService } = await load();
    crossTenantReturning([{ id: 'c1', tenant_id: TENANT, applied_invoice_id: null, status: 'granted' }]);
    mockWithBillingTenant.mockImplementation(async (_t: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)({ query: fn(async () => ({ rows: [], rowCount: 1 })) }),
    );

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());

    expect(await svc.disqualifyReferral(REFERRAL_ID)).toEqual({
      reversed: 1, absorbed: 0, found: true,
    });
  });

  it('absorbs credit already applied rather than clawing it back', async () => {
    const { ReferralCreditService } = await load();
    crossTenantReturning([{ id: 'c1', tenant_id: TENANT, applied_invoice_id: 'in_1', status: 'granted' }]);
    const updated = fn(async () => ({ rows: [], rowCount: 1 }));
    mockWithBillingTenant.mockImplementation(async (_t: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)({ query: updated }),
    );

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());

    // An operator told "disqualified" when the $20 was already spent would
    // believe something happened that did not, so the two are reported apart.
    expect(await svc.disqualifyReferral(REFERRAL_ID)).toEqual({
      reversed: 0, absorbed: 1, found: true,
    });
    expect(updated).not.toHaveBeenCalled();
  });

  it('reports a referral that never earned anything', async () => {
    const { ReferralCreditService } = await load();
    crossTenantReturning([]);
    const svc = new ReferralCreditService({} as never, {} as never, makeLog());

    expect(await svc.disqualifyReferral(REFERRAL_ID)).toEqual({
      reversed: 0, absorbed: 0, found: false,
    });
  });
});

describe('forfeiting a workspace balance for a terms violation', () => {
  it('reverses everything unspent, and nothing else', async () => {
    const { ReferralCreditService } = await load();
    const statements: string[] = [];
    mockWithBillingTenant.mockImplementation(async (_t: unknown, cb: unknown) =>
      (cb as (c: unknown) => unknown)({
        query: fn(async (sql: unknown) => {
          statements.push(String(sql));
          if (String(sql).includes('SELECT')) {
            return { rows: [{ id: 'c1' }, { id: 'c2' }], rowCount: 2 };
          }
          return { rows: [], rowCount: 2 };
        }),
      }),
    );

    const svc = new ReferralCreditService({} as never, {} as never, makeLog());

    expect(await svc.forfeitForTermsViolation(TENANT)).toEqual({ forfeited: 2 });
    // The selection is what limits the blast radius: applied credit is never in
    // the set, so "immediate forfeiture" cannot reach money already spent.
    expect(statements[0]).toContain('applied_invoice_id IS NULL');
  });
});
