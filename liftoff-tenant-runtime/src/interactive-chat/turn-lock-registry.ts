// The in-flight turn registry for team chat.
//
// ONE property, ONE implementation: a thread is busy only while something is
// demonstrably serving it (INV-PB-018).
//
// Every statement that asks or answers "is a turn running on this thread" lives
// here. Four owners each wrote their own before:
//
//   src/interactive-chat/locks.ts                     acquire / heartbeat / release
//   src/interactive-chat/sigterm-handler.ts           the orderly-exit cleanup
//   src/agent-execution/engine/workspace-reaper.ts    the live-workspace skip and
//                                                     its tombstone
//   src/handlers/internal-cron-handler.ts             the expiry sweep
//
// and the first three each decided liveness for themselves, from an unexpired
// lease. The heartbeat ran every 2 minutes into a 20-minute lease, a 10x gap, so
// that answer was worthless: a row heartbeated 5 seconds ago and a row abandoned
// 19 minutes ago were the same row to all of them.
//
// A fifth owner existed and is here too: `src/scheduling/stalled-run-reconciler.ts`
// frees the threads of runs it has just closed (`releaseLocksForInvocations`). It
// asks no liveness question — it names invocations — but leaving one statement
// outside would have made this module's exclusivity a convention rather than a
// fact, and `eslint-rules/no-turn-locks-outside-registry.js` fails the build when
// a sixth appears.
//
// LIVENESS IS READ, NEVER INFERRED. `heartbeat_at` (migration 440) is the fact;
// the lease is not evidence of anything except that nobody has reclaimed the row
// yet. A turn heartbeats every ~20s, so 75 seconds tolerates three missed beats
// before the thread is declared free — and a container that died takes the thread
// back in 75 seconds instead of 20 minutes, with no code running anywhere. That
// last clause is why this is the primary fix: it holds under SIGKILL and under an
// OOM kill, where the drain handler does not run at all.
//
// A container that exits mid-turn (every Postgres socket on an instance closing
// at once is enough) otherwise leaves a conversation answered by nothing until
// the lease runs out. This table has the same shape, the same two constants and
// the same two readers as platform-backend's, so team chat carries the same
// wedge.
//
// EVERY FUNCTION TAKES AN OPTIONAL CLIENT, and that is load-bearing rather than
// tidy. The workspace reaper reads the lock and writes its tombstone inside one
// `BEGIN … FOR UPDATE SKIP LOCKED` transaction; a registry call that opened its
// own connection would silently break the atomicity of that acquisition — the
// TOCTOU guard the reaper exists to have — and nothing would fail until two
// sweeps raced.
//
// RLS: `chat_turn_locks` has never carried a policy (migration 084 creates it
// with none), so these statements run on the pool directly. That is why there is
// no scope wrapper here and why migration 440 adds no NO FORCE / FORCE pair.

import type { Pool, PoolClient } from 'pg';

/** Anything that can run a statement: a pool, or a client inside a caller's
 *  transaction. */
type Queryable = Pick<Pool, 'query'> | PoolClient;

/** How long after its last heartbeat a turn still counts as running.
 *
 *  Sized off the heartbeat, not off the work: HEARTBEAT_BASE_MS is 20s with ±3s
 *  of jitter, so the longest legitimate gap between two beats is 23s and this
 *  absorbs three of them. Deliberately unrelated to how long a turn takes — the
 *  question is whether something is still there, not whether it is finished. */
export const LIVE_WINDOW_SECONDS = 75;

/**
 * The one definition of "a turn is running on this row".
 *
 * Both halves are load-bearing and neither implies the other:
 *
 *   heartbeat_at > NOW() - 75s  — somebody is demonstrably still serving it.
 *   expires_at   > NOW()        — the row has not been handed to anyone else.
 *
 * A fragment rather than a WHERE builder, because every statement that needs it
 * already has its own tenant/thread predicate. It names no parameters of its own,
 * so it composes positionally with any of them.
 */
export const LIVE_LOCK_PREDICATE =
  `heartbeat_at > NOW() - INTERVAL '${LIVE_WINDOW_SECONDS} seconds' AND expires_at > NOW()`;

/** The lease every acquire and every heartbeat writes.
 *
 *  Twenty minutes, unchanged, and no longer a liveness signal: it is how long a
 *  row survives an owner that never came back. */
const LOCK_EXPIRY_SQL = "INTERVAL '20 minutes'";

/** What acquisition did. `held` is a live turn somebody else owns, which the
 *  chat-turn handler answers as a 409; it is NOT an error. */
export type LockAcquisition = 'acquired' | 'held';

function db(pool: Pool, client?: PoolClient): Queryable {
  return client ?? pool;
}

/**
 * Claim the thread for this turn.
 *
 * The DELETE first clears a row that is NOT live by the shared predicate — the
 * widening this module exists for. It used to read `expires_at <= NOW()`, so a
 * thread whose container died was reclaimable only after the full 20-minute
 * lease.
 */
export async function acquireLock(
  pool: Pool,
  tenantId: string,
  threadId: string,
  invocationId: string,
  client?: PoolClient,
): Promise<LockAcquisition> {
  const c = db(pool, client);
  await c.query(
    `DELETE FROM chat_turn_locks
      WHERE tenant_id = $1 AND thread_id = $2
        AND NOT (${LIVE_LOCK_PREDICATE})`,
    [tenantId, threadId],
  );
  const result = await c.query(
    `INSERT INTO chat_turn_locks (tenant_id, thread_id, acquired_by_invocation_id, expires_at, heartbeat_at)
     VALUES ($1, $2, $3, NOW() + ${LOCK_EXPIRY_SQL}, NOW())
     ON CONFLICT (tenant_id, thread_id) DO NOTHING
     RETURNING 1`,
    [tenantId, threadId, invocationId],
  );
  return (result.rowCount ?? 0) === 0 ? 'held' : 'acquired';
}

/**
 * Prove this turn is still running, and push its lease out.
 *
 * Returns the number of rows matched. Zero means this turn no longer owns the
 * thread — reclaimed, or stolen by the reaper's tombstone — which the caller
 * treats exactly as it treats a run of failed heartbeats.
 *
 * BOTH columns move. Writing only `expires_at` is what the old heartbeat did, and
 * it is why the writer must ship one deployment ahead of the readers: an old
 * revision's live turn carries a frozen `heartbeat_at`, and a new revision
 * reading the 75-second predicate would take its workspace apart underneath it.
 */
export async function heartbeatLock(
  pool: Pool,
  tenantId: string,
  threadId: string,
  invocationId: string,
  client?: PoolClient,
): Promise<number> {
  const result = await db(pool, client).query(
    `UPDATE chat_turn_locks
        SET heartbeat_at = NOW(),
            expires_at = NOW() + ${LOCK_EXPIRY_SQL}
      WHERE tenant_id = $1 AND thread_id = $2 AND acquired_by_invocation_id = $3
      RETURNING 1`,
    [tenantId, threadId, invocationId],
  );
  return result.rowCount ?? 0;
}

/**
 * Drop this turn's lock row.
 *
 * Keyed on the invocation as well as the thread, so a turn that lost the row to a
 * reclaim cannot delete the row of whatever is running now.
 */
export async function releaseLock(
  pool: Pool,
  tenantId: string,
  threadId: string,
  invocationId: string,
  client?: PoolClient,
): Promise<void> {
  await db(pool, client).query(
    `DELETE FROM chat_turn_locks
      WHERE tenant_id = $1 AND thread_id = $2 AND acquired_by_invocation_id = $3`,
    [tenantId, threadId, invocationId],
  );
}

/** How old a row has to be for the drain to take it regardless of who holds it.
 *  Past the 20-minute lease, so it can only ever name a row nothing renewed. */
const DRAIN_AGE_FALLBACK_SQL = "INTERVAL '25 minutes'";

/**
 * The orderly-exit cleanup: drop this turn's row, OR a row on the same thread old
 * enough that nothing can still be renewing it.
 *
 * The age fallback is there for the reaper-tombstone case — the reaper may hold
 * the row under its own invocation id, and a drain that only matched our own id
 * would leave it behind (BE-R5-008).
 */
export async function releaseLockOnDrain(
  pool: Pool,
  tenantId: string,
  threadId: string,
  invocationId: string,
  client?: PoolClient,
): Promise<void> {
  await db(pool, client).query(
    `DELETE FROM chat_turn_locks
      WHERE tenant_id = $1 AND thread_id = $2
        AND (acquired_by_invocation_id = $3
             OR acquired_at < NOW() - ${DRAIN_AGE_FALLBACK_SQL})`,
    [tenantId, threadId, invocationId],
  );
}

/**
 * The invocation running on this thread right now, or null.
 *
 * The plain liveness read, and the one `findActiveInvocationId` is built on. A
 * mid-run message and a stop are both addressed to an invocation id, and before
 * this the handler took that id from `invocations.completed_at IS NULL` alone —
 * the same defect as an unexpired lease in its UNBOUNDED form. A lease at least
 * expires; a row whose writer died is never completed by anyone, so a dead
 * invocation swallowed every message on its thread indefinitely, with no end
 * date. The lock is what bounds it.
 *
 * Returns null when the table is missing (42P01, a service ahead of its
 * migration). That is the conservative answer and it matches what locks.ts does
 * in the same state: the turn runs, it just cannot be stopped or steered mid-run,
 * because without the lock there is nothing to bound liveness with and an
 * unbounded answer is the defect this exists to remove.
 */
export async function liveLockInvocationId(
  pool: Pool,
  tenantId: string,
  threadId: string,
  client?: PoolClient,
): Promise<string | null> {
  try {
    const result = await db(pool, client).query(
      `SELECT acquired_by_invocation_id FROM chat_turn_locks
        WHERE tenant_id = $1 AND thread_id = $2
          AND ${LIVE_LOCK_PREDICATE}`,
      [tenantId, threadId],
    );
    return (result.rows[0]?.acquired_by_invocation_id as string | undefined) ?? null;
  } catch (err) {
    if ((err as { code?: string })?.code === '42P01') return null;
    throw err;
  }
}

/**
 * Is a turn running on this thread, taking the row for update and skipping a row
 * somebody else has locked?
 *
 * The workspace reaper's TOCTOU guard, and the reason the client parameter
 * exists: this SELECT and the tombstone INSERT that follows it are one
 * transaction, and separating them would let two sweeps both decide a workspace
 * was free.
 *
 * SKIP LOCKED means a row another transaction holds reads as absent here. That is
 * the conservative answer for a reaper — it skips the workspace this sweep and
 * tries again next tick — but it would be the wrong answer for a liveness
 * question, which is why nothing else calls this.
 *
 * The client is REQUIRED, and it is the first parameter rather than an optional
 * last one — the only function here shaped that way. `FOR UPDATE` outside a
 * transaction takes a row lock and releases it immediately, so a caller that
 * passed a pool would get a statement that reads correctly and guards nothing,
 * with no error to notice. The type is what stops that.
 */
export async function lockIsLiveForUpdate(
  client: PoolClient,
  tenantId: string,
  threadId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM chat_turn_locks
      WHERE tenant_id = $1 AND thread_id = $2
        AND ${LIVE_LOCK_PREDICATE}
      FOR UPDATE SKIP LOCKED`,
    [tenantId, threadId],
  );
  return result.rows.length > 0;
}

/** Clear a row on this thread that nothing is serving. Same predicate as
 *  acquisition's own pre-DELETE, for the same reason. */
export async function deleteDeadLock(
  pool: Pool,
  tenantId: string,
  threadId: string,
  client?: PoolClient,
): Promise<void> {
  await db(pool, client).query(
    `DELETE FROM chat_turn_locks
      WHERE tenant_id = $1 AND thread_id = $2
        AND NOT (${LIVE_LOCK_PREDICATE})`,
    [tenantId, threadId],
  );
}

/**
 * Take the thread as a TOMBSTONE for a short window, so a workspace can be
 * removed without a turn starting on top of it.
 *
 * Not a turn, and deliberately a different function from `acquireLock`: it writes
 * no heartbeat schedule behind it, and its lease is seconds rather than minutes
 * because nothing will renew it. `heartbeat_at` is still stamped — a tombstone
 * that read as dead the instant it was written would be skipped by its own
 * holder's next statement.
 */
export async function acquireTombstone(
  pool: Pool,
  tenantId: string,
  threadId: string,
  reaperInvocationId: string,
  ttlSeconds: number,
  client?: PoolClient,
): Promise<LockAcquisition> {
  // A number, formatted here, so nothing a caller spells reaches the statement.
  const ttl = `INTERVAL '${Math.trunc(ttlSeconds)} seconds'`;
  const result = await db(pool, client).query(
    `INSERT INTO chat_turn_locks (tenant_id, thread_id, acquired_by_invocation_id, expires_at, heartbeat_at)
     VALUES ($1, $2, $3, NOW() + ${ttl}, NOW())
     ON CONFLICT (tenant_id, thread_id) DO NOTHING
     RETURNING 1`,
    [tenantId, threadId, reaperInvocationId],
  );
  return (result.rowCount ?? 0) === 0 ? 'held' : 'acquired';
}

/**
 * Free the threads of runs that have just been closed.
 *
 * The stalled-run reconciler's, and the one statement here that asks no liveness
 * question: it names the invocations it closed, so whether anything was
 * heartbeating them is already answered — nothing was, which is why they were
 * closed. Keyed on the invocation for the same reason `releaseLock` is, and the
 * tenant is in the predicate rather than implied by the ids.
 *
 * A process still holding one of these rows sees rowCount 0 on its next heartbeat
 * and aborts its own, already dead, turn.
 */
export async function releaseLocksForInvocations(
  pool: Pool,
  tenantId: string,
  invocationIds: string[],
  client?: PoolClient,
): Promise<number> {
  if (invocationIds.length === 0) return 0;
  const result = await db(pool, client).query(
    `DELETE FROM chat_turn_locks
      WHERE tenant_id = $1::uuid AND acquired_by_invocation_id = ANY($2::uuid[])`,
    [tenantId, invocationIds],
  );
  return result.rowCount ?? 0;
}

/**
 * The expiry sweep. Still keyed on the LEASE, and deliberately so.
 *
 * This is the backstop, not a liveness signal: it exists to stop rows
 * accumulating for threads nothing ever returns to, and a row past its 20-minute
 * lease is one nobody has renewed by any measure. Narrowing it to the 75-second
 * window would make a cron tick race live turns, which is the opposite of what a
 * backstop is for.
 */
export async function sweepExpiredLocks(
  pool: Pool,
  client?: PoolClient,
): Promise<Array<{ tenant_id: string; thread_id: string }>> {
  const result = await db(pool, client).query(
    `DELETE FROM chat_turn_locks WHERE expires_at < NOW() RETURNING tenant_id, thread_id`,
  );
  return result.rows as Array<{ tenant_id: string; thread_id: string }>;
}
