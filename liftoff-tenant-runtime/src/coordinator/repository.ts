// Coordinator Repository
// Per Section 7: Required workflow tables

import { pool } from '../infrastructure/database';
import {
  Workflow,
  StartWorkflowInput,
  WorkflowTask,
  ChildTask,
  WorkflowHierarchy,
  ChildTaskResult,
  WorkflowCheckpoint,
  ToolCall,
} from './types';
import { validateSchema, schemas } from '../infrastructure/repository-validation';

export class WorkflowRepository {
  async create(input: StartWorkflowInput): Promise<Workflow> {
    // Validate input
    validateSchema(input as unknown as Record<string, unknown>, schemas.workflow);

    const result = await pool.query(
      `INSERT INTO workflows (tenant_id, agent_id, objective, status)
       VALUES ($1, $2, $3, 'pending') RETURNING *`,
      [input.tenantId, input.agentId, input.objective]
    );
    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<Workflow | null> {
    const result = await pool.query(`SELECT * FROM workflows WHERE id = $1`, [id]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async updateStatus(id: string, status: string): Promise<void> {
    await pool.query(
      `UPDATE workflows SET status = $2, updated_at = NOW() WHERE id = $1`,
      [id, status]
    );
  }

  // Update compensation state on workflow
  async updateCompensationState(
    id: string,
    state: { reason: string; compensatedTasks: string[]; pendingCompensations: string[] }
  ): Promise<void> {
    await pool.query(
      `UPDATE workflows SET compensation_state = $2, updated_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(state)]
    );
  }

  // Set final outcome for a completed/failed workflow
  async setFinalOutcome(id: string, outcome: { success: boolean; result?: any; error?: string }): Promise<void> {
    await pool.query(
      `UPDATE workflows SET final_outcome = $2, updated_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(outcome)]
    );
  }

  // Count recent workflow failures for an agent (for reflection triggers)
  async countRecentFailures(agentId: string, days: number = 7): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM workflows
       WHERE agent_id = $1
       AND status = 'failed'
       AND created_at > NOW() - INTERVAL '1 day' * $2`,
      [agentId, days]
    );
    return parseInt(result.rows[0].count, 10);
  }

  // Per Section 19: Find all workflows that are not in terminal state for reconciliation
  async findActiveWorkflows(): Promise<Workflow[]> {
    const result = await pool.query(
      `SELECT * FROM workflows
       WHERE status IN ('pending', 'running', 'paused', 'compensating')
       ORDER BY created_at`
    );
    return result.rows.map(this.mapRow);
  }

  // Per Section 7: Scan leased and incomplete tasks
  async findLeasedAndIncompleteTasks(workflowId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM workflow_tasks
       WHERE workflow_id = $1
       AND status IN ('leased', 'running')`,
      [workflowId]
    );
    return result.rows;
  }

  // Per Section 7: Get checkpoint for task
  async getCheckpoint(workflowId: string, taskId: string): Promise<WorkflowCheckpoint | null> {
    const result = await pool.query(
      `SELECT * FROM workflow_checkpoints
       WHERE workflow_id = $1 AND task_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [workflowId, taskId]
    );
    return result.rows[0] ? this.mapCheckpointRow(result.rows[0]) : null;
  }

  // Per Section 7: Save checkpoint for workflow state transition
  async saveCheckpoint(checkpoint: {
    workflowId: string;
    taskId: string;
    state: any;
    idempotencyKey: string;
    pendingToolCalls: ToolCall[];
  }): Promise<WorkflowCheckpoint> {
    const result = await pool.query(
      `INSERT INTO workflow_checkpoints
       (workflow_id, task_id, state, idempotency_key, pending_tool_calls)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         state = EXCLUDED.state,
         pending_tool_calls = EXCLUDED.pending_tool_calls,
         created_at = NOW()
       RETURNING *`,
      [
        checkpoint.workflowId,
        checkpoint.taskId,
        JSON.stringify(checkpoint.state),
        checkpoint.idempotencyKey,
        JSON.stringify(checkpoint.pendingToolCalls),
      ]
    );
    return this.mapCheckpointRow(result.rows[0]);
  }

  // Per Section 7: Find checkpoint by idempotency key for resume
  async findCheckpointByIdempotencyKey(idempotencyKey: string): Promise<WorkflowCheckpoint | null> {
    const result = await pool.query(
      `SELECT * FROM workflow_checkpoints WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    return result.rows[0] ? this.mapCheckpointRow(result.rows[0]) : null;
  }

  // Per Section 7: Update checkpoint pending tool calls after execution
  async updateCheckpointToolCalls(
    checkpointId: string,
    pendingToolCalls: ToolCall[]
  ): Promise<void> {
    await pool.query(
      `UPDATE workflow_checkpoints
       SET pending_tool_calls = $2, created_at = NOW()
       WHERE id = $1`,
      [checkpointId, JSON.stringify(pendingToolCalls)]
    );
  }

  // Per Section 7: Delete checkpoint after successful completion
  async deleteCheckpoint(checkpointId: string): Promise<void> {
    await pool.query(
      `DELETE FROM workflow_checkpoints WHERE id = $1`,
      [checkpointId]
    );
  }

  private mapCheckpointRow(row: any): WorkflowCheckpoint {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      taskId: row.task_id,
      state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
      idempotencyKey: row.idempotency_key,
      pendingToolCalls: typeof row.pending_tool_calls === 'string'
        ? JSON.parse(row.pending_tool_calls)
        : (row.pending_tool_calls || []),
      createdAt: row.created_at,
      // Additional checkpoint contract fields
      phase: row.phase || 'executing',
      dependencySatisfaction: typeof row.dependency_satisfaction === 'string'
        ? JSON.parse(row.dependency_satisfaction)
        : (row.dependency_satisfaction || []),
      nextAllowedTransitions: typeof row.next_allowed_transitions === 'string'
        ? JSON.parse(row.next_allowed_transitions)
        : (row.next_allowed_transitions || []),
      sequenceNumber: row.sequence_number || 0,
    };
  }

  // Find a specific task by ID
  async findTaskById(taskId: string): Promise<WorkflowTask | null> {
    const result = await pool.query(
      `SELECT * FROM workflow_tasks WHERE id = $1`,
      [taskId]
    );
    return result.rows[0] ? this.mapTaskRow(result.rows[0]) : null;
  }

  // Find all tasks for a workflow
  async findTasksByWorkflowId(workflowId: string): Promise<WorkflowTask[]> {
    const result = await pool.query(
      `SELECT * FROM workflow_tasks WHERE workflow_id = $1 ORDER BY created_at`,
      [workflowId]
    );
    return result.rows.map(this.mapTaskRow);
  }

  // Find child workflows of a parent workflow
  async findChildWorkflows(parentWorkflowId: string): Promise<Workflow[]> {
    const result = await pool.query(
      `SELECT w.* FROM workflows w
       JOIN workflow_hierarchy h ON w.id = h.workflow_id
       WHERE h.parent_workflow_id = $1
       ORDER BY w.created_at`,
      [parentWorkflowId]
    );
    return result.rows.map(this.mapRow);
  }

  // Update task with aggregated child results
  async updateTaskChildResults(taskId: string, results: ChildTaskResult[]): Promise<void> {
    await pool.query(
      `UPDATE workflow_tasks
       SET child_results = $2, updated_at = NOW()
       WHERE id = $1`,
      [taskId, JSON.stringify(results)]
    );
  }

  async insertTaskDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    await pool.query(
      `INSERT INTO workflow_task_dependencies (task_id, depends_on_task_id)
       VALUES ($1, $2)
       ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
      [taskId, dependsOnTaskId],
    );
  }

  private mapTaskRow(row: any): WorkflowTask {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      agentId: row.agent_id,
      status: row.status,
      leaseId: row.lease_id,
      leaseExpiresAt: row.lease_expires_at,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRow(row: any): Workflow {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      objective: row.objective,
      status: row.status,
      compensationState: row.compensation_state,
      finalOutcome: row.final_outcome,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ==========================================
// Per Section 6: Child Task Repository
// ==========================================

export class ChildTaskRepository {
  async create(input: {
    parentTaskId: string;
    workflowId: string;
    objective: string;
    inputData?: Record<string, unknown>;
    executorAgentId?: string;   // NEW — populates child_tasks.agent_id when set
  }): Promise<ChildTask> {
    const result = await pool.query(
      `INSERT INTO child_tasks (parent_task_id, workflow_id, objective, input_data, status, task_type, agent_id)
       VALUES ($1, $2, $3, $4, 'pending', 'subtask', $5)
       RETURNING *`,
      [input.parentTaskId, input.workflowId, input.objective, JSON.stringify(input.inputData ?? {}), input.executorAgentId ?? null],
    );
    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<ChildTask | null> {
    const result = await pool.query(
      `SELECT * FROM child_tasks WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByParentTaskId(parentTaskId: string): Promise<ChildTask[]> {
    const result = await pool.query(
      `SELECT * FROM child_tasks WHERE parent_task_id = $1 ORDER BY created_at`,
      [parentTaskId]
    );
    return result.rows.map(this.mapRow);
  }

  async complete(childTaskId: string, result: unknown): Promise<ChildTask> {
    const queryResult = await pool.query(
      // A success clears the streak, so a task that fails once, succeeds,
      // then fails again is not one attempt away from being blocked.
      `UPDATE child_tasks
       SET status = 'completed', result = $2, consecutive_failures = 0,
           completed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [childTaskId, JSON.stringify(result)]
    );
    if (!queryResult.rows[0]) {
      throw new Error(`Child task ${childTaskId} not found`);
    }
    return this.mapRow(queryResult.rows[0]);
  }

  /** How many consecutive failures a task gets before it is blocked
   *  rather than retried again. Two: a task that failed twice identically is
   *  not going to pass on the third, and each attempt is a whole child run. */
  static readonly MAX_CONSECUTIVE_FAILURES = Number(
    process.env.CHILD_TASK_MAX_FAILURES ?? 2,
  );

  async fail(childTaskId: string, error: string): Promise<ChildTask> {
    // Count the failure and, at the limit, ABANDON the task rather than leave
    // it in a state the dispatcher will pick up again. Done in one statement so
    // two concurrent failures cannot both read the old count and both decide
    // they are not yet at the limit.
    //
    // `abandoned`, never `blocked`: `blocked` means waiting on dependencies,
    // and the async advance path un-blocks any such row whose upstream has
    // completed. A task that failed twice necessarily HAS completed
    // dependencies, so parking it there let the next sibling completion put it
    // straight back on the dispatcher — the exact retry burn this limit exists
    // to stop (migration 342).
    const queryResult = await pool.query(
      `UPDATE child_tasks
       SET consecutive_failures = consecutive_failures + 1,
           status = CASE
             WHEN consecutive_failures + 1 >= $3 THEN 'abandoned' ELSE 'failed' END,
           blocked_at = CASE
             WHEN consecutive_failures + 1 >= $3 THEN NOW() ELSE blocked_at END,
           error = $2, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [childTaskId, error, ChildTaskRepository.MAX_CONSECUTIVE_FAILURES]
    );
    if (!queryResult.rows[0]) {
      throw new Error(`Child task ${childTaskId} not found`);
    }
    return this.mapRow(queryResult.rows[0]);
  }

  async updateStatus(childTaskId: string, status: string): Promise<void> {
    await pool.query(
      `UPDATE child_tasks SET status = $2, updated_at = NOW() WHERE id = $1`,
      [childTaskId, status]
    );
  }

  private mapRow(row: any): ChildTask {
    return {
      id: row.id,
      parentTaskId: row.parent_task_id,
      workflowId: row.workflow_id,
      taskType: row.task_type,
      objective: row.objective,
      status: row.status,
      result: row.result,
      error: row.error,
      consecutiveFailures: row.consecutive_failures ?? 0,
      blockedAt: row.blocked_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      executorAgentId: row.agent_id ?? null,
    };
  }
}

// ==========================================
// Workflow Hierarchy Repository
// ==========================================

export class WorkflowHierarchyRepository {
  async create(hierarchy: {
    workflowId: string;
    parentWorkflowId: string | null;
    depth: number;
    rootWorkflowId: string;
  }): Promise<WorkflowHierarchy> {
    const result = await pool.query(
      `INSERT INTO workflow_hierarchy (workflow_id, parent_workflow_id, depth, root_workflow_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [hierarchy.workflowId, hierarchy.parentWorkflowId, hierarchy.depth, hierarchy.rootWorkflowId]
    );
    return this.mapRow(result.rows[0]);
  }

  async findByWorkflowId(workflowId: string): Promise<WorkflowHierarchy | null> {
    const result = await pool.query(
      `SELECT * FROM workflow_hierarchy WHERE workflow_id = $1`,
      [workflowId]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByRootWorkflowId(rootWorkflowId: string): Promise<WorkflowHierarchy[]> {
    const result = await pool.query(
      `SELECT * FROM workflow_hierarchy WHERE root_workflow_id = $1 ORDER BY depth`,
      [rootWorkflowId]
    );
    return result.rows.map(this.mapRow);
  }

  async findChildren(parentWorkflowId: string): Promise<WorkflowHierarchy[]> {
    const result = await pool.query(
      `SELECT * FROM workflow_hierarchy WHERE parent_workflow_id = $1 ORDER BY depth`,
      [parentWorkflowId]
    );
    return result.rows.map(this.mapRow);
  }

  async getMaxDepth(rootWorkflowId: string): Promise<number> {
    const result = await pool.query(
      `SELECT MAX(depth) as max_depth FROM workflow_hierarchy WHERE root_workflow_id = $1`,
      [rootWorkflowId]
    );
    return result.rows[0]?.max_depth ?? 0;
  }

  private mapRow(row: any): WorkflowHierarchy {
    return {
      workflowId: row.workflow_id,
      parentWorkflowId: row.parent_workflow_id,
      depth: row.depth,
      rootWorkflowId: row.root_workflow_id,
    };
  }
}
