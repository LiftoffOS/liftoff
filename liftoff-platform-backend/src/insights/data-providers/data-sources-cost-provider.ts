import { withTenantScope } from '../../infrastructure/database';
import type { TimeRange } from '../types';
import { costColumn } from '../cost-column';

export interface DataSourceCost {
  /** `internal_agents.id` when an agent made the call, null otherwise. */
  agentId: string | null;
  /** Surface name for a platform assistant's call, when the writer set one. */
  surface: string | null;
  /** The data source itself: 'apify' | 'locus' | 'vaaya' | 'google_sheets' | … */
  connector: string;
  callCount: number;
  totalCostUsd: number;
  ouConsumed: number;
}

/**
 * What each agent's data sources cost.
 *
 * Every call out to a connector or an aggregator books
 * `event_type='connector_call'`: the Composio and vendor-MCP connectors
 * (google_sheets, google_mail, google_docs, google_drive, …) and the aggregator
 * rungs the workspace pays per call for (apify, locus, vaaya, strale, tikhub,
 * google_trends). `connector` names the source and is what a reader recognises,
 * so it is the sub-row.
 *
 * They do not bill through the invocation that made them, so no other provider
 * covers them. They are standalone rows with their own `customer_cost_usd` and
 * `ou_consumed`, nothing folds them into the invocation, and they can be the
 * largest charged line after the model calls themselves.
 *
 * Both sources are read. `tenant_runtime` covers the aggregator rungs and the
 * runtime's own connector calls; `composio_mcp` covers the Composio front door.
 * Filtering to one would drop the other silently, which is the shape of defect
 * this provider exists to prevent.
 *
 * 'unknown' is excluded alongside 'platform_overhead' here, unlike the web-tool
 * provider: on this event type it marks a row whose bucket assignment is
 * meaningless rather than a BYOK call worth showing at $0
 * (cost-attribution/repository.ts:557).
 */
export async function getDataSourceCosts(
  tenantId: string,
  range: TimeRange,
): Promise<DataSourceCost[]> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT
       agent_id,
       purpose,
       COALESCE(connector, 'unknown') AS connector,
       COUNT(*)                       AS call_count,
       SUM(${costColumn()})         AS total_cost_usd,
       SUM(ou_consumed)               AS ou_consumed
     FROM cost_attribution_events
     WHERE tenant_id   = $1
       AND event_type  = 'connector_call'
       AND source      IN ('tenant_runtime', 'composio_mcp')
       AND cost_bucket NOT IN ('platform_overhead', 'unknown')
       AND occurred_at >= $2 AND occurred_at < $3
     GROUP BY agent_id, purpose, connector
     ORDER BY total_cost_usd DESC`,
    [tenantId, range.start, range.end],
  ));
  return result.rows.map(r => ({
    agentId:      r.agent_id ?? null,
    surface:      r.purpose ?? null,
    connector:    r.connector,
    callCount:    parseInt(r.call_count) || 0,
    totalCostUsd: parseFloat(r.total_cost_usd) || 0,
    ouConsumed:   parseFloat(r.ou_consumed) || 0,
  }));
}
