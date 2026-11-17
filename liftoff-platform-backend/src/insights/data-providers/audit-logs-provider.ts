// Audit Logs Data Provider
// Aggregates agent_audit_logs for activity trends

import { withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import type { TimeRange, TimeGrouping, AuditLogAggregation } from '../types';

/**
 * SQL expression for grouping timestamps by the given time unit.
 */
function groupByExpr(grouping: TimeGrouping): string {
  switch (grouping) {
    case 'hour':
      return `DATE_TRUNC('hour', created_at)`;
    case 'day':
      return `DATE(created_at)`;
    case 'month':
      return `DATE_TRUNC('month', created_at)`;
  }
}

/**
 * Get audit log aggregation for a tenant within a time range.
 * Provides time breakdown (grouped by hour/day/week/month), top agents, and totals.
 */
export async function getAuditLogAggregation(
  tenantId: string,
  range: TimeRange,
  grouping: TimeGrouping = 'day',
): Promise<AuditLogAggregation | null> {
  const groupExpr = groupByExpr(grouping);

  try {
    // Time breakdown with AI vs human split
    const timeResult = await withTenantScope(tenantId, (client) => client.query(
      `SELECT
         ${groupExpr} as date,
         COUNT(*) as count,
         COUNT(CASE WHEN outcome = 'success' THEN 1 END) as success_count,
         COUNT(CASE WHEN outcome = 'error' THEN 1 END) as error_count,
         COUNT(CASE WHEN triggered_by LIKE 'human:%' THEN 1 END) as human_count,
         COUNT(CASE WHEN triggered_by NOT LIKE 'human:%' THEN 1 END) as ai_count
       FROM agent_audit_logs
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
       GROUP BY ${groupExpr}
       ORDER BY date ASC`,
      [tenantId, range.start, range.end],
    ));

    // All AI workforce with action counts.
    // Includes all agents (active, paused, archived/deleted) plus any agents
    // that only exist in audit logs (hard-deleted but had past activity).
    const topAgentsResult = await withTenantScope(tenantId, (client) => client.query(
      `SELECT agent_id, agent_name, action_count, success_rate FROM (
         -- All internal agents (including archived)
         SELECT
           ia.id::text as agent_id,
           ia.role as agent_name,
           COUNT(aal.id) as action_count,
           CASE WHEN COUNT(aal.id) > 0
             THEN COUNT(CASE WHEN aal.outcome = 'success' THEN 1 END)::float / COUNT(aal.id)
             ELSE 0
           END as success_rate
         FROM internal_agents ia
         LEFT JOIN agent_audit_logs aal
           ON aal.internal_agent_id = ia.id
           AND aal.tenant_id = ia.tenant_id
           AND aal.created_at >= $2
           AND aal.created_at < $3
         WHERE ia.tenant_id = $1
         GROUP BY ia.id, ia.role
         UNION ALL
         -- All external agents (including archived)
         SELECT
           ea.id::text as agent_id,
           ea.name as agent_name,
           COUNT(aal.id) as action_count,
           CASE WHEN COUNT(aal.id) > 0
             THEN COUNT(CASE WHEN aal.outcome = 'success' THEN 1 END)::float / COUNT(aal.id)
             ELSE 0
           END as success_rate
         FROM external_agents ea
         LEFT JOIN agent_audit_logs aal
           ON aal.external_agent_id = ea.id
           AND aal.tenant_id = ea.tenant_id
           AND aal.created_at >= $2
           AND aal.created_at < $3
         WHERE ea.tenant_id = $1
         GROUP BY ea.id, ea.name
       ) combined
       ORDER BY action_count DESC
       LIMIT 10`,
      [tenantId, range.start, range.end],
    ));

    // Totals
    const totalsResult = await withTenantScope(tenantId, (client) => client.query(
      `SELECT
         COUNT(*) as total_actions,
         COUNT(CASE WHEN outcome = 'success' THEN 1 END) as total_success,
         COUNT(CASE WHEN outcome = 'error' THEN 1 END) as total_errors,
         AVG(duration_ms) as avg_duration_ms
       FROM agent_audit_logs
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3`,
      [tenantId, range.start, range.end],
    ));

    return {
      timeBreakdown: timeResult.rows.map(row => ({
        date: row.date instanceof Date ? row.date.toISOString() : String(row.date),
        count: parseInt(row.count),
        successCount: parseInt(row.success_count),
        errorCount: parseInt(row.error_count),
        humanCount: parseInt(row.human_count),
        aiCount: parseInt(row.ai_count),
      })),
      topAgents: topAgentsResult.rows.map(row => ({
        agentId: row.agent_id as string,
        agentName: (row.agent_name || row.agent_id) as string,
        actionCount: parseInt(row.action_count),
        successRate: parseFloat(row.success_rate),
      })),
      totalActions: parseInt(totalsResult.rows[0].total_actions) || 0,
      totalSuccess: parseInt(totalsResult.rows[0].total_success) || 0,
      totalErrors: parseInt(totalsResult.rows[0].total_errors) || 0,
      avgDurationMs: totalsResult.rows[0].avg_duration_ms ? parseFloat(totalsResult.rows[0].avg_duration_ms) : null,
    };
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch audit log aggregation');
    return null;
  }
}

/**
 * Get per-agent audit stats (success/error counts) for building InternalAgentStats.
 */
export async function getPerAgentAuditStats(
  tenantId: string,
  range: TimeRange,
): Promise<Record<string, { successCount: number; errorCount: number; totalCount: number }>> {

  try {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT
         internal_agent_id,
         COUNT(*) as total_count,
         COUNT(CASE WHEN outcome = 'success' THEN 1 END) as success_count,
         COUNT(CASE WHEN outcome = 'error' THEN 1 END) as error_count
       FROM agent_audit_logs
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
         AND internal_agent_id IS NOT NULL
       GROUP BY internal_agent_id`,
      [tenantId, range.start, range.end],
    ));

    const stats: Record<string, { successCount: number; errorCount: number; totalCount: number }> = {};
    for (const row of result.rows) {
      stats[row.internal_agent_id as string] = {
        successCount: parseInt(row.success_count),
        errorCount: parseInt(row.error_count),
        totalCount: parseInt(row.total_count),
      };
    }
    return stats;
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch per-agent audit stats');
    return {};
  }
}
