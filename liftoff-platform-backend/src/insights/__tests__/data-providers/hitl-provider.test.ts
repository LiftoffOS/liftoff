// HITL Provider Tests
//
// getHitlApprovalStats reads hitl_late_feedback (post-expiry would_approve /
// would_reject decisions). The single SELECT aggregates total + decision
// counts + average decision time.

const mockQuery = jest.fn();
(global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery = mockQuery;

jest.mock('../../../infrastructure/database', () => {
  const __db: any = {
  getPool: () => ({
    query: (...args: unknown[]) =>
      (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args),
  }),
};
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__db.getPool());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__db.getPool());
  return __db;
});

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { getHitlApprovalStats } from '../../data-providers/hitl-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';
const range = {
  start: new Date('2026-04-01T00:00:00Z'),
  end: new Date('2026-04-08T00:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe('getHitlApprovalStats', () => {
  it('returns aggregated stats from a single row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          total: '20',
          approved: '14',
          rejected: '6',
          avg_decision_time_ms: '1234.5',
        },
      ],
    });

    const result = await getHitlApprovalStats(tenantId, range);

    expect(result).not.toBeNull();
    expect(result!.totalApprovals).toBe(20);
    expect(result!.approvedCount).toBe(14);
    expect(result!.rejectedCount).toBe(6);
    expect(result!.avgDecisionTimeMs).toBeCloseTo(1234.5);
    // pendingCount + expiredCount are not tracked here
    expect(result!.pendingCount).toBe(0);
    expect(result!.expiredCount).toBe(0);
  });

  it('returns zero counts and null avgDecisionTime when no rows in range', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '0', approved: '0', rejected: '0', avg_decision_time_ms: null }],
    });

    const result = await getHitlApprovalStats(tenantId, range);

    expect(result).not.toBeNull();
    expect(result!.totalApprovals).toBe(0);
    expect(result!.approvedCount).toBe(0);
    expect(result!.rejectedCount).toBe(0);
    expect(result!.avgDecisionTimeMs).toBeNull();
  });

  it('handles partial data (some null fields) without crashing', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: null, approved: null, rejected: null, avg_decision_time_ms: null }],
    });

    const result = await getHitlApprovalStats(tenantId, range);

    expect(result).not.toBeNull();
    expect(result!.totalApprovals).toBe(0);
    expect(result!.approvedCount).toBe(0);
    expect(result!.rejectedCount).toBe(0);
    expect(result!.avgDecisionTimeMs).toBeNull();
  });

  it('returns null when the query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));
    const result = await getHitlApprovalStats(tenantId, range);
    expect(result).toBeNull();
  });

  it('passes tenantId + range bind params for tenant isolation', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '0', approved: '0', rejected: '0', avg_decision_time_ms: null }],
    });

    await getHitlApprovalStats(tenantId, range);

    expect(mockQuery.mock.calls[0][1]).toEqual([tenantId, range.start, range.end]);
    expect(mockQuery.mock.calls[0][0]).toContain('hitl_late_feedback');
    expect(mockQuery.mock.calls[0][0]).toContain('would_approve');
  });
});
