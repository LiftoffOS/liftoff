// TE-004: Execution Guard
//
// Tests:
//   - Tenant with agent_execution_allowed + not suspended → allowed
//   - Tenant with agent_execution_allowed + suspended → blocked with balance in reason
//   - Tenant with agent_execution_allowed = false → blocked
//   - Missing entitlements row → blocked
//   - Exempt/internal tenant (agent_execution_allowed = true, no billing_controls row) → allowed
//   - Sequential calls each hit the DB (no caching)
//   - Concurrent calls for the same tenantId share one DB read (in-flight dedup)
//   - DB error → allows through (billing gate, not security gate)

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  getPool: jest.fn(),
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
});

import { getPool } from '../../infrastructure/database';
import { checkExecutionAllowed, invalidateExecutionCache } from '../../billing/execution-guard';

const TENANT_ID = 'tenant-exec-guard-001';

interface GuardRow {
  agent_execution_allowed: boolean;
  suspended: boolean | null;
  outstanding_balance_usd: string | null;
}

function setupPool(row: GuardRow | null) {
  (getPool as jest.Mock).mockReturnValue({
    query: jest.fn().mockResolvedValue({
      rows: row ? [row] : [],
      rowCount: row ? 1 : 0,
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TE-004 — checkExecutionAllowed()', () => {
  it('allows a tenant with active subscription and no outstanding balance', async () => {
    setupPool({ agent_execution_allowed: true, suspended: false, outstanding_balance_usd: '0.00' });
    const result = await checkExecutionAllowed(TENANT_ID);
    expect(result).toEqual({ allowed: true });
  });

  it('blocks when entitlements row does not exist (no subscription)', async () => {
    setupPool(null);
    const result = await checkExecutionAllowed(TENANT_ID);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('subscribe');
  });

  it('blocks when agent_execution_allowed is false', async () => {
    setupPool({ agent_execution_allowed: false, suspended: false, outstanding_balance_usd: '0.00' });
    const result = await checkExecutionAllowed(TENANT_ID);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('subscribe');
  });

  it('blocks a suspended tenant and includes the balance in the reason', async () => {
    setupPool({ agent_execution_allowed: true, suspended: true, outstanding_balance_usd: '100.00' });
    const result = await checkExecutionAllowed(TENANT_ID);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('$100.00');
    expect(result.reason).toContain('payment method');
  });

  it('includes the exact outstanding balance in the suspension reason', async () => {
    setupPool({ agent_execution_allowed: true, suspended: true, outstanding_balance_usd: '350.75' });
    const result = await checkExecutionAllowed(TENANT_ID);
    expect(result.reason).toContain('$350.75');
  });

  it('allows an exempt/internal tenant with no billing_controls row (LEFT JOIN null)', async () => {
    // Internal accounts have agent_execution_allowed = true but no billing_controls row.
    // The LEFT JOIN produces suspended = null, which must not block.
    setupPool({ agent_execution_allowed: true, suspended: null, outstanding_balance_usd: null });
    const result = await checkExecutionAllowed(TENANT_ID);
    expect(result).toEqual({ allowed: true });
  });

  it('a billing_exempt account that is explicitly suspended is still blocked', async () => {
    // billing_exempt suppresses CHARGES, never the operator hard stop. The
    // guard does not read the flag at all — suspended is suspended — and this
    // pins that: an exemption must never become a way to keep running after
    // someone has deliberately stopped the account.
    setupPool({
      agent_execution_allowed: true,
      suspended: true,
      outstanding_balance_usd: '0.00',
    });

    const result = await checkExecutionAllowed(TENANT_ID);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('payment method');
  });

  it('does not read billing_exempt — the guard is not a charge boundary', async () => {
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [{ agent_execution_allowed: true, suspended: false, outstanding_balance_usd: '0.00' }],
      rowCount: 1,
    });
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });

    await checkExecutionAllowed(TENANT_ID);

    expect(String(mockQuery.mock.calls[0][0])).not.toContain('billing_exempt');
  });

  it('hits the DB on each sequential call (no TTL cache)', async () => {
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [{ agent_execution_allowed: true, suspended: false, outstanding_balance_usd: '0.00' }],
      rowCount: 1,
    });
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });

    await checkExecutionAllowed(TENANT_ID);
    await checkExecutionAllowed(TENANT_ID);
    await checkExecutionAllowed(TENANT_ID);

    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('deduplicates concurrent calls — only one DB read for a burst', async () => {
    let resolveQuery!: (v: unknown) => void;
    const mockQuery = jest.fn().mockReturnValue(
      new Promise((res) => { resolveQuery = res; }),
    );
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });

    const [r1, r2, r3] = await Promise.all([
      checkExecutionAllowed(TENANT_ID),
      checkExecutionAllowed(TENANT_ID),
      checkExecutionAllowed(TENANT_ID),
      Promise.resolve().then(() =>
        resolveQuery({ rows: [{ agent_execution_allowed: true, suspended: false, outstanding_balance_usd: '0.00' }], rowCount: 1 }),
      ),
    ]).then(([a, b, c]) => [a, b, c]);

    expect(r1).toEqual({ allowed: true });
    expect(r2).toEqual({ allowed: true });
    expect(r3).toEqual({ allowed: true });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('allows through when the DB read fails (billing gate, not security gate)', async () => {
    (getPool as jest.Mock).mockReturnValue({
      query: jest.fn().mockRejectedValue(new Error('connection timeout')),
    });
    const result = await checkExecutionAllowed(TENANT_ID);
    expect(result).toEqual({ allowed: true });
  });

  it('invalidateExecutionCache is a no-op', async () => {
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [{ agent_execution_allowed: true, suspended: false, outstanding_balance_usd: '0.00' }],
      rowCount: 1,
    });
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery });

    invalidateExecutionCache(TENANT_ID);
    await checkExecutionAllowed(TENANT_ID);
    invalidateExecutionCache(TENANT_ID);
    await checkExecutionAllowed(TENANT_ID);

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

// ── E2E: payment-failure → block → recovery sequence ───────────────────────

describe('TE-004 — full execution block E2E (payment-failure → recovery)', () => {
  it('blocks after suspension and unblocks after recovery', async () => {
    setupPool({ agent_execution_allowed: true, suspended: false, outstanding_balance_usd: '0.00' });
    expect(await checkExecutionAllowed(TENANT_ID)).toEqual({ allowed: true });

    setupPool({ agent_execution_allowed: true, suspended: true, outstanding_balance_usd: '100.00' });
    const afterFailure = await checkExecutionAllowed(TENANT_ID);
    expect(afterFailure.allowed).toBe(false);
    expect(afterFailure.reason).toContain('$100.00');

    setupPool({ agent_execution_allowed: true, suspended: false, outstanding_balance_usd: '0.00' });
    expect(await checkExecutionAllowed(TENANT_ID)).toEqual({ allowed: true });
  });

  it('blocks immediately when subscription is deactivated', async () => {
    setupPool({ agent_execution_allowed: true, suspended: false, outstanding_balance_usd: '0.00' });
    expect(await checkExecutionAllowed(TENANT_ID)).toEqual({ allowed: true });

    setupPool({ agent_execution_allowed: false, suspended: false, outstanding_balance_usd: '0.00' });
    const result = await checkExecutionAllowed(TENANT_ID);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('subscribe');
  });
});
