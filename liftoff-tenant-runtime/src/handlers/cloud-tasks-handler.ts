// Cloud Tasks Handler
// Per implementation plan Phase 1.2: HTTP handler for Cloud Tasks execution
// Verifies OIDC token from Cloud Tasks/Scheduler and calls agentExecutionService

import { Router, Request, Response } from 'express';
import { firstPresentId } from '../agent-execution/run-identity';
import { v4 as uuidv4 } from 'uuid';
import { agentExecutionService, readCarriedResumeState } from '../agent-execution/service';
import { invocationsService } from '../invocations/service';
import { child_task_completed_total } from '../observability/runtime-extensions-metrics';
import { recordResumeResult, recordResumeDurationMs, type PauseKind } from '../observability/pause-resume-telemetry';
import type { TaskExecutionResult } from '../agent-execution/types';
import { resolveTerminalState, THREAD_STATUS_BY_TERMINAL } from '../agent-execution/terminal-state';
import type { AgentTrigger } from '../agent-execution/types';
import type { SalvageNote } from '../agent-execution/engine/step-salvage-prompt';
import { logger } from '../infrastructure/logging';
import { setTraceContext } from '../infrastructure/safe-trace-context';
import { verifyOidcToken } from '../infrastructure/oidc';
import { getPoolForService } from '../infrastructure/database';
import { recordRoutineOutcome } from '../scheduling/routine-failure-state';
import { isRetryableFailureClass } from '../agent-execution/failure-classification';
import { recordTriggerSkip } from '../scheduling/skip-reasons';

const router = Router();

interface CloudTaskPayload {
  tenantId: string;
  agentId: string;
  workflowId: string;
  taskId: string;
  objective: string;
  inputData?: Record<string, unknown>;
  /** Which connector `inputData` came from. A companion routine that fans a
   *  work source out into one run per item sets it; graph validation needs it
   *  or the run is judged a bare cron and every `{{input.message.*}}` reference
   *  is rejected before step 1. */
  inputSource?: string;
  threadId?: string;
  triggeredBy?: string;
  triggeredByUserId?: string;
  hitlLevel?: number;
  escalation?: 'exceptions' | 'important' | 'sensitive';
  requestedByType?: 'mcp_key' | 'a2a_token' | 'internal';
  requestedById?: string;
  /** Self-schedule chain depth carried from the triggering scheduled row. */
  chainDepth?: number;
  /** Optional explicit run-level idempotency key (§4.7); falls back to the
   *  stable X-CloudTasks-TaskName when absent. */
  triggerKey?: string;
  triggeredByLabel?: string;
  deferAttempt?: number;
  onConflict?: 'defer' | 'reject';
  trigger?: AgentTrigger;
  trustLevel?: 'trusted' | 'untrusted_inbound';
  childTaskId?: string;
  delegationDepth?: number;
  execTimeoutMsOverride?: number;
  /** ADR-030: id of the original invocation this run re-runs (set by the Run again path). */
  rerunOfInvocationId?: string;
}

// Cloud Tasks / Scheduler service accounts allowed to invoke this handler.
// Filtered to non-empty values inside verifyOidcToken; when the resulting set
// is empty (typical in dev) we fall through to issuer-only verification.
function cloudTasksAllowedSAs(): Array<string | undefined> {
  return [
    process.env.CLOUD_TASKS_SERVICE_ACCOUNT,
    process.env.CLOUD_SCHEDULER_SERVICE_ACCOUNT,
    // Default Cloud Tasks service account pattern.
    process.env.GCP_PROJECT_NUMBER
      ? `${process.env.GCP_PROJECT_NUMBER}@cloudtasks.gserviceaccount.com`
      : undefined,
  ];
}

// Wrapper used by every route in THIS file. The shared verifyOidcToken
// (../infrastructure/oidc) only checks issuer + audience by default; the
// pre-refactor inline function in this file also pinned the caller email
// to the Cloud Tasks / Scheduler SAs configured for this project. The
// wrapper restores that behavior for every route so each call site stays
// short and a future call site can't accidentally skip the SA check.
export async function verifyCloudTasksOidc(req: Request): Promise<boolean> {
  return verifyOidcToken(req, {
    allowedServiceAccounts: cloudTasksAllowedSAs(),
    allowDevBypass: process.env.ENVIRONMENT === 'dev',
  });
}

// POST /api/tasks/execute - Execute a task from Cloud Tasks
router.post('/execute', async (req: Request, res: Response) => {
  try {
    const isValid = await verifyCloudTasksOidc(req);
    if (!isValid) {
      // Allow requests with valid internal headers for development
      const internalSecret = req.headers['x-internal-secret'];
      if (internalSecret !== process.env.INTERNAL_SERVICE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    // Extract payload - Cloud Tasks sends base64 encoded body
    let payload: CloudTaskPayload;

    if (typeof req.body === 'string') {
      // Base64 encoded body from Cloud Tasks
      payload = JSON.parse(Buffer.from(req.body, 'base64').toString());
    } else {
      // Direct JSON body
      payload = req.body;
    }

    // Validate required fields
    if (!payload.tenantId || !payload.agentId || !payload.workflowId || !payload.taskId || !payload.objective) {
      return res.status(400).json({
        error: 'Missing required fields: tenantId, agentId, workflowId, taskId, objective',
      });
    }

    // WS-1.2 — bind tenant_id at the task-handler boundary so executeTask's
    // downstream logs (including the agent-execution loop) carry attribution.
    setTraceContext({ tenantId: payload.tenantId, agentId: payload.agentId });

    logger.info('Cloud Tasks execution started', {
      tenant_id: payload.tenantId,
      agent_id: payload.agentId,
      workflow_id: payload.workflowId,
      task_id: payload.taskId,
    });

    // Execute the task, guarded by Cloud Tasks idempotency: a redelivery
    // (after a post-LLM failure returned 500) replays the stored result
    // instead of re-invoking the LLM. progressWorkflow below still runs on a
    // replay so the bookkeeping that failed gets re-driven.
    // §4.7-PR2: run-level idempotency is now executeTask's own concern (it claims
    // an event_processing_ledger agent_run row keyed on triggerKey). The Cloud
    // Tasks taskName is stable across retries → use it as the triggerKey so a
    // post-LLM-bookkeeping retry replays the stored result instead of re-running
    // the LLM, and a concurrent dup is skipped. Replaces the retired
    // runWithTaskIdempotency / cloud_task_executions.
    const taskName = req.headers['x-cloudtasks-taskname'] as string | undefined;
    const result = await agentExecutionService.executeTask({
      tenantId: payload.tenantId,
      agentId: payload.agentId,
      workflowId: payload.workflowId,
      taskId: payload.taskId,
      triggerKey: payload.triggerKey ?? taskName,
      objective: payload.objective,
      inputData: payload.inputData,
      threadId: payload.threadId,
      triggeredBy: (payload.triggeredBy as 'human' | 'agent' | 'cron' | 'event') || 'cron',
      triggeredByUserId: payload.triggeredByUserId,
      // The payload has carried this field all along and the handler never
      // passed it on, so a run that DEFERRED lost its trigger at the queue
      // boundary — and with it the untrusted_inbound marking on
      // external-authored content, plus any host a trigger-bound step resolves
      // against. A deferred run is the same run; it must not be less safe than
      // the one that got the lock first.
      trigger: payload.trigger,
      hitlLevel: payload.hitlLevel,
      escalation: payload.escalation,
      requestedByType: payload.requestedByType,
      requestedById: payload.requestedById,
    });

    // Concurrent duplicate delivery in flight — the owning delivery completes the
    // work; ack so Cloud Tasks does not retry.
    if (result.error === 'duplicate_delivery_in_flight') {
      return res.status(200).json({ deduplicated: true });
    }

    // §4.12: the async "resume-caller" a2a callback was verified-broken
    // (onTargetAgentCompleted wrote engine_sessions.agentCallResult that nothing
    // read, then enqueued a resume that 410'd). Removed; a2a delegation now runs
    // inline via delegateToAgent (§4.13).

    // Progress workflow based on result
    await agentExecutionService.progressWorkflow(
      payload.workflowId,
      payload.taskId,
      result
    );

    logger.info('Cloud Tasks execution completed', {
      tenant_id: payload.tenantId,
      agent_id: payload.agentId,
      success: result.success,
      tool_calls: result.toolCallsExecuted,
    });

    return res.status(200).json(result);
  } catch (error) {
    logger.error('Cloud Tasks execution failed', {
      error: (error as Error).message,
      stack: (error as Error).stack,
    });

    // Return 500 to trigger Cloud Tasks retry
    return res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/tasks/agent-scheduled
// Handles Cloud Tasks delivery for scheduled agent execution.
// Cloud Tasks retries on 500, deduplicates by task name.
//
// PER-AGENT SERIALIZATION
// =======================
// The cloud-tasks queue runs at maxConcurrentDispatches=10 (shared across all
// agents in the tenant). The task name dedup only collapses two enqueues for
// the same minute bucket — it does NOT prevent the worker from receiving the
// minute-N+1 task while the minute-N task is still executing. Without a lock
// here, any agent whose execution overruns its cron interval will run
// concurrently with itself and double-write side effects (e.g. two BTC rows
// per minute).
//
// We hold a Postgres session-level advisory lock keyed by a hash of the
// agent_id for the duration of the request. Concurrent deliveries for the
// SAME agent_id race for the lock; the loser returns 200 with skipped:true so
// Cloud Tasks does NOT retry (the run is logically subsumed by the in-flight
// execution). Lock keys for different agents are independent so this does not
// serialize across agents — only across deliveries of the same agent.
//
// pg_try_advisory_lock takes a bigint and we have a UUID, so we hash the
// UUID to a 64-bit int with PG's hashtextextended. Collisions are
// astronomically unlikely (~2^-32 per pair) and harmless: a collision would
// merely serialize two unrelated agents, never corrupt data.
router.post('/agent-scheduled', async (req: Request, res: Response) => {
  const traceId = uuidv4();

  // 1. Verify OIDC token
  const isAuthorized = await verifyCloudTasksOidc(req);
  if (!isAuthorized) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // 2. Parse payload
  const payload = req.body as CloudTaskPayload;
  if (!payload.tenantId || !payload.agentId) {
    return res.status(400).json({ error: 'Missing tenantId or agentId' });
  }

  // WS-1.2 — bind tenant_id at the scheduled-task boundary.
  setTraceContext({ tenantId: payload.tenantId, agentId: payload.agentId });

  logger.info('Agent scheduled task received', {
    trace_id: traceId,
    agent_id: payload.agentId,
    tenant_id: payload.tenantId,
    triggered_by: payload.triggeredBy,
  });

  // 3. Acquire per-agent advisory lock. We must hold a dedicated connection
  // for the lifetime of the request so the lock is released on connection
  // return — otherwise pg's pool handoff could leave the lock dangling.
  const scheduledPool = getPoolForService('scheduled-execution');
  const lockClient = await scheduledPool.connect();

  try {
    const lockResult = await lockClient.query(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
      [payload.agentId]
    );
    const acquired: boolean = lockResult.rows[0]?.acquired === true;

    if (!acquired) {
      logger.info('Agent execution lock not acquired — concurrent run in progress, skipping', {
        trace_id: traceId,
        agent_id: payload.agentId,
      });
      // Return 200 so Cloud Tasks does NOT retry: a concurrent run is already
      // doing this agent's work. The skipped run is acceptable for polling
      // workloads (each cron tick is independent).
      recordTriggerSkip('cloud_task', 'concurrent_execution');
      return res.status(200).json({
        skipped: true,
        reason: 'Concurrent execution in progress for this agent',
      });
    }

    try {
      // 4. Re-check lifecycle AND reconcile against platform backend source of truth.
      //
      // The agents.lifecycle field drives execution, but the canonical source of
      // truth is internal_agents.status on the platform backend, mirrored into
      // cached_internal_agents.status via the event subscriber.
      //
      // If the two disagree, the canonical state wins: the local agents.lifecycle
      // is healed to match, and the task is rejected. This closes drift windows
      // caused by: (a) missed events, (b) out-of-order delivery, (c) direct DB
      // manipulation bypassing the event path.
      const lifecycleCheck = await lockClient.query(
        `SELECT a.lifecycle, c.status as canonical_status, m.internal_agent_id
         FROM agents a
         LEFT JOIN internal_agent_runtime_mapping m
           ON m.agent_id = a.id AND m.tenant_id = a.tenant_id
         LEFT JOIN cached_internal_agents c
           ON c.internal_agent_id = m.internal_agent_id AND c.tenant_id = a.tenant_id
         WHERE a.id = $1
         LIMIT 1`,
        [payload.agentId]
      );
      const row = lifecycleCheck.rows[0];
      const lifecycle = row?.lifecycle as string | undefined;
      const canonicalStatus = row?.canonical_status as string | undefined;

      // Map canonical platform-backend status → runtime lifecycle
      //   active → ACTIVE | paused → PAUSED | draft → DRAFT | archived → ARCHIVED
      const expectedLifecycle = canonicalStatus
        ? canonicalStatus.toUpperCase()
        : undefined;

      // Drift detection — canonical state wins, auto-heal local agents table
      if (expectedLifecycle && lifecycle !== expectedLifecycle) {
        logger.error('Agent lifecycle drift detected — reconciling against canonical source', {
          trace_id: traceId,
          agent_id: payload.agentId,
          local_lifecycle: lifecycle,
          canonical_status: canonicalStatus,
          expected_lifecycle: expectedLifecycle,
        });
        await lockClient.query(
          `UPDATE agents SET lifecycle = $1, updated_at = NOW() WHERE id = $2`,
          [expectedLifecycle, payload.agentId]
        );
        // If the canonical state is PAUSED/DRAFT/ARCHIVED, also pause the scheduler
        // to stop firing and triggering more drift.
        if (expectedLifecycle !== 'ACTIVE') {
          try {
            const { pauseJob } = await import('../scheduling/cloud-scheduler');
            await pauseJob(payload.tenantId, payload.agentId);
          } catch (schedErr) {
            logger.warn({ err: schedErr }, 'Non-fatal: scheduler pause after drift heal failed');
          }
        }
        recordTriggerSkip('cloud_task', 'lifecycle_drift_healed');
        return res.status(200).json({
          skipped: true,
          reason: `Lifecycle drift: local=${lifecycle}, canonical=${canonicalStatus}. Healed to ${expectedLifecycle}.`,
        });
      }

      if (lifecycle !== 'ACTIVE') {
        logger.info('Agent not ACTIVE at task delivery time, skipping', {
          trace_id: traceId,
          agent_id: payload.agentId,
          lifecycle,
        });
        recordTriggerSkip('cloud_task', 'agent_lifecycle_not_active');
        return res.status(200).json({ skipped: true, reason: `Agent lifecycle is ${lifecycle || 'unknown'}` });
      }

      // 5. Execute agent
      // executeTask() creates and completes its own invocation internally
      // (with correct tokens, pricing, tool calls). Do NOT create a duplicate
      // invocation here — that was producing blank records with toolCalls: []
      // and inputTokens: 0 that overwrote nothing but cluttered the data.
      const triggeredBy = (payload.triggeredBy || 'cron') as 'human' | 'agent' | 'cron' | 'event';
      const triggeredByLabel = (payload as unknown as Record<string, unknown>).triggeredByLabel as string | undefined;

      // §4.7-PR2: run-level idempotency is executeTask's own concern now; the
      // stable Cloud Tasks taskName is the triggerKey so a redelivery replays the
      // prior result instead of re-invoking the LLM. Replaces runWithTaskIdempotency.
      const taskName = req.headers['x-cloudtasks-taskname'] as string | undefined;
      const result = await agentExecutionService.executeTask({
        tenantId: payload.tenantId,
        agentId: payload.agentId,
        workflowId: payload.workflowId || uuidv4(),
        taskId: payload.taskId || uuidv4(),
        triggerKey: payload.triggerKey ?? taskName,
        threadId: payload.threadId,
        triggeredBy,
        triggeredByLabel,
        triggeredByUserId: payload.triggeredByUserId,
        objective: payload.objective,
        chainDepth: payload.chainDepth,
        rerunOfInvocationId: payload.rerunOfInvocationId,
        // ADR-030: a "Run again" re-enqueue carries the original run's structured
        // input and trigger so the re-run is faithful (reactive event payload) and
        // safe (webhook trust level → HITL + SSRF gating preserved). Both are
        // undefined for ordinary cron/scheduled deliveries, so behavior is unchanged.
        inputData: payload.inputData,
        // Companion work-source fan-out: tells graph validation this run carries
        // an event-shaped input even though Cloud Tasks delivered it on the
        // cron path. Undefined for every other delivery, so nothing else moves.
        inputSource: payload.inputSource,
        trigger: payload.trigger,
      });
      if (result.error === 'duplicate_delivery_in_flight') {
        recordTriggerSkip('cloud_task', 'duplicate_delivery_in_flight');
        return res.status(200).json({ skipped: true, reason: 'duplicate delivery in flight' });
      }

      // J3 — a routine that fails every tick should eventually stop firing.
      // Counted here rather than at the enqueue endpoint because this is where
      // the run actually terminates on the live path.
      //
      // An ESCALATED run is a FAILED tick for this counter. The run itself
      // returns success:true deliberately — that flag means "terminated
      // cleanly", and resolveTerminalState owns outcome precedence — but the
      // routine did not do its job, and consecutive escalations are exactly
      // the fails-every-tick condition this breaker exists for. Feeding it the
      // raw flag would let an escalating routine reset its own streak on every
      // run, so the breaker could never trip.
      //
      // A run that hit its ceiling is NOT counted. It says the budget is too
      // small, not that the routine is broken, and pausing the agent is the
      // wrong answer to that — the fix is a bigger budget or a smaller job.
      // Counting it stopped a team whose run had already done its work.
      const hitItsLimit = result.terminalState === 'limit_reached';
      // A run that succeeded and escalated is evidence of NEITHER, so it is not
      // recorded at all.
      //
      // `success: result.success === true && result.escalated !== true` counted
      // it as a FAILURE. Escalating is not a fault — for a support agent it is a
      // designed outcome with its own branch in the graph (the Customer Support
      // workflow routes s9 → s9b → s10 for exactly this), and a routine that
      // correctly hands three awkward emails to a human in a row would stop its
      // own agent: three escalating sweeps trip the breaker, and because a
      // paused agent is deregistered from its event trigger, inbound customer
      // mail stops being answered too — the breaker meant to protect the agent
      // takes it off the air.
      //
      // Not simply flipping it to `success: true` either: the comment this
      // replaces was right that an escalating routine must not RESET its streak,
      // or a routine failing every other run would never trip. Withholding the
      // record satisfies both — it neither adds nor clears, which is the same
      // treatment `countsTowardRoutinePause` already gives a failure that says
      // nothing about the routine's configuration.
      //
      // A run that FAILED is still counted, whether or not it also escalated.
      const escalatedCleanly = result.success === true && result.escalated === true;
      if (escalatedCleanly) {
        logger.info('routine escalated to a human — not counted for or against the routine', {
          trace_id: traceId,
          agent_id: payload.agentId,
          triggered_by_label: triggeredByLabel,
        });
      }
      if (!hitItsLimit && !escalatedCleanly) {
        await recordRoutineOutcome({
          tenantId: payload.tenantId,
          agentId: payload.agentId,
          triggeredByLabel,
          success: result.success === true,
          error: result.error,
          // WHY it failed decides whether it is evidence about the ROUTINE. A
          // provider outage, a lapsed entitlement, or an agent that was simply
          // busy are none of them a broken routine, and counting them is how a
          // healthy one got its agent stopped.
          failureClass: result.failureClass,
        });
      }

      logger.info('Agent scheduled task completed', {
        trace_id: traceId,
        agent_id: payload.agentId,
        success: result.success,
        reasoning_steps: result.reasoningSteps,
        tool_calls: result.toolCallsExecuted,
      });

      // 7. A transient provider failure asks Cloud Tasks to deliver again.
      //
      // The adapter turns an SDK throw into a completion event with
      // outcome:'error', which RETURNS rather than throws, so this handler used
      // to answer 200 and Cloud Tasks marked the task done. A 429 therefore
      // ended a scheduled run permanently, and the only recovery was a human
      // clicking "Run again" on the Activity page — which mints a fresh
      // scheduleKey and cold-starts the work from the beginning.
      //
      // Everything a redelivery needs already exists: the stable Cloud Tasks
      // task name is the triggerKey, isTerminalForTrigger() re-opens the
      // idempotency ledger on exactly engine_error, prepareAutonomousSession
      // resumes the session persistAutonomousSession checkpointed after every
      // tool call, and dedup-posture keeps already-fired side effects from
      // firing twice. The missing wire was this status code.
      //
      // Only this handler. scheduled-invoke-handler passes no triggerKey, so
      // executeTask skips the idempotency claim entirely and never arms the
      // autonomous resume — a retry there would cold-start AND could double-run
      // with no ledger to dedup it.
      //
      // recordRoutineOutcome ran above, and the class filter it now applies is
      // what stops each retry attempt from counting toward the threshold that
      // pauses the agent.
      if (isRetryableFailureClass(result.failureClass)) {
        logger.warn({
          event: 'agent_run_retry_requested',
          trace_id: traceId,
          tenant_id: payload.tenantId,
          agent_id: payload.agentId,
          failure_class: result.failureClass,
          error: result.error,
        }, 'transient provider failure; asking Cloud Tasks to redeliver');
        return res.status(500).json({
          success: false,
          retryable: true,
          failureClass: result.failureClass,
          error: result.error,
        });
      }

      // 8. Return 200 on success (Cloud Tasks marks task complete)
      return res.status(200).json({
        success: result.success,
        reasoningSteps: result.reasoningSteps,
        toolCalls: result.toolCallsExecuted,
      });
    } finally {
      // Always release the advisory lock — even on error paths. pg releases
      // session-level locks on connection close, but we explicitly release
      // here so the lock is immediately available for the next dispatch.
      try {
        await lockClient.query(
          `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
          [payload.agentId]
        );
      } catch (unlockErr) {
        logger.warn('Failed to release agent execution advisory lock (will release on connection close)', {
          trace_id: traceId,
          agent_id: payload.agentId,
          error: (unlockErr as Error).message,
        });
      }
    }
  } catch (error) {
    logger.error('Agent scheduled task failed', {
      trace_id: traceId,
      error: (error as Error).message,
    });
    // Return 500 so Cloud Tasks retries with backoff
    return res.status(500).json({ error: (error as Error).message });
  } finally {
    lockClient.release();
  }
});

// POST /api/tasks/child-execution — run one DAG child (lock-free; no per-agent
// advisory lock so siblings under the same parent agent parallelize). Idempotent
// via executeTask triggerKey = childTaskId. Reports terminal status to the coordinator.
router.post('/child-execution', async (req: Request, res: Response) => {
  if (!(await verifyCloudTasksOidc(req))) {
    if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SERVICE_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }
  const p = (typeof req.body === 'string' ? JSON.parse(Buffer.from(req.body, 'base64').toString()) : req.body) as CloudTaskPayload & { childTaskId?: string };
  if (!p.tenantId || !p.agentId || !p.objective || !p.childTaskId) return res.status(400).json({ error: 'Missing tenantId/agentId/objective/childTaskId' });
  setTraceContext({ tenantId: p.tenantId, agentId: p.agentId });
  const { CoordinatorService } = await import('../coordinator/service');
  const coord = new CoordinatorService();
  try {
    const result = await agentExecutionService.executeTask({
      tenantId: p.tenantId, agentId: p.agentId,
      workflowId: p.workflowId || uuidv4(), taskId: p.taskId || uuidv4(),
      objective: p.objective, inputData: p.inputData,
      triggerKey: p.childTaskId, triggeredBy: 'agent',
      hitlLevel: p.hitlLevel, requestedByType: 'internal',
      delegationDepth: (p as { delegationDepth?: number }).delegationDepth ?? null,
      execTimeoutMsOverride: (p as { execTimeoutMsOverride?: number }).execTimeoutMsOverride ?? 240_000,
    });
    if (result.error === 'duplicate_delivery_in_flight') return res.status(200).json({ deduplicated: true });
    // Self-woken child: do NOT complete it (that would prematurely resume the parent — the fan-in at
    // checkChildTasksCompletion counts a child NOT IN ('completed','failed') as still-pending, so
    // leaving it non-terminal keeps the parent blocked until the child's wake continuation finishes,
    // or the saga's delegation-expiry backstop compensates).
    if (result.paused && result.pauseKind === 'self_wake') {
      const { agentScheduledInvocationsRepo } = await import('../scheduling/agent-scheduled-invocations-repo');
      const { ChildTaskRepository } = await import('../coordinator/repository');
      // Mark the child 'waiting' — an explicit non-terminal state (distinct from 'executing') so the
      // fan-in count reads it as still-pending and the coordinator surface can show it is parked.
      await new ChildTaskRepository().updateStatus(p.childTaskId, 'waiting').catch(() => {});
      if (result.clarificationSessionId) {
        // Bind the child to its wake row so resumeFromWake completes the child once the wake continuation
        // succeeds — rather than relying only on the saga delegation-expiry backstop.
        await agentScheduledInvocationsRepo.bindWakeChildTask(result.clarificationSessionId, p.childTaskId).catch(() => {});
        // Clamp the child's wake TTL to the parent saga deadline so it never outlives the delegation.
        await agentScheduledInvocationsRepo.reconcileChildWakeTtl(result.clarificationSessionId, p.childTaskId).catch(() => {});
      }
      logger.info('Child paused on self-wake; marked waiting so the parent stays blocked', { childTaskId: p.childTaskId });
      return res.status(200).json({ childTaskId: p.childTaskId, paused: 'self_wake' });
    }
    if (result.success || result.paused || result.escalated) await coord.completeChildTask(p.childTaskId, result.output ?? result);  // no requestingAgentId → ownership check skipped
    else await coord.failChildTask(p.childTaskId, result.error ?? 'child_task_failed');
    child_task_completed_total.inc({ tenant_id: p.tenantId, status: result.success ? 'completed' : 'failed' });
    return res.status(200).json({ childTaskId: p.childTaskId, success: result.success });
  } catch (e) {
    // 500 → Cloud Tasks retries; executeTask triggerKey replays if already terminal.
    return res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/tasks/resume-execution - Resume agent execution after HITL approval or agent-to-agent callback
router.post('/resume-execution', async (req: Request, res: Response) => {
  try {
    const isValid = await verifyCloudTasksOidc(req);
    if (!isValid) {
      const internalSecret = req.headers['x-internal-secret'];
      if (internalSecret !== process.env.INTERNAL_SERVICE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const body = typeof req.body === 'string'
      ? JSON.parse(Buffer.from(req.body, 'base64').toString())
      : req.body;

    const { invocationId, tenantId, agentId } = body;

    if (!invocationId || !tenantId) {
      return res.status(400).json({ error: 'Missing invocationId or tenantId' });
    }

    // workflow-delay / hybrid resume dispatch. Workflows have no JSONL engine
    // session; their state is the deterministic step position carried in the
    // task body's workflowResume marker. When that's present, dispatch to the
    // appropriate resume path based on workflowResume.kind (D24).
    //
    // kind:
    //   - 'delay' (default / omitted): existing workflow-delay resume.
    //   - 'clarification-answered': user replied to an ask_user pause —
    //     re-enter the hybrid loop via resumeFromClarificationAnswer.
    //   - 'clarification-expiry': 24h elapsed with no answer — cap-exhausted
    //     internal escalation.
    const workflowResume = (body as { workflowResume?: {
      scheduledInvocationId: string;
      workflowId?: string;
      taskId?: string;
      resumeAfterStepId?: string;
      stepOutput?: unknown;
      kind?: 'delay' | 'clarification-answered' | 'clarification-expiry'
           | 'hitl-approved' | 'hitl-rejected' | 'hitl-expiry'
           | 'delegation-resolved' | 'delegation-expiry'
           | 'wake-timer' | 'wake-event' | 'wake-job' | 'wake-poll' | 'wake-expiry'
           | 'wake-waitset' | 'wake-waitset-expiry'
           | 'run-continuation' | 'chat-continuation' | 'background-work';
      wakePayload?: { event?: unknown; jobResult?: unknown; pollResult?: unknown };
      waitSetId?: string;
      firedKind?: string;
      pausedAtStepId?: string;
      question?: string;
      userAnswer?: string;
      invocationId?: string;
    } }).workflowResume;

    if (workflowResume) {
      const { agentScheduledInvocationsRepo } = await import('../scheduling/agent-scheduled-invocations-repo');
      const kind = workflowResume.kind ?? 'delay';

      // Resume-attempt telemetry at the signal→terminal boundary: one attempt
      // per resume dispatch, tagged with the engine the primitive ran under (it
      // surfaces it on the result) and the elapsed time. Covers both the success
      // and {success:false} returns of every primitive; a thrown resume is
      // recorded as failed in the branch's catch. Engine is 'unknown-legacy' when
      // the primitive failed before it resolved one, or the pause predates provenance.
      const recordResume = (pauseKind: PauseKind, startedAt: number, result: TaskExecutionResult | null): void => {
        // An idempotent redelivery (lost claim / already-fired / still-pending) is
        // not a genuine resume attempt — skip so it never inflates the denominators.
        if (result?.resumeNoop) return;
        const engine = result?.executionEngine ?? 'unknown-legacy';
        recordResumeResult(engine, pauseKind, result?.success ? 'succeeded' : 'failed');
        recordResumeDurationMs(engine, pauseKind, Date.now() - startedAt);
      };

      // A run that reached its wall clock at a step boundary, picking up where
      // it stopped. Unlike every other kind here it is not waiting on anything:
      // it ran out of room, and this delivery IS the extra room.
      if (kind === 'run-continuation') {
        const startedAt = Date.now();
        const row = await agentScheduledInvocationsRepo.getById(workflowResume.scheduledInvocationId);
        const payload = row?.workflowResumePayload as unknown as {
          kind?: string; workflowId?: string; taskId?: string; resumeAtStepId?: string;
          stepOutput?: unknown; objective?: string; inputData?: Record<string, unknown>;
          perStepRecoveries?: Record<string, number>; totalRecoveries?: number;
          recoveryHistory?: Array<{ stepId: string; anomalyKind: string; decision: string; kind: 'fresh' | 'recovery_of_recovery' }>;
          stepOutputs?: Record<string, unknown>;
          enteredSteps?: string[];
          unsatisfiedSteps?: string[];
          salvagedSteps?: string[];
          salvageNotes?: Record<string, SalvageNote>;
          threadId?: string | null;
        } | null;
        if (!row || !payload || payload.kind !== 'run-continuation' || !payload.resumeAtStepId) {
          // Nothing to continue from. 200 so Cloud Tasks does not retry a task
          // whose state is gone; a retry would find the same nothing.
          logger.warn(
            { scheduledInvocationId: workflowResume.scheduledInvocationId },
            'Run-continuation task carried no usable payload',
          );
          return res.status(200).json({ resumed: false, reason: 'no_continuation_payload' });
        }
        // At-least-once delivery is the whole hazard here: a continuation runs
        // REAL STEPS, so a duplicate would re-send whatever the next step sends.
        // The status flip is the atomic claim -- it updates only a row that is
        // still pending and reports how many it changed.
        const claimed = await agentScheduledInvocationsRepo.markFiredByInvocationId(invocationId);
        if (claimed === 0) {
          return res.status(200).json({ resumed: false, reason: 'already_continued' });
        }
        try {
          const result = await agentExecutionService.resumeWorkflow({
            tenantId,
            agentId,
            // The continuation row is the durable carrier; the task body is the
            // legacy fallback. Absent stays absent — never a blank.
            workflowId: firstPresentId(payload.workflowId, workflowResume.workflowId),
            taskId: firstPresentId(payload.taskId, workflowResume.taskId),
            resumeAfterStepId: payload.resumeAtStepId,
            carryOverOutput: payload.stepOutput,
            invocationId,
            threadId: payload.threadId ?? undefined,
            carryOver: {
              objective: payload.objective ?? 'run-continuation',
              inputData: payload.inputData,
              perStepRecoveries: payload.perStepRecoveries ?? {},
              totalRecoveries: payload.totalRecoveries ?? 0,
              recoveryHistory: payload.recoveryHistory ?? [],
              // EVERY field the pause carried, through the writer's own key
              // list. Named one by one, this list had already lost `stepReplay`
              // (carried-resume-state.test.ts).
              ...readCarriedResumeState(payload as unknown as Record<string, unknown>),
            },
            // Somebody asked for this and is still waiting.
            deliverTo: { scheduledInvocationId: row.id },
            resumedFrom: { kind: 'continuation', scheduledInvocationId: row.id },
          });
          recordResume('continuation', startedAt, result);
          return res.status(200).json({ resumed: true, kind, ...result });
        } catch (err) {
          recordResume('continuation', startedAt, null);
          await agentScheduledInvocationsRepo.markErrored(row.id, (err as Error).message);
          logger.error({ err: (err as Error).message }, 'Run continuation failed');
          return res.status(500).json({ error: 'Run continuation failed' });
        }
      }

      // The continuation of a chat turn a bound closed: a thread-bound run
      // on the same thread, as the person whose message started the work.
      // The module owns the whole handoff (claim → the thread's lock →
      // recheck → run → deliver → chain); here only the delivery's place in
      // the queue is read, and a retry is asked for with a retryable status.
      // Background work a team set going rides the same rails: the same
      // row, the same queue, the same handoff. What differs is inside the
      // module — its own brief as the objective, and a person writing on the
      // thread does not cancel it.
      if (kind === 'chat-continuation' || kind === 'background-work') {
        const { runChatContinuationTask, isLastChatContinuationDelivery, CLOUD_TASKS_RETRY_COUNT_HEADER } = await import(
          '../interactive-chat/chat-continuation'
        );
        try {
          const outcome = await runChatContinuationTask({
            tenantId,
            scheduledInvocationId: workflowResume.scheduledInvocationId,
            lastDelivery: isLastChatContinuationDelivery(req.headers[CLOUD_TASKS_RETRY_COUNT_HEADER]),
          });
          if (outcome.status === 'retry') return res.status(503).json({ deferred: true, kind, ...outcome });
          return res.status(200).json({ resumed: outcome.status === 'done', kind, ...outcome });
        } catch (err) {
          logger.error({ err: (err as Error).message }, 'Chat continuation failed');
          return res.status(500).json({ error: 'Chat continuation failed' });
        }
      }

      // HITL approved / rejected: re-enter the hybrid loop via the
      // resumeFromHitlApproval primitive. The primitive itself decides
      // dispatch-vs-finalize based on the approval row's decision field,
      // so both kinds route to the same method; the kind on the task is
      // primarily for telemetry + future routing differentiation. See
      if (kind === 'hitl-approved' || kind === 'hitl-rejected') {
        const startedAt = Date.now();
        try {
          // The ids pass through as they are on the task body — present or
          // absent, never defaulted to a blank. Both feed uuid columns, where a
          // blank is a type error; the resume primitive recovers a missing id
          // from the pause payload or the approval row.
          const minimalContext = {
            tenantId, agentId,
            workflowId: workflowResume.workflowId,
            taskId: workflowResume.taskId,
            instructionVersion: 0,
            instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' },
            traceId: `resume-hitl-${kind}-${invocationId}`,
            agentType: 'agent' as const,
            hitlLevel: 3,
            modelConfig: {}, execConfig: {}, memoryScope: {},
            invocationId,
          };
          const result = await agentExecutionService.resumeFromHitlApproval(
            minimalContext as unknown as Parameters<typeof agentExecutionService.resumeFromHitlApproval>[0],
            workflowResume.scheduledInvocationId,
          );
          recordResume('hitl_approval', startedAt, result);
          // A deferred resume means the thread was busy (C3). The decision is
          // already recorded and the pause row is untouched, so 503 to make
          // Cloud Tasks retry — a 200 here would ack the task and strand the
          // run, which is the failure this whole path exists to prevent.
          //
          // Except when the resume RE-ARMED ITSELF (`resumeAt`): the retry is
          // already scheduled, and a 503 on top would spend the queue's five
          // quick attempts against the same outage and land duplicate
          // deliveries on a row that will only defer them again.
          if (result.deferred && result.resumeAt) return res.status(200).json({ deferred: true, rearmed: result.resumeAt, kind });
          if (result.deferred) return res.status(503).json({ deferred: true, kind });
          return res.status(200).json({ resumed: true, kind, ...result });
        } catch (err) {
          recordResume('hitl_approval', startedAt, null);
          await agentScheduledInvocationsRepo.markErrored(
            workflowResume.scheduledInvocationId,
            (err as Error).message,
          );
          logger.error({ err: (err as Error).message, kind }, 'HITL resume failed');
          return res.status(500).json({ error: `HITL resume failed (${kind})` });
        }
      }

      // HITL 24h expiry: operator never decided — finalize the row +
      // approval as expired + emit SSE. Idempotent against operator
      // having decided between arm and fire (the row is fired_at != null
      // and the helper short-circuits).
      if (kind === 'hitl-expiry') {
        try {
          const { finalizeHitlExpired } = await import('../agent-execution/hitl-expiry-helpers');
          const result = await finalizeHitlExpired({
            tenantId, agentId, invocationId,
            scheduledInvocationId: workflowResume.scheduledInvocationId,
          });
          // Recovery backstop: the operator decided before expiry but the
          // resume task was never delivered. Route through the resume primitive
          // (dispatch approved / continue-and-adapt rejected) instead of letting
          // the action lapse. resumeFromHitlApproval re-checks fired_at, so it's
          // safe against a late delivery of the original resume task.
          if (result.reason === 'decided_pending_resume') {
            // Same contract as the primary branch: ids pass through, never
            // defaulted to a blank.
            const minimalContext = {
              tenantId, agentId,
              workflowId: workflowResume.workflowId,
              taskId: workflowResume.taskId,
              instructionVersion: 0,
              instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' },
              traceId: `resume-hitl-recovered-${invocationId}`,
              agentType: 'agent' as const,
              hitlLevel: 3,
              modelConfig: {}, execConfig: {}, memoryScope: {},
              invocationId,
            };
            const recovered = await agentExecutionService.resumeFromHitlApproval(
              minimalContext as unknown as Parameters<typeof agentExecutionService.resumeFromHitlApproval>[0],
              workflowResume.scheduledInvocationId,
            );
            // Same deferral contract as the primary branch above.
            if (recovered.deferred) return res.status(503).json({ deferred: true, kind });
            return res.status(200).json({ kind, recovered: true, ...recovered });
          }
          return res.status(200).json({ kind, ...result });
        } catch (err) {
          logger.error({ err: (err as Error).message }, 'HITL expiry finalization failed');
          return res.status(500).json({ error: 'HITL expiry finalization failed' });
        }
      }

      if (kind === 'delegation-resolved' || kind === 'delegation-expiry') {
        const parentTaskId = (workflowResume as { parentTaskId?: string }).parentTaskId ?? '';
        if (kind === 'delegation-expiry') {
          // orphan backstop: only resume if children are actually all-terminal; else fail the graph's stragglers.
          const { CoordinatorService } = await import('../coordinator/service');
          await new CoordinatorService().expireGraphIfStuck(parentTaskId);   // small helper: fail non-terminal children, then fall through to resume
        }
        // The ids are recovered by the resume primitive from the pause row; the
        // task body carries none, so none are passed — never a blank.
        const minimalContext = { tenantId, agentId, instructionVersion: 0,
          instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' }, traceId: `resume-deleg-${invocationId}`,
          agentType: 'agent' as const, hitlLevel: 3, modelConfig: {}, execConfig: {}, memoryScope: {}, invocationId };
        const delegStartedAt = Date.now();
        const result = await agentExecutionService.resumeFromDelegation(
          minimalContext as unknown as Parameters<typeof agentExecutionService.resumeFromDelegation>[0],
          workflowResume.scheduledInvocationId, parentTaskId);
        recordResume('delegation', delegStartedAt, result);
        return res.status(200).json({ resumed: true, kind, ...result });
      }

      // Self-wake resume (timer/event/job/poll/expiry) → resumeFromWake. The primitive owns the
      // fenced lease + admission + settlement split; it decides release (retryable) vs errored, so we
      // do NOT markErrored here.
      if (kind === 'wake-timer' || kind === 'wake-event' || kind === 'wake-job'
          || kind === 'wake-poll' || kind === 'wake-expiry') {
        const startedAt = Date.now();
        try {
          const minimalContext = {
            tenantId, agentId,
            // Normalized pass-through; the wake resume recovers the real ids from its row.
            workflowId: firstPresentId(workflowResume.workflowId),
            taskId: firstPresentId(workflowResume.taskId),
            instructionVersion: 0,
            instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' },
            traceId: `resume-wake-${kind}-${invocationId}`, agentType: 'agent' as const, hitlLevel: 3,
            modelConfig: {}, execConfig: {}, memoryScope: {}, invocationId,
          };
          const result = await agentExecutionService.resumeFromWake(
            minimalContext as unknown as Parameters<typeof agentExecutionService.resumeFromWake>[0],
            workflowResume.scheduledInvocationId,
            kind,
            workflowResume.wakePayload ?? {},
          );
          recordResume('self_wake', startedAt, result);
          // A deferred resume (agent-lock contention / admission / rate-limit — the lease was released
          // back to pending) must be RETRIED: return a retryable status so Cloud Tasks re-drives the
          // same resume with backoff, rather than 200 (which would drop it).
          if (result.deferred) return res.status(503).json({ deferred: true, kind });
          return res.status(200).json({ resumed: true, kind, ...result });
        } catch (err) {
          recordResume('self_wake', startedAt, null);
          logger.error({ err: (err as Error).message, kind }, 'Wake resume failed');
          return res.status(500).json({ error: `Wake resume failed (${kind})` });
        }
      }

      // Wait-set resume (wake_on_any / wake_on_all): a member fired (wake-waitset) or the whole set
      // timed out (wake-waitset-expiry) → resumeWaitSet. Owns its own fenced lease + settlement split.
      if (kind === 'wake-waitset' || kind === 'wake-waitset-expiry') {
        const startedAt = Date.now();
        try {
          const minimalContext = {
            tenantId, agentId,
            // Normalized pass-through; the wake resume recovers the real ids from its row.
            workflowId: firstPresentId(workflowResume.workflowId),
            taskId: firstPresentId(workflowResume.taskId),
            instructionVersion: 0,
            instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' },
            traceId: `resume-waitset-${kind}-${invocationId}`, agentType: 'agent' as const, hitlLevel: 3,
            modelConfig: {}, execConfig: {}, memoryScope: {}, invocationId,
          };
          const result = await agentExecutionService.resumeWaitSet(
            minimalContext as unknown as Parameters<typeof agentExecutionService.resumeWaitSet>[0],
            workflowResume.waitSetId ?? '',
            { firedKind: workflowResume.firedKind, payload: workflowResume.wakePayload ?? {}, expiry: kind === 'wake-waitset-expiry' },
          );
          recordResume('self_wake', startedAt, result);
          // Deferred (contention / admission / rate-limit) → retry via Cloud Tasks, don't drop.
          if (result.deferred) return res.status(503).json({ deferred: true, kind });
          return res.status(200).json({ resumed: true, kind, ...result });
        } catch (err) {
          recordResume('self_wake', startedAt, null);
          logger.error({ err: (err as Error).message, kind }, 'Wait-set resume failed');
          return res.status(500).json({ error: `Wait-set resume failed (${kind})` });
        }
      }

      if (kind === 'clarification-answered') {
        // D17: re-enter the hybrid loop with the user's answer.
        const startedAt = Date.now();
        try {
          // Recovered by the resume primitive from the pause row; none passed here.
          const minimalContext = {
            tenantId,
            agentId,
            instructionVersion: 0,
            instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' },
            traceId: `resume-clarification-${invocationId}`,
            agentType: 'agent' as const,
            hitlLevel: 3,
            modelConfig: {},
            execConfig: {},
            memoryScope: {},
            invocationId,
          };
          const result = await agentExecutionService.resumeFromClarificationAnswer(
            minimalContext as unknown as Parameters<typeof agentExecutionService.resumeFromClarificationAnswer>[0],
            workflowResume.scheduledInvocationId,
            workflowResume.userAnswer ?? '',
          );
          recordResume('ask_user', startedAt, result);
          // `resumed: true` used to go out unconditionally, spread over a result
          // that could say `success: false` two keys later. Cloud Tasks read the
          // 200 as delivered and never retried, the ask was already consumed by
          // the resume, and the person's answer was gone with nothing logged
          // above INFO and nothing said in the thread. A resume that did not
          // happen is not a resume.
          if (!result.success) {
            const outcome = await agentScheduledInvocationsRepo.releaseFailedClarificationResume(
              workflowResume.scheduledInvocationId,
              result.error ?? 'clarification resume returned success: false',
            );
            logger.error({
              scheduledInvocationId: workflowResume.scheduledInvocationId,
              error: result.error,
              released: outcome.released,
              exhausted: outcome.exhausted,
            }, 'Clarification-answered resume did not run');
            // Released means the ask is claimable again, so ask Cloud Tasks to
            // come back. Exhausted means it never will be: report it as handled
            // so the queue stops, having errored the row so the thread is not
            // left routing every later message into a resume that cannot work.
            return outcome.released
              ? res.status(500).json({ resumed: false, error: result.error })
              : res.status(200).json({ resumed: false, exhausted: outcome.exhausted, error: result.error });
          }
          return res.status(200).json({ resumed: true, ...result });
        } catch (err) {
          recordResume('ask_user', startedAt, null);
          // Back to 'pending', not 'errored'. The 500 below asks Cloud Tasks to
          // retry, and the resume only accepts a row in 'pending' or
          // 'resume_inflight' — marking it errored here would make the first
          // failure permanent. Leaving it in 'resume_inflight' was worse still:
          // markErrored matches only 'pending' so it did nothing at all, and
          // the ask vanished from the queue for good once the retries ran out.
          await agentScheduledInvocationsRepo.releaseFailedClarificationResume(
            workflowResume.scheduledInvocationId,
            (err as Error).message,
          );
          logger.error({ err: (err as Error).message }, 'Clarification-answered resume failed');
          return res.status(500).json({ error: 'Clarification-answered resume failed' });
        }
      }

      if (kind === 'clarification-expiry') {
        // The window closing is only news if nobody used it.
        //
        // Nothing cancels this task when the ask is settled: answering or
        // declining moves the row on, but the timer created at pause time
        // still fires at its hour. Until this guard, that fire ran the whole
        // expiry path regardless — `markFiredByInvocationId` matched no rows
        // (the row was no longer 'pending') and the handler ignored that and
        // filed "Clarification request expired without answer (24h)" anyway.
        // Every answered question left a false record behind, and because
        // `workflow_escalations` dedups on (tenant, agent, kind) while one is
        // open, a false record could absorb a real one.
        //
        // A row that is no longer 'pending' was settled by somebody. There is
        // nothing to expire.
        if (workflowResume.scheduledInvocationId) {
          const settledCheck = await agentScheduledInvocationsRepo.getById(
            workflowResume.scheduledInvocationId as string,
          );
          if (settledCheck && settledCheck.status !== 'pending') {
            logger.info(
              { id: settledCheck.id, status: settledCheck.status, tenantId, agentId },
              'Clarification expiry fired after the ask was settled; nothing to expire',
            );
            return res.status(200).json({ expired: false, reason: 'already_settled' });
          }
        }

        // PR2: branch on clarification_source. anchor_intervention rows have no
        // workflow to escalate — Anchor self-terminated long before 24h. Just
        // mark fired and log.
        try {
          const row = workflowResume.scheduledInvocationId
            ? await agentScheduledInvocationsRepo.getById(workflowResume.scheduledInvocationId as string)
            : null;
          if (row?.clarificationSource === 'anchor_intervention') {
            // Records the outcome (migration 419) in the same statement that
            // marks the row fired: an expiry is a resolution too.
            await agentScheduledInvocationsRepo.markClarificationExpiredById(row.id);
            logger.info(
              { id: row.id, vendorRequestId: row.vendorRequestId },
              'anchor_intervention clarification expired without response (Anchor self-timed-out)',
            );
            return res.status(200).json({ expired: true, source: 'anchor_intervention' });
          }
        } catch (e) {
          logger.warn({ err: (e as Error).message }, 'clarification-source branch failed; falling through to recovery_llm path');
        }
        // A2: a blocker does not expire into a record the customer cannot see.
        //
        // The rule below turns an unanswered clarification into a
        // `system_internal` escalation, which is right for a question: the
        // moment has passed, the context is stale, and nobody outside the
        // platform needs to know it lapsed. It is wrong for a blocker. "Share
        // the sheet with the service account" is still true when the window
        // closes, and downgrading it moves a live, customer-clearable request
        // into a record only operators can read — the run is abandoned and the
        // person who could have fixed it is told nothing.
        //
        // So a blocker's window closes the ASK, not the NEED. The row is marked
        // fired, which clears the dedup, and the agent's next tick re-parks the
        // blocker and notifies again through the normal path. Nothing is hidden
        // and nothing is held open forever.
        try {
          const expiringRow = workflowResume.scheduledInvocationId
            ? await agentScheduledInvocationsRepo.getById(workflowResume.scheduledInvocationId as string)
            : null;
          if (expiringRow?.clarificationOrigin === 'blocker') {
            await agentScheduledInvocationsRepo.markClarificationExpiredById(expiringRow.id);
            logger.info(
              { id: expiringRow.id, agentId, tenantId },
              'Blocker clarification window lapsed without an answer; the next run re-raises it',
            );
            return res.status(200).json({ expired: true, origin: 'blocker' });
          }
        } catch (e) {
          logger.warn(
            { err: (e as Error).message },
            'clarification-origin branch failed; falling through to the question path',
          );
        }
        // D14 + D16: 24h elapsed with no user answer → cap-exhausted internal
        // escalation. The row itself is marked fired by the standard prologue
        // (markFiredByInvocationId below in the delay path); here we run
        // explicitly so the order of mark + escalate is well-defined.
        //
        // The row count is the second half of the settled guard above, and the
        // only one available when the task carries no scheduledInvocationId:
        // this UPDATE matches 'pending' alone, so zero rows means the ask was
        // already answered or declined and there is nothing to expire. The
        // expiry-specific operation also records the outcome (migration 419);
        // the generic markFiredByInvocationId stays for the delay path below.
        const expiredRowCount = await agentScheduledInvocationsRepo.markClarificationExpiredByInvocationId(invocationId);
        if (expiredRowCount === 0) {
          logger.info(
            { invocationId, tenantId, agentId },
            'Clarification expiry fired but no pending row remained; nothing to expire',
          );
          return res.status(200).json({ expired: false, reason: 'already_settled' });
        }
        try {
          const { createEscalation } = await import('../agent-execution/engine/escalation-helper');
          // The ids pass through present-or-absent. An interactive-chat
          // clarification may have no workflow at all; createEscalation resolves
          // the identity its rows require at its own boundary.
          const minimalContext = {
            tenantId,
            agentId,
            workflowId: firstPresentId(workflowResume.workflowId),
            taskId: firstPresentId(workflowResume.taskId),
            instructionVersion: 0,
            instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' },
            traceId: `clarification-expiry-${invocationId}`,
            agentType: 'agent' as const,
            hitlLevel: 3,
            modelConfig: {},
            execConfig: {},
            memoryScope: {},
            invocationId,
          };
          await createEscalation(
            minimalContext as unknown as Parameters<typeof createEscalation>[0],
            'Clarification request expired without answer (24h)',
            {
              kind: 'system_internal',
              fingerprint: 'expiry:clarification',
              // No instructionVersion: the minimal context above carries 0,
              // which is not a real version, and passing it would dedupe every
              // version into one row. Left NULL it dedupes only against other
              // expiry rows, which is what this site did before fingerprints.
            },
          );
          return res.status(200).json({ expired: true });
        } catch (err) {
          logger.error({ err: (err as Error).message }, 'Clarification-expiry escalation failed');
          return res.status(500).json({ error: 'Clarification-expiry escalation failed' });
        }
      }

      // Default ('delay'): existing workflow-delay resume contract.
      await agentScheduledInvocationsRepo.markFiredByInvocationId(invocationId);
      const delayStartedAt = Date.now();
      // The state lives on the ROW now: a task body is capped at 100KB and the
      // carried step-output registry can exceed it. The body remains the
      // fallback so a task enqueued before this landed still resumes.
      const delayRow = workflowResume.scheduledInvocationId
        ? await agentScheduledInvocationsRepo.getById(workflowResume.scheduledInvocationId)
        : null;
      const delayPayload = (delayRow?.workflowResumePayload ?? null) as {
        kind?: string; workflowId?: string; taskId?: string; resumeAfterStepId?: string; stepOutput?: unknown;
        stepOutputs?: Record<string, unknown>; enteredSteps?: string[];
        unsatisfiedSteps?: string[]; perStepRecoveries?: Record<string, number>;
        salvagedSteps?: string[];
        salvageNotes?: Record<string, SalvageNote>;
        totalRecoveries?: number;
        recoveryHistory?: Array<{ stepId: string; anomalyKind: string; decision: string; kind: 'fresh' | 'recovery_of_recovery' }>;
      } | null;
      const fromRow = delayPayload?.kind === 'workflow-delay' ? delayPayload : null;
      try {
        const result = await agentExecutionService.resumeWorkflow({
          tenantId,
          agentId,
          // The delay row persisted the run's ids when it was armed; the task
          // body is the legacy carrier and is read only when the row has none.
          workflowId: firstPresentId(fromRow?.workflowId, workflowResume.workflowId),
          taskId: firstPresentId(fromRow?.taskId, workflowResume.taskId),
          resumeAfterStepId: fromRow?.resumeAfterStepId ?? workflowResume.resumeAfterStepId ?? '',
          carryOverOutput: fromRow ? fromRow.stepOutput : workflowResume.stepOutput,
          // Present only for a delay armed after the registry started being
          // carried; an older row resumes exactly as it did.
          // State only. A delay is a wait the workflow chose; nobody is sitting
          // in a thread waiting for it, so no deliverTo.
          ...(fromRow
            ? {
              carryOver: {
                perStepRecoveries: fromRow.perStepRecoveries,
                totalRecoveries: fromRow.totalRecoveries,
                recoveryHistory: fromRow.recoveryHistory,
                stepOutputs: fromRow.stepOutputs,
                enteredSteps: fromRow.enteredSteps,
                unsatisfiedSteps: fromRow.unsatisfiedSteps,
                salvagedSteps: fromRow.salvagedSteps,
                salvageNotes: fromRow.salvageNotes,
              },
            }
            : {}),
          // The invocation this delay resumes. Its ExecutionContext previously
          // carried no run identity at all, which left sandbox dispatch with
          // nothing to key a workspace on.
          invocationId,
          ...(workflowResume.scheduledInvocationId
            ? { resumedFrom: { kind: 'delay' as const, scheduledInvocationId: workflowResume.scheduledInvocationId } }
            : {}),
        });
        recordResume('delay', delayStartedAt, result);
        return res.status(200).json({ resumed: true, ...result });
      } catch (err) {
        recordResume('delay', delayStartedAt, null);
        await agentScheduledInvocationsRepo.markErrored(
          workflowResume.scheduledInvocationId,
          (err as Error).message,
        );
        logger.error({ err: (err as Error).message, workflowId: workflowResume.workflowId }, 'Workflow resume failed');
        return res.status(500).json({ error: 'Workflow resume failed' });
      }
    }

    // SDK-engine HITL approval resume is retired. The hybrid loop's
    // pause/resume contract supersedes the EngineSessionStore sessionRef
    // format; any legacy engine_sessions row is now an orphan that bails
    // to a 410 instead of resuming. The user needs to re-trigger their
    // HITL approval, which routes through the adapter and the hybrid
    // loop's own resume primitives.
    //
    // Workflow-delay + clarification-expiry resumes (above) already route
    // through the hybrid loop and continue to work; only the
    // session-store-keyed approval-resume code path is gone.
    //
    // 410 Gone signals the orphaned-session condition to the caller (the
    // operator-plane HITL UI), which can then prompt the user to redo
    // the action.
    logger.warn(
      { invocationId, agentId },
      'resume-execution: legacy SDK-engine session resume retired; returning 410',
    );
    return res.status(410).json({
      error: 'SDK-engine session resume retired',
      detail:
        'This pause was created under the legacy SDK engine path. The ' +
        'engine_sessions sessionRef format is no longer replayable. ' +
        'Please re-trigger the original action; the new invocation will ' +
        'pause + resume through the adapter pathway.',
    });
  } catch (error) {
    logger.error({ error }, 'Resume execution failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks/memory-cleanup - Run memory garbage collection for a tenant
// Phase 8.5D: Triggered by Cloud Scheduler
router.post('/memory-cleanup', async (req: Request, res: Response) => {
  try {
    const isValid = await verifyCloudTasksOidc(req);
    if (!isValid) {
      const internalSecret = req.headers['x-internal-secret'];
      if (internalSecret !== process.env.INTERNAL_SERVICE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const body = typeof req.body === 'string'
      ? JSON.parse(Buffer.from(req.body, 'base64').toString())
      : req.body;

    const tenantId = body.tenantId || req.headers['x-tenant-id'];
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    const { runMemoryCleanup } = require('../learning/memory-cleanup-service');
    const result = await runMemoryCleanup(tenantId);

    return res.status(200).json(result);
  } catch (error) {
    logger.error({ error }, 'Memory cleanup failed');
    return res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/tasks/memory-summarization-daily — Change C: per-tenant daily L1 summarization.
router.post('/memory-summarization-daily', async (req: Request, res: Response) => {
  try {
    const isValid = await verifyCloudTasksOidc(req);
    if (!isValid) {
      const internalSecret = req.headers['x-internal-secret'];
      if (internalSecret !== process.env.INTERNAL_SERVICE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const body = typeof req.body === 'string'
      ? JSON.parse(Buffer.from(req.body, 'base64').toString())
      : req.body;
    const tenantId = body.tenantId || req.headers['x-tenant-id'];
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

    const { runDailySummarization } = require('../scheduling/memory-summarization-loop');
    const result = await runDailySummarization(tenantId);
    return res.status(200).json(result);
  } catch (error) {
    logger.error({ error }, 'Daily summarization failed');
    return res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/tasks/memory-summarization-weekly — Change C: per-tenant weekly L2 summarization.
router.post('/memory-summarization-weekly', async (req: Request, res: Response) => {
  try {
    const isValid = await verifyCloudTasksOidc(req);
    if (!isValid) {
      const internalSecret = req.headers['x-internal-secret'];
      if (internalSecret !== process.env.INTERNAL_SERVICE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const body = typeof req.body === 'string'
      ? JSON.parse(Buffer.from(req.body, 'base64').toString())
      : req.body;
    const tenantId = body.tenantId || req.headers['x-tenant-id'];
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

    const { runWeeklySummarization } = require('../scheduling/memory-summarization-loop');
    const result = await runWeeklySummarization(tenantId);
    return res.status(200).json(result);
  } catch (error) {
    logger.error({ error }, 'Weekly summarization failed');
    return res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/tasks/memory-metrics-flush — flush in-process counters/histograms
// to Cloud Monitoring. Triggered by Cloud Scheduler every 60s.
router.post('/memory-metrics-flush', async (req: Request, res: Response) => {
  try {
    const isValid = await verifyCloudTasksOidc(req);
    if (!isValid) {
      const internalSecret = req.headers['x-internal-secret'];
      if (internalSecret !== process.env.INTERNAL_SERVICE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
    const { flushMemoryMetrics } = require('../memory/metrics');
    const result = await flushMemoryMetrics();
    return res.status(200).json(result);
  } catch (error) {
    logger.error({ error }, 'Memory metrics flush failed');
    return res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/tasks/embedding-cache-cleanup — Change E: global embedding-cache LRU sweep.
router.post('/embedding-cache-cleanup', async (req: Request, res: Response) => {
  try {
    const isValid = await verifyCloudTasksOidc(req);
    if (!isValid) {
      const internalSecret = req.headers['x-internal-secret'];
      if (internalSecret !== process.env.INTERNAL_SERVICE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const { runEmbeddingCacheCleanup } = require('../learning/memory-cleanup-service');
    const result = await runEmbeddingCacheCleanup();
    return res.status(200).json(result);
  } catch (error) {
    logger.error({ error }, 'Embedding cache cleanup failed');
    return res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/tasks/reconcile-lifecycles - Reconcile agents.lifecycle vs cached_internal_agents.status
// Triggered periodically by Cloud Scheduler to heal any drift. Canonical source of truth is the
// platform backend's internal_agents.status, mirrored into cached_internal_agents.
router.post('/reconcile-lifecycles', async (req: Request, res: Response) => {
  try {
    const isValid = await verifyCloudTasksOidc(req);
    if (!isValid) {
      const internalSecret = req.headers['x-internal-secret'];
      if (internalSecret !== process.env.INTERNAL_SERVICE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const { reconcileAllAgents } = require('../agent-lifecycle/drift-reconciler');
    const result = await reconcileAllAgents();

    return res.status(200).json(result);
  } catch (error) {
    logger.error({ error }, 'Lifecycle reconciliation failed');
    return res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/tasks/deferred-execution — receiver for defer-on-contention retries. NO advisory lock
// (row lock + defer serializes); forwards full payload incl. inputData. 200 for any handled outcome
// (ran / re-deferred / dead-lettered); 500 only on unexpected error.
router.post('/deferred-execution', async (req: Request, res: Response) => {
  try {
    if (!(await verifyCloudTasksOidc(req))) return res.status(401).json({ error: 'Unauthorized' });
    const p: CloudTaskPayload = typeof req.body === 'string' ? JSON.parse(Buffer.from(req.body,'base64').toString()) : req.body;
    if (!p.tenantId || !p.agentId || !p.objective) return res.status(400).json({ error: 'Missing required fields' });
    setTraceContext({ tenantId: p.tenantId, agentId: p.agentId });
    const taskName = req.headers['x-cloudtasks-taskname'] as string | undefined;
    const result = await agentExecutionService.executeTask({
      tenantId: p.tenantId, agentId: p.agentId, workflowId: p.workflowId || uuidv4(), taskId: p.taskId || uuidv4(),
      objective: p.objective, inputData: p.inputData, threadId: p.threadId,
      triggeredBy: (p.triggeredBy as 'human'|'agent'|'cron'|'event') || 'event', triggeredByLabel: p.triggeredByLabel,
      triggeredByUserId: p.triggeredByUserId,
      triggerKey: p.triggerKey ?? taskName, deferAttempt: p.deferAttempt, onConflict: p.onConflict ?? 'defer',
      trigger: p.trigger, trustLevel: p.trustLevel, hitlLevel: p.hitlLevel, escalation: p.escalation,
    });
    if (p.threadId && !result.deferred) {
      await invocationsService.updateThreadStatus(p.threadId, p.tenantId,
        THREAD_STATUS_BY_TERMINAL[resolveTerminalState(result, false)]
      ).catch(err => logger.warn({ err: (err as Error).message }, 'deferred-execution thread status update failed'));
    }
    logger.info('Deferred execution handled', { tenant_id: p.tenantId, agent_id: p.agentId, success: result.success, deferred: result.deferred === true, defer_attempt: p.deferAttempt });
    return res.status(200).json({ success: result.success, deferred: result.deferred === true });
  } catch (error) {
    logger.error('Deferred execution failed', { error: (error as Error).message });
    return res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/tasks/health - Health check for Cloud Tasks
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({ status: 'healthy' });
});

export { router as cloudTasksHandler };
