// Zero-crossing detection inside applyReloadDrain. Fires the agents-stalled
// notification once per depletion cycle when:
//   • reload_balance_usd <= 0 after the drain
//   • auto_reload_enabled = false (auto-reload would otherwise rescue them)
//   • agents_stalled_notified_at is currently NULL (per-cycle dedupe)
//
// Reset hooks (top-up, auto-reload enable, period reset, resubscribe) clear
// the flag back to NULL — those are covered by billing-controls-router and
// annual-plan-allocation-reset tests.

import type { PoolClient } from 'pg';

const notifyAgentsStalled = jest.fn().mockResolvedValue(undefined);
jest.mock('../agents-stalled-notify', () => ({ notifyAgentsStalled }));
const triggerAutoReload = jest.fn().mockResolvedValue(undefined);
jest.mock('../../billing/billing-admin-client', () => ({ getBillingAdminClient: () => ({ triggerAutoReload }) }));

import { applyReloadDrain, fireAutoReloadClaim } from '../reload-drain';
import type { BucketAssignment } from '../ou-bucket-service';

function mockClient(queryResults: Array<{ rows: unknown[]; rowCount?: number }>): PoolClient {
  let i = 0;
  const query = jest.fn().mockImplementation(() => {
    const r = queryResults[i] ?? { rows: [], rowCount: 0 };
    i++;
    return Promise.resolve({ rows: r.rows, rowCount: r.rowCount ?? r.rows.length });
  });
  return { query } as unknown as PoolClient;
}

const ACCOUNT_ID = 'acct-uuid-drain-001';

function reloadAssignments(usd: number): BucketAssignment[] {
  return [
    {
      costBucket: 'reload',
      customerCostUsd: usd,
    } as unknown as BucketAssignment,
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('applyReloadDrain — zero-crossing notification', () => {
  it('fires notifyAgentsStalled exactly once when balance crosses to <=0 and auto-reload OFF', async () => {
    const client = mockClient([
      { rows: [{ billing_mode: 'pre_pay' }] },                // mode check
      { rows: [{                                              // drain UPDATE RETURNING
        reload_balance_usd: '-1.50',
        suspended: true,
        auto_reload_enabled: false,
        auto_reload_threshold_usd: null,
        auto_reload_amount_usd: null,
        last_auto_reload_triggered_at: null,
        stripe_customer_id: 'cus_test',
        agents_stalled_notified_at: null,
        billing_period_start: new Date('2026-05-01T00:00:00.000Z'),
      }] },
      { rows: [], rowCount: 1 },                              // UPDATE agents_stalled_notified_at = NOW()
    ]);

    await applyReloadDrain(client, ACCOUNT_ID, reloadAssignments(2.0), { fireAutoReload: false });
    await new Promise((r) => setImmediate(r));    // let void promise settle

    expect(notifyAgentsStalled).toHaveBeenCalledTimes(1);
    expect(notifyAgentsStalled.mock.calls[0][0]).toBe(ACCOUNT_ID);
    // nextResetDate is billing_period_start + 1 month (JS Date.setMonth in
    // local time — exact day depends on the test machine's TZ but always
    // lands ~30 days later).
    const reset = notifyAgentsStalled.mock.calls[0][1].nextResetDate as Date;
    const start = new Date('2026-05-01T00:00:00.000Z').getTime();
    const deltaDays = (reset.getTime() - start) / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBeGreaterThanOrEqual(28);
    expect(deltaDays).toBeLessThanOrEqual(32);
  });

  it('does NOT fire when balance stays positive', async () => {
    const client = mockClient([
      { rows: [{ billing_mode: 'pre_pay' }] },
      { rows: [{
        reload_balance_usd: '5.00',
        suspended: false,
        auto_reload_enabled: false,
        auto_reload_threshold_usd: null,
        auto_reload_amount_usd: null,
        last_auto_reload_triggered_at: null,
        stripe_customer_id: 'cus_test',
        agents_stalled_notified_at: null,
        billing_period_start: new Date('2026-05-01T00:00:00.000Z'),
      }] },
    ]);

    await applyReloadDrain(client, ACCOUNT_ID, reloadAssignments(1.0), { fireAutoReload: false });
    await new Promise((r) => setImmediate(r));

    expect(notifyAgentsStalled).not.toHaveBeenCalled();
  });

  it('does NOT fire when auto-reload is ENABLED (Stripe rescue path takes over)', async () => {
    const client = mockClient([
      { rows: [{ billing_mode: 'pre_pay' }] },
      { rows: [{
        reload_balance_usd: '-0.50',
        suspended: true,
        auto_reload_enabled: true,
        auto_reload_threshold_usd: '10.00',
        auto_reload_amount_usd: '50.00',
        last_auto_reload_triggered_at: null,
        stripe_customer_id: 'cus_test',
        agents_stalled_notified_at: null,
        billing_period_start: new Date('2026-05-01T00:00:00.000Z'),
      }] },
      // No agents_stalled UPDATE expected (skipped) — but the auto-reload claim
      // branch may issue its own UPDATE last_auto_reload_triggered_at.
      { rows: [], rowCount: 1 },
    ]);

    await applyReloadDrain(client, ACCOUNT_ID, reloadAssignments(1.0), { fireAutoReload: true });
    await new Promise((r) => setImmediate(r));

    expect(notifyAgentsStalled).not.toHaveBeenCalled();
  });

  it('does NOT fire when agents_stalled_notified_at is already set (per-cycle dedupe)', async () => {
    const client = mockClient([
      { rows: [{ billing_mode: 'pre_pay' }] },
      { rows: [{
        reload_balance_usd: '-1.00',
        suspended: true,
        auto_reload_enabled: false,
        auto_reload_threshold_usd: null,
        auto_reload_amount_usd: null,
        last_auto_reload_triggered_at: null,
        stripe_customer_id: 'cus_test',
        agents_stalled_notified_at: new Date('2026-05-10T00:00:00.000Z'),
        billing_period_start: new Date('2026-05-01T00:00:00.000Z'),
      }] },
    ]);

    await applyReloadDrain(client, ACCOUNT_ID, reloadAssignments(1.0), { fireAutoReload: false });
    await new Promise((r) => setImmediate(r));

    expect(notifyAgentsStalled).not.toHaveBeenCalled();
  });

  it('does NOT fire for post-pay accounts (drain skipped entirely)', async () => {
    const client = mockClient([
      { rows: [{ billing_mode: 'post_pay' }] },
    ]);

    await applyReloadDrain(client, ACCOUNT_ID, reloadAssignments(1.0), { fireAutoReload: false });
    await new Promise((r) => setImmediate(r));

    expect(notifyAgentsStalled).not.toHaveBeenCalled();
  });
});

// The drain reports whether THIS charge is the one that suspended the account
// — the fact its callers publish post-commit so every tenant under the
// account hears in seconds. An account that was already suspended reports
// nothing: the runtime was told when it happened.
describe('applyReloadDrain — the suspension it caused', () => {
  const drained = (suspendedBefore: boolean, balanceAfter: string, suspendedAfter: boolean) => mockClient([
    { rows: [{ billing_mode: 'pre_pay', suspended: suspendedBefore }] },
    { rows: [{
      reload_balance_usd: balanceAfter,
      suspended: suspendedAfter,
      auto_reload_enabled: true,
      auto_reload_threshold_usd: '5.00',
      auto_reload_amount_usd: null,
      last_auto_reload_triggered_at: null,
      stripe_customer_id: 'cus_test',
      agents_stalled_notified_at: new Date(),
      billing_period_start: new Date('2026-05-01T00:00:00.000Z'),
    }] },
    { rows: [], rowCount: 1 },
  ]);

  it('is reported when the balance crosses below zero on this charge', async () => {
    const out = await applyReloadDrain(drained(false, '-0.02', true), ACCOUNT_ID, reloadAssignments(0.05), { fireAutoReload: false });
    expect(out.suspendedNow).toBe(true);
  });

  it('is not reported when the balance stays positive, nor when the account was suspended already', async () => {
    expect((await applyReloadDrain(drained(false, '4.00', false), ACCOUNT_ID, reloadAssignments(0.05), { fireAutoReload: false })).suspendedNow).toBe(false);
    expect((await applyReloadDrain(drained(true, '-3.00', true), ACCOUNT_ID, reloadAssignments(0.05), { fireAutoReload: false })).suspendedNow).toBe(false);
  });

  it('is not reported for a charge with no reload portion, nor for a post-pay account', async () => {
    const none = await applyReloadDrain(mockClient([]), ACCOUNT_ID, [{ costBucket: 'included', customerCostUsd: 0 } as unknown as BucketAssignment], { fireAutoReload: false });
    expect(none.suspendedNow).toBe(false);
    const postPay = await applyReloadDrain(mockClient([{ rows: [{ billing_mode: 'post_pay', suspended: false }] }]), ACCOUNT_ID, reloadAssignments(0.05), { fireAutoReload: false });
    expect(postPay.suspendedNow).toBe(false);
  });
});

// The prepaid floor: the served snapshot reads as suspended once a workspace
// past its allowance has a reload balance under the floor, and the drain
// reports the crossing so the runtime hears it now.
describe('applyReloadDrain — the floor crossing it caused', () => {
  const drained = (suspendedBefore: boolean, balanceAfter: string, thresholdUsd: string | null = '5.00') => mockClient([
    { rows: [{ billing_mode: 'pre_pay', suspended: suspendedBefore }] },
    { rows: [{
      reload_balance_usd: balanceAfter,
      suspended: suspendedBefore,
      auto_reload_enabled: thresholdUsd !== null,
      auto_reload_threshold_usd: thresholdUsd,
      auto_reload_amount_usd: null,
      last_auto_reload_triggered_at: null,
      stripe_customer_id: 'cus_test',
      agents_stalled_notified_at: new Date(),
      billing_period_start: new Date('2026-05-01T00:00:00.000Z'),
    }] },
    { rows: [], rowCount: 1 },
  ]);
  afterEach(() => { delete process.env.PREPAID_SPEND_FLOOR_USD; });

  it('is reported when this charge takes the balance from above the floor to under it', async () => {
    // $2.05 → $1.95 across the default $2 floor
    const out = await applyReloadDrain(drained(false, '1.95'), ACCOUNT_ID, reloadAssignments(0.10), { fireAutoReload: false });
    expect(out.suspendedNow).toBe(true);
    expect(out.stopReason).toBe('prepaid_floor');
  });

  it('is not reported for a charge that stays above the floor, nor one already under it, nor on a stopped account', async () => {
    expect((await applyReloadDrain(drained(false, '2.50'), ACCOUNT_ID, reloadAssignments(0.10), { fireAutoReload: false })).stopReason).toBeNull();
    expect((await applyReloadDrain(drained(false, '1.50'), ACCOUNT_ID, reloadAssignments(0.10), { fireAutoReload: false })).stopReason).toBeNull();
    expect((await applyReloadDrain(drained(true, '1.95'), ACCOUNT_ID, reloadAssignments(0.10), { fireAutoReload: false })).stopReason).toBeNull();
  });

  it('honours the configured floor, and a crossing below zero is reported as that, not as the floor', async () => {
    process.env.PREPAID_SPEND_FLOOR_USD = '10';
    expect((await applyReloadDrain(drained(false, '9.95', null), ACCOUNT_ID, reloadAssignments(0.10), { fireAutoReload: false })).stopReason).toBe('prepaid_floor');
    const zero = mockClient([
      { rows: [{ billing_mode: 'pre_pay', suspended: false }] },
      { rows: [{ reload_balance_usd: '-0.05', suspended: true, auto_reload_enabled: false, auto_reload_threshold_usd: null, auto_reload_amount_usd: null, last_auto_reload_triggered_at: null, stripe_customer_id: 'cus', agents_stalled_notified_at: new Date(), billing_period_start: new Date() }] },
      { rows: [], rowCount: 1 },
    ]);
    expect((await applyReloadDrain(zero, ACCOUNT_ID, reloadAssignments(0.10), { fireAutoReload: false })).stopReason).toBe('zero_prepaid_balance');
  });
});

// A $1 auto-reload threshold sits under the $2 floor. Stopping at $2 would
// leave the workspace making no charges, and the drain is the only thing that
// fires a reload, so the account stops at its threshold instead: the charge
// that stops it is the one that claims the reload.
describe('applyReloadDrain — an auto-reload threshold under the floor', () => {
  const drained = (balanceAfter: string) => mockClient([
    { rows: [{ billing_mode: 'pre_pay', suspended: false }] },
    { rows: [{
      reload_balance_usd: balanceAfter,
      suspended: false,
      auto_reload_enabled: true,
      auto_reload_threshold_usd: '1.00',
      auto_reload_amount_usd: '5.00',
      last_auto_reload_triggered_at: null,
      stripe_customer_id: 'cus_test',
      agents_stalled_notified_at: null,
      billing_period_start: new Date('2026-05-01T00:00:00.000Z'),
    }] },
    { rows: [], rowCount: 1 },
  ]);

  it('keeps spending past the $2 floor while the balance is above the threshold', async () => {
    // $2.50 → $1.50
    const out = await applyReloadDrain(drained('1.50'), ACCOUNT_ID, reloadAssignments(1.0), { fireAutoReload: true });
    expect(out.stopReason).toBeNull();
    expect(out.autoReloadClaim).toBeNull();
  });

  it('stops at the threshold with the same charge that claims the reload', async () => {
    // $1.20 → $0.90
    const out = await applyReloadDrain(drained('0.90'), ACCOUNT_ID, reloadAssignments(0.30), { fireAutoReload: true });
    expect(out.stopReason).toBe('prepaid_floor');
    expect(out.autoReloadClaim).toEqual({ stripeCustomerId: 'cus_test', autoReloadAmountUsd: '5.00' });
  });
});

describe('fireAutoReloadClaim', () => {
  it('charges the reload amount to the claimed customer for the workspace', async () => {
    fireAutoReloadClaim({ stripeCustomerId: 'cus_test', autoReloadAmountUsd: '5.00' }, ACCOUNT_ID, 'tenant-1', 'test');
    expect(triggerAutoReload).toHaveBeenCalledWith('cus_test', 5, 'tenant-1');
  });
});
