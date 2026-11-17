// The live CAIO turn on a thread, and whether somebody has asked it to stop
// (migration 016).
//
// Durable rather than in-process: the turn is an async generator inside one
// request, and with no session affinity the stop request lands on a different
// instance almost every time. Writing it down is the only way the two meet.
//
// Every function here is best-effort from the turn's point of view. A stop
// signal that cannot be read is a turn that keeps running, which is the same
// outcome as not pressing stop — so nothing in this file may throw into the
// turn loop.

import { withTenantContext } from '../infrastructure/rls.js';
import { log } from '../infrastructure/logging.js';

// How long a claim stays stoppable. An instance killed mid-turn leaves its row
// behind (there is no one to release it), and a stop against that row would
// report "delivered" to somebody watching a thread where nothing is running.
// Comfortably longer than the 10-iteration turn cap, short enough that a
// stranded row stops lying quickly.
const CLAIM_STOPPABLE_MINUTES = 15;

/**
 * Record that this turn is live on this thread.
 *
 * Upserts on thread_id and clears any previous stop request, so a row stranded
 * by a crashed instance never blocks the next turn or leaks a stale stop into
 * it.
 */
export async function claimTurn(
  tenantId: string,
  threadId: string,
  turnId: string,
  accountId: string,
): Promise<void> {
  try {
    await withTenantContext(tenantId, (client) =>
      client.query(
        `INSERT INTO team_plan_active_turns
           (thread_id, tenant_id, turn_id, account_id, started_at, stop_requested_at, stop_requested_by)
         VALUES ($1, $2, $3, $4, NOW(), NULL, NULL)
         ON CONFLICT (thread_id) DO UPDATE
           SET turn_id           = EXCLUDED.turn_id,
               account_id        = EXCLUDED.account_id,
               started_at        = NOW(),
               stop_requested_at = NULL,
               stop_requested_by = NULL`,
        [threadId, tenantId, turnId, accountId],
      ),
    );
  } catch (err) {
    // A turn that could not register is a turn that cannot be stopped. Worth a
    // log; not worth failing the person's message over.
    log.warn(
      { threadId, turnId, error: (err as Error).message },
      'CAIO: could not claim the active turn - stop will report noop for this turn',
    );
  }
}

/**
 * Release the claim, if it is still ours. Scoped to turn_id so a slow turn
 * finishing after its successor started cannot delete the successor's claim.
 */
export async function releaseTurn(
  tenantId: string,
  threadId: string,
  turnId: string,
): Promise<void> {
  try {
    await withTenantContext(tenantId, (client) =>
      client.query(
        `DELETE FROM team_plan_active_turns WHERE thread_id = $1 AND turn_id = $2`,
        [threadId, turnId],
      ),
    );
  } catch (err) {
    // The row ages out of stoppability on its own; see CLAIM_STOPPABLE_MINUTES.
    log.warn(
      { threadId, turnId, error: (err as Error).message },
      'CAIO: could not release the active turn',
    );
  }
}

/**
 * Ask the turn running on this thread to stop.
 *
 * Returns true when a live claim was marked, false when there was nothing to
 * stop — which the route reports as 'abort' vs 'noop', the same contract agent
 * chat's stop returns.
 */
export async function requestStop(
  tenantId: string,
  threadId: string,
  requestedBy: string,
): Promise<boolean> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE team_plan_active_turns
       SET stop_requested_at = NOW(), stop_requested_by = $2
       WHERE thread_id = $1
         AND stop_requested_at IS NULL
         AND started_at > NOW() - INTERVAL '${CLAIM_STOPPABLE_MINUTES} minutes'
       RETURNING turn_id`,
      [threadId, requestedBy],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

/** Has this turn been asked to stop? Read by the turn loop between iterations. */
export async function isStopRequested(
  tenantId: string,
  threadId: string,
  turnId: string,
): Promise<boolean> {
  try {
    return await withTenantContext(tenantId, async (client) => {
      const result = await client.query(
        `SELECT stop_requested_at
         FROM team_plan_active_turns
         WHERE thread_id = $1 AND turn_id = $2`,
        [threadId, turnId],
      );
      return result.rows[0]?.stop_requested_at != null;
    });
  } catch (err) {
    // Never abort a turn because the check failed — a failed read must read as
    // "nobody asked", not as a stop.
    log.warn(
      { threadId, turnId, error: (err as Error).message },
      'CAIO: stop check failed - treating as not stopped',
    );
    return false;
  }
}
