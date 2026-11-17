// Internal Agents Data Provider
// Queries internal_agents table for agent metadata and status

import { withTenantScope } from '../../infrastructure/database';
import type { InternalAgentStats } from '../types';

export interface InternalAgentRow {
  id: string;
  name: string;
  role: string;
  status: string;
  /** Set when the agent has been removed. Its spend inside the window is
   *  still the workspace's and still renders; see `includeDeleted`. */
  deletedAt: Date | null;
}

/**
 * Get internal agent stats for a tenant within a time range.
 * Agent metadata comes from the local DB; cost/task data is enriched externally.
 *
 * `includeDeleted` exists because removing an agent would otherwise silently
 * remove its spend from the page. The Cost Breakdown and the Total Cost card
 * both iterate this list, so a team deleted mid-period would take its whole
 * cost with it: charged to the customer and rendered nowhere. Money already
 * spent does not stop having been spent because the team that spent it was
 * removed afterwards.
 *
 * The default stays live-only, because every other caller wants the current
 * roster.
 */
export async function getInternalAgents(
  tenantId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<InternalAgentRow[]> {

  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT id, role, status, created_at, deleted_at
     FROM internal_agents
     WHERE tenant_id = $1
       AND ($2::boolean OR deleted_at IS NULL)
     ORDER BY created_at DESC`,
    [tenantId, opts.includeDeleted === true],
  ));

  return result.rows.map(row => ({
    id: row.id as string,
    name: row.role as string,
    role: row.role as string,
    status: row.status as string,
    deletedAt: (row.deleted_at as Date | null) ?? null,
  }));
}

/**
 * Build InternalAgentStats by combining local agent metadata with
 * externally-fetched cost and task data.
 */
export function buildInternalAgentStats(
  agents: Array<{ id: string; name: string; role: string; status: string }>,
  costData: Record<string, { totalCostUsd: number; invocationCount: number }>,
  auditData: Record<string, { successCount: number; errorCount: number; totalCount: number }>,
): InternalAgentStats[] {
  return agents.map(agent => {
    const cost = costData[agent.id] || { totalCostUsd: 0, invocationCount: 0 };
    const audit = auditData[agent.id] || { successCount: 0, errorCount: 0, totalCount: 0 };
    const successRate = audit.totalCount > 0
      ? audit.successCount / audit.totalCount
      : 0;

    return {
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      status: agent.status,
      taskCount: cost.invocationCount,
      costUsd: cost.totalCostUsd,
      successRate,
      errorCount: audit.errorCount,
    };
  });
}
