// The rows behind a continuation: work a bound closed with more to do, kept
// (migration 517) until a worker runs it on the same thread as a further turn.
//
// Every statement here is bound to one row and one status, so the worker's
// handoff (chat-run-worker.ts) reads as a sequence of atomic claims:
//
//   queued  --claim-->  claimed  --lock, recheck-->  running  -->  done | failed
//     ^                    |
//     +---- requeue -------+   (the thread lock was busy; the queue retries)
//
// and a person's new message cancels a row in `queued` OR `claimed`: a claim
// is not the lock, and the worker that claimed a row learns of the
// cancellation at its recheck, under the lock, before it runs anything.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

export type ContinuationSurface = 'liftoff' | 'insights' | 'caio';
export type ContinuationStatus = 'queued' | 'claimed' | 'running' | 'done' | 'cancelled' | 'failed';

/** The most continuations one person message may start. At the cap the
 *  loop closes with the reply saying what remains and that the person can
 *  ask it to go on; nothing further is queued. */
export const MAX_CONTINUATIONS_PER_MESSAGE = 5;

/** What a queued row is: carrying on work a bound closed, or a job the
 *  assistant set going and is not waiting for. The difference decides the
 *  objective, whether a person writing cancels it, and whether it chains. */
export type ContinuationKind = 'continuation' | 'background_work';

export interface ContinuationRow {
  id: string;
  tenantId: string;
  surface: ContinuationSurface;
  threadId: string;
  accountId: string;
  originMessageId: string;
  ordinal: number;
  reason: string;
  status: ContinuationStatus;
  workerId: string | null;
  kind: ContinuationKind;
  /** The whole job, for background work. Empty for a continuation. */
  brief: string;
}

interface Row {
  id: string;
  tenant_id: string;
  surface: ContinuationSurface;
  thread_id: string;
  account_id: string;
  origin_message_id: string;
  ordinal: number;
  reason: string;
  status: ContinuationStatus;
  worker_id: string | null;
  kind: ContinuationKind;
  brief: string;
}

const COLUMNS = 'id, tenant_id, surface, thread_id, account_id, origin_message_id, ordinal, reason, status, worker_id, kind, brief';

function toRow(r: Row): ContinuationRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    surface: r.surface,
    threadId: r.thread_id,
    accountId: r.account_id,
    originMessageId: r.origin_message_id,
    ordinal: Number(r.ordinal),
    reason: r.reason,
    status: r.status,
    workerId: r.worker_id,
    kind: r.kind ?? 'continuation',
    brief: r.brief ?? '',
  };
}

export interface EnqueueContinuationInput {
  tenantId: string;
  surface: ContinuationSurface;
  threadId: string;
  /** The person whose message started the work: admission and funding are
   *  theirs, and the reply is announced to them. */
  accountId: string;
  originMessageId: string;
  /** The bound that closed the turn. */
  reason: string;
}

/**
 * Insert the next continuation for a person's message as `queued`, with the
 * ordinal after the last one for that message. Null at the cap: the sixth is
 * never queued. Inserted while the turn still holds the thread lock; the
 * Cloud Task is created by the caller afterwards (dispatch.ts).
 */
export async function enqueueContinuation(input: EnqueueContinuationInput): Promise<ContinuationRow | null> {
  return withTenantScope(input.tenantId, async (client) => {
    const prior = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM chat_continuations WHERE tenant_id = $1 AND origin_message_id = $2`,
      [input.tenantId, input.originMessageId],
    );
    const ordinal = Number(prior.rows[0]?.n ?? 0) + 1;
    if (ordinal > MAX_CONTINUATIONS_PER_MESSAGE) {
      log.info(
        { tenantId: input.tenantId, threadId: input.threadId, originMessageId: input.originMessageId, ordinal },
        'chat continuation not queued: the cap for this message is reached',
      );
      return null;
    }
    const r = await client.query<Row>(
      `INSERT INTO chat_continuations (tenant_id, surface, thread_id, account_id, origin_message_id, ordinal, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
       RETURNING ${COLUMNS}`,
      [input.tenantId, input.surface, input.threadId, input.accountId, input.originMessageId, ordinal, input.reason],
    );
    return toRow(r.rows[0]);
  });
}

/**
 * Queue a job the assistant set going and is not waiting for.
 *
 * The same row, the same queue, the same worker as a continuation. What it
 * carries instead is a brief of its own, and the worker reads `kind` to know
 * that a person writing must not cancel it and that it does not chain.
 *
 * Ordinal 1 always: background work is queued once against the message that
 * set it going, so it never competes with that message's continuations for
 * the per-message cap.
 */
export async function enqueueBackgroundWork(input: {
  tenantId: string;
  surface: ContinuationSurface;
  threadId: string;
  accountId: string;
  originMessageId: string;
  brief: string;
}): Promise<ContinuationRow> {
  return withTenantScope(input.tenantId, async (client) => {
    const r = await client.query<Row>(
      `INSERT INTO chat_continuations
         (tenant_id, surface, thread_id, account_id, origin_message_id, ordinal, reason, status, kind, brief)
       VALUES ($1, $2, $3, $4, $5, 1, 'background_work', 'queued', 'background_work', $6)
       RETURNING ${COLUMNS}`,
      [input.tenantId, input.surface, input.threadId, input.accountId, input.originMessageId, input.brief],
    );
    return toRow(r.rows[0]);
  });
}

/** CLAIM: `queued` → `claimed` under this worker. Null when the row is not
 *  queued any more (cancelled, or taken by another delivery): nothing runs. */
export async function claimContinuation(tenantId: string, id: string, workerId: string): Promise<ContinuationRow | null> {
  const r = await withTenantScope(tenantId, (client) => client.query<Row>(
    `UPDATE chat_continuations
        SET status = 'claimed', claimed_at = NOW(), worker_id = $3
      WHERE tenant_id = $1 AND id = $2 AND status = 'queued'
      RETURNING ${COLUMNS}`,
    [tenantId, id, workerId],
  ));
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

/** The thread lock was busy: `claimed` → back to `queued`, so the queue's
 *  retry finds it, and a new person message meanwhile cancels it. Only the
 *  worker that claimed it may put it back. */
export async function requeueContinuation(tenantId: string, id: string, workerId: string): Promise<boolean> {
  const r = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE chat_continuations
        SET status = 'queued', claimed_at = NULL, worker_id = NULL
      WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND worker_id = $3`,
    [tenantId, id, workerId],
  ));
  return (r.rowCount ?? 0) > 0;
}

/** RECHECK, under the lock: the row as this worker claimed it, or null when
 *  it is no longer claimed by this worker (cancelled, or re-queued and taken
 *  by another delivery). */
export async function recheckClaimedContinuation(tenantId: string, id: string, workerId: string): Promise<ContinuationRow | null> {
  const r = await withTenantScope(tenantId, (client) => client.query<Row>(
    `SELECT ${COLUMNS} FROM chat_continuations
      WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND worker_id = $3`,
    [tenantId, id, workerId],
  ));
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

/** `claimed` → `running`, by the worker that claimed it. */
export async function markContinuationRunning(tenantId: string, id: string, workerId: string): Promise<boolean> {
  const r = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE chat_continuations SET status = 'running'
      WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND worker_id = $3`,
    [tenantId, id, workerId],
  ));
  return (r.rowCount ?? 0) > 0;
}

/** A terminal state for a row this worker holds (claimed or running). The
 *  reason — a busy lock spent, a superseding message, a thrown turn — goes
 *  to the log with the row's id, never into a column nothing reads. */
export async function finishContinuation(
  tenantId: string,
  id: string,
  workerId: string,
  status: 'done' | 'cancelled' | 'failed',
  reason: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE chat_continuations SET status = $4, finished_at = NOW()
      WHERE tenant_id = $1 AND id = $2 AND worker_id = $3 AND status IN ('claimed', 'running')`,
    [tenantId, id, workerId, status],
  ));
  log.info({ tenantId, continuationId: id, workerId, status, reason }, 'chat continuation finished');
}

/**
 * A person's new message on the thread cancels every continuation still
 * waiting for it: `queued`, and `claimed` too, because a claimed worker may
 * not hold the lock yet and discovers the cancellation at its recheck. A
 * `running` one holds the lock; the message reaches it the way a message
 * reaches any running turn (ADR-041), so it is left alone.
 */
export async function cancelThreadContinuations(tenantId: string, threadId: string): Promise<number> {
  try {
    const r = await withTenantScope(tenantId, (client) => client.query(
      // BACKGROUND WORK IS NOT CANCELLED HERE. A continuation is superseded
      // by the next thing the person says, and rightly: they moved on.
      // Background work is the opposite case — they asked for it and then
      // carried on talking, and cancelling it because they spoke again would
      // throw away the very thing they asked for.
      `UPDATE chat_continuations SET status = 'cancelled', finished_at = NOW()
        WHERE tenant_id = $1 AND thread_id = $2 AND status IN ('queued', 'claimed')
          AND kind = 'continuation'`,
      [tenantId, threadId],
    ));
    const n = r.rowCount ?? 0;
    if (n > 0) log.info({ tenantId, threadId, cancelled: n }, 'chat continuations cancelled by a new person message');
    return n;
  } catch (err) {
    // Never fails the person's turn: a continuation left queued is caught at
    // the worker's recheck by the supersession test.
    log.warn({ tenantId, threadId, err: (err as Error).message }, 'could not cancel the thread\'s continuations');
    return 0;
  }
}

/** The thread's live continuation, for the status a person is shown:
 *  `running` outranks `claimed` outranks `queued`; null when none. */
export async function threadContinuationStatus(
  tenantId: string,
  threadId: string,
): Promise<'queued' | 'claimed' | 'running' | null> {
  try {
    const r = await withTenantScope(tenantId, (client) => client.query<{ status: 'queued' | 'claimed' | 'running' }>(
      `SELECT status FROM chat_continuations
        WHERE tenant_id = $1 AND thread_id = $2 AND status IN ('queued', 'claimed', 'running')
        ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END
        LIMIT 1`,
      [tenantId, threadId],
    ));
    return r.rows[0]?.status ?? null;
  } catch (err) {
    log.warn({ tenantId, threadId, err: (err as Error).message }, 'could not read the thread\'s continuation state');
    return null;
  }
}

/**
 * What to hang a wake off: the thread's owner and the person's last message
 * in it.
 *
 * A continuation the assistant starts itself is born inside a turn and knows
 * the message it came from. One started by something OUTSIDE a turn — a
 * browser task finishing minutes later, in another service — does not, and
 * the row needs both: the account because the work is done on somebody's
 * behalf, and the origin message because supersession and cancellation are
 * measured against it.
 *
 * Null when the thread has nothing of the person's in it, which is not a
 * thread anything should be pushed into.
 */
export async function threadOriginFor(
  tenantId: string,
  surface: 'liftoff' | 'insights',
  threadId: string,
): Promise<{ accountId: string; originMessageId: string } | null> {
  const messages = surface === 'liftoff' ? 'liftoff_chat_messages' : 'insights_chat_messages';
  const threads = surface === 'liftoff' ? 'liftoff_chat_threads' : 'insights_chat_threads';
  const r = await withTenantScope(tenantId, (client) => client.query<{ account_id: string; message_id: string | null }>(
    `SELECT t.account_id,
            (SELECT m.id FROM ${messages} m
              WHERE m.thread_id = t.id AND m.role = 'user'
              ORDER BY m.created_at DESC LIMIT 1) AS message_id
       FROM ${threads} t
      WHERE t.id = $1 AND t.tenant_id = $2 AND t.deleted_at IS NULL`,
    [threadId, tenantId],
  ));
  const row = r.rows[0];
  if (!row || !row.account_id || !row.message_id) return null;
  return { accountId: row.account_id, originMessageId: row.message_id };
}

/** Whether the thread has a person's message newer than the origin: the
 *  supersession test the worker runs under the lock. Reads the surface's own
 *  messages table by id, so it is given the reader. */
export async function hasNewerPersonMessage(
  tenantId: string,
  surface: 'liftoff' | 'insights',
  threadId: string,
  originMessageId: string,
): Promise<boolean> {
  const table = surface === 'liftoff' ? 'liftoff_chat_messages' : 'insights_chat_messages';
  const r = await withTenantScope(tenantId, (client) => client.query<{ newer: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${table} m
        WHERE m.thread_id = $1 AND m.role = 'user'
          AND m.created_at > (SELECT o.created_at FROM ${table} o WHERE o.id = $2)
     ) AS newer`,
    [threadId, originMessageId],
  ));
  return r.rows[0]?.newer === true;
}
