// Cloud Tasks delivery handler for HRBP per-spec fan-out.
//
// Cloud Tasks → POST /api/tasks/hrbp-provision-spec with OIDC token.
// We verify the token belongs to our own workforce-service SA, then run
// HRBP via runPlatformAgent for the single spec carried in the payload.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { runPlatformAgent } from '../platform-agent/execution.js';
import { HRBP_TOOLS, dispatchHrbpToolCall } from '../platform-agent/hrbp/index.js';
import {
  handleProvisioningUpdateSpecStatus,
  rollUpPlanStatus,
} from '../platform-agent/hrbp/tools/provisioning-update-spec-status.js';
import { workforcePlanService } from './service.js';
import { postProvisioningNotice } from './provisioning-notice.js';
import { startProvisionedTeams } from './provisioning-launch.js';
import { resumeStuckProvisioningPlans } from './stuck-plan-resumer.js';
import { WorkforcePlanNotFoundError } from './types.js';
import type { HrbpToolContext } from '../platform-agent/hrbp/types.js';
import type { WorkforcePlanAgentSpec } from './types.js';
import { log } from '../infrastructure/logging.js';
import { getPool } from '../infrastructure/database.js';
import { withTenantContext } from '../infrastructure/rls.js';
import { CAIO_AGENT_ID, HRBP_AGENT_ID } from '../platform-agent/system-agent-ids.js';

const oidcClient = new OAuth2Client();

interface TaskPayload {
  tenantId: string;
  planId: string;
  runId: string;
  spec: WorkforcePlanAgentSpec;
  approverAccountId: string;
}

async function verifyOidc(req: FastifyRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing OIDC token' };
  }
  const audience = process.env['WORKFORCE_SERVICE_URL'] ?? '';
  const expectedSa = process.env['WORKFORCE_SERVICE_ACCOUNT_EMAIL'] ?? '';
  try {
    const ticket = await oidcClient.verifyIdToken({
      idToken: authHeader.slice(7),
      audience,
    });
    if (ticket.getPayload()?.email !== expectedSa) {
      return { ok: false, reason: 'OIDC token from unexpected SA' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `OIDC verification failed: ${(err as Error).message}` };
  }
}

export async function registerHrbpTaskRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/tasks/hrbp-provision-spec', async (request, reply) => {
    const auth = await verifyOidc(request);
    if (!auth.ok) {
      log.warn({ reason: auth.reason }, 'HRBP task handler rejected request');
      const code = auth.reason === 'missing OIDC token' ? 401 : 403;
      return reply.status(code).send({ error: auth.reason });
    }

    let body: TaskPayload;
    try {
      const raw = request.body;
      body = typeof raw === 'string'
        ? (JSON.parse(Buffer.from(raw, 'base64').toString()) as TaskPayload)
        : (raw as TaskPayload);
    } catch (err) {
      return reply.status(400).send({ error: `invalid payload: ${(err as Error).message}` });
    }

    const { tenantId, planId, runId, spec, approverAccountId } = body;
    if (!tenantId || !planId || !runId || !spec?.specId) {
      return reply.status(400).send({ error: 'missing required fields' });
    }

    const objective = JSON.stringify({
      action: 'provision_spec',
      planId,
      specId: spec.specId,
      spec,
      approverAccountId,
    });

    // Mutable so tools (teambuilder__create) can stamp createdInternalAgentId
    // and we can read it back after the loop to write terminal state.
    const toolContext: HrbpToolContext = {
      tenantId,
      planId,
      runId,
      specId: spec.specId,
      approverAccountId,
      spec,
    };

    let terminator: string | undefined;
    let lastError: string | undefined;
    try {
      for await (const event of runPlatformAgent({
        agentId: HRBP_AGENT_ID,
        tenantId,
        // Correlate this run's agent_audit_logs `.tool_called` rows (which carry the
        // real {tool,input}) to the provisioning run via thread_id = run_id, so the
        // diagnostics HRBP adapter can recover the real tool arguments instead of
        // synthesizing {specId} from the events ledger.
        threadId: runId,
        objective,
        tools: HRBP_TOOLS,
        toolContext: toolContext as unknown as Record<string, unknown>,
        dispatchToolCall: dispatchHrbpToolCall,
        auditAction: 'hrbp.provision_spec',
        // Provisioning is dispatched by CAIO over Cloud Tasks, so it is agent-
        // triggered even though a human approved the plan upstream. That keeps
        // it on the AI-internal side of the /insights human-vs-AI split, where
        // automated provisioning work belongs.
        triggeredBy: `agent:${CAIO_AGENT_ID}`,
        usagePurpose: 'hrbp_provision_spec',
      })) {
        if (event.type === 'complete') {
          terminator = event.summary.terminator;
        } else if (event.type === 'error') {
          lastError = event.message;
        }
      }
    } catch (err) {
      // Mark spec failed, then return 500 so Cloud Tasks retries.
      log.error(
        { err: (err as Error).message, planId, specId: spec.specId },
        'HRBP task handler threw',
      );
      await ensureSpecTerminalState(toolContext, {
        status: 'failed',
        errorMessage: `handler threw: ${(err as Error).message}`,
      });
      return reply.status(500).send({ error: (err as Error).message });
    }

    // Platform-level enforcement of the terminal-status invariant. The LLM's
    // system prompt instructs it to call provisioning__update_spec_status,
    // but a missed call would leave the spec stuck in 'pending' and the
    // parent plan stuck in 'provisioning'. So we always ensure terminal
    // state is recorded, idempotently: if the LLM already wrote it, this
    // is a no-op overwrite to the same value.
    //
    // transition_to_blocker terminates the loop with terminator='tool_blocker'
    // and writes its own terminal state via the blocker path — skip in that
    // case to preserve the blocked status.
    if (terminator !== 'tool_blocker') {
      const status = pickTerminalStatus(terminator, toolContext.createdInternalAgentId);
      await ensureSpecTerminalState(toolContext, {
        status,
        ...(toolContext.createdInternalAgentId ? { internalAgentId: toolContext.createdInternalAgentId } : {}),
        ...(status === 'failed' && lastError ? { errorMessage: lastError } : {}),
      });
    }

    // Fan-in. Each spec runs in its own Cloud Task, so the last one to finish
    // is the one that closes the plan.
    await finalizePlanIfDone(toolContext);

    return reply.status(200).send({ ok: true, terminator, lastError });
  });

  // POST /api/tasks/resume-stuck-plans — Cloud Scheduler.
  //
  // Running the resumer only at startup makes recovery a side effect of
  // deploying, which is not a recovery mechanism. An in-process interval cannot
  // replace it either: the service runs at min-instances 0, so a timer dies
  // with the instance. It has to be woken from outside.
  app.post('/api/tasks/resume-stuck-plans', async (request, reply) => {
    const auth = await verifyOidc(request);
    if (!auth.ok) {
      log.warn({ reason: auth.reason }, 'Stuck-plan sweep rejected request');
      return reply.status(auth.reason === 'missing OIDC token' ? 401 : 403).send({ error: auth.reason });
    }

    try {
      const resumed = await resumeStuckProvisioningPlans();
      log.info({ resumed }, 'Stuck-plan sweep finished');
      return reply.status(200).send({ ok: true, resumed });
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Stuck-plan sweep threw');
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}

function pickTerminalStatus(
  terminator: string | undefined,
  createdInternalAgentId: string | undefined,
): 'completed' | 'failed' | 'skipped' {
  // The agent existing IS the work. Whether the reasoning loop then exited
  // cleanly, ran out of iterations or was stopped describes the loop's control
  // flow, not whether the spec was provisioned — and the agent's configuration
  // does not depend on how the loop ended, since its bindings and distilled
  // output are written from the spec and the distill result in code.
  return createdInternalAgentId ? 'completed' : 'failed';
}

/**
 * Move the plan (and its run row) to a terminal state once every spec is done.
 *
 * Race-safe without a lock: markCompleted/markFailed go through
 * repository.transitionStatus, which is a compare-and-swap on the from-status.
 * If several specs finish at once they can all decide the plan is terminal, but
 * only the first UPDATE matches `status = 'provisioning'`; the losers get a
 * WorkforcePlanNotFoundError and drop out here.
 *
 * Everything here is best-effort. Provisioning has already succeeded by the
 * time it runs, and a bookkeeping failure must never turn a successful run into
 * a 500 that Cloud Tasks retries.
 */
async function finalizePlanIfDone(ctx: HrbpToolContext): Promise<void> {
  try {
    const plan = await withTenantContext(ctx.tenantId, async (client) => {
      const { rows } = await client.query<{
        agents: Array<Record<string, unknown>>;
        status: string;
        approved_by: string | null;
        launch_on_completion: boolean | null;
      }>(
        `SELECT agents, status, approved_by, launch_on_completion FROM workforce_plans WHERE id = $1 AND tenant_id = $2`,
        [ctx.planId, ctx.tenantId],
      );
      return rows[0]?.status === 'provisioning' ? rows[0] : null;
    });
    if (!plan) return;
    const agents = plan.agents ?? [];

    const planStatus = rollUpPlanStatus(agents);
    if (!planStatus) return;

    try {
      if (planStatus === 'completed') {
        await workforcePlanService.markCompleted(ctx.planId, ctx.tenantId);
      } else {
        await workforcePlanService.markFailed(ctx.planId, ctx.tenantId);
      }
      log.info({ planId: ctx.planId, planStatus }, 'HRBP: last spec landed — plan is terminal');
    } catch (err) {
      if (err instanceof WorkforcePlanNotFoundError) return; // another spec won the race
      throw err;
    }

    // hrbp_provisioning_runs is a non-RLS service table (INV-WF-002), so the
    // direct pool is correct here.
    await getPool().query(
      `UPDATE hrbp_provisioning_runs SET status = $1, updated_at = NOW()
        WHERE id = $2 AND status = 'running'`,
      [planStatus, ctx.runId],
    );

    // Tell the person. This is the only place that knows every spec has landed,
    // and until now it told nobody: the CAIO promised "they will appear on the
    // Teams page shortly", provisioning took minutes, and the conversation ended
    // there whether the teams were created or not.
    //
    // Deliberately after the markCompleted/markFailed race, which exactly one
    // spec task can win, so the notice is posted at most once. It never throws.
    // The person's Launch Now, honoured by the one task that reached this
    // line: each built team is started as the approver through the same
    // workspace action a click uses, and what that came to goes into the
    // notice. Drafts (Maybe Later, or no recorded approver) skip this.
    const launches = plan.launch_on_completion === true && plan.approved_by
      ? await startProvisionedTeams({
          tenantId: ctx.tenantId,
          planId: ctx.planId,
          approvedBy: plan.approved_by,
          specs: agents,
        })
      : undefined;

    await postProvisioningNotice({
      tenantId: ctx.tenantId,
      planId: ctx.planId,
      specs: agents,
      ...(launches ? { launches } : {}),
      accountId: plan.approved_by,
    });
  } catch (err) {
    log.warn(
      { planId: ctx.planId, runId: ctx.runId, err: (err as Error).message },
      'HRBP: could not finalize the plan — the specs themselves are unaffected',
    );
  }
}

async function ensureSpecTerminalState(
  ctx: HrbpToolContext,
  input: { status: 'completed' | 'failed' | 'skipped'; internalAgentId?: string; errorMessage?: string },
): Promise<void> {
  try {
    const result = await handleProvisioningUpdateSpecStatus(
      input as unknown as Record<string, unknown>,
      ctx,
    );
    if (!result.ok) {
      log.warn(
        { planId: ctx.planId, specId: ctx.specId, status: input.status, result: result.data },
        'HRBP terminal-state enforcement: update_spec_status returned not-ok',
      );
    }
  } catch (err) {
    log.error(
      { planId: ctx.planId, specId: ctx.specId, status: input.status, err: (err as Error).message },
      'HRBP terminal-state enforcement threw — spec may remain in non-terminal state',
    );
  }
}
