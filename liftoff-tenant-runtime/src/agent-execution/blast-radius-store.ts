// The per-invocation blast-radius counter, persisted.
//
// Every dispatch path that can change something adds to one row keyed by
// invocation, so a run's total is the same number whichever pod or process
// asks. That is what makes the sandbox path — a separate HTTP request from the
// sidecar, potentially on a different pod — measurable at all, and what makes a
// resumed run measure against the work that already happened.
//
// NEVER THROWS. This is consulted inside a governance decision. A database
// hiccup must not fail an agent's turn, so a failed read reports zeroes and a
// failed write is logged and dropped. Both under-report, which biases toward
// letting work through rather than blocking it — the same direction every other
// degraded path here takes, and stated so it is a decision rather than an
// accident.

import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import type { RunningTotals } from '../tool-gateway/plan-quantifier';

const ZERO: RunningTotals = { entitiesTouched: 0, destructiveOps: 0, clearedFields: 0 };

/** What this run has changed so far. Zeroes when there is no row yet, which is
 *  the truth for a run that has not dispatched anything. */
export async function readRunTotals(
  tenantId: string,
  invocationId: string,
): Promise<RunningTotals> {
  try {
    const { rows } = await withTenantScope(tenantId, (client) =>
      client.query<{ entities_touched: number; destructive_ops: number; cleared_fields: number }>(
        `SELECT entities_touched, destructive_ops, cleared_fields
           FROM invocation_blast_radius
          WHERE tenant_id = $1 AND invocation_id = $2`,
        [tenantId, invocationId],
      ),
    );
    const row = rows[0];
    if (!row) return { ...ZERO };
    return {
      entitiesTouched: row.entities_touched,
      destructiveOps: row.destructive_ops,
      clearedFields: row.cleared_fields,
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, invocationId },
      'blast_radius_read_failed — treating this run as having changed nothing so far',
    );
    return { ...ZERO };
  }
}

/**
 * Add one dispatched batch to the run's totals, atomically.
 *
 * The increment is done IN SQL rather than read-modify-write: two dispatch
 * paths can be in flight in one run at the same time (the LLM loop and a
 * sandbox script), and a last-write-wins update would silently discard
 * whichever lost the race. The discarded half is precisely the evidence the
 * gate exists to accumulate.
 *
 * Returns the new totals, or null when the write failed.
 */
export async function incrementRunTotals(
  tenantId: string,
  invocationId: string,
  batch: { entitiesTouched: number; destructiveOps: number; clearedFields: number },
): Promise<RunningTotals | null> {
  try {
    const { rows } = await withTenantScope(tenantId, (client) =>
      client.query<{ entities_touched: number; destructive_ops: number; cleared_fields: number }>(
        `INSERT INTO invocation_blast_radius
           (tenant_id, invocation_id, entities_touched, destructive_ops, cleared_fields)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, invocation_id) DO UPDATE SET
           entities_touched = invocation_blast_radius.entities_touched + EXCLUDED.entities_touched,
           destructive_ops  = invocation_blast_radius.destructive_ops  + EXCLUDED.destructive_ops,
           cleared_fields   = invocation_blast_radius.cleared_fields   + EXCLUDED.cleared_fields,
           updated_at       = NOW()
         RETURNING entities_touched, destructive_ops, cleared_fields`,
        [tenantId, invocationId, batch.entitiesTouched, batch.destructiveOps, batch.clearedFields],
      ),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      entitiesTouched: row.entities_touched,
      destructiveOps: row.destructive_ops,
      clearedFields: row.cleared_fields,
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, invocationId, batch },
      'blast_radius_increment_failed — this batch is not counted toward the run total',
    );
    return null;
  }
}

/**
 * Remove counters for runs that finished long ago.
 *
 * The row is only interesting while its run is live. Without a sweep this table
 * grows one row per invocation forever, which is a slow leak rather than a
 * failure and therefore the kind nobody notices.
 */
export async function pruneOldRunTotals(tenantId: string, olderThanHours = 72): Promise<number> {
  try {
    const { rowCount } = await withTenantScope(tenantId, (client) =>
      client.query(
        `DELETE FROM invocation_blast_radius
          WHERE tenant_id = $1 AND updated_at < NOW() - ($2 || ' hours')::interval`,
        [tenantId, String(olderThanHours)],
      ),
    );
    return rowCount ?? 0;
  } catch (err) {
    logger.warn({ err: (err as Error).message, tenantId }, 'blast_radius_prune_failed');
    return 0;
  }
}
