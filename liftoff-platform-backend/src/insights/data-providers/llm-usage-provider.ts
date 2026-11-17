// LLM Usage Data Provider
// Queries llm_usage_log in Platform Backend for distill, capability analysis, insights,
// and Claude Code proxy costs.

import { withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import type { TimeRange } from '../types';
import { costColumn } from '../cost-column';

export interface AgentLLMCost {
  agentId: string;
  purpose: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;     // customer-charged USD (bucket-rated)
  rawModelCostUsd: number;      // wholesale model compute cost; ops/debug only
  ouConsumed: number;
  /** Cost attributable to LLM calls that failed (success=false).
   *  Included in estimatedCostUsd — this is a breakdown field, not additive. */
  failedAttemptsCostUsd: number;
}

/**
 * One purpose's worth of charged model spend that carries no agent id.
 *
 * This is what the three platform assistants' own model calls look like in the
 * ledger: `source='platform_llm'`, `agent_id IS NULL`, and a `purpose` that
 * says which surface made the call. `assistantForPurpose` turns that into a
 * name for the page.
 */
export interface AgentlessLLMCost {
  purpose: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;     // customer-charged USD (bucket-rated)
  rawModelCostUsd: number;      // wholesale model compute cost; ops/debug only
  ouConsumed: number;
}

export interface ClaudeCodeProxyCost {
  proxyKeyId: string;
  keyHint: string;
  accountId: string;
  displayName: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedCostUsd: number;
  requestCount: number;
}

/**
 * Get per-agent LLM costs from Platform Backend (distill, capability analysis, updates).
 * Returns one entry per agent+purpose combination.
 */
export async function getAgentLLMCosts(
  tenantId: string,
  range: TimeRange,
): Promise<AgentLLMCost[]> {
  try {
    const { rows } = await withTenantScope(tenantId, (client) => client.query<{
      agent_id: string; purpose: string;
      input_tokens: string | null; output_tokens: string | null;
      cost_usd: string; ou_consumed: string; customer_cost_usd: string;
      failed_cost_usd: string;
    }>(
      `SELECT
         agent_id, purpose,
         SUM(input_tokens)      AS input_tokens,
         SUM(output_tokens)     AS output_tokens,
         SUM(cost_usd)          AS cost_usd,
         SUM(ou_consumed)       AS ou_consumed,
         SUM(${costColumn()}) AS customer_cost_usd,
         SUM(CASE WHEN correlation_confidence = 'unmatched' THEN customer_cost_usd ELSE 0 END) AS failed_cost_usd
       FROM cost_attribution_events
       WHERE tenant_id      = $1
         AND occurred_at   >= $2
         AND occurred_at   <  $3
         AND source         = 'platform_llm'
         AND event_type     = 'llm_invocation'
         AND agent_id       IS NOT NULL
         AND cost_bucket    <> 'platform_overhead'
       GROUP BY agent_id, purpose`,
      [tenantId, range.start, range.end],
    ));
    return rows.map(r => ({
      agentId: r.agent_id,
      purpose: r.purpose,
      totalInputTokens:       Number(r.input_tokens  ?? 0),
      totalOutputTokens:      Number(r.output_tokens ?? 0),
      estimatedCostUsd:       parseFloat(r.customer_cost_usd),   // customer-charged amount (bucket-rated)
      rawModelCostUsd:        parseFloat(r.cost_usd),             // wholesale compute cost, retained for ops/debug only
      ouConsumed:             parseFloat(r.ou_consumed),
      failedAttemptsCostUsd:  parseFloat(r.failed_cost_usd),
    }));
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch agent LLM costs');
    return [];
  }
}

/**
 * Every charged model call that carries NO agent id, split by purpose.
 *
 * This replaces `getPlatformLLMCosts` and `getWorkforcePlanningCosts`, which
 * were two queries over the same rows separated by a hand-maintained list of
 * CAIO purposes: one selected `purpose NOT IN (…)`, the other `purpose IN (…)`.
 * Keeping two lists complementary by hand is the same defect class this whole
 * change exists to remove — a purpose added to neither is money that reaches no
 * reader, and a purpose added to both is money counted twice. Neither failure
 * announces itself.
 *
 * One query, no purpose list, and the caller decides how to group. What comes
 * back is per-purpose, so the spend lands on the line of the assistant that
 * made it instead of being summed into a figure with nowhere to render.
 *
 * `cost_bucket <> 'platform_overhead'` is the whole chargeability filter: a
 * purpose the platform absorbs books at customer_cost_usd=0 in that bucket and
 * simply does not come back from here. That is why this needs no policy
 * knowledge of its own — event-classification.ts already holds it, and reading
 * the bucket means the two cannot disagree.
 */
export async function getAgentlessLLMCosts(
  tenantId: string,
  range: TimeRange,
): Promise<AgentlessLLMCost[]> {
  try {
    const { rows } = await withTenantScope(tenantId, (client) => client.query<{
      purpose: string | null;
      input_tokens: string | null; output_tokens: string | null;
      cost_usd: string; ou_consumed: string; customer_cost_usd: string;
    }>(
      `SELECT
         purpose,
         SUM(input_tokens)      AS input_tokens,
         SUM(output_tokens)     AS output_tokens,
         SUM(cost_usd)          AS cost_usd,
         SUM(ou_consumed)       AS ou_consumed,
         SUM(${costColumn()}) AS customer_cost_usd
       FROM cost_attribution_events
       WHERE tenant_id   = $1
         AND occurred_at >= $2
         AND occurred_at <  $3
         AND source       = 'platform_llm'
         AND event_type   = 'llm_invocation'
         AND agent_id     IS NULL
         AND cost_bucket <> 'platform_overhead'
       GROUP BY purpose`,
      [tenantId, range.start, range.end],
    ));
    return rows.map(r => ({
      purpose:           r.purpose,
      totalInputTokens:  Number(r.input_tokens  ?? 0),
      totalOutputTokens: Number(r.output_tokens ?? 0),
      estimatedCostUsd:  parseFloat(r.customer_cost_usd ?? '0'),
      rawModelCostUsd:   parseFloat(r.cost_usd ?? '0'),
      ouConsumed:        parseFloat(r.ou_consumed ?? '0'),
    }));
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch agentless LLM costs');
    return [];
  }
}

/**
 * Get developer-proxy (Claude Code + Codex) usage costs, broken down by member.
 *
 * Applies to BOTH vendors: Claude Code (Anthropic) and Codex (OpenAI) BYOK usage
 * are the same `developer_proxy_llm` cost source — Codex is no more granular here
 * than Claude Code.
 *
 * Migration 132 (byok_cutover_drop) removed claude_code_proxy_keys and the
 * proxy_key_id/proxy_account_id columns from llm_usage_log. Developer proxy
 * usage is now ingested into cost_attribution_events (event_type =
 * 'developer_proxy_llm') without per-credential breakdown, so a per-member
 * table cannot be reconstructed from local data. It also carries no per-agent
 * attribution: the coding-tool CLIs are transparent clients and don't propagate
 * agent identity, so usage is credential/user-scoped at best. Returns empty until
 * a per-credential endpoint is available from the developer proxy service.
 */
export async function getClaudeCodeProxyCosts(
  _tenantId: string,
  _range: TimeRange,
): Promise<ClaudeCodeProxyCost[]> {
  return [];
}
