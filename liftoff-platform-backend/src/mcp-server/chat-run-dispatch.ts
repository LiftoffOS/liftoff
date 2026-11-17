// MCP chat-run Cloud Tasks dispatch (plan v6.1 Phase 5b)
//
// Enqueues the durable chat-run worker task into the SAME-project queue
// `mcp-chat-runs-{env}` (infra Phase 0: dispatchDeadline 600s, maxAttempts 4,
// minBackoff 5s, maxBackoff 60s, maxConcurrentDispatches 20; the queue SA has
// run.invoker on platform-backend itself). Task name = chatRunId — Cloud
// Tasks is at-least-once and named tasks dedup redelivery of the same run.
//
// Why a queue at all: live services run with cpu-throttling:'true', so
// post-response compute is not guaranteed — the worker executes inside its
// OWN request and therefore always has CPU.

import { CloudTasksClient } from '@google-cloud/tasks';
import { log } from '../infrastructure/logging';
import { getBackendUrl } from '../infrastructure/control-plane-url';

const client = new CloudTasksClient();

const projectId = process.env.GCP_PROJECT_ID || '';
const location = process.env.GCP_LOCATION || 'us-west1';

export async function enqueueChatRunTask(chatRunId: string, tenantId: string): Promise<void> {
  const queuePath = client.queuePath(
    projectId,
    location,
    `mcp-chat-runs-${process.env.ENVIRONMENT || 'dev'}`,
  );
  const targetUrl = `${getBackendUrl()}/api/internal/mcp-chat-runs/execute`;
  const invokerSa = process.env.MCP_CHAT_RUNS_INVOKER_SA || '';

  const [response] = await client.createTask({
    parent: queuePath,
    task: {
      name: `${queuePath}/tasks/${chatRunId}`,
      // Plan: dispatchDeadline 600s for this queue's tasks (worker turn is
      // bounded by the TR stream's 5-min abort + persistence overhead).
      dispatchDeadline: { seconds: 600 },
      httpRequest: {
        httpMethod: 'POST' as const,
        url: targetUrl,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ chatRunId, tenantId })).toString('base64'),
        ...(invokerSa
          ? { oidcToken: { serviceAccountEmail: invokerSa, audience: getBackendUrl() } }
          : {}),
      },
    },
  });

  log.info({ chatRunId, tenantId, taskName: response.name }, 'mcp chat run enqueued');
}
