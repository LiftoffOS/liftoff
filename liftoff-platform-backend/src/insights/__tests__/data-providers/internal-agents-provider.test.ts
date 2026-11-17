// Internal Agents Provider Tests
// Tests: null, empty, tenant isolation, correct mapping

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

import { getInternalAgents, buildInternalAgentStats } from '../../data-providers/internal-agents-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';

describe('getInternalAgents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('should return agents for a tenant', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'a1', role: 'Sales Outreach', status: 'active', created_at: new Date() },
        { id: 'a2', role: 'Support Bot', status: 'draft', created_at: new Date() },
      ],
    });

    const agents = await getInternalAgents(tenantId);
    expect(agents).toHaveLength(2);
    expect(agents[0]).toEqual({
      id: 'a1', name: 'Sales Outreach', role: 'Sales Outreach', status: 'active', deletedAt: null,
    });
  });

  it('should return empty array when no agents exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const agents = await getInternalAgents(tenantId);
    expect(agents).toEqual([]);
  });

  it('should pass tenantId for tenant isolation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getInternalAgents(tenantId);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = $1'),
      [tenantId, false],
    );
  });

  // Removing an agent must not remove its spend from /insights along with it:
  // the Cost Breakdown and the Total Cost card both iterate this list, so a
  // team deleted mid-period would take its whole cost off the page — charged
  // and rendered nowhere.
  it('excludes removed agents by default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getInternalAgents(tenantId);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('deleted_at IS NULL');
    expect(params[1]).toBe(false);
  });

  it('includes them when asked, flagged so the caller can say so', async () => {
    const deletedAt = new Date('2026-09-01T00:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'a3', role: 'Old Team', status: 'paused', created_at: new Date(), deleted_at: deletedAt }],
    });

    const agents = await getInternalAgents(tenantId, { includeDeleted: true });

    expect(mockQuery.mock.calls[0][1][1]).toBe(true);
    expect(agents[0].deletedAt).toEqual(deletedAt);
  });
});

describe('buildInternalAgentStats', () => {
  it('should combine agent data with cost and audit data', () => {
    const agents = [
      { id: 'a1', name: 'Sales', role: 'Sales', status: 'active', deletedAt: null },
    ];
    const costData = { a1: { totalCostUsd: 10.5, invocationCount: 42 } };
    const auditData = { a1: { successCount: 38, errorCount: 4, totalCount: 42 } };

    const stats = buildInternalAgentStats(agents, costData, auditData);
    expect(stats[0].taskCount).toBe(42);
    expect(stats[0].costUsd).toBe(10.5);
    expect(stats[0].successRate).toBeCloseTo(38 / 42);
    expect(stats[0].errorCount).toBe(4);
  });

  it('should handle agent with no cost or audit data', () => {
    const agents = [{ id: 'a1', name: 'New Agent', role: 'New', status: 'draft' }];
    const stats = buildInternalAgentStats(agents, {}, {});
    expect(stats[0].taskCount).toBe(0);
    expect(stats[0].costUsd).toBe(0);
    expect(stats[0].successRate).toBe(0);
    expect(stats[0].errorCount).toBe(0);
  });
});
