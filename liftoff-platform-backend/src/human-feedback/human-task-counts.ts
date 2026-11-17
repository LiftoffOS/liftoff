// Human Task Counts — unified workforce activity helper.
//
// Single source of truth for "tasks performed by a human" across the
// platform. Used by:
//   • /teams page Tasks column + 30-day metric tile (person-assignments)
//   • /insights Human Workforce Activity bar chart (tenant-members-provider)
//
// A "human task" is one of:
//   1. In-time HITL decision      → hitl_approval_requests (Tenant Runtime)
//   2. Late HITL feedback         → hitl_late_feedback     (Platform Backend)
//   3. Correction                 → agent_audit_logs       (Platform Backend)
//
// Late feedback is counted as work because the human still spent the time
// reviewing and deciding, even though the agent had already moved on.

import { getPool, withTenantScope } from '../infrastructure/database';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { log } from '../infrastructure/logging';

export interface HumanTaskCount {
  // Sum of in-time HITL decisions + late HITL feedback for this account.
  approvalCount: number;
  // Corrections submitted by this account from /activity.
  correctionCount: number;
}

/**
 * Returns per-account human task counts for [start, end).
 * Failures in any individual source are logged and treated as zero so a
 * single broken dependency cannot zero out the whole report.
 */
export async function getHumanTaskCounts(
  tenantId: string,
  start: Date,
  end: Date,
): Promise<Record<string, HumanTaskCount>> {

  const lateFeedbackPromise = withTenantScope(tenantId, (client) => client.query(
      `SELECT decided_by::text AS account_id, COUNT(*)::int AS cnt
       FROM hitl_late_feedback
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
       GROUP BY decided_by`,
      [tenantId, start, end],
    ))
    .catch((error: Error) => {
      log.error({ tenantId, error: error.message }, 'Failed to fetch hitl_late_feedback counts');
      return { rows: [] as Array<{ account_id: string; cnt: number }> };
    });

  const correctionsPromise = withTenantScope(tenantId, (client) => client.query(
      `SELECT REPLACE(triggered_by, 'human:', '') AS account_id, COUNT(*)::int AS cnt
       FROM agent_audit_logs
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
         AND correction_of IS NOT NULL
         AND triggered_by LIKE 'human:%'
       GROUP BY triggered_by`,
      [tenantId, start, end],
    ))
    .catch((error: Error) => {
      log.error({ tenantId, error: error.message }, 'Failed to fetch correction counts');
      return { rows: [] as Array<{ account_id: string; cnt: number }> };
    });

  const inTimeHitlPromise = tenantRuntimeClient
    .getHitlDecisionCounts(tenantId, start, end)
    .catch((error: Error) => {
      log.error({ tenantId, error: error.message }, 'Failed to fetch in-time HITL decision counts');
      return {} as Record<string, { decisionCount: number }>;
    });

  const [lateFeedbackRes, correctionsRes, inTimeHitl] = await Promise.all([
    lateFeedbackPromise,
    correctionsPromise,
    inTimeHitlPromise,
  ]);

  const result: Record<string, HumanTaskCount> = {};
  const ensure = (id: string): HumanTaskCount => {
    if (!result[id]) result[id] = { approvalCount: 0, correctionCount: 0 };
    return result[id];
  };

  for (const row of lateFeedbackRes.rows) {
    if (!row.account_id) continue;
    ensure(row.account_id).approvalCount += Number(row.cnt);
  }

  for (const row of correctionsRes.rows) {
    if (!row.account_id) continue;
    ensure(row.account_id).correctionCount += Number(row.cnt);
  }

  for (const [accountId, { decisionCount }] of Object.entries(inTimeHitl)) {
    ensure(accountId).approvalCount += decisionCount;
  }

  return result;
}
