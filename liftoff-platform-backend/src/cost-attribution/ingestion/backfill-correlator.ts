// Backfill Correlator
//
// Updates agent_id on cost_attribution_events rows where it was not
// captured at ingestion time (developer proxy and governance rows from before
// those services logged agent_id directly).
//
// Strategy:
//   1. Exact match: join on invocation_id within the same tenant_id.
//      Sets correlation_confidence = 'exact'.
//   2. Fuzzy match: join on closest occurred_at within ±5 seconds for
//      the same tenant_id. Sets correlation_confidence = 'fuzzy'.
//   3. Mark remaining NULL rows as 'unmatched'.
//
// Safe to run multiple times — ON CONFLICT / WHERE agent_id IS NULL guards
// prevent overwriting already-correlated rows.

import { withAdminScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';

export interface CorrelatorStats {
  exact:     number;
  fuzzy:     number;
  unmatched: number;
}

// cost_attribution_events is RLS-on (migration 200). This correlator is a
// nightly batch job that operates across every tenant — admin scope is the
// correct primitive. The self-join is naturally bound by `tenant_id = t.tenant_id`
// so cross-tenant correlation is impossible by query construction.
export async function runBackfillCorrelator(): Promise<CorrelatorStats> {
  const stats: CorrelatorStats = { exact: 0, fuzzy: 0, unmatched: 0 };

  return withAdminScope(
    {
      caller: 'cost-attribution.backfill-correlator',
      reason: 'nightly cross-tenant agent_id backfill on cost_attribution_events',
    },
    async (client) => {
      // ── Step 1: exact match via invocation_id ────────────────────────────
      const exactResult = await client.query(`
        UPDATE cost_attribution_events t
           SET agent_id               = s.agent_id,
               correlation_confidence = 'exact'
          FROM cost_attribution_events s
         WHERE t.agent_id       IS NULL
           AND t.invocation_id  IS NOT NULL
           AND s.agent_id       IS NOT NULL
           AND s.invocation_id  = t.invocation_id
           AND s.tenant_id      = t.tenant_id
      `);
      stats.exact = exactResult.rowCount ?? 0;
      log.info({ exact: stats.exact }, 'backfill-correlator: exact pass done');

      // ── Step 2: fuzzy match via timestamp ±5 seconds ─────────────────────
      // Use DISTINCT ON to pick the temporally closest match per target row.
      const fuzzyResult = await client.query(`
        UPDATE cost_attribution_events t
           SET agent_id               = closest.agent_id,
               correlation_confidence = 'fuzzy'
          FROM (
            SELECT DISTINCT ON (target_id)
                   cand_target.id   AS target_id,
                   cand_source.agent_id
              FROM cost_attribution_events cand_target
              JOIN cost_attribution_events cand_source
                ON cand_source.tenant_id = cand_target.tenant_id
               AND cand_source.agent_id IS NOT NULL
               AND cand_source.occurred_at BETWEEN
                     cand_target.occurred_at - INTERVAL '5 seconds'
                 AND cand_target.occurred_at + INTERVAL '5 seconds'
             WHERE cand_target.agent_id IS NULL
             ORDER BY cand_target.id,
                      ABS(EXTRACT(EPOCH FROM (cand_source.occurred_at - cand_target.occurred_at)))
          ) closest
         WHERE t.id        = closest.target_id
           AND t.agent_id IS NULL
      `);
      stats.fuzzy = fuzzyResult.rowCount ?? 0;
      log.info({ fuzzy: stats.fuzzy }, 'backfill-correlator: fuzzy pass done');

      // ── Step 3: mark remaining rows as unmatched ─────────────────────────
      const unmatchedResult = await client.query(`
        UPDATE cost_attribution_events
           SET correlation_confidence = 'unmatched'
         WHERE agent_id               IS NULL
           AND correlation_confidence IS NULL
      `);
      stats.unmatched = unmatchedResult.rowCount ?? 0;
      log.info({ unmatched: stats.unmatched }, 'backfill-correlator: unmatched pass done');

      log.info({ ...stats }, 'backfill-correlator: complete');
      return stats;
    },
  );
}
