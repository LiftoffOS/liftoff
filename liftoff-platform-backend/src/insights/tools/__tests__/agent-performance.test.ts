// get_agent_performance tool tests.
//
// Stubs the data-providers module so we don't hit the DB or Tenant Runtime.
// Verifies the tool's contract: time range parsing, comparison expansion,
// totals computation, and the role check (delegated to dispatcher elsewhere).

jest.mock('../../data-providers', () => ({
  getInternalAgents: jest.fn(),
  getAgentCosts: jest.fn(),
  getPerAgentAuditStats: jest.fn(),
  buildInternalAgentStats: jest.fn(),
}));

import {
  getInternalAgents,
  getAgentCosts,
  getPerAgentAuditStats,
  buildInternalAgentStats,
} from '../../data-providers';
import { getAgentPerformanceTool } from '../agent-performance';
import type { InsightsToolContext } from '../types';
import type { InternalAgentStats } from '../../types';

const ctx: InsightsToolContext = {
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'owner',
};

const FAKE_STATS: InternalAgentStats[] = [
  {
    agentId: 'a1',
    agentName: 'Salesforce Sync',
    role: 'salesforce_sync',
    status: 'active',
    taskCount: 100,
    costUsd: 12.5,
    successRate: 0.92,
    errorCount: 8,
  },
  {
    agentId: 'a2',
    agentName: 'Inbox Triage',
    role: 'inbox_triage',
    status: 'active',
    taskCount: 50,
    costUsd: 4.25,
    successRate: 1.0,
    errorCount: 0,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  (getInternalAgents as jest.Mock).mockResolvedValue([
    { id: 'a1', name: 'Salesforce Sync', role: 'salesforce_sync', status: 'active' },
    { id: 'a2', name: 'Inbox Triage', role: 'inbox_triage', status: 'active' },
  ]);
  (getAgentCosts as jest.Mock).mockResolvedValue({
    a1: { totalCostUsd: 12.5, invocationCount: 100 },
    a2: { totalCostUsd: 4.25, invocationCount: 50 },
  });
  (getPerAgentAuditStats as jest.Mock).mockResolvedValue({
    a1: { successCount: 92, errorCount: 8, totalCount: 100 },
    a2: { successCount: 50, errorCount: 0, totalCount: 50 },
  });
  (buildInternalAgentStats as jest.Mock).mockReturnValue(FAKE_STATS);
});

describe('get_agent_performance tool', () => {
  it('exposes its definition with required schema fields', () => {
    expect(getAgentPerformanceTool.definition.name).toBe('get_agent_performance');
    expect(getAgentPerformanceTool.definition.description).toContain('agent');
    expect(getAgentPerformanceTool.definition.input_schema.properties).toHaveProperty('time_range');
    expect(getAgentPerformanceTool.definition.input_schema.properties).toHaveProperty('compare_to');
  });

  it('returns agents + totals + period for a valid time range', async () => {
    const result = await getAgentPerformanceTool.execute(
      { time_range: { preset: 'this_week' } },
      ctx,
    );

    expect(result).toMatchObject({
      period: { start: expect.any(String), end: expect.any(String) },
      agents: FAKE_STATS,
      totals: {
        totalAgents: 2,
        totalTasks: 150,
        totalCostUsd: 16.75,
        totalErrors: 8,
      },
    });
  });

  it('passes the resolved tenant id to every data provider', async () => {
    await getAgentPerformanceTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    expect(getInternalAgents).toHaveBeenCalledWith('tenant-1');
    expect(getAgentCosts).toHaveBeenCalledWith('tenant-1', expect.any(Object));
    expect(getPerAgentAuditStats).toHaveBeenCalledWith('tenant-1', expect.any(Object));
  });

  it('expands comparison when compare_to is provided', async () => {
    const result = await getAgentPerformanceTool.execute(
      {
        time_range: { preset: 'this_week' },
        compare_to: { preset: 'last_week' },
      },
      ctx,
    );

    expect(result.comparison).toBeDefined();
    expect(result.comparison?.period).toBeDefined();
    expect(result.comparison?.totals.totalAgents).toBe(2);
    // Both periods should have triggered the data calls
    expect(getInternalAgents).toHaveBeenCalledTimes(2);
    expect(getAgentCosts).toHaveBeenCalledTimes(2);
    expect(getPerAgentAuditStats).toHaveBeenCalledTimes(2);
  });

  it('omits comparison when compare_to is absent', async () => {
    const result = await getAgentPerformanceTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    expect(result.comparison).toBeUndefined();
  });

  it('throws when time_range is missing entirely (executor surfaces it as a tool error)', async () => {
    await expect(
      getAgentPerformanceTool.execute({}, ctx),
    ).rejects.toThrow(/time_range is required/);
    // Data providers should not have been called
    expect(getAgentCosts).not.toHaveBeenCalled();
  });

  it('throws when time_range is malformed (string instead of object)', async () => {
    await expect(
      getAgentPerformanceTool.execute({ time_range: 'this_week' }, ctx),
    ).rejects.toThrow(/time_range is required/);
  });

  it('handles null AgentCosts (Tenant Runtime unreachable) gracefully', async () => {
    (getAgentCosts as jest.Mock).mockResolvedValue(null);
    const result = await getAgentPerformanceTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    // buildInternalAgentStats should have been called with {} when costs are null
    expect(buildInternalAgentStats).toHaveBeenCalledWith(expect.any(Array), {}, expect.any(Object));
    expect(result.totals.totalAgents).toBe(2); // still works
  });
});
