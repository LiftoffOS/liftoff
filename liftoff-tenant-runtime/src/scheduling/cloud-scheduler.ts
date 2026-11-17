// Cloud Scheduler Service
// Per implementation plan Phase 2.1: Dynamic scheduler job management for agent execution
// Ported from colab-prototype's apps/api/src/utils/scheduler.ts

import { CloudSchedulerClient, protos } from '@google-cloud/scheduler';
import { logger } from '../infrastructure/logging';
import { getTenantRuntimeUrl, tenantRuntimeUrlState } from '../infrastructure/runtime-env';
import { usageLedgerService } from '../usage-ledger/service';
import { getJobName } from './job-name';

const client = new CloudSchedulerClient();

const projectId = process.env.GCP_PROJECT_ID || '';
const location = process.env.GCP_LOCATION || 'us-west1';

// Feature flag: route through Cloud Tasks for durable execution
function getSchedulerTarget(): string {
  return process.env.USE_CLOUD_TASKS_EXECUTION === 'true'
    ? '/api/execution/scheduled-enqueue'
    : '/api/execution/scheduled-invoke';
}

export interface CreateJobOptions {
  tenantId: string;
  agentId: string;
  cronExpr: string;
  apiBaseUrl: string;
  timezone?: string;
  description?: string;
  /** Optional suffix appended to the job name (e.g. '-companion-weekly-summary'). */
  jobSuffix?: string;
  /** Optional granular label baked into the POST body as triggeredByLabel.
   *  triggeredBy stays 'cron' to satisfy invocations CHECK constraint. */
  triggeredByLabel?: string;
  /** WS-9.5 — tenant flag set; carries `companion_cron_high_frequency_enabled`
   *  when the tenant has been granted exception to the 5-min floor. */
  tenantFlags?: Set<string>;
}

// Job naming lives in ./job-name so consumers that only need the string (e.g.
// the /internal/agents/resolve operator endpoint) don't have to import this
// module and construct a CloudSchedulerClient. Re-exported for callers already
// importing it from here.
export { getJobName } from './job-name';

// Get full job path for Cloud Scheduler API
function getJobPath(tenantId: string, agentId: string, suffix = ''): string {
  const jobName = getJobName(tenantId, agentId, suffix);
  return client.jobPath(projectId, location, jobName);
}

// WS-9.5 — scheduler cadence floor. Applies to EVERY agent scheduler job, not
// only companion crons: the check runs inside createOrUnpauseJob below, which
// canonical-reconciler calls for the primary trigger as well.
//
// Calling it a "companion-cron safety floor" misleads: someone tracing why an
// agent's stored `*/1 * * * *` never seems to run can conclude the floor cannot
// apply to a primary trigger and search elsewhere, reaching a wrong conclusion
// about a mechanism that is working exactly as written.
//
// It refuses rather than clamps. A cadence below the floor throws, so the job is
// never created and the agent gets NO schedule at all — which is why a producer
// emitting `*/1` does not get a fast agent, it gets a silent one. The distiller
// is told about this floor for that reason (see its cadence rule).
const MIN_CADENCE_SECONDS = 300; // 5 minutes
const HIGH_FREQUENCY_FLAG = 'companion_cron_high_frequency_enabled';

function estimateMinIntervalFromCron(cronExpr: string): number {
  // Coarse estimator for the common cases the reconciler emits.
  // `*/N * * * *` → N minutes. `0 */N * * *` → N hours.
  // Anything else falls back to 'unknown high cadence' and we accept it.
  const everyMin = /^\*\/(\d+) \* \* \* \*$/.exec(cronExpr.trim());
  if (everyMin) return Number(everyMin[1]) * 60;
  const everyHour = /^0 \*\/(\d+) \* \* \*$/.exec(cronExpr.trim());
  if (everyHour) return Number(everyHour[1]) * 3600;
  return MIN_CADENCE_SECONDS;
}

export function assertCadenceAtOrAboveFloor(cronExpr: string, tenantFlags: Set<string>): void {
  if (tenantFlags.has(HIGH_FREQUENCY_FLAG)) return;
  const minIntervalSec = estimateMinIntervalFromCron(cronExpr);
  if (minIntervalSec < MIN_CADENCE_SECONDS) {
    throw new Error(
      `Cron cadence ${cronExpr} (≈${minIntervalSec}s) is below the platform floor ` +
      `(${MIN_CADENCE_SECONDS}s). Set tenant flag '${HIGH_FREQUENCY_FLAG}' to override.`,
    );
  }
}

// Create or unpause a scheduler job for an agent
export async function createOrUnpauseJob(opts: CreateJobOptions): Promise<string> {
  // Hard-fail rather than letting Cloud Scheduler reject the half-built URL with
  // "HttpRequest.url must start with 'https://'". An empty apiBaseUrl here means
  // TENANT_RUNTIME_URL was unset on this service — the resulting nack would clog
  // control-plane-events-${env}-coordinator-sub indefinitely.
  if (!opts.apiBaseUrl) {
    throw new Error(
      'createOrUnpauseJob: apiBaseUrl is empty — TENANT_RUNTIME_URL must be set on this service. ' +
      'See cloudbuild.yaml step `wire-peer-urls`.',
    );
  }

  // WS-9.5 — reject below-floor cadences at the API boundary.
  assertCadenceAtOrAboveFloor(opts.cronExpr, opts.tenantFlags ?? new Set());

  const suffix = opts.jobSuffix || '';
  const jobPath = getJobPath(opts.tenantId, opts.agentId, suffix);
  const jobName = getJobName(opts.tenantId, opts.agentId, suffix);

  const serviceAccountEmail = process.env.CLOUD_SCHEDULER_SERVICE_ACCOUNT ||
    `${projectId}@appspot.gserviceaccount.com`;
  const targetUri = `${opts.apiBaseUrl}${getSchedulerTarget()}`;

  const bodyPayload: Record<string, unknown> = {
    tenantId: opts.tenantId,
    agentId: opts.agentId,
    // Must be one of the values accepted by invocations.triggered_by_check:
    // 'human' | 'agent' | 'cron' | 'event' (see migration 015). 'scheduler'
    // was rejected with code 23514, killing every Cloud-Tasks-routed
    // execution before it ran a single tool call.
    triggeredBy: 'cron',
  };
  if (opts.triggeredByLabel) {
    bodyPayload.triggeredByLabel = opts.triggeredByLabel;
  }

  const desiredJob: protos.google.cloud.scheduler.v1.IJob = {
    name: jobPath,
    description: opts.description || `Scheduled execution for agent ${opts.agentId}`,
    schedule: opts.cronExpr,
    timeZone: opts.timezone || 'UTC',
    httpTarget: {
      uri: targetUri,
      httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(bodyPayload)).toString('base64'),
      oidcToken: {
        serviceAccountEmail,
        audience: opts.apiBaseUrl,
      },
    },
    retryConfig: {
      retryCount: 3,
      minBackoffDuration: { seconds: 5 },
      maxBackoffDuration: { seconds: 300 },
      maxDoublings: 3,
    },
  };

  // Step 1: Check if job exists
  let existingJob: protos.google.cloud.scheduler.v1.IJob | null = null;
  try {
    const [job] = await client.getJob({ name: jobPath });
    existingJob = job;
  } catch (error: any) {
    if (error.code !== 5) throw error; // 5 = NOT_FOUND, anything else is a real error
  }

  if (existingJob) {
    // Step 2a: Resume if paused
    if (existingJob.state === 'PAUSED') {
      try {
        await client.resumeJob({ name: jobPath });
        logger.info('Resumed Cloud Scheduler job', { job_name: jobName });
      } catch (resumeError: any) {
        logger.error('Failed to resume Cloud Scheduler job', {
          job_name: jobName, error: resumeError.message,
        });
        throw resumeError;
      }
    }

    // Step 2b: Update schedule and URI
    try {
      await client.updateJob({ job: desiredJob });
      logger.info('Updated Cloud Scheduler job', {
        job_name: jobName, schedule: opts.cronExpr, uri: targetUri,
      });
    } catch (updateError: any) {
      logger.error('Failed to update Cloud Scheduler job', {
        job_name: jobName, error: updateError.message,
      });
      throw updateError;
    }

    return jobPath;
  }

  // Step 2 (no existing job): Create new
  const parent = client.locationPath(projectId, location);
  const [createdJob] = await client.createJob({ parent, job: desiredJob });

  logger.info('Created Cloud Scheduler job', {
    job_name: jobName, tenant_id: opts.tenantId, schedule: opts.cronExpr,
  });

  // Track Cloud Scheduler job creation for cost attribution ($0.10/job/month)
  { const { randomUUID } = require('crypto') as typeof import('crypto');
    usageLedgerService.recordUsage({
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      workflowId: null,
      actionId: randomUUID(),
      eventType: 'cloud_scheduler_job_created',
      credits: 0,
      metadata: { jobName, cronExpr: opts.cronExpr },
    }).catch((err: Error) => logger.warn({ err: err.message }, 'Non-fatal: cloud_scheduler_job_created tracking failed'));
  }

  return createdJob.name || jobPath;
}

// Pause a scheduler job for an agent
// Resume a paused scheduler job. Used on agent activation as a fast path
// (one or two API calls) instead of the full createOrUnpauseJob (three API
// calls). createOrUnpauseJob() is only needed for first-time job creation
// during distillation.
//
// Self-healing migration: as part of the resume, we check whether the
// existing job's httpTarget matches what we'd write today (URI + body),
// and patch any stale fields inline. This handles two distinct migrations:
//
//   1. URI migration when USE_CLOUD_TASKS_EXECUTION was flipped after the
//      job was created — old jobs point at /scheduled-invoke, new code
//      wants /scheduled-enqueue.
//   2. Body migration when the body's `triggeredBy` value was changed
//      from 'scheduler' to 'cron' to satisfy the invocations CHECK
//      constraint — old jobs have the rejected literal baked in.
//
// A single pause+resume cycle migrates an existing job to the new endpoint
// AND the new body without requiring a separate backfill script.
//
// NOT_FOUND (error.code === 5) is propagated so the caller can fall back
// to create.
export async function resumeJob(
  tenantId: string,
  agentId: string,
  suffix = '',
  desiredBodyExtras?: { triggeredByLabel?: string },
): Promise<void> {
  const jobPath = getJobPath(tenantId, agentId, suffix);
  const jobName = getJobName(tenantId, agentId, suffix);

  // Fetch the existing job so we can compare its httpTarget to the desired one.
  const [existingJob] = await client.getJob({ name: jobPath });

  // Compute desired httpTarget fields. getTenantRuntimeUrl() throws if the env
  // is unset — message will nack, surface in coordinator logs + DLQ alerting.
  const apiBaseUrl = getTenantRuntimeUrl();
  const desiredUri = `${apiBaseUrl}${getSchedulerTarget()}`;
  const desiredBodyObj: Record<string, unknown> = {
    tenantId,
    agentId,
    triggeredBy: 'cron',
  };
  if (desiredBodyExtras?.triggeredByLabel) {
    desiredBodyObj.triggeredByLabel = desiredBodyExtras.triggeredByLabel;
  }
  const desiredBody = Buffer.from(JSON.stringify(desiredBodyObj)).toString('base64');

  const currentUri = existingJob.httpTarget?.uri || '';
  const currentBody = existingJob.httpTarget?.body
    ? Buffer.from(existingJob.httpTarget.body as Uint8Array).toString('base64')
    : '';

  // The OIDC audience must track the service URL. Cloud Run validates the token's
  // audience against the RECEIVING service, so a token minted for the old URL is
  // rejected 401 UNAUTHENTICATED no matter how correct the URI is.
  //
  // This is migration #3. Splitting the tenant-runtime monolith into
  // agent-service/coordinator-service repoints the URI, and the block below
  // deliberately preserves `oidcToken` (see the re-spread comment), so without
  // this the audience keeps naming the old service and the job fires every
  // minute into a 401. A job created after the split carries the correct
  // audience; only the drift path needs this.
  const currentAudience = existingJob.httpTarget?.oidcToken?.audience || '';
  const audienceStale = currentAudience !== apiBaseUrl;

  const uriStale = currentUri !== desiredUri;
  const bodyStale = currentBody !== desiredBody;

  if (uriStale || bodyStale || audienceStale) {
    logger.info('Cloud Scheduler job is stale, patching before resume', {
      job_name: jobName,
      uri_stale: uriStale,
      body_stale: bodyStale,
      audience_stale: audienceStale,
      current_uri: currentUri,
      desired_uri: desiredUri,
      current_audience: currentAudience,
      desired_audience: apiBaseUrl,
    });
    // Patch the entire httpTarget.uri + httpTarget.body via field mask.
    // We re-spread existingJob.httpTarget so any other fields the API set
    // (oidcToken, headers, httpMethod) survive the update.
    await client.updateJob({
      job: {
        name: jobPath,
        httpTarget: {
          ...existingJob.httpTarget,
          uri: desiredUri,
          body: desiredBody,
          // Re-mint the audience against the current base URL, preserving the
          // service account the API set. Spreading oidcToken alone would keep the
          // stale audience — that is precisely the bug this fixes.
          ...(existingJob.httpTarget?.oidcToken
            ? { oidcToken: { ...existingJob.httpTarget.oidcToken, audience: apiBaseUrl } }
            : {}),
        },
      },
      updateMask: {
        paths: [
          'http_target.uri',
          'http_target.body',
          ...(existingJob.httpTarget?.oidcToken ? ['http_target.oidc_token.audience'] : []),
        ],
      },
    });
  }

  // Only call resumeJob if the job is actually paused. Calling resumeJob on
  // an already-running job is a no-op API call but we save the round-trip.
  if (existingJob.state === 'PAUSED') {
    await client.resumeJob({ name: jobPath });
  }

  logger.info('Resumed Cloud Scheduler job', {
    job_name: jobName,
    tenant_id: tenantId,
    agent_id: agentId,
    uri_migrated: uriStale,
    body_migrated: bodyStale,
  });
}

export async function pauseJob(tenantId: string, agentId: string, suffix = ''): Promise<void> {
  const jobPath = getJobPath(tenantId, agentId, suffix);
  const jobName = getJobName(tenantId, agentId, suffix);

  try {
    await client.pauseJob({ name: jobPath });

    logger.info('Paused Cloud Scheduler job', {
      job_name: jobName,
      tenant_id: tenantId,
      agent_id: agentId,
    });
  } catch (error: any) {
    if (error.code === 5) {
      // NOT_FOUND - job doesn't exist, nothing to pause
      logger.info('Cloud Scheduler job not found, nothing to pause', {
        job_name: jobName,
        tenant_id: tenantId,
        agent_id: agentId,
      });
      return;
    }
    throw error;
  }
}

// One-shot startup migration: scan every Cloud Scheduler agent job in the
// tenant project and patch any whose httpTarget.uri or httpTarget.body has
// drifted from what the current code would write. Runs idempotently on every
// Cloud Run instance startup; concurrent runs of multiple instances are safe
// because client.updateJob is idempotent and converges to the same state.
//
// This exists so that when the runtime ships a change to the scheduler job
// shape (e.g. flipping USE_CLOUD_TASKS_EXECUTION, or correcting the
// triggeredBy literal in the job body), all existing agent jobs are migrated
// in-place at deploy time without needing a separate backfill script and
// without leaving any defensive coercion code paths in the worker.
//
// Only touches jobs whose name matches the agent prefix `liftoffos-agent-` —
// reflection scheduler jobs and any other jobs in the project are ignored.
export async function migrateAllAgentSchedulerJobs(): Promise<void> {
  if (!projectId) {
    logger.warn('Skipping scheduler job migration: GCP_PROJECT_ID not set');
    return;
  }

  // Soft-fail rather than throw here — this is a startup-background sweep.
  // Throwing during the wire-peer-urls first-deploy window would crash boot.
  if (tenantRuntimeUrlState() !== 'set') {
    logger.warn('Skipping scheduler job migration: TENANT_RUNTIME_URL not set');
    return;
  }

  const apiBaseUrl = getTenantRuntimeUrl();
  const desiredUri = `${apiBaseUrl}${getSchedulerTarget()}`;
  const parent = client.locationPath(projectId, location);

  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  const errors: Array<{ name: string; error: string }> = [];

  try {
    // Iterate via the auto-paginated async iterator to handle tenants with
    // many agents. The page size is small enough (default 100) that this is
    // a single API call for typical tenants.
    const iterable = client.listJobsAsync({ parent });
    for await (const job of iterable) {
      if (!job.name) continue;
      // Restrict to agent jobs only — reflection-* etc. are out of scope.
      const shortName = job.name.split('/').pop() || '';
      if (!shortName.startsWith('liftoffos-agent-')) continue;
      if (shortName.includes('-companion-')) {
        // Companion job — body shape differs (carries triggeredByLabel). Skip the
        // strict 3-field rewrite to avoid corrupting it. Companion jobs self-heal
        // via resumeJob's desiredBodyExtras path.
        continue;
      }

      scanned++;

      // Decode the agent identifiers from the existing body so the migrated
      // body is rewritten with the same tenant/agent (we don't try to parse
      // the job name itself — the body is the source of truth).
      let parsedBody: { tenantId?: string; agentId?: string } = {};
      try {
        const bodyStr = job.httpTarget?.body
          ? Buffer.from(job.httpTarget.body as Uint8Array).toString('utf-8')
          : '{}';
        parsedBody = JSON.parse(bodyStr);
      } catch {
        // If we can't parse the body, leave the job alone — patching with
        // a wrong tenant/agent would be worse than skipping.
        errors.push({ name: shortName, error: 'unparseable body, skipped' });
        continue;
      }

      if (!parsedBody.tenantId || !parsedBody.agentId) {
        errors.push({ name: shortName, error: 'missing tenantId/agentId in body' });
        continue;
      }

      const desiredBody = Buffer.from(JSON.stringify({
        tenantId: parsedBody.tenantId,
        agentId: parsedBody.agentId,
        triggeredBy: 'cron',
      })).toString('base64');

      const currentUri = job.httpTarget?.uri || '';
      const currentBody = job.httpTarget?.body
        ? Buffer.from(job.httpTarget.body as Uint8Array).toString('base64')
        : '';

      const uriStale = currentUri !== desiredUri;
      const bodyStale = currentBody !== desiredBody;

      if (!uriStale && !bodyStale) {
        skipped++;
        continue;
      }

      try {
        await client.updateJob({
          job: {
            name: job.name,
            httpTarget: {
              ...job.httpTarget,
              uri: desiredUri,
              body: desiredBody,
            },
          },
          updateMask: { paths: ['http_target.uri', 'http_target.body'] },
        });
        migrated++;
        logger.info('Migrated Cloud Scheduler job', {
          job_name: shortName,
          uri_stale: uriStale,
          body_stale: bodyStale,
        });
      } catch (err: any) {
        errors.push({ name: shortName, error: err.message });
      }
    }

    logger.info('Cloud Scheduler agent job migration complete', {
      scanned, migrated, skipped, errors: errors.length,
    });
    if (errors.length > 0) {
      logger.warn('Scheduler migration errors', { errors });
    }
  } catch (err) {
    // Migration failures must NOT block runtime startup. Worst case the
    // affected jobs stay on the old shape and the next pause+resume cycle
    // (via resumeJob's idempotent patcher) fixes them.
    logger.error('Cloud Scheduler agent job migration failed', {
      error: (err as Error).message,
    });
  }
}

// Delete a scheduler job for an agent
export async function deleteJob(tenantId: string, agentId: string, suffix = ''): Promise<void> {
  const jobPath = getJobPath(tenantId, agentId, suffix);
  const jobName = getJobName(tenantId, agentId, suffix);

  try {
    await client.deleteJob({ name: jobPath });

    logger.info('Deleted Cloud Scheduler job', {
      job_name: jobName,
      tenant_id: tenantId,
      agent_id: agentId,
    });

    // Track deletion so cost attribution knows this agent no longer owns a scheduler slot
    { const { randomUUID } = require('crypto') as typeof import('crypto');
      usageLedgerService.recordUsage({
        tenantId,
        agentId,
        workflowId: null,
        actionId: randomUUID(),
        eventType: 'cloud_scheduler_job_deleted',
        credits: 0,
        metadata: { jobName },
      }).catch((err: Error) => logger.warn({ err: err.message }, 'Non-fatal: cloud_scheduler_job_deleted tracking failed'));
    }
  } catch (error: any) {
    if (error.code === 5) {
      // NOT_FOUND - job doesn't exist, nothing to delete
      logger.info('Cloud Scheduler job not found, nothing to delete', {
        job_name: jobName,
        tenant_id: tenantId,
        agent_id: agentId,
      });
      return;
    }
    throw error;
  }
}

// List all scheduler jobs for a tenant
export async function listJobsForTenant(tenantId: string): Promise<string[]> {
  const parent = client.locationPath(projectId, location);
  const prefix = `liftoffos-agent-${tenantId}-`;

  const [jobs] = await client.listJobs({ parent });

  return jobs
    .filter(job => job.name?.includes(prefix))
    .map(job => job.name || '');
}

// Get job status
export async function getJobStatus(tenantId: string, agentId: string): Promise<{
  exists: boolean;
  state?: string;
  schedule?: string;
  lastAttemptTime?: Date;
  lastAttemptResult?: string;
} | null> {
  const jobPath = getJobPath(tenantId, agentId);

  try {
    const [job] = await client.getJob({ name: jobPath });

    return {
      exists: true,
      state: job.state !== undefined && job.state !== null ? String(job.state) : undefined,
      schedule: job.schedule || undefined,
      lastAttemptTime: job.lastAttemptTime?.seconds
        ? new Date(Number(job.lastAttemptTime.seconds) * 1000)
        : undefined,
      lastAttemptResult: job.status?.code === 0 ? 'success' : 'failed',
    };
  } catch (error: any) {
    if (error.code === 5) {
      return { exists: false };
    }
    throw error;
  }
}

// List companion jobs for an agent (used by drift reconciler).
export async function listAgentCompanionJobs(
  tenantId: string,
  agentId: string,
): Promise<Array<{ name: string; label: string; schedule: string; paused: boolean; uri: string }>> {
  const parent = client.locationPath(projectId, location);
  const prefix = getJobName(tenantId, agentId, '-companion-');
  const fullPrefix = `${parent}/jobs/${prefix}`;
  const [allJobs] = await client.listJobs({ parent });
  return allJobs
    .filter(j => typeof j.name === 'string' && j.name.startsWith(fullPrefix))
    .map(j => ({
      name: j.name ?? '',
      label: (j.name ?? '').slice(fullPrefix.length),
      schedule: j.schedule ?? '',
      paused: j.state === 'PAUSED',
      uri: j.httpTarget?.uri ?? '',
    }));
}

// Run a job immediately (for testing/manual trigger)
export async function runJobNow(tenantId: string, agentId: string, suffix = ''): Promise<void> {
  const jobPath = getJobPath(tenantId, agentId, suffix);
  const jobName = getJobName(tenantId, agentId, suffix);

  await client.runJob({ name: jobPath });

  logger.info('Triggered Cloud Scheduler job manually', {
    job_name: jobName,
    tenant_id: tenantId,
    agent_id: agentId,
  });
}
