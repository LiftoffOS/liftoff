// Mid-run control for the insights chat (ADR-041).
//
// Two tables do the whole job (migration 332):
//
// The SQL for all three lifecycle statements and for the liveness read is
// src/common/turn-registry.ts's, which is the only module that may name either
// lock table (INV-PB-018): a lock is not a heartbeat, and several hand-written
// copies of that question let a dead container wedge a conversation until the
// lease ran out. What stays here is the handle and the signals.
//
//   insights_turn_locks   — one row per live turn on a thread. The primary key
//                           (tenant_id, thread_id) IS the mutex, and the row is
//                           also the in-flight registry: its turn_id is the
//                           address a stop or a mid-run message is written to.
//   insights_turn_signals — 'abort' and 'user_message' rows addressed to one
//                           turn_id, claimed by the loop at its boundaries.
//
// The lock is the first act of a turn, so a turn is addressable from the instant
// it starts — no window where Stop no-ops because the registry row has not been
// written yet.
//
// Every function here degrades OPEN when the tables are missing (42P01): a
// service deployed ahead of its migration must still be able to hold a
// conversation. Missing tables mean "no mid-run control", never "no chat".
//
// Signals never outlive their turn: the lock row is the foreign-key parent, so
// releasing a lock (or reclaiming an expired one) takes its signals with it.
// Nothing here sweeps, and nothing can accumulate.
//
// Ported from Liftoff-Tenant-Runtime src/interactive-chat/locks.ts (lock
// lifecycle + jittered heartbeat) and src/agent-execution/service.ts (atomic
// signal claims). RLS note: both tables are FORCE-RLS — the lock by tenant_id,
// the signals through the lock that owns the turn — so every query here runs
// inside withTenantScope.

import { randomUUID } from 'crypto';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import {
  acquireLock,
  findActiveTurnId as registryFindActiveTurnId,
  heartbeatLock,
  releaseLock,
} from '../common/turn-registry';

// A heartbeat is now the thing liveness is READ from (INV-PB-018), so its
// period sets how quickly a thread comes back after a container dies, not just
// how often a lease is pushed out. 20s against the registry's 75s window
// tolerates three missed beats; at the old 2 minutes against a 20-minute lease
// the two numbers were 10x apart and the lease told a reader nothing.
// Cost is one UPDATE per live turn per 20s — a turn runs ~60s, so about three
// writes.
// Which lock table this module's turn belongs to. Named once: every registry
// call takes it, and the two values are both valid members of the union, so a
// typo at a call site would compile and quietly operate on the OTHER surface's
// table.
const SURFACE = 'insights' as const;

const HEARTBEAT_BASE_MS = 20_000; // 20s
const HEARTBEAT_JITTER_MS = 3_000; // ±3s
const MAX_CONSECUTIVE_FAILURES = 3;
const RELEASE_MAX_RETRIES = 2;
const RELEASE_RETRY_DELAY_MS = 250;

export interface TurnLockHandle {
  tenantId: string;
  threadId: string;
  turnId: string;
  /** Aborted when the lock is lost, or when the loop claims a user stop. The
   *  streaming LLM call carries this signal so a stop does not wait out the
   *  rest of the model's output. */
  abortController: AbortController;
  heartbeatTask: ReturnType<typeof setTimeout> | null;
  consecutiveFailures: number;
  released: boolean;
}

export class TurnLockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnLockUnavailableError';
  }
}

/** Every lock this process currently holds.
 *
 *  A lock row that outlives its turn is worse than no lock at all: for as long
 *  as it sits there the thread looks busy, so the next message is delivered
 *  into a turn that is not running and nothing ever answers it. The request's
 *  own `finally` covers the normal path; this registry covers the one it
 *  cannot — the container going away mid-turn — by letting the SIGTERM drain
 *  release what is still held. */
const liveLocks = new Set<TurnLockHandle>();

/** Release every lock this process holds. Wired into the server's SIGTERM
 *  handler so a deploy does not leave threads looking busy for the whole expiry
 *  window. */
export async function releaseAllLiveTurnLocks(): Promise<void> {
  const held = [...liveLocks];
  if (held.length === 0) return;
  log.info({ count: held.length }, 'Releasing insights turn locks held at shutdown');
  await Promise.all(held.map((handle) => releaseTurnLock(handle)));
}

function nextHeartbeatDelay(): number {
  return HEARTBEAT_BASE_MS + (Math.random() * 2 - 1) * HEARTBEAT_JITTER_MS;
}

function isRelationMissingError(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

/** Wording for something delivered into a run that is already under way.
 *
 *  Copied verbatim from Liftoff-Tenant-Runtime
 *  src/agent-execution/interrupt-framing.ts. Both halves do real work: sender
 *  attribution changes how the assistant reads the message, and the "mid-run
 *  addition to the current task" clause stops it from abandoning what it was
 *  doing and answering the new line as a fresh request. */
export function frameInterrupt(i: {
  text: string; senderDisplayName: string | null; senderAccountId: string | null;
}): string {
  const who = i.senderDisplayName?.trim();
  return (who ? `${who} just sent a message while you were working: ` : 'A user message arrived while you were working: ')
    + `"${i.text}"\n`
    + 'This is a mid-run addition to the current task, not a new task. Take it into '
    + 'account — adjust course, answer it, or acknowledge it in your reply as appropriate.';
}

export interface MidRunUserMessage {
  text: string;
  senderDisplayName: string | null;
  senderAccountId: string | null;
}

// ── Lock lifecycle ──────────────────────────────────────────────────────

/**
 * Claim the thread for this turn. Returns null when another turn already holds
 * it (the caller answers 409), or a handle when the turn owns the thread.
 *
 * A row nobody is heartbeating is deleted first, so a thread whose previous turn
 * died with its container is reclaimed on the next message rather than wedged for
 * the rest of the lease. The registry owns that predicate and the SQL; what stays
 * here is the handle — the abort signal the turn's model call carries, the
 * heartbeat schedule, and the process-wide set the SIGTERM drain releases.
 */
export async function tryAcquireTurnLock(
  tenantId: string,
  threadId: string,
  turnId: string,
): Promise<TurnLockHandle | null> {
  try {
    const acquisition = await acquireLock(SURFACE, tenantId, threadId, turnId);
    if (acquisition === 'held') {
      return null; // a concurrent turn holds the lock
    }
  } catch (err) {
    if (isRelationMissingError(err)) {
      log.warn(
        { tenantId, threadId },
        'insights_turn_locks missing — running the turn without mid-run control',
      );
      // Degrade open: a service ahead of its migration still holds
      // conversations, it just cannot be stopped or steered mid-run. Not
      // registered as a live lock — there is no row to release.
      return {
        tenantId,
        threadId,
        turnId,
        abortController: new AbortController(),
        heartbeatTask: null,
        consecutiveFailures: 0,
        released: true,
      };
    }
    log.error({ tenantId, threadId, err: (err as Error).message }, 'Insights turn lock acquire failed');
    throw new TurnLockUnavailableError((err as Error).message);
  }

  const handle: TurnLockHandle = {
    tenantId,
    threadId,
    turnId,
    abortController: new AbortController(),
    heartbeatTask: null,
    consecutiveFailures: 0,
    released: false,
  };
  liveLocks.add(handle);

  log.info({ tenantId, threadId, turnId }, 'Insights turn lock acquired');

  const scheduleNext = (): void => {
    if (handle.released) return;
    handle.heartbeatTask = setTimeout(async () => {
      if (handle.released) return;
      try {
        const rowCount = await heartbeatLock(SURFACE, tenantId, threadId, turnId);
        if (rowCount === 0) {
          // The row is gone or belongs to somebody else — reclaimed because
          // nothing heartbeated it inside the registry's window, or because its
          // lease finally ran out. Either way this turn no longer owns the
          // thread, so treat it the same as a run of failed heartbeats.
          handle.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
        } else {
          handle.consecutiveFailures = 0;
        }
      } catch (err) {
        handle.consecutiveFailures++;
        log.warn(
          {
            tenantId,
            threadId,
            turnId,
            err: (err as Error).message,
            consecutiveFailures: handle.consecutiveFailures,
          },
          'Insights turn lock heartbeat failed',
        );
      }

      if (handle.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log.error({ tenantId, threadId, turnId }, 'Insights turn lock lost');
        handle.abortController.abort(new Error('Lock lost'));
        return; // stop rescheduling
      }
      scheduleNext();
    }, nextHeartbeatDelay());
  };

  scheduleNext();
  return handle;
}

/**
 * End the turn by dropping the lock row. Its signals go with it through the
 * foreign key's cascade, so a turn can never leave behind rows that no future
 * turn will look for — they are addressed by turn_id, not by thread.
 */
export async function releaseTurnLock(handle: TurnLockHandle): Promise<void> {
  if (handle.released) return;
  handle.released = true;
  liveLocks.delete(handle);
  if (handle.heartbeatTask) {
    clearTimeout(handle.heartbeatTask);
    handle.heartbeatTask = null;
  }
  // Retried, because a row left behind is not a cosmetic failure: it makes the
  // thread look busy, and the next message is then delivered into a turn that
  // is not running. A transient blip must not cost the person that.
  for (let attempt = 0; attempt <= RELEASE_MAX_RETRIES; attempt++) {
    try {
      await releaseLock(SURFACE, handle.tenantId, handle.threadId, handle.turnId);
      log.info(
        { tenantId: handle.tenantId, threadId: handle.threadId, turnId: handle.turnId },
        'Insights turn lock released',
      );
      return;
    } catch (err) {
      if (isRelationMissingError(err)) return;
      if (attempt === RELEASE_MAX_RETRIES) {
        log.error(
          {
            tenantId: handle.tenantId,
            threadId: handle.threadId,
            turnId: handle.turnId,
            err: (err as Error).message,
          },
          'Insights turn lock release failed after retries — the row expires on its own',
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_DELAY_MS));
    }
  }
}

// ── In-flight lookup + signal writes ────────────────────────────────────

/**
 * The turn running on this thread right now, or null.
 *
 * One line, because the predicate is not this module's to write: an unexpired
 * lease is not evidence that anything is serving the thread, and the three
 * readers that each spelled that out independently are exactly why the registry
 * exists (INV-PB-018). Kept as a named export so the router reads the same way
 * it always has.
 */
export async function findActiveTurnId(
  tenantId: string,
  threadId: string,
): Promise<string | null> {
  return registryFindActiveTurnId(SURFACE, tenantId, threadId);
}

/** What happened to a signal the caller tried to deliver.
 *
 *  'no_turn' is the honest answer to a race the design makes visible: the turn
 *  ended between the caller reading the lock and writing the signal, so the
 *  foreign key rejected a row that nothing would ever have read. Callers treat
 *  it as "nothing is running" rather than as a failure. */
export type SignalDelivery = 'delivered' | 'no_turn' | 'unavailable';

function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23503';
}

/** Write a signal addressed to one turn. */
export async function insertTurnSignal(
  tenantId: string,
  turnId: string,
  signalKind: 'user_message' | 'abort',
  payload: Record<string, unknown>,
): Promise<SignalDelivery> {
  try {
    await withTenantScope(tenantId, async (client) => {
      await client.query(
        `INSERT INTO insights_turn_signals (turn_id, signal_kind, payload)
         VALUES ($1, $2, $3)`,
        [turnId, signalKind, JSON.stringify(payload)],
      );
    });
    return 'delivered';
  } catch (err) {
    if (isForeignKeyViolation(err)) return 'no_turn';
    if (isRelationMissingError(err)) return 'unavailable';
    log.warn(
      { tenantId, turnId, signalKind, err: (err as Error).message },
      'Insights signal insert failed',
    );
    return 'unavailable';
  }
}

/** Ask the turn running on this thread to stop. Mirrors Tenant-Runtime's
 *  tryInsertAbortSignal: no active turn means nothing to stop, which the route
 *  reports as deliveredAs:'noop' rather than an error. */
export async function tryInsertAbortSignal(input: {
  tenantId: string;
  threadId: string;
  senderAccountId: string | null;
  senderDisplayName: string | null;
}): Promise<boolean> {
  const turnId = await findActiveTurnId(input.tenantId, input.threadId);
  if (turnId === null) return false;
  const delivery = await insertTurnSignal(input.tenantId, turnId, 'abort', {
    senderAccountId: input.senderAccountId,
    senderDisplayName: input.senderDisplayName,
    sentAt: new Date().toISOString(),
  });
  return delivery === 'delivered';
}

// ── Boundary claims (consumption IS the claim) ──────────────────────────

/**
 * Claim one pending abort for this turn, if any.
 *
 * The UPDATE ... RETURNING is the claim: two boundary polls racing (the
 * in-flight watcher and the end-of-iteration poll) cannot both consume the same
 * row.
 */
export async function claimAbortSignal(tenantId: string, turnId: string): Promise<boolean> {
  try {
    return await withTenantScope(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE insights_turn_signals SET consumed_at = NOW()
         WHERE id IN (
           SELECT id FROM insights_turn_signals
           WHERE turn_id = $1 AND signal_kind = 'abort' AND consumed_at IS NULL
           ORDER BY created_at ASC
           LIMIT 1)
         RETURNING id`,
        [turnId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  } catch (err) {
    if (isRelationMissingError(err)) return false;
    log.warn({ tenantId, turnId, err: (err as Error).message }, 'Insights abort-signal claim failed');
    return false;
  }
}

/** Claim the oldest pending mid-run user message for this turn, if any. Same
 *  atomic claim as the abort path, so a message is delivered exactly once. */
export async function claimUserMessageSignal(
  tenantId: string,
  turnId: string,
): Promise<MidRunUserMessage | null> {
  try {
    return await withTenantScope(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE insights_turn_signals SET consumed_at = NOW()
         WHERE id IN (
           SELECT id FROM insights_turn_signals
           WHERE turn_id = $1 AND signal_kind = 'user_message' AND consumed_at IS NULL
           ORDER BY created_at ASC
           LIMIT 1)
         RETURNING payload`,
        [turnId],
      );
      const payload = result.rows[0]?.payload as
        | { text?: string; senderDisplayName?: string | null; senderAccountId?: string | null }
        | undefined;
      if (!payload) return null;
      return {
        text: payload.text ?? '',
        senderDisplayName: payload.senderDisplayName ?? null,
        senderAccountId: payload.senderAccountId ?? null,
      };
    });
  } catch (err) {
    if (isRelationMissingError(err)) return null;
    log.warn(
      { tenantId, turnId, err: (err as Error).message },
      'Insights user-message signal claim failed',
    );
    return null;
  }
}

/** A fresh turn id. Kept here so the router, the lock and the signals all agree
 *  on where turn ids come from. */
export function newTurnId(): string {
  return randomUUID();
}
