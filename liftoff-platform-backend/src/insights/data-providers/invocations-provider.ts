import { withTenantScope } from '../../infrastructure/database';
import type { TimeRange, AgentCostEntry, InvocationStats } from '../types';
import { costColumn } from '../cost-column';

export async function getAgentCosts(
  tenantId: string, range: TimeRange,
): Promise<Record<string, AgentCostEntry>> {
  const { rows } = await withTenantScope(tenantId, (client) => client.query<{
    agent_id: string;
    cost_usd: string; ou_consumed: string; customer_cost_usd: string;
    input_tokens: string | null; output_tokens: string | null; cached_tokens: string | null;
    invocations: string;
    uncosted_invocations: string;
    uncosted_input_tokens: string | null; uncosted_output_tokens: string | null;
  }>(
    // The uncosted_* columns split out the rows that consumed real tokens and
    // reported no cost. Without them a period containing an unpriced model reads
    // exactly like a cheap one, and the OU-native surfaces that sum
    // customer_cost_usd report a number that is confidently too low.
    `SELECT
       agent_id,
       SUM(cost_usd)          AS cost_usd,
       SUM(ou_consumed)       AS ou_consumed,
       SUM(${costColumn()}) AS customer_cost_usd,
       SUM(input_tokens)      AS input_tokens,
       SUM(output_tokens)     AS output_tokens,
       SUM(cached_tokens)     AS cached_tokens,
       COUNT(*)               AS invocations,
       COUNT(*) FILTER (
         WHERE COALESCE(cost_usd, 0) = 0
           AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
       ) AS uncosted_invocations,
       COALESCE(SUM(input_tokens) FILTER (
         WHERE COALESCE(cost_usd, 0) = 0
           AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
       ), 0) AS uncosted_input_tokens,
       COALESCE(SUM(output_tokens) FILTER (
         WHERE COALESCE(cost_usd, 0) = 0
           AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
       ), 0) AS uncosted_output_tokens
     FROM cost_attribution_events
     WHERE tenant_id    = $1
       AND occurred_at >= $2
       AND occurred_at <  $3
       AND source       = 'tenant_runtime'
       AND event_type   = 'llm_invocation'
       AND agent_id     IS NOT NULL
       AND cost_bucket  <> 'platform_overhead'
     GROUP BY agent_id`,
    [tenantId, range.start, range.end],
  ));
  const out: Record<string, AgentCostEntry> = {};
  for (const r of rows) {
    out[r.agent_id] = {
      totalCostUsd:      parseFloat(r.customer_cost_usd),    // customer-charged (bucket-rated)
      rawModelCostUsd:   parseFloat(r.cost_usd),              // wholesale compute, ops/debug only
      ouConsumed:        parseFloat(r.ou_consumed),
      invocationCount:   Number(r.invocations),
      totalInputTokens:  Number(r.input_tokens  ?? 0),
      totalOutputTokens: Number(r.output_tokens ?? 0),
      totalCachedTokens: Number(r.cached_tokens ?? 0),
      uncostedInvocationCount: Number(r.uncosted_invocations ?? 0),
      uncostedInputTokens:     Number(r.uncosted_input_tokens  ?? 0),
      uncostedOutputTokens:    Number(r.uncosted_output_tokens ?? 0),
    };
  }
  return out;
}

export async function getInvocationStats(
  tenantId: string, range: TimeRange, agentId?: string,
): Promise<InvocationStats | null> {
  const { rows } = await withTenantScope(tenantId, (client) => client.query<{
    cost_usd: string; input_tokens: string | null; output_tokens: string | null; invocations: string;
    uncosted_invocations: string;
    uncosted_input_tokens: string | null; uncosted_output_tokens: string | null;
  }>(
    // See getAgentCosts — same split, same reason.
    `SELECT
       SUM(cost_usd)      AS cost_usd,
       SUM(input_tokens)  AS input_tokens,
       SUM(output_tokens) AS output_tokens,
       COUNT(*)           AS invocations,
       COUNT(*) FILTER (
         WHERE COALESCE(cost_usd, 0) = 0
           AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
       ) AS uncosted_invocations,
       COALESCE(SUM(input_tokens) FILTER (
         WHERE COALESCE(cost_usd, 0) = 0
           AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
       ), 0) AS uncosted_input_tokens,
       COALESCE(SUM(output_tokens) FILTER (
         WHERE COALESCE(cost_usd, 0) = 0
           AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
       ), 0) AS uncosted_output_tokens
     FROM cost_attribution_events
     WHERE tenant_id    = $1
       AND occurred_at >= $2
       AND occurred_at <  $3
       AND source       = 'tenant_runtime'
       AND event_type   = 'llm_invocation'
       AND cost_bucket  <> 'platform_overhead'
       ${agentId ? 'AND agent_id = $4' : ''}`,
    agentId ? [tenantId, range.start, range.end, agentId] : [tenantId, range.start, range.end],
  ));
  const r = rows[0];
  if (!r) return null;
  return {
    totalCostUsd:      parseFloat(r.cost_usd),
    totalInputTokens:  Number(r.input_tokens  ?? 0),
    totalOutputTokens: Number(r.output_tokens ?? 0),
    invocationCount:   Number(r.invocations),
    uncostedInvocationCount: Number(r.uncosted_invocations ?? 0),
    uncostedInputTokens:     Number(r.uncosted_input_tokens  ?? 0),
    uncostedOutputTokens:    Number(r.uncosted_output_tokens ?? 0),
  };
}
