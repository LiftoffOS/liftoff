// get_workforce_composition Tool
//
// Answers questions like:
//   "Who's on my team?"
//   "How many agents do we have?"
//   "What's the split between AI and humans?"
//
// Wraps:
//   - getInternalAgents (DB — AI agent metadata)
//   - getExternalAgentStats (DB — external agent metadata, with rangeDays=30
//     so per_month subscriptions show their full monthly cost)
//   - getTenantMembers (DB — human members and their roles)
//
// Point-in-time — no time_range parameter. The 30-day window for external
// agents is just used for the cost calculation; we ignore the taskCount
// field here since this is composition, not activity.

import {
  getInternalAgents,
  getExternalAgentStats,
  getTenantMembers,
} from '../data-providers';
import type { InsightsTool, InsightsToolContext } from './types';
import type { ExternalAgentStats, TenantMemberInfo } from '../types';

interface WorkforceCompositionOutput {
  internalAgents: Array<{
    id: string;
    name: string;
    role: string;
    status: string;
  }>;
  externalAgents: Array<{
    agentId: string;
    agentName: string;
    costType: 'per_task' | 'per_month' | null;
    costAmount: number | null;
  }>;
  members: TenantMemberInfo[];
  totals: {
    totalInternalAgents: number;
    totalExternalAgents: number;
    totalMembers: number;
    totalWorkforce: number;
  };
}

export const getWorkforceCompositionTool: InsightsTool = {
  definition: {
    name: 'get_workforce_composition',
    description:
      'Full workforce composition snapshot: every agent (with role and status), every external agent (with cost type and amount), and every person (with role). Includes totals. Use this when the user asks who is in the workspace, the size of the AI workforce or the human workforce, or the AI vs human split. Point-in-time snapshot — no time range needed.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  async execute(_input, ctx: InsightsToolContext): Promise<WorkforceCompositionOutput> {
    const [internalAgents, externalAgentStats, members] = await Promise.all([
      getInternalAgents(ctx.tenantId),
      // We don't care about cost or task count for composition — pass empty
      // task counts and 30 days so the call is well-formed but cheap.
      getExternalAgentStats(ctx.tenantId, {}, 30),
      getTenantMembers(ctx.tenantId),
    ]);

    return {
      internalAgents: internalAgents.map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        status: a.status,
      })),
      externalAgents: externalAgentStats.map((ea: ExternalAgentStats) => ({
        agentId: ea.agentId,
        agentName: ea.agentName,
        costType: ea.costType,
        costAmount: ea.costAmount,
      })),
      members,
      totals: {
        totalInternalAgents: internalAgents.length,
        totalExternalAgents: externalAgentStats.length,
        totalMembers: members.length,
        totalWorkforce: internalAgents.length + externalAgentStats.length + members.length,
      },
    };
  },
};
