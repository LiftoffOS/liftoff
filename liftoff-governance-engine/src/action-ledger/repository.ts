// Action Ledger Repository
// Per Section 5: Highest-priority DB client

import { pool } from '../infrastructure/database';
import { Action, CompensationAction, CompensationPlan, CompensationStep } from './types';

export class ActionRepository {
  // Per Section 7 & 11: Persist action intent with full audit trail
  async createAction(input: any): Promise<string> {
    const result = await pool.query(
      `INSERT INTO actions (
        tenant_id, agent_id, workflow_id, task_id, idempotency_key,
        connector, entity_type, action_type, target_ref, pre_action_snapshot,
        trace_id, instruction_version, undo_support_mode, conflict_resolution_mode,
        payload, status, cost_usd, thread_id, invocation_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
      [
        input.tenantId,
        input.agentId,
        input.workflowId,
        input.taskId,
        input.idempotencyKey,
        input.connector,
        input.entityType,
        input.actionType,
        input.targetRef,
        JSON.stringify(input.preActionSnapshot),
        input.traceId ? input.traceId.substring(0, 128) : null,
        input.instructionVersion ?? null,
        input.undoSupportMode ?? null,
        input.conflictResolutionMode ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        input.status,
        input.costUsd ?? 0,
        input.threadId ?? null,
        input.invocationId ?? null,
      ]
    );
    return result.rows[0].id;
  }

  async updateAction(id: string, update: any): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [id];
    let paramIndex = 2;

    if (update.externalResponse !== undefined) {
      fields.push(`external_response = $${paramIndex++}`);
      values.push(JSON.stringify(update.externalResponse));
    }
    if (update.status !== undefined) {
      fields.push(`status = $${paramIndex++}`);
      values.push(update.status);
    }
    if (update.error !== undefined) {
      fields.push(`error = $${paramIndex++}`);
      values.push(update.error);
    }
    if (update.completedAt !== undefined) {
      fields.push(`completed_at = $${paramIndex++}`);
      values.push(update.completedAt);
    }

    if (fields.length > 0) {
      await pool.query(
        `UPDATE actions SET ${fields.join(', ')} WHERE id = $1`,
        values
      );
    }
  }

  async findById(id: string): Promise<Action | null> {
    const result = await pool.query(`SELECT * FROM actions WHERE id = $1`, [id]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByWorkflowId(workflowId: string): Promise<Action[]> {
    const result = await pool.query(
      `SELECT * FROM actions WHERE workflow_id = $1 ORDER BY created_at`,
      [workflowId]
    );
    return result.rows.map(this.mapRow);
  }

  // Per Section 7: Reconcile by idempotency key
  async findByIdempotencyKey(key: string): Promise<Action | null> {
    const result = await pool.query(
      `SELECT * FROM actions WHERE idempotency_key = $1`,
      [key]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  // Phase 3 conflict detection: any in-flight action on the same
  // (tenant, connector, entity_type, entity_id, action_type) tuple in the
  // last 5 minutes blocks a second concurrent write. `entity_id` maps to
  // the `target_ref` column in the schema.
  async findInFlightConflict(input: {
    tenantId: string;
    connector: string;
    entityType: string;
    entityId: string;
    actionType: string;
  }): Promise<{
    id: string;
    idempotencyKey: string | null;
    status: string;
    createdAt: Date;
  } | null> {
    const result = await pool.query(
      `SELECT id, idempotency_key, status, created_at
         FROM actions
        WHERE tenant_id = $1
          AND connector = $2
          AND entity_type = $3
          AND target_ref = $4
          AND action_type = $5
          AND status IN ('pending', 'executing', 'in_flight', 'queued')
          AND created_at > NOW() - INTERVAL '5 minutes'
        LIMIT 1`,
      [
        input.tenantId,
        input.connector,
        input.entityType,
        input.entityId,
        input.actionType,
      ]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id as string,
      idempotencyKey: (row.idempotency_key as string | null) ?? null,
      status: row.status as string,
      createdAt: row.created_at as Date,
    };
  }

  // Per Section 19: Find actions by task ID for reconciliation
  async findByTaskId(taskId: string): Promise<Action[]> {
    const result = await pool.query(
      `SELECT * FROM actions WHERE task_id = $1 ORDER BY created_at`,
      [taskId]
    );
    return result.rows.map(this.mapRow);
  }

  // Find action by audit log ID for correction state resolution
  // Per Correction Protocol: Returns pre-action snapshot for corrections
  async findByAuditLogId(
    tenantId: string,
    auditLogId: string
  ): Promise<{
    resourceId: string;
    resourceType: string;
    preActionState: Record<string, unknown> | null;
    createdAt: Date;
  } | null> {
    const result = await pool.query(
      `SELECT target_ref as resource_id, entity_type as resource_type,
              pre_action_snapshot as pre_action_state, created_at
       FROM actions
       WHERE tenant_id = $1 AND audit_log_id = $2
       LIMIT 1`,
      [tenantId, auditLogId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      resourceId: row.resource_id,
      resourceType: row.resource_type,
      preActionState: row.pre_action_state,
      createdAt: row.created_at,
    };
  }

  // Per Section 7: Find completed actions for compensation (reverse order)
  async findCompletedActionsForWorkflow(workflowId: string): Promise<Action[]> {
    const result = await pool.query(
      `SELECT * FROM actions
       WHERE workflow_id = $1 AND status = 'completed'
       ORDER BY completed_at DESC`,
      [workflowId]
    );
    return result.rows.map(this.mapRow);
  }

  // Mark action as compensated
  async markAsCompensated(actionId: string): Promise<void> {
    await pool.query(
      `UPDATE actions SET status = 'compensated' WHERE id = $1`,
      [actionId]
    );
  }

  private mapRow(row: any): Action {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      workflowId: row.workflow_id,
      taskId: row.task_id,
      idempotencyKey: row.idempotency_key,
      connector: row.connector,
      entityType: row.entity_type,
      actionType: row.action_type,
      targetRef: row.target_ref,
      traceId: row.trace_id,
      instructionVersion: row.instruction_version,
      undoSupportMode: row.undo_support_mode,
      conflictResolutionMode: row.conflict_resolution_mode,
      payload: row.payload,
      preActionSnapshot: row.pre_action_snapshot,
      externalResponse: row.external_response,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}

// ==========================================
// Per Section 7: Compensation Repository
// ==========================================

export class CompensationRepository {
  async createCompensationAction(input: {
    originalActionId: string;
    workflowId: string;
    taskId: string;
    compensationType: string;
    compensationData: any;
  }): Promise<CompensationAction> {
    const result = await pool.query(
      `INSERT INTO compensation_actions
       (original_action_id, workflow_id, task_id, compensation_type, compensation_data, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [
        input.originalActionId,
        input.workflowId,
        input.taskId,
        input.compensationType,
        JSON.stringify(input.compensationData),
      ]
    );
    return this.mapCompensationRow(result.rows[0]);
  }

  async updateCompensationStatus(
    id: string,
    status: string,
    error?: string
  ): Promise<void> {
    const executedAt = status === 'completed' || status === 'failed' ? new Date() : null;
    await pool.query(
      `UPDATE compensation_actions
       SET status = $2, error = $3, executed_at = $4
       WHERE id = $1`,
      [id, status, error ?? null, executedAt]
    );
  }

  async findByWorkflowId(workflowId: string): Promise<CompensationAction[]> {
    const result = await pool.query(
      `SELECT * FROM compensation_actions WHERE workflow_id = $1 ORDER BY created_at DESC`,
      [workflowId]
    );
    return result.rows.map(this.mapCompensationRow);
  }

  async findPendingForWorkflow(workflowId: string): Promise<CompensationAction[]> {
    const result = await pool.query(
      `SELECT * FROM compensation_actions
       WHERE workflow_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [workflowId]
    );
    return result.rows.map(this.mapCompensationRow);
  }

  // Compensation plan persistence
  async createPlan(input: {
    workflowId: string;
    reason: string;
    steps: CompensationStep[];
  }): Promise<CompensationPlan> {
    const result = await pool.query(
      `INSERT INTO compensation_plans (workflow_id, reason, actions, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [input.workflowId, input.reason, JSON.stringify(input.steps)]
    );
    return this.mapPlanRow(result.rows[0]);
  }

  async updatePlanStatus(workflowId: string, status: string): Promise<void> {
    const completedAt = status === 'completed' || status === 'failed' ? new Date() : null;
    await pool.query(
      `UPDATE compensation_plans
       SET status = $2, completed_at = $3
       WHERE workflow_id = $1`,
      [workflowId, status, completedAt]
    );
  }

  async updatePlanStep(workflowId: string, actionId: string, status: string): Promise<void> {
    await pool.query(
      `UPDATE compensation_plans
       SET actions = (
         SELECT jsonb_agg(
           CASE
             WHEN elem->>'actionId' = $2
             THEN jsonb_set(elem, '{status}', to_jsonb($3::text))
             ELSE elem
           END
         )
         FROM jsonb_array_elements(actions) elem
       )
       WHERE workflow_id = $1`,
      [workflowId, actionId, status]
    );
  }

  async findPlanByWorkflowId(workflowId: string): Promise<CompensationPlan | null> {
    const result = await pool.query(
      `SELECT * FROM compensation_plans WHERE workflow_id = $1`,
      [workflowId]
    );
    return result.rows[0] ? this.mapPlanRow(result.rows[0]) : null;
  }

  private mapCompensationRow(row: any): CompensationAction {
    return {
      id: row.id,
      originalActionId: row.original_action_id,
      workflowId: row.workflow_id,
      taskId: row.task_id,
      compensationType: row.compensation_type,
      status: row.status,
      compensationData: row.compensation_data,
      error: row.error,
      createdAt: row.created_at,
      executedAt: row.executed_at,
    };
  }

  private mapPlanRow(row: any): CompensationPlan {
    return {
      workflowId: row.workflow_id,
      reason: row.reason,
      actions: row.actions,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}
