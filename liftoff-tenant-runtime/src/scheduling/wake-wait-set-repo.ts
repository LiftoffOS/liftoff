// wake_wait_sets repository: the wake_on_any / wake_on_all parent.
//
// A wait-set waits on N member wakes (agent_scheduled_invocations rows carrying wait_set_id). It owns
// its own fenced heartbeat lease + execution/settlement split, mirroring the self-wake state machine on
// agent_scheduled_invocations, so a resume is exactly-once under Cloud Task / reconciler redelivery.
// Every post-claim transition carries WHERE lease_token=$t so a stale worker can never overwrite the
// new owner.

import { getPool } from '../infrastructure/database';
import { WAKE_MAX_RESUME_ATTEMPTS } from './agent-scheduled-invocations-repo';

export interface InsertWaitSetInput {
  /** The row's id, when the caller minted it ahead of the insert (a pause
   *  checkpoint is keyed by it and written first). Absent, the database mints one. */
  id?: string;
  tenantId: string;
  agentId: string;
  mode: 'any' | 'all';
  firesAt: Date;
  threadId: string | null;
  originTrust: 'trusted' | 'untrusted_inbound';
  originSurface: 'web' | 'slack' | 'teams' | 'mcp' | null;
  threadRevision: number | null;
  wakeChainDepth: number;
  contextRef: string;
  scheduledByInvocationId: string | null;
  workflowResumePayload: Record<string, unknown>;
  memberTotal: number;
}

export const wakeWaitSetRepo = {
  /** Insert a pending wait-set. Throws 23505 if a live wait-set already exists for (tenant,agent,context_ref). */
  async insert(input: InsertWaitSetInput): Promise<string> {
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO wake_wait_sets
         (tenant_id, agent_id, mode, fires_at, thread_id, origin_trust, origin_surface, thread_revision,
          wake_chain_depth, context_ref, scheduled_by_invocation_id, workflow_resume_payload, member_total, id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14::uuid, gen_random_uuid()))
       RETURNING id`,
      [
        input.tenantId, input.agentId, input.mode, input.firesAt, input.threadId, input.originTrust,
        input.originSurface, input.threadRevision, input.wakeChainDepth, input.contextRef,
        input.scheduledByInvocationId, JSON.stringify(input.workflowResumePayload), input.memberTotal,
        input.id ?? null,
      ],
    );
    return rows[0].id as string;
  },

  async updateCloudTaskName(id: string, cloudTaskName: string): Promise<void> {
    const pool = getPool();
    await pool.query(`UPDATE wake_wait_sets SET cloud_task_name = $2, updated_at = NOW() WHERE id = $1`, [id, cloudTaskName]);
  },

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM wake_wait_sets WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  /** pending -> resume_inflight (atomic, tenant-bound, mints a fenced lease). Null if not claimable. */
  async claimForResume(id: string, tenantId: string): Promise<Record<string, unknown> | null> {
    const pool = getPool();
    const { rows } = await pool.query(
      // C2: same attempt budget as the scheduled-invocation claim — see
      // WAKE_MAX_RESUME_ATTEMPTS. A wait-set that keeps killing the process
      // that resumes it is parked rather than reclaimed forever.
      `UPDATE wake_wait_sets
         SET status = 'resume_inflight', lease_token = gen_random_uuid(),
             lease_until = NOW() + INTERVAL '15 minutes', lease_heartbeat_at = NOW(),
             resume_attempts = resume_attempts + 1, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
         AND resume_attempts < $3
       RETURNING *`,
      [id, tenantId, WAKE_MAX_RESUME_ATTEMPTS],
    );
    return rows[0] ?? null;
  },

  async heartbeat(id: string, leaseToken: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE wake_wait_sets SET lease_until = NOW() + INTERVAL '15 minutes', lease_heartbeat_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status IN ('resume_inflight','settlement_pending')`,
      [id, leaseToken],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** resume_inflight -> settlement_pending, persisting the continuation result. */
  async persistResult(id: string, leaseToken: string, result: unknown): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE wake_wait_sets SET status = 'settlement_pending', wake_result = $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status = 'resume_inflight'`,
      [id, leaseToken, JSON.stringify(result ?? null)],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** settlement_pending -> fired (after delivery ACK). */
  async settle(id: string, leaseToken: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE wake_wait_sets SET status = 'fired', fired_at = NOW(), lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status = 'settlement_pending'`,
      [id, leaseToken],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** Retryable failure / lock contention: release lease back to pending (never fired). */
  async releaseLease(id: string, leaseToken: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE wake_wait_sets SET status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status IN ('resume_inflight','settlement_pending')`,
      [id, leaseToken],
    );
    return (r.rowCount ?? 0) > 0;
  },

  async markErrored(id: string, leaseToken: string, error: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE wake_wait_sets SET status = 'errored', last_error = $3, lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status IN ('resume_inflight','settlement_pending')`,
      [id, leaseToken, error],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** Reconciler: reset stale wait-set leases to pending so the resume can be re-claimed. */
  async reclaimStaleLeases(limit = 100): Promise<Array<Record<string, unknown>>> {
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE wake_wait_sets
         SET status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE id IN (
         SELECT id FROM wake_wait_sets
         WHERE status IN ('resume_inflight','settlement_pending') AND lease_until IS NOT NULL AND lease_until < NOW()
         ORDER BY lease_until ASC LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id, agent_id, status, thread_id`,
      [limit],
    );
    return rows;
  },

  /** Operator / cancel_wake: cancel a live wait-set (tenant-bound). Caller cancels the member wakes. */
  async cancelById(tenantId: string, id: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE wake_wait_sets SET status = 'cancelled', cancelled_at = NOW(), lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status IN ('pending','resume_inflight','settlement_pending')`,
      [id, tenantId],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** Operator surface: list a tenant's live wait-sets (optionally for one agent). Shaped to match the
   *  ASI operator rows (so the caller can present + cost-enrich both uniformly). */
  async listForOperator(tenantId: string, agentId: string | null, limit = 200): Promise<Array<Record<string, unknown>>> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, agent_id, mode, status, fires_at, wake_chain_depth, origin_surface, resume_attempts,
              context_ref, scheduled_by_invocation_id, member_total, created_at, updated_at
       FROM wake_wait_sets
       WHERE tenant_id = $1
         AND status IN ('pending','resume_inflight','settlement_pending')
         AND ($2::uuid IS NULL OR agent_id = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [tenantId, agentId, limit],
    );
    return rows;
  },

  async cancelByContextRef(tenantId: string, agentId: string, contextRef: string): Promise<string | null> {
    const pool = getPool();
    const r = await pool.query<{ id: string }>(
      `UPDATE wake_wait_sets SET status = 'cancelled', cancelled_at = NOW(), lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE tenant_id = $1 AND agent_id = $2 AND context_ref = $3 AND status IN ('pending','resume_inflight','settlement_pending')
       RETURNING id`,
      [tenantId, agentId, contextRef],
    );
    return r.rows[0]?.id ?? null;
  },

  /** Park wait-sets that have exhausted their resume budget (C2). Mirrors
   *  parkExhaustedWakes on the scheduled-invocation repo. */
  async parkExhaustedWaitSets(limit = 100): Promise<Array<Record<string, unknown>>> {
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE wake_wait_sets
       SET status = 'parked', lease_token = NULL, lease_until = NULL, updated_at = NOW(),
           last_error = COALESCE(last_error, 'parked: resume attempts exhausted')
       WHERE id IN (
         SELECT id FROM wake_wait_sets
         WHERE status = 'pending' AND resume_attempts >= $1
         ORDER BY updated_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id, agent_id, resume_attempts`,
      [WAKE_MAX_RESUME_ATTEMPTS, limit],
    );
    return rows;
  },

};
