// Tenant Members Provider Tests
//
// Two methods:
//   getTenantMembers   — straightforward SELECT against tenant_members + accounts
//   getMemberActivity  — combines members-in-window CTE with getHumanTaskCounts,
//                        then optionally backfills display names for former
//                        members who had activity but are no longer in
//                        tenant_members. The "former member backfill" branch
//                        is the trickiest to get right and gets a dedicated
//                        test.

const mockQuery = jest.fn();
(global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery = mockQuery;

jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({
    query: (...args: unknown[]) =>
      (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args),
  }),
  // tenant-members-provider now wraps tenant_members + tenant_member_audit
  // reads in withTenantScope. The fake client delegates query() to the same
  // global mock so existing mockResolvedValueOnce chains keep working.
  withTenantScope: jest.fn(
    async (
      _tenantId: string,
      fn: (client: { query: typeof mockQuery }) => Promise<unknown>,
    ) =>
      fn({
        query: (...args: unknown[]) =>
          (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args),
      }),
  ),
}));

const mockGetHumanTaskCounts = jest.fn();
jest.mock('../../../human-feedback/human-task-counts', () => ({
  getHumanTaskCounts: (...args: unknown[]) => mockGetHumanTaskCounts(...args),
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import {
  getTenantMembers,
  getMemberActivity,
} from '../../data-providers/tenant-members-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';
const range = {
  start: new Date('2026-04-01T00:00:00Z'),
  end: new Date('2026-04-08T00:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

// ── getTenantMembers ───────────────────────────────────────────────────

describe('getTenantMembers', () => {
  it('returns mapped tenant members', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          account_id: 'a1',
          display_name: 'Alice Owner',
          email: 'alice@example.com',
          role: 'owner',
        },
        {
          account_id: 'a2',
          display_name: 'Bob Member',
          email: 'bob@example.com',
          role: 'member',
        },
      ],
    });

    const result = await getTenantMembers(tenantId);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      accountId: 'a1',
      displayName: 'Alice Owner',
      email: 'alice@example.com',
      role: 'owner',
    });
    expect(result[1].role).toBe('member');
  });

  it('returns empty array when tenant has no members', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getTenantMembers(tenantId);
    expect(result).toEqual([]);
  });

  it('returns empty array on query error (fail-soft)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));
    const result = await getTenantMembers(tenantId);
    expect(result).toEqual([]);
  });

  it('passes tenantId for tenant isolation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTenantMembers(tenantId);
    expect(mockQuery.mock.calls[0][1]).toEqual([tenantId]);
    expect(mockQuery.mock.calls[0][0]).toContain('tm.tenant_id = $1');
  });
});

// ── getMemberActivity ──────────────────────────────────────────────────

describe('getMemberActivity', () => {
  it('returns members in window with their task counts, sorted by total activity', async () => {
    // members-in-window CTE result
    mockQuery.mockResolvedValueOnce({
      rows: [
        { account_id: 'a1', display_name: 'Alice' },
        { account_id: 'a2', display_name: 'Bob' },
      ],
    });

    mockGetHumanTaskCounts.mockResolvedValueOnce({
      a1: { approvalCount: 5, correctionCount: 3 }, // total 8
      a2: { approvalCount: 12, correctionCount: 1 }, // total 13
    });

    const result = await getMemberActivity(tenantId, range);

    expect(result).toHaveLength(2);
    // Sorted desc by approval+correction total → Bob first
    expect(result[0]).toEqual({
      accountId: 'a2',
      displayName: 'Bob',
      approvalCount: 12,
      correctionCount: 1,
    });
    expect(result[1].accountId).toBe('a1');
  });

  it('includes members in window who had zero activity', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ account_id: 'a1', display_name: 'Alice' }],
    });
    mockGetHumanTaskCounts.mockResolvedValueOnce({});

    const result = await getMemberActivity(tenantId, range);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      accountId: 'a1',
      displayName: 'Alice',
      approvalCount: 0,
      correctionCount: 0,
    });
  });

  it('backfills display names for former members who had activity', async () => {
    // Window members: only Alice
    mockQuery.mockResolvedValueOnce({
      rows: [{ account_id: 'a1', display_name: 'Alice' }],
    });
    // But task counts include Charlie (former member)
    mockGetHumanTaskCounts.mockResolvedValueOnce({
      a1: { approvalCount: 2, correctionCount: 0 },
      'former-charlie': { approvalCount: 4, correctionCount: 1 },
    });
    // Backfill query for the orphan account_id
    mockQuery.mockResolvedValueOnce({
      rows: [{ account_id: 'former-charlie', display_name: 'Charlie (former)' }],
    });

    const result = await getMemberActivity(tenantId, range);

    expect(result).toHaveLength(2);
    const charlie = result.find(r => r.accountId === 'former-charlie');
    expect(charlie).toBeDefined();
    expect(charlie!.displayName).toBe('Charlie (former)');
    expect(charlie!.approvalCount).toBe(4);
    expect(charlie!.correctionCount).toBe(1);
    // Sorted: Charlie (5) first, Alice (2) second
    expect(result[0].accountId).toBe('former-charlie');
  });

  it('skips the backfill query when there are no orphan accounts', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ account_id: 'a1', display_name: 'Alice' }],
    });
    mockGetHumanTaskCounts.mockResolvedValueOnce({
      a1: { approvalCount: 1, correctionCount: 1 },
    });

    await getMemberActivity(tenantId, range);

    // Only the in-window CTE query should have run — no backfill
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns empty array on query error (fail-soft)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    mockGetHumanTaskCounts.mockResolvedValueOnce({});
    const result = await getMemberActivity(tenantId, range);
    expect(result).toEqual([]);
  });

  it('passes tenantId + range params to the in-window query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockGetHumanTaskCounts.mockResolvedValueOnce({});
    await getMemberActivity(tenantId, range);
    expect(mockQuery.mock.calls[0][1]).toEqual([tenantId, range.start, range.end]);
    expect(mockGetHumanTaskCounts).toHaveBeenCalledWith(
      tenantId,
      range.start,
      range.end,
    );
  });
});
