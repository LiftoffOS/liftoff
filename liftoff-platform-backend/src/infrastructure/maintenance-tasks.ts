// Maintenance that runs because something happened, not because a clock ticked.
//
// Each internal job used to have its own Cloud Scheduler entry and fire every
// hour whether or not there was work, and several of them called into each
// tenant runtime, which woke an always-allocated agent-service every hour for
// ~15 billed idle minutes. Work that has a deadline now arms a Cloud Task for
// it when the work appears, aimed at the SAME endpoint the
// scheduler fired, carrying the SAME identity: the cloud-scheduler SA's OIDC
// token (what requireSchedulerOidc checks) plus the X-Service-Auth header the
// route's shared-secret check expects. Routes only: a Cloud Run job run from
// Cloud Tasks is refused by the project's VPC-SC perimeter (housekeeping.ts). The
// daily housekeeping pass (jobs/housekeeping.ts) runs everything once a day as
// the backstop, so a lost arming costs latency, never the work.
//
// armWatch names a task by 10-minute bucket and armDue by minute: a burst of
// armings is one task, and a duplicate name is Cloud Tasks refusing a second
// copy, which is the dedupe working.

import { CloudTasksClient } from '@google-cloud/tasks';
import { log } from './logging';
import { getBackendUrlOrNull } from './control-plane-url';

/** Which shared secret the route's own check expects, besides the OIDC token
 *  every task carries. */
export type MaintenanceAuth = 'callback' | 'tunnel' | 'oidc';

export interface MaintenanceTask {
  /** Deterministic task id. Characters outside [A-Za-z0-9_-] are replaced. */
  name: string;
  /** A platform-backend route, e.g. '/api/internal/x402-reload'. */
  path: string;
  auth?: MaintenanceAuth;
  at?: Date;
  body?: Record<string, unknown>;
}

export type ArmResult = 'enqueued' | 'already-armed' | 'unconfigured';

export const WATCH_BUCKET_MS = 10 * 60 * 1000;

/** Cloud Run's request timeout on platform-backend. */
const DISPATCH_DEADLINE_SECONDS = 900;

let client: CloudTasksClient | null = null;
function tasksClient(): CloudTasksClient {
  if (!client) client = new CloudTasksClient();
  return client;
}

function safeId(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 400);
}

function secretFor(auth: MaintenanceAuth): string | undefined {
  if (auth === 'callback') return process.env.PLATFORM_CALLBACK_TOKEN;
  if (auth === 'tunnel') return process.env.TUNNEL_SERVICE_TOKEN;
  return undefined;
}

/** Enqueue one task. Throws on a Cloud Tasks error other than a duplicate
 *  name; `armMaintenance` is the variant a request path calls. */
export async function enqueueMaintenanceTask(task: MaintenanceTask): Promise<ArmResult> {
  const projectId = process.env.GCP_PROJECT_ID;
  const env = process.env.ENVIRONMENT;
  const invoker = process.env.CLOUD_SCHEDULER_SA_EMAIL;
  const backend = getBackendUrlOrNull();
  if (!projectId || !env || !invoker || !backend) return 'unconfigured';

  const location = process.env.GCP_LOCATION || 'us-west1';
  const c = tasksClient();
  const parent = c.queuePath(projectId, location, `maintenance-tasks-${env}`);

  const secret = secretFor(task.auth ?? 'callback');
  const httpRequest = {
    httpMethod: 'POST',
    url: `${backend}${task.path}`,
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Service-Auth': secret } : {}) },
    body: Buffer.from(JSON.stringify(task.body ?? {})).toString('base64'),
    oidcToken: { serviceAccountEmail: invoker, audience: backend },
  };

  const request: Record<string, unknown> = {
    name: `${parent}/tasks/${safeId(task.name)}`,
    dispatchDeadline: { seconds: DISPATCH_DEADLINE_SECONDS },
    httpRequest,
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

const armed = new Set<string>();
const ARMED_MEMO_MAX = 1000;

/** Arm a task and never throw: a failure is a log line, and the daily pass
 *  picks the work up. One round trip per name per process. */
export function armMaintenance(task: MaintenanceTask): void {
  if (armed.has(task.name)) return;
  if (armed.size >= ARMED_MEMO_MAX) armed.clear();
  armed.add(task.name);
  enqueueMaintenanceTask(task).catch((err: Error) => {
    armed.delete(task.name);
    log.warn(
      { err: err.message, task: task.name, path: task.path },
      'Non-fatal: maintenance task not armed; the daily housekeeping pass will cover it',
    );
  });
}

/** "Check again soon": fires at the first bucket boundary at least `delayMs`
 *  from now; every arming inside the same bucket is the same task. */
export function armWatch(
  kind: string,
  target: { path: string; auth?: MaintenanceAuth; body?: Record<string, unknown> },
  delayMs: number,
): void {
  const bucket = Math.ceil((Date.now() + delayMs) / WATCH_BUCKET_MS);
  armMaintenance({ ...target, name: `watch-${kind}-${bucket}`, at: new Date(bucket * WATCH_BUCKET_MS) });
}

/** "Run at this instant": at `at`, or after `minDelayMs` when `at` has passed.
 *  Named by the minute it fires. */
export function armDue(
  kind: string,
  target: { path: string; auth?: MaintenanceAuth },
  at: Date,
  minDelayMs = 30_000,
): void {
  const fireAt = Math.max(at.getTime(), Date.now() + minDelayMs);
  const minute = Math.ceil(fireAt / 60_000);
  armMaintenance({ ...target, name: `due-${kind}-${minute}`, at: new Date(minute * 60_000) });
}

/** Test seam: forget what this process has armed. */
export function _resetArmedMemo(): void {
  armed.clear();
}
