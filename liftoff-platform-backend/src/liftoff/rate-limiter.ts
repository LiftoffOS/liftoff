// Liftoff Rate Limiter
//
// Thin wrapper around the shared chat rate limiter in src/common. Exists so the
// call sites (router.ts, stream-router.ts, plus any tests that mock this module
// by name) keep one import path per surface.
//
// Logic lives in src/common/chat-rate-limiter.ts; this file only binds the
// Liftoff-specific ledger table name, which that module refuses to use unless
// it is on its allow-list.

import {
  checkAndIncrementChatRateLimit,
  type ChatRateLimitResult,
} from '../common/chat-rate-limiter';

const LIFTOFF_RATE_LIMIT_TABLE = 'liftoff_rate_limit_events';

/**
 * Atomically check and increment rate limits for a Liftoff chat message.
 * Delegates to the shared `checkAndIncrementChatRateLimit` with the Liftoff
 * ledger table bound in. See the shared module for the atomic-CTE mechanics.
 */
export async function checkAndIncrementLiftoffRateLimit(
  tenantId: string,
  accountId: string,
): Promise<ChatRateLimitResult> {
  return checkAndIncrementChatRateLimit({
    tableName: LIFTOFF_RATE_LIMIT_TABLE,
    tenantId,
    accountId,
  });
}
