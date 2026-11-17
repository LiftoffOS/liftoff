/**
 * DLQ retention, executed rather than inspected.
 *
 * The sibling unit test asserts the SQL's shape: what it is allowed to touch,
 * that it orders oldest-first, that it holds what it cannot resolve. Shape
 * cannot tell you the statement parses, that `DELETE ... WHERE id IN (SELECT
 * ... FOR UPDATE SKIP LOCKED)` is legal, that failure_class survives its CHECK
 * constraint, or that the columns exist at all. This runs it against a real
 * Postgres and reads the rows back.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated database.
 */
import { Pool } from 'pg';

const realPool = process.env.TEST_DATABASE_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_URL })
  : null;

jest.mock('../database', () => ({
  getPool: () => realPool,
}));

import { runDlqRetention, DLQ_RETENTION_DAYS } from '../dlq-retention';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const TENANT = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';

async function seedDlqMessage(opts: {
  id: string;
  status: 'pending' | 'processing' | 'resolved' | 'discarded';
  ageDays: number;
  failureClass?: 'transient' | 'permanent';
}) {
  const terminal = opts.status === 'resolved' || opts.status === 'discarded';
  await realPool!.query(
    `INSERT INTO dlq_messages
       (id, original_topic, original_message_id, tenant_id, payload, error,
        delivery_attempt, max_delivery_attempts, first_received_at, failed_at,
        status, resolved_at, failure_class)
     VALUES ($1, 'fixture.topic', $1, $2, '{}'::jsonb, 'fixture', 1, 10,
             NOW() - ($3::int * INTERVAL '1 day'),
             NOW() - ($3::int * INTERVAL '1 day'),
             $4,
             CASE WHEN $5::bool THEN NOW() - ($3::int * INTERVAL '1 day') ELSE NULL END,
             $6)`,
    [opts.id, TENANT, opts.ageDays, opts.status, terminal, opts.failureClass ?? null],
  );
}

async function seedFailedEvent(opts: {
  dlqMessageId: string;
  republished: boolean;
  ageDays: number;
}) {
  await realPool!.query(
    `INSERT INTO failed_events
       (tenant_id, original_event_id, original_topic, original_subscription,
        dlq_message_id, payload, payload_raw_base64, drained_at, republished,
        republish_error)
     VALUES ($1, NULL, 'fixture.topic', 'fixture-sub', $2, '{}'::jsonb, 'e30=',
             NOW() - ($3::int * INTERVAL '1 day'), $4,
             CASE WHEN $4::bool THEN NULL ELSE 'fixture hold' END)`,
    [TENANT, opts.dlqMessageId, opts.ageDays, opts.republished],
  );
}

async function dlqIds(): Promise<string[]> {
  const res = await realPool!.query<{ id: string }>(
    `SELECT id FROM dlq_messages WHERE tenant_id = $1 ORDER BY id`, [TENANT],
  );
  return res.rows.map((r) => r.id);
}

async function failedEventIds(): Promise<string[]> {
  const res = await realPool!.query<{ dlq_message_id: string }>(
    `SELECT dlq_message_id FROM failed_events WHERE tenant_id = $1 ORDER BY dlq_message_id`,
    [TENANT],
  );
  return res.rows.map((r) => r.dlq_message_id);
}

describeFn('runDlqRetention against Postgres', () => {
  beforeEach(async () => {
    await realPool!.query('DELETE FROM failed_events WHERE tenant_id = $1', [TENANT]);
    await realPool!.query('DELETE FROM dlq_escalations WHERE tenant_id = $1', [TENANT]);
    await realPool!.query('DELETE FROM dlq_messages WHERE tenant_id = $1', [TENANT]);
  });

  afterAll(async () => {
    await realPool?.query("DELETE FROM failed_events WHERE tenant_id = $1", [TENANT]);
    await realPool?.query("DELETE FROM dlq_escalations WHERE tenant_id = $1", [TENANT]);
    await realPool?.query('DELETE FROM dlq_messages WHERE tenant_id = $1', [TENANT]);
    await realPool?.end();
  });

  it('deletes terminal dlq_messages past the window and keeps everything else', async () => {
    const old = DLQ_RETENTION_DAYS + 5;
    const recent = DLQ_RETENTION_DAYS - 5;
    await seedDlqMessage({ id: 'keep-pending-old', status: 'pending', ageDays: old });
    await seedDlqMessage({ id: 'keep-processing-old', status: 'processing', ageDays: old });
    await seedDlqMessage({ id: 'keep-resolved-recent', status: 'resolved', ageDays: recent });
    await seedDlqMessage({ id: 'zap-resolved-old', status: 'resolved', ageDays: old });
    await seedDlqMessage({ id: 'zap-discarded-old', status: 'discarded', ageDays: old });

    const result = await runDlqRetention();

    expect(result.dlqMessagesDeleted).toBe(2);
    // The pending rows outlive the window. That is the whole policy: age is
    // not a reason to delete work nobody has dealt with.
    expect(await dlqIds()).toEqual([
      'keep-pending-old', 'keep-processing-old', 'keep-resolved-recent',
    ]);
  });

  it('deletes republished failed_events past the window and holds the rest', async () => {
    const old = DLQ_RETENTION_DAYS + 5;
    await seedFailedEvent({ dlqMessageId: 'fe-held-old', republished: false, ageDays: old });
    await seedFailedEvent({ dlqMessageId: 'fe-sent-old', republished: true, ageDays: old });
    await seedFailedEvent({
      dlqMessageId: 'fe-sent-recent', republished: true, ageDays: DLQ_RETENTION_DAYS - 5,
    });

    const result = await runDlqRetention();

    expect(result.failedEventsDeleted).toBe(1);
    expect(await failedEventIds()).toEqual(['fe-held-old', 'fe-sent-recent']);
  });

  it('drains a backlog larger than one batch in a single run', async () => {
    // The shape that made the loop necessary. One batch per run meant dev's
    // 53,315 republished rows would take 107 nights, so a run has to keep
    // going while batches come back full. Seeded past DLQ_SWEEP_BATCH so a
    // single-batch implementation leaves a remainder and fails here.
    const { DLQ_SWEEP_BATCH } = await import('../dlq-retention');
    const surplus = DLQ_SWEEP_BATCH + 137;
    await realPool!.query(
      `INSERT INTO failed_events
         (tenant_id, original_event_id, original_topic, original_subscription,
          dlq_message_id, payload, payload_raw_base64, drained_at, republished)
       SELECT $1, NULL, 'fixture.topic', 'fixture-sub', 'fe-bulk-' || g,
              '{}'::jsonb, 'e30=', NOW() - ($2::int * INTERVAL '1 day'), TRUE
         FROM generate_series(1, $3) g`,
      [TENANT, DLQ_RETENTION_DAYS + 5, surplus],
    );
    // One row inside the window, to prove the loop still respects the cutoff
    // rather than running until the table is empty.
    await seedFailedEvent({ dlqMessageId: 'fe-recent', republished: true, ageDays: 1 });

    const result = await runDlqRetention();

    expect(result.failedEventsDeleted).toBe(surplus);
    expect(result.cappedOut).toBe(false);
    expect(await failedEventIds()).toEqual(['fe-recent']);
  });

  it('reports the backlog and its age from the oldest unresolved row', async () => {
    await seedDlqMessage({ id: 'p1', status: 'pending', ageDays: 10 });
    await seedDlqMessage({ id: 'p2', status: 'pending', ageDays: 2 });
    await seedDlqMessage({ id: 'r1', status: 'resolved', ageDays: 90 });
    await seedFailedEvent({ dlqMessageId: 'fe-held', republished: false, ageDays: 4 });

    const result = await runDlqRetention();

    expect(result.dlqMessages.pending).toBe(2);
    // 10 days, from the oldest pending row — not from the 90-day resolved one,
    // which is finished and therefore not backlog.
    expect(result.dlqMessages.oldestAgeHours).toBeGreaterThan(10 * 24 - 1);
    expect(result.dlqMessages.oldestAgeHours).toBeLessThan(10 * 24 + 1);
    expect(result.failedEvents.pending).toBe(1);
    expect(result.failedEvents.oldestAgeHours).toBeGreaterThan(4 * 24 - 1);
  });

  it('reports a clean queue as zero with no age', async () => {
    const result = await runDlqRetention();
    expect(result.dlqMessages).toEqual({ pending: 0, oldestAgeHours: null });
    expect(result.failedEvents).toEqual({ pending: 0, oldestAgeHours: null });
  });

  it('takes dependent escalations with the message instead of tripping its foreign key', async () => {
    // dlq_escalations.dlq_message_id REFERENCES dlq_messages(id) with no
    // ON DELETE clause. A sweep that deleted only the parent would raise a
    // foreign-key violation and fail every night from the first escalation
    // onward. An environment with no escalations yet cannot show that, which
    // is exactly why this needs a test rather than an observation.
    const old = DLQ_RETENTION_DAYS + 5;
    await seedDlqMessage({ id: 'zap-with-escalation', status: 'resolved', ageDays: old });
    await seedDlqMessage({ id: 'keep-pending', status: 'pending', ageDays: old });
    await realPool!.query(
      `INSERT INTO dlq_escalations (dlq_message_id, tenant_id, original_topic, error, reason)
       VALUES ($1, $2, 'fixture.topic', 'fixture', 'fixture')`,
      ['zap-with-escalation', TENANT],
    );

    const result = await runDlqRetention();

    expect(result.dlqMessagesDeleted).toBe(1);
    expect(await dlqIds()).toEqual(['keep-pending']);
    const left = await realPool!.query(
      'SELECT 1 FROM dlq_escalations WHERE tenant_id = $1', [TENANT],
    );
    expect(left.rowCount).toBe(0);
  });

  it('leaves an escalation alone when its message is not yet sweepable', async () => {
    // The child follows the parent. It is never a deletion target on its own.
    await seedDlqMessage({ id: 'keep-pending-esc', status: 'pending', ageDays: 400 });
    await realPool!.query(
      `INSERT INTO dlq_escalations (dlq_message_id, tenant_id, original_topic, error, reason)
       VALUES ($1, $2, 'fixture.topic', 'fixture', 'fixture')`,
      ['keep-pending-esc', TENANT],
    );

    await runDlqRetention();

    const left = await realPool!.query(
      'SELECT 1 FROM dlq_escalations WHERE tenant_id = $1', [TENANT],
    );
    expect(left.rowCount).toBe(1);
  });

  it('accepts both failure classes and rejects anything else', async () => {
    await seedDlqMessage({ id: 'fc-t', status: 'pending', ageDays: 1, failureClass: 'transient' });
    await seedDlqMessage({ id: 'fc-p', status: 'pending', ageDays: 1, failureClass: 'permanent' });
    await expect(
      seedDlqMessage({
        id: 'fc-bad', status: 'pending', ageDays: 1,
        failureClass: 'obsolete' as 'transient',
      }),
    ).rejects.toThrow();

    const res = await realPool!.query<{ failure_class: string }>(
      `SELECT failure_class FROM dlq_messages WHERE tenant_id = $1 ORDER BY id`, [TENANT],
    );
    expect(res.rows.map((r) => r.failure_class)).toEqual(['permanent', 'transient']);
  });
});
