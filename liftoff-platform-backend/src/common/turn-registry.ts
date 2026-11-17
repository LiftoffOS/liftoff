// The in-flight turn registry for the two platform chat surfaces.
//
// ONE property, ONE implementation: a thread is busy only while something is
// demonstrably serving it (INV-PB-018).
//
// This module is the only place `liftoff_turn_locks` and `insights_turn_locks`
// may be named in SQL, and `eslint-rules/no-turn-locks-outside-registry.js`
// fails the build when a second place appears. That fence is the point of the
// module, because the defect it replaces was not a wrong query — it was FOUR
// right-looking copies of the same wrong query:
//
//   src/liftoff/turn-control.ts     findActiveTurnId
//   src/insights/turn-control.ts    findActiveTurnId
//   src/common/chat-presence-repository.ts  liveTurnId
//   the acquire path's own expired-row DELETE
//
// each hand-writing `expires_at > NOW()` under a comment asserting the opposite:
// "An expired lock does not count. A container that died mid-turn must not leave
// the thread looking busy for the rest of the expiry window." The heartbeat ran
// every 2 minutes into a 20-minute lease, so that comment could not be true of
// any of them. Writing it down a fifth time is demonstrably not a fix.
//
// LIVENESS IS READ, NEVER INFERRED. `heartbeat_at` (migration 561) is the fact;
// the lease is not evidence of anything except that nobody has reclaimed the row
// yet. A turn heartbeats every ~20s, so 75 seconds tolerates three missed beats
// before the thread is declared free — and a container that died takes the
// thread back in 75 seconds instead of 20 minutes, with no code running
// anywhere. That last clause is why this is the primary fix and not the
// borrowed-client guard: it holds under SIGKILL and under an OOM kill, where no
// handler runs at all.
//
// "IDLE" AND "ACQUIRABLE" CANNOT DISAGREE, because the readers and the acquire
// path share `LIVE_LOCK_PREDICATE` rather than each spelling it out. A reader
// that thought a thread was free while acquire thought it was taken would answer
// a person with a 409 that the UI has no state for.
//
// RLS: both lock tables are FORCE-RLS on tenant_id, so every statement here runs
// inside withTenantScope — or inside a transaction the CALLER already opened and
// scoped, which is what the optional `client` parameter is for. The tenant
// runtime's workspace reaper reads the lock and writes its tombstone inside one
// `BEGIN … FOR UPDATE SKIP LOCKED`, and a registry call that opened its own
// connection would silently break that atomicity; the presence poll needs the
// same thing for a different reason — it reads the live turn in the same
// transaction as its own heartbeat write, so a viewer cannot learn about a turn
// in one poll and lose it in the next to a read that landed elsewhere.

import type { PoolClient } from 'pg';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

/** The two platform chat surfaces that serialize a thread with a turn lock.
 *  Team chat's equivalent lives in the tenant runtime (`chat_turn_locks`). */
export type TurnLockSurface = 'liftoff' | 'insights';

// Table names are interpolated into SQL, so they can only ever come from here —
// a surface is an enum the caller already has, never a caller-supplied string.
const SURFACE_LOCK_TABLES: Record<TurnLockSurface, string> = {
  liftoff: 'liftoff_turn_locks',
  insights: 'insights_turn_locks',
};

/** How long after its last heartbeat a turn still counts as running.
 *
 *  Sized off the heartbeat, not off the work: HEARTBEAT_BASE_MS is 20s with ±3s
 *  of jitter, so the longest legitimate gap between two beats is 23s and this
 *  absorbs three of them. It is deliberately unrelated to how long a turn takes
 *  (~60s typical, 880s at the cap) — the question is whether something is still
 *  there, not whether it is finished. */
export const LIVE_WINDOW_SECONDS = 75;

/**
 * The one definition of "a turn is running on this row".
 *
 * Both halves are load-bearing and neither implies the other:
 *
 *   heartbeat_at > NOW() - 75s  — somebody is demonstrably still serving it.
 *   expires_at   > NOW()        — the row has not been handed to anyone else.
 *
 * Interpolated into SQL as a fragment rather than exposed as a WHERE builder,
 * because every statement that needs it already has its own tenant/thread
 * predicate and a builder would only obscure that. It names no columns a caller
 * has to supply and no parameters, so it composes positionally with any of them.
 */
export const LIVE_LOCK_PREDICATE =
  `heartbeat_at > NOW() - INTERVAL '${LIVE_WINDOW_SECONDS} seconds' AND expires_at > NOW()`;

/** The lease the acquire INSERT and every heartbeat write.
 *
 *  Twenty minutes, unchanged, and no longer a liveness signal: it is how long a
 *  row survives an owner that never came back, which only matters now for the
 *  window between a crash and the next message on that thread. */
const LOCK_EXPIRY_SQL = "INTERVAL '20 minutes'";

/** What acquisition did. `held` is a live turn somebody else owns, which the
 *  routers answer as a 409; it is NOT an error. */
export type LockAcquisition = 'acquired' | 'held';

/** Thrown inside the acquire transaction so a lost race rolls back the
 *  dead-row DELETE with it. Never escapes this module. */
class ConcurrentTurnError extends Error {}

/**
 * Run `fn` against the caller's client when it supplied one, otherwise open a
 * tenant scope of our own.
 *
 * A caller inside a transaction keeps its atomicity, and a caller that is not
 * does not have to invent one. The tenant id is still required in both cases:
 * it is a predicate on every statement here, not only the RLS variable.
 */
function runScoped<T>(
  tenantId: string,
  client: PoolClient | undefined,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  return client ? fn(client) : withTenantScope(tenantId, fn);
}

// ── Reads ───────────────────────────────────────────────────────────────

/**
 * The turn running on this thread right now, or null.
 *
 * Degrades OPEN: a missing table (42P01, a service deployed ahead of its
 * migration) and a failed read both answer "idle", because the alternative is
 * refusing to hold a conversation over a lookup whose whole job is to decide
 * whether to fold a message into a run. The cost of a wrong "idle" is a 409 from
 * the acquire path; the cost of a wrong "busy" is the wedged thread this
 * module exists to prevent.
 */
export async function findActiveTurnId(
  surface: TurnLockSurface,
  tenantId: string,
  threadId: string,
  client?: PoolClient,
): Promise<string | null> {
  try {
    return await liveTurnId(surface, tenantId, threadId, client);
  } catch (err) {
    if (isRelationMissing(err)) return null;
    log.warn(
      { surface, tenantId, threadId, err: (err as Error).message },
      'Turn-lock lookup failed; treating the thread as idle',
    );
    return null;
  }
}

/**
 * The same read, with its errors left to the caller.
 *
 * This is the one presence uses. Its query runs inside the presence poll's own
 * transaction, where swallowing an error would be a lie twice over: the
 * transaction is already aborted, and every statement after it would fail
 * anyway. `findActiveTurnId` is the degrading wrapper for callers that own no
 * transaction.
 */
export async function liveTurnId(
  surface: TurnLockSurface,
  tenantId: string,
  threadId: string,
  client?: PoolClient,
): Promise<string | null> {
  const table = SURFACE_LOCK_TABLES[surface];
  return runScoped(tenantId, client, async (c) => {
    const result = await c.query(
      `SELECT turn_id
         FROM ${table}
        WHERE tenant_id = $1 AND thread_id = $2
          AND ${LIVE_LOCK_PREDICATE}`,
      [tenantId, threadId],
    );
    return (result.rows[0]?.turn_id as string | undefined) ?? null;
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────────

/**
 * Claim the thread for this turn.
 *
 * The DELETE first clears a row that is NOT live by the shared predicate —
 * which is the widening this module exists for. It used to read
 * `expires_at <= NOW()`, so a thread whose container died was reclaimable only
 * after the full 20-minute lease; now a row nobody has heartbeated for 75
 * seconds is reclaimed on the next message. The lease still reclaims a row whose
 * heartbeat somehow kept running past it, which is the only job it has left.
 *
 * The DELETE and the INSERT are one transaction on purpose: a lost race must
 * roll the DELETE back with it, or two messages arriving together could both
 * clear the row and neither hold it.
 *
 * WITH A CALLER-SUPPLIED CLIENT that rollback is the CALLER's, and this is the
 * one place the optional-client API changes a guarantee rather than preserving
 * it: `held` then means the INSERT conflicted with the caller's DELETE already
 * applied in their open transaction, and they have to roll it back. The tenant
 * runtime's workspace reaper does exactly that. A caller that commits anyway has
 * cleared a row it does not hold.
 */
export async function acquireLock(
  surface: TurnLockSurface,
  tenantId: string,
  threadId: string,
  turnId: string,
  client?: PoolClient,
): Promise<LockAcquisition> {
  const table = SURFACE_LOCK_TABLES[surface];
  try {
    await runScoped(tenantId, client, async (c) => {
      await c.query(
        `DELETE FROM ${table}
          WHERE tenant_id = $1 AND thread_id = $2
            AND NOT (${LIVE_LOCK_PREDICATE})`,
        [tenantId, threadId],
      );
      const result = await c.query(
        `INSERT INTO ${table} (tenant_id, thread_id, turn_id, expires_at, heartbeat_at)
         VALUES ($1, $2, $3, NOW() + ${LOCK_EXPIRY_SQL}, NOW())
         ON CONFLICT (tenant_id, thread_id) DO NOTHING
         RETURNING 1`,
        [tenantId, threadId, turnId],
      );
      if ((result.rowCount ?? 0) === 0) throw new ConcurrentTurnError();
    });
    return 'acquired';
  } catch (err) {
    if (err instanceof ConcurrentTurnError) return 'held';
    throw err;
  }
}

/**
 * Prove this turn is still running, and push its lease out.
 *
 * Returns the number of rows the UPDATE matched. Zero means this turn no longer
 * owns the thread — reclaimed after a run of missed heartbeats — which the
 * caller treats exactly as it treats a run of failed heartbeats.
 *
 * BOTH columns move. Writing only `expires_at` is what the old heartbeat did,
 * and it is why the writer had to ship one deployment ahead of the readers: an
 * old revision's live turn carries a frozen `heartbeat_at`, and a new revision
 * reading the 75-second predicate would reclaim the thread underneath it.
 */
export async function heartbeatLock(
  surface: TurnLockSurface,
  tenantId: string,
  threadId: string,
  turnId: string,
  client?: PoolClient,
): Promise<number> {
  const table = SURFACE_LOCK_TABLES[surface];
  return runScoped(tenantId, client, async (c) => {
    const result = await c.query(
      `UPDATE ${table}
          SET heartbeat_at = NOW(),
              expires_at = NOW() + ${LOCK_EXPIRY_SQL}
        WHERE tenant_id = $1 AND thread_id = $2 AND turn_id = $3
        RETURNING 1`,
      [tenantId, threadId, turnId],
    );
    return result.rowCount ?? 0;
  });
}

/**
 * End the turn by dropping its lock row.
 *
 * Keyed on turn_id as well as the thread, so a turn that lost the row to a
 * reclaim cannot delete the row of whatever is running now. The surface's
 * signals go with it through the foreign key's cascade.
 */
export async function releaseLock(
  surface: TurnLockSurface,
  tenantId: string,
  threadId: string,
  turnId: string,
  client?: PoolClient,
): Promise<void> {
  const table = SURFACE_LOCK_TABLES[surface];
  await runScoped(tenantId, client, async (c) => {
    await c.query(
      `DELETE FROM ${table}
        WHERE tenant_id = $1 AND thread_id = $2 AND turn_id = $3`,
      [tenantId, threadId, turnId],
    );
  });
}

function isRelationMissing(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}
