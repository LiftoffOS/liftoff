/**
 * R5 Fix 4: Chat turn lock with jittered heartbeat + AbortController.
 *
 * Lock lifecycle (the SQL is src/interactive-chat/turn-lock-registry.ts's, which
 * owns every statement that asks or answers "is a turn running" — INV-PB-018):
 *   acquire:  INSERT ... ON CONFLICT DO NOTHING RETURNING, with a pre-DELETE of
 *             any row NOTHING IS HEARTBEATING, so a thread whose container died
 *             is reclaimed in ~75s rather than after the full 20-minute lease
 *   heartbeat: UPDATE of heartbeat_at AND expires_at, on a recursive setTimeout
 *              with ±3s jitter every 20s (BE-R4-003). Both columns, because
 *              liveness is now READ from heartbeat_at: a heartbeat that moved
 *              only the lease is indistinguishable from an abandoned turn
 *   on failure: after 3 consecutive heartbeat failures OR rowCount=0 (row
 *               stolen by reaper or expired), fire AbortController to cancel
 *               the in-flight SDK query
 *   release:  DELETE WHERE acquired_by_invocation_id (with SIGTERM fallback
 *             by (tenant_id, thread_id) tuple — BE-R5-008)
 */
import type { Pool } from 'pg';
import { scrubLogger } from '../observability/scrub-logger';
import { acquireLock, heartbeatLock, releaseLock as registryReleaseLock } from './turn-lock-registry';

// A heartbeat is now the thing liveness is READ from (INV-PB-018), so its period
// sets how quickly a thread comes back after a container dies, not just how often
// a lease is pushed out. 20s against the registry's 75s window tolerates three
// missed beats; at the old 2 minutes against a 20-minute lease the two numbers
// were 10x apart and the lease told a reader nothing. Cost is one UPDATE per live
// turn per 20s.
const HEARTBEAT_BASE_MS = 20_000; // 20s
const HEARTBEAT_JITTER_MS = 3_000; // ±3s
const MAX_CONSECUTIVE_FAILURES = 3;

export interface LockHandle {
  tenantId: string;
  threadId: string;
  invocationId: string;
  abortController: AbortController;
  heartbeatTask: ReturnType<typeof setTimeout> | null;
  consecutiveFailures: number;
  released: boolean;
}

function nextHeartbeatDelay(): number {
  return HEARTBEAT_BASE_MS + (Math.random() * 2 - 1) * HEARTBEAT_JITTER_MS;
}

function isRelationMissingError(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

export class LockServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockServiceUnavailableError';
  }
}

export async function tryAcquireLock(
  pool: Pool,
  tenantId: string,
  threadId: string,
  invocationId: string,
): Promise<LockHandle | null> {
  try {
    // A row nobody is heartbeating is cleared first, so a thread whose container
    // died is reclaimed on the next message rather than wedged for the rest of
    // the lease. The registry owns that predicate and the SQL; what stays here is
    // the handle — the abort signal the SDK query carries and the heartbeat
    // schedule.
    const acquisition = await acquireLock(pool, tenantId, threadId, invocationId);
    if (acquisition === 'held') {
      return null; // concurrent turn holds the lock
    }
  } catch (err) {
    if (isRelationMissingError(err)) {
      scrubLogger.warn({ event: 'chat_turn_locks_table_missing' });
      // Graceful degradation: proceed without lock (dev/migration states)
      return {
        tenantId,
        threadId,
        invocationId,
        abortController: new AbortController(),
        heartbeatTask: null,
        consecutiveFailures: 0,
        released: false,
      };
    }
    scrubLogger.error({ event: 'lock_acquire_db_error', err: (err as Error).message });
    throw new LockServiceUnavailableError((err as Error).message);
  }

  const handle: LockHandle = {
    tenantId,
    threadId,
    invocationId,
    abortController: new AbortController(),
    heartbeatTask: null,
    consecutiveFailures: 0,
    released: false,
  };

  scrubLogger.info({ event: 'lock_acquired', tenantId, threadId, invocationId });

  const scheduleNext = (): void => {
    if (handle.released) return;
    handle.heartbeatTask = setTimeout(async () => {
      if (handle.released) return;
      try {
        const rowCount = await heartbeatLock(pool, tenantId, threadId, invocationId);
        if (rowCount === 0) {
          // The row is gone or belongs to somebody else: the reaper's tombstone
          // took it, nothing heartbeated it inside the registry's window, or its
          // lease finally ran out.
          handle.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
        } else {
          handle.consecutiveFailures = 0;
        }
      } catch (err) {
        handle.consecutiveFailures++;
        scrubLogger.warn({
          event: 'lock_heartbeat_failed',
          err: (err as Error).message,
          consecutiveFailures: handle.consecutiveFailures,
        });
      }

      if (handle.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        scrubLogger.error({ event: 'lock_lost', tenantId, threadId, invocationId });
        handle.abortController.abort(new Error('Lock lost'));
        return; // stop rescheduling
      }
      scheduleNext();
    }, nextHeartbeatDelay());
  };

  scheduleNext();
  return handle;
}

export async function releaseLock(pool: Pool, handle: LockHandle): Promise<void> {
  if (handle.released) return;
  handle.released = true;
  if (handle.heartbeatTask) {
    clearTimeout(handle.heartbeatTask);
    handle.heartbeatTask = null;
  }
  try {
    await registryReleaseLock(pool, handle.tenantId, handle.threadId, handle.invocationId);
    scrubLogger.info({
      event: 'lock_released',
      tenantId: handle.tenantId,
      threadId: handle.threadId,
      invocationId: handle.invocationId,
    });
  } catch (err) {
    scrubLogger.warn({
      event: 'sigterm_release_failed',
      tenantId: handle.tenantId,
      threadId: handle.threadId,
      err: (err as Error).message,
    });
  }
}
