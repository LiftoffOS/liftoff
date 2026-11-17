// Idempotency reconciliation sweeper (plan §4.8).
//
// Finds at_most_once side-effect rows stuck in 'processing' past the crash window
// (a claim was made, the side effect may or may not have fired, but the run died
// before resolve/fail) and marks them 'abandoned' + emits an operator audit row.
// This is the "figure out later why it was missed" half of at-most-once.
//
// effectively_once stuck rows are intentionally NOT touched — the next attempt
// reclaims them via claimSideEffect's WHERE clause (vendor key / natural
// idempotency makes the retry safe).
//
// Gated on IDEMPOTENCY_RECONCILER_ENABLED + isExecutionAllowed. Armed by
// claimSideEffect for one window after an at_most_once claim, re-armed while a
// claim is in flight, and run by the daily housekeeping pass. Also
// opportunistically prunes expired idempotency_result_payloads.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { isExecutionAllowed } from '../entitlements-client/service';
import { insertAuditLog } from '../audit';

const STUCK_INTERVAL = "INTERVAL '10 minutes'";

function isEnabled(): boolean {
  return process.env.IDEMPOTENCY_RECONCILER_ENABLED === '1';
}

function pool() {
  return getPoolForService('default');
}

/**
 * Whether this tenant has an at_most_once claim still in flight: one the
 * reconciler will abandon if its run never resolves it. The reconcile route
 * re-arms itself while this holds, so a stuck claim is abandoned within one
 * window of becoming stuck rather than at the next daily pass. False while
 * the reconciler would skip the tenant, so a suspended tenant's stuck claim
 * cannot keep the check alive.
 */
export async function hasInFlightAtMostOnceClaims(tenantId: string): Promise<boolean> {
  if (!isEnabled()) return false;
  if (!(await isExecutionAllowed(tenantId))) return false;
  const res = await pool().query(
    `SELECT 1 FROM event_processing_ledger
      WHERE tenant_id = $1::uuid
        AND event_type = 'side_effect'
        AND status = 'processing'
        AND result_metadata->>'policy' = 'at_most_once'
      LIMIT 1`,
    [tenantId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function runIdempotencyReconciliation(
  tenantId: string,
): Promise<{ abandoned: number; pruned: number; ledgerPruned: number }> {
  if (!isEnabled()) {
    logger.info({ tenantId }, 'idempotency-reconciler: disabled (IDEMPOTENCY_RECONCILER_ENABLED!=1)');
    return { abandoned: 0, pruned: 0, ledgerPruned: 0 };
  }
  if (!(await isExecutionAllowed(tenantId))) {
    logger.info({ tenantId }, 'idempotency-reconciler: skipped (tenant not execution-allowed / suspended)');
    return { abandoned: 0, pruned: 0, ledgerPruned: 0 };
  }

  let abandoned = 0;
  try {
    // Atomic claim-and-return so concurrent reconcilers don't double-process.
    const res = await pool().query<{ event_id: string; entity_id: string }>(
      `UPDATE event_processing_ledger
         SET status='abandoned', updated_at=NOW()
       WHERE tenant_id = $1::uuid
         AND event_type = 'side_effect'
         AND status = 'processing'
         AND result_metadata->>'policy' = 'at_most_once'
         AND updated_at < NOW() - ${STUCK_INTERVAL}
       RETURNING event_id, entity_id`,
      [tenantId],
    );
    abandoned = res.rows.length;
    for (const row of res.rows) {
      // Operator-visible record of the dropped action. (§4.9: also append an
      // open item to the agent's task ledger — "attempted <tool>, outcome
      // unknown, verify/redo" — once Part B lands.)
      await insertAuditLog(null, tenantId, {
        action: 'idempotency_step_abandoned',
        inputArgs: { stepKey: row.event_id },
        outcome: 'error',
        errorCode: 'side_effect_abandoned',
        triggeredBy: 'system',
      }).catch((err) =>
        logger.warn({ err: (err as Error).message, stepKey: row.event_id }, 'idempotency-reconciler: audit insert failed'),
      );
    }
    if (abandoned > 0) {
      logger.warn({ tenantId, abandoned }, 'idempotency-reconciler: abandoned stuck at_most_once side effects');
    }
  } catch (err) {
    logger.error({ tenantId, err: (err as Error).message }, 'idempotency-reconciler: abandon sweep failed');
  }

  // Opportunistic TTL prune of replay payloads (cheap, indexed on expires_at).
  let pruned = 0;
  try {
    const del = await pool().query(
      `DELETE FROM idempotency_result_payloads WHERE tenant_id = $1::uuid AND expires_at < NOW()`,
      [tenantId],
    );
    pruned = del.rowCount ?? 0;
  } catch (err) {
    logger.warn({ tenantId, err: (err as Error).message }, 'idempotency-reconciler: payload prune failed');
  }

  // Bound event_processing_ledger growth: the connector-event defer path adds a
  // ledger row per event. Prune terminal rows (>14d) in a single batch. 14 days
  // ≫ any redelivery window (Cloud Tasks max_retry_duration 1h; Pub/Sub ≤7d);
  // status <> 'processing' also covers the reconciler's own 'abandoned' rows.
  let ledgerPruned = 0;
  try {
    const del = await pool().query(
      `DELETE FROM event_processing_ledger
        WHERE tenant_id = $1::uuid
          AND status <> 'processing'                         -- completed/failed/abandoned; never touch in-flight
          AND updated_at < NOW() - INTERVAL '14 days'
          AND ctid IN (SELECT ctid FROM event_processing_ledger
                       WHERE tenant_id = $1::uuid AND status <> 'processing'
                         AND updated_at < NOW() - INTERVAL '14 days' LIMIT 5000)   -- batched, avoids long locks`,
      [tenantId],
    );
    ledgerPruned = del.rowCount ?? 0;
  } catch (err) {
    logger.warn({ tenantId, err: (err as Error).message }, 'idempotency-reconciler: ledger prune failed');
  }

  return { abandoned, pruned, ledgerPruned };
}
