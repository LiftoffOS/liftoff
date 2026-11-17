// Retention for workflow_escalations (B1 to B3).
//
// Escalations are operator records now: nothing customer-facing reads this
// table, so it accumulates with nobody looking at it. Two windows, both 30
// days, matching the Cloud Logging default engineers already expect:
//
//   1. A `system_internal` row still `pending` after 30 days is not a to-do any
//      more, it is archaeology. It gets resolved with a sweeper marker so the
//      unresolved list stays believable.
//   2. A `resolved` row older than 30 days is deleted. Its outcome is already
//      recorded in the evidence counters (migration 353), which is what makes
//      deleting it safe: the learning signal survives the row.
//
// Deliberately NOT swept: `kind = 'escalation'` rows still pending. Those are
// customer-facing, they should not accumulate at all now that a blocker parks
// the run instead, and quietly closing one would hide a live request from the
// person who could clear it. If the count is ever non-zero for more than a day
// that is a bug to fix, not a row to sweep, so this reports it instead.

import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

/** Both windows. One number, so they cannot drift apart by accident. */
export const RETENTION_DAYS = 30;

/** Bounded work per pass. The sweep runs on a schedule, so a backlog drains
 *  over several passes rather than holding one long transaction open. Paired
 *  with ORDER BY below, which is what makes the batching fair. */
export const SWEEP_BATCH = 500;

export interface RetentionResult {
  /** system_internal rows moved pending -> resolved. */
  swept: number;
  /** resolved rows deleted. */
  deleted: number;
  /** Customer-facing rows still pending. Should be zero; reported, never swept. */
  customerFacingPending: number;
}

export async function runEscalationRetention(): Promise<RetentionResult> {
  const pool = getPool();

  // 1. Sweep stale operator records.
  //
  // ORDER BY created_at is load-bearing, not tidiness. An unordered UPDATE with
  // a LIMIT lets Postgres hand back whichever rows are cheapest to reach, which
  // in practice means the same recent ones every pass while the oldest rows —
  // the entire reason the sweep exists — are never touched. The
  // clarification-expiry path orders for the same reason.
  const sweptRes = await pool.query(
    `UPDATE workflow_escalations
        SET status = 'resolved',
            resolved_at = NOW(),
            -- A distinct marker, so a swept row is never mistaken for one
            -- a person actually looked at and closed. Manual cleanups should
            -- use this same shape.
            resolution = jsonb_build_object(
              'via', 'retention_sweep',
              'reason', 'system_internal record unresolved beyond the retention window',
              'windowDays', $1::int
            )
      WHERE id IN (
        SELECT id FROM workflow_escalations
         WHERE status = 'pending'
           AND kind = 'system_internal'
           AND created_at < NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY created_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id`,
    [RETENTION_DAYS, SWEEP_BATCH],
  );

  // B2.1: sweeping must not cause a notification storm.
  //
  // The open row is both the dedup anchor and the notification suppressor, so
  // resolving one re-arms notification for the next occurrence. That is correct
  // for a person resolving a record and wrong for a bulk sweep: if the
  // underlying blocker still recurs, every swept agent would notify on its next
  // tick, all at once. The protection is that only `system_internal` rows are
  // swept, and system_internal never notified in the first place — the notifier
  // is gated on kind === 'escalation'. Nothing here can re-arm a notification
  // that was never armed.

  // 2. Delete long-resolved rows.
  //
  // Safe only because B0 moved the learning signal off these rows: the
  // reflection engine reads human_corrections from agent_evidence_totals, which
  // is stamped when the correction happens. Before that change this DELETE
  // would have walked an agent's correction history down as it ran.
  const deletedRes = await pool.query(
    `DELETE FROM workflow_escalations
      WHERE id IN (
        SELECT id FROM workflow_escalations
         WHERE status = 'resolved'
           AND resolved_at IS NOT NULL
           AND resolved_at < NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY resolved_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id`,
    [RETENTION_DAYS, SWEEP_BATCH],
  );

  // 3. Report, do not touch.
  const pendingRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM workflow_escalations
      WHERE status = 'pending' AND kind = 'escalation'`,
  );
  const customerFacingPending = parseInt(pendingRes.rows[0]?.count ?? '0', 10);
  if (customerFacingPending > 0) {
    logger.warn(
      { metric: 'escalation_retention.customer_facing_pending', customerFacingPending },
      'Customer-facing escalations are pending. A blocker should park its run instead, so these are not swept and need looking at',
    );
  }

  const result: RetentionResult = {
    swept: sweptRes.rowCount ?? 0,
    deleted: deletedRes.rowCount ?? 0,
    customerFacingPending,
  };
  logger.info({ ...result, windowDays: RETENTION_DAYS }, 'escalation retention cycle complete');
  return result;
}
