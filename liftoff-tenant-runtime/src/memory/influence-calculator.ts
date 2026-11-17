// src/memory/influence-calculator.ts
// Two phases:
//   1. Daily rollup: aggregates raw events into memory_influence_rollup by day.
//   2. Recompute: derives influence_score from rollup over 30-day window.
// Per-tenant; guarded by tenants.influence_last_recomputed.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { observeHistogram } from './metrics';

const LOOKBACK_DAYS = parseInt(process.env.MEM_INFLUENCE_LOOKBACK_DAYS ?? '30', 10);
const RECOMPUTE_GUARD_HOURS = parseInt(process.env.MEM_INFLUENCE_GUARD_HOURS ?? '11', 10);

export async function rollupYesterday(tenantId: string): Promise<number> {
  const pool = getPoolForService('scheduled-execution');
  const result = await pool.query(
    `INSERT INTO memory_influence_rollup (tenant_id, memory_id, day, retrieved, cited)
     SELECT $1 AS tenant_id, m_id, day,
            COUNT(*)::int AS retrieved,
            SUM(cited)::int AS cited
     FROM (
       SELECT unnest(retrieved_ids) AS m_id,
              date_trunc('day', created_at)::date AS day,
              CASE WHEN unnest(retrieved_ids) = ANY(cited_ids) THEN 1 ELSE 0 END AS cited
       FROM memory_retrieval_events
       WHERE tenant_id = $1
         AND created_at >= CURRENT_DATE - INTERVAL '1 day'
         AND created_at < CURRENT_DATE
     ) e
     GROUP BY m_id, day
     ON CONFLICT (tenant_id, memory_id, day) DO UPDATE SET
       retrieved = EXCLUDED.retrieved,
       cited = EXCLUDED.cited
     RETURNING memory_id`,
    [tenantId],
  );
  return result.rowCount ?? 0;
}

export async function recomputeInfluenceScores(
  tenantId: string,
): Promise<{ updated: number; skipped: boolean }> {
  const pool = getPoolForService('scheduled-execution');

  const guard = await pool.query<{ should_run: boolean }>(
    `UPDATE tenants
     SET influence_last_recomputed = NOW()
     WHERE id = $1
       AND (influence_last_recomputed IS NULL
            OR influence_last_recomputed < NOW() - ($2 || ' hours')::interval)
     RETURNING TRUE AS should_run`,
    [tenantId, RECOMPUTE_GUARD_HOURS],
  );
  if (guard.rowCount === 0) return { updated: 0, skipped: true };

  // Reads only from rollup table — incremental, not full-scan.
  const result = await pool.query<{ id: string; influence_score: number; layer: string }>(
    `WITH stats AS (
       SELECT memory_id,
              SUM(retrieved) AS retrieved,
              SUM(cited) AS cited
       FROM memory_influence_rollup
       WHERE tenant_id = $1 AND day > CURRENT_DATE - ($2 || ' days')::interval
       GROUP BY memory_id
     )
     UPDATE memories m
     SET influence_score = LEAST(GREATEST((s.cited + 0.5) / (s.retrieved + 1.0), 0.0), 1.0),
         influence_last_computed = NOW()
     FROM stats s
     WHERE m.id = s.memory_id AND m.tenant_id = $1
     RETURNING m.id, m.influence_score, m.layer`,
    [tenantId, LOOKBACK_DAYS],
  );

  // Emit per-layer histogram of post-recompute influence scores. Bucket boundaries
  // chosen to surface the bulk of the distribution: heavy clustering near 0.5
  // (default) with right-tail for high-influence memories.
  for (const row of result.rows) {
    observeHistogram(
      'influence_score',
      Number(row.influence_score),
      // No tenant_id: this loop emits one observation per ROW, so a per-tenant
      // label would key a new accumulator entry for every tenant it ever sees.
      { __name: 'influence_score', layer: row.layer },
    );
  }

  logger.info({ tenantId, updated: result.rowCount ?? 0, lookbackDays: LOOKBACK_DAYS }, 'influence-calculator: recomputed');
  return { updated: result.rowCount ?? 0, skipped: false };
}
