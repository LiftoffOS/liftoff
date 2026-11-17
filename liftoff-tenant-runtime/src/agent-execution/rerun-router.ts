// ADR-030: "Run again" — re-run a failed autonomous run.
//
// POST /api/internal/agents/:agentId/invocations/:invocationId/rerun
//
// Called by the platform-backend proxy on behalf of a human who clicked
// "Run again" on a failed run in the Activity page. Re-enqueues a FRESH
// execution of the original run's captured input (invocations.replay_input)
// through the normal /api/tasks/agent-scheduled receiver — so the per-agent
// lock, lifecycle/drift check, admission gate, billing, and idempotency all
// apply unchanged. A fresh (unique) scheduleKey yields a unique task name and
// thus a fresh event_processing_ledger claim, so this re-runs rather than
// replaying the cached failure.

import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireServiceAuth } from '../security/service-auth';
import { invocationsService } from '../invocations/service';
import { enqueueAgentExecution } from '../infrastructure/cloud-tasks';
import { logger } from '../infrastructure/logging';
import type { AgentTrigger } from './types';

// Cloud Tasks caps a task body at 1 MiB, and the re-run body base64-inflates the
// replayed inputData + trigger (~+33%). Reject an oversized reactive/webhook
// payload up front with a clear 413 rather than letting createTask throw a
// generic 500. 700 KiB of raw replay JSON → ~930 KiB base64, leaving headroom for
// the wrapper fields under the 1 MiB ceiling. Mirrors the deferred-execution cap.
const MAX_RERUN_PAYLOAD_BYTES = 700 * 1024;

/** Invocation outcomes a person may re-run.
 *
 *  Both mean the run is OVER. Deliberately not a check against a "still live"
 *  list: a new outcome should have to opt IN to being re-runnable, because the
 *  cost of wrongly offering it is running someone's work twice. */
const RE_RUNNABLE_OUTCOMES: ReadonlySet<string> = new Set(['error', 'escalated']);

const router = Router();

// Service auth: PB sends X-Service-Auth: TENANT_RUNTIME_SERVICE_TOKEN via
// buildRuntimeHeaders. requireServiceAuth() defaults to that env var.
router.use(requireServiceAuth());

router.post('/:agentId/invocations/:invocationId/rerun', async (req: Request, res: Response) => {
  const tenantId = req.headers['x-tenant-id'] as string | undefined;
  if (!tenantId) {
    return res.status(400).json({ error: 'Missing X-Tenant-Id' });
  }
  const { invocationId } = req.params;

  // The member who clicked "Run again", forwarded by PB. Clicking is a new human
  // action, so this run is attributed to that person rather than inheriting the
  // schedule that started the run it replaces; rerun_of_invocation_id below is
  // what carries the lineage. Absent when PB could not resolve the caller to an
  // account, or when an older PB is deployed — in which case the replayed value
  // below still applies, exactly as before.
  const clickedBy =
    typeof (req.body as { triggeredByUserId?: unknown } | undefined)?.triggeredByUserId === 'string'
      ? ((req.body as { triggeredByUserId: string }).triggeredByUserId)
      : undefined;

  // Whole body is wrapped so a DB / enqueue throw returns 500 instead of
  // becoming an unhandled rejection (Express 4 does not await handlers).
  try {
    const src = await invocationsService.getRerunSource(invocationId, tenantId);
    if (!src) {
      return res.status(404).json({ error: 'Invocation not found' });
    }

    // Guardrails (ADR-030): only ended, top-level, autonomous (cron/event) runs
    // with captured replay_input can be re-run. Mirrors the frontend gate as
    // defense-in-depth.
    //
    // 'escalated' belongs here as much as 'error' does, and its absence was the
    // gap this closes: an escalated run has ENDED, having asked a person to
    // clear something. Fixing that thing and running the work again is the
    // whole point of the ask, and it was the one outcome that could not.
    //
    // 'paused' and 'gated' stay out and must: those runs are still live and
    // will resume on their own once the person decides. Re-running one would
    // double the work rather than retry it.
    if (!RE_RUNNABLE_OUTCOMES.has(src.outcome)) {
      return res.status(422).json({
        error: 'not_re_runnable',
        reason: 'Only runs that ended in a failure or an escalation can be re-run',
      });
    }
    if (!src.replayInput) {
      return res.status(422).json({ error: 'not_re_runnable', reason: 'This run predates Run again support' });
    }
    if (src.parentInvocationId != null) {
      return res.status(422).json({ error: 'not_re_runnable', reason: 'Delegated sub-runs cannot be re-run on their own' });
    }
    if (src.triggeredBy !== 'cron' && src.triggeredBy !== 'event') {
      return res.status(422).json({ error: 'not_re_runnable', reason: 'Only scheduled and event-triggered runs can be re-run' });
    }

    // Reject an oversized replay payload before it hits the Cloud Tasks 1 MiB
    // body limit (where createTask would throw a generic 500).
    if (Buffer.byteLength(JSON.stringify(src.replayInput)) > MAX_RERUN_PAYLOAD_BYTES) {
      return res.status(413).json({
        error: 'payload_too_large',
        reason: "This run's input is too large to re-run.",
      });
    }

    const replay = src.replayInput as {
      objective?: string;
      threadId?: string;
      chainDepth?: number;
      inputData?: Record<string, unknown>;
      trigger?: AgentTrigger;
      triggeredByUserId?: string;
    };

    // Enqueue with src.agentId — the authoritative runtime agent id from the
    // invocation row. The :agentId path segment is addressing only (PB forwards
    // the internal id by convention), so we must not use it as the run target.
    //
    // inputData + trigger are replayed verbatim: inputData restores the structured
    // run input (e.g. a reactive subscription's event payload — the objective text
    // alone is a redacted summary), and trigger restores the trust level so an
    // untrusted-inbound webhook re-run keeps its <webhook_payload> isolation + SSRF
    // gating on payload URLs (executeTask derives trustLevel from the trigger; it
    // deliberately does NOT coerce hitlLevel). Without the trigger the re-run would
    // silently escalate to 'trusted'. This is why webhook runs are safe to re-run
    // (no untrusted-inbound exclusion is needed).
    await enqueueAgentExecution(tenantId, src.agentId, {
      workflowId: uuidv4(),
      taskId: uuidv4(),
      objective: replay.objective ?? '',
      threadId: replay.threadId ?? '',
      triggeredBy: src.triggeredBy,
      triggeredByLabel: `rerun_of:${invocationId}`,
      triggeredByUserId: clickedBy ?? replay.triggeredByUserId,
      scheduleKey: uuidv4(), // fresh -> unique task name -> fresh run, not a replay
      contextRef: `rerun-${invocationId}`,
      chainDepth: replay.chainDepth ?? 0,
      rerunOfInvocationId: invocationId,
      inputData: replay.inputData,
      trigger: replay.trigger,
    });

    logger.info('rerun enqueued', {
      tenant_id: tenantId,
      agent_id: src.agentId,
      rerun_of_invocation_id: invocationId,
    });
    return res.status(202).json({ accepted: true });
  } catch (error) {
    logger.error(
      { err: (error as Error).message, tenant_id: tenantId, invocation_id: invocationId },
      'rerun failed',
    );
    return res.status(500).json({ error: 'Internal error' });
  }
});

export { router as rerunRouter };
