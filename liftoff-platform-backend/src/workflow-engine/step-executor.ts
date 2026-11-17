// Workflow Step Executor
// Dispatches individual steps to the tenant runtime and advances the run
// when steps complete. Handles retries (up to node.max_retries) and
// parallel join (waits for all branches before advancing).
//
// RLS scope: workflow_runs / workflow_definitions / workflow_step_executions /
// workflow_step_events are RLS-on (migration 200). The executor is a
// background-worker callback invoked by Cloud Tasks with no incoming tenant
// context — the runId in the callback payload uniquely identifies the tenant.
// Admin scope is the correct primitive (auth-lookup pattern). Queries are
// naturally bound by run_id / id so admin bypass exposes no cross-tenant data.

import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { oversightService } from '../internal-agent-oversight/service';
import { resolveAgentHitlLevel, type AutonomyLevel } from '../internal-agent-oversight/types';
import { publishEvent } from '../events/publisher';
import type { WorkflowRunRow, WorkflowNode, WorkflowEdge, WorkflowDefinitionBody } from './types';

// WorkflowRunRow extended with definition JOIN — used in queries that join workflow_definitions
type WorkflowRunWithDefinition = WorkflowRunRow & { definition: WorkflowDefinitionBody };

const DEFAULT_MAX_RETRIES = 2;

// Resolve a handlebars-style template against run context.
// Only supports {{context.key}} and {{context.nested.key}} tokens.
function resolveTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{context\.([^}]+)\}\}/g, (_match, path: string) => {
    const value = path.split('.').reduce<unknown>((obj, key) => {
      return obj != null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
    }, context);
    return value != null ? String(value) : '';
  });
}

// Extract a subset of run context keys per input_mapping spec.
// mapping is { targetKey: 'context.sourceKey' } — JSONPath-lite.
function resolveInputMapping(
  mapping: Record<string, string> | undefined,
  context: Record<string, unknown>,
): Record<string, unknown> {
  if (!mapping) return {};
  const result: Record<string, unknown> = {};
  for (const [targetKey, sourcePath] of Object.entries(mapping)) {
    const segments = sourcePath.replace(/^context\./, '').split('.');
    result[targetKey] = segments.reduce<unknown>((obj, key) => {
      return obj != null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
    }, context);
  }
  return result;
}

// Evaluate a single outgoing edge condition against run context.
function evaluateCondition(
  edge: WorkflowEdge,
  context: Record<string, unknown>,
): boolean {
  if (!edge.condition) return true;

  const { field, operator, value } = edge.condition;
  const segments = field.replace(/^context\./, '').split('.');
  const actual = segments.reduce<unknown>((obj, key) => {
    return obj != null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
  }, context);

  switch (operator) {
    case 'eq':      return actual === value;
    case 'neq':     return actual !== value;
    case 'contains': return typeof actual === 'string' && actual.includes(String(value));
    case 'exists':  return actual !== undefined && actual !== null;
    default:        return false;
  }
}

export async function dispatchStep(
  run: WorkflowRunRow,
  node: WorkflowNode,
  attempt: number = 1,
): Promise<void> {
  if (!node.agent_id) {
    throw new Error(`node "${node.id}" has no agent_id`);
  }

  const objective = resolveTemplate(node.objective_template, run.context);
  const input = resolveInputMapping(node.input_mapping, run.context);

  const oversightSettings = await oversightService.getOrCreateOversightSettings(run.tenant_id);
  // The step's own agent may carry an Autonomy Override, which beats the
  // workspace default. Read separately because the agent row below is loaded
  // inside the step transaction, after this level is needed.
  const overrideRows: Array<{ autonomy_override: AutonomyLevel | null }> = await withAdminScope(
    {
      caller: 'workflow-engine.dispatchStep.autonomyOverride',
      reason: 'workflow background dispatch — resolve the step agent autonomy override',
    },
    async (client) => {
      const r = await client.query<{ autonomy_override: AutonomyLevel | null }>(
        `SELECT autonomy_override FROM internal_agents
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [node.agent_id, run.tenant_id],
      );
      return r.rows;
    },
  );
  const hitlLevel = resolveAgentHitlLevel(
    overrideRows[0]?.autonomy_override,
    oversightSettings.autonomy,
  );

  // ─── DB writes (workflow_step_executions, workflow_runs, workflow_step_events)
  // Run under admin scope: background-worker callback, no request-level
  // tenant context — auth via run_id / run.tenant_id payload.
  const { stepId } = await withAdminScope(
    {
      caller: 'workflow-engine.dispatchStep.preRuntime',
      reason: 'workflow background dispatch — pre-runtime DB row + agent check',
      actor: `workflow-run:${run.id}`,
    },
    async (client) => {
      // Verify agent exists and is active
      const agentResult = await client.query<{ id: string }>(
        `SELECT id FROM internal_agents
         WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND deleted_at IS NULL`,
        [node.agent_id, run.tenant_id],
      );

      if (agentResult.rows.length === 0) {
        throw new Error(`agent "${node.agent_id}" not found or not active`);
      }

      // Create step_execution row
      const stepResult = await client.query<{ id: string }>(
        `INSERT INTO workflow_step_executions
           (run_id, node_id, agent_id, status, input, attempt, started_at)
         VALUES ($1, $2, $3, 'running', $4, $5, NOW())
         RETURNING id`,
        [run.id, node.id, node.agent_id, JSON.stringify(input), attempt],
      );
      return { stepId: stepResult.rows[0].id };
    },
  );

  // Enqueue task in tenant runtime — capture returned taskId if the runtime provides one.
  // Falls back to our synthetic triggerRef so the callback can always look up the step.
  const syntheticRef = `workflow:${run.id}:${node.id}`;
  let runtimeTaskId: string | undefined;
  try {
    ({ taskId: runtimeTaskId } = await tenantRuntimeClient.enqueueAgentTask(run.tenant_id, node.agent_id, {
      objective,
      context: { ...input, workflowRunId: run.id, workflowStepId: stepId },
      triggeredBy: 'workflow',
      triggerRef: syntheticRef,
      hitlLevel,
      escalationLevel: oversightSettings.escalation,
      requestedByType: 'internal',
      requestedById: run.id,
    }));
  } catch (enqueueErr) {
    // enqueueAgentTask THROWS on dispatch failure (plan v6.1 — the old `{}`
    // breaker fallback silently succeeded). Without this cleanup the step
    // row created above would sit 'running' forever with no task behind it.
    await withAdminScope(
      {
        caller: 'workflow-engine.dispatchStep.enqueueFailed',
        reason: 'mark step failed after dispatch failure',
        actor: `workflow-run:${run.id}`,
      },
      (client) => client.query(
        `UPDATE workflow_step_executions SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`,
        [stepId, `dispatch failed: ${(enqueueErr as Error).message}`.slice(0, 500)],
      ),
    ).catch((cleanupErr) => {
      log.error({ runId: run.id, stepId, error: (cleanupErr as Error).message }, 'workflow: step-failed cleanup after dispatch failure also failed');
    });
    throw enqueueErr;
  }
  const storedTaskId = runtimeTaskId ?? syntheticRef;

  await withAdminScope(
    {
      caller: 'workflow-engine.dispatchStep.postRuntime',
      reason: 'workflow background dispatch — post-runtime book-keeping',
      actor: `workflow-run:${run.id}`,
    },
    async (client) => {
      // Store the task ID (runtime's own ID when available, synthetic ref otherwise)
      await client.query(
        `UPDATE workflow_step_executions SET task_id = $1 WHERE id = $2`,
        [storedTaskId, stepId],
      );
      await client.query(
        `UPDATE workflow_runs
         SET current_node_ids = array_append(current_node_ids, $1), updated_at = NOW()
         WHERE id = $2`,
        [node.id, run.id],
      );
      // Audit event
      await client.query(
        `INSERT INTO workflow_step_events (run_id, step_execution_id, event_type, payload)
         VALUES ($1, $2, 'dispatched', $3)`,
        [run.id, stepId, JSON.stringify({ nodeId: node.id, agentId: node.agent_id, attempt, hitlLevel })],
      );
    },
  );

  publishEvent({
    eventType: 'workflow.step.dispatched',
    entityType: 'workflow_run',
    entityId: run.id,
    tenantId: run.tenant_id,
    entityVersion: null,
    eventVersion: 1,
    payload: { runId: run.id, nodeId: node.id, stepId, agentId: node.agent_id },
  }).catch(err => {
    log.warn({ error: (err as Error).message, runId: run.id }, 'workflow: failed to publish step.dispatched event');
  });

  log.info({ runId: run.id, nodeId: node.id, stepId, agentId: node.agent_id, hitlLevel }, 'workflow: step dispatched');
}

export async function onStepCompleted(
  runId: string,
  nodeId: string,
  taskId: string,
  output: unknown,
): Promise<void> {
  const result = await withAdminScope(
    {
      caller: 'workflow-engine.onStepCompleted',
      reason: 'workflow Cloud Tasks callback — completed step',
      actor: `workflow-run:${runId}`,
    },
    async (client): Promise<{
      run: WorkflowRunWithDefinition;
      stepId: string;
      updatedContext: Record<string, unknown>;
      remainingPending: number;
    } | null> => {
      // Fetch run + definition in one round-trip
      const runResult = await client.query<WorkflowRunWithDefinition>(
        `SELECT r.*, d.definition
         FROM workflow_runs r
         JOIN workflow_definitions d ON d.id = r.definition_id
         WHERE r.id = $1 AND r.status = 'running'`,
        [runId],
      );
      if (runResult.rows.length === 0) {
        log.warn({ runId, nodeId }, 'workflow: onStepCompleted called for non-running run — ignoring');
        return null;
      }
      const run = runResult.rows[0];

      // Mark step completed
      const stepResult = await client.query<{ id: string }>(
        `UPDATE workflow_step_executions
         SET status = 'completed', output = $1, completed_at = NOW()
         WHERE run_id = $2 AND node_id = $3 AND status = 'running'
         RETURNING id`,
        [JSON.stringify(output), runId, nodeId],
      );
      if (stepResult.rows.length === 0) return null;
      const stepId = stepResult.rows[0].id;

      // Audit event
      await client.query(
        `INSERT INTO workflow_step_events (run_id, step_execution_id, event_type, payload)
         VALUES ($1, $2, 'completed', $3)`,
        [runId, stepId, JSON.stringify({ nodeId, taskId, output })],
      );

      // Write step output into run context if node defines output_key
      const definition = run.definition;
      const completedNode = definition.nodes.find(n => n.id === nodeId);

      let updatedContext = run.context;
      if (completedNode?.output_key && output != null) {
        updatedContext = { ...run.context, [completedNode.output_key]: output };
        await client.query(
          `UPDATE workflow_runs SET context = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(updatedContext), runId],
        );
      }

      // Remove completed node from current_node_ids
      await client.query(
        `UPDATE workflow_runs
         SET current_node_ids = array_remove(current_node_ids, $1), updated_at = NOW()
         WHERE id = $2`,
        [nodeId, runId],
      );

      // Find outgoing edges whose conditions are satisfied
      const outgoing = definition.edges.filter(e => e.from === nodeId && evaluateCondition(e, updatedContext));

      let remainingPending = 0;
      if (outgoing.length === 0) {
        // No outgoing edges — check if any other nodes are still running
        const pendingResult = await client.query<{ count: string }>(
          `SELECT COUNT(*) FROM workflow_step_executions
           WHERE run_id = $1 AND status IN ('pending', 'running')`,
          [runId],
        );
        remainingPending = parseInt(pendingResult.rows[0].count, 10);
        if (remainingPending === 0) {
          await client.query(
            `UPDATE workflow_runs SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [runId],
          );
        }
      }

      return { run, stepId, updatedContext, remainingPending };
    },
  );

  if (!result) return;
  const { run, stepId, updatedContext, remainingPending } = result;
  const definition = run.definition;
  const outgoing = definition.edges.filter(e => e.from === nodeId && evaluateCondition(e, updatedContext));

  publishEvent({
    eventType: 'workflow.step.completed',
    entityType: 'workflow_run',
    entityId: runId,
    tenantId: run.tenant_id,
    entityVersion: null,
    eventVersion: 1,
    payload: { runId, nodeId, stepId },
  }).catch(err => {
    log.warn({ error: (err as Error).message, runId }, 'workflow: failed to publish step.completed event');
  });

  if (outgoing.length === 0 && remainingPending === 0) {
    publishEvent({
      eventType: 'workflow.run.completed',
      entityType: 'workflow_run',
      entityId: runId,
      tenantId: run.tenant_id,
      entityVersion: null,
      eventVersion: 1,
      payload: { runId },
    }).catch(() => {});
    log.info({ runId }, 'workflow: run completed');
    return;
  }
  if (outgoing.length === 0) return;

  // Dispatch next nodes — parallel_join nodes are checked rather than dispatched directly
  const nextNodes = outgoing.map(e => definition.nodes.find(n => n.id === e.to)).filter(Boolean) as WorkflowNode[];
  const updatedRun: WorkflowRunRow = { ...run, context: updatedContext };

  await Promise.all(nextNodes.map(node => {
    if (node.type === 'parallel_join') {
      return handleParallelJoin(updatedRun, node.id, definition);
    }
    return dispatchStep(updatedRun, node);
  }));
}

export async function onStepFailed(
  runId: string,
  nodeId: string,
  taskId: string,
  error: string,
): Promise<void> {
  const result = await withAdminScope(
    {
      caller: 'workflow-engine.onStepFailed',
      reason: 'workflow Cloud Tasks callback — failed step',
      actor: `workflow-run:${runId}`,
    },
    async (client): Promise<{
      run: WorkflowRunWithDefinition;
      stepId: string;
      attempt: number;
      failedNode: WorkflowNode | undefined;
      shouldRetry: boolean;
      shouldFailRun: boolean;
    } | null> => {
      const runResult = await client.query<WorkflowRunWithDefinition>(
        `SELECT r.*, d.definition
         FROM workflow_runs r
         JOIN workflow_definitions d ON d.id = r.definition_id
         WHERE r.id = $1 AND r.status = 'running'`,
        [runId],
      );
      if (runResult.rows.length === 0) return null;
      const run = runResult.rows[0];

      // Fetch current attempt count
      const stepResult = await client.query<{ id: string; attempt: number }>(
        `UPDATE workflow_step_executions
         SET status = 'failed', error = $1, completed_at = NOW()
         WHERE run_id = $2 AND node_id = $3 AND status = 'running'
         RETURNING id, attempt`,
        [error, runId, nodeId],
      );
      if (stepResult.rows.length === 0) return null;
      const { id: stepId, attempt } = stepResult.rows[0];

      await client.query(
        `INSERT INTO workflow_step_events (run_id, step_execution_id, event_type, payload)
         VALUES ($1, $2, 'failed', $3)`,
        [runId, stepId, JSON.stringify({ nodeId, taskId, error, attempt })],
      );

      const definition = run.definition;
      const failedNode = definition.nodes.find(n => n.id === nodeId);
      const maxRetries = failedNode?.max_retries ?? DEFAULT_MAX_RETRIES;
      const shouldRetry = attempt < maxRetries;

      if (shouldRetry) {
        await client.query(
          `INSERT INTO workflow_step_events (run_id, step_execution_id, event_type, payload)
           VALUES ($1, $2, 'retried', $3)`,
          [runId, stepId, JSON.stringify({ attempt: attempt + 1 })],
        );
      } else {
        await client.query(
          `UPDATE workflow_runs
           SET status = 'failed', completed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [runId],
        );
      }

      return {
        run,
        stepId,
        attempt,
        failedNode,
        shouldRetry,
        shouldFailRun: !shouldRetry,
      };
    },
  );

  if (!result) return;
  const { run, attempt, failedNode, shouldRetry, shouldFailRun } = result;

  if (shouldRetry && failedNode) {
    log.info({ runId, nodeId, attempt, maxRetries: failedNode.max_retries ?? DEFAULT_MAX_RETRIES }, 'workflow: retrying failed step');
    await dispatchStep(run, failedNode, attempt + 1);
  } else if (shouldFailRun) {
    publishEvent({
      eventType: 'workflow.run.failed',
      entityType: 'workflow_run',
      entityId: runId,
      tenantId: run.tenant_id,
      entityVersion: null,
      eventVersion: 1,
      payload: { runId, nodeId, error },
    }).catch(() => {});
    log.error({ runId, nodeId, attempt, error }, 'workflow: run failed after max retries');
  }
}

export async function handleParallelJoin(
  run: WorkflowRunRow,
  joinNodeId: string,
  definition: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
): Promise<void> {
  // Gather all nodes that are upstream of the join node
  const incomingNodeIds = definition.edges
    .filter(e => e.to === joinNodeId)
    .map(e => e.from);

  const allComplete = await withAdminScope(
    {
      caller: 'workflow-engine.handleParallelJoin',
      reason: 'workflow background — check parallel-join completion state',
      actor: `workflow-run:${run.id}`,
    },
    async (client) => {
      const completedResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) FROM workflow_step_executions
         WHERE run_id = $1 AND node_id = ANY($2) AND status = 'completed'`,
        [run.id, incomingNodeIds],
      );
      return parseInt(completedResult.rows[0].count, 10) >= incomingNodeIds.length;
    },
  );

  if (!allComplete) return;

  // All branches done — dispatch the join node
  const joinNode = definition.nodes.find(n => n.id === joinNodeId);
  if (joinNode) {
    await dispatchStep(run, joinNode);
  }
}
