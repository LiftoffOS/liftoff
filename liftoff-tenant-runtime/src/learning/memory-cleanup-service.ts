// Memory Cleanup Service
// Periodically hard-deletes expired and superseded memories.
// Follows the archival service pattern: batch processing + audit trail.
//
// REVIEW FIX DE-005: Uses FOR UPDATE SKIP LOCKED to prevent lock contention.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

const BATCH_SIZE = 100;
// Keep superseded memories for 7 days after supersession (audit trail)
const SUPERSEDED_RETENTION_DAYS = 7;

export interface CleanupResult {
  expiredDeleted: number;
  supersededDeleted: number;
  tenantId: string;
  durationMs: number;
}

export async function runMemoryCleanup(tenantId: string): Promise<CleanupResult> {
  const pool = getPoolForService('reflection-engine');
  const startTime = Date.now();
  let expiredDeleted = 0;
  let supersededDeleted = 0;

  // REVIEW FIX DE-005: Use FOR UPDATE SKIP LOCKED to prevent lock contention
  // 1. Hard-delete expired memories (past their expires_at)
  while (true) {
    const result = await pool.query(
      `DELETE FROM memories
       WHERE id IN (
         SELECT id FROM memories
         WHERE tenant_id = $1 AND expires_at IS NOT NULL AND expires_at < NOW()
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [tenantId, BATCH_SIZE]
    );
    expiredDeleted += result.rowCount || 0;
    if ((result.rowCount || 0) < BATCH_SIZE) break;
  }

  // 2. Hard-delete superseded memories older than retention period
  const supersededCutoff = new Date(Date.now() - SUPERSEDED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  while (true) {
    const result = await pool.query(
      `DELETE FROM memories
       WHERE id IN (
         SELECT id FROM memories
         WHERE tenant_id = $1 AND superseded_at IS NOT NULL AND superseded_at < $2
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [tenantId, supersededCutoff.toISOString(), BATCH_SIZE]
    );
    supersededDeleted += result.rowCount || 0;
    if ((result.rowCount || 0) < BATCH_SIZE) break;
  }

  // 3. Change B: drop old memory_influence_rollup rows (90-day retention)
  const rollupCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await pool.query(
    `DELETE FROM memory_influence_rollup WHERE tenant_id = $1 AND day < $2`,
    [tenantId, rollupCutoff.toISOString().slice(0, 10)],
  ).catch((err: Error) => logger.warn({ tenantId, err: err.message }, 'rollup cleanup failed (non-fatal)'));

  // 4. Change B: tenant-bounded delete from HASH-partitioned memory_retrieval_events.
  //    30-day retention.
  const eventsCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let eventsDeleted = 0;
  while (true) {
    try {
      const result = await pool.query(
        `DELETE FROM memory_retrieval_events
         WHERE ctid IN (
           SELECT ctid FROM memory_retrieval_events
           WHERE tenant_id = $1 AND created_at < $2
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id`,
        [tenantId, eventsCutoff.toISOString(), BATCH_SIZE],
      );
      eventsDeleted += result.rowCount || 0;
      if ((result.rowCount || 0) < BATCH_SIZE) break;
    } catch (err) {
      logger.warn({ tenantId, err: (err as Error).message }, 'memory_retrieval_events cleanup failed (non-fatal)');
      break;
    }
  }

  const durationMs = Date.now() - startTime;

  logger.info({
    tenantId, expiredDeleted, supersededDeleted, eventsDeleted, durationMs,
  }, 'Memory cleanup completed');

  return { expiredDeleted, supersededDeleted, tenantId, durationMs };
}

// Embedding cache cleanup is GLOBAL (cache is shared across tenants).
// Invoked from a weekly Cloud Tasks route, not from the per-tenant sweep.
const EMBEDDING_CACHE_RETENTION_DAYS = 90;

export async function runEmbeddingCacheCleanup(): Promise<{ deleted: number; durationMs: number }> {
  const pool = getPoolForService('reflection-engine');
  const startTime = Date.now();
  const cutoff = new Date(Date.now() - EMBEDDING_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let deleted = 0;

  while (true) {
    const result = await pool.query(
      `DELETE FROM embedding_cache
       WHERE (content_hash, embedding_model) IN (
         SELECT content_hash, embedding_model FROM embedding_cache
         WHERE last_used_at < $1
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING content_hash`,
      [cutoff.toISOString(), BATCH_SIZE],
    );
    deleted += result.rowCount || 0;
    if ((result.rowCount || 0) < BATCH_SIZE) break;
  }

  const durationMs = Date.now() - startTime;
  logger.info({ deleted, durationMs }, 'Embedding cache cleanup completed');
  return { deleted, durationMs };
}
