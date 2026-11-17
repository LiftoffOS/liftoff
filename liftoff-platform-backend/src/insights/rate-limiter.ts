// Insights Rate Limiter
//
// Thin wrapper around the shared chat rate limiter in src/common. Exists so
// the existing call sites (router.ts, stream-router.ts, plus any tests that
// mock this module by name) keep the same import path.
//
// Logic lives in src/common/chat-rate-limiter.ts; this file only binds the
// insights-specific ledger table name.

import {
  checkAndIncrementChatRateLimit,
  type ChatRateLimitResult,
} from '../common/chat-rate-limiter';
import type { InsightsRateLimitResult } from './types';

const INSIGHTS_RATE_LIMIT_TABLE = 'insights_rate_limit_events';

/**
 * Atomically check and increment rate limits for an insights chat message.
 * Delegates to the shared `checkAndIncrementChatRateLimit` with the insights
 * ledger table bound in. See the shared module for the atomic-CTE mechanics.
 */
export async function checkAndIncrementInsightsRateLimit(
  tenantId: string,
  accountId: string,
): Promise<InsightsRateLimitResult> {
  const result: ChatRateLimitResult = await checkAndIncrementChatRateLimit({
    tableName: INSIGHTS_RATE_LIMIT_TABLE,
    tenantId,
    accountId,
  });
  // ChatRateLimitResult and InsightsRateLimitResult have identical shape; the
  // assertion is just a name-level adapter for the existing callers/types.
  return result as InsightsRateLimitResult;
}
