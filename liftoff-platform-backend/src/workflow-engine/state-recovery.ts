// Workflow State Recovery
// On service startup (or periodic sweep), re-dispatches step_executions
// that are stuck in 'running' with no recent activity — guards against
// steps going stale across Cloud Run instance restarts.
//
// Cross-tenant sweep: this runs over every active tenant by definition,
// scanning workflow_step_executions for stale rows. Admin scope is correct.

import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { dispatchStep } from './step-executor';
import type { WorkflowRunRow, WorkflowNode } from './types';

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export async function recoverStaleSteps(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  type StaleRow = {
    step_id: string;
    run_id: string;
    node_id: string;
    agent_id: string;
    attempt: number;
    tenant_id: string;
    context: Record<string, unknown>;
    definition: unknown;
  };

  const staleRows = await withAdminScope(
    {
      caller: 'workflow-engine.state-recovery.scan',
      reason: 'cross-tenant scan for stale workflow step executions',
    },
    async (client) => {
      const result = await client.query<StaleRow>(
        `SELECT s.id AS step_id, s.run_id, s.node_id, s.agent_id, s.attempt,
                r.tenant_id, r.context, d.definition
         FROM workflow_step_executions s
         JOIN workflow_runs r ON r.id = s.run_id
         JOIN workflow_definitions d ON d.id = r.definition_id
         WHERE s.status IN ('pending', 'running')
           AND s.created_at < $1
           AND r.status = 'running'`,
        [staleThreshold],
      );
      return result.rows;
    },
  );

  if (staleRows.length === 0) return;

  log.info({ staleSteps: staleRows.length }, 'workflow state-recovery: re-dispatching stale steps');

  for (const row of staleRows) {
    try {
      const definition = row.definition as { nodes: WorkflowNode[] };
      const node = definition.nodes.find(n => n.id === row.node_id);
      if (!node) {
        log.warn({ runId: row.run_id, nodeId: row.node_id }, 'workflow state-recovery: node not found in definition');
        continue;
      }

      const run: WorkflowRunRow = {
        id: row.run_id,
        tenant_id: row.tenant_id,
        context: row.context,
        current_node_ids: [],
        definition_id: '',
        definition_version: 0,
        status: 'running',
        triggered_by: '',
        trigger_ref: null,
        started_at: new Date(),
        completed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Mark the stale step as failed before re-dispatching so audit trail is clean
      await withAdminScope(
        {
          caller: 'workflow-engine.state-recovery.markStale',
          reason: 'mark stale step failed before re-dispatching',
          actor: `workflow-run:${row.run_id}`,
        },
        (client) =>
          client.query(
            `UPDATE workflow_step_executions
             SET status = 'failed', error = 'stale — recovered by state-recovery'
             WHERE id = $1`,
            [row.step_id],
          ),
      );

      await dispatchStep(run, node, row.attempt + 1);
      log.info({ runId: row.run_id, nodeId: row.node_id }, 'workflow state-recovery: step re-dispatched');
    } catch (err) {
      log.error({ runId: row.run_id, nodeId: row.node_id, error: (err as Error).message },
        'workflow state-recovery: failed to re-dispatch step');
    }
  }
}
