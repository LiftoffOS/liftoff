// Action Ledger Repository
// Per Section 5: Highest-priority DB client

import { pool } from '../infrastructure/database';
import { Action, CompensationAction, CompensationPlan, CompensationStep } from './types';

/** What a claim decided. `owned` means dispatch; the other two mean do not. */
export type ClaimResult =
  | { kind: 'owned'; actionId: string }
  | { kind: 'replay'; actionId: string; externalResponse?: unknown; createdAt: string }
  | { kind: 'in_flight'; actionId: string; claimedAt: string };

export class ActionRepository {
  // Per Section 7 & 11: Persist action intent with full audit trail
  async createAction(input: any): Promise<string> {
    const result = await pool.query(
      `INSERT INTO actions (
        tenant_id, agent_id, workflow_id, task_id, idempotency_key,
        connector, entity_type, action_type, target_ref, pre_action_snapshot,
        trace_id, instruction_version, undo_support_mode, conflict_resolution_mode,
        payload, status, snapshot_status, target_version, is_external_write,
        invocation_id, act_key
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      -- A RETRY of an attempt that never completed must not be refused.
      --
      -- The idempotency key is <traceId>-<toolCallId>, identical across the
      -- retries of one step, and intent is recorded BEFORE dispatch. So when a
      -- dispatch failed and the step retried, this INSERT hit
      -- actions_idempotency_key_key and the retry died on a unique violation
      -- rather than on anything to do with the work.
      --
      -- For example, a tool call that fails on a bad connector id, where
      -- recovery correctly decides to continue, would otherwise have its retry
      -- rejected with duplicate key value violates unique constraint — a
      -- second, unrelated failure stacked on the first, hiding it.
      --
      -- The conflict target is only re-armed when the prior row did NOT
      -- succeed. A completed action keeps its row untouched and returns its
      -- existing id, so genuine redelivery still replays instead of acting
      -- twice — which is the protection this constraint exists to give.
      ON CONFLICT (idempotency_key) DO UPDATE
        SET status = EXCLUDED.status,
            payload = EXCLUDED.payload,
            pre_action_snapshot = EXCLUDED.pre_action_snapshot,
            snapshot_status = EXCLUDED.snapshot_status,
            trace_id = EXCLUDED.trace_id,
            -- The target follows the payload. A retry after the recovery
            -- advisor corrected the arguments is aimed at a different thing
            -- than the first attempt was, and leaving the original target would
            -- record the retry against whatever the failed call had named.
            target_ref = EXCLUDED.target_ref,
            target_version = EXCLUDED.target_version,
            act_key = EXCLUDED.act_key,
            invocation_id = COALESCE(EXCLUDED.invocation_id, actions.invocation_id)
        WHERE actions.status NOT IN ('completed', 'succeeded')
      RETURNING id`,
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
        input.snapshotStatus ?? 'captured',
        input.targetVersion ?? null,
        input.isExternalWrite === true,
        input.invocationId ?? null,
        input.actKey ?? null,
      ]
    );
    if (result.rows[0]?.id) return result.rows[0].id;
    // DO UPDATE ... WHERE matched nothing: a COMPLETED action already owns this
    // key. That is a genuine replay — return the existing id so the caller
    // joins the original rather than acting a second time.
    const existing = await pool.query(
      'SELECT id FROM actions WHERE idempotency_key = $1 AND tenant_id = $2',
      [input.idempotencyKey, input.tenantId],
    );
    if (existing.rows[0]?.id) return existing.rows[0].id;
    throw new Error(
      `action ledger: idempotency key ${input.idempotencyKey} conflicted but no row could be read back`,
    );
  }

  /**
   * Claim an idempotency key for an act about to be dispatched, atomically.
   *
   * The unique constraint on `idempotency_key` is the arbiter: whoever's
   * INSERT lands owns the act. A caller that loses reads the row it lost to
   * and is told what to do — replay a completed act, stand down from one
   * still in flight, or take over one whose owner failed or went quiet past
   * the in-flight window. There is no window between a check and an insert
   * for two identical calls to both pass through.
   */
  async claimAction(input: any, inFlightWindowMs: number): Promise<ClaimResult> {
    const inserted = await pool.query(
      `INSERT INTO actions (
        tenant_id, agent_id, workflow_id, task_id, idempotency_key,
        connector, entity_type, action_type, target_ref, pre_action_snapshot,
        trace_id, instruction_version, undo_support_mode, conflict_resolution_mode,
        payload, status, snapshot_status, target_version, is_external_write,
        invocation_id, act_key, claimed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending', $16, $17, $18, $19, $20, NOW())
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id`,
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
        JSON.stringify(input.preActionSnapshot ?? null),
        input.traceId ? input.traceId.substring(0, 128) : null,
        input.instructionVersion ?? null,
        input.undoSupportMode ?? null,
        input.conflictResolutionMode ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        input.snapshotStatus ?? 'skipped_no_snapshot_path',
        input.targetVersion ?? null,
        input.isExternalWrite === true,
        input.invocationId ?? null,
        input.actKey ?? null,
      ],
    );
    if (inserted.rows[0]?.id) return { kind: 'owned', actionId: String(inserted.rows[0].id) };

    // Lost the insert. At most one take-over attempt, then whatever stands.
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await pool.query(
        `SELECT id, status, external_response, created_at, COALESCE(claimed_at, created_at) AS claimed_at
           FROM actions WHERE idempotency_key = $1 AND tenant_id = $2`,
        [input.idempotencyKey, input.tenantId],
      );
      const row = existing.rows[0];
      if (!row) throw new Error(`action ledger: idempotency key ${input.idempotencyKey} conflicted but no row could be read back`);
      const status = String(row.status);
      if (status === 'completed' || status === 'succeeded') {
        return { kind: 'replay', actionId: String(row.id), externalResponse: row.external_response ?? undefined, createdAt: String(row.created_at) };
      }
      const claimedAt = new Date(row.claimed_at).getTime();
      const stale = Number.isFinite(claimedAt) && Date.now() - claimedAt > inFlightWindowMs;
      if (status === 'pending' && !stale) {
        return { kind: 'in_flight', actionId: String(row.id), claimedAt: String(row.claimed_at) };
      }
      if (attempt === 1) {
        return { kind: 'in_flight', actionId: String(row.id), claimedAt: String(row.claimed_at) };
      }
      // Failed, or pending past the window: take it over. Conditional on the
      // state just read, so two takers cannot both win.
      const rearmed = await pool.query(
        `UPDATE actions
            SET status = 'pending', error = NULL, completed_at = NULL, claimed_at = NOW(),
                payload = $3, trace_id = $4, act_key = $5,
                invocation_id = COALESCE($6, invocation_id)
          WHERE idempotency_key = $1 AND tenant_id = $2
            AND (status = 'failed'
                 OR (status = 'pending' AND COALESCE(claimed_at, created_at) < NOW() - ($7 || ' milliseconds')::interval))
          RETURNING id`,
        [
          input.idempotencyKey,
          input.tenantId,
          input.payload ? JSON.stringify(input.payload) : null,
          input.traceId ? input.traceId.substring(0, 128) : null,
          input.actKey ?? null,
          input.invocationId ?? null,
          String(inFlightWindowMs),
        ],
      );
      if (rearmed.rows[0]?.id) return { kind: 'owned', actionId: String(rearmed.rows[0].id) };
    }
    throw new Error(`action ledger: claim of ${input.idempotencyKey} reached no decision`);
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
    // A target the INTENT could not name, recovered from the response.
    //
    // Guarded in SQL rather than by reading the row first: the write is
    // conditional on a value only the database has, and a read-then-write would
    // be a race on a row two paths can update. CASE keeps it one statement.
    //
    // Only ever fills an empty target. A target derived from the payload is the
    // truer answer — it says what the call was AIMED at, which for an update or
    // a delete is the thing itself. This is for a CREATE, where there was
    // nothing to aim at.
    if (update.targetRefIfEmpty) {
      fields.push(`target_ref = CASE WHEN target_ref = '' THEN $${paramIndex++} ELSE target_ref END`);
      values.push(update.targetRefIfEmpty);
    }
    if (update.completedAt !== undefined) {
      fields.push(`completed_at = $${paramIndex++}`);
      values.push(update.completedAt);
    }
    if (update.postActionSnapshot !== undefined) {
      fields.push(`post_action_snapshot = $${paramIndex++}`);
      values.push(JSON.stringify(update.postActionSnapshot));
    }
    if (update.snapshotStatus !== undefined) {
      fields.push(`snapshot_status = $${paramIndex++}`);
      values.push(update.snapshotStatus);
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

  /**
   * Prior successful actions this agent (or tenant) has taken on one target.
   *
   * COMPLETED ONLY. A failed attempt is not something the agent did — if the
   * send errored, the agent SHOULD try again, and counting the attempt would
   * make the ledger tell it not to. `succeeded` is accepted alongside
   * `completed` because both spellings exist in the table's history and the
   * ON CONFLICT clause above already treats them as one.
   *
   * OUTWARD ACTS ONLY (`is_external_write`), the rule `prior-work.ts` and
   * `acts-this-run.ts` already apply to the same table: a read produced
   * nothing, so it is not something the agent DID to the target. The ledger
   * records reads too, at the revision they saw, and the agent reads the thing
   * it is about to act on — the pull request, to learn its head — BEFORE it
   * asks whether it has acted on it. Counting that read answers "acted" at the
   * exact revision on every fresh head, and the agent declines the first
   * review it has not yet written.
   *
   * VERSION IS NOT FILTERED HERE. The caller needs to tell "acted at this
   * revision" apart from "acted, revision unknown" apart from "acted at a
   * different revision", and a WHERE clause collapses all three into an empty
   * result — which the agent would read as "never acted" and act again. So the
   * rows come back with their versions attached and the service decides.
   */
  async findPriorActionsOnTarget(input: {
    tenantId: string;
    agentId: string;
    targetRef: string;
    scope: 'agent' | 'tenant';
    windowDays: number;
    limit: number;
  }): Promise<Array<{
    actionType: string;
    connector: string;
    targetVersion: string | null;
    agentId: string;
    createdAt: Date;
  }>> {
    const scopedByAgent = input.scope === 'agent';
    const result = await pool.query(
      `SELECT action_type, connector, target_version, agent_id, created_at
         FROM actions
        WHERE tenant_id = $1
          AND target_ref = $2
          AND is_external_write = true
          AND status IN ('completed', 'succeeded')
          AND created_at > now() - ($3 || ' days')::interval
          ${scopedByAgent ? 'AND agent_id = $4' : ''}
        ORDER BY created_at DESC
        LIMIT ${Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 100) : 20}`,
      scopedByAgent
        ? [input.tenantId, input.targetRef, String(input.windowDays), input.agentId]
        : [input.tenantId, input.targetRef, String(input.windowDays)],
    );
    return result.rows.map((row) => ({
      actionType: row.action_type,
      connector: row.connector,
      targetVersion: row.target_version ?? null,
      agentId: row.agent_id,
      createdAt: row.created_at,
    }));
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
      targetVersion: row.target_version ?? null,
      traceId: row.trace_id,
      instructionVersion: row.instruction_version,
      undoSupportMode: row.undo_support_mode,
      conflictResolutionMode: row.conflict_resolution_mode,
      payload: row.payload,
      preActionSnapshot: row.pre_action_snapshot,
      postActionSnapshot: row.post_action_snapshot,
      snapshotStatus: row.snapshot_status,
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
