// Attribution Service
//
// Query layer over cost_attribution_events. Returns structured
// breakdowns suitable for the REST API and the insights page.

import { withTenantScope } from '../infrastructure/database';
import { getCostBreakdown, getCostByAgent } from './repository';
import type { CostBreakdown, CostByAgent } from './types';

export async function getTenantCostSummary(
  tenantId: string,
  since: Date,
  until: Date,
): Promise<CostBreakdown> {
  return getCostBreakdown({ tenantId, since, until });
}

export async function getAgentCostSummary(
  tenantId: string,
  agentId: string,
  since: Date,
  until: Date,
): Promise<CostBreakdown> {
  return getCostBreakdown({ tenantId, agentId, since, until });
}

export async function getAllAgentsCosts(
  tenantId: string,
  since: Date,
  until: Date,
): Promise<CostByAgent[]> {
  return getCostByAgent(tenantId, since, until);
}

export interface ActionCostEntry {
  eventId:     string;
  agentId:     string | null;
  actionId:    string | null;
  workflowId:  string | null;
  connector:   string | null;
  actionType:  string | null;
  eventType:   string;
  costUsd:     number;
  occurredAt:  Date;
}

export async function getActionCosts(
  tenantId: string,
  agentId:  string | null,
  since:    Date,
  until:    Date,
  limit:    number,
  cursor:   string | null,
): Promise<{ entries: ActionCostEntry[]; nextCursor: string | null }> {
  const params: unknown[] = [tenantId, since, until];
  const agentFilter  = agentId ? ` AND agent_id = $${params.push(agentId)}` : '';
  const cursorFilter = cursor  ? ` AND id > $${params.push(cursor)}::uuid`  : '';
  const safeLimit    = Math.min(Math.max(1, limit), 500);

  // cost_attribution_events is RLS-on (migration 200). This is a per-tenant
  // dashboard read — wrap in tenant scope.
  const result = await withTenantScope(tenantId, (client) =>
    client.query(
      `SELECT id::text, agent_id, action_id, workflow_id, connector, action_type,
              event_type, cost_usd, occurred_at
       FROM cost_attribution_events
       WHERE tenant_id = $1
         AND occurred_at >= $2
         AND occurred_at < $3
         AND event_type IN ('connector_call', 'llm_invocation', 'developer_proxy_llm')
         ${agentFilter}${cursorFilter}
       ORDER BY id
       LIMIT ${safeLimit + 1}`,
      params,
    ),
  );

  const hasMore = result.rows.length > safeLimit;
  const rows    = hasMore ? result.rows.slice(0, safeLimit) : result.rows;

  const entries: ActionCostEntry[] = rows.map(row => ({
    eventId:    row.id    as string,
    agentId:    row.agent_id   as string | null,
    actionId:   row.action_id  as string | null,
    workflowId: row.workflow_id as string | null,
    connector:  row.connector  as string | null,
    actionType: row.action_type as string | null,
    eventType:  row.event_type  as string,
    costUsd:    parseFloat(row.cost_usd),
    occurredAt: row.occurred_at as Date,
  }));

  const nextCursor = hasMore ? rows[rows.length - 1].id as string : null;
  return { entries, nextCursor };
}
