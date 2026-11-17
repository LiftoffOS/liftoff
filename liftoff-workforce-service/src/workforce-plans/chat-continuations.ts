// The Chief AI Officer's continuations: work a bound closed with more to do,
// kept (migration 029) until a task runs it on the same thread as a further
// turn. The same rows, states and handoff as platform-backend's
// chat-continuations (its migration 514) — every statement bound to one row
// and one status, so the task handler reads as a sequence of atomic claims:
//
//   queued  --claim-->  claimed  --turn free, recheck-->  running  -->  done | failed
//     ^                    |
//     +---- requeue -------+   (the thread had a live turn; the queue retries)
//
// and a person's new message cancels a row in `queued` OR `claimed`: a claim
// is not the turn, and the handler that claimed a row learns of the
// cancellation at its recheck, after it has claimed the turn, before it
// runs anything.

import { CloudTasksClient } from '@google-cloud/tasks';
import { loadConfig } from '../infrastructure/config.js';
import { withTenantContext } from '../infrastructure/rls.js';
import { log } from '../infrastructure/logging.js';

export type ContinuationStatus = 'queued' | 'claimed' | 'running' | 'done' | 'cancelled' | 'failed';

/** The most continuations one person message may start. At the cap the
 *  loop closes with the reply saying what remains and that the person can
 *  ask it to go on; nothing further is queued. */
export const MAX_CONTINUATIONS_PER_MESSAGE = 5;
/** `maxAttempts` on workforce-chat-continuations-{env}, as the infra module
 *  sets it. The handler marks the row failed on the last delivery itself, so
 *  a row can never remain queued after the queue has given up. */
export const CONTINUATION_QUEUE_MAX_ATTEMPTS = 20;
/** The task's dispatch deadline: a Chief AI Officer turn's own bound. */
export const CONTINUATION_DISPATCH_DEADLINE_SECONDS = 600;
/** A small delay before the first delivery, so the usual dispatch lands after
 *  the enqueuing turn has released its claim. Never relied on. */
export const CONTINUATION_SCHEDULE_DELAY_SECONDS = 5;
/** The header Cloud Tasks sets to the number of times the task has been
 *  retried (0 on the first delivery). */
export const CLOUD_TASKS_RETRY_COUNT_HEADER = 'x-cloudtasks-taskretrycount';

export interface ContinuationRow {
  id: string;
  tenantId: string;
  threadId: string;
  accountId: string;
  originMessageId: string;
  ordinal: number;
  reason: string;
  status: ContinuationStatus;
  workerId: string | null;
}

interface Row {
  id: string;
  tenant_id: string;
  thread_id: string;
  account_id: string;
  origin_message_id: string;
  ordinal: number;
  reason: string;
  status: ContinuationStatus;
  worker_id: string | null;
}

const COLUMNS = 'id, tenant_id, thread_id, account_id, origin_message_id, ordinal, reason, status, worker_id';

function toRow(r: Row): ContinuationRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    threadId: r.thread_id,
    accountId: r.account_id,
    originMessageId: r.origin_message_id,
    ordinal: Number(r.ordinal),
    reason: r.reason,
    status: r.status,
    workerId: r.worker_id,
  };
}

// ── The rows ────────────────────────────────────────────────────────────

/** Insert the next continuation for a person's message as `queued`, with the
 *  ordinal after the last one for that message. Null at the cap. */
export async function enqueueContinuation(input: {
  tenantId: string;
  threadId: string;
  accountId: string;
  originMessageId: string;
  reason: string;
}): Promise<ContinuationRow | null> {
  return withTenantContext(input.tenantId, async (client) => {
    const prior = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM chat_continuations WHERE tenant_id = $1 AND origin_message_id = $2`,
      [input.tenantId, input.originMessageId],
    );
    const ordinal = Number(prior.rows[0]?.n ?? 0) + 1;
    if (ordinal > MAX_CONTINUATIONS_PER_MESSAGE) {
      log.info(
        { tenantId: input.tenantId, threadId: input.threadId, originMessageId: input.originMessageId, ordinal },
        'CAIO continuation not queued: the cap for this message is reached',
      );
      return null;
    }
    const r = await client.query<Row>(
      `INSERT INTO chat_continuations (tenant_id, thread_id, account_id, origin_message_id, ordinal, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued')
       RETURNING ${COLUMNS}`,
      [input.tenantId, input.threadId, input.accountId, input.originMessageId, ordinal, input.reason],
    );
    return toRow(r.rows[0]);
  });
}

/** CLAIM: `queued` → `claimed` under this worker, or null. */
export async function claimContinuation(tenantId: string, id: string, workerId: string): Promise<ContinuationRow | null> {
  const r = await withTenantContext(tenantId, (client) => client.query<Row>(
    `UPDATE chat_continuations
        SET status = 'claimed', claimed_at = NOW(), worker_id = $3
      WHERE tenant_id = $1 AND id = $2 AND status = 'queued'
      RETURNING ${COLUMNS}`,
    [tenantId, id, workerId],
  ));
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

/** The thread had a live turn: `claimed` → back to `queued`. */
export async function requeueContinuation(tenantId: string, id: string, workerId: string): Promise<boolean> {
  const r = await withTenantContext(tenantId, (client) => client.query(
    `UPDATE chat_continuations
        SET status = 'queued', claimed_at = NULL, worker_id = NULL
      WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND worker_id = $3`,
    [tenantId, id, workerId],
  ));
  return (r.rowCount ?? 0) > 0;
}

/** RECHECK: the row as this worker claimed it, or null. */
export async function recheckClaimedContinuation(tenantId: string, id: string, workerId: string): Promise<ContinuationRow | null> {
  const r = await withTenantContext(tenantId, (client) => client.query<Row>(
    `SELECT ${COLUMNS} FROM chat_continuations
      WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND worker_id = $3`,
    [tenantId, id, workerId],
  ));
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

/** `claimed` → `running`, by the worker that claimed it. */
export async function markContinuationRunning(tenantId: string, id: string, workerId: string): Promise<boolean> {
  const r = await withTenantContext(tenantId, (client) => client.query(
    `UPDATE chat_continuations SET status = 'running'
      WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND worker_id = $3`,
    [tenantId, id, workerId],
  ));
  return (r.rowCount ?? 0) > 0;
}

/** A terminal state for a row this worker holds; the reason goes to the log. */
export async function finishContinuation(
  tenantId: string,
  id: string,
  workerId: string,
  status: 'done' | 'cancelled' | 'failed',
  reason: string,
): Promise<void> {
  await withTenantContext(tenantId, (client) => client.query(
    `UPDATE chat_continuations SET status = $4, finished_at = NOW()
      WHERE tenant_id = $1 AND id = $2 AND worker_id = $3 AND status IN ('claimed', 'running')`,
    [tenantId, id, workerId, status],
  ));
  log.info({ tenantId, continuationId: id, workerId, status, reason }, 'CAIO continuation finished');
}

/** A person's new message on the thread cancels every continuation still
 *  waiting for it: `queued`, and `claimed` too. A `running` one holds the
 *  turn; the message reaches it as a mid-run message. Never throws. */
export async function cancelThreadContinuations(tenantId: string, threadId: string): Promise<number> {
  try {
    const r = await withTenantContext(tenantId, (client) => client.query(
      `UPDATE chat_continuations SET status = 'cancelled', finished_at = NOW()
        WHERE tenant_id = $1 AND thread_id = $2 AND status IN ('queued', 'claimed')`,
      [tenantId, threadId],
    ));
    const n = r.rowCount ?? 0;
    if (n > 0) log.info({ tenantId, threadId, cancelled: n }, 'CAIO continuations cancelled by a new person message');
    return n;
  } catch (err) {
    log.warn({ tenantId, threadId, error: (err as Error).message }, 'CAIO: could not cancel the thread\'s continuations');
    return 0;
  }
}

/** The thread's live continuation, for the status a person is shown. */
export async function threadContinuationStatus(
  tenantId: string,
  threadId: string,
): Promise<'queued' | 'claimed' | 'running' | null> {
  try {
    const r = await withTenantContext(tenantId, (client) => client.query<{ status: 'queued' | 'claimed' | 'running' }>(
      `SELECT status FROM chat_continuations
        WHERE tenant_id = $1 AND thread_id = $2 AND status IN ('queued', 'claimed', 'running')
        ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END
        LIMIT 1`,
      [tenantId, threadId],
    ));
    return r.rows[0]?.status ?? null;
  } catch (err) {
    log.warn({ tenantId, threadId, error: (err as Error).message }, 'CAIO: could not read the thread\'s continuation state');
    return null;
  }
}

/** Whether the thread has a person's message newer than the origin: the
 *  supersession test the handler runs after claiming the turn. */
export async function hasNewerPersonMessage(tenantId: string, threadId: string, originMessageId: string): Promise<boolean> {
  const r = await withTenantContext(tenantId, (client) => client.query<{ newer: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM team_plan_messages m
        WHERE m.thread_id = $1 AND m.role = 'user'
          AND m.created_at > (SELECT o.created_at FROM team_plan_messages o WHERE o.id = $2)
     ) AS newer`,
    [threadId, originMessageId],
  ));
  return r.rows[0]?.newer === true;
}

// ── The task ────────────────────────────────────────────────────────────

let tasksClient: CloudTasksClient | undefined;
function getTasksClient(): CloudTasksClient {
  tasksClient ??= new CloudTasksClient();
  return tasksClient;
}

/** Create the task for a queued row on workforce-chat-continuations-{env},
 *  named by the row, delivered OIDC-signed as the workforce SA (as the HRBP
 *  fan-out is) to this service's /api/tasks/chat-continuation. */
export async function enqueueContinuationTask(continuationId: string, tenantId: string): Promise<void> {
  const cfg = loadConfig();
  const queuePath = getTasksClient().queuePath(cfg.GCP_PROJECT_ID, cfg.GCP_REGION, `workforce-chat-continuations-${cfg.ENVIRONMENT}`);
  const serviceUrl = (process.env['WORKFORCE_SERVICE_URL'] ?? '').replace(/\/$/, '');
  const serviceAccount = process.env['WORKFORCE_SERVICE_ACCOUNT_EMAIL'] ?? '';
  if (!serviceUrl) throw new Error('WORKFORCE_SERVICE_URL is required to enqueue a continuation');
  if (!serviceAccount) throw new Error('WORKFORCE_SERVICE_ACCOUNT_EMAIL is required to enqueue a continuation');

  const [response] = await getTasksClient().createTask({
    parent: queuePath,
    task: {
      name: `${queuePath}/tasks/${continuationId}`,
      dispatchDeadline: { seconds: CONTINUATION_DISPATCH_DEADLINE_SECONDS },
      scheduleTime: { seconds: Math.floor(Date.now() / 1000) + CONTINUATION_SCHEDULE_DELAY_SECONDS },
      httpRequest: {
        httpMethod: 'POST' as const,
        url: `${serviceUrl}/api/tasks/chat-continuation`,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ continuationId, tenantId })).toString('base64'),
        oidcToken: { serviceAccountEmail: serviceAccount, audience: serviceUrl },
      },
    },
  });
  log.info({ continuationId, tenantId, taskName: response.name }, 'CAIO continuation enqueued');
}

/** Whether this delivery is the queue's last. */
export function isLastDelivery(retryCountHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(retryCountHeader) ? retryCountHeader[0] : retryCountHeader;
  const retryCount = Number(raw);
  if (!Number.isFinite(retryCount) || retryCount < 0) return false;
  return retryCount + 1 >= CONTINUATION_QUEUE_MAX_ATTEMPTS;
}
