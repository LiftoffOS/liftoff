// get_execution_trends tool tests.

jest.mock('../../data-providers', () => ({
  getAuditLogAggregation: jest.fn(),
  getInvocationStats: jest.fn(),
}));

import { getAuditLogAggregation, getInvocationStats } from '../../data-providers';
import { getExecutionTrendsTool } from '../execution-trends';
import type { InsightsToolContext } from '../types';
import type { AuditLogAggregation, InvocationStats } from '../../types';

const ctx: InsightsToolContext = {
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'owner',
};

const FAKE_AUDIT: AuditLogAggregation = {
  timeBreakdown: [
    { date: '2026-04-01', count: 100, successCount: 92, errorCount: 8, humanCount: 5, aiCount: 95 },
    { date: '2026-04-02', count: 120, successCount: 110, errorCount: 10, humanCount: 8, aiCount: 112 },
  ],
  topAgents: [
    { agentId: 'a1', agentName: 'Salesforce Sync', actionCount: 150, successRate: 0.92 },
  ],
  totalActions: 220,
  totalSuccess: 202,
  totalErrors: 18,
  avgDurationMs: 1234,
};

const FAKE_INVOCATIONS: InvocationStats = {
  totalCostUsd: 12.5,
  totalInputTokens: 100000,
  totalOutputTokens: 25000,
  invocationCount: 220,
};

beforeEach(() => {
  jest.clearAllMocks();
  (getAuditLogAggregation as jest.Mock).mockResolvedValue(FAKE_AUDIT);
  (getInvocationStats as jest.Mock).mockResolvedValue(FAKE_INVOCATIONS);
});

describe('get_execution_trends tool', () => {
  it('exposes its definition with the expected schema', () => {
    expect(getExecutionTrendsTool.definition.name).toBe('get_execution_trends');
    expect(getExecutionTrendsTool.definition.input_schema.properties).toHaveProperty('time_range');
    expect(getExecutionTrendsTool.definition.input_schema.properties).toHaveProperty('compare_to');
    expect(getExecutionTrendsTool.definition.input_schema.properties).toHaveProperty('grouping');
  });

  it('returns audit + invocations + period for a valid time range', async () => {
    const result = await getExecutionTrendsTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    expect(result.audit).toEqual(FAKE_AUDIT);
    expect(result.invocations).toEqual(FAKE_INVOCATIONS);
    expect(result.period).toBeDefined();
    expect(result.grouping).toBeDefined();
  });

  it('chooses hour grouping for ranges <= 48h', async () => {
    await getExecutionTrendsTool.execute({ time_range: { preset: 'today' } }, ctx);
    expect(getAuditLogAggregation).toHaveBeenCalledWith('tenant-1', expect.any(Object), 'hour');
  });

  it('chooses day grouping for ranges <= 90d', async () => {
    await getExecutionTrendsTool.execute({ time_range: { preset: 'last_30_days' } }, ctx);
    expect(getAuditLogAggregation).toHaveBeenCalledWith('tenant-1', expect.any(Object), 'day');
  });

  it('chooses month grouping for ranges > 90d', async () => {
    await getExecutionTrendsTool.execute({ time_range: { preset: 'this_year' } }, ctx);
    expect(getAuditLogAggregation).toHaveBeenCalledWith('tenant-1', expect.any(Object), 'month');
  });

  it('respects an explicit grouping override', async () => {
    await getExecutionTrendsTool.execute(
      { time_range: { preset: 'this_year' }, grouping: 'day' },
      ctx,
    );
    expect(getAuditLogAggregation).toHaveBeenCalledWith('tenant-1', expect.any(Object), 'day');
  });

  it('expands comparison and uses the same grouping for both', async () => {
    const result = await getExecutionTrendsTool.execute(
      {
        time_range: { preset: 'last_7_days' },
        compare_to: { preset: 'last_30_days' },
      },
      ctx,
    );
    expect(result.comparison).toBeDefined();
    expect(getAuditLogAggregation).toHaveBeenCalledTimes(2);
    // Both calls should use the same grouping (chosen from the primary range)
    const calls = (getAuditLogAggregation as jest.Mock).mock.calls;
    expect(calls[0][2]).toBe(calls[1][2]);
  });

  it('handles null audit and invocations gracefully', async () => {
    (getAuditLogAggregation as jest.Mock).mockResolvedValue(null);
    (getInvocationStats as jest.Mock).mockResolvedValue(null);
    const result = await getExecutionTrendsTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    expect(result.audit).toBeNull();
    expect(result.invocations).toBeNull();
  });
});
