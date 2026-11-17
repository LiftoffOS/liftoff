import { withTenantScope } from '../../infrastructure/database';
import type { TimeRange } from '../types';
import { costColumn } from '../cost-column';

export interface WebToolCost {
  /** `internal_agents.id` when an agent made the call. Null when a platform
   *  assistant did — see `surface`. */
  agentId: string | null;
  /** Which surface spent it when there is no agent: 'liftoff' | 'insights' |
   *  'team_plan'. Resolved to an assistant by `assistantForPurpose`. */
  surface: string | null;
  toolName: string;
  callCount: number;
  totalCostUsd: number;
  ouConsumed: number;
}

/**
 * What each agent's web and browser work cost, per tool.
 *
 * Browser-tool calls land in cost_attribution_events with:
 *   event_type   = 'web_tool'
 *   source       = 'tenant_runtime'
 *   connector    = vendor name ('webclaw' | 'firecrawl' | 'perplexity' | 'anchor' | 'browserbase' | 'tavily' | 'exa' | 'openai' | 'google' | 'browser_use' | 'xai' | 'steel' | 'browserbase_x402' | 'locus_web')
 *   action_type  = tool name   ('web_fetch_advanced' | 'web_extract' | …)
 *
 * Three columns carry the customer-facing story, and dropping any of them
 * loses part of it:
 *
 *   agent_id — the spend subscriber writes the agent's `internal_agents.id`
 *   on every call a team makes (billing/web-tool-spend-subscriber.ts).
 *   Grouping by `action_type` alone would pull every team's browser spend off
 *   its own line and pool it into one anonymous "Web Tools" row.
 *
 *   purpose — null for a team, and the SURFACE name for a platform assistant,
 *   which is the only thing that tells the Chief AI Officer's browser session
 *   apart from Liftoff's. Discarded, all three assistants' spend renders as
 *   one unnamed line.
 *
 *   ou_consumed — without it, the Operating Units column on that row shows a
 *   dash while OUs have actually drained.
 *
 * Two filters carry the rest:
 *
 *   customer_cost_usd — the bucket-rated, customer-billable amount, never the
 *   raw wholesale cost_usd. Same rule as snapshot-service.ts:57, enforced at CI
 *   time by .github/workflows/ou-native-grep-gate.yml.
 *
 *   cost_bucket <> 'platform_overhead' — absorbed rows are not customer spend.
 *   Note this deliberately does NOT exclude 'unknown', the bucket a strict-BYOK
 *   web call books: those rows are already $0 and excluding them would blank a
 *   BYOK workspace's tool usage, which INV-PB-014 exists to prevent. They show
 *   with their real call counts at zero cost, which is what happened.
 */
export async function getWebToolCosts(tenantId: string, range: TimeRange): Promise<WebToolCost[]> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT
       agent_id,
       purpose,
       COALESCE(action_type, 'unknown') AS tool_name,
       COUNT(*)                          AS call_count,
       SUM(${costColumn()})            AS total_cost_usd,
       SUM(ou_consumed)                  AS ou_consumed
     FROM cost_attribution_events
     WHERE tenant_id   = $1
       AND event_type  = 'web_tool'
       AND source      = 'tenant_runtime'
       AND cost_bucket <> 'platform_overhead'
       AND occurred_at >= $2 AND occurred_at < $3
     GROUP BY agent_id, purpose, action_type
     ORDER BY total_cost_usd DESC`,
    [tenantId, range.start, range.end],
  ));
  return result.rows.map(r => ({
    agentId:      r.agent_id ?? null,
    surface:      r.purpose ?? null,
    toolName:     r.tool_name,
    callCount:    parseInt(r.call_count) || 0,
    totalCostUsd: parseFloat(r.total_cost_usd) || 0,
    ouConsumed:   parseFloat(r.ou_consumed) || 0,
  }));
}
