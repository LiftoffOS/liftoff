// The Cloud Tasks side of a continuation: a queue of its own.
//
// The MCP chat-run queue (`mcp-chat-runs-{env}`, chat-run-dispatch.ts) is
// `maxAttempts 4`, because a chat run that throws must not be re-delivered
// twenty times, each a paid turn. A continuation is the opposite case: what
// makes it retry is a thread lock that is BUSY (the turn that queued it is
// still finishing, or a person is talking), and that has to be re-delivered
// with backoff until the thread is free. So `chat-continuations-{env}`:
// maxAttempts 20, minBackoff 5s, maxBackoff 60s, maxDoublings 4 (the backoff
// reaches 60s and stays there, about fifteen minutes of attempts),
// maxConcurrentDispatches 20, the same queue service account and run.invoker
// grant as the MCP queue; landed in Liftoff-Infrastructure-GCP before this
// code enqueues to it. Cloud Tasks is at-least-once and named tasks dedup
// re-delivery of the same row.
//
// The queue's retry policy is mirrored here as one constant, because the
// worker has to know when the queue will give up: on the LAST delivery it
// marks the row failed itself rather than re-queueing, so a row can never
// remain queued after the queue has stopped delivering.

import { CloudTasksClient } from '@google-cloud/tasks';
import { log } from '../infrastructure/logging';
import { getBackendUrl } from '../infrastructure/control-plane-url';

/** `maxAttempts` on chat-continuations-{env}, as the infra module sets it. */
export const CONTINUATION_QUEUE_MAX_ATTEMPTS = 20;
/** The task's dispatch deadline: an assistant turn's own bound. */
export const CONTINUATION_DISPATCH_DEADLINE_SECONDS = 600;
/** A small delay before the first delivery, so the usual dispatch lands after
 *  the enqueuing turn has released the thread lock. Never relied on: a
 *  delivery that arrives while the lock is still held is re-queued and
 *  retried by the queue's own backoff. */
export const CONTINUATION_SCHEDULE_DELAY_SECONDS = 5;

/** The header Cloud Tasks sets to the number of times the task has been
 *  retried (0 on the first delivery). */
export const CLOUD_TASKS_RETRY_COUNT_HEADER = 'x-cloudtasks-taskretrycount';

const client = new CloudTasksClient();

const projectId = process.env.GCP_PROJECT_ID || '';
const location = process.env.GCP_LOCATION || 'us-west1';

export function continuationQueuePath(): string {
  return client.queuePath(projectId, location, `chat-continuations-${process.env.ENVIRONMENT || 'dev'}`);
}

/**
 * Create the task for a queued continuation row. Named by the row's id so a
 * duplicate enqueue is a duplicate task, dropped by Cloud Tasks.
 */
export async function enqueueContinuationTask(continuationId: string, tenantId: string): Promise<void> {
  const queuePath = continuationQueuePath();
  const targetUrl = `${getBackendUrl()}/api/internal/mcp-chat-runs/continue`;
  const invokerSa = process.env.MCP_CHAT_RUNS_INVOKER_SA || '';

  const [response] = await client.createTask({
    parent: queuePath,
    task: {
      name: `${queuePath}/tasks/${continuationId}`,
      dispatchDeadline: { seconds: CONTINUATION_DISPATCH_DEADLINE_SECONDS },
      scheduleTime: { seconds: Math.floor(Date.now() / 1000) + CONTINUATION_SCHEDULE_DELAY_SECONDS },
      httpRequest: {
        httpMethod: 'POST' as const,
        url: targetUrl,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ continuationId, tenantId })).toString('base64'),
        ...(invokerSa
          ? { oidcToken: { serviceAccountEmail: invokerSa, audience: getBackendUrl() } }
          : {}),
      },
    },
  });

  log.info({ continuationId, tenantId, taskName: response.name }, 'chat continuation enqueued');
}

/** Whether this delivery is the queue's last: the retry count the header
 *  carries, plus one for this attempt, has reached the queue's maxAttempts.
 *  A missing or unreadable header reads as the first delivery. */
export function isLastDelivery(retryCountHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(retryCountHeader) ? retryCountHeader[0] : retryCountHeader;
  const retryCount = Number(raw);
  if (!Number.isFinite(retryCount) || retryCount < 0) return false;
  return retryCount + 1 >= CONTINUATION_QUEUE_MAX_ATTEMPTS;
}
