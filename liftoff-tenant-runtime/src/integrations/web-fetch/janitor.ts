import { getPool } from '../../infrastructure/database';
import { logger } from '../../infrastructure/logging';

// Sweeps expired inflight rows, expired waiters, stale token_buckets, and — as
// a LAST-RESORT backstop only — web_sessions the reaper has given up on. Run
// from a setInterval in src/index.ts at 60s cadence.
//
// When inflight rows are reclaimed, we fire pg_notify so waiters wake even
// when releases stop coming naturally (e.g. all holders crashed).
export async function sweepWebFetchExpired(): Promise<void> {
  const pool = getPool();
  try {
    const inflight = await pool.query(
      `WITH d AS (DELETE FROM web_inflight_requests WHERE expires_at < NOW() RETURNING vendor)
       SELECT pg_notify('web_fetch_release', vendor) FROM d`,
    );
    const waiters = await pool.query(`DELETE FROM web_waiters WHERE expires_at < NOW()`);
    // A session is the REAPER's to close, not this sweep's.
    //
    // Closing one here frees its admission slot and nothing else: no vendor
    // stop, so Browser Use keeps charging the whole upfront window until its
    // own timeout, and no settle, so the cost is recorded nowhere. The reaper
    // does both — but it selects on exactly the predicate this UPDATE used, so
    // running every 60s against the reaper's 5 minutes meant this sweep took
    // the row first almost every time and the cost was lost.
    //
    // So this stays as a backstop and nothing more: an hour past expiry is long
    // after the reaper has had twelve chances, and a row still open then means
    // the reaper is broken or gone. Freeing the slot is the right call at that
    // point; before it, taking the row is what breaks billing.
    //
    // The candidates are selected here and closed one at a time through the
    // repository's closeSession — the one writer of closed_at — so a takeover
    // hold open on any of them ends in the same transaction as its session.
    const candidates = await pool.query<{ id: string }>(
      `SELECT id FROM web_sessions
       WHERE closed_at IS NULL AND expires_at < NOW() - INTERVAL '1 hour'`,
    );
    let sessionsClosed = 0;
    if (candidates.rows.length > 0) {
      const { closeSession } = await import('../../browser-sessions/repository');
      for (const row of candidates.rows) {
        if (await closeSession(row.id, 'failed')) sessionsClosed++;
      }
    }
    if (sessionsClosed > 0) {
      // Loud, because reaching this means the reaper did not run. The slot is
      // recovered; the money is not.
      logger.warn({
        sessions_closed: sessionsClosed,
        event: 'web_session_backstop_closed',
      }, 'closed web_sessions the reaper never reached; their cost is unrecorded');
    }
    const buckets = await pool.query(
      `DELETE FROM token_buckets WHERE last_refilled_at < NOW() - INTERVAL '24 hours'`,
    );
    const total = (inflight.rowCount ?? 0) + (waiters.rowCount ?? 0)
      + sessionsClosed + (buckets.rowCount ?? 0);
    if (total > 0) {
      logger.info({
        inflight_cleared: inflight.rowCount,
        waiters_cleared:  waiters.rowCount,
        sessions_closed:  sessionsClosed,
        buckets_cleared:  buckets.rowCount,
      }, 'web_fetch_janitor swept');
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'web_fetch_janitor sweep failed');
  }
}

export function startWebFetchJanitor(): NodeJS.Timeout {
  return setInterval(sweepWebFetchExpired, 60_000).unref();
}
