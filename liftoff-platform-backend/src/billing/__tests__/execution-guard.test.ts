// The execution guard's refusal order.
//
// The guard answers one question — may this workspace start new work — and the
// ORDER of its branches is the part worth guarding, because each branch tells
// the person something different about what to do next. A fraud hold is the
// only one of them that buying something cannot lift, so it is checked before
// the plan and balance branches: a held workspace that is fully funded and
// subscribed must still be refused, and must not be sent to the pricing page.
//
// The runtime does not call this function — it reads `billingSuspended` off its
// entitlement snapshot, where the same column is a term in
// prepaid-floor.billingStoppedSql. Both readers exist because they serve
// different callers, and the hold has to be in both or a held workspace is
// stopped in one place and running in the other.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockClientQuery = jest.fn();
const mockClient = { query: mockClientQuery };
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) => fn(mockClient)),
  getPool: jest.fn(),
}));

import { checkExecutionAllowed, FRAUD_HOLD_REASON } from '../execution-guard';

const TENANT = '11111111-1111-4111-8111-111111111111';

/** A workspace that is funded, subscribed and running: every branch of the
 *  guard says yes. Each test turns exactly one fact against it. */
function healthyRow(overrides: Record<string, unknown> = {}) {
  return {
    agent_execution_allowed: true,
    suspended: false,
    outstanding_balance_usd: '0',
    billing_mode: 'pre_pay',
    reload_balance_usd: '100.000000',
    in_reload_territory: false,
    auto_reload_enabled: false,
    auto_reload_threshold_usd: null,
    suspended_reason: null,
    fraud_hold_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockClientQuery.mockReset();
});

it('allows a funded, subscribed workspace', async () => {
  mockClientQuery.mockResolvedValueOnce({ rows: [healthyRow()] });
  await expect(checkExecutionAllowed(TENANT)).resolves.toEqual({ allowed: true });
});

it('refuses a held workspace that is otherwise perfectly able to pay', async () => {
  mockClientQuery.mockResolvedValueOnce({ rows: [healthyRow({ fraud_hold_at: new Date('2026-09-23T00:00:00Z') })] });

  await expect(checkExecutionAllowed(TENANT)).resolves.toEqual({
    allowed: false,
    reason: FRAUD_HOLD_REASON,
  });
});

it('tells a held workspace about the hold, not about a plan it already lacks', async () => {
  // Both facts are against it. The hold is the one that explains the refusal:
  // subscribing would not lift it, so the plan copy would be a false promise.
  mockClientQuery.mockResolvedValueOnce({
    rows: [healthyRow({ fraud_hold_at: new Date(), agent_execution_allowed: false })],
  });

  const result = await checkExecutionAllowed(TENANT);
  expect(result.reason).toBe(FRAUD_HOLD_REASON);
  expect(result.reason).not.toMatch(/subscribe/i);
});

it('tells a held workspace about the hold, not about a balance it could top up', async () => {
  mockClientQuery.mockResolvedValueOnce({
    rows: [healthyRow({ fraud_hold_at: new Date(), suspended: true, suspended_reason: 'zero_prepaid_balance', reload_balance_usd: '0' })],
  });

  const result = await checkExecutionAllowed(TENANT);
  expect(result.reason).toBe(FRAUD_HOLD_REASON);
  expect(result.reason).not.toMatch(/credit/i);
});

it('selects the hold column, so a held row cannot read as absent', async () => {
  mockClientQuery.mockResolvedValueOnce({ rows: [healthyRow()] });
  await checkExecutionAllowed(TENANT);

  const sql = mockClientQuery.mock.calls[0][0] as string;
  expect(sql).toContain('bc.fraud_hold_at');
});

it('still refuses an unfunded workspace on its own terms when no hold is set', async () => {
  mockClientQuery.mockResolvedValueOnce({
    rows: [healthyRow({ suspended: true, suspended_reason: 'zero_prepaid_balance', reload_balance_usd: '0' })],
  });

  const result = await checkExecutionAllowed(TENANT);
  expect(result.allowed).toBe(false);
  expect(result.reason).toMatch(/credit balance is \$0/i);
});

// Past the allowance, a workspace stops under the $2 floor, or under its
// auto-reload threshold when that is lower: the charge that reaches the
// threshold is the one that fires the reload, so it must still be admitted
// until then.
it('admits a workspace with auto-reload on down to its threshold, and stops it below', async () => {
  const territory = { in_reload_territory: true, auto_reload_enabled: true, auto_reload_threshold_usd: '1.00' };
  mockClientQuery.mockResolvedValueOnce({ rows: [healthyRow({ ...territory, reload_balance_usd: '1.50' })] });
  await expect(checkExecutionAllowed(TENANT)).resolves.toEqual({ allowed: true });

  mockClientQuery.mockResolvedValueOnce({ rows: [healthyRow({ ...territory, reload_balance_usd: '0.90' })] });
  expect((await checkExecutionAllowed(TENANT)).allowed).toBe(false);

  mockClientQuery.mockResolvedValueOnce({ rows: [healthyRow({ ...territory, auto_reload_enabled: false, reload_balance_usd: '1.50' })] });
  expect((await checkExecutionAllowed(TENANT)).allowed).toBe(false);
});
