// get_agent_performance Tool
//
// Answers questions like:
//   "How are my agents performing this week?"
//   "Which agent has the most errors?"
//   "Compare agent performance this month vs last month"
//
// Wraps:
//   - getInternalAgents (DB metadata)
//   - getAgentCosts (Tenant Runtime — invocation costs per agent)
//   - getPerAgentAuditStats (DB — success/error counts per agent)
//   - buildInternalAgentStats (combines the three)
//
// And does the same thing again for compare_to if provided so the LLM can
// compute deltas without making it explicitly request both periods.

import {
  getInternalAgents,
  getAgentCosts,
  getPerAgentAuditStats,
  buildInternalAgentStats,
} from '../data-providers';
import { COMPARE_TO_SCHEMA, TIME_RANGE_SCHEMA, formatTimeRangeForOutput, parseCompareToArg, parseTimeRangeArg } from './tool-helpers';
import type { InsightsTool, InsightsToolContext } from './types';
import type { InternalAgentStats, TimeRange } from '../types';

interface AgentPerformanceOutput {
  period: { start: string; end: string };
  agents: InternalAgentStats[];
  totals: {
    totalAgents: number;
    totalTasks: number;
    totalCostUsd: number;
    totalErrors: number;
  };
  comparison?: {
    period: { start: string; end: string };
    agents: InternalAgentStats[];
    totals: {
      totalAgents: number;
      totalTasks: number;
      totalCostUsd: number;
      totalErrors: number;
    };
  };
}

async function loadStatsForRange(tenantId: string, range: TimeRange): Promise<InternalAgentStats[]> {
  const [agents, costs, audit] = await Promise.all([
    getInternalAgents(tenantId),
    getAgentCosts(tenantId, range),
    getPerAgentAuditStats(tenantId, range),
  ]);
  return buildInternalAgentStats(agents, costs ?? {}, audit);
}

function summarize(stats: InternalAgentStats[]) {
  return {
    totalAgents: stats.length,
    totalTasks: stats.reduce((s, a) => s + a.taskCount, 0),
    totalCostUsd: stats.reduce((s, a) => s + a.costUsd, 0),
    totalErrors: stats.reduce((s, a) => s + a.errorCount, 0),
  };
}

export const getAgentPerformanceTool: InsightsTool = {
  definition: {
    name: 'get_agent_performance',
    description:
      'The agents: tasks executed, cost per agent, success rate, error counts. Use this when the user asks about an agent\'s activity or reliability, or which agents are doing the most work. Supports period comparison via compare_to.',
    input_schema: {
      type: 'object',
      properties: {
        time_range: TIME_RANGE_SCHEMA,
        compare_to: COMPARE_TO_SCHEMA,
      },
      required: ['time_range'],
    },
  },
  async execute(input, ctx: InsightsToolContext): Promise<AgentPerformanceOutput> {
    const range = parseTimeRangeArg(input.time_range);
    const compareRange = parseCompareToArg(input.compare_to);

    const stats = await loadStatsForRange(ctx.tenantId, range);

    const out: AgentPerformanceOutput = {
      period: formatTimeRangeForOutput(range),
      agents: stats,
      totals: summarize(stats),
    };

    if (compareRange) {
      const compareStats = await loadStatsForRange(ctx.tenantId, compareRange);
      out.comparison = {
        period: formatTimeRangeForOutput(compareRange),
        agents: compareStats,
        totals: summarize(compareStats),
      };
    }

    return out;
  },
};
