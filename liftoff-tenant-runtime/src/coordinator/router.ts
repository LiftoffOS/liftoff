// Workflow Coordinator REST router.
//
// Mount at `/api/v1` in src/index.ts. Non-CRUD actions follow the GitHub /
// Stripe REST idiom: a POST to a sub-resource that names the event created
// (e.g., `POST /workflows/{id}/completions` creates a completion event on
// the workflow, with state change as a side effect). This keeps the verb
// in the HTTP method, not the path.
//
// Resource map:
//
//   Workflows:
//     POST   /workflows                                       — start
//     GET    /workflows/{id}                                  — read
//     GET    /workflows/{id}/hierarchy                        — tree
//     GET    /workflows/{id}/child-workflows                  — list children
//     POST   /workflows/{id}/resumptions                      — resume from checkpoint
//     POST   /workflows/{id}/reconciliations                  — reconcile one
//     POST   /workflows/{id}/completions                      — complete
//     POST   /workflows/{id}/failures                         — fail
//     POST   /workflows/{id}/compensations                    — trigger compensation
//     GET    /workflows/{id}/compensations                    — compensation status
//     POST   /workflows/{id}/sub-completions                  — complete as sub-workflow
//     POST   /workflows/{id}/checkpoints                      — commit a transition
//
//   Tasks (scoped to their parent task for spawn / list):
//     POST   /tasks/{id}/child-tasks
//     GET    /tasks/{id}/child-tasks                          — ?wait=true polls
//     POST   /tasks/{id}/sub-workflows
//
//   Child tasks (flat once spawned):
//     POST   /child-tasks/{id}/completions
//     POST   /child-tasks/{id}/failures
//
//   Cross-cutting:
//     POST   /reconciliations                                 — full reconciliation
//     POST   /actions/{id}/compensations                      — compensate one action
//
// Auth accepts Google OIDC (aud == COORDINATOR_SERVICE_URL) or the shared
// X-Service-Auth bearer. Agent-service's CoordinatorHttpClient targets the
// exact paths above.

import { Router } from 'express';
import { CoordinatorService } from './service';
import { requireServiceAuth } from '../security/service-auth';

export const coordinatorRouter = Router();
const service = new CoordinatorService();

function resolveTenantRuntimeSaEmail(): string[] {
  const tenantId = process.env.TENANT_ID;
  const env = process.env.ENVIRONMENT;
  if (!tenantId || !env) return [];
  return [`tenant-${tenantId}-runtime@tenant-${tenantId}-${env}.iam.gserviceaccount.com`];
}

function resolveOidcAudience(): string | undefined {
  const url = process.env.COORDINATOR_SERVICE_URL?.trim();
  return url && url.length > 0 ? url : undefined;
}

coordinatorRouter.use(
  requireServiceAuth({
    acceptOidc: true,
    oidcAudience: () => resolveOidcAudience() ?? '',
    allowedOidcEmails: resolveTenantRuntimeSaEmail,
  }),
);

// -----------------------------------------------------------------------------
// Workflows
// -----------------------------------------------------------------------------

coordinatorRouter.post('/workflows', async (req, res) => {
  const workflow = await service.startWorkflow(req.body);
  res.status(201).json(workflow);
});

coordinatorRouter.get('/workflows/:id', async (req, res) => {
  const workflow = await service.getWorkflow(req.params.id);
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  res.json(workflow);
});

coordinatorRouter.get('/workflows/:id/hierarchy', async (req, res) => {
  const hierarchy = await service.getWorkflowHierarchy(req.params.id);
  if (!hierarchy) {
    return res.status(404).json({ error: 'Workflow hierarchy not found' });
  }
  res.json(hierarchy);
});

coordinatorRouter.get('/workflows/:id/child-workflows', async (req, res) => {
  const children = await service.getChildWorkflows(req.params.id);
  res.json({ items: children });
});

// -----------------------------------------------------------------------------
// Workflow state transitions — POST sub-resource creates the event
// -----------------------------------------------------------------------------

coordinatorRouter.post('/workflows/:id/resumptions', async (req, res) => {
  await service.resumeWorkflow(req.params.id);
  res.status(201).json({ workflowId: req.params.id, resumed: true });
});

coordinatorRouter.post('/workflows/:id/reconciliations', async (req, res) => {
  await service.reconcileWorkflow(req.params.id);
  res.status(201).json({ workflowId: req.params.id, reconciled: true });
});

coordinatorRouter.post('/workflows/:id/completions', async (req, res) => {
  const workflow = await service.completeWorkflow(req.params.id, req.body?.outcome);
  res.status(201).json(workflow);
});

coordinatorRouter.post('/workflows/:id/failures', async (req, res) => {
  const workflow = await service.failWorkflow(req.params.id, req.body?.error ?? 'unspecified');
  res.status(201).json(workflow);
});

coordinatorRouter.post('/workflows/:id/sub-completions', async (req, res) => {
  const result = await service.completeSubWorkflow(req.params.id);
  res.status(201).json(result);
});

coordinatorRouter.post('/workflows/:id/compensations', async (req, res) => {
  const result = await service.compensateWorkflow(
    req.params.id,
    req.body?.reason || 'Manual compensation triggered',
  );
  res.status(201).json(result);
});

coordinatorRouter.get('/workflows/:id/compensations', async (req, res) => {
  const status = await service.getCompensationStatus(req.params.id);
  res.json(status);
});

// Commit a workflow transition checkpoint. Previously a loose
// /commit-transition RPC — now scoped to the workflow whose state it
// transitions. Body carries taskId, idempotencyKey, newState, pendingToolCalls.
coordinatorRouter.post('/workflows/:id/checkpoints', async (req, res) => {
  const checkpoint = await service.commitTransition({
    workflowId: req.params.id,
    taskId: req.body?.taskId,
    idempotencyKey: req.body?.idempotencyKey,
    newState: req.body?.newState,
    pendingToolCalls: req.body?.pendingToolCalls ?? [],
  });
  res.status(201).json(checkpoint);
});

// -----------------------------------------------------------------------------
// Tasks — spawn child tasks / sub-workflows, list children
// -----------------------------------------------------------------------------

coordinatorRouter.post('/tasks/:taskId/child-tasks', async (req, res) => {
  const childTask = await service.spawnChildTask({
    parentTaskId: req.params.taskId,
    ...req.body,
  });
  res.status(201).json(childTask);
});

// `?wait=true` long-polls until children complete, matching the previous
// /children/wait endpoint. Without the flag, returns the current list.
coordinatorRouter.get('/tasks/:taskId/child-tasks', async (req, res) => {
  if (req.query.wait === 'true' || req.query.wait === '1') {
    const results = await service.waitForChildTasks(req.params.taskId);
    res.json({ items: results });
    return;
  }
  const children = await service.getChildTasks(req.params.taskId);
  res.json({ items: children });
});

coordinatorRouter.post('/tasks/:taskId/sub-workflows', async (req, res) => {
  const subWorkflow = await service.spawnSubWorkflow({
    parentTaskId: req.params.taskId,
    ...req.body,
  });
  res.status(201).json(subWorkflow);
});

// -----------------------------------------------------------------------------
// Child tasks — flat resource, completion/failure as sub-resources
// -----------------------------------------------------------------------------

coordinatorRouter.post('/child-tasks/:id/completions', async (req, res) => {
  const childTask = await service.completeChildTask(req.params.id, req.body?.result);
  res.status(201).json(childTask);
});

coordinatorRouter.post('/child-tasks/:id/failures', async (req, res) => {
  const childTask = await service.failChildTask(req.params.id, req.body?.error ?? 'unspecified');
  res.status(201).json(childTask);
});

// -----------------------------------------------------------------------------
// Cross-cutting
// -----------------------------------------------------------------------------

// Full reconciliation run (plan §19). Creating a `/reconciliations` resource
// signals a fresh reconciliation pass; returns an acknowledgement.
coordinatorRouter.post('/reconciliations', async (_req, res) => {
  await service.runReconciliation();
  res.status(202).json({ status: 'reconciliation_complete' });
});

// Compensate a specific action by id.
coordinatorRouter.post('/actions/:id/compensations', async (req, res) => {
  const result = await service.compensateAction(
    req.params.id,
    req.body?.reason || 'Manual action compensation',
  );
  res.status(201).json(result);
});
