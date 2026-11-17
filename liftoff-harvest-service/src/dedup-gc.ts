// In-process garbage collector for harvest_dedup.
//
// Cloud SQL doesn't ship with pg_cron by default, so the migration's DO $$
// block silently skips scheduling. This module fills the gap: a setInterval
// that runs every hour and deletes dedup rows older than 7 days.
//
// 7 days >> Pub/Sub max redelivery window (~7 days at max backoff), so any
// row that's survived 7 days is safe to purge — it will never be redelivered.

import { getPool } from './infrastructure/database';
import { log } from './infrastructure/logging';

const GC_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour

let gcTimer: ReturnType<typeof setInterval> | null = null;

export async function runGC(): Promise<void> {
  try {
    const result = await getPool().query(
      `DELETE FROM harvest_dedup WHERE processed_at < now() - INTERVAL '7 days'`,
    );
    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      log.info({ deleted }, 'harvest_dedup GC: pruned old entries');
    }
  } catch (err) {
    // Non-fatal: if the DB is temporarily unavailable the next interval will
    // catch up. The dedup table only grows, never causes incorrect behaviour.
    log.warn({ error: (err as Error).message }, 'harvest_dedup GC run failed (non-fatal)');
  }
}

export function startDedupGC(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => void runGC(), GC_INTERVAL_MS);
  // Allow the process to exit even if the timer is pending.
  if (gcTimer.unref) gcTimer.unref();
  log.info({ intervalMs: GC_INTERVAL_MS }, 'harvest_dedup GC started');
}

export function stopDedupGC(): void {
  if (!gcTimer) return;
  clearInterval(gcTimer);
  gcTimer = null;
}
