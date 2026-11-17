// External Agents Provider Tests

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

import { getExternalAgentStats } from '../../data-providers/external-agents-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';

describe('getExternalAgentStats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('should compute per_task cost correctly', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'ea1', name: 'Agent A', cost_type: 'per_task', cost_amount: '5.00' }],
    });

    const stats = await getExternalAgentStats(tenantId, { ea1: { taskCount: 10 } }, 7);
    expect(stats[0].computedCostUsd).toBe(50.0);
    expect(stats[0].taskCount).toBe(10);
  });

  it('should prorate per_month cost', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'ea1', name: 'Agent B', cost_type: 'per_month', cost_amount: '300.00' }],
    });

    const stats = await getExternalAgentStats(tenantId, {}, 15);
    expect(stats[0].computedCostUsd).toBe((300 / 30) * 15);
  });

  it('should handle null cost config', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'ea1', name: 'Agent C', cost_type: null, cost_amount: null }],
    });

    const stats = await getExternalAgentStats(tenantId, {}, 7);
    expect(stats[0].computedCostUsd).toBe(0);
  });

  it('should return empty array when no external agents exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const stats = await getExternalAgentStats(tenantId, {}, 7);
    expect(stats).toEqual([]);
  });

  it('should enforce tenant isolation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getExternalAgentStats(tenantId, {}, 7);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = $1'),
      [tenantId],
    );
  });
});
