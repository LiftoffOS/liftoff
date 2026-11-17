// Memory usefulness tracking.
//
// After each agent execution, updates usefulness_score for injected memories:
//   +1 on success (always, including cold start)
//   -1 on failure (only past cold start — first 5 executions forgiven)
//
// Uses atomic conditional UPDATE — no read-then-write TOCTOU race.
// 24h rate limit per memory via usefulness_last_updated WHERE clause.
// Auto-supersedes at usefulness_score <= -3.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import type { Clock } from '../test-utils/clock';
import { systemClock } from '../test-utils/clock';

const COLD_START_THRESHOLD = 5;
const AUTO_SUPERSEDE_THRESHOLD = -3;
const RATE_LIMIT_HOURS = 24;

/**
 * Update usefulness scores for memories that were injected during this execution.
 * Returns the IDs that were actually updated (rate-limited ones are skipped).
 */
export async function updateUsefulnessScores(
  injectedMemoryIds: string[],
  delta: 1 | -1,
  ttlIntervalDays: number,
  clock: Clock = systemClock,
): Promise<string[]> {
  if (injectedMemoryIds.length === 0) return [];

  const pool = getPoolForService('scheduled-execution');
  const now = new Date(clock());

  // Atomic conditional UPDATE — the WHERE clause ensures:
  // 1. Rate limit: only update if last update was > 24h ago
  // 2. Not already superseded
  // No TOCTOU race — PostgreSQL row-level locking serializes concurrent UPDATEs
  const result = await pool.query<{ id: string; usefulness_score: number }>(
    `UPDATE memories
     SET usefulness_score = usefulness_score + $1,
         usefulness_last_updated = $2,
         expires_at = CASE WHEN $1 > 0
           THEN LEAST($2::timestamptz + ($3 || ' days')::interval,
                       COALESCE(expires_at, $2::timestamptz + ($3 || ' days')::interval))
           ELSE expires_at END
     WHERE id = ANY($4)
       AND (usefulness_last_updated IS NULL OR usefulness_last_updated < $2::timestamptz - INTERVAL '${RATE_LIMIT_HOURS} hours')
       AND superseded_by IS NULL
     RETURNING id, usefulness_score`,
    [delta, now, ttlIntervalDays, injectedMemoryIds],
  );

  const updatedIds = result.rows.map(r => r.id);

  // Auto-supersede memories that dropped to <= -3
  const toSupersede = result.rows.filter(r => r.usefulness_score <= AUTO_SUPERSEDE_THRESHOLD);
  if (toSupersede.length > 0) {
    const supersededIds = toSupersede.map(r => r.id);
    await pool.query(
      `UPDATE memories
       SET superseded_by = id, superseded_at = $1, supersession_reason = 'negative-usefulness'
       WHERE id = ANY($2)`,
      [now, supersededIds],
    );
    logger.info({
      supersededIds,
      threshold: AUTO_SUPERSEDE_THRESHOLD,
    }, 'usefulness-tracker: auto-superseded memories with negative usefulness');
  }

  return updatedIds;
}

/**
 * Check if an agent is past the cold-start period (> 5 executions).
 * Uses LIMIT 6 instead of COUNT(*) for performance — stops scanning after 6 rows.
 */
export async function checkPastColdStart(
  tenantId: string,
  agentId: string,
): Promise<boolean> {
  const pool = getPoolForService('scheduled-execution');
  const result = await pool.query(
    `SELECT 1 FROM invocations WHERE tenant_id = $1 AND agent_id = $2 LIMIT $3`,
    [tenantId, agentId, COLD_START_THRESHOLD + 1],
  );
  return result.rowCount >= COLD_START_THRESHOLD + 1;
}
