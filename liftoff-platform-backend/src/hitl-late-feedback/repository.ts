// HITL Late Feedback Repository
// Stores feedback for expired approvals to enable agent learning
//
// RLS note (FORCE census): `hitl_late_feedback` is RLS-enabled. tenantId-bearing
// methods (insert/getByApprovalId/listByAgent/listByToolCallsHash) →
// withTenantScope. The background sync job methods (getUnsynced cross-tenant
// scan, markSynced/recordSyncAttempt by-PK) and findById by-PK carry no tenant
// context → withAdminScope.

import type { PoolClient } from 'pg';
import { withTenantScope, withAdminScope } from '../infrastructure/database';
import type {
  LateFeedback,
  CreateLateFeedbackInput,
  LateFeedbackRow,
} from './types';
import { rowToLateFeedback } from './types';

export class LateFeedbackRepository {
  /**
   * Insert a new late feedback record
   */
  async insert(input: CreateLateFeedbackInput, client?: PoolClient): Promise<LateFeedback> {
    const query = `
      INSERT INTO hitl_late_feedback (
        tenant_id,
        approval_id,
        agent_id,
        internal_agent_id,
        workflow_id,
        hitl_level,
        tool_calls_hash,
        pending_tool_calls,
        gate_reason,
        decision,
        decided_by,
        decided_by_role,
        rejection_reason,
        approval_created_at,
        approval_expired_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `;

    const values = [
      input.tenantId,
      input.approval.id,
      input.approval.agentId,
      input.approval.internalAgentId || null,
      input.approval.workflowId || null,
      input.approval.hitlLevel,
      input.approval.toolCallsHash,
      JSON.stringify(input.approval.pendingToolCalls),
      input.approval.reason,
      input.decision,
      input.decidedBy,
      input.decidedByRole,
      input.rejectionReason || null,
      input.approval.createdAt,
      input.approval.expiresAt,
    ];

    // When a client is supplied the caller owns the (tenant-scoped) transaction and we
    // run on it, so the feedback row and its trust-outbox row commit together.
    const result = client
      ? await client.query<LateFeedbackRow>(query, values)
      : await withTenantScope(input.tenantId, (c) => c.query<LateFeedbackRow>(query, values));
    return rowToLateFeedback(result.rows[0]);
  }

  /**
   * Find feedback by ID (by-PK, no tenant context)
   */
  async findById(id: string): Promise<LateFeedback | null> {
    const query = `SELECT * FROM hitl_late_feedback WHERE id = $1`;
    const result = await withAdminScope(
      { caller: 'hitl-late-feedback.findById', reason: 'by-PK late-feedback lookup (no tenant context)' },
      (client) => client.query<LateFeedbackRow>(query, [id]),
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToLateFeedback(result.rows[0]);
  }

  /**
   * Which of these approvals already carry feedback.
   *
   * The "decision window passed" view renders a page of approvals and offers
   * each one a feedback form. Asking per card would be a query per row; without
   * asking at all, the page offers a form for items already answered and the
   * person only finds out when the submit comes back alreadySubmitted.
   */
  async findApprovalIdsWithFeedback(
    tenantId: string,
    approvalIds: string[]
  ): Promise<Set<string>> {
    if (approvalIds.length === 0) return new Set();

    const query = `
      SELECT DISTINCT approval_id FROM hitl_late_feedback
      WHERE tenant_id = $1 AND approval_id = ANY($2::uuid[])
    `;
    const result = await withTenantScope(tenantId, (client) =>
      client.query<{ approval_id: string }>(query, [tenantId, approvalIds]));

    return new Set(result.rows.map((row) => row.approval_id));
  }

  /**
   * Get feedback by approval ID (for idempotency check)
   */
  async getByApprovalId(
    tenantId: string,
    approvalId: string
  ): Promise<LateFeedback | null> {
    const query = `
      SELECT * FROM hitl_late_feedback
      WHERE tenant_id = $1 AND approval_id = $2
    `;
    const result = await withTenantScope(tenantId, (client) =>
      client.query<LateFeedbackRow>(query, [tenantId, approvalId]));

    if (result.rows.length === 0) {
      return null;
    }

    return rowToLateFeedback(result.rows[0]);
  }

  /**
   * List feedback by agent for learning queries
   */
  /**
   * Minimal flag projection for the autonomy advisor. Optional agentId filter (without it,
   * one agent's rejection would block every agent's promotion). Every row carries `decision` so
   * the consumer can separate would_reject (negative signal) from would_approve (positive).
   */
  async listFlags(
    tenantId: string,
    since: string,
    agentId?: string,
  ): Promise<Array<{ feedbackId: string; approvalId: string | null; agentId: string; decision: string; decidedAt: Date }>> {
    const query = `
      SELECT id, approval_id, agent_id, decision, created_at
        FROM hitl_late_feedback
       WHERE tenant_id = $1 AND created_at >= $2
         AND ($3::text IS NULL OR agent_id = $3)
       ORDER BY created_at DESC`;
    const result = await withTenantScope(tenantId, (client) =>
      client.query<{ id: string; approval_id: string | null; agent_id: string; decision: string; created_at: Date }>(
        query,
        [tenantId, since, agentId ?? null],
      ),
    );
    return result.rows.map((r) => ({
      feedbackId: r.id,
      approvalId: r.approval_id,
      agentId: r.agent_id,
      decision: r.decision,
      decidedAt: r.created_at,
    }));
  }

  async listByAgent(
    tenantId: string,
    agentId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<LateFeedback[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const query = `
      SELECT * FROM hitl_late_feedback
      WHERE tenant_id = $1 AND agent_id = $2
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4
    `;
    const result = await withTenantScope(tenantId, (client) =>
      client.query<LateFeedbackRow>(query, [tenantId, agentId, limit, offset]));

    return result.rows.map(rowToLateFeedback);
  }

  /**
   * List feedback by tool calls hash for pattern matching
   */
  async listByToolCallsHash(
    tenantId: string,
    toolCallsHash: string,
    options?: { limit?: number }
  ): Promise<LateFeedback[]> {
    const limit = options?.limit ?? 50;

    const query = `
      SELECT * FROM hitl_late_feedback
      WHERE tenant_id = $1 AND tool_calls_hash = $2
      ORDER BY created_at DESC
      LIMIT $3
    `;
    const result = await withTenantScope(tenantId, (client) =>
      client.query<LateFeedbackRow>(query, [tenantId, toolCallsHash, limit]));

    return result.rows.map(rowToLateFeedback);
  }

  /**
   * Get unsynced feedback records for background sync job (cross-tenant scan)
   */
  async getUnsynced(options?: {
    limit?: number;
    maxAttempts?: number;
  }): Promise<LateFeedback[]> {
    const limit = options?.limit ?? 100;
    const maxAttempts = options?.maxAttempts ?? 5;

    const query = `
      SELECT * FROM hitl_late_feedback
      WHERE synced_to_runtime = FALSE
        AND sync_attempts < $1
      ORDER BY created_at ASC
      LIMIT $2
    `;
    const result = await withAdminScope(
      { caller: 'hitl-late-feedback.getUnsynced', reason: 'background sync job: cross-tenant scan of unsynced feedback (no tenant filter)' },
      (client) => client.query<LateFeedbackRow>(query, [maxAttempts, limit]),
    );

    return result.rows.map(rowToLateFeedback);
  }

  /**
   * Mark feedback as synced to runtime (by-PK, called from cross-tenant sync job)
   */
  async markSynced(id: string): Promise<void> {
    const query = `
      UPDATE hitl_late_feedback
      SET synced_to_runtime = TRUE, synced_at = NOW()
      WHERE id = $1
    `;
    await withAdminScope(
      { caller: 'hitl-late-feedback.markSynced', reason: 'background sync job: by-PK mark-synced (no tenant context)' },
      (client) => client.query(query, [id]),
    );
  }

  /**
   * Record a failed sync attempt (by-PK, called from cross-tenant sync job)
   */
  async recordSyncAttempt(id: string, errorMessage: string): Promise<void> {
    const query = `
      UPDATE hitl_late_feedback
      SET sync_attempts = sync_attempts + 1,
          last_sync_error = $2
      WHERE id = $1
    `;
    await withAdminScope(
      { caller: 'hitl-late-feedback.recordSyncAttempt', reason: 'background sync job: by-PK sync-attempt record (no tenant context)' },
      (client) => client.query(query, [id, errorMessage]),
    );
  }
}

export const lateFeedbackRepository = new LateFeedbackRepository();
