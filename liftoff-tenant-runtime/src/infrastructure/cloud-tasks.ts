// Cloud Tasks Client
// Per Section 12: Writebacks go through Cloud Tasks and the tool gateway
// Per Section 6: Cloud Tasks for durable execution attempts and retries
//
// Phase 4: targets are authenticated
// Cloud Run services (--no-allow-unauthenticated). Every enqueued HTTP
// request must include an OIDC token so the receiving service can verify
// it via `requireServiceAuth({ acceptOidc: true })`. Cloud Tasks mints the
// token using the task's service_account_email, audience = target URL.

import { CloudTasksClient } from '@google-cloud/tasks';
import { logger } from './logging';
import { getTenantRuntimeUrl } from './runtime-env';
import { usageLedgerService } from '../usage-ledger/service';
import type { AgentTrigger } from '../agent-execution/types';

function trackTaskEnqueue(tenantId: string, agentId: string, queueType: string): void {
  const { randomUUID } = require('crypto') as typeof import('crypto');
  usageLedgerService.recordUsage({
    tenantId,
    agentId,
    workflowId: null,
    actionId: randomUUID(),
    eventType: 'cloud_tasks_enqueue',
    credits: 0,
    metadata: { queueType },
  }).catch((err: Error) => logger.warn({ err: err.message }, 'Non-fatal: cloud_tasks_enqueue tracking failed'));
}

const client = new CloudTasksClient();

const projectId = process.env.GCP_PROJECT_ID || '';
const location = process.env.GCP_LOCATION || 'us-west1';

/**
 * Resolve the SA email Cloud Tasks should use to mint OIDC tokens. All
 * tenant-runtime services (monolith + split) run as
 * `tenant-${TENANT_ID}-runtime@tenant-${TENANT_ID}-${ENV}.iam.gserviceaccount.com`
 * and this SA has run.invoker on every Cloud Run target in the tenant.
 * Returns undefined in local dev / tests without the env vars set — the
 * enqueue falls back to no-auth (legacy behaviour) rather than throwing.
 */
function resolveTaskInvokerSa(): string | undefined {
  const tenantId = process.env.TENANT_ID;
  const env = process.env.ENVIRONMENT;
  if (!tenantId || !env) return undefined;
  return `tenant-${tenantId}-runtime@tenant-${tenantId}-${env}.iam.gserviceaccount.com`;
}

/**
 * Build an oidcToken block for a Cloud Tasks httpRequest. Audience must match
 * the target Cloud Run URL exactly — service-auth.ts's OIDC verifier checks
 * this field. Returns undefined when the SA can't be resolved, which produces
 * the legacy unauthenticated delivery (useful for local dev; prod always has
 * TENANT_ID/ENVIRONMENT set so this path never fires in prod).
 */
function buildOidcToken(targetUrl: string): { oidcToken: { serviceAccountEmail: string; audience: string } } | undefined {
  const sa = resolveTaskInvokerSa();
  if (!sa) return undefined;
  // Audience must be the full scheme+host of the target URL, no path.
  let audience: string;
  try {
    const u = new URL(targetUrl);
    audience = `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
  return { oidcToken: { serviceAccountEmail: sa, audience } };
}

export interface TaskPayload {
  tenantId: string;
  agentId: string;
  workflowId: string;
  taskId: string;
  actionType: string;
  payload: any;
  idempotencyKey: string;
}

// Per Section 12: Writebacks go through Cloud Tasks
export async function enqueueConnectorWriteback(
  connectorId: string,
  payload: TaskPayload
): Promise<string> {
  const queuePath = client.queuePath(
    projectId,
    location,
    `connector-writeback-${process.env.ENVIRONMENT || 'dev'}`
  );

  // Phase 4: prefer the split tool-gateway-service URL when set, fall back
  // to TOOL_GATEWAY_URL for the monolith legacy env var.
  const serviceUrl = process.env.TOOL_GATEWAY_SERVICE_URL
    || process.env.TOOL_GATEWAY_URL
    || 'https://tool-gateway.run.app';
  const taskUrl = `${serviceUrl}/api/v1/tool-calls`;

  const task = {
    httpRequest: {
      httpMethod: 'POST' as const,
      url: taskUrl,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': payload.tenantId,
        'X-Idempotency-Key': payload.idempotencyKey,
      },
      body: Buffer.from(JSON.stringify({
        connectorId,
        ...payload,
      })).toString('base64'),
      ...buildOidcToken(taskUrl),
    },
  };

  const [response] = await client.createTask({
    parent: queuePath,
    task,
  });

  logger.info({
    message: 'Enqueued connector writeback task',
    tenant_id: payload.tenantId,
    connector_id: connectorId,
    task_name: response.name,
  });
  trackTaskEnqueue(payload.tenantId, payload.agentId, 'connector_writeback');

  return response.name || '';
}

// Per Section 6: Cloud Tasks for durable execution attempts and retries
export async function enqueueWorkflowTask(
  workflowId: string,
  taskId: string,
  payload: TaskPayload
): Promise<string> {
  const queuePath = client.queuePath(
    projectId,
    location,
    `task-execution-${process.env.ENVIRONMENT || 'dev'}`
  );

  // Phase 4: prefer the split coordinator-service URL when set.
  //
  // Target: POST /api/v1/workflows/{id}/tasks/{id}/executions. The coordinator
  // router doesn't currently ship a matching handler — `enqueueWorkflowTask`
  // callers need to add one when they wire up the task-execution Cloud Tasks
  // path. Kept here so the client+URL shape matches the rest of the REST
  // surface and any future handler drops in cleanly.
  const serviceUrl = process.env.COORDINATOR_SERVICE_URL
    || process.env.COORDINATOR_URL
    || 'https://coordinator.run.app';
  const taskUrl = `${serviceUrl}/api/v1/workflows/${workflowId}/tasks/${taskId}/executions`;

  const task = {
    httpRequest: {
      httpMethod: 'POST' as const,
      url: taskUrl,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': payload.tenantId,
        'X-Idempotency-Key': payload.idempotencyKey,
      },
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      ...buildOidcToken(taskUrl),
    },
  };

  const [response] = await client.createTask({
    parent: queuePath,
    task,
  });

  logger.info({
    message: 'Enqueued workflow task',
    tenant_id: payload.tenantId,
    workflow_id: workflowId,
    task_id: taskId,
    task_name: response.name,
  });
  trackTaskEnqueue(payload.tenantId, payload.agentId, 'workflow_task');

  return response.name || '';
}

// Agent execution via Cloud Tasks — durable, retryable, deduplicated.
//
// L1 deliverable: scheduleTime (deferred firing), contextRef (cancellation
// key), receiverPath/receiverBody (route to alternate handler like
// /api/tasks/resume-execution for workflow delay resumes), and
// triggeredByLabel (granular attribution alongside the CHECK-constrained
// triggeredBy column).
/** The queues this service enqueues to (Liftoff-Infrastructure-GCP,
 *  terraform/modules/cloud-tasks: one Cloud Tasks queue per name, with its own
 *  rate limits and retry policy). */
export type AgentTaskQueue = 'agent-tasks' | 'child-tasks' | 'chat-continuations';

export interface EnqueueAgentExecutionOptions {
  /** The run's workflow and task ids, present or absent — never a blank.
   *  They ride the default body only; a caller that supplies `receiverBody`
   *  carries whatever ids its receiver needs inside that body. A blank here
   *  is not an id and would reach a uuid column as a type error, so absence
   *  is passed as absence. */
  workflowId?: string;
  taskId?: string;
  objective: string;
  threadId: string;
  triggeredBy: string;
  scheduleKey: string;                  // ISO timestamp truncated to minute for dedup
  /** Granular trigger label (companion:<x>, reactive:<x>, workflow_delay:<id>, …).
   *  Persisted to invocations.triggered_by_label by the receiver. */
  triggeredByLabel?: string;
  /** Triggering human, forwarded in the body so a re-enqueued human run keeps
   *  its identity. Undefined for non-human enqueues. */
  triggeredByUserId?: string;
  /** Fire-at time. When set, Cloud Tasks holds the task until this instant. */
  scheduleTime?: Date;
  /** Cancellation key — included in the task name so cancelScheduledAgentExecution
   *  can locate the task. Workflow-delay handler uses '{workflowId}:{stepId}'. */
  contextRef?: string;
  /** Override the receiver path (defaults to /api/tasks/agent-scheduled).
   *  Workflow-delay resumes target /api/tasks/resume-execution. */
  receiverPath?: string;
  /** Override the body the receiver receives. Defaults to the agent-scheduled
   *  shape. Caller is responsible for matching the receiver's expected shape. */
  receiverBody?: Record<string, unknown>;
  /** Self-schedule chain depth (generation count) for the execution this task
   *  triggers. Forwarded in the body so the receiver can thread it into the
   *  tool context and schedule_followup can bound self-loops. */
  chainDepth?: number;
  /** Target queue key. Default 'agent-tasks' (shared). 'child-tasks' isolates
   *  DAG fan-out so it can't starve normal agent traffic. */
  /** Which queue delivers the task. 'agent-tasks' is the default and every
   *  ordinary scheduled run; 'child-tasks' keeps a DAG fan-out from starving
   *  it; 'chat-continuations' carries the second half of a chat turn a bound
   *  closed, whose retries are waiting for a busy conversation rather than
   *  recovering from a failure, so it retries twenty times with backoff where
   *  the others retry five. */
  queue?: AgentTaskQueue;
  /** Make the task name a function of the SCHEDULED ROW, so Cloud Tasks refuses
   *  a second arming for the same row.
   *
   *  The default name is built from `scheduleKey` + `contextRef`, and
   *  clarification's contextRef embeds the per-run `invocationId` — fresh every
   *  tick. So every arming produced a UNIQUE name, and the one backstop that
   *  could have contained a runaway (Cloud Tasks rejecting a duplicate name)
   *  never engaged: ONE pending clarification row could sit behind many queued
   *  tasks, each firing the escalation step and arming another.
   *
   *  The caller-side dedup is a code-path guarantee — it holds only for the paths that remember to check. This is a
   *  structural one: it holds for every arming, including ones written later by
   *  someone who has not read that code.
   *
   *  Include the attempt counter, not just the row id. A row legitimately
   *  re-arms after a failed resume, and Cloud Tasks retains a completed task's
   *  name for ~1h — so a bare row id would refuse the legitimate retry inside
   *  that window. `<rowId>-a<attempt>` collides on a duplicate arming of the
   *  same attempt and permits the next one. */
  taskIdentity?: string;
  /** ADR-030: id of the original invocation being re-run. Forwarded in the
   *  body so the receiver threads it into executeTask → invocations.rerun_of_invocation_id. */
  rerunOfInvocationId?: string;
  /** ADR-030: structured run input (e.g. a reactive subscription's event payload)
   *  replayed so the re-run sees exactly what the original run saw. */
  inputData?: Record<string, unknown>;
  /** Which connector the `inputData` envelope came from, for a companion
   *  routine that fans a work source out into one run per item.
   *
   *  Graph validation reads it: without it a run carrying a real
   *  `input.message` is still judged a bare cron, and every
   *  `{{input.message.*}}` reference is rejected before step 1. */
  inputSource?: string;
  /** ADR-030: the original discriminated trigger. Carries the trust level, so an
   *  untrusted-inbound webhook re-run keeps its HITL coercion + SSRF gating
   *  instead of silently executing as trusted. */
  trigger?: AgentTrigger;
}

export interface EnqueueAgentExecutionResult {
  /** Full Cloud Tasks resource name. */
  taskName: string;
  /** The schedule_key the dedup row should record. */
  scheduleKey: string;
  /** The contextRef the agent_scheduled_invocations row records. */
  contextRef: string | null;
}

function getAgentTasksQueuePath(queue: AgentTaskQueue = 'agent-tasks'): string {
  const environment = process.env.ENVIRONMENT || 'dev';
  const tenantPrefix = process.env.TENANT_ID || '';
  return client.queuePath(
    projectId,
    location,
    `${tenantPrefix}-${queue}-${environment}-v2`,
  );
}

/** Build the deterministic Cloud Tasks resource name. Including contextRef in
 *  the suffix means a delay-step task can be located for cancellation without
 *  storing the task name elsewhere first; for the unscheduled cron case the
 *  shape collapses to the legacy `sched-{agentId}-{scheduleKey}` form. */
function buildAgentTaskName(
  queuePath: string,
  agentId: string,
  scheduleKey: string,
  contextRef: string | null,
): string {
  const safeKey = scheduleKey.replace(/[^a-zA-Z0-9-]/g, '-');
  const safeCtx = contextRef ? contextRef.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 100) : '';
  const suffix = safeCtx ? `${safeKey}-${safeCtx}` : safeKey;
  return `${queuePath}/tasks/sched-${agentId}-${suffix}`;
}

export async function enqueueAgentExecution(
  tenantId: string,
  agentId: string,
  opts: EnqueueAgentExecutionOptions,
): Promise<EnqueueAgentExecutionResult> {
  const queuePath = getAgentTasksQueuePath(opts.queue);
  const serviceUrl = getTenantRuntimeUrl();
  const schedulerSA = process.env.CLOUD_SCHEDULER_SERVICE_ACCOUNT
    || process.env.CLOUD_TASKS_SERVICE_ACCOUNT
    || '';

  const contextRef = opts.contextRef ?? null;
  // `taskIdentity` makes Cloud Tasks itself enforce one live task per scheduled
  // row. See the option's docs for why the default cannot.
  const taskName = opts.taskIdentity
    ? `${queuePath}/tasks/row-${opts.taskIdentity.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 120)}`
    : buildAgentTaskName(queuePath, agentId, opts.scheduleKey, contextRef);

  const receiverPath = opts.receiverPath ?? '/api/tasks/agent-scheduled';
  const bodyObj: Record<string, unknown> = opts.receiverBody ?? {
    tenantId,
    agentId,
    workflowId: opts.workflowId,
    taskId: opts.taskId,
    objective: opts.objective,
    threadId: opts.threadId,
    triggeredBy: opts.triggeredBy,
    ...(opts.triggeredByLabel ? { triggeredByLabel: opts.triggeredByLabel } : {}),
    ...(opts.triggeredByUserId ? { triggeredByUserId: opts.triggeredByUserId } : {}),
    ...(contextRef ? { contextRef } : {}),
    ...(opts.chainDepth != null ? { chainDepth: opts.chainDepth } : {}),
    ...(opts.rerunOfInvocationId ? { rerunOfInvocationId: opts.rerunOfInvocationId } : {}),
    ...(opts.inputData ? { inputData: opts.inputData } : {}),
    ...(opts.inputSource ? { inputSource: opts.inputSource } : {}),
    ...(opts.trigger ? { trigger: opts.trigger } : {}),
  };

  // Coupled to the RECEIVING service's Cloud Run request timeout, which is
  // agent-service (`getTenantRuntimeUrl()` above) at 900s.
  //
  // This said 270s "because the underlying Cloud Run service has a 300s request
  // timeout". The service is 900s now and the deadline never followed, so Cloud
  // Tasks gave up on a delivery at 270s while the run kept going inside a
  // request that had another 630s to live — and then retried it. The execution
  // lock absorbs the duplicate ("Agent execution lock not acquired — concurrent
  // run in progress, skipping"), so the symptom is invisible: the work is
  // neither lost nor doubled, it just burns a queue retry per scheduled run and
  // reports a failed delivery for a run that succeeded.
  //
  // A deadline BELOW the receiver's timeout is the wrong side of the trade. The
  // queue should outlive the request it is waiting on, so a real timeout is
  // reported by the service that actually ran the work, not by the queue that
  // stopped listening. 870s leaves 30s of margin under 900s.
  //
  // Read from the environment and set explicitly in the deploy for the reason
  // TOOL_RESULT_MAX_CHARS is: "unset" and "deliberately 870" look identical from
  // the outside, and this repo has already lost time to a limit nobody could
  // see. If agent-service's timeoutSeconds moves, move this with it — they are
  // one decision expressed in two places.
  const dispatchDeadlineSeconds = (() => {
    const raw = Number(process.env.AGENT_TASK_DISPATCH_DEADLINE_SECONDS);
    return Number.isFinite(raw) && raw > 0 ? raw : 870;
  })();

  const task: Record<string, unknown> = {
    name: taskName,
    dispatchDeadline: { seconds: dispatchDeadlineSeconds },
    httpRequest: {
      httpMethod: 'POST' as const,
      url: `${serviceUrl}${receiverPath}`,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenantId,
        'X-Idempotency-Key': `sched-${agentId}-${opts.scheduleKey}`,
      },
      body: Buffer.from(JSON.stringify(bodyObj)).toString('base64'),
      oidcToken: schedulerSA
        ? { serviceAccountEmail: schedulerSA, audience: serviceUrl }
        : undefined,
    },
  };

  if (opts.scheduleTime) {
    const ms = opts.scheduleTime.getTime();
    task.scheduleTime = {
      seconds: Math.floor(ms / 1000),
      nanos: (ms % 1000) * 1_000_000,
    };
  }

  // ALREADY_EXISTS is the guarantee working, not a failure.
  //
  // When the caller supplies a `taskIdentity`, the task name is a function of
  // the scheduled ROW, so a second arming for the same row collides here — in
  // Cloud Tasks, which is the only place that can see every arming regardless
  // of which code path made it. Treated as success: the row already has its
  // task, which is exactly what the caller wanted.
  //
  // Without this the guarantee would be worse than useless: making names
  // collide while letting the collision throw would turn a benign duplicate
  // into an error on a path whose whole job is to be idempotent.
  let response: { name?: string | null };
  try {

    [response] = await client.createTask({ parent: queuePath, task: task as any });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (opts.taskIdentity && code === 6) {   // 6 = ALREADY_EXISTS
      logger.info({
        message: 'Task already armed for this row — collision is the guarantee, not an error',
        tenant_id: tenantId,
        agent_id: agentId,
        task_name: taskName,
        task_identity: opts.taskIdentity,
      });
      return { taskName, scheduleKey: opts.scheduleKey, contextRef };
    }
    throw err;
  }

  logger.info({
    message: 'Enqueued agent execution task',
    tenant_id: tenantId,
    agent_id: agentId,
    task_name: response.name,
    schedule_key: opts.scheduleKey,
    context_ref: contextRef,
    schedule_time: opts.scheduleTime?.toISOString(),
    receiver_path: receiverPath,
  });
  trackTaskEnqueue(tenantId, agentId, 'agent_execution');

  return {
    taskName: response.name || taskName,
    scheduleKey: opts.scheduleKey,
    contextRef,
  };
}

/** Cancel a previously-enqueued agent execution. Used by:
 *   - schedule_followup cancel path (predecessor L1).
 *   - workflow cancel propagating to pending delay-step resumes (workflow delay steps).
 *
 *  Best-effort: NOT_FOUND (code 5) is treated as success at the caller side —
 *  the task already fired or never existed.
 */
export async function cancelScheduledAgentExecution(
  tenantId: string,
  agentId: string,
  scheduleKey: string,
  contextRef: string | null,
  queue: AgentTaskQueue = 'agent-tasks',   // child cancels must target the child-tasks queue
): Promise<void> {
  const queuePath = getAgentTasksQueuePath(queue);
  const taskName = buildAgentTaskName(queuePath, agentId, scheduleKey, contextRef);
  await client.deleteTask({ name: taskName });
  logger.info({
    message: 'Cancelled scheduled agent execution',
    tenant_id: tenantId,
    agent_id: agentId,
    task_name: taskName,
  });
}

// Per Section 16: Evaluation (formerly "reflection") jobs via Cloud Tasks.
//
// The task body carries { agentId, tenantId, triggerType, metadata } —
// the receiving `POST /api/v1/evaluations` endpoint deserialises into a
// ReflectionTrigger and runs the Opus analysis.
export async function enqueueReflectionJob(
  agentId: string,
  tenantId: string,
  triggeredBy: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  // `${TENANT_ID}-reflection-tasks-${ENVIRONMENT}-v2`, which is the name the
  // queue is actually PROVISIONED under, and the convention every sibling
  // queue in this file follows (see getAgentTasksQueuePath). This read
  // `reflection-jobs-${env}` — a name matching nothing in any environment — so
  // every reflection enqueue died with NOT_FOUND: Queue does not exist.
  //
  // Invisible until now for the same reason as the actAs gap beneath it:
  // nothing ever reached the enqueue, because every trigger was gated on
  // counters reading a table the current architecture stopped writing. Three
  // independent breaks stacked behind one gate that never opened.
  const queuePath = client.queuePath(
    projectId,
    location,
    `${process.env.TENANT_ID || ''}-reflection-tasks-${process.env.ENVIRONMENT || 'dev'}-v2`,
  );

  const serviceUrl = process.env.REFLECTION_URL || 'https://reflection-engine.run.app';

  // REST: POST /api/v1/evaluations with agentId in the body, not the URL.
  const taskUrl = `${serviceUrl}/api/v1/evaluations`;
  const task = {
    httpRequest: {
      httpMethod: 'POST' as const,
      url: taskUrl,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenantId,
      },
      body: Buffer.from(JSON.stringify({
        agentId,
        tenantId,
        triggerType: triggeredBy,
        metadata,
      })).toString('base64'),
      ...buildOidcToken(taskUrl),
    },
  };

  const [response] = await client.createTask({
    parent: queuePath,
    task,
  });

  logger.info({
    message: 'Enqueued reflection job',
    tenant_id: tenantId,
    agent_id: agentId,
    task_name: response.name,
  });
  trackTaskEnqueue(tenantId, agentId, 'reflection_job');

  return response.name || '';
}
