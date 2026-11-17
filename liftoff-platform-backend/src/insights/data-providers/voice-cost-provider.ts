import { withTenantScope } from '../../infrastructure/database';
import type { TimeRange } from '../types';
import { costColumn } from '../cost-column';

export interface AgentVoiceCost {
  agentId: string;
  totalCostUsd: number;
  ouConsumed: number;
}

/**
 * What each agent's voice cost, per agent.
 *
 * Dictation into an agent's thread and the agent speaking its reply both land in
 * cost_attribution_events with `event_type` of 'voice_stt' / 'voice_tts' and the
 * agent's `internal_agents.id`. Every other provider here filters
 * `event_type = 'llm_invocation'`, so these rows reached no reader at all: the
 * cost was charged, Operating Units were consumed, and no surface could show it.
 *
 * Two filters carry the whole customer-facing story:
 *
 *   customer_cost_usd — the bucket-rated amount, never raw cost_usd. Same rule as
 *   every other /insights provider, enforced by ou-native-grep-gate.yml.
 *
 *   cost_bucket <> 'platform_overhead' — voice on the Chief AI Officer plan and
 *   on workspace insights is absorbed by Liftoff. Those rows still carry a
 *   derived `ou_consumed` for ops, so excluding them by bucket rather than
 *   relying on a zero cost is what keeps absorbed usage from inflating an
 *   agent's Operating Units.
 */
export async function getAgentVoiceCosts(
  tenantId: string,
  range: TimeRange,
): Promise<AgentVoiceCost[]> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT
       agent_id,
       SUM(${costColumn()}) AS total_cost_usd,
       SUM(ou_consumed)       AS ou_consumed
     FROM cost_attribution_events
     WHERE tenant_id    = $1
       AND event_type   IN ('voice_stt', 'voice_tts')
       AND agent_id     IS NOT NULL
       AND cost_bucket  <> 'platform_overhead'
       AND occurred_at >= $2 AND occurred_at < $3
     GROUP BY agent_id`,
    [tenantId, range.start, range.end],
  ));
  return result.rows.map((r) => ({
    agentId: r.agent_id,
    totalCostUsd: parseFloat(r.total_cost_usd) || 0,
    ouConsumed: parseFloat(r.ou_consumed) || 0,
  }));
}
