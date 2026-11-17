// The sweep reaches a workspace the drain no longer can: one that spent a
// whole reload inside the cooldown and stopped under its threshold, where no
// later charge will arrive to fire the next reload. The claim's SQL was run
// against Postgres (claims, exclusions, SKIP LOCKED under two instances);
// this pins its shape and what a pass does with what it claims.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery })),
}));

const mockFire = jest.fn();
jest.mock('../../cost-attribution/reload-drain', () => ({
  AUTO_RELOAD_COOLDOWN_MS: 300000,
  fireAutoReloadClaim: (...a: unknown[]) => mockFire(...a),
}));

import { runAutoReloadSweep } from '../auto-reload-sweep';

beforeEach(() => jest.clearAllMocks());

it('fires each claimed reload for its first workspace, after the claim', async () => {
  mockQuery.mockResolvedValueOnce({
    rows: [
      { account_id: 'acct-1', stripe_customer_id: 'cus_1', auto_reload_amount_usd: '5.00', tenant_id: 'tenant-1' },
      { account_id: 'acct-2', stripe_customer_id: 'cus_2', auto_reload_amount_usd: '20.00', tenant_id: null },
    ],
  });

  await expect(runAutoReloadSweep()).resolves.toBe(2);
  expect(mockFire).toHaveBeenCalledWith({ stripeCustomerId: 'cus_1', autoReloadAmountUsd: '5.00' }, 'acct-1', 'tenant-1', 'billing.auto_reload_sweep');
  expect(mockFire).toHaveBeenCalledWith({ stripeCustomerId: 'cus_2', autoReloadAmountUsd: '20.00' }, 'acct-2', null, 'billing.auto_reload_sweep');
});

it('fires nothing when nothing is stranded', async () => {
  mockQuery.mockResolvedValueOnce({ rows: [] });
  await expect(runAutoReloadSweep()).resolves.toBe(0);
  expect(mockFire).not.toHaveBeenCalled();
});

it('claims through the drain’s cooldown stamp, and leaves declined cards and holds alone', async () => {
  mockQuery.mockResolvedValueOnce({ rows: [] });
  await runAutoReloadSweep();
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toContain('SET last_auto_reload_triggered_at = NOW()');
  expect(sql).toContain('FOR UPDATE SKIP LOCKED');
  expect(sql).toContain('bc.reload_balance_usd <= bc.auto_reload_threshold_usd');
  expect(sql).toContain("(NOT bc.suspended OR bc.suspended_reason = 'zero_prepaid_balance')");
  expect(sql).toContain('bc.fraud_hold_at IS NULL');
  expect(params[0]).toBe(300000);
});
