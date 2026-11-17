// Postgres-backed distributed rate limiter.
// Uses INSERT ON CONFLICT to atomically increment per-window counters,
// giving correct counts across all Cloud Run instances sharing the same DB.

import type { Pool } from 'pg';

const WINDOW_SECS = 60;

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limitCount: number;
  resetAt: Date;
}

// bucketKey: "{credentialId}:{vendor}" — window is derived from current time.
export async function checkPgRateLimit(
  pool: Pool,
  bucketKey: string,
  limitCount: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs    = WINDOW_SECS * 1000;
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const resetAt     = new Date(windowStart.getTime() + windowMs);

  const result = await pool.query<{ count: number }>(
    `INSERT INTO developer_proxy_rate_limit_buckets (bucket_key, window_start, count, limit_count)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (bucket_key, window_start) DO UPDATE
       SET count = developer_proxy_rate_limit_buckets.count + 1
     RETURNING count`,
    [bucketKey, windowStart, limitCount],
  );

  const count = Number(result.rows[0].count);
  return { allowed: count <= limitCount, count, limitCount, resetAt };
}

// Periodic cleanup: delete rows older than 2 minutes.
// Call this from a low-frequency background task, not on the hot path.
export async function cleanupExpiredBuckets(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM developer_proxy_rate_limit_buckets
     WHERE window_start < NOW() - INTERVAL '2 minutes'`,
  );
}
