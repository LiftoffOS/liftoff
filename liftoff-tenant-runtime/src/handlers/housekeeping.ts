// The daily housekeeping pass: the one Cloud Scheduler job this runtime has.
//
// Every maintenance endpoint is listed here and run once a day as its own Cloud
// Task. For work that arms itself (a stall check, a session reap, a metric
// poll) this is the backstop for an arming that was lost; for retention,
// reconcilers and probes it is the cadence. One list, so an endpoint that
// nothing arms and nothing lists is visible as exactly that.
//
// Tasks rather than calls: run inline, two dozen sweeps would share one
// request's 15-minute timeout and one failure would hide the rest. As tasks,
// each gets its own deadline, retries and log line. They are staggered so the
// sweeps do not all contend for the runtime's four pooled connections at once,
// and named by date so a re-run of the pass the same day is a no-op.

import {
  enqueueMaintenanceTask,
  MAINTENANCE_PATHS,
  type MaintenanceTarget,
} from '../infrastructure/maintenance-tasks';
import { logger } from '../infrastructure/logging';

export interface HousekeepingEntry {
  path: string;
  target?: MaintenanceTarget;
  body?: Record<string, unknown>;
  /** UTC day of week (0 = Sunday) the entry runs on; daily when absent. */
  weekday?: number;
}

export const DAILY_HOUSEKEEPING: readonly HousekeepingEntry[] = [
  // Armed when their work appears; listed as the backstop.
  { path: MAINTENANCE_PATHS.stalledRunReconcile },
  { path: MAINTENANCE_PATHS.idempotencyReconcile },
  { path: MAINTENANCE_PATHS.billingQueuedReconciliation },
  { path: MAINTENANCE_PATHS.memoryDeepScan },
  { path: MAINTENANCE_PATHS.skillEmbeddingSweeper },
  { path: MAINTENANCE_PATHS.computedMetricPoller },
  { path: MAINTENANCE_PATHS.gmailWatchRearm },
  { path: MAINTENANCE_PATHS.webSessionsReap },
  { path: MAINTENANCE_PATHS.sandboxGcSweep, target: 'sandbox-executor' },
  // Per-row Cloud Tasks are the primary path; this catches a lost delivery and
  // withdraws approvals whose run already ended.
  { path: '/api/internal/hybrid-loop/sweep-stuck' },
  // Pub/Sub is the primary path for both; these repair drift.
  { path: '/api/agents/reconcile' },
  { path: '/api/internal/model-config-reconciler' },
  // Storage only: a new lock / window on the same key already reclaims an
  // expired one, so these only stop rows accumulating.
  { path: '/api/internal/reap-chat-turn-locks' },
  { path: '/api/internal/reap-mirror-locks' },
  { path: '/api/internal/reactive-window-pruner' },
  { path: '/api/internal/notification-dedup-sweep' },
  // Retention.
  { path: '/api/internal/connector-entity-state-pruner' },
  { path: '/api/internal/hybrid-loop/sweep-signals' },
  { path: '/api/internal/escalation-retention' },
  { path: '/api/internal/dlq-retention' },
  { path: '/api/internal/agent-skills-retention' },
  // Probes, canaries, learning.
  { path: '/api/internal/connector-binding-probe' },
  { path: '/api/internal/connector-tool-smoke', body: { allBuckets: true } },
  { path: '/api/internal/canonical-rebuild-canary' },
  { path: '/api/internal/reflection-outcome-closure' },
  { path: '/api/internal/scheduled-reflection' },
  { path: '/api/internal/performance-snapshot-tick', weekday: 1 },
];

const STAGGER_MS = 30_000;

export interface HousekeepingResult {
  day: string;
  enqueued: number;
  alreadyArmed: number;
  failed: string[];
}

/** Enqueue today's entries. Throws when any failed to enqueue, so the
 *  scheduler job reads the pass as failed and its alert fires. */
export async function enqueueDailyHousekeeping(now: Date = new Date()): Promise<HousekeepingResult> {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const today = DAILY_HOUSEKEEPING.filter((e) => e.weekday === undefined || e.weekday === now.getUTCDay());
  const result: HousekeepingResult = { day, enqueued: 0, alreadyArmed: 0, failed: [] };

  for (const [i, entry] of today.entries()) {
    try {
      const outcome = await enqueueMaintenanceTask({
        path: entry.path,
        name: `hk-${day}-${entry.path}`,
        at: new Date(now.getTime() + i * STAGGER_MS),
        target: entry.target,
        body: entry.body,
      });
      if (outcome === 'enqueued') result.enqueued++;
      else if (outcome === 'already-armed') result.alreadyArmed++;
      else result.failed.push(`${entry.path}: unconfigured`);
    } catch (err) {
      result.failed.push(`${entry.path}: ${(err as Error).message}`);
    }
  }

  logger.info({ ...result }, 'daily housekeeping enqueued');
  if (result.failed.length > 0) {
    throw new Error(`daily housekeeping: ${result.failed.length} entries not enqueued: ${result.failed.join('; ')}`);
  }
  return result;
}
