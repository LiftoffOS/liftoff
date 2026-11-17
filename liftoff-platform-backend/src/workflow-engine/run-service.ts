// Workflow Run Service — lifecycle management for workflow_runs
//
// RLS scope: workflow_runs / workflow_step_executions are RLS-on (migration 200).
// Public functions accept tenantId — use withTenantScope for tenant-bound
// reads/writes.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { publishEvent } from '../events/publisher';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { dispatchStep } from './step-executor';
import { getDefinition } from './definition-service';
import type { WorkflowRunRow } from './types';

export async function startRun(
  tenantId: string,
  definitionId: string,
  context: Record<string, unknown>,
  triggeredBy: string,
  triggerRef?: string,
): Promise<WorkflowRunRow> {
  const definition = await getDefinition(tenantId, definitionId);
  if (!definition) throw new Error('Workflow definition not found');
  if (definition.status !== 'active') {
    throw new Error(`Cannot start a run from a "${definition.status}" definition`);
  }

  const run = await withTenantScope(tenantId, async (client) => {
    const runResult = await client.query<WorkflowRunRow>(
      `INSERT INTO workflow_runs
         (tenant_id, definition_id, definition_version, context, triggered_by, trigger_ref)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tenantId, definitionId, definition.version, JSON.stringify(context), triggeredBy, triggerRef ?? null],
    );
    return runResult.rows[0];
  });

  publishEvent({
    eventType: 'workflow.run.started',
    entityType: 'workflow_run',
    entityId: run.id,
    tenantId,
    entityVersion: null,
    eventVersion: 1,
    payload: { runId: run.id, definitionId, triggeredBy },
  }).catch(err => {
    log.warn({ error: (err as Error).message, runId: run.id }, 'workflow: failed to publish run.started event');
  });

  // Dispatch the entry node
  const defBody = definition.definition;
  const entryNode = defBody.nodes.find(n => n.id === defBody.entry_node_id);

  if (!entryNode) throw new Error(`Entry node "${defBody.entry_node_id}" not found`);

  await dispatchStep(run, entryNode);

  log.info({ runId: run.id, definitionId, triggeredBy }, 'workflow: run started');
  return run;
}

export async function cancelRun(tenantId: string, runId: string): Promise<boolean> {
  const stepsToCancel = await withTenantScope(tenantId, async (client): Promise<
    Array<{ node_id: string; agent_id: string; task_id: string }> | null
  > => {
    const result = await client.query<WorkflowRunRow>(
      `UPDATE workflow_runs
       SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status IN ('running', 'paused')
       RETURNING *`,
      [runId, tenantId],
    );
    if (result.rows.length === 0) return null;

    // Best-effort cancel in-flight tasks
    const stepsResult = await client.query<{ node_id: string; agent_id: string; task_id: string }>(
      `UPDATE workflow_step_executions
       SET status = 'skipped', completed_at = NOW()
       WHERE run_id = $1 AND status IN ('pending', 'running')
       RETURNING node_id, agent_id, task_id`,
      [runId],
    );
    return stepsResult.rows;
  });
  if (stepsToCancel === null) return false;

  await Promise.allSettled(
    stepsToCancel
      .filter(s => s.task_id)
      .map(s => tenantRuntimeClient.cancelAgentTask(tenantId, s.agent_id, s.task_id)),
  );

  log.info({ runId, tenantId }, 'workflow: run cancelled');
  return true;
}

export async function getRunStatus(tenantId: string, runId: string): Promise<{
  run: WorkflowRunRow;
  steps: Array<{ id: string; nodeId: string; status: string; createdAt: Date }>;
} | null> {
  return withTenantScope(tenantId, async (client) => {
    const runResult = await client.query<WorkflowRunRow>(
      `SELECT * FROM workflow_runs WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );
    if (runResult.rows.length === 0) return null;

    const stepsResult = await client.query<{ id: string; node_id: string; status: string; created_at: Date }>(
      `SELECT id, node_id, status, created_at FROM workflow_step_executions
       WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId],
    );

    return {
      run: runResult.rows[0],
      steps: stepsResult.rows.map(s => ({
        id: s.id,
        nodeId: s.node_id,
        status: s.status,
        createdAt: s.created_at,
      })),
    };
  });
}

export async function listRuns(
  tenantId: string,
  opts: { status?: string; definitionId?: string; limit?: number; offset?: number } = {},
): Promise<WorkflowRunRow[]> {
  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];

  if (opts.status) {
    params.push(opts.status);
    conditions.push(`status = $${params.length}`);
  }
  if (opts.definitionId) {
    params.push(opts.definitionId);
    conditions.push(`definition_id = $${params.length}`);
  }

  params.push(opts.limit ?? 50);
  params.push(opts.offset ?? 0);

  const result = await withTenantScope(tenantId, (client) =>
    client.query<WorkflowRunRow>(
      `SELECT * FROM workflow_runs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
  );
  return result.rows;
}
