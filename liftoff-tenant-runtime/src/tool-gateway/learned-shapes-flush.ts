// Getting the process's observations into the table before it exits.
//
// `observeReadShape` accumulates in memory, which is right for the hot path and
// useless on its own: a container restart threw the night's learning away, and
// nothing read it in the meantime. This drains that store to the database on a
// timer, so what one process saw is available to the next one and to whoever
// reviews it.
//
// Drains rather than copies: the counts persisted are taken back out of the
// pending store on success, so each flush carries what THIS interval saw and
// the table's counter adds it up. A copy that never cleared re-wrote the same
// observation every interval and counted it as a new read each time.

import { pendingShapeCountsForTenant, observedEntityTypesForTenant, drainObservedShapes, observedTenants } from './observed-shapes';
import { persistObservedShapes } from './learned-shapes-store';
import { logger } from '../infrastructure/logging';

const FLUSH_MS = 5 * 60_000;
let timer: NodeJS.Timeout | null = null;

/** Write what one tenant has been observed to return since the last flush,
 *  and take it out of the pending counts once it is written. A failed write
 *  leaves the counts where they were, to be carried by the next flush. */
export async function flushObservedShapes(tenantId: string): Promise<number> {
  const pending = pendingShapeCountsForTenant(tenantId);
  if (Object.keys(pending).length === 0) return 0;
  const written = await persistObservedShapes(tenantId, pending, observedEntityTypesForTenant(tenantId));
  if (written > 0) drainObservedShapes(tenantId, pending);
  return written;
}

/** The flush in progress, if one is. ONE at a time: the flush persists a
 *  snapshot of the counts and then drains by that snapshot, so two running at
 *  once — the timer's and shutdown's — would persist the same delta twice and
 *  drain past zero. A caller that finds one running joins it. */
let inFlight: Promise<number> | null = null;

/** Flush every tenant this process has seen. */
export function flushAllObservedShapes(): Promise<number> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let total = 0;
    for (const tenantId of observedTenants()) {
      total += await flushObservedShapes(tenantId);
    }
    return total;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Flush on a timer for the life of the process.
 *
 * `unref` so this never keeps a process alive on its own: a job that has
 * finished its work should exit, and a learning timer is not a reason to hold
 * a container open.
 */
export function startLearnedShapeFlush(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushAllObservedShapes().catch((err: Error) => {
      logger.warn({ err: err.message }, 'learned_shapes_flush_failed');
    });
  }, FLUSH_MS);
  timer.unref?.();
}

/**
 * Stop the timer and flush once more, bounded, for shutdown.
 *
 * A deploy, a scale-down or a restart used to discard up to an interval of
 * observations — which biases the counter and loses a low-volume shape every
 * time. Called once intake has stopped. A flush already in progress is
 * waited for rather than raced, and then a SECOND pass runs: the first took
 * its snapshot before it started, and an observation that arrived after that
 * snapshot is pending still. Joining alone left it behind.
 */
/** What the final flush came to. Three outcomes, named, because a bound that
 *  expired and a store that refused are not counts and must not read as one:
 *  a `-1` reported through the same line as a count was an informational
 *  entry for the one case that deserved a warning. */
export type FinalFlushOutcome =
  | { outcome: 'flushed'; written: number }
  | { outcome: 'timed_out'; boundMs: number }
  | { outcome: 'failed'; error: string };

export async function stopLearnedShapeFlush(boundMs = 5_000): Promise<FinalFlushOutcome> {
  if (timer) { clearInterval(timer); timer = null; }
  let bound: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { bound = setTimeout(() => resolve('timeout'), boundMs); });
  try {
    const inProgress = inFlight;
    if (inProgress) {
      const joined = await Promise.race([inProgress.then(() => 'done' as const), timeout]);
      if (joined === 'timeout') return timedOut(boundMs);
    }
    const final = await Promise.race([flushAllObservedShapes(), timeout]);
    if (final === 'timeout') return timedOut(boundMs);
    if (final > 0) logger.info({ written: final }, 'learned_shapes_final_flush');
    return { outcome: 'flushed', written: final };
  } catch (err) {
    const error = (err as Error).message;
    logger.warn({ err: error }, 'learned_shapes_final_flush_failed');
    return { outcome: 'failed', error };
  } finally {
    if (bound) clearTimeout(bound);
  }
}

/** Reported here, where the bound is known: what was pending at exit may not
 *  have been written, and the next process cannot tell. */
function timedOut(boundMs: number): FinalFlushOutcome {
  logger.warn({ boundMs }, 'learned_shapes_final_flush_timed_out: pending observations may be lost');
  return { outcome: 'timed_out', boundMs };
}

/** Test helper — stops the timer and forgets a flush in flight. NOT for
 *  production use. */
export function _stopLearnedShapeFlushForTesting(): void {
  if (timer) { clearInterval(timer); timer = null; }
  inFlight = null;
}
