// HITL Data Provider
// Queries hitl_late_feedback for decision stats

import { withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import type { TimeRange, HitlApprovalStats } from '../types';

/**
 * Get HITL late feedback statistics for a tenant.
 * The hitl_late_feedback table stores post-expiry decisions (would_approve/would_reject).
 */
export async function getHitlApprovalStats(
  tenantId: string,
  range: TimeRange,
): Promise<HitlApprovalStats | null> {

  try {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT
         COUNT(*) as total,
         COUNT(CASE WHEN decision = 'would_approve' THEN 1 END) as approved,
         COUNT(CASE WHEN decision = 'would_reject' THEN 1 END) as rejected,
         AVG(EXTRACT(EPOCH FROM (feedback_provided_at - approval_created_at)) * 1000) as avg_decision_time_ms
       FROM hitl_late_feedback
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3`,
      [tenantId, range.start, range.end],
    ));

    const row = result.rows[0];
    return {
      totalApprovals: parseInt(row.total) || 0,
      approvedCount: parseInt(row.approved) || 0,
      rejectedCount: parseInt(row.rejected) || 0,
      pendingCount: 0,
      expiredCount: 0,
      avgDecisionTimeMs: row.avg_decision_time_ms ? parseFloat(row.avg_decision_time_ms) : null,
    };
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch HITL approval stats');
    return null;
  }
}
