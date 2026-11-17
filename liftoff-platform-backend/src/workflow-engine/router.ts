// Workflow Engine Router
//
// REST API for workflow definitions and runs. All tenant-scoped routes require
// Firebase auth (via authMiddleware mounted before /api in index.ts).
// tenantId from req.query.tenantId; userId from req.ctx?.userId.
//
// HMAC-authenticated internal callback for step-completed notifications:
//   POST /api/internal/workflow/step-completed
//   Headers: X-Workflow-Timestamp, X-Workflow-Signature
//   HMAC-SHA256(method + '\n' + path + '\n' + timestamp + '\n' + body)
//   Replay window: 60 seconds

import { createHmac, timingSafeEqual } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { log } from '../infrastructure/logging';
import {
  createDefinition, updateDefinition, activateDefinition,
  archiveDefinition, getDefinition, listDefinitions,
} from './definition-service';
import {
  startRun, cancelRun, getRunStatus, listRuns,
} from './run-service';
import { onStepCompleted, onStepFailed } from './step-executor';
import { withAdminScope, withTenantScope } from '../infrastructure/database';

// ── HMAC auth for internal callbacks ──────────────────────────────────────────

function validateWorkflowHmac(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.WORKFLOW_INTERNAL_TOKEN;
  if (!token) {
    log.error({}, 'workflow.internal: WORKFLOW_INTERNAL_TOKEN not configured');
    res.status(503).json({ error: 'misconfigured' });
    return;
  }

  const timestampHeader = req.headers['x-workflow-timestamp'] as string | undefined;
  const signatureHeader = req.headers['x-workflow-signature'] as string | undefined;

  if (!timestampHeader || !signatureHeader) {
    res.status(401).json({ error: 'missing_workflow_signature_headers' });
    return;
  }

  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp) || Math.abs(Date.now() - timestamp) > 60_000) {
    res.status(401).json({ error: 'signature_expired' });
    return;
  }

  const bodyStr = JSON.stringify(req.body ?? {});
  const signingString = `${req.method}\n${req.originalUrl.split('?')[0]}\n${timestamp}\n${bodyStr}`;
  const expected = createHmac('sha256', token).update(signingString).digest('hex');

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    log.warn({ path: req.path }, 'workflow.internal: invalid HMAC signature');
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  next();
}

// ── Idempotency: prevent double-advancement on redelivery ─────────────────────

const processedCallbacks = new Map<string, number>();
const CALLBACK_TTL_MS = 5 * 60 * 1000;

function isCallbackAlreadyProcessed(key: string): boolean {
  const entry = processedCallbacks.get(key);
  if (!entry) return false;
  if (Date.now() - entry > CALLBACK_TTL_MS) {
    processedCallbacks.delete(key);
    return false;
  }
  return true;
}

function markCallbackProcessed(key: string): void {
  processedCallbacks.set(key, Date.now());
}

// ── Internal callback router ───────────────────────────────────────────────────
// Mounted at /api/internal/workflow — BEFORE authMiddleware in index.ts

export const workflowInternalRouter = Router();

workflowInternalRouter.post(
  '/step-completed',
  validateWorkflowHmac,
  async (req: Request, res: Response) => {
    const { tenantId, taskId, stepId: directStepId, status, output, error } = req.body as {
      tenantId: string;
      taskId: string;
      stepId?: string;           // optional — runtime may echo workflowStepId from task context
      status: 'completed' | 'failed';
      output?: unknown;
      error?: string;
    };

    if (!tenantId || !taskId || !status) {
      res.status(400).json({ error: 'tenantId, taskId, and status are required' });
      return;
    }

    const idempotencyKey = `${tenantId}:${taskId}`;
    if (isCallbackAlreadyProcessed(idempotencyKey)) {
      res.json({ ok: true, idempotent: true });
      return;
    }

    try {
      // HMAC-authenticated internal callback from the tenant runtime — no
      // request-level tenant scope is established. The step row uniquely
      // identifies the tenant via run_id; admin scope is the correct
      // primitive for the lookup.
      const stepRow = await withAdminScope(
        {
          caller: 'workflow-engine.router.step-completed-callback',
          reason: 'HMAC-authed runtime callback — pre-tenant-context step lookup',
          actor: `workflow-task:${taskId}`,
        },
        async (client) => {
          // Primary lookup by task_id (covers both runtime-returned ID and synthetic triggerRef).
          // Secondary lookup by step execution ID when the runtime echoes back workflowStepId
          // from task context — handles runtimes that use their own internal task IDs.
          let result = await client.query<{ id: string; run_id: string; node_id: string }>(
            `SELECT id, run_id, node_id FROM workflow_step_executions WHERE task_id = $1`,
            [taskId],
          );
          if (result.rows.length === 0 && directStepId) {
            result = await client.query<{ id: string; run_id: string; node_id: string }>(
              `SELECT id, run_id, node_id FROM workflow_step_executions WHERE id = $1`,
              [directStepId],
            );
          }
          return result.rows[0] ?? null;
        },
      );

      if (!stepRow) {
        log.warn({ taskId, directStepId }, 'workflow.internal: step not found for callback');
        res.status(404).json({ error: 'step not found' });
        return;
      }

      const { run_id: runId, node_id: nodeId } = stepRow;
      markCallbackProcessed(idempotencyKey);

      if (status === 'completed') {
        await onStepCompleted(runId, nodeId, taskId, output);
      } else {
        await onStepFailed(runId, nodeId, taskId, error ?? 'unknown error');
      }

      res.json({ ok: true });
    } catch (err) {
      log.error({ error: (err as Error).message, taskId }, 'workflow.internal: step-completed handler failed');
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ── Tenant-scoped API routers ──────────────────────────────────────────────────
// Mounted at /api/workflow-definitions and /api/workflow-runs — AFTER authMiddleware

export const workflowDefinitionsRouter = Router();

workflowDefinitionsRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  const userId = req.ctx?.userId ?? 'unknown';
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }
  try {
    const def = await createDefinition(tenantId, req.body as Parameters<typeof createDefinition>[1], userId);
    res.status(201).json(def);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('Invalid definition:')) { res.status(400).json({ error: msg }); return; }
    log.error({ error: msg }, 'workflow: createDefinition failed');
    res.status(500).json({ error: 'internal_error' });
  }
});

workflowDefinitionsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }
  const { status, limit, offset } = req.query as Record<string, string>;
  const defs = await listDefinitions(tenantId, {
    status: status as 'draft' | 'active' | 'archived' | undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });
  res.json({ definitions: defs, total: defs.length });
});

workflowDefinitionsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }
  const def = await getDefinition(tenantId, req.params.id);
  if (!def) { res.status(404).json({ error: 'not_found' }); return; }
  res.json(def);
});

workflowDefinitionsRouter.patch('/:id', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  const userId = req.ctx?.userId ?? 'unknown';
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }
  try {
    const def = await updateDefinition(tenantId, req.params.id, req.body as Parameters<typeof updateDefinition>[2], userId);
    if (!def) { res.status(404).json({ error: 'not_found' }); return; }
    res.json(def);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('Invalid definition:')) { res.status(400).json({ error: msg }); return; }
    res.status(500).json({ error: 'internal_error' });
  }
});

workflowDefinitionsRouter.post('/:id/activate', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }
  const def = await activateDefinition(tenantId, req.params.id);
  if (!def) { res.status(404).json({ error: 'not_found_or_not_draft' }); return; }
  res.json(def);
});

workflowDefinitionsRouter.post('/:id/archive', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }
  const def = await archiveDefinition(tenantId, req.params.id);
  if (!def) { res.status(404).json({ error: 'not_found_or_already_archived' }); return; }
  res.json(def);
});

export const workflowRunsRouter = Router();

workflowRunsRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  const userId = req.ctx?.userId ?? 'unknown';
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }
  const { definitionId, context, triggerRef } = req.body as {
    definitionId: string; context?: Record<string, unknown>; triggerRef?: string;
  };
  if (!definitionId) { res.status(400).json({ error: 'definitionId is required' }); return; }
  try {
    const run = await startRun(tenantId, definitionId, context ?? {}, userId, triggerRef);
    res.status(201).json(run);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found') || msg.includes('Cannot start')) {
      res.status(400).json({ error: msg }); return;
    }
    log.error({ error: msg }, 'workflow: startRun failed');
    res.status(500).json({ error: 'internal_error' });
  }
});

workflowRunsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }
  const { status, definitionId, limit, offset } = req.query as Record<string, string>;
  const runs = await listRuns(tenantId, {
    status,
    definitionId,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });
  res.json({ runs, total: runs.length });
});

workflowRunsRouter.get('/:id', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }
  const result = await getRunStatus(tenantId, req.params.id);
  if (!result) { res.status(404).json({ error: 'not_found' }); return; }
  res.json(result);
});

workflowRunsRouter.get('/:id/steps', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }

  const result = await withTenantScope(tenantId, async (client) => {
    const runCheck = await client.query<{ id: string }>(
      `SELECT id FROM workflow_runs WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId],
    );
    if (runCheck.rows.length === 0) return null;

    const stepsResult = await client.query(
      `SELECT s.*, array_agg(e.event_type ORDER BY e.created_at) AS event_types
       FROM workflow_step_executions s
       LEFT JOIN workflow_step_events e ON e.step_execution_id = s.id
       WHERE s.run_id = $1
       GROUP BY s.id
       ORDER BY s.created_at ASC`,
      [req.params.id],
    );
    return stepsResult.rows;
  });

  if (result === null) { res.status(404).json({ error: 'not_found' }); return; }
  res.json({ steps: result });
});

workflowRunsRouter.post('/:id/cancel', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) { res.status(400).json({ error: 'tenantId required' }); return; }
  const ok = await cancelRun(tenantId, req.params.id);
  if (!ok) { res.status(404).json({ error: 'not_found_or_not_running' }); return; }
  res.json({ ok: true });
});
