// Scheduled Invoke Handler
// Per implementation plan Phase 2.2: Cloud Scheduler invoke endpoint
// POST /api/execution/scheduled-invoke - Called by Cloud Scheduler jobs

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { agentExecutionService } from '../agent-execution/service';
import { invocationsService } from '../invocations/service';
import { logger } from '../infrastructure/logging';
import { setTraceContext } from '../infrastructure/safe-trace-context';
import { verifyOidcToken } from '../infrastructure/oidc';
import { getPoolForService, withTenantScope } from '../infrastructure/database';
import { forEachTenant } from '../infrastructure/tenant-registry';
import { enqueueAgentExecution } from '../infrastructure/cloud-tasks';
import { resolveTerminalState, THREAD_STATUS_BY_TERMINAL } from '../agent-execution/terminal-state';
import { catchupWindowMs, estimateCronPeriodMs, tickAgeMs } from '../scheduling/catchup-clamp';
import { recordRoutineOutcome } from '../scheduling/routine-failure-state';
import { connectorEventTrigger } from '../agent-lifecycle/types';
import {
  logRoutineScript,
  noAgentReply,
  objectiveWithScriptOutput,
  parseRoutineScript,
  runRoutineScript,
} from './routine-script';

const router = Router();

// Dedicated pool for scheduled execution — isolated from event subscriber
const scheduledPool = getPoolForService('scheduled-execution');

interface ScheduledInvokePayload {
  tenantId: string;
  agentId: string;
  triggeredBy?: string;
  /** `companion:<label>` for a per-routine job. Cloud Scheduler bakes it into
   *  the body (cloud-scheduler.ts) and it identifies WHICH routine is firing —
   *  every companion job for an agent hits this one endpoint. */
  triggeredByLabel?: string;
}

/** The label form the scheduler bakes in is `companion:<label>`; the label as
 *  the distiller wrote it is the part after the colon. */
function companionLabelFrom(triggeredByLabel: string | undefined): string | undefined {
  if (!triggeredByLabel) return undefined;
  const m = /^companion:(.+)$/.exec(triggeredByLabel);
  return m ? m[1] : undefined;
}

interface CompanionCron {
  label?: string;
  cronExpr?: string;
  objective?: string;
  contextFromLabel?: string;
  /** A command this routine runs before (or instead of) the model. See
   *  routine-script.ts — mechanical work should not cost a model call. */
  script?: unknown;
  /** True when the script IS the job and no model should run at all. */
  noAgent?: boolean;
  /** Where this routine's work comes from.
   *
   *  A companion cron runs the same workflow graph as the agent's primary
   *  trigger, and a cron fire carries no `input`. An event-shaped graph — one
   *  whose first step reads `{{input.message.threadId}}` — therefore fails
   *  step 1 on every companion fire and takes the author's onFailure branch.
   *  Declaring a workSource makes the routine resolve its items first and run
   *  the graph once per item with a synthesized `input.message`, the same
   *  envelope the event path builds. */
  workSource?: {
    /** Listing tool, e.g. `google-mail-14a82d9e__list_messages`. */
    toolName: string;
    /** Arguments for the listing call. */
    toolArgs?: Record<string, unknown>;
    /** Dot-path to the array in the tool result, e.g. `messages`. */
    itemsPath: string;
    /** Connector source for the envelope builder, e.g. `google_mail`. */
    source: string;
    /** Safety cap on fan-out per fire. */
    maxItems?: number;
  };
}

/** F3 — the objective for THIS fire.
 *
 *  Every companion job posts to the same endpoint, so without the label all of
 *  an agent's routines ran the top-level objective and the per-routine
 *  objectives the distiller wrote were never honored at fire time. The label
 *  picks the right one; the top-level objective remains the fallback for the
 *  primary (non-companion) schedule and for a label with no objective of its
 *  own. */
async function getScheduledObjective(
  tenantId: string,
  agentId: string,
  triggeredByLabel?: string,
): Promise<{ objective: string; companion?: CompanionCron }> {
  const pool = scheduledPool;

  // Try to get objective from agent's trigger_config
  const result = await pool.query(
    `SELECT trigger_config, name FROM agents WHERE id = $1 AND tenant_id = $2`,
    [agentId, tenantId]
  );

  if (result.rows.length === 0) {
    return { objective: 'Execute scheduled autonomous task' };
  }

  const triggerConfig = result.rows[0].trigger_config;
  const agentName = result.rows[0].name;

  const label = companionLabelFrom(triggeredByLabel);
  let companion: CompanionCron | undefined;
  if (label) {
    const crons: CompanionCron[] = Array.isArray(triggerConfig?.companionCrons)
      ? triggerConfig.companionCrons
      : [];
    companion = crons.find((c) => c?.label === label);
    if (companion?.objective) {
      return { objective: companion.objective, companion };
    }
  }

  if (triggerConfig?.objective) {
    return { objective: triggerConfig.objective, companion };
  }

  return { objective: `Execute scheduled task for agent: ${agentName}`, companion };
}

/** F4 — is this routine already running?
 *
 *  Tick dedup is per-tick (a minute-truncated scheduleKey plus Cloud Tasks
 *  ALREADY_EXISTS), which stops the SAME tick firing twice but says nothing
 *  about tick N+1 arriving while tick N is still working. A five-minute routine
 *  on a one-minute schedule stacks up runs that fight over the same state.
 *
 *  An in-flight run is one with no outcome yet. There is deliberately no time
 *  bound on that: bounding it would let a genuinely long run double-fire, and
 *  a run that died without settling is already the stalled-run reconciler's
 *  job — it owns exactly these rows (top-level cron/event) and completes them
 *  as `stalled`, at which point this guard opens again on its own. */
async function routineIsAlreadyRunning(
  tenantId: string,
  agentId: string,
  triggeredByLabel: string | undefined,
): Promise<boolean> {
  // Only per-routine jobs carry a label. The primary schedule has none, and
  // guarding it on agent id alone would block unrelated work.
  if (!triggeredByLabel) return false;
  try {
    // RUNTIME_AGENT_ID_OK: the payload comes from a Cloud Scheduler job this
    // service creates itself (cloud-scheduler.ts, from agents.id via
    // ensureSchedulerJob), so agentId is already runtime-space. The same value
    // gates the run a few lines up against `agents a WHERE a.id = $1`, which
    // would skip every tick as "agent not found" if it were a control-plane id.
    const r = await scheduledPool.query(
      `SELECT 1 FROM invocations
        WHERE tenant_id = $1::uuid AND agent_id = $2 AND triggered_by_label = $3
          AND outcome IS NULL AND completed_at IS NULL
        LIMIT 1`,
      [tenantId, agentId, triggeredByLabel],
    );
    return r.rows.length > 0;
  } catch (err) {
    // Fail open: a failed lookup must not silently stop a routine from running.
    logger.warn(
      { err: (err as Error).message, tenant_id: tenantId, agent_id: agentId, triggeredByLabel },
      'routine overlap check failed (non-fatal — running the tick)',
    );
    return false;
  }
}

/** Prepend the named sibling routine's last completed run, when this routine
 *  declares one. Silent no-op when the sibling has never completed — a chain
 *  whose upstream has not run yet is a normal first day, not an error. */
async function appendChainedContext(
  tenantId: string,
  agentId: string,
  objective: string,
  contextFromLabel: string | undefined,
): Promise<string> {
  if (!contextFromLabel) return objective;
  try {
    const siblingLabel = `companion:${contextFromLabel}`;
    const prior = await invocationsService.getLatestCompletedByLabel(tenantId, agentId, siblingLabel);
    if (!prior) {
      logger.info(
        { tenant_id: tenantId, agent_id: agentId, contextFromLabel },
        'routine chaining: no completed sibling run yet',
      );
      return objective;
    }
    const { buildPriorInvocationSummary } = await import('../agent-execution/service');
    const summary = buildPriorInvocationSummary(prior);
    if (!summary) return objective;
    logger.info(
      { tenant_id: tenantId, agent_id: agentId, contextFromLabel, priorInvocationId: prior.id },
      'routine chaining: folded in the sibling routine last run',
    );
    return `${objective}\n${summary}`;
  } catch (err) {
    // Chaining is context, not correctness. A failed lookup runs the routine
    // without the extra context rather than skipping the tick.
    logger.warn(
      { err: (err as Error).message, tenant_id: tenantId, agent_id: agentId, contextFromLabel },
      'routine chaining: sibling lookup failed (non-fatal)',
    );
    return objective;
  }
}

// POST /api/execution/scheduled-invoke
router.post('/scheduled-invoke', async (req: Request, res: Response) => {
  try {
    // Verify OIDC token from Cloud Scheduler
    const isValid = await verifyOidcToken(req);
    if (!isValid) {
      // SE-004: Dev bypass only in non-production environments
      if (process.env.NODE_ENV !== 'production') {
        const internalSecret = req.headers['x-internal-secret'];
        if (internalSecret === process.env.INTERNAL_SERVICE_SECRET) {
          logger.warn('Using dev auth bypass - not for production', {
            path: req.path,
          });
          // Continue to handler
        } else {
          return res.status(401).json({ error: 'Unauthorized' });
        }
      } else {
        // Production: OIDC only, no bypass
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    // Extract payload
    let payload: ScheduledInvokePayload;

    if (typeof req.body === 'string') {
      // Base64 encoded body
      payload = JSON.parse(Buffer.from(req.body, 'base64').toString());
    } else {
      payload = req.body;
    }

    // Validate required fields
    if (!payload.tenantId || !payload.agentId) {
      return res.status(400).json({
        error: 'Missing required fields: tenantId, agentId',
      });
    }

    // WS-1.2 — bind tenant_id at the scheduled-invoke boundary so the agent
    // execution chain logs with attribution from this point on.
    //
    // agentId belongs here too, and its absence cost real debugging time. The
    // trace context is the ONLY thing that puts an agent on a plain `logger.*`
    // line; the middleware sets it from an `x-agent-id` header, which a
    // scheduler POST does not carry. So an autonomous run emitted `tenant_id`
    // and nothing else, and the line naming a failed step and its error —
    // `workflow step failed and routed to its onFailure branch` — was
    // unreachable by any agent-scoped query, under either spelling. It read as
    // missing telemetry. It was unattributed telemetry.
    setTraceContext({ tenantId: payload.tenantId, agentId: payload.agentId });

    logger.info('Scheduled invoke started', {
      tenant_id: payload.tenantId,
      agent_id: payload.agentId,
      triggered_by: payload.triggeredBy || 'scheduler',
    });

    // L3 entitlement check (see src/index.ts kill-switch comment for the
    // three-layer enforcement model). Verify both tenant entitlement AND
    // agent lifecycle before doing any DB-heavy work. This is the last-line
    // defense for tenant suspension — the primary stop is the Cloud Scheduler
    // pause flow (L1), but a tenant can be suspended in the brief window
    // between the suspension event and the scheduler job being paused.
    // Returns 200 with skipped:true so Cloud Scheduler does NOT retry.
    const preCheck = await scheduledPool.query(
      `SELECT a.lifecycle, ce.agent_execution_allowed, ce.operational_status
       FROM agents a
       LEFT JOIN cached_entitlements ce ON ce.tenant_id = a.tenant_id
       WHERE a.id = $1 LIMIT 1`,
      [payload.agentId]
    );
    const row = preCheck.rows[0];
    if (!row) {
      logger.info('Scheduled invoke skipped: agent not found', { agent_id: payload.agentId });
      return res.status(200).json({ skipped: true, reason: 'Agent not found' });
    }
    if (row.agent_execution_allowed === false) {
      logger.info('Scheduled invoke skipped: tenant execution not allowed', {
        agent_id: payload.agentId,
        tenant_id: payload.tenantId,
        operational_status: row.operational_status,
      });
      return res.status(200).json({
        skipped: true,
        reason: `Tenant execution not allowed (status: ${row.operational_status || 'unknown'})`,
      });
    }
    if (row.lifecycle !== 'ACTIVE') {
      logger.info('Scheduled invoke skipped: agent not ACTIVE', {
        agent_id: payload.agentId,
        lifecycle: row.lifecycle,
      });
      return res.status(200).json({ skipped: true, reason: `Agent lifecycle is ${row.lifecycle || 'unknown'}` });
    }

    // Create thread for this scheduled invocation
    const thread = await invocationsService.createThread({
      tenantId: payload.tenantId,
      agentId: payload.agentId,
      initiatedByType: 'scheduler',
      title: `Scheduled execution - ${new Date().toISOString()}`,
    });

    // Generate workflow and task IDs for this scheduled execution
    const workflowId = uuidv4();
    const taskId = uuidv4();

    // F4 — skip this tick outright if the previous one is still working. No
    // backlog: a routine that fell behind should resume on its next natural
    // fire, not replay every tick it missed.
    if (await routineIsAlreadyRunning(payload.tenantId, payload.agentId, payload.triggeredByLabel)) {
      logger.info(
        {
          event: 'routine_tick_skipped_overlap',
          tenant_id: payload.tenantId,
          agent_id: payload.agentId,
          triggered_by_label: payload.triggeredByLabel,
        },
        'routine tick skipped: the previous run is still in flight',
      );
      return res.status(200).json({ skipped: true, reason: 'Previous run still in flight' });
    }

    // Get objective for THIS routine, not the agent's top-level schedule (F3).
    const { objective: baseObjective, companion } = await getScheduledObjective(
      payload.tenantId,
      payload.agentId,
      payload.triggeredByLabel,
    );
    // F4b — drop a tick that arrived long after its scheduled time. Cloud
    // Scheduler retries a missed fire under its own attemptDeadline, so a long
    // outage otherwise ends with a burst of stale ticks; a monitor reporting on
    // windows that already closed is worse than one that stayed quiet.
    {
      const age = tickAgeMs(req.headers['x-cloudscheduler-scheduletime'] as string | undefined, new Date());
      if (age !== null) {
        const window = catchupWindowMs(estimateCronPeriodMs(companion?.cronExpr));
        if (age > window) {
          logger.info(
            {
              event: 'routine_tick_stale',
              tenant_id: payload.tenantId,
              agent_id: payload.agentId,
              triggered_by_label: payload.triggeredByLabel,
              age_ms: age,
              window_ms: window,
            },
            'routine tick dropped: it arrived long after the time it was scheduled for',
          );
          return res.status(200).json({ skipped: true, reason: 'Tick is stale' });
        }
      }
    }

    // A routine may run a command before (or instead of) the model. Mechanical
    // work — "is the build green", "how many rows failed" — has an exact
    // answer, and paying a model per tick to read it back adds cost, latency
    // and a chance of paraphrasing a number wrongly.
    const script = parseRoutineScript(companion?.script, companion?.noAgent);
    let scriptResult: Awaited<ReturnType<typeof runRoutineScript>> | null = null;
    if (script) {
      const { toolGatewayService } = await import('../tool-gateway/router');
      const runner = toolGatewayService.sandboxExecutorForRoutines();
      if (!runner) {
        // Refused loudly. Running the model anyway would produce a report about
        // data that was never gathered, which reads exactly like a real report.
        logger.error(
          {
            event: 'routine_script_no_sandbox',
            tenant_id: payload.tenantId,
            agent_id: payload.agentId,
            triggered_by_label: payload.triggeredByLabel,
          },
          'routine declares a script but this team member has no sandbox to run it in',
        );
        await recordRoutineOutcome({
          tenantId: payload.tenantId,
          agentId: payload.agentId,
          triggeredByLabel: payload.triggeredByLabel,
          success: false,
          error: 'routine_script_no_sandbox',
          // Explicitly unclassified, which COUNTS. A routine that declares a
          // script the team member cannot run is a configuration fault, and
          // reaching the threshold on it is exactly what the threshold is for.
          failureClass: null,
        });
        return res.status(200).json({ skipped: true, reason: 'No sandbox for the routine script' });
      }

      scriptResult = await runRoutineScript({
        runner,
        tenantId: payload.tenantId,
        agentId: payload.agentId,
        invocationId: taskId,
        sessionId: thread.id,
        script,
      });
      logRoutineScript({
        tenantId: payload.tenantId,
        agentId: payload.agentId,
        triggeredByLabel: payload.triggeredByLabel,
        noAgent: script.noAgent === true,
        result: scriptResult,
      });

      // The script IS the job: its stdout is the reply and its exit code is the
      // outcome. Nothing else runs, so this costs a container second and no
      // tokens at all.
      if (script.noAgent) {
        const reply = noAgentReply(scriptResult);
        const terminal = scriptResult.ok ? 'success' : 'engine_error';
        if (reply) {
          // The same delivery seam a model-authored routine settles through:
          // it already fans out to web, Slack and Teams from the thread's own
          // channel, and it is idempotent on the id below. A second delivery
          // path here would be a second set of surfaces to keep in step.
          const { settleWakeViaCallback } = await import('../platform-callback/client');
          await settleWakeViaCallback({
            tenantId: payload.tenantId,
            wakeId: taskId,
            threadId: thread.id,
            agentId: payload.agentId,
            replyText: reply,
          }).catch((err: Error) => logger.warn(
            { err: err.message, thread_id: thread.id },
            'routine script reply could not be delivered',
          ));
        }
        await invocationsService.updateThreadStatus(
          thread.id, payload.tenantId, THREAD_STATUS_BY_TERMINAL[terminal],
        );
        await recordRoutineOutcome({
          tenantId: payload.tenantId,
          agentId: payload.agentId,
          triggeredByLabel: payload.triggeredByLabel,
          success: scriptResult.ok,
          error: scriptResult.ok ? undefined : (scriptResult.error ?? `exit ${scriptResult.exitCode}`),
          // Explicitly unclassified, which COUNTS — a script that exits non-zero
          // every tick is the deterministic fault this breaker exists for.
          failureClass: null,
        });
        return res.status(200).json({
          threadId: thread.id,
          workflowId,
          taskId,
          success: scriptResult.ok,
          noAgent: true,
          delivered: reply.length > 0,
          exitCode: scriptResult.exitCode,
        });
      }
    }

    // A routine may declare that it continues from a sibling; fold that
    // sibling's last completed run in as the same containment-tagged
    // `<prior-run>` block the run-to-run continuity path already uses.
    const objective = await appendChainedContext(
      payload.tenantId,
      payload.agentId,
      baseObjective,
      companion?.contextFromLabel,
    );

    // Execute the task. When a script gathered data first, it rides along as
    // untrusted content inside the objective — the model decides what to say,
    // but the numbers came from a command rather than a guess.
    const finalObjective = scriptResult
      ? objectiveWithScriptOutput(objective, scriptResult, payload.tenantId)
      : objective;

    // Fan out over the routine's work items, when it declares where work comes
    // from.
    //
    // Without this a companion cron runs the agent's event-shaped graph with no
    // `input` at all: step 1 reads `{{input.message.threadId}}`, fails, and the
    // run takes whatever onFailure branch the author wrote. Customer Support
    // Representative's branch escalated and then marked the mail read, so the
    // routine meant as a safety net was closing tickets it never opened, every
    // fifteen minutes, reporting success.
    //
    // Each item runs the SAME graph the event trigger runs, with an
    // `input.message` built by the SAME function the event path uses — one
    // envelope contract with two producers, rather than a second graph that
    // would drift.
    const workSource = companion?.workSource;
    const inputBatches: Array<Record<string, unknown> | undefined> = [undefined];
    if (workSource?.toolName && workSource.itemsPath && workSource.source) {
      const { buildEventMessageEnvelope } = await import('../scheduling/event-input-envelope');
      const resolved = await agentExecutionService.resolveCompanionWorkItems({
        tenantId: payload.tenantId,
        agentId: payload.agentId,
        toolName: workSource.toolName,
        toolArgs: workSource.toolArgs,
        itemsPath: workSource.itemsPath,
        maxItems: workSource.maxItems ?? 25,
      });
      if (resolved.error) {
        // A listing that could not run is a failed routine, not an empty one.
        // Reporting "no work" here is the fabricated-success shape this whole
        // change exists to remove.
        logger.error('companion work source failed to resolve', {
          agent_id: payload.agentId,
          label: payload.triggeredByLabel,
          tool: workSource.toolName,
          error: resolved.error,
        });
        throw new Error(`companion work source failed: ${resolved.error}`);
      }
      inputBatches.length = 0;
      for (const item of resolved.items) {
        inputBatches.push({ message: buildEventMessageEnvelope(workSource.source, item) });
      }
      logger.info('companion work source resolved', {
        agent_id: payload.agentId,
        label: payload.triggeredByLabel,
        tool: workSource.toolName,
        items: inputBatches.length,
      });
      // Nothing to do is a legitimate outcome — and it is now a STATED one,
      // distinguishable in the logs from a listing that failed.
      if (inputBatches.length === 0) {
        await invocationsService.updateThreadStatus(
          thread.id,
          payload.tenantId,
          THREAD_STATUS_BY_TERMINAL[resolveTerminalState({ success: true }, false)],
        );
        return res.status(200).json({ ok: true, companionWorkItems: 0 });
      }
    }

    let result!: Awaited<ReturnType<typeof agentExecutionService.executeTask>>;
    for (const inputData of inputBatches) {
      result = await agentExecutionService.executeTask({
        tenantId: payload.tenantId,
        agentId: payload.agentId,
        workflowId,
        taskId,
        objective: finalObjective,
        threadId: thread.id,
        triggeredBy: ['human', 'agent', 'cron', 'event'].includes(payload.triggeredBy || '') ? payload.triggeredBy as 'cron' : 'cron',
        // Which routine fired. Dropped on this path until now, so every companion
        // run was attributed to the agent's generic cron trigger and per-routine
        // history did not exist here.
        triggeredByLabel: payload.triggeredByLabel,
        // Present only for a work-source routine; undefined keeps the existing
        // single-run behaviour byte-for-byte for every other companion.
        ...(inputData ? { inputData } : {}),
        // Tells graph validation that this run carries an event-shaped input.
        // Without it the run is judged a bare cron and every
        // `{{input.message.*}}` reference is rejected before step 1 — the two
        // halves of the fan-out contradicting each other.
        ...(inputData && workSource?.source ? { inputSource: workSource.source } : {}),
      });
    }

    // Update thread status based on result
    await invocationsService.updateThreadStatus(
      thread.id,
      payload.tenantId,
      THREAD_STATUS_BY_TERMINAL[resolveTerminalState(result, false)]
    );

    // J3 — track the routine's failure streak. Same call the live (queued) path
    // makes when its run terminates; this covers the older jobs that still
    // target the direct-execute route.
    await recordRoutineOutcome({
      tenantId: payload.tenantId,
      agentId: payload.agentId,
      triggeredByLabel: payload.triggeredByLabel,
      success: result.success === true,
      error: result.error,
      // Same filter as the queued path: only a routine fault counts.
      failureClass: result.failureClass,
    });

    logger.info('Scheduled invoke completed', {
      tenant_id: payload.tenantId,
      agent_id: payload.agentId,
      thread_id: thread.id,
      success: result.success,
      tool_calls: result.toolCallsExecuted,
      reasoning_steps: result.reasoningSteps,
    });

    return res.status(200).json({
      threadId: thread.id,
      workflowId,
      taskId,
      ...result,
    });
  } catch (error) {
    logger.error('Scheduled invoke failed', {
      error: (error as Error).message,
      stack: (error as Error).stack,
    });

    // Best-effort: reset agent runtime status to IDLE so next invocation isn't blocked
    try {
      const body = typeof req.body === 'string'
        ? JSON.parse(Buffer.from(req.body, 'base64').toString())
        : req.body;
      if (body?.agentId) {
        const { AgentLifecycleService } = require('../agent-lifecycle/service');
        const lifecycle = new AgentLifecycleService();
        await lifecycle.updateRuntimeStatus(body.agentId, 'IDLE');
      }
    } catch { /* ignore cleanup errors */ }

    // Return 500 to let Cloud Scheduler know it should retry
    return res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/execution/scheduled-invoke/health
// POST /api/execution/scheduled-enqueue
// Lightweight endpoint (<500ms) that enqueues agent execution into Cloud Tasks.
// Cloud Scheduler calls this instead of scheduled-invoke when USE_CLOUD_TASKS_EXECUTION=true.
router.post('/scheduled-enqueue', async (req: Request, res: Response) => {
  const traceId = uuidv4();
  try {
    // 1. Verify OIDC token
    const isAuthorized = await verifyOidcToken(req);
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Unauthorized: invalid OIDC token' });
    }
    logger.info('Cloud Scheduler OIDC token verified for enqueue', { trace_id: traceId });

    // 2. Parse payload
    const payload = req.body as ScheduledInvokePayload;
    if (!payload.tenantId || !payload.agentId) {
      return res.status(400).json({ error: 'Missing tenantId or agentId' });
    }

    // 3. L3 entitlement check (see scheduled-invoke handler above for full rationale)
    const preCheck = await scheduledPool.query(
      `SELECT a.lifecycle, ce.agent_execution_allowed, ce.operational_status
       FROM agents a
       LEFT JOIN cached_entitlements ce ON ce.tenant_id = a.tenant_id
       WHERE a.id = $1 LIMIT 1`,
      [payload.agentId]
    );
    const row = preCheck.rows[0];
    if (!row) {
      return res.status(200).json({ skipped: true, reason: 'Agent not found' });
    }
    if (row.agent_execution_allowed === false) {
      logger.info('Scheduled enqueue skipped: tenant execution not allowed', {
        trace_id: traceId,
        agent_id: payload.agentId,
        tenant_id: payload.tenantId,
        operational_status: row.operational_status,
      });
      return res.status(200).json({
        skipped: true,
        reason: `Tenant execution not allowed (status: ${row.operational_status || 'unknown'})`,
      });
    }
    if (row.lifecycle !== 'ACTIVE') {
      // Self-heal: cache may be stale. Force a one-agent reconcile against
      // platform-backend, then re-check. This bounds the worst-case "agent
      // active in PB but DRAFT locally" window to a single missed tick rather
      // than 5 min (the periodic reconciler cadence). If still DRAFT after
      // reconcile, the canonical answer really is DRAFT — skip honestly.
      try {
        const mapRes = await scheduledPool.query<{ internal_agent_id: string }>(
          `SELECT internal_agent_id FROM internal_agent_runtime_mapping WHERE agent_id = $1 LIMIT 1`,
          [payload.agentId],
        );
        const internalAgentId = mapRes.rows[0]?.internal_agent_id;
        if (internalAgentId) {
          const { reconcileSingleAgent } = await import('../agent-lifecycle/canonical-reconciler');
          const reconciled = await reconcileSingleAgent({
            tenantId: payload.tenantId, internalAgentId,
          });
          if (reconciled) {
            const recheck = await scheduledPool.query<{ lifecycle: string }>(
              `SELECT lifecycle FROM agents WHERE id = $1 LIMIT 1`,
              [payload.agentId],
            );
            const newLifecycle = recheck.rows[0]?.lifecycle;
            if (newLifecycle === 'ACTIVE') {
              logger.info(
                { trace_id: traceId, agent_id: payload.agentId },
                'self-heal succeeded — agent is now ACTIVE, continuing',
              );
              // Fall through to the normal path. row.lifecycle was stale.
              row.lifecycle = 'ACTIVE';
            } else {
              return res.status(200).json({
                skipped: true,
                reason: `Agent lifecycle is ${newLifecycle || 'unknown'} (after self-heal)`,
              });
            }
          } else {
            return res.status(200).json({
              skipped: true,
              reason: `Agent not in canonical state — likely deleted upstream`,
            });
          }
        }
      } catch (err) {
        logger.warn(
          { trace_id: traceId, err: (err as Error).message },
          'self-heal reconcile failed; falling back to original skip',
        );
        return res.status(200).json({
          skipped: true,
          reason: `Agent lifecycle is ${row.lifecycle || 'unknown'} (self-heal failed)`,
        });
      }
    }
    if (row.lifecycle !== 'ACTIVE') {
      return res.status(200).json({ skipped: true, reason: `Agent lifecycle is ${row.lifecycle || 'unknown'}` });
    }

    // F4 — check BEFORE enqueueing, so an overlapping tick never becomes a
    // queued task that will run the moment the current one settles.
    if (await routineIsAlreadyRunning(payload.tenantId, payload.agentId, payload.triggeredByLabel)) {
      logger.info(
        {
          event: 'routine_tick_skipped_overlap',
          trace_id: traceId,
          tenant_id: payload.tenantId,
          agent_id: payload.agentId,
          triggered_by_label: payload.triggeredByLabel,
        },
        'routine tick skipped: the previous run is still in flight',
      );
      return res.status(200).json({ enqueued: false, skipped: true, reason: 'Previous run still in flight' });
    }

    // 4. Create thread + get objective (per-routine — F3)
    const { objective: baseObjective, companion } = await getScheduledObjective(
      payload.tenantId,
      payload.agentId,
      payload.triggeredByLabel,
    );
    // F4b — drop a tick that arrived long after its scheduled time. Cloud
    // Scheduler retries a missed fire under its own attemptDeadline, so a long
    // outage otherwise ends with a burst of stale ticks; a monitor reporting on
    // windows that already closed is worse than one that stayed quiet.
    {
      const age = tickAgeMs(req.headers['x-cloudscheduler-scheduletime'] as string | undefined, new Date());
      if (age !== null) {
        const window = catchupWindowMs(estimateCronPeriodMs(companion?.cronExpr));
        if (age > window) {
          logger.info(
            {
              event: 'routine_tick_stale',
              tenant_id: payload.tenantId,
              agent_id: payload.agentId,
              triggered_by_label: payload.triggeredByLabel,
              age_ms: age,
              window_ms: window,
            },
            'routine tick dropped: it arrived long after the time it was scheduled for',
          );
          return res.status(200).json({ skipped: true, reason: 'Tick is stale' });
        }
      }
    }

    const objective = await appendChainedContext(
      payload.tenantId,
      payload.agentId,
      baseObjective,
      companion?.contextFromLabel,
    );
    const thread = await invocationsService.createThread({
      tenantId: payload.tenantId,
      agentId: payload.agentId,
      initiatedByType: 'scheduler',
    });
    const threadId = thread.id;
    const workflowId = uuidv4();
    const taskId = uuidv4();

    // 5. Generate scheduleKey (truncated to minute for dedup)
    const now = new Date();
    const scheduleKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}T${String(now.getUTCHours()).padStart(2, '0')}-${String(now.getUTCMinutes()).padStart(2, '0')}`;

    // 5b. Companion work source: one task PER ITEM, each with a real input.
    //
    // The identical fan-out exists in /scheduled-invoke above, but
    // production does not use that endpoint: USE_CLOUD_TASKS_EXECUTION routes
    // Cloud Scheduler here instead. Without the fan-out here, this path would
    // enqueue ONE task with no inputData, and every companion routine would run
    // its graph with nothing to read.
    // A graph that resolves `{{input.message.*}}` — which is every per-record
    // reactive graph — then failed validation before step 1:
    //
    //   [UNKNOWN_INPUT_FIELD] toolInputTemplate reads {{input.message.threadId}},
    //   but a cron fire carries no input at all
    //
    // Every cron fire of a support agent then fails that way. Enough of them in
    // one hour trip the consecutive-failure guard, the agent auto-pauses, and
    // being paused it is deregistered from its event trigger — so inbound
    // customer mail stops being answered too. The routine looks configured, the
    // graph is correct, and the two are joined by a code path nobody ran.
    const workSource = companion?.workSource;
    let itemInputs: Array<Record<string, unknown> | undefined> = [undefined];
    if (workSource?.toolName && workSource.itemsPath && workSource.source) {
      const { buildEventMessageEnvelope } = await import('../scheduling/event-input-envelope');
      const resolved = await agentExecutionService.resolveCompanionWorkItems({
        tenantId: payload.tenantId,
        agentId: payload.agentId,
        toolName: workSource.toolName,
        toolArgs: workSource.toolArgs,
        itemsPath: workSource.itemsPath,
        maxItems: workSource.maxItems ?? 25,
      });
      if (resolved.error) {
        // A listing that could not run is a failed routine, not an empty one.
        logger.error('companion work source failed to resolve', {
          trace_id: traceId, agent_id: payload.agentId,
          label: payload.triggeredByLabel, tool: workSource.toolName, error: resolved.error,
        });
        return res.status(500).json({ error: `companion work source failed: ${resolved.error}` });
      }
      itemInputs = resolved.items.map(
        (item) => ({ message: buildEventMessageEnvelope(workSource.source as string, item) }),
      );
      logger.info('companion work source resolved', {
        trace_id: traceId, agent_id: payload.agentId,
        label: payload.triggeredByLabel, tool: workSource.toolName, items: itemInputs.length,
      });
      // Nothing to do is a legitimate, STATED outcome — and enqueueing a run
      // with no input is what produced the validation failures above.
      if (itemInputs.length === 0) {
        return res.status(200).json({ enqueued: false, companionWorkItems: 0 });
      }
    }

    // 6. Enqueue Cloud Task
    try {
      const taskNames: string[] = [];
      for (let i = 0; i < itemInputs.length; i++) {
        const inputData = itemInputs[i];
        const { taskName } = await enqueueAgentExecution(payload.tenantId, payload.agentId, {
          // Each item is its own run, so it needs its own ids — reusing one
          // workflowId/taskId across the fan-out would collapse them.
          workflowId: i === 0 ? workflowId : uuidv4(),
          taskId: i === 0 ? taskId : uuidv4(),
          objective,
          threadId,
          triggeredBy: payload.triggeredBy || 'cron',
          // Carry the routine identity through the queue hop; the receiver
          // (cloud-tasks-handler) already reads it off the body.
          triggeredByLabel: payload.triggeredByLabel,
          scheduleKey,
          // Distinguishes the per-item tasks. The task name is built from
          // (agent, scheduleKey, contextRef), so without this every item in a
          // fan-out would dedup down to one task.
          ...(inputData ? { contextRef: `item-${i}` } : {}),
          ...(inputData ? { inputData } : {}),
          ...(inputData && workSource?.source ? { inputSource: workSource.source } : {}),
          // The same trigger identity the event path carries.
          //
          // A run that resolves `{{input.message.*}}` needs `inputSource` for
          // graph validation AND a `trigger` for the HITL gate, which builds
          // its in-place target only when `trigger.kind === 'connector_event'`.
          // Sending one without the other produced a run that validated and
          // executed correctly and then asked permission to mark the very
          // thread it had just answered as read — the carve-out reads
          // `if (!target) return false`, and no trigger means no target.
          //
          // Built with the same helper the event path uses, so the trust level
          // is derived identically rather than restated: mail from an external
          // author is untrusted_inbound on both paths.
          ...(inputData && workSource?.source
            ? { trigger: connectorEventTrigger(workSource.source, 'Email') }
            : {}),
        });
        taskNames.push(taskName);
      }

      logger.info('Scheduled invoke enqueued to Cloud Tasks', {
        trace_id: traceId,
        agent_id: payload.agentId,
        task_name: taskNames[0],
        tasks: taskNames.length,
        schedule_key: scheduleKey,
      });

      return res.status(200).json({ enqueued: true, taskName: taskNames[0], tasks: taskNames.length });
    } catch (enqueueError: any) {
      // ALREADY_EXISTS (code 6) means dedup — same cron tick already enqueued
      if (enqueueError.code === 6) {
        logger.info('Task already exists (dedup)', {
          trace_id: traceId,
          agent_id: payload.agentId,
          schedule_key: scheduleKey,
        });
        return res.status(200).json({ enqueued: false, reason: 'Task already exists (dedup)', deduplicated: true });
      }
      throw enqueueError;
    }
  } catch (error) {
    logger.error('Scheduled enqueue failed', {
      trace_id: traceId,
      error: (error as Error).message,
    });
    return res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/scheduled-invoke/health', (_req: Request, res: Response) => {
  return res.status(200).json({ status: 'healthy' });
});

// POST /api/execution/consolidation-tick
// Called by Cloud Scheduler (every 12h) to trigger memory consolidation + CLAUDE.md graduation.
// Fans out per-agent work: queries qualifying agents, then calls runConsolidationForAgent()
// for each. Advisory lock per agent prevents duplicate processing across instances.
router.post('/consolidation-tick', async (req: Request, res: Response) => {
  try {
    const isValid = await verifyOidcToken(req);
    if (!isValid && process.env.NODE_ENV === 'production') {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { runConsolidationForAgent } = require('../scheduling/memory-consolidation-loop');

    // `memories` is RLS-scoped on app.tenant_id, so discovery runs once per
    // tenant rather than once for the runtime. The query selects m.tenant_id as
    // though it spanned tenants, but the scope it runs in has already bound it
    // to one — so a single scoped pass finds the qualifying agents of exactly
    // one tenant and silently reports the rest as having none.
    let agentsProcessed = 0;
    let totalConsolidated = 0;
    let totalGraduated = 0;

    const fanout = await forEachTenant('consolidation-tick', async (tenantId) => {
      const agentsResult = await withTenantScope(tenantId, async (client) => {
        return client.query(`
          SELECT DISTINCT m.agent_id, m.tenant_id
          FROM memories m
          WHERE m.tags @> ARRAY['auto-reflection']
            AND m.superseded_by IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > NOW())
          GROUP BY m.agent_id, m.tenant_id
          HAVING COUNT(*) >= 5
        `);
      }, 'scheduled-execution');

      for (const row of agentsResult.rows) {
        try {
          const result = await runConsolidationForAgent(row.tenant_id, row.agent_id);
          totalConsolidated += result.consolidated;
          totalGraduated += result.graduated;
        } catch (err) {
          logger.warn({
            agentId: row.agent_id,
            tenantId: row.tenant_id,
            err: (err as Error).message,
          }, 'consolidation-tick: agent processing failed (continuing)');
        }
      }
      agentsProcessed += agentsResult.rows.length;
      return { qualifyingAgents: agentsResult.rows.length };
    });

    logger.info({
      tenants: fanout.tenants,
      agentsProcessed,
      totalConsolidated,
      totalGraduated,
    }, 'consolidation-tick: complete');

    return res.json({ tenants: fanout.tenants, agentsProcessed, totalConsolidated, totalGraduated });
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'consolidation-tick: failed');
    return res.status(500).json({ error: (error as Error).message });
  }
});

export { router as scheduledInvokeHandler };
