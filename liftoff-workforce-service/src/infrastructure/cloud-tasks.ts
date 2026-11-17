// Cloud Tasks enqueue helper for HRBP fan-out.
//
// Workforce-plan approval enqueues one Cloud Task per spec. Each task carries
// the workforce_plan_id, the spec, and the approver's accountId, and POSTs
// to /api/tasks/hrbp-provision-spec on this same workforce-service Cloud Run
// deployment. The handler verifies the OIDC token before running HRBP.

import { CloudTasksClient } from '@google-cloud/tasks';
import { loadConfig } from './config.js';
import { log } from './logging.js';
import type { WorkforcePlanAgentSpec } from '../workforce-plans/types.js';

// Built on first enqueue, not at import.
//
// A module-scope `new CloudTasksClient()` constructs a gRPC/auth client the
// moment anything in the import graph reaches this file, including processes
// that never enqueue a task.
let client: CloudTasksClient | undefined;
function getClient(): CloudTasksClient {
  client ??= new CloudTasksClient();
  return client;
}

export interface EnqueueHrbpSpecOptions {
  tenantId: string;
  planId: string;
  runId: string;
  spec: WorkforcePlanAgentSpec;
  approverAccountId: string;
}

function getWorkforceServiceUrl(): string {
  return (process.env['WORKFORCE_SERVICE_URL'] ?? '').replace(/\/$/, '');
}

function getWorkforceServiceAccountEmail(): string {
  return process.env['WORKFORCE_SERVICE_ACCOUNT_EMAIL'] ?? '';
}

export interface EnqueueResult {
  /** True only when THIS call created the task. False means a task for this
   *  run and spec already existed, so nothing new was queued. */
  enqueued: boolean;
  taskName: string;
}

export async function enqueueHrbpSpec(opts: EnqueueHrbpSpecOptions): Promise<EnqueueResult> {
  const cfg = loadConfig();
  const queuePath = getClient().queuePath(
    cfg.GCP_PROJECT_ID,
    cfg.GCP_REGION,
    `workforce-hrbp-fanout-${cfg.ENVIRONMENT}`,
  );
  const serviceUrl = getWorkforceServiceUrl();
  const serviceAccount = getWorkforceServiceAccountEmail();
  if (!serviceUrl) throw new Error('WORKFORCE_SERVICE_URL is required for HRBP enqueue');
  if (!serviceAccount) throw new Error('WORKFORCE_SERVICE_ACCOUNT_EMAIL is required for HRBP enqueue');

  // Two different keys, because they answer two different questions.
  //
  // The TASK name identifies this attempt, so it is scoped to the run. Keyed to
  // the spec instead, a later deliberate attempt — a resume, or a re-approval
  // after reopen — rebuilds the previous attempt's name and Cloud Tasks drops
  // it as a duplicate rather than running it. Run-scoping still dedups a spec
  // enqueued twice within one run, which is the idempotency actually wanted.
  //
  // The IDEMPOTENCY key travels to platform-backend's create and is scoped
  // there; see teambuilder-create.ts for why.
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, '-');
  // Cloud Tasks caps a task id at 500 chars; specId comes from the model, so
  // bound it rather than trusting it.
  const specKey = sanitize(opts.spec.specId).slice(0, 120);
  const attemptKey = `${sanitize(opts.runId)}-${specKey}`;
  const idempotencyKey = `hrbp-${sanitize(opts.planId)}-${specKey}`;
  const taskName = `${queuePath}/tasks/hrbp-${attemptKey}`;

  const task = {
    name: taskName,
    dispatchDeadline: { seconds: 270 },
    httpRequest: {
      httpMethod: 'POST' as const,
      url: `${serviceUrl}/api/tasks/hrbp-provision-spec`,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': opts.tenantId,
        'X-Idempotency-Key': idempotencyKey,
      },
      body: Buffer.from(
        JSON.stringify({
          tenantId: opts.tenantId,
          planId: opts.planId,
          runId: opts.runId,
          spec: opts.spec,
          approverAccountId: opts.approverAccountId,
        }),
      ).toString('base64'),
      oidcToken: { serviceAccountEmail: serviceAccount, audience: serviceUrl },
    },
  };

  try {
    const [response] = await getClient().createTask({ parent: queuePath, task });
    log.info(
      { taskName: response.name, planId: opts.planId, specId: opts.spec.specId },
      'Enqueued HRBP spec',
    );
    return { enqueued: true, taskName: response.name ?? taskName };
  } catch (err) {
    // Duplicate task name: this attempt did NOT get queued.
    //
    // Returned as a distinct outcome rather than as the task name, which is
    // what a successful enqueue returns. Callers that cannot tell the two apart
    // count dedup hits as work done and report retries that never happened.
    const message = (err as Error).message ?? '';
    if (message.includes('ALREADY_EXISTS')) {
      log.info(
        { taskName, planId: opts.planId, specId: opts.spec.specId },
        'HRBP spec not enqueued — a task for this run and spec already exists',
      );
      return { enqueued: false, taskName };
    }
    throw err;
  }
}
