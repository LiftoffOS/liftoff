// Operating Unit reporting service. Reads directly from billing_controls
// (allocation) and billing_spend_events.ou_consumed (per-event consumption).
//
// `1 OU = $0.01 of blended platform cost` lives in billing_system_settings (key='ou_definition_rate_usd')
// and consumed only at the subscriber (src/billing/spend-subscriber.ts) when writing rows.

import { getPool, withTenantScope } from '../infrastructure/database';

export interface AgentOuEntry {
  agentId: string;
  agentName: string;
  ousConsumed: number;
}

export interface OperatingUnitResult {
  totalOusConsumed: number;
  platformAnalyticsOusConsumed: number;
  byAgent: AgentOuEntry[];
}

export async function getOperatingUnitsForPeriod(
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<OperatingUnitResult> {

  const [byAgentResult, namesResult] = await Promise.all([
    withTenantScope(tenantId, (client) => client.query<{ agent_id: string | null; total_ou_consumed: string }>(`
      SELECT agent_id, SUM(ou_consumed) AS total_ou_consumed
      FROM billing_spend_events
      WHERE tenant_id   = $1
        AND occurred_at >= $2
        AND occurred_at  < $3
      GROUP BY agent_id
    `, [tenantId, periodStart, periodEnd])),
    withTenantScope(tenantId, (client) => client.query<{ id: string; display_name: string }>(`
      SELECT id::text AS id, role AS display_name FROM internal_agents WHERE tenant_id = $1
      UNION ALL
      SELECT id::text AS id, name AS display_name FROM external_agents WHERE tenant_id = $1
    `, [tenantId])),
  ]);

  const nameMap = new Map<string, string>();
  for (const row of namesResult.rows) nameMap.set(row.id, row.display_name);

  const platformAnalyticsRow = byAgentResult.rows.find(r => r.agent_id === null);
  const agentRows = byAgentResult.rows.filter(r => r.agent_id !== null);

  const byAgent: AgentOuEntry[] = agentRows.map(row => ({
    agentId:     row.agent_id!,
    agentName:   nameMap.get(row.agent_id!) ?? row.agent_id!,
    ousConsumed: parseFloat(row.total_ou_consumed),
  }));

  const platformAnalyticsOusConsumed = platformAnalyticsRow
    ? parseFloat(platformAnalyticsRow.total_ou_consumed)
    : 0;

  const totalOusConsumed = byAgent.reduce((s, a) => s + a.ousConsumed, 0) + platformAnalyticsOusConsumed;

  return { totalOusConsumed, platformAnalyticsOusConsumed, byAgent };
}
