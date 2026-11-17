// agent_scheduled_invocations: agent_scheduled_invocations repository.
//
// Owns CRUD over the table declared in migration 220. Used by:
//   - schedule_followup tool (L1) — insert when the LLM schedules a follow-up.
//   - workflow delay steps workflow delay handler — insert when a delay step suspends.
//   - /api/tasks/resume-execution (cloud-tasks-handler.ts) — mark fired.
//   - cancel.ts — bulk cancel by context_ref prefix.

import { getPool } from '../infrastructure/database';

export interface ScheduledInvocationRow {
  id: string;
  tenantId: string;
  agentId: string;
  threadId: string | null;
  contextRef: string;
  scheduleKey: string;
  firesAt: Date;
  objective: string;
  cloudTaskName: string | null;
  status: 'pending' | 'resume_inflight' | 'settlement_pending' | 'fired' | 'cancelled' | 'errored';
  scheduledByInvocationId: string | null;
  workflowResumePayload: Record<string, unknown> | null;
  firedAt: Date | null;
  cancelledAt: Date | null;
  lastError: string | null;
  clarificationSource: 'recovery_llm' | 'anchor_intervention' | null;
  vendorRequestId: string | null;
  /** 'blocker' when a person must act outside the product before the run can
   *  continue, 'question' when they only need to answer. NULL on rows written
   *  before migration 352, which every consumer reads as 'question' — the
   *  behaviour those rows were armed with. */
  clarificationOrigin: 'question' | 'blocker' | null;
  /** When the durable notification for this row was successfully sent. NULL
   *  means nobody has been told yet, which is what makes the next tick retry
   *  rather than assume delivery. */
  notifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsertScheduledInvocationInput {
  /** The row's id, when the caller minted it ahead of the insert (a pause
   *  checkpoint is keyed by it and written first). Absent, the database mints one. */
  id?: string;
  tenantId: string;
  agentId: string;
  contextRef: string;
  threadId?: string | null;
  firesAt: Date;
  objective: string;
  scheduleKey: string;
  scheduledByInvocationId?: string | null;
  /** D25: widened from `{workflowId, invocationId}` to a generic record so
   *  hybrid execution engine pause payloads (HybridResumeState) can carry
   *  richer state on the same JSONB column. Non-breaking — existing callers
   *  pass shapes that satisfy the wider type. */
  workflowResume?: Record<string, unknown> | null;
  clarificationSource?: 'recovery_llm' | 'anchor_intervention';
  vendorRequestId?: string | null;
}

/** Exported so AgentExecutionService.createClarificationPause can map the
 *  row it INSERTs inside its own transaction without inlining the field
 *  mapping (keeps the row→type contract in one place). */
export function mapRow(row: Record<string, unknown>): ScheduledInvocationRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    agentId: row.agent_id as string,
    threadId: (row.thread_id ?? null) as string | null,
    contextRef: row.context_ref as string,
    scheduleKey: row.schedule_key as string,
    firesAt: row.fires_at as Date,
    objective: row.objective as string,
    cloudTaskName: (row.cloud_task_name ?? null) as string | null,
    status: row.status as ScheduledInvocationRow['status'],
    scheduledByInvocationId: (row.scheduled_by_invocation_id ?? null) as string | null,
    workflowResumePayload: (row.workflow_resume_payload ?? null) as Record<string, unknown> | null,
    firedAt: (row.fired_at ?? null) as Date | null,
    cancelledAt: (row.cancelled_at ?? null) as Date | null,
    lastError: (row.last_error ?? null) as string | null,
    clarificationSource: (row.clarification_source ?? null) as
      | 'recovery_llm'
      | 'anchor_intervention'
      | null,
    vendorRequestId: (row.vendor_request_id ?? null) as string | null,
    clarificationOrigin: (row.clarification_origin ?? null) as 'question' | 'blocker' | null,
    notifiedAt: (row.notified_at ?? null) as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * How many times a wake may be claimed for resume before it is parked (C2).
 *
 * `resume_attempts` has always been incremented on every fenced claim, and
 * never read. Without a cap, a resume that crashes the PROCESS is reclaimed by
 * the stale-lease reconciler and crashes it again — indefinitely, taking the
 * whole wake queue down with it. Five attempts is generous for the legitimate
 * causes (a deploy mid-resume, a transient dependency) and short enough that a
 * genuine crash loop is contained within minutes rather than days.
 *
 * Tunable via env so an incident can widen it without a deploy; declared in
 * Terraform like every other runtime flag.
 */
export const WAKE_MAX_RESUME_ATTEMPTS = Number(process.env.WAKE_MAX_RESUME_ATTEMPTS ?? 5);

/**
 * How many times a clarification answer may be re-attempted before the ask is
 * abandoned. See `releaseFailedClarificationResume` for why a cap is required
 * rather than merely tidy: the released status is the same one the chat-turn
 * router treats as "this message is the answer", so an ask that can never
 * resume would otherwise absorb every later message on the thread.
 *
 * Same default and same env-override shape as the wake cap above.
 */
export const CLARIFICATION_MAX_RESUME_ATTEMPTS = Number(
  process.env.CLARIFICATION_MAX_RESUME_ATTEMPTS ?? 5,
);

/** The fenced claim every resume that can fail after claiming takes.
 *
 *  Lease uses gen_random_uuid() as the fencing token + a 15-min lease window
 *  (mirrors execution-environments/agent-lock.ts). Every post-claim transition
 *  carries WHERE lease_token=$t, so a stale worker whose lease was reclaimed
 *  can never overwrite the new owner. Refuses the claim once the attempt
 *  budget is spent: a row that has burned through it is parked by
 *  `parkExhaustedWakes` rather than handed to another worker to crash on. */
async function claimPendingForResume(id: string, tenantId: string): Promise<Record<string, unknown> | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE agent_scheduled_invocations
     SET status = 'resume_inflight', lease_token = gen_random_uuid(),
         lease_until = NOW() + INTERVAL '15 minutes', lease_heartbeat_at = NOW(),
         resume_attempts = resume_attempts + 1, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
       AND resume_attempts < $3
     RETURNING *`,
    [id, tenantId, WAKE_MAX_RESUME_ATTEMPTS],
  );
  return rows[0] ?? null;
}

/** Back to `pending`, fenced, keeping why when the caller says.
 *
 *  A DEFERRAL hands the attempt back. "Not now" — the engine cannot be built
 *  here, execution is not admitted, the reasons in force cannot be read — is
 *  not a failed attempt, and counting it as one spent the whole budget inside
 *  the queue's thirty seconds of retries and parked an approved send behind a
 *  governance outage shorter than a coffee. */
async function releaseLease(id: string, leaseToken: string, error?: string, opts: { deferred?: boolean } = {}): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query(
    `UPDATE agent_scheduled_invocations
     SET status = 'pending', lease_token = NULL, lease_until = NULL,
         resume_attempts = CASE WHEN $4 THEN GREATEST(resume_attempts - 1, 0) ELSE resume_attempts END,
         last_error = COALESCE($3, last_error), updated_at = NOW()
     WHERE id = $1 AND lease_token = $2 AND status IN ('resume_inflight', 'settlement_pending')`,
    [id, leaseToken, error ?? null, opts.deferred === true],
  );
  return (r.rowCount ?? 0) > 0;
}

export const agentScheduledInvocationsRepo = {
  async insert(input: InsertScheduledInvocationInput): Promise<ScheduledInvocationRow> {
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO agent_scheduled_invocations
         (tenant_id, agent_id, thread_id, context_ref, schedule_key, fires_at, objective,
          scheduled_by_invocation_id, workflow_resume_payload,
          clarification_source, vendor_request_id, id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::uuid, gen_random_uuid()))
       RETURNING *`,
      [
        input.tenantId,
        input.agentId,
        input.threadId ?? null,
        input.contextRef,
        input.scheduleKey,
        input.firesAt,
        input.objective,
        input.scheduledByInvocationId ?? null,
        input.workflowResume ? JSON.stringify(input.workflowResume) : null,
        input.clarificationSource ?? null,
        input.vendorRequestId ?? null,
        input.id ?? null,
      ],
    );
    return mapRow(rows[0]);
  },

  async updateCloudTaskName(id: string, cloudTaskName: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE agent_scheduled_invocations
       SET cloud_task_name = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, cloudTaskName],
    );
  },

  async markFiredByInvocationId(invocationId: string): Promise<number> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'fired', fired_at = NOW(), updated_at = NOW()
       WHERE scheduled_by_invocation_id = $1 AND status = 'pending'`,
      [invocationId],
    );
    return result.rowCount ?? 0;
  },

  async markClarificationFired(id: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'fired', fired_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id],
    );
  },

  /** A clarification's window closed with no answer (migration 419).
   *
   *  The expiry path's own transition, distinct from `markClarificationFired`
   *  and `markFiredByInvocationId`, which stay ignorant of the resolution
   *  columns: the outcome is written in the SAME statement that flips the
   *  status, guarded on a pending clarification row, so an outcome can never
   *  exist without its transition and a row somebody already answered is left
   *  exactly as they left it. */
  async markClarificationExpiredById(id: string): Promise<number> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'fired', fired_at = NOW(),
           resolution_kind = 'expired', resolved_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND status = 'pending' AND objective = 'clarification-expiry'`,
      [id],
    );
    return result.rowCount ?? 0;
  },

  /** The same transition, addressed by the invocation that scheduled the row,
   *  for the recovery-LLM expiry branch that carries no row id. */
  async markClarificationExpiredByInvocationId(invocationId: string): Promise<number> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'fired', fired_at = NOW(),
           resolution_kind = 'expired', resolved_at = NOW(),
           updated_at = NOW()
       WHERE scheduled_by_invocation_id = $1 AND status = 'pending'
         AND objective = 'clarification-expiry'`,
      [invocationId],
    );
    return result.rowCount ?? 0;
  },

  async getById(id: string): Promise<ScheduledInvocationRow | null> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM agent_scheduled_invocations WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async markErrored(id: string, error: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'errored', last_error = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [id, error],
    );
  },

  /** A clarification resume failed: put the ask back where a person can see it.
   *
   *  The answer path moves the row 'pending' -> 'resume_inflight' without
   *  taking a lease, so when the resume failed nothing could recover it.
   *  `markErrored` matches only 'pending' and silently did nothing; the stale
   *  lease reconciler skips it because `lease_until` is null; and the queue
   *  predicate selects 'pending' alone. The row sat in 'resume_inflight'
   *  forever — out of the queue, never retried, never errored, and the person
   *  who answered was never told their answer had not landed.
   *
   *  Returning it to 'pending' is both halves of the fix. Cloud Tasks retries
   *  the same task and `resumeFromClarificationAnswer` still accepts the row,
   *  so a transient failure heals itself; and once the retries are exhausted
   *  the ask is back in the queue, which is the honest report that it was not
   *  delivered. `last_error` keeps why.
   *
   *  Bounded, because 'pending' is also what the chat-turn handler looks for
   *  when deciding that the next message on the thread is an answer rather than
   *  a new request. An ask that can never resume and is released forever would
   *  swallow every subsequent message on that thread — the person would type,
   *  the router would hand it to a resume that fails again, and chat would be
   *  dead with no error anywhere. After the budget is spent the ask is errored
   *  instead, which drops it out of that predicate and lets the thread go back
   *  to ordinary turns. Same `resume_attempts` counter and the same reasoning
   *  as the wake queue's claim cap.
   *
   *  The recorded outcome (migration 419) is cleared in the same statement.
   *  The answer or decline that moved the row to 'resume_inflight' wrote
   *  resolution_kind and the actor alongside the transition, and this is the
   *  transition being undone: a released ask is back in front of a person and
   *  an exhausted one was never delivered, so a row that still said "answered"
   *  would report a resolution that did not take effect. */
  async releaseFailedClarificationResume(
    id: string,
    error: string,
  ): Promise<{ released: boolean; exhausted: boolean }> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = CASE WHEN resume_attempts + 1 >= $3 THEN 'errored' ELSE 'pending' END,
           resume_attempts = resume_attempts + 1,
           last_error = $2,
           resolution_kind = NULL,
           resolved_by = NULL,
           resolved_by_label = NULL,
           resolved_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status = 'resume_inflight'
         AND objective = 'clarification-expiry'
       RETURNING status`,
      [id, error, CLARIFICATION_MAX_RESUME_ATTEMPTS],
    );
    const status = r.rows?.[0]?.status as string | undefined;
    return { released: status === 'pending', exhausted: status === 'errored' };
  },

  async cancelByContextRefPrefix(tenantId: string, contextRefPrefix: string): Promise<ScheduledInvocationRow[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND context_ref LIKE $2 AND status = 'pending'
       RETURNING *`,
      [tenantId, `${contextRefPrefix}%`],
    );
    return rows.map(mapRow);
  },

  async findById(id: string): Promise<ScheduledInvocationRow | null> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM agent_scheduled_invocations WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async listPendingForAgent(tenantId: string, agentId: string): Promise<ScheduledInvocationRow[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM agent_scheduled_invocations
       WHERE tenant_id = $1 AND agent_id = $2 AND status = 'pending'
       ORDER BY fires_at ASC`,
      [tenantId, agentId],
    );
    return rows.map(mapRow);
  },

  // ── Self-wake fenced lease state machine ─────────────────────────
  // Lease uses gen_random_uuid() as the fencing token + a 15-min lease window (mirrors
  // execution-environments/agent-lock.ts). Every post-claim transition carries WHERE lease_token=$t,
  // so a stale worker whose lease was reclaimed can never overwrite the new owner.

  /** pending -> resume_inflight. Atomic + tenant-bound. Returns the row (incl new lease_token) or null. */
  async claimWakeForResume(id: string, tenantId: string): Promise<Record<string, unknown> | null> {
    return claimPendingForResume(id, tenantId);
  },

  /** The HITL resume's claim: the same fenced `pending -> resume_inflight`
   *  lease a wake takes, on the approval's pause row.
   *
   *  The HITL resume used to flip its row straight to `fired` before it had
   *  built anything. `fired` is irrevocable — `markErrored` matches only
   *  `pending` — so a failure between that flip and the dispatch (an engine
   *  this deployment cannot construct) left an approved action nothing would
   *  ever retry: the row said fired, the retry saw fired and stopped, and the
   *  agent sat RUNNING. A lease is the state that says "somebody is on it" and
   *  can still be handed back. Released with `releaseResumeLease`, settled with
   *  `markFiredUnderLease`; a lease that outlives its holder is reclaimed by the
   *  same reconciler that reclaims a wake's. */
  async claimHitlForResume(id: string, tenantId: string): Promise<Record<string, unknown> | null> {
    return claimPendingForResume(id, tenantId);
  },

  /** resume_inflight -> fired, fenced. The point past which a duplicate
   *  delivery must find the row spent. False when the lease was lost, in which
   *  case the caller has no claim on the row and must not dispatch. */
  async markFiredUnderLease(id: string, leaseToken: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'fired', fired_at = NOW(), lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status = 'resume_inflight'`,
      [id, leaseToken],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** Hand a claimed row back to `pending` (NEVER fired) with the reason, so
   *  the next delivery can claim it again. Fenced by lease_token. Pass
   *  `deferred` when the row was not tried at all — the attempt is handed back
   *  with it. */
  async releaseResumeLease(id: string, leaseToken: string, error?: string, opts: { deferred?: boolean } = {}): Promise<boolean> {
    return releaseLease(id, leaseToken, error, opts);
  },

  /** Renew the lease while gates/model/settlement run. Returns false if the lease was lost. */
  async heartbeatWakeLease(id: string, leaseToken: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET lease_until = NOW() + INTERVAL '15 minutes', lease_heartbeat_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status IN ('resume_inflight', 'settlement_pending')`,
      [id, leaseToken],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** resume_inflight -> settlement_pending, persisting the continuation result (settlement replay source). */
  async persistWakeResult(id: string, leaseToken: string, result: unknown): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'settlement_pending', wake_result = $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status = 'resume_inflight'`,
      [id, leaseToken, JSON.stringify(result ?? null)],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** settlement_pending -> fired (after PB delivery ACK). */
  async settleWake(id: string, leaseToken: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'fired', fired_at = NOW(), lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status = 'settlement_pending'`,
      [id, leaseToken],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** Retryable failure / lock contention: release lease, back to pending (NEVER fired). */
  async releaseWakeLease(id: string, leaseToken: string): Promise<boolean> {
    return releaseLease(id, leaseToken);
  },

  /** Terminal error from ANY non-terminal status (the existing markErrored only touches 'pending' —
   *). Fenced by lease_token. */
  async markWakeErrored(id: string, leaseToken: string, error: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'errored', last_error = $3, lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status IN ('resume_inflight', 'settlement_pending')`,
      [id, leaseToken, error],
    );
    return (r.rowCount ?? 0) > 0;
  },


  /**
   * Park wakes that have exhausted their resume budget (C2).
   *
   * Runs alongside the stale-lease reconciler: that one hands rows back to be
   * retried, and this one takes the rows out that have proven they will not
   * succeed. Without it the reconciler would keep resetting the same poisoned
   * row to 'pending' forever while claimForResume silently refused it — a queue
   * that looks busy and moves nothing.
   *
   * Returns the parked rows so the caller can alert on them.
   */
  async parkExhaustedWakes(limit = 100): Promise<Array<Record<string, unknown>>> {
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'parked', lease_token = NULL, lease_until = NULL, updated_at = NOW(),
           last_error = COALESCE(last_error, 'parked: resume attempts exhausted')
       WHERE id IN (
         SELECT id FROM agent_scheduled_invocations
         WHERE status = 'pending' AND resume_attempts >= $1
         ORDER BY updated_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id, agent_id, wake_kind, resume_attempts`,
      [WAKE_MAX_RESUME_ATTEMPTS, limit],
    );
    return rows;
  },

  /** Reconciler: clear stale leases (resume_inflight/settlement_pending past lease_until) but KEEP the
   *  status, and return the rows so the reconciler loop can re-enqueue the appropriate Cloud Task
   *  (resume for resume_inflight; settlement for settlement_pending — settlement replays wake_result,
   * never reruns the agent). */
  async reclaimStaleWakeLeases(limit = 100): Promise<Array<Record<string, unknown>>> {
    const pool = getPool();
    // Reset to 'pending' so resumeFromWake can re-claim. A resume_inflight re-run replays via the
    // event_processing_ledger (stable triggerKey) rather than re-running tools; a settlement_pending
    // re-run likewise replays the cached result and re-drives delivery only.
    const { rows } = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE id IN (
         SELECT id FROM agent_scheduled_invocations
         WHERE status IN ('resume_inflight', 'settlement_pending')
           AND lease_until IS NOT NULL AND lease_until < NOW()
         ORDER BY lease_until ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id, agent_id, status, wake_kind, thread_id, workflow_resume_payload,
                 scheduled_by_invocation_id`,
      [limit],
    );
    return rows;
  },

  // ── Wait-set members (wake_on_any / wake_on_all) ─────────────────────────
  // A member wake is an ordinary row with wait_set_id set. Firing it does NOT run the agent; it signals
  // the wait-set. The member transitions resume_inflight -> fired (fenced) and the wait-set decides.

  /** Member fired: resume_inflight -> fired (fenced). The member's trigger condition was met. */
  async fireWaitSetMember(id: string, leaseToken: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE agent_scheduled_invocations
         SET status = 'fired', fired_at = NOW(), lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status = 'resume_inflight'`,
      [id, leaseToken],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** Count members of a wait-set that have NOT yet fired (or been cancelled/errored). For 'all' mode
   *  the wait-set resumes when this reaches 0. */
  async countUnfiredWaitSetMembers(waitSetId: string): Promise<number> {
    const pool = getPool();
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agent_scheduled_invocations
       WHERE wait_set_id = $1 AND status NOT IN ('fired','cancelled','errored')`,
      [waitSetId],
    );
    return Number(rows[0]?.n ?? 0);
  },

  /** Cancel a wait-set's still-live sibling members (for 'any' mode, after one fires). Optionally keep
   *  the member that fired. Returns the cancelled members so the caller can best-effort cancel triggers. */
  async cancelWaitSetMembers(waitSetId: string, exceptId?: string): Promise<Array<Record<string, unknown>>> {
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE agent_scheduled_invocations
         SET status = 'cancelled', cancelled_at = NOW(), lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE wait_set_id = $1 AND ($2::uuid IS NULL OR id <> $2)
         AND status IN ('pending','resume_inflight','settlement_pending')
       RETURNING id, cloud_task_name, bound_subscription_id`,
      [waitSetId, exceptId ?? null],
    );
    return rows;
  },

  /** Durable per-(tenant,agent) fixed-window resume-rate counter. Atomically bumps the
   *  current window's count (resetting it when the window elapsed) and returns the post-bump count so
   *  the caller can DEFER over-limit resumes. Runaway protection, not a cost cap. */
  async bumpResumeRate(tenantId: string, agentId: string, windowSeconds: number): Promise<number> {
    const pool = getPool();
    const { rows } = await pool.query<{ count: number }>(
      `INSERT INTO wake_resume_rate (tenant_id, agent_id, window_start, count)
       VALUES ($1, $2, NOW(), 1)
       ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
         count = CASE WHEN wake_resume_rate.window_start < NOW() - ($3 || ' seconds')::interval
                      THEN 1 ELSE wake_resume_rate.count + 1 END,
         window_start = CASE WHEN wake_resume_rate.window_start < NOW() - ($3 || ' seconds')::interval
                             THEN NOW() ELSE wake_resume_rate.window_start END
       RETURNING count`,
      [tenantId, agentId, String(Math.max(1, Math.floor(windowSeconds)))],
    );
    return Number(rows[0]?.count ?? 1);
  },

  /** Poll re-arm: record the attempt and release the lease back to pending for the next
   *  poll tick. Fenced by lease_token so a stale worker cannot re-arm the new owner's row. */
  async rearmPoll(id: string, leaseToken: string, attempt: number): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status='pending', wake_poll_attempts=$3, lease_token=NULL, lease_until=NULL, updated_at=NOW()
       WHERE id=$1 AND lease_token=$2 AND status='resume_inflight'`,
      [id, leaseToken, attempt],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** Operator surface: list a tenant's live wakes (optionally for one agent). */
  async listWakesForOperator(tenantId: string, agentId: string | null, limit = 200): Promise<Array<Record<string, unknown>>> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, agent_id, wake_kind, status, fires_at, wake_chain_depth, origin_surface,
              resume_attempts, context_ref, scheduled_by_invocation_id, created_at, updated_at
       FROM agent_scheduled_invocations
       WHERE tenant_id = $1 AND wake_kind IS NOT NULL
         AND wait_set_id IS NULL   -- members are surfaced via their parent wake-set, not individually
         AND status IN ('pending','resume_inflight','settlement_pending')
         AND ($2::uuid IS NULL OR agent_id = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [tenantId, agentId, limit],
    );
    return rows;
  },

  /** Operator cancel of a live wake by id (tenant-bound). */
  async cancelWakeById(tenantId: string, wakeId: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status='cancelled', cancelled_at=NOW(), lease_token=NULL, lease_until=NULL, updated_at=NOW()
       WHERE id=$1 AND tenant_id=$2
         AND status IN ('pending','resume_inflight','settlement_pending') AND wake_kind IS NOT NULL`,
      [wakeId, tenantId],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /** Clamp a child's wake TTL to its parent saga deadline: a self-woken child must not outlive the
   *  parent delegation (whose delegation-expiry compensates at its own deadline). Sets the wake row's
   *  fires_at to the earlier of its current value and the parent's deleg:<parentTaskId> deadline.
   *  Returns the (possibly-clamped) fires_at so the caller can re-arm the expiry task if it moved. */
  async reconcileChildWakeTtl(wakeRowId: string, childTaskId: string): Promise<Date | null> {
    const pool = getPool();
    const { rows } = await pool.query<{ fires_at: Date }>(
      `UPDATE agent_scheduled_invocations w
         SET fires_at = LEAST(w.fires_at, p.fires_at), updated_at = NOW()
       FROM child_tasks c
       JOIN agent_scheduled_invocations p
         ON p.context_ref = 'deleg:' || c.parent_task_id
        AND p.status = 'pending'
       WHERE w.id = $1 AND c.id = $2
       RETURNING w.fires_at AS fires_at`,
      [wakeRowId, childTaskId],
    );
    return rows[0] ? (rows[0].fires_at as Date) : null;
  },

  /** Bind a coordinator child task to a wake row: when a self-woken CHILD pauses, the
   *  child-task receiver records its childTaskId on the wake so resumeFromWake can complete the child
   *  once the wake continuation succeeds (instead of the saga-timeout backstop). Stored in wake_spec. */
  async bindWakeChildTask(wakeRowId: string, childTaskId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE agent_scheduled_invocations
       SET wake_spec = jsonb_set(COALESCE(wake_spec, '{}'::jsonb), '{_childTaskId}', to_jsonb($2::text)),
           updated_at = NOW()
       WHERE id = $1`,
      [wakeRowId, childTaskId],
    );
  },

  /** Direct, tenant-bound, lease-aware cancel of a pending wake (cancel_wake tool,).
   *  Best-effort Cloud Task / subscription cancellation is done by the caller (TODO). */
  async cancelWakeByContextRef(tenantId: string, agentId: string, contextRef: string): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'cancelled', cancelled_at = NOW(), lease_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE tenant_id = $1 AND agent_id = $2 AND context_ref = $3
         AND status IN ('pending', 'resume_inflight', 'settlement_pending') AND wake_kind IS NOT NULL`,
      [tenantId, agentId, contextRef],
    );
    return (r.rowCount ?? 0) > 0;
  },
};
