// Corrections Provider Tests
//
// getCorrectionStats runs two queries: total count, then top-10 by-agent.
// Tests cover happy path, empty result, error path, tenant isolation, and
// the LEFT JOIN fallback for orphaned agent_id (display agent_id when
// internal_agents row is missing).

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

import { getCorrectionStats } from '../../data-providers/corrections-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';
const range = {
  start: new Date('2026-04-01T00:00:00Z'),
  end: new Date('2026-04-08T00:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe('getCorrectionStats', () => {
  it('returns aggregated stats with by-agent breakdown', async () => {
    // 1st: total count
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '12' }] });
    // 2nd: by-agent
    mockQuery.mockResolvedValueOnce({
      rows: [
        { internal_agent_id: 'a1', agent_name: 'Salesforce Sync', correction_count: '7' },
        { internal_agent_id: 'a2', agent_name: 'Inbox Triage', correction_count: '5' },
      ],
    });

    const result = await getCorrectionStats(tenantId, range);

    expect(result).not.toBeNull();
    expect(result!.totalCorrections).toBe(12);
    expect(result!.byAgent).toEqual([
      { agentId: 'a1', agentName: 'Salesforce Sync', correctionCount: 7 },
      { agentId: 'a2', agentName: 'Inbox Triage', correctionCount: 5 },
    ]);
  });

  it('falls back to internal_agent_id when the joined agent name is null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '3' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { internal_agent_id: 'orphan-id', agent_name: null, correction_count: '3' },
      ],
    });

    const result = await getCorrectionStats(tenantId, range);

    expect(result!.byAgent[0].agentName).toBe('orphan-id');
  });

  it('returns zero totals + empty byAgent when no corrections in range', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getCorrectionStats(tenantId, range);

    expect(result!.totalCorrections).toBe(0);
    expect(result!.byAgent).toEqual([]);
  });

  it('handles missing total row gracefully (parseInt undefined → 0)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: null }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getCorrectionStats(tenantId, range);

    expect(result!.totalCorrections).toBe(0);
  });

  it('returns null when either query throws', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '5' }] });
    mockQuery.mockRejectedValueOnce(new Error('by-agent query failed'));

    const result = await getCorrectionStats(tenantId, range);

    expect(result).toBeNull();
  });

  it('passes tenantId + range bind params on both queries for tenant isolation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getCorrectionStats(tenantId, range);

    expect(mockQuery.mock.calls[0][1]).toEqual([tenantId, range.start, range.end]);
    expect(mockQuery.mock.calls[1][1]).toEqual([tenantId, range.start, range.end]);
    expect(mockQuery.mock.calls[0][0]).toContain('correction_of IS NOT NULL');
  });
});
