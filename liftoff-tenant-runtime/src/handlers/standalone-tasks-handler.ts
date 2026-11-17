// Standalone Task Handlers (plan v6.1 Phase 0.4)
//
// Two endpoints that give the Platform Backend a working async dispatch path
// WITHOUT touching /api/tasks/execute (whose unconditional progressWorkflow()
// call throws "Workflow not found" for any task that has no coordinator
// workflow — which is every PB-originated delegation).
//
//   POST /api/tasks/enqueue-standalone  — service-auth (PB → TR). Validates the
//     payload and self-enqueues a Cloud Task via the existing
//     enqueueAgentExecution helper (receiverPath/receiverBody overrides),
//     targeting execute-standalone below. Returns 202 {taskId} immediately.
//     The Cloud Task name derives from taskId, so PB retries dedup.
//
//   POST /api/tasks/execute-standalone — Cloud Tasks OIDC delivery. Runs
//     executeTask with onConflict:'defer' (busy agents defer and re-deliver
//     instead of being silently dropped) and a synthesized-but-inert
//     workflowId. NEVER calls progressWorkflow.
//
// taskId identity contract: the PB-generated taskId IS this payload's taskId
// IS the id workflow-engine stores in workflow_step_executions.task_id — one
// uuid threads through enqueue, execution, cancellation, and the completion
// callback's `WHERE task_id = $1` lookup.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { agentExecutionService } from '../agent-execution/service';
import { enqueueAgentExecution } from '../infrastructure/cloud-tasks';
import { requireServiceAuth } from '../security/service-auth';
import { resolveRuntimeAgentId } from '../agent-lifecycle/resolve-runtime-agent-id';
import { verifyCloudTasksOidc } from './cloud-tasks-handler';
import { logger } from '../infrastructure/logging';
import { setTraceContext } from '../infrastructure/safe-trace-context';

const router = Router();

// Payload contract shared by both endpoints. Field names are TR's own
// (inputData / escalation / triggerKey) — the PB client maps its legacy
// names before calling. triggeredBy is the ExecuteTaskInput union, NOT the
// audit-string format; granular attribution rides in triggeredByLabel.
const StandaloneTaskSchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  taskId: z.string().uuid(),
  objective: z.string().min(1).max(10000),
  inputData: z.record(z.string(), z.unknown()).optional(),
  triggeredBy: z.enum(['human', 'agent', 'cron', 'event']),
  triggeredByLabel: z.string().max(200).optional(),
  triggerKey: z.string().min(1).max(500),
  hitlLevel: z.number().int().min(0).max(4).optional(),
  escalation: z.enum(['exceptions', 'important', 'sensitive']).optional(),
  requestedByType: z.enum(['mcp_key', 'a2a_token', 'internal']).optional(),
  requestedById: z.string().max(200).optional(),
  deferAttempt: z.number().int().min(0).optional(),
});

// ── POST /api/tasks/enqueue-standalone ────────────────────────────────

router.post(
  '/enqueue-standalone',
  requireServiceAuth(),
  async (req: Request, res: Response) => {
    const parsed = StandaloneTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.issues });
    }
    const p = parsed.data;
    setTraceContext({ tenantId: p.tenantId, agentId: p.agentId });

    try {
      // receiverBody overrides the default agent-scheduled shape entirely;
      // the workflowId/threadId/objective fields on opts only feed the
      // default body and the ledger row, so inert values are fine.
      const result = await enqueueAgentExecution(p.tenantId, p.agentId, {
        workflowId: uuidv4(),
        taskId: p.taskId,
        objective: p.objective,
        threadId: '',
        triggeredBy: p.triggeredBy,
        scheduleKey: p.taskId,
        receiverPath: '/api/tasks/execute-standalone',
        receiverBody: p as unknown as Record<string, unknown>,
      });

      logger.info('Standalone task enqueued', {
        tenant_id: p.tenantId,
        agent_id: p.agentId,
        task_id: p.taskId,
        task_name: result.taskName,
        trigger_key: p.triggerKey,
      });
      return res.status(202).json({ taskId: p.taskId });
    } catch (error) {
      const err = error as Error & { code?: number };
      // Cloud Tasks ALREADY_EXISTS (code 6): the same taskId was enqueued
      // before — dedup, treat as accepted.
      if (err.code === 6) {
        return res.status(202).json({ taskId: p.taskId, deduplicated: true });
      }
      logger.error('Standalone task enqueue failed', {
        tenant_id: p.tenantId,
        agent_id: p.agentId,
        task_id: p.taskId,
        error: err.message,
      });
      return res.status(500).json({ error: 'Enqueue failed' });
    }
  },
);

// ── POST /api/tasks/execute-standalone ────────────────────────────────

router.post('/execute-standalone', async (req: Request, res: Response) => {
  try {
    const isValid = await verifyCloudTasksOidc(req);
    if (!isValid) {
      if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SERVICE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const raw = typeof req.body === 'string'
      ? JSON.parse(Buffer.from(req.body, 'base64').toString())
      : req.body;
    const parsed = StandaloneTaskSchema.safeParse(raw);
    if (!parsed.success) {
      // Malformed payloads are permanent — 200 so Cloud Tasks does not retry.
      logger.error('execute-standalone: invalid payload — dropping', { details: parsed.error.issues });
      return res.status(200).json({ dropped: true });
    }
    const p = parsed.data;
    setTraceContext({ tenantId: p.tenantId, agentId: p.agentId });

    // PB addresses agents by internal_agents.id; TR execution keys by the
    // runtime agents.id — translate at the endpoint boundary like every other
    // PB->TR entry point (falls back to the same id when unmapped).
    const runtimeAgentId = await resolveRuntimeAgentId(p.tenantId, p.agentId, 'standalone-tasks-handler');

    // Synthesized workflowId: executeTask expects a string across its
    // execution paths, and nothing here ever progresses a workflow, so the
    // uuid is inert.
    const result = await agentExecutionService.executeTask({
      tenantId: p.tenantId,
      agentId: runtimeAgentId,
      workflowId: uuidv4(),
      taskId: p.taskId,
      objective: p.objective,
      inputData: p.inputData,
      triggeredBy: p.triggeredBy,
      triggeredByLabel: p.triggeredByLabel,
      triggerKey: p.triggerKey,
      onConflict: 'defer',
      deferAttempt: p.deferAttempt,
      hitlLevel: p.hitlLevel,
      escalation: p.escalation,
      requestedByType: p.requestedByType,
      requestedById: p.requestedById,
    });

    if (result.error === 'duplicate_delivery_in_flight') {
      return res.status(200).json({ deduplicated: true });
    }

    logger.info('Standalone task executed', {
      tenant_id: p.tenantId,
      agent_id: p.agentId,
      runtime_agent_id: runtimeAgentId,
      error: result.error,
      task_id: p.taskId,
      success: result.success,
      deferred: result.deferred === true,
      escalated: result.escalated === true,
    });
    return res.status(200).json({
      success: result.success,
      escalated: result.escalated === true,
      deferred: result.deferred === true,
    });
  } catch (error) {
    logger.error('execute-standalone failed', { error: (error as Error).message });
    // 500 → Cloud Tasks retries with backoff; executeTask's triggerKey
    // idempotency replays the stored result if the run already finished.
    return res.status(500).json({ error: (error as Error).message });
  }
});

export { router as standaloneTasksHandler };
