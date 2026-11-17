import { logger } from '../infra/logging.js';
import type { CloudTasksClient } from '@google-cloud/tasks';

let tasksClient: CloudTasksClient | null = null;

async function getClient(): Promise<CloudTasksClient> {
  if (!tasksClient) {
    const { CloudTasksClient: Client } = await import('@google-cloud/tasks');
    tasksClient = new Client();
  }
  return tasksClient;
}

export async function enqueueJob(jobId: string): Promise<void> {
  const queue   = process.env.CONNECTOR_TASKS_QUEUE;
  const selfUrl = process.env.CONNECTOR_SERVICE_SELF_URL;

  if (!queue || !selfUrl) {
    // Local dev / missing env: execute in-process synchronously.
    const { executeJobInProcess } = await import('./execute-router.js');
    await executeJobInProcess(jobId);
    return;
  }

  const project  = process.env.GCP_PROJECT_ID!;
  const location = process.env.GCP_REGION ?? 'us-west1';
  const token    = process.env.CONNECTOR_SERVICE_TOKEN!;

  // Cloud Run requires OIDC authentication at the infrastructure layer.
  // K_SERVICE_ACCOUNT is injected by Cloud Run with the running SA email.
  const serviceAccountEmail =
    process.env.K_SERVICE_ACCOUNT ??
    `connector-service-${process.env.ENVIRONMENT ?? 'dev'}@${project}.iam.gserviceaccount.com`;

  const client = await getClient();
  await client.createTask({
    parent: client.queuePath(project, location, queue),
    task: {
      httpRequest: {
        httpMethod: 'POST' as const,
        url: `${selfUrl}/api/connectors/internal/jobs/${jobId}/execute`,
        headers: {
          'X-Service-Auth': token,
          'Content-Type': 'application/json',
        },
        // Cloud Tasks requires a non-empty body for POST tasks.
        body: Buffer.from(JSON.stringify({ jobId })).toString('base64'),
        // Cloud Run rejects requests without a valid OIDC token regardless of
        // application-level auth. The connector-service SA is granted
        // roles/run.invoker on this service so Cloud Tasks can invoke it.
        oidcToken: {
          serviceAccountEmail,
          audience: selfUrl,
        },
      },
    },
  });
  logger.debug({ jobId }, 'job enqueued to Cloud Tasks');
}
