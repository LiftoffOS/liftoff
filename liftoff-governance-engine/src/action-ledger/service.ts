// Action Ledger Service Implementation
// Per Section 7: For every external write-capable action, persist action state
// Per Section 11: Persist structured audit logs with trace IDs and reversibility metadata

import { Action, ActionIntent } from './types';
import { ActionRepository } from './repository';
import { pool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export class ActionLedgerService {
  private repository = new ActionRepository();

  // Per Section 7: For every external write-capable action:
  // 1. persist action intent
  // 2. persist idempotency key
  // 3. persist target reference and pre-action snapshot reference
  // Per Section 11: Also persist:
  // - trace_id for distributed tracing correlation
  // - instruction_version for audit trail
  // - undo_support_mode for reversibility metadata
  // - conflict_resolution_mode for conflict handling audit

  async recordIntent(input: ActionIntent): Promise<string> {
    logger.info({
      message: 'Recording action intent',
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      connector: input.connector,
      action_type: input.actionType,
      entity_type: input.entityType,
      trace_id: input.traceId,
      undo_support_mode: input.undoSupportMode,
    });

    return this.repository.createAction({
      tenantId: input.tenantId,
      agentId: input.agentId,
      workflowId: input.workflowId,
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
      connector: input.connector,
      entityType: input.entityType,
      actionType: input.actionType,
      targetRef: input.targetRef,
      preActionSnapshot: input.snapshot,
      traceId: input.traceId,
      instructionVersion: input.instructionVersion,
      undoSupportMode: input.undoSupportMode,
      conflictResolutionMode: input.conflictResolutionMode,
      payload: input.payload,
      costUsd: input.costUsd,
      threadId: input.threadId,
      invocationId: input.invocationId,
      status: 'pending',
    });
  }

  // Per Section 7: Step 5 - persist external response
  // Step 6 - persist outcome
  async recordOutcome(actionId: string, result: any): Promise<void> {
    await this.repository.updateAction(actionId, {
      externalResponse: result.data,
      status: result.success ? 'completed' : 'failed',
      completedAt: new Date(),
    });
  }

  async recordFailure(actionId: string, error: any): Promise<void> {
    await this.repository.updateAction(actionId, {
      error: error.message || String(error),
      status: 'failed',
      completedAt: new Date(),
    });
  }

  async getById(id: string): Promise<Action | null> {
    return this.repository.findById(id);
  }

  async getByWorkflowId(workflowId: string): Promise<Action[]> {
    return this.repository.findByWorkflowId(workflowId);
  }

  // Per Section 7: Reconcile by idempotency key
  async getByIdempotencyKey(key: string): Promise<Action | null> {
    return this.repository.findByIdempotencyKey(key);
  }

  // Phase 3 conflict detection: returns an in-flight action targeting the
  // same (connector, entityType, entityId, actionType) tuple for the tenant
  // within the last 5 minutes, or null if no conflict exists.
  async findInFlightConflicts(
    tenantId: string,
    connector: string,
    entityType: string,
    entityId: string,
    actionType: string,
  ): Promise<{
    id: string;
    idempotencyKey: string | null;
    status: string;
    createdAt: Date;
  } | null> {
    return this.repository.findInFlightConflict({
      tenantId,
      connector,
      entityType,
      entityId,
      actionType,
    });
  }

  // Cost attribution ingestion feed: returns completed/failed actions for a
  // tenant since a cursor timestamp, ordered by created_at ASC for stable
  // pagination. Used by platform-backend's governance-ingester poller.
  async listActionsForIngestion(
    tenantId: string,
    since: Date,
    limit: number,
  ): Promise<{
    id: string;
    tenantId: string;
    agentId: string;
    workflowId: string;
    actionId: string;
    connector: string;
    entityType: string | null;
    actionType: string;
    costUsd: number;
    traceId: string | null;
    createdAt: Date;
    completedAt: Date | null;
    status: string;
  }[]> {
    const result = await pool.query(
      `SELECT id::text, tenant_id, agent_id, workflow_id, id::text AS action_id,
              connector, entity_type, action_type,
              COALESCE(cost_usd, 0) AS cost_usd,
              trace_id, created_at, completed_at, status
       FROM actions
       WHERE tenant_id = $1
         AND created_at > $2
         AND status IN ('completed', 'failed')
       ORDER BY created_at ASC, id ASC
       LIMIT $3`,
      [tenantId, since, limit],
    );
    return result.rows.map(row => ({
      id:          row.id as string,
      tenantId:    row.tenant_id as string,
      agentId:     row.agent_id as string,
      workflowId:  row.workflow_id as string,
      actionId:    row.action_id as string,
      connector:   row.connector as string,
      entityType:  row.entity_type as string | null,
      actionType:  row.action_type as string,
      costUsd:     parseFloat(row.cost_usd) || 0,
      traceId:     row.trace_id as string | null,
      createdAt:   row.created_at as Date,
      completedAt: row.completed_at as Date | null,
      status:      row.status as string,
    }));
  }
}
