// External Agents Data Provider
// Queries external_agents table for external agent metadata and cost config

import { withTenantScope } from '../../infrastructure/database';
import type { ExternalAgentStats } from '../types';

/**
 * Get external agent stats with computed costs.
 * For per_task agents, taskCounts must be provided from Tenant Runtime audit logs.
 * For per_month agents, cost is prorated if the time range is a partial month.
 */
export async function getExternalAgentStats(
  tenantId: string,
  taskCounts: Record<string, { taskCount: number }>,
  rangeDays: number,
): Promise<ExternalAgentStats[]> {

  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT id, name, cost_type, cost_amount
     FROM external_agents
     WHERE tenant_id = $1 AND deleted_at IS NULL
     ORDER BY name ASC`,
    [tenantId],
  ));

  return result.rows.map(row => {
    const costType = row.cost_type as 'per_task' | 'per_month' | null;
    const costAmount = row.cost_amount ? parseFloat(row.cost_amount) : null;
    const agentId = row.id as string;
    const tasks = taskCounts[agentId] || { taskCount: 0 };

    let computedCostUsd = 0;
    if (costType === 'per_task' && costAmount !== null) {
      computedCostUsd = costAmount * tasks.taskCount;
    } else if (costType === 'per_month' && costAmount !== null) {
      // Prorate for partial months
      computedCostUsd = (costAmount / 30) * rangeDays;
    }

    return {
      agentId,
      agentName: row.name as string,
      costType,
      costAmount,
      taskCount: tasks.taskCount,
      computedCostUsd,
    };
  });
}
