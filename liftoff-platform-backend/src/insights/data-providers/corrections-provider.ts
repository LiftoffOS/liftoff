// Corrections Data Provider
// Queries agent_audit_logs WHERE correction_of IS NOT NULL

import { withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import type { TimeRange, CorrectionStats } from '../types';

/**
 * Get correction statistics for a tenant within a time range.
 * Corrections are audit log entries where correction_of IS NOT NULL.
 */
export async function getCorrectionStats(
  tenantId: string,
  range: TimeRange,
): Promise<CorrectionStats | null> {

  try {
    // Total corrections
    const totalResult = await withTenantScope(tenantId, (client) => client.query(
      `SELECT COUNT(*) as total
       FROM agent_audit_logs
       WHERE tenant_id = $1
         AND correction_of IS NOT NULL
         AND created_at >= $2
         AND created_at < $3`,
      [tenantId, range.start, range.end],
    ));

    // Corrections by agent
    const byAgentResult = await withTenantScope(tenantId, (client) => client.query(
      `SELECT
         aal.internal_agent_id,
         ia.role as agent_name,
         COUNT(*) as correction_count
       FROM agent_audit_logs aal
       LEFT JOIN internal_agents ia ON ia.id = aal.internal_agent_id AND ia.tenant_id = aal.tenant_id
       WHERE aal.tenant_id = $1
         AND aal.correction_of IS NOT NULL
         AND aal.created_at >= $2
         AND aal.created_at < $3
       GROUP BY aal.internal_agent_id, ia.role
       ORDER BY correction_count DESC
       LIMIT 10`,
      [tenantId, range.start, range.end],
    ));

    return {
      totalCorrections: parseInt(totalResult.rows[0].total) || 0,
      byAgent: byAgentResult.rows.map(row => ({
        agentId: row.internal_agent_id as string,
        agentName: (row.agent_name || row.internal_agent_id) as string,
        correctionCount: parseInt(row.correction_count),
      })),
    };
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch correction stats');
    return null;
  }
}
