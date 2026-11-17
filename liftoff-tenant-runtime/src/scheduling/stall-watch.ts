// When the stalled-run reconciler looks at a run.
//
// Its own module, importing nothing but the task helper, because it is called
// from the two hottest writers in the runtime (createInvocation and the run
// heartbeat) and the reconciler itself imports half the execution engine.

import { armWatch, MAINTENANCE_PATHS } from '../infrastructure/maintenance-tasks';

/** Fifteen minutes is the reconciler's GRACE: the first moment an autonomous
 *  run can be swept. The bucket boundary adds up to ten more. */
const STALL_WATCH_DELAY_MS = 15 * 60 * 1000;

/**
 * Arm a stall check for a run that just started or just heartbeat.
 *
 * Called from both, so the check that finally fires is the one armed by the
 * LAST heartbeat: a run that stops making progress is looked at one grace
 * window later, and a healthy one keeps pushing its check forward. The sweep
 * re-arms while a run it could still close is open (hasOpenSweepableRuns),
 * which covers the human thresholds that are longer than one window.
 *
 * Off while the reconciler is off: a check of a sweep that does nothing is a
 * wake for nothing.
 */
export function armStallWatch(): void {
  if (process.env.STALLED_RUN_RECONCILER_ENABLED !== '1') return;
  armWatch('stalled-run', MAINTENANCE_PATHS.stalledRunReconcile, { delayMs: STALL_WATCH_DELAY_MS });
}
