// The entitlement snapshot the tenant runtime fetches must carry the SAME
// billing hard stop this plane's execution-guard reads.
//
// Two gates decided "may this tenant run agents" from different facts:
// execution-guard read `agent_execution_allowed` AND
// `billing_controls.suspended`; the runtime's admission check read only a
// cached copy of the entitlement row, which never contained the second. Folding
// it into the served snapshot is what makes the two computable from one fact.

const mockClientQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: mockClientQuery })),
  withAdminScope: jest.fn(async (_o: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: mockClientQuery })),
}));

import { EntitlementRepository } from '../repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function entitlementRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ent-1',
    tenant_id: TENANT_ID,
    version: 4,
    team_count: 10,
    is_custom_pricing: false,
    tenant_operational_status: 'active',
    agent_execution_allowed: true,
    remaining_included_credits: 1000,
    overage_allowed: true,
    included_monthly_credits: 1000,
    overage_ceiling: 1000000,
    created_at: new Date('2026-04-01T00:00:00Z'),
    updated_at: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('EntitlementRepository.findByTenantId — billing_suspended', () => {
  it('joins billing_controls and COALESCEs a missing row to FALSE', async () => {
    mockClientQuery.mockResolvedValue({ rows: [entitlementRow({ billing_suspended: false })], rowCount: 1 });

    await new EntitlementRepository().findByTenantId(TENANT_ID);

    const sql = String(mockClientQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('LEFT JOIN billing_controls bc ON bc.account_id = t.account_id');
    // The served stop signal: a fraud hold, OR the stored flag, OR a pre-pay
    // account past its allowance with a reload balance under the prepaid
    // floor; a missing row still reads FALSE.
    expect(sql).toMatch(/COALESCE\(bc\.fraud_hold_at IS NOT NULL OR bc\.suspended OR \(bc\.billing_mode = 'pre_pay' AND .*bc\.reload_balance_usd < CASE WHEN bc\.auto_reload_enabled AND bc\.auto_reload_threshold_usd IS NOT NULL THEN LEAST\(\$2, bc\.auto_reload_threshold_usd\) ELSE \$2 END\), FALSE\) AS billing_suspended/);
    expect(mockClientQuery.mock.calls[0][1]).toEqual([TENANT_ID, 2]);
  });

  // The other half of the fraud hold. This plane's execution-guard reads the
  // column directly, but the runtime never calls that function — it admits
  // work off this snapshot. A hold that reached only one of them would stop a
  // workspace in the dashboard and leave it running in the runtime, which is
  // the state the shared predicate exists to prevent.
  it('carries a fraud hold into the snapshot the runtime admits work from', async () => {
    mockClientQuery.mockResolvedValue({ rows: [entitlementRow({ billing_suspended: true })], rowCount: 1 });

    const result = await new EntitlementRepository().findByTenantId(TENANT_ID);

    const sql = String(mockClientQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('bc.fraud_hold_at IS NOT NULL');
    expect(result?.billingSuspended).toBe(true);
  });

  it('surfaces a suspended account as billingSuspended = true', async () => {
    mockClientQuery.mockResolvedValue({ rows: [entitlementRow({ billing_suspended: true })], rowCount: 1 });

    const result = await new EntitlementRepository().findByTenantId(TENANT_ID);

    expect(result?.billingSuspended).toBe(true);
  });

  it('reads an account with no billing_controls row as NOT suspended', async () => {
    // Internal / exempt accounts have no billing_controls row at all. A missing
    // row must never read as suspended — the same rule execution-guard follows.
    mockClientQuery.mockResolvedValue({ rows: [entitlementRow({ billing_suspended: false })], rowCount: 1 });

    const result = await new EntitlementRepository().findByTenantId(TENANT_ID);

    expect(result?.billingSuspended).toBe(false);
  });

  it('renders an absent column as false rather than undefined', async () => {
    // A row from an INSERT/UPDATE ... RETURNING * has no such column. `false`
    // is the safe rendering of "no opinion".
    mockClientQuery.mockResolvedValue({ rows: [entitlementRow()], rowCount: 1 });

    const result = await new EntitlementRepository().findByTenantId(TENANT_ID);

    expect(result?.billingSuspended).toBe(false);
  });
});

describe('EntitlementRepository.findAll — billing_suspended', () => {
  it('carries the same join so the operator list is not a different truth', async () => {
    mockClientQuery.mockResolvedValue({
      rows: [entitlementRow({ billing_suspended: true })],
      rowCount: 1,
    });

    const all = await new EntitlementRepository().findAll();

    const sql = String(mockClientQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toMatch(/COALESCE\(bc\.fraud_hold_at IS NOT NULL OR bc\.suspended OR \(bc\.billing_mode = 'pre_pay' AND .*bc\.reload_balance_usd < CASE WHEN bc\.auto_reload_enabled AND bc\.auto_reload_threshold_usd IS NOT NULL THEN LEAST\(\$1, bc\.auto_reload_threshold_usd\) ELSE \$1 END\), FALSE\) AS billing_suspended/);
    expect(mockClientQuery.mock.calls[0][1]).toEqual([2]);
    expect(all[0].billingSuspended).toBe(true);
  });
});
