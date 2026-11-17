// Maintenance that runs because something happened, not because a clock ticked.
//
// Every /api/internal/* maintenance endpoint used to have its own Cloud
// Scheduler job. Each one woke agent-service at the top of every hour whether
// or not there was anything to do, and an always-allocated instance then billed
// ~15 idle minutes per wake: two thirds of the service's cost was the clock.
//
// Work that has a deadline now arms a Cloud Task for it at the moment the work
// is created, aimed at the SAME endpoint the scheduler called, with the same
// OIDC identity (the scheduler SA, which holds run.invoker on every service in
// the project). Nothing runs when nothing happened. The daily housekeeping pass
// (handlers/housekeeping.ts) re-runs every endpoint once a day as the backstop,
// so an arming that fails costs latency, never the work.
//
// Two shapes:
//   armWatch — "check again soon while something is open". Named by a 10-minute
//     bucket, so a burst of armings (a run's every heartbeat) is one task.
//   armDue   — "run at this instant" (a stored next_poll_at / expiry). Named by
//     the minute it fires.
// A second arming of an existing name is Cloud Tasks refusing a duplicate,
// which is the dedupe working, not a failure.

import { CloudTasksClient } from '@google-cloud/tasks';
import { logger } from './logging';
import { getTenantRuntimeUrl, tenantRuntimeUrlState } from './runtime-env';

export type MaintenanceTarget = 'agent-service' | 'sandbox-executor';

export interface MaintenanceTask {
  /** Endpoint path on the target, e.g. '/api/internal/stalled-run-reconcile'. */
  path: string;
  /** Deterministic task id. Characters outside [A-Za-z0-9_-] are replaced. */
  name: string;
  /** Fire time. Absent = as soon as the queue dispatches it. */
  at?: Date;
  body?: Record<string, unknown>;
  target?: MaintenanceTarget;
}

export type ArmResult = 'enqueued' | 'already-armed' | 'unconfigured';

/** Every endpoint something arms. Kept here, in a module that imports nothing
 *  heavy, so the hot paths that arm and the housekeeping list that backstops
 *  them name the same path without loading each other. The handlers are in handlers/internal-cron-handler.ts
 *  (agent-service) and execution-environments/router.ts (sandbox-executor). */
export const MAINTENANCE_PATHS = {
  stalledRunReconcile: '/api/internal/stalled-run-reconcile',
  computedMetricPoller: '/api/internal/computed-metric-poller',
  gmailWatchRearm: '/api/internal/gmail-watch-rearm',
  memoryDeepScan: '/api/internal/memory-deep-scan-tick',
  billingQueuedReconciliation: '/api/internal/billing-queued-reconciliation',
  skillEmbeddingSweeper: '/api/internal/skill-embedding-sweeper',
  idempotencyReconcile: '/api/internal/idempotency-reconcile',
  webSessionsReap: '/api/internal/web-sessions-reap',
  sandboxGcSweep: '/api/v1/execution-environments/gc-sweep',
} as const;

/** One bucket of a watch. Ten minutes: inside the stalled-run reconciler's own
 *  windows (10 min heartbeat silence, 15 min grace), and coarse enough that a
 *  busy run arms once per bucket rather than once per tool call. */
export const WATCH_BUCKET_MS = 10 * 60 * 1000;

/** Cloud Run's request timeout on both targets. */
const DISPATCH_DEADLINE_SECONDS = 900;

let client: CloudTasksClient | null = null;
function tasksClient(): CloudTasksClient {
  if (!client) client = new CloudTasksClient();
  return client;
}

function targetUrl(target: MaintenanceTarget): string | undefined {
  if (target === 'sandbox-executor') return process.env.SANDBOX_EXECUTOR_URL;
  return tenantRuntimeUrlState() === 'set' ? getTenantRuntimeUrl() : undefined;
}

function safeId(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 400);
}

/** Enqueue one maintenance task. Throws on a Cloud Tasks error other than a
 *  duplicate name; `armMaintenance` is the variant a hot path calls. */
export async function enqueueMaintenanceTask(task: MaintenanceTask): Promise<ArmResult> {
  const tenant = process.env.TENANT_ID;
  const env = process.env.ENVIRONMENT;
  const projectId = process.env.GCP_PROJECT_ID;
  const invoker = process.env.CLOUD_SCHEDULER_SERVICE_ACCOUNT;
  const base = targetUrl(task.target ?? 'agent-service');
  // Local dev and tests: nothing to enqueue to. The daily pass still runs the
  // endpoint wherever it is deployed.
  if (!tenant || !env || !projectId || !invoker || !base) return 'unconfigured';

  const location = process.env.GCP_LOCATION || 'us-west1';
  const c = tasksClient();
  const parent = c.queuePath(projectId, location, `${tenant}-maintenance-tasks-${env}-v2`);
  const audience = new URL(base).origin;

  const request: Record<string, unknown> = {
    name: `${parent}/tasks/${safeId(task.name)}`,
    dispatchDeadline: { seconds: DISPATCH_DEADLINE_SECONDS },
    httpRequest: {
      httpMethod: 'POST',
      url: `${audience}${task.path}`,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(task.body ?? {})).toString('base64'),
      oidcToken: { serviceAccountEmail: invoker, audience },
    },
  };
  if (task.at) {
    const ms = task.at.getTime();
    request.scheduleTime = { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 };
  }

  try {
    await c.createTask({ parent, task: request as never });
    return 'enqueued';
  } catch (err) {
    if ((err as { code?: number }).code === 6) return 'already-armed'; // ALREADY_EXISTS
    throw err;
  }
}

// Names this process has already armed. A run heartbeats on every tool call;
// without this each heartbeat would be a Cloud Tasks round trip that returns
// ALREADY_EXISTS. Bounded so a long-lived instance does not grow it forever.
const armed = new Set<string>();
const ARMED_MEMO_MAX = 1000;

/** Arm a task and never throw. For call sites inside a request or a run, where
 *  a maintenance arming must not cost the caller anything: a failure is a log
 *  line, and the daily pass picks the work up. */
export function armMaintenance(task: MaintenanceTask): void {
  const key = `${task.target ?? 'agent-service'}:${task.name}`;
  if (armed.has(key)) return;
  if (armed.size >= ARMED_MEMO_MAX) armed.clear();
  armed.add(key);
  enqueueMaintenanceTask(task).catch((err: Error) => {
    armed.delete(key);
    logger.warn(
      { err: err.message, task: task.name, path: task.path },
      'Non-fatal: maintenance task not armed; the daily housekeeping pass will cover it',
    );
  });
}

/** "Check again soon": fires at the first bucket boundary at least `delayMs`
 *  from now. Every arming inside the same bucket is the same task. */
export function armWatch(
  kind: string,
  path: string,
  opts: { delayMs: number; target?: MaintenanceTarget; body?: Record<string, unknown> },
): void {
  const bucket = Math.ceil((Date.now() + opts.delayMs) / WATCH_BUCKET_MS);
  armMaintenance({
    path,
    name: `watch-${kind}-${bucket}`,
    at: new Date(bucket * WATCH_BUCKET_MS),
    target: opts.target,
    body: opts.body,
  });
}

/** "Run at this instant": fires at `at`, or after `minDelayMs` when `at` has
 *  already passed (a due time in the past is overdue work, not a reason to fire
 *  in a tight loop). Named by the minute it fires. */
export function armDue(
  kind: string,
  path: string,
  at: Date,
  opts: { minDelayMs?: number; target?: MaintenanceTarget } = {},
): void {
  const earliest = Date.now() + (opts.minDelayMs ?? 30_000);
  const fireAt = Math.max(at.getTime(), earliest);
  const minute = Math.ceil(fireAt / 60_000);
  armMaintenance({
    path,
    name: `due-${kind}-${minute}`,
    at: new Date(minute * 60_000),
    target: opts.target,
  });
}

/** Test seam: forget what this process has armed. */
export function _resetArmedMemo(): void {
  armed.clear();
}
