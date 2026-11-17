/**
 * Retention for the two application DLQ tables.
 *
 * These assert the SQL's shape rather than its results, because the property
 * that matters most here is negative: what the sweep is NOT allowed to touch.
 * A results test that seeds only finished rows passes just as happily against
 * a DELETE with no status predicate at all, and the failure that would catch
 * is the one that silently discards unresolved work.
 *
 * The sibling integration test runs the same statements against a real
 * Postgres. Neither is sufficient alone: shape cannot prove the SQL parses,
 * execution cannot prove the sweep would have refused a pending row it never
 * saw.
 */
import {
  runDlqRetention, DLQ_RETENTION_DAYS, DLQ_SWEEP_BATCH, DLQ_SWEEP_MAX_BATCHES,
} from '../dlq-retention';

const queryMock = jest.fn();
jest.mock('../database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => queryMock(...args) }),
}));

/** Both levels land here: warn carries the cap notice, error the backlog. */
const warnings: Array<Record<string, unknown>> = [];
jest.mock('../logging', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn((fields: Record<string, unknown>) => { warnings.push(fields); }),
    error: jest.fn((fields: Record<string, unknown>) => { warnings.push(fields); }),
  },
}));

/** Rows each successive DELETE returns. A bare number means one batch of that
 *  size and then exhaustion; an array drives the loop batch by batch. */
type BatchPlan = number | number[];

function nextRowCount(plan: BatchPlan | undefined, call: number): number {
  if (plan === undefined) return 0;
  if (typeof plan === 'number') return call === 0 ? plan : 0;
  return plan[call] ?? 0;
}

/** Dispatch by statement, not by call order, so adding a query later cannot
 *  silently re-point one of these at the wrong assertion. */
function primePool(counts: {
  dlqDeleted?: BatchPlan;
  failedDeleted?: BatchPlan;
  dlqPending?: { count: string; oldest_hours: string | null };
  failedPending?: { count: string; oldest_hours: string | null };
} = {}) {
  queryMock.mockReset();
  warnings.length = 0;
  let dlqCall = 0;
  let failedCall = 0;
  queryMock.mockImplementation(async (sql: string) => {
    if (/DELETE FROM dlq_messages/i.test(sql)) {
      return { rowCount: nextRowCount(counts.dlqDeleted, dlqCall++), rows: [] };
    }
    if (/DELETE FROM failed_events/i.test(sql)) {
      return { rowCount: nextRowCount(counts.failedDeleted, failedCall++), rows: [] };
    }
    if (/FROM dlq_messages/i.test(sql)) {
      return { rowCount: 1, rows: [counts.dlqPending ?? { count: '0', oldest_hours: null }] };
    }
    if (/FROM failed_events/i.test(sql)) {
      return { rowCount: 1, rows: [counts.failedPending ?? { count: '0', oldest_hours: null }] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  });
}

function sqlMatching(fragment: RegExp): string {
  const call = queryMock.mock.calls.find((c) => fragment.test(c[0] as string));
  if (!call) throw new Error(`no query matched ${fragment}`);
  return call[0] as string;
}

function sqlCallCount(fragment: RegExp): number {
  return queryMock.mock.calls.filter((c) => fragment.test(c[0] as string)).length;
}

describe('runDlqRetention', () => {
  describe('what it deletes', () => {
    it('deletes dlq_messages only in a terminal status', async () => {
      primePool();
      await runDlqRetention();
      const sql = sqlMatching(/DELETE FROM dlq_messages/i);
      expect(sql).toMatch(/status IN \('resolved', 'discarded'\)/);
      // The whole point. A pending row is the queue's reason to exist.
      expect(sql).not.toMatch(/'pending'/);
      expect(sql).not.toMatch(/'processing'/);
    });

    it('will not delete a terminal dlq_messages row with no resolved_at', async () => {
      // Without this, `resolved_at < NOW() - interval` on a NULL evaluates to
      // unknown and the row is skipped by accident rather than by intent. The
      // explicit NOT NULL says which one it is.
      primePool();
      await runDlqRetention();
      expect(sqlMatching(/DELETE FROM dlq_messages/i)).toMatch(/resolved_at IS NOT NULL/);
    });

    it('drops dependent escalations in the same statement as their message', async () => {
      // dlq_escalations REFERENCES dlq_messages(id) with no ON DELETE clause,
      // so a parent-only delete is a foreign-key violation waiting for the
      // first escalation to exist. One statement, not two, because the sweep
      // runs outside a transaction and a gap between them would leave orphaned
      // parents behind.
      primePool();
      await runDlqRetention();
      const sql = sqlMatching(/DELETE FROM dlq_messages/i);
      expect(sql).toMatch(/DELETE FROM dlq_escalations\s+WHERE dlq_message_id IN \(SELECT id FROM doomed\)/);
      // Both deletes read the same CTE, so they cannot select different rows.
      expect(sql.match(/SELECT id FROM doomed/g)).toHaveLength(2);
    });

    it('deletes failed_events only where the republish succeeded', async () => {
      primePool();
      await runDlqRetention();
      const sql = sqlMatching(/DELETE FROM failed_events/i);
      expect(sql).toMatch(/WHERE republished/);
      expect(sql).not.toMatch(/NOT republished/);
    });

    it('measures both windows against the same retention constant', async () => {
      primePool();
      await runDlqRetention();
      for (const stmt of [/DELETE FROM dlq_messages/i, /DELETE FROM failed_events/i]) {
        const call = queryMock.mock.calls.find((c) => stmt.test(c[0] as string))!;
        expect(call[1]).toEqual([DLQ_RETENTION_DAYS, DLQ_SWEEP_BATCH]);
      }
    });

    it('keeps deleting while batches come back full', async () => {
      // One batch per run does not survive a real backlog: dev held 53,315
      // republished failed_events, which at 500 a night is 107 nights.
      primePool({ failedDeleted: [DLQ_SWEEP_BATCH, DLQ_SWEEP_BATCH, 17] });
      const result = await runDlqRetention();
      expect(result.failedEventsDeleted).toBe(DLQ_SWEEP_BATCH * 2 + 17);
      expect(sqlCallCount(/DELETE FROM failed_events/i)).toBe(3);
      expect(result.cappedOut).toBe(false);
    });

    it('stops at the first short batch rather than spinning', async () => {
      // A short batch means the eligible set is exhausted — or that SKIP LOCKED
      // stepped over rows someone else holds. Retrying those immediately would
      // spin against the lock holder for the rest of the cap.
      primePool({ dlqDeleted: [3] });
      const result = await runDlqRetention();
      expect(result.dlqMessagesDeleted).toBe(3);
      expect(sqlCallCount(/DELETE FROM dlq_messages/i)).toBe(1);
    });

    it('stops at the cap and says so instead of looking finished', async () => {
      // A sweep that quietly truncates reads exactly like a sweep that caught
      // up. The flag and the log line are the difference.
      primePool({ dlqDeleted: Array(DLQ_SWEEP_MAX_BATCHES + 5).fill(DLQ_SWEEP_BATCH) });
      const result = await runDlqRetention();
      expect(sqlCallCount(/DELETE FROM dlq_messages/i)).toBe(DLQ_SWEEP_MAX_BATCHES);
      expect(result.dlqMessagesDeleted).toBe(DLQ_SWEEP_BATCH * DLQ_SWEEP_MAX_BATCHES);
      expect(result.cappedOut).toBe(true);
      expect(warnings).toContainEqual(expect.objectContaining({
        metric: 'dlq_retention.capped_out', surface: 'dlq_messages',
      }));
    });

    it('takes the oldest rows first in both sweeps', async () => {
      // An unordered DELETE with a LIMIT lets Postgres hand back whichever rows
      // are cheapest to reach, which in practice is the same recent ones every
      // pass while the oldest — the entire reason the sweep exists — are never
      // touched. This repo shipped that bug once already in the
      // clarification-expiry path.
      primePool();
      await runDlqRetention();
      expect(sqlMatching(/DELETE FROM dlq_messages/i)).toMatch(/ORDER BY resolved_at\s+LIMIT/);
      expect(sqlMatching(/DELETE FROM failed_events/i)).toMatch(/ORDER BY drained_at\s+LIMIT/);
    });

    it('skips locked rows rather than blocking on them', async () => {
      primePool();
      await runDlqRetention();
      expect(sqlMatching(/DELETE FROM dlq_messages/i)).toMatch(/FOR UPDATE SKIP LOCKED/);
      expect(sqlMatching(/DELETE FROM failed_events/i)).toMatch(/FOR UPDATE SKIP LOCKED/);
    });
  });

  describe('what it reports instead of deleting', () => {
    it('counts unresolved rows on both surfaces without writing to them', async () => {
      primePool({
        dlqPending: { count: '644', oldest_hours: '2952' },
        failedPending: { count: '3', oldest_hours: '12.5' },
      });
      const result = await runDlqRetention();
      expect(result.dlqMessages).toEqual({ pending: 644, oldestAgeHours: 2952 });
      expect(result.failedEvents).toEqual({ pending: 3, oldestAgeHours: 12.5 });

      // Every statement touching the unresolved sets is a SELECT.
      const mutations = queryMock.mock.calls
        .map((c) => c[0] as string)
        .filter((s) => /UPDATE|DELETE/i.test(s))
        .filter((s) => /'pending'|NOT republished/i.test(s));
      expect(mutations).toEqual([]);
    });

    it('reads the age from Postgres, not from the app clock', async () => {
      // The sweep and the database can disagree about now(); only one of them
      // is authoritative for a timestamp column.
      primePool();
      await runDlqRetention();
      expect(sqlMatching(/SELECT count\(\*\)[\s\S]*FROM dlq_messages/i))
        .toMatch(/EXTRACT\(EPOCH FROM \(NOW\(\) - MIN\(failed_at\)\)\)/);
      expect(sqlMatching(/SELECT count\(\*\)[\s\S]*FROM failed_events/i))
        .toMatch(/EXTRACT\(EPOCH FROM \(NOW\(\) - MIN\(drained_at\)\)\)/);
    });

    it('counts processing alongside pending as unresolved', async () => {
      // 'processing' is a claim someone started and did not finish. Leaving it
      // out of the backlog would let a crashed handler hide work forever.
      primePool();
      await runDlqRetention();
      expect(sqlMatching(/SELECT count\(\*\)[\s\S]*FROM dlq_messages/i))
        .toMatch(/status IN \('pending', 'processing'\)/);
    });

    it('reports no age when there is no backlog', async () => {
      primePool();
      const result = await runDlqRetention();
      expect(result.dlqMessages).toEqual({ pending: 0, oldestAgeHours: null });
      expect(result.failedEvents).toEqual({ pending: 0, oldestAgeHours: null });
    });
  });

  describe('the signal', () => {
    it('emits one alertable line per non-empty surface', async () => {
      primePool({
        dlqPending: { count: '644', oldest_hours: '2952' },
        failedPending: { count: '3', oldest_hours: '12.5' },
      });
      await runDlqRetention();
      expect(warnings).toEqual([
        expect.objectContaining({
          event: 'dlq_backlog_pending', surface: 'dlq_messages',
          pendingCount: 644, oldestAgeHours: 2952,
        }),
        expect.objectContaining({
          event: 'dlq_backlog_pending', surface: 'failed_events',
          pendingCount: 3, oldestAgeHours: 12.5,
        }),
      ]);
    });

    it('stays silent when both surfaces are clean', async () => {
      // The alert threshold is zero, so an empty queue must emit nothing at
      // all. A line saying "0 pending" would fire it every single day and the
      // alert would be muted within a week.
      primePool();
      await runDlqRetention();
      expect(warnings).toEqual([]);
    });

    it('names one surface when only one has a backlog', async () => {
      primePool({ failedPending: { count: '2', oldest_hours: '1' } });
      await runDlqRetention();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ surface: 'failed_events', pendingCount: 2 });
    });
  });

  it('reports what it deleted', async () => {
    primePool({ dlqDeleted: 500, failedDeleted: 500 });
    const result = await runDlqRetention();
    expect(result.dlqMessagesDeleted).toBe(500);
    expect(result.failedEventsDeleted).toBe(500);
  });
});
