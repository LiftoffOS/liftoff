// Per-source + per-tenant minute-bucket rate limiter for inbound webhooks.
//
// Atomic check-and-increment: a single CTE inserts one row into
// event_source_rate_limit_events and counts the last-60s windows for both
// the source and the tenant. If either window exceeds its cap, the insert
// is rolled back so the offending request doesn't bump future counts.
//
// Mirrors the shape of src/common/chat-rate-limiter.ts but stays minute-only
// (the chat limiter also enforces hour/day windows, which aren't part of
// the webhook plan). Takes a tenant-scoped PoolClient so RLS is honored
// when FORCE RLS rolls out — see migration 200's comment for the BYPASSRLS
// trajectory across this codebase.

import type { PoolClient } from 'pg';
import { log } from './log-scrubber';

const TABLE = 'event_source_rate_limit_events';

export interface WebhookRateLimitResult {
  allowed: boolean;
  /** Cause of rejection. Maps directly onto event_deliveries.status. */
  reason?: 'rejected_rate' | 'rejected_tenant_ceiling';
  /** Seconds until the next minute boundary; sent in the Retry-After header. */
  retryAfter?: number;
}

export interface WebhookRateLimitInput {
  client: PoolClient;
  tenantId: string;
  sourceId: string;
  /** Per-source max requests per 60s window. */
  sourceLimitPerMinute: number;
  /** Per-tenant cross-source max requests per 60s window. */
  tenantLimitPerMinute: number;
}

/**
 * Atomically:
 *   1. INSERT a (tenant_id, source_id) row keyed at now().
 *   2. SELECT the count of (tenant_id, _) rows in the last 60s.
 *   3. SELECT the count of (_, source_id) rows in the last 60s.
 *   4. If either count exceeds its limit, DELETE the just-inserted row and
 *      return the matching rejection reason. Otherwise return allowed=true.
 *
 * The tenant check fires first so a tenant-ceiling breach short-circuits
 * before a source-specific 429 is reported.
 *
 * On DB failure, fails OPEN with a logged warning — better to over-serve
 * one request than block all webhook traffic when the ledger query hiccups.
 */
export async function checkAndIncrementWebhookRateLimit(
  input: WebhookRateLimitInput,
): Promise<WebhookRateLimitResult> {
  const minuteAgo = new Date(Date.now() - 60_000);
  try {
    const result = await input.client.query<{ tenant_count: string; source_count: string }>(
      `WITH inserted AS (
         INSERT INTO ${TABLE} (tenant_id, account_id)
         VALUES ($1, $2)
         RETURNING id
       )
       SELECT
         (SELECT COUNT(*) FROM ${TABLE}
            WHERE tenant_id = $1 AND created_at >= $3)::text as tenant_count,
         (SELECT COUNT(*) FROM ${TABLE}
            WHERE account_id = $2 AND created_at >= $3)::text as source_count`,
      [input.tenantId, input.sourceId, minuteAgo],
    );
    const tenantCount = parseInt(result.rows[0]?.tenant_count ?? '0', 10);
    const sourceCount = parseInt(result.rows[0]?.source_count ?? '0', 10);

    if (tenantCount > input.tenantLimitPerMinute) {
      await rollback(input);
      return { allowed: false, reason: 'rejected_tenant_ceiling', retryAfter: retryAfterSeconds() };
    }
    if (sourceCount > input.sourceLimitPerMinute) {
      await rollback(input);
      return { allowed: false, reason: 'rejected_rate', retryAfter: retryAfterSeconds() };
    }
    return { allowed: true };
  } catch (err) {
    log.warn(
      { tenantId: input.tenantId, sourceId: input.sourceId, error: (err as Error).message },
      'webhook rate-limiter query failed — failing open',
    );
    return { allowed: true };
  }
}

async function rollback(input: WebhookRateLimitInput): Promise<void> {
  try {
    await input.client.query(
      `DELETE FROM ${TABLE}
       WHERE id = (
         SELECT id FROM ${TABLE}
         WHERE tenant_id = $1 AND account_id = $2
         ORDER BY created_at DESC LIMIT 1
       )`,
      [input.tenantId, input.sourceId],
    );
  } catch {
    // intentional swallow — row ages out of the window in <60s
  }
}

function retryAfterSeconds(): number {
  // Seconds until the next minute boundary. Always at least 1s so clients
  // don't immediately retry.
  return Math.max(1, 60 - new Date().getSeconds());
}
