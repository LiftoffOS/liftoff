// Audit Logs Provider Tests

const mockQuery = jest.fn();
(global as any).__mockQuery = mockQuery;

jest.mock('../../../infrastructure/database', () => {
  const __db: any = {
  getPool: () => ({
    query: (...args: unknown[]) => (global as any).__mockQuery(...args),
  }),
};
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__db.getPool());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__db.getPool());
  return __db;
});

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { getAuditLogAggregation, getPerAgentAuditStats } from '../../data-providers/audit-logs-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';
const range = {
  start: new Date('2024-06-01T00:00:00Z'),
  end: new Date('2024-06-30T23:59:59Z'),
};

describe('getAuditLogAggregation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('should return aggregated data', async () => {
    // Daily breakdown query
    mockQuery.mockResolvedValueOnce({
      rows: [
        { date: new Date('2024-06-01'), count: '10', success_count: '8', error_count: '2' },
      ],
    });
    // Top agents query
    mockQuery.mockResolvedValueOnce({
      rows: [{ internal_agent_id: 'a1', agent_name: 'Bot', action_count: '50', success_rate: '0.9' }],
    });
    // Totals query
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_actions: '100', total_success: '90', total_errors: '10' }],
    });

    const result = await getAuditLogAggregation(tenantId, range);
    expect(result).not.toBeNull();
    expect(result!.totalActions).toBe(100);
    expect(result!.totalSuccess).toBe(90);
    expect(result!.totalErrors).toBe(10);
    expect(result!.timeBreakdown).toHaveLength(1);
    expect(result!.topAgents).toHaveLength(1);
  });

  it('should return null on error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const result = await getAuditLogAggregation(tenantId, range);
    expect(result).toBeNull();
  });

  it('should handle empty results', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total_actions: '0', total_success: '0', total_errors: '0' }] });

    const result = await getAuditLogAggregation(tenantId, range);
    expect(result).not.toBeNull();
    expect(result!.totalActions).toBe(0);
    expect(result!.timeBreakdown).toEqual([]);
    expect(result!.topAgents).toEqual([]);
  });
});

describe('getPerAgentAuditStats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('should return per-agent stats keyed by agent_id', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { internal_agent_id: 'a1', total_count: '10', success_count: '8', error_count: '2' },
        { internal_agent_id: 'a2', total_count: '5', success_count: '5', error_count: '0' },
      ],
    });

    const stats = await getPerAgentAuditStats(tenantId, range);
    expect(stats['a1'].totalCount).toBe(10);
    expect(stats['a1'].errorCount).toBe(2);
    expect(stats['a2'].successCount).toBe(5);
  });

  it('should return empty object on error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const stats = await getPerAgentAuditStats(tenantId, range);
    expect(stats).toEqual({});
  });
});
