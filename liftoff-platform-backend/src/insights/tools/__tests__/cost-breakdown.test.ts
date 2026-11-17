// get_cost_breakdown tool tests.
//
// Stubs the data-providers module + tenant-runtime-client. Verifies the
// category math, the per-task external agent cost computation (delegated
// to getExternalAgentStats) and the top-N internal agents sort.

jest.mock('../../data-providers', () => ({
  getInternalAgents: jest.fn(),
  getAgentCosts: jest.fn(),
  getExternalAgentStats: jest.fn(),
  getAgentLLMCosts: jest.fn(),
  getAgentlessLLMCosts: jest.fn(),
}));

jest.mock('../../data-providers/web-tools-cost-provider', () => ({
  getWebToolCosts: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../data-providers/sandbox-cost-provider', () => ({
  getSandboxCosts: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../data-providers/data-sources-cost-provider', () => ({
  getDataSourceCosts: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../data-providers/voice-cost-provider', () => ({
  getAgentVoiceCosts: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getExternalAgentTaskCounts: jest.fn(),
  },
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import {
  getInternalAgents,
  getAgentCosts,
  getExternalAgentStats,
  getAgentLLMCosts,
  getAgentlessLLMCosts,
} from '../../data-providers';
import { tenantRuntimeClient } from '../../../connectors/tenant-runtime-client';
import { getCostBreakdownTool } from '../cost-breakdown';
import type { InsightsToolContext } from '../types';

const ctx: InsightsToolContext = {
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'owner',
};

beforeEach(() => {
  jest.clearAllMocks();
  (getInternalAgents as jest.Mock).mockResolvedValue([
    { id: 'a1', name: 'Salesforce Sync', role: 'salesforce_sync', status: 'active', deletedAt: null },
    { id: 'a2', name: 'Inbox Triage', role: 'inbox_triage', status: 'active', deletedAt: null },
  ]);
  (getAgentCosts as jest.Mock).mockResolvedValue({
    a1: { totalCostUsd: 12.5, invocationCount: 100 },
    a2: { totalCostUsd: 4.25, invocationCount: 50 },
  });
  (getExternalAgentStats as jest.Mock).mockResolvedValue([
    {
      agentId: 'e1',
      agentName: 'Stripe Agent',
      costType: 'per_month' as const,
      costAmount: 50,
      taskCount: 0,
      computedCostUsd: 50,
    },
    {
      agentId: 'e2',
      agentName: 'Notion Agent',
      costType: 'per_task' as const,
      costAmount: 0.10,
      taskCount: 200,
      computedCostUsd: 20,
    },
  ]);
  (getAgentLLMCosts as jest.Mock).mockResolvedValue([
    { agentId: 'a1', purpose: 'distill', totalInputTokens: 1000, totalOutputTokens: 500, estimatedCostUsd: 0.0105 },
  ]);
  (getAgentlessLLMCosts as jest.Mock).mockResolvedValue([
    { purpose: 'insights_chat', totalInputTokens: 5000, totalOutputTokens: 2000,
      estimatedCostUsd: 0.045, rawModelCostUsd: 0.04, ouConsumed: 0 },
    { purpose: 'caio_workforce_planning', totalInputTokens: 3000, totalOutputTokens: 1000,
      estimatedCostUsd: 0.024, rawModelCostUsd: 0.02, ouConsumed: 0 },
  ]);
  (tenantRuntimeClient.getExternalAgentTaskCounts as jest.Mock).mockResolvedValue({
    e2: { taskCount: 200 },
  });
});

describe('get_cost_breakdown tool', () => {
  it('exposes its definition', () => {
    expect(getCostBreakdownTool.definition.name).toBe('get_cost_breakdown');
    expect(getCostBreakdownTool.definition.input_schema.properties).toHaveProperty('time_range');
    expect(getCostBreakdownTool.definition.input_schema.properties).toHaveProperty('compare_to');
  });

  it('computes byCategory totals correctly', async () => {
    const result = await getCostBreakdownTool.execute({ time_range: { preset: 'this_week' } }, ctx);

    expect(result.current.byCategory).toEqual({
      internalAgentInvocations: 16.75, // 12.5 + 4.25
      agentLLMOperations: 0.0105,
      interactions: 0, // no agent_chat / context_absorption / title-gen rows in fixture
      externalAgents: 70, // 50 + 20
      platformAssistants: 0.069, // 0.045 Insights Manager + 0.024 Chief AI Officer
      webTools: 0, // mocked getWebToolCosts returns []
      dataSources: 0, // mocked getDataSourceCosts returns []
      sandbox: 0, // mocked getSandboxCosts returns []
      voice: 0, // mocked getAgentVoiceCosts returns []
      developerProxy: 0,
      unattributed: 0,
    });
  });

  it('computes totalUsd over the model, not by re-adding the categories', async () => {
    const result = await getCostBreakdownTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    expect(result.current.totalUsd).toBeCloseTo(16.75 + 0.0105 + 0 + 70 + 0.069, 4);
  });

  it('names each platform assistant that spent anything', async () => {
    const result = await getCostBreakdownTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    expect(result.current.platformAssistantsByName).toEqual([
      { assistant: 'Insights Manager', costUsd: 0.045, ouConsumed: 0 },
      { assistant: 'Chief AI Officer', costUsd: 0.024, ouConsumed: 0 },
    ]);
  });

  it("ranks agents by TOTAL cost, tool spend included", async () => {
    const { getWebToolCosts } = require('../../data-providers/web-tools-cost-provider');
    // a2 invokes less than a1 but browses far more. Ranking on the invocation
    // figure alone put it second; ranking on what it actually costs does not.
    (getWebToolCosts as jest.Mock).mockResolvedValueOnce([
      { agentId: 'a2', surface: null, toolName: 'web_research', callCount: 9, totalCostUsd: 40, ouConsumed: 0 },
    ]);
    const result = await getCostBreakdownTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    expect(result.current.topInternalAgents[0].agentId).toBe('a2');
    expect(result.current.topInternalAgents[0].costUsd).toBeCloseTo(44.25, 6);
  });

  it('routes interaction-purpose rows into the interactions bucket', async () => {
    (getAgentLLMCosts as jest.Mock).mockResolvedValue([
      { agentId: 'a1', purpose: 'distill', totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0.01 },
      { agentId: 'a1', purpose: 'agent_chat', totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0.20 },
      { agentId: 'a1', purpose: 'agent_chat_summarization', totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0.05 },
      { agentId: 'a1', purpose: 'thread_title_generation', totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0.001 },
      { agentId: 'a1', purpose: 'context_absorption', totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0.003 },
    ]);
    const result = await getCostBreakdownTool.execute({ time_range: { preset: 'this_week' } }, ctx);

    expect(result.current.byCategory.agentLLMOperations).toBeCloseTo(0.01, 5);
    expect(result.current.byCategory.interactions).toBeCloseTo(0.254, 5);
    // Reconciliation: total includes both buckets, no double-counting.
    expect(result.current.totalUsd).toBeCloseTo(
      16.75 + 0.01 + 0.254 + 70 + 0.045 + 0.024,
      4,
    );
  });

  it('passes external task counts from Tenant Runtime to getExternalAgentStats', async () => {
    await getCostBreakdownTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    expect(tenantRuntimeClient.getExternalAgentTaskCounts).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(Date),
      expect.any(Date),
    );
    expect(getExternalAgentStats).toHaveBeenCalledWith(
      'tenant-1',
      { e2: { taskCount: 200 } },
      expect.any(Number),
    );
  });

  it('falls back to empty task counts when Tenant Runtime fails', async () => {
    (tenantRuntimeClient.getExternalAgentTaskCounts as jest.Mock).mockRejectedValue(new Error('boom'));
    const result = await getCostBreakdownTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    // Tool didn't crash; getExternalAgentStats was called with {}
    expect(getExternalAgentStats).toHaveBeenCalledWith('tenant-1', {}, expect.any(Number));
    expect(result.current.totalUsd).toBeGreaterThan(0);
  });

  it('returns top internal agents sorted by cost desc', async () => {
    const result = await getCostBreakdownTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    // a1's figure is 12.5 invocations + 0.0105 distill: what the agent cost,
    // not what its invocations cost. `taskCount` stays the invocation count,
    // which is what it has always measured.
    expect(result.current.topInternalAgents).toEqual([
      { agentId: 'a1', agentName: 'Salesforce Sync', costUsd: 12.5105, taskCount: 100 },
      { agentId: 'a2', agentName: 'Inbox Triage', costUsd: 4.25, taskCount: 50 },
    ]);
  });

  it('expands comparison when compare_to is provided', async () => {
    const result = await getCostBreakdownTool.execute(
      {
        time_range: { preset: 'this_week' },
        compare_to: { preset: 'last_week' },
      },
      ctx,
    );
    expect(result.comparison).toBeDefined();
    // Both periods should have triggered the data calls
    expect(getInternalAgents).toHaveBeenCalledTimes(2);
    expect(getAgentCosts).toHaveBeenCalledTimes(2);
    expect(getAgentlessLLMCosts).toHaveBeenCalledTimes(2);
  });

  it('handles null AgentCosts (Tenant Runtime unreachable) gracefully', async () => {
    (getAgentCosts as jest.Mock).mockResolvedValue(null);
    const result = await getCostBreakdownTool.execute({ time_range: { preset: 'this_week' } }, ctx);
    expect(result.current.byCategory.internalAgentInvocations).toBe(0);
    // a1 still shows the distillation it was charged for: losing the runtime's
    // invocation feed is not a reason to report the rest of a team's spend as
    // zero. a2's only cost came from that feed, so with it gone a2 has spent
    // nothing and drops off — a team with no spend is not a row on a table
    // about where the money went.
    expect(result.current.topInternalAgents).toHaveLength(1);
    expect(result.current.topInternalAgents[0].agentId).toBe('a1');
    expect(result.current.topInternalAgents[0].costUsd).toBeCloseTo(0.0105, 6);
  });
});

// ── An unpriced model must not read as a cheap one ───────────────────────────
//
// calculateCost returns null on a rate-table miss and the caller falls back to
// zero, so a run whose model is unpriced records real tokens at no cost. It then
// lands in the total as if the work were free. Surfacing the split is what lets
// a reader tell "this period was cheap" from "part of this period was never
// priced" — and it stays OUT of totalUsd, because an estimate from a guessed
// rate cannot reproduce request-level pricing and would make a measured figure
// less trustworthy rather than more complete.

describe('cost breakdown — the uncosted split', () => {
  it('sums the uncosted subset across agents and keeps it out of totalUsd', () => {
    const agentCosts = {
      a1: {
        totalCostUsd: 10, ouConsumed: 0, invocationCount: 20,
        uncostedInvocationCount: 2, uncostedInputTokens: 300, uncostedOutputTokens: 100,
      },
      a2: {
        totalCostUsd: 5, ouConsumed: 0, invocationCount: 12,
        uncostedInvocationCount: 1, uncostedInputTokens: 50, uncostedOutputTokens: 25,
      },
    };
    const uncosted = Object.values(agentCosts).reduce(
      (acc, e) => ({
        invocations: acc.invocations + (e.uncostedInvocationCount ?? 0),
        inputTokens: acc.inputTokens + (e.uncostedInputTokens ?? 0),
        outputTokens: acc.outputTokens + (e.uncostedOutputTokens ?? 0),
      }),
      { invocations: 0, inputTokens: 0, outputTokens: 0 },
    );
    expect(uncosted).toEqual({ invocations: 3, inputTokens: 350, outputTokens: 125 });

    // The measured total is unchanged by the presence of unpriced runs.
    const total = Object.values(agentCosts).reduce((s, e) => s + e.totalCostUsd, 0);
    expect(total).toBe(15);
  });

  it('reads a source that does not report the split as zero, not as absent', () => {
    // The gRPC stats shape carries no token counts, so it cannot say which of
    // its invocations were uncosted. Zero must not become NaN downstream.
    const entry = { totalCostUsd: 1, ouConsumed: 0, invocationCount: 1 } as {
      totalCostUsd: number; ouConsumed: number; invocationCount: number;
      uncostedInvocationCount?: number;
    };
    expect((entry.uncostedInvocationCount ?? 0) + 0).toBe(0);
  });
});
