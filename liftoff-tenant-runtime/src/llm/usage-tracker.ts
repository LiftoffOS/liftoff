// LLM Usage Tracker
// Registers an onUsage callback on the LLM client that persists every
// call (success or failure) to the llm_usage_log table.
// This is the single source of truth for token consumption.

import { llmClient } from './client';
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import type { LLMUsageEvent } from './types';

/**
 * Call once at startup to begin tracking all LLM calls.
 */
export function initLLMUsageTracking(): void {
  llmClient.onUsage((event: LLMUsageEvent) => {
    // Fire-and-forget — usage recording must never block or fail the LLM call.
    persistUsageEvent(event).catch(err => {
      logger.error({
        error: (err as Error).message,
        provider: event.provider,
        model: event.model,
        input_tokens: event.inputTokens,
        output_tokens: event.outputTokens,
        success: event.success,
        context: event.context,
      }, 'Failed to persist LLM usage event');
    });
  });

  logger.info('LLM usage tracking initialized');
}

/** Write one token-consumption row.
 *
 *  Exported because not every LLM call in this runtime goes through
 *  `llmClient` — a nested `code_session` runs a vendor coding agent in its own
 *  subprocess and reports its usage back out-of-band. That spend is as real as
 *  any other, and this table calls itself the single source of truth for token
 *  consumption, so the out-of-band callers land in it through the SAME insert
 *  rather than a parallel one that could drift from it. */
export async function persistUsageEvent(event: LLMUsageEvent): Promise<void> {
  const pool = getPool();

  await pool.query(
    `INSERT INTO llm_usage_log (
      timestamp, provider, model,
      input_tokens, output_tokens, cached_tokens,
      success, error_message,
      tenant_id, agent_id, invocation_id, purpose
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      event.timestamp,
      event.provider,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.cachedTokens,
      event.success,
      event.error || null,
      event.context?.tenantId || null,
      event.context?.agentId || null,
      event.context?.invocationId || null,
      event.context?.purpose || null,
    ]
  );
}
