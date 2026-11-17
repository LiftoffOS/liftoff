import { withTenantScope } from '../../infrastructure/database';
import type { TimeRange } from '../types';
import { costColumn } from '../cost-column';

export interface SandboxCost {
  /** `internal_agents.id`, or the runtime's own agent id when the sandbox feed
   *  could not map it (sandbox-ingester.ts falls back, INV-TR-010). An id that
   *  resolves to no team is reported as unattributed, never dropped. */
  agentId: string | null;
  runCount: number;
  totalCostUsd: number;
  ouConsumed: number;
}

/**
 * What each agent's sandbox compute cost.
 *
 * Sandbox runs land in cost_attribution_events with `event_type='sandbox'` and
 * `source='tenant_runtime'`, priced from the runtime's credit feed
 * (cost-attribution/ingestion/sandbox-ingester.ts). They carry the agent's id
 * and no purpose.
 *
 * Every other provider here filters `event_type` to 'llm_invocation',
 * 'web_tool' or the two voice types, so without this one these rows reach no
 * customer-facing surface at all — while being a large charged line in the
 * ledger, every row `cost_bucket='included'` and attributed to a team.
 *
 * `src/insights/__tests__/event-type-coverage.test.ts` is the ratchet that
 * catches exactly this. Sandbox compute is not platform overhead, so that
 * entry names this file rather than a reason for leaving it out.
 *
 * `customer_cost_usd` and the platform_overhead exclusion follow the same rule
 * as every other provider here.
 */
export async function getSandboxCosts(tenantId: string, range: TimeRange): Promise<SandboxCost[]> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT
       agent_id,
       COUNT(*)               AS run_count,
       SUM(${costColumn()}) AS total_cost_usd,
       SUM(ou_consumed)       AS ou_consumed
     FROM cost_attribution_events
     WHERE tenant_id   = $1
       AND event_type  = 'sandbox'
       AND cost_bucket <> 'platform_overhead'
       AND occurred_at >= $2 AND occurred_at < $3
     GROUP BY agent_id
     ORDER BY total_cost_usd DESC`,
    [tenantId, range.start, range.end],
  ));
  return result.rows.map(r => ({
    agentId:      r.agent_id ?? null,
    runCount:     parseInt(r.run_count) || 0,
    totalCostUsd: parseFloat(r.total_cost_usd) || 0,
    ouConsumed:   parseFloat(r.ou_consumed) || 0,
  }));
}
