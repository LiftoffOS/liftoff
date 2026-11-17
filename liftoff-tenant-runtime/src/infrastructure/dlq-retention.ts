// Retention and backlog reporting for the two application DLQ tables.
//
// A dead-letter queue is a work queue, not a log. Its one useful property is
// that a non-empty queue means somebody owes it an action; the moment a
// standing backlog is normal, the queue stops being read at all. A drainer with
// no replay bound makes it worse, replaying the same events over and over
// (scripts/pubsub-dlq-drainer.ts caps it).
//
// The policy, and the reason for each half:
//
//   Delete what is finished. A resolved or discarded dlq_messages row, and a
//   failed_events row that was successfully republished, are both records of a
//   path that already completed. Thirty days is long enough to answer "what
//   happened last month" and short enough that the table stays readable. Same
//   window as the escalation sweep (escalation-retention.ts) on purpose: two
//   retention numbers that mean the same thing should not drift apart.
//
//   Never delete what is unresolved. A pending dlq_messages row and a
//   failed_events row with republish_error set are outstanding work. Sweeping
//   those on a timer is how a queue comes to look healthy while the work in it
//   is quietly lost, so they are counted and reported instead. If the count is
//   non-zero, that is the signal, and the fix is to resolve or discard the row
//   deliberately, not to widen the sweep.
//
// The reported counts are what the dlq_backlog_pending log metric and its
// alert are built on (infrastructure-gcp: log-metrics.tf, alerts.tf). Age
// matters more than count: one row stuck for four months is worse than fifty
// from this morning, and only the age reading distinguishes them.

import { getPool } from './database';
import { logger } from './logging';

/** Both delete windows. One number, so they cannot drift apart. */
export const DLQ_RETENTION_DAYS = 30;

/** Rows per statement. Keeps any single transaction short. Paired with ORDER BY
 *  in each statement, which is what makes the batching fair: an unordered
 *  DELETE with a LIMIT lets Postgres return whichever rows are cheapest to
 *  reach, which in practice means the same recent ones every pass while the
 *  oldest — the entire point of the sweep — are never touched. */
export const DLQ_SWEEP_BATCH = 500;

/** Batches per table per run, so one nightly pass clears up to 20,000 rows.
 *
 *  One batch per night does not survive contact with a real backlog: 50,000
 *  republished failed_events from a replay loop would take 100 nights at 500 a
 *  night. A retention sweep that takes three months to catch up is not retention, it is
 *  a slow leak with a cron attached.
 *
 *  Looping to exhaustion instead is the sibling pattern in this same cron
 *  router (connector-entity-state-pruner, 100 batches of 1000). The cap is what
 *  keeps it bounded: a runaway or a table growing faster than the sweep drains
 *  it stops at a known ceiling rather than holding the connection all night. */
export const DLQ_SWEEP_MAX_BATCHES = 40;

export interface DlqBacklog {
  /** Rows nobody has resolved or discarded. Reported, never deleted. */
  pending: number;
  /** Age of the oldest such row, in hours. Null when there are none. */
  oldestAgeHours: number | null;
}

export interface DlqRetentionResult {
  /** Terminal dlq_messages rows deleted this pass. */
  dlqMessagesDeleted: number;
  /** Republished failed_events rows deleted this pass. */
  failedEventsDeleted: number;
  /** True when a table stopped at DLQ_SWEEP_MAX_BATCHES with rows still to go.
   *  Logged rather than silently truncated, because a sweep that quietly stops
   *  short reads exactly like a sweep that finished. */
  cappedOut: boolean;
  /** dlq_messages the app gave up on and nobody has triaged. */
  dlqMessages: DlqBacklog;
  /** failed_events the drainer could not or would not republish. */
  failedEvents: DlqBacklog;
}

/** Hours between `since` and now, as reported by Postgres so the reading does
 *  not depend on the app clock agreeing with the database clock. */
function hoursOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** Run one DELETE repeatedly until it stops finding rows or hits the cap.
 *
 *  Returns the total and whether it stopped early. Each iteration is its own
 *  statement, so the transaction footprint stays at DLQ_SWEEP_BATCH rows no
 *  matter how large the backlog is. */
async function sweepToExhaustion(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> },
  sql: string,
  label: string,
): Promise<{ deleted: number; cappedOut: boolean }> {
  let deleted = 0;
  for (let batch = 0; batch < DLQ_SWEEP_MAX_BATCHES; batch++) {
    const res = await pool.query(sql, [DLQ_RETENTION_DAYS, DLQ_SWEEP_BATCH]);
    const n = res.rowCount ?? 0;
    deleted += n;
    // A short batch means the eligible set is exhausted. Not `n === 0`: with
    // FOR UPDATE SKIP LOCKED a partial batch can also mean rows were locked,
    // and retrying those immediately would spin against whoever holds them.
    if (n < DLQ_SWEEP_BATCH) return { deleted, cappedOut: false };
  }
  logger.warn(
    { metric: 'dlq_retention.capped_out', surface: label, deleted, maxBatches: DLQ_SWEEP_MAX_BATCHES },
    'DLQ retention hit its per-run batch cap with rows still eligible; the remainder drains on the next run',
  );
  return { deleted, cappedOut: true };
}

export async function runDlqRetention(): Promise<DlqRetentionResult> {
  const pool = getPool();

  // 1. Delete finished dlq_messages, and the escalations hanging off them.
  //
  // status IN ('resolved','discarded') is the terminal set; 'pending' and
  // 'processing' are excluded by the predicate, not by convention, so a bug
  // elsewhere cannot widen this into deleting live work. resolved_at IS NOT
  // NULL guards the same thing from the other side: a terminal row with no
  // resolved_at has no age to measure and is left alone rather than deleted on
  // a NULL comparison that would silently evaluate to unknown.
  //
  // The dlq_escalations arm is not optional. That table carries
  // `dlq_message_id ... REFERENCES dlq_messages(id)` with no ON DELETE clause
  // (migration 002), so deleting a parent that any escalation points at raises
  // a foreign-key violation and takes the whole nightly sweep down with it.
  // Even with no such rows yet, the constraint is live and the code path
  // exists, so the sweep must not be one INSERT away from failing every night.
  //
  // One statement rather than two, because the sweep runs outside a
  // transaction: the CTEs share a snapshot and the FK is NO ACTION, which
  // Postgres checks at end of statement, so both deletes land or neither does.
  // Splitting them would open a window where the child rows are gone and the
  // parents are not. An escalation whose message is resolved or discarded and
  // 30 days old is stale by construction, which is what makes this safe.
  const dlqDeleted = await sweepToExhaustion(
    pool,
    `WITH doomed AS (
        SELECT id FROM dlq_messages
         WHERE status IN ('resolved', 'discarded')
           AND resolved_at IS NOT NULL
           AND resolved_at < NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY resolved_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      ), dropped_escalations AS (
        DELETE FROM dlq_escalations
         WHERE dlq_message_id IN (SELECT id FROM doomed)
      )
      DELETE FROM dlq_messages
       WHERE id IN (SELECT id FROM doomed)
      RETURNING id`,
    'dlq_messages',
  );

  // 2. Delete republished failed_events.
  //
  // republished = TRUE means the drainer put the event back on the live topic:
  // the row is a forensic trail of a completed remediation, not a to-do. Rows
  // with republished = FALSE are held regardless of age.
  const failedEventsDeleted = await sweepToExhaustion(
    pool,
    `DELETE FROM failed_events
      WHERE id IN (
        SELECT id FROM failed_events
         WHERE republished
           AND drained_at < NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY drained_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id`,
    'failed_events',
  );

  // 3. Report the outstanding work. Read-only, deliberately.
  const dlqPendingRes = await pool.query<{ count: string; oldest_hours: string | null }>(
    `SELECT count(*)::text AS count,
            EXTRACT(EPOCH FROM (NOW() - MIN(failed_at))) / 3600 AS oldest_hours
       FROM dlq_messages
      WHERE status IN ('pending', 'processing')`,
  );
  const failedEventsPendingRes = await pool.query<{ count: string; oldest_hours: string | null }>(
    `SELECT count(*)::text AS count,
            EXTRACT(EPOCH FROM (NOW() - MIN(drained_at))) / 3600 AS oldest_hours
       FROM failed_events
      WHERE NOT republished`,
  );

  const dlqMessages: DlqBacklog = {
    pending: parseInt(dlqPendingRes.rows[0]?.count ?? '0', 10),
    oldestAgeHours: hoursOrNull(dlqPendingRes.rows[0]?.oldest_hours),
  };
  const failedEvents: DlqBacklog = {
    pending: parseInt(failedEventsPendingRes.rows[0]?.count ?? '0', 10),
    oldestAgeHours: hoursOrNull(failedEventsPendingRes.rows[0]?.oldest_hours),
  };

  // One log line per non-empty surface, carrying both readings.
  //
  // `event` is what the log-based metric filters on, and emitting nothing when
  // a surface is clean is what lets its alert sit at a threshold of zero: a
  // daily "0 pending" line would fire it every single day and the alert would
  // be muted inside a week. The depth and the age travel in the entry rather
  // than in the metric value, because Cloud Monitoring only extracts values
  // into DISTRIBUTION metrics and a histogram of backlog sizes is not what
  // anyone reads at 3am — the entry is.
  for (const [surface, backlog] of [
    ['dlq_messages', dlqMessages],
    ['failed_events', failedEvents],
  ] as const) {
    if (backlog.pending > 0) {
      logger.error(
        {
          event: 'dlq_backlog_pending',
          surface,
          pendingCount: backlog.pending,
          oldestAgeHours: backlog.oldestAgeHours,
        },
        `${surface} has dead-lettered work nobody has resolved. These are never swept: each one needs a replay, a discard with a reason, or a fix`,
      );
    }
  }

  const result: DlqRetentionResult = {
    dlqMessagesDeleted: dlqDeleted.deleted,
    failedEventsDeleted: failedEventsDeleted.deleted,
    cappedOut: dlqDeleted.cappedOut || failedEventsDeleted.cappedOut,
    dlqMessages,
    failedEvents,
  };
  logger.info({ ...result, windowDays: DLQ_RETENTION_DAYS }, 'DLQ retention cycle complete');
  return result;
}
