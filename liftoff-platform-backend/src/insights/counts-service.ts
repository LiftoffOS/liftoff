// Insights Counts Service
//
// Three all-time SELECT count(*) probes that let callers decide whether to
// kick off the expensive report fan-out. The empty-state check is ALL-TIME
// by design: "No insights yet" is onboarding copy, not a period-filter
// message. A tenant with historical data viewing a quiet recent window
// should see a period-scoped "no activity this period" message from the
// report itself, never this onboarding text.
//
// Used by:
//   1. GET /api/insights/counts — frontend gates the report fetch on this
//   2. report-service.generateReport — short-circuits the 12-query fan-out
//      when all three counts are zero, so direct API consumers also benefit

import { withTenantScope } from '../infrastructure/database';

export interface InsightsCounts {
  agentCount: number;
  invocationCount: number;
  auditCount: number;
  isEmpty: boolean;
}

/**
 * All-time count of non-deleted internal agents for a tenant.
 */
export async function countAgents(tenantId: string): Promise<number> {
  const { rows } = await withTenantScope(tenantId, (client) => client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM internal_agents
      WHERE tenant_id = $1
        AND deleted_at IS NULL`,
    [tenantId],
  ));
  return Number(rows[0]?.count ?? 0);
}

/**
 * All-time count of LLM invocation events for a tenant. Mirrors the row
 * filter used by getInvocationStats (source/event_type/cost_bucket) so a
 * tenant with only platform-overhead rows is still considered empty.
 */
export async function countInvocations(tenantId: string): Promise<number> {
  const { rows } = await withTenantScope(tenantId, (client) => client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM cost_attribution_events
      WHERE tenant_id   = $1
        AND source      = 'tenant_runtime'
        AND event_type  = 'llm_invocation'
        AND cost_bucket <> 'platform_overhead'`,
    [tenantId],
  ));
  return Number(rows[0]?.count ?? 0);
}

/**
 * All-time count of agent audit log entries for a tenant.
 */
export async function countAuditActions(tenantId: string): Promise<number> {
  const { rows } = await withTenantScope(tenantId, (client) => client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM agent_audit_logs
      WHERE tenant_id = $1`,
    [tenantId],
  ));
  return Number(rows[0]?.count ?? 0);
}

/**
 * Run the three count probes in parallel and return the empty-state verdict.
 * The three queries are independent SELECT COUNT(*)s with tenant_id indexes;
 * they complete in tens of ms even on populated tenants.
 */
export async function getInsightsCounts(tenantId: string): Promise<InsightsCounts> {
  const [agentCount, invocationCount, auditCount] = await Promise.all([
    countAgents(tenantId),
    countInvocations(tenantId),
    countAuditActions(tenantId),
  ]);
  return {
    agentCount,
    invocationCount,
    auditCount,
    isEmpty: agentCount === 0 && invocationCount === 0 && auditCount === 0,
  };
}
