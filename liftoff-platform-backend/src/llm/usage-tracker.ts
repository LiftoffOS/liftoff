// LLM Usage Tracker
// Registers an onUsage callback on the LLM client that persists every
// call (success or failure) to the llm_usage_log table.
// This is the single source of truth for token consumption.

import { llmClient } from './client';
import { armCostIngest } from '../jobs/maintenance-targets';
import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import type { LLMUsageEvent } from './types';

/**
 * Call once at startup to begin tracking all LLM calls.
 *
 * The callback returns the persist promise so the LLM client can await
 * it before returning to its caller. This guarantees the usage row is
 * committed to llm_usage_log before downstream code (notably
 * attributeSessionToAgent) runs — avoiding the fire-and-forget race
 * where an UPDATE could match zero rows because the INSERT
 * hadn't landed yet. Errors are still swallowed inside
 * persistUsageEvent so a DB hiccup never fails the LLM call.
 */
export function initLLMUsageTracking(): void {
  llmClient.onUsage(async (event: LLMUsageEvent) => {
    try {
      await persistUsageEvent(event);
    } catch (err) {
      log.error({
        error: (err as Error).message,
        provider: event.provider,
        model: event.model,
        input_tokens: event.inputTokens,
        output_tokens: event.outputTokens,
        success: event.success,
        context: event.context,
      }, 'Failed to persist LLM usage event');
    }
  });

  log.info('LLM usage tracking initialized');
}

/**
 * Backfill agent_id on usage log rows that were tagged with a session_id.
 * Called after an agent is created from a distill session.
 *
 * Best-effort: attribution is cosmetic (affects /insights cost bucketing
 * only), so this function never throws. DB errors — including a not-yet-
 * initialized pool — are caught and logged.
 */
export async function attributeSessionToAgent(sessionId: string, agentId: string): Promise<void> {
  try {
    await withAdminScope({ caller: 'llm.usage-tracker', reason: 'llm_usage_log writer: tenant_id may be NULL (platform calls) + by-session attribution (content table)' }, (client) => client.query(
      `UPDATE llm_usage_log SET agent_id = $1 WHERE session_id = $2 AND agent_id IS NULL`,
      [agentId, sessionId],
    ));
    log.info({ sessionId, agentId }, 'Attributed distill session LLM usage to agent');
  } catch (err) {
    log.error({ error: (err as Error).message, sessionId, agentId }, 'Failed to attribute session to agent');
  }
}

/**
 * Write one usage row, and throw when it cannot be written.
 *
 * The providers' streaming path reaches this through initLLMUsageTracking,
 * which logs and swallows; the TypeSafe client (src/typesafe/usage.ts) calls
 * it directly and treats a throw as "the answer is not used". Two callers, one
 * statement.
 *
 * Idempotent on `call_id` (migration 506): a partial unique index over
 * `call_id WHERE call_id IS NOT NULL`, and PostgreSQL infers a partial index
 * only when the conflict target repeats its predicate, so the bare
 * `ON CONFLICT (call_id)` is rejected at runtime and the predicate is spelled
 * out. A NULL call_id — every row the streaming path writes — never conflicts.
 */
export async function writeUsageEvent(event: LLMUsageEvent): Promise<void> {
  await withAdminScope({ caller: 'llm.usage-tracker', reason: 'llm_usage_log writer: tenant_id may be NULL (platform calls) + by-session attribution (content table)' }, (client) => client.query(
    `INSERT INTO llm_usage_log (
      timestamp, provider, model,
      input_tokens, output_tokens, web_search_requests, web_fetch_requests,
      cache_creation_input_tokens, cache_read_input_tokens,
      success, error_message,
      tenant_id, purpose, agent_id, session_id,
      thread_id, invocation_id, item_id,
      call_id, attempts, vendor_request_id, vendor_cost_usd
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NULL, $18, $19, $20, $21)
    ON CONFLICT (call_id) WHERE call_id IS NOT NULL DO NOTHING`,
    [
      event.timestamp,
      event.provider,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.webSearchRequests ?? 0,
      event.webFetchRequests ?? 0,
      event.cacheWriteTokens ?? 0,
      event.cacheReadTokens ?? 0,
      event.success,
      event.error || null,
      event.context?.tenantId || null,
      event.context?.purpose || null,
      event.context?.agentId || null,
      event.context?.sessionId || null,
      event.context?.threadId || null,
      event.context?.invocationId || null,
      event.callId ?? null,
      event.attempts ?? null,
      event.vendorRequestId ?? null,
      // NULL, not 0, when the vendor reported no charge. A reader prices a NULL
      // row from the rate table; a 0 would read as a free call and un-bill it.
      event.vendorCostUsd ?? null,
    ]
  ));
  // This service's own model spend reaches the cost pass only through the
  // pass's read of llm_usage_log; arm it (maintenance-targets.ts).
  armCostIngest('platform');
}

async function persistUsageEvent(event: LLMUsageEvent): Promise<void> {
  await writeUsageEvent(event);
}
