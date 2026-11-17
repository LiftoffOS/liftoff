// Sandbox State Repository
// Persists sandbox lifecycle state for crash recovery and GC sweep.
// Resolved: BE-006 — lifecycle state in DB, not just in-memory Map.

import { getPoolForService } from '../infrastructure/database';
import { SandboxStateRecord, SandboxStatus, ExecutionEnvironmentType } from './types';
import { armWatch, MAINTENANCE_PATHS } from '../infrastructure/maintenance-tasks';

const pool = getPoolForService('default');

/**
 * Arm the GC sweep for a sandbox that exists. Every live sandbox is a pinned
 * Cloud Run instance, so the sweep that tears down a finished run's sandbox is
 * money: on a 6-hourly clock a run's sandbox outlived it by up to six hours.
 * Armed at the claim and re-armed by the sweep while any sandbox is live
 * (execution-environments/router.ts), so the sweep runs every ten minutes
 * while sandboxes exist and never when none do.
 */
export function armSandboxGcWatch(): void {
  armWatch('sandbox-gc', MAINTENANCE_PATHS.sandboxGcSweep, { delayMs: 60_000, target: 'sandbox-executor' });
}

export class SandboxStateRepository {
  /**
   * Claim the right to provision this session's sandbox, before provisioning
   * starts. Returns false when another caller already holds the claim.
   *
   * The INSERT is the lock (idx_sandbox_state_live_session, migration 348).
   * Recording the intent up front is what makes the ~1 minute of provisioning
   * a state the system can SEE: a second caller reads 'creating' and is told
   * to retry instead of provisioning a duplicate, a create that dies leaves a
   * row to reconcile rather than an unreferenced Cloud Run service, and
   * `ready_at - created_at` finally spans the provision instead of the
   * microseconds between two adjacent statements.
   */
  async claimProvisioning(record: {
    sandboxId: string;
    sessionId: string;
    tenantId: string;
    agentId: string;
    invocationId: string;
    template: ExecutionEnvironmentType;
    capabilities?: SandboxStateRecord['capabilities'];
  }): Promise<boolean> {
    const res = await pool.query(
      `INSERT INTO sandbox_state
        (sandbox_id, session_id, tenant_id, agent_id, invocation_id, status, template,
         capabilities, created_at, last_heartbeat, last_billed_at)
       VALUES ($1, $2, $3, $4, $5, 'creating', $6, $7, NOW(), NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING sandbox_id`,
      [
        record.sandboxId,
        record.sessionId,
        record.tenantId,
        record.agentId,
        record.invocationId,
        record.template,
        record.capabilities ?? ['shell', 'file', 'browser', 'vscode'],
      ],
    );
    const claimed = (res.rowCount ?? 0) > 0;
    if (claimed) armSandboxGcWatch();
    return claimed;
  }

  /** Whether any sandbox is still live: the GC sweep re-arms itself while one is. */
  async hasLiveSandboxes(): Promise<boolean> {
    const res = await pool.query(
      `SELECT 1 FROM sandbox_state WHERE status NOT IN ('destroyed', 'error') LIMIT 1`,
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Provisioning finished: the sandbox is usable. `ready_at` is stamped here
   *  and nowhere else, so the cold-start metric measures the real wait. */
  async markProvisioned(
    sandboxId: string,
    details: { jwtSecretEncrypted?: Buffer; imageTag?: string },
  ): Promise<void> {
    await pool.query(
      `UPDATE sandbox_state
          SET status = 'ready',
              ready_at = COALESCE(ready_at, NOW()),
              last_heartbeat = NOW(),
              jwt_secret_encrypted = COALESCE($2, jwt_secret_encrypted),
              image_tag = COALESCE($3, image_tag)
        WHERE sandbox_id = $1`,
      [sandboxId, details.jwtSecretEncrypted ?? null, details.imageTag ?? null],
    );
  }

  /** Provisioning failed. 'error' releases the session's claim so the next
   *  attempt can start clean, and the GC sweep destroys any service that did
   *  come up behind the failure. */
  async markProvisionFailed(sandboxId: string): Promise<void> {
    await pool.query(
      `UPDATE sandbox_state SET status = 'error' WHERE sandbox_id = $1`,
      [sandboxId],
    );
  }

  async create(record: Omit<SandboxStateRecord, 'createdAt' | 'lastHeartbeat' | 'destroyedAt'>): Promise<void> {
    await pool.query(
      `INSERT INTO sandbox_state
        (sandbox_id, session_id, tenant_id, agent_id, invocation_id, status, template,
         capabilities, jwt_secret_encrypted, image_tag,
         created_at, last_heartbeat, last_billed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW(), NOW())`,
      [
        record.sandboxId,
        record.sessionId,
        record.tenantId,
        record.agentId,
        record.invocationId,
        record.status,
        record.template,
        record.capabilities ?? ['shell', 'file', 'browser', 'vscode'],
        record.jwtSecretEncrypted ?? null,
        record.imageTag ?? null,
      ],
    );
  }

  /**
   * Stop further alive-billing for a sandbox. Called from the cleanup path
   * AFTER the final partial-minute charge is flushed by InstanceAliveTicker.tick().
   * The ticker's WHERE clause skips rows where status IS IN ('destroyed','error'),
   * so just setting status='destroyed' is sufficient — this method makes
   * that intent explicit at the call site.
   */
  async stopBilling(sandboxId: string): Promise<void> {
    await pool.query(
      `UPDATE sandbox_state SET last_billed_at = NULL WHERE sandbox_id = $1`,
      [sandboxId],
    );
  }

  /**
   * Cost-ceiling check used by SandboxExecutor before dispatching each tool
   * call. Returns the running total of micro-credits charged to this
   * sandbox so far. Used to gate destructive ops when the per-sandbox
   * ceiling is exceeded.
   */
  async getCostMicroCreditsTotal(sandboxId: string): Promise<number> {
    const result = await pool.query<{ cost_micro_credits_total: string | number }>(
      `SELECT cost_micro_credits_total FROM sandbox_state WHERE sandbox_id = $1`,
      [sandboxId],
    );
    if (result.rows.length === 0) return 0;
    const raw = result.rows[0].cost_micro_credits_total;
    return typeof raw === 'string' ? parseInt(raw, 10) : raw;
  }

  /**
   * Mark the sandbox as ready (Cloud Run startup probe first returned 200).
   * Drives the cold-start metric (sandbox_cold_start_seconds = ready_at - created_at).
   */
  async markReady(sandboxId: string, readyAt: Date = new Date()): Promise<void> {
    await pool.query(
      `UPDATE sandbox_state SET ready_at = $2, last_heartbeat = NOW()
       WHERE sandbox_id = $1 AND ready_at IS NULL`,
      [sandboxId, readyAt],
    );
  }

  /**
   * Re-hydrate all in-flight sandboxes on runtime boot:
   * decrypt the per-sandbox JWT secret from sandbox_state.jwt_secret_encrypted
   * and seed it back into the provider's in-memory cache. Called once from
   * src/index.ts after the provider is constructed.
   */
  async hydrateAllJwtSecrets(provider: { restoreJwtSecret: (sandboxId: string, ciphertext: Buffer) => Promise<void> }): Promise<{ restored: number; failed: number }> {
    const result = await pool.query(
      `SELECT sandbox_id, jwt_secret_encrypted FROM sandbox_state
       WHERE status NOT IN ('destroyed', 'error') AND jwt_secret_encrypted IS NOT NULL`,
    );
    let restored = 0;
    let failed = 0;
    for (const row of result.rows) {
      try {
        await provider.restoreJwtSecret(row.sandbox_id as string, row.jwt_secret_encrypted as Buffer);
        restored++;
      } catch {
        failed++;
      }
    }
    return { restored, failed };
  }

  async updateStatus(sandboxId: string, status: SandboxStatus): Promise<void> {
    const setClause = status === 'destroyed'
      ? `status = $2, destroyed_at = NOW(), last_heartbeat = NOW()`
      : `status = $2, last_heartbeat = NOW()`;

    await pool.query(
      `UPDATE sandbox_state SET ${setClause} WHERE sandbox_id = $1`,
      [sandboxId, status],
    );
  }

  async heartbeat(sandboxId: string): Promise<void> {
    await pool.query(
      `UPDATE sandbox_state SET last_heartbeat = NOW() WHERE sandbox_id = $1`,
      [sandboxId],
    );
  }

  /** Sandboxes whose owning run has finished and will never come back to them.
   *
   *  A sandbox is a pinned instance (minInstanceCount 1, 4 vCPU / 8 GB) for its
   *  whole life, so the 20-minute idle window costs real capacity. That window
   *  earns its keep for a conversation — the person may send another message,
   *  and the workspace is keyed by the thread — but a cron or event run gets a
   *  fresh thread every time it fires, so its workspace has no possible second
   *  reader. Prod bears that out: 5 sandboxes, 5 distinct sessions, no reuse.
   *
   *  Deliberately narrow:
   *  - `human` and `agent` triggers are EXCLUDED. A person who asked the agent
   *    to run may keep talking in that thread, and a delegated child's parent
   *    may still be running.
   *  - `gated` is EXCLUDED because it means oversight blocked OR PAUSED the run
   *    (migration 329). A paused run is not finished with its workspace.
   *  - A NULL outcome is still in flight.
   *  - `invocation_id` is text with no FK (migration 286) and holds composite
   *    handles for provisioning/sidecar/parity callers, so only uuid-shaped
   *    values can join and the rest are simply never fast-reaped. */
  async findFinishedAutonomous(): Promise<SandboxStateRecord[]> {
    const result = await pool.query(
      `SELECT s.* FROM sandbox_state s
         JOIN invocations i
           ON s.invocation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND i.id = s.invocation_id::uuid
        WHERE s.status NOT IN ('destroyed', 'error')
          AND i.triggered_by IN ('cron', 'event')
          AND i.outcome IS NOT NULL
          AND i.outcome <> 'gated'`,
    );
    return result.rows.map(r => this.mapRow(r));
  }

  /** Did this session ever have a sandbox that is now gone?
   *
   *  A resumed run gets a NEW workspace when its old one was reaped, and the
   *  files it wrote before pausing are not in it. Provisioning silently and
   *  handing back an empty directory is the failure that has no symptom: the
   *  agent reads its own missing output as "the work was never done" and starts
   *  again, or worse, as an empty result. Rows are never deleted — the GC sweep
   *  marks them 'destroyed' — so the history is right here to be asked. */
  async hadDestroyedSandbox(sessionId: string): Promise<boolean> {
    const r = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM sandbox_state
          WHERE session_id = $1 AND status IN ('destroyed', 'error')
       ) AS exists`,
      [sessionId],
    );
    return r.rows[0]?.exists === true;
  }

  async getBySession(sessionId: string): Promise<SandboxStateRecord | null> {
    const result = await pool.query(
      `SELECT * FROM sandbox_state WHERE session_id = $1 AND status NOT IN ('destroyed', 'error') LIMIT 1`,
      [sessionId],
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async getBySandboxId(sandboxId: string): Promise<SandboxStateRecord | null> {
    const result = await pool.query(
      `SELECT * FROM sandbox_state WHERE sandbox_id = $1 LIMIT 1`,
      [sandboxId],
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Find orphaned sandboxes: active but no heartbeat for > 2x the configured timeout.
   * Used by GC sweep.
   */
  async findOrphaned(maxHeartbeatAgeMs: number): Promise<SandboxStateRecord[]> {
    const result = await pool.query(
      `SELECT * FROM sandbox_state
       WHERE status NOT IN ('destroyed', 'error')
       AND last_heartbeat < NOW() - INTERVAL '1 millisecond' * $1`,
      [maxHeartbeatAgeMs],
    );
    return result.rows.map(r => this.mapRow(r));
  }

  /**
   * Filter a list of sandbox IDs down to those that have a row in
   * sandbox_state (in any status, including 'destroyed' and 'error').
   *
   * Used by gcSweep's Cloud Run orphan phase to decide which provider-side
   * services are NOT tracked by the platform — those are the orphans whose
   * create() threw before stateRepo.create() ran. Includes terminal-status
   * rows so we never re-attempt to destroy a service whose lifecycle the DB
   * has already concluded.
   */
  async findExisting(sandboxIds: string[]): Promise<string[]> {
    if (sandboxIds.length === 0) return [];
    const result = await pool.query<{ sandbox_id: string }>(
      'SELECT sandbox_id FROM sandbox_state WHERE sandbox_id = ANY($1::text[])',
      [sandboxIds],
    );
    return result.rows.map(r => r.sandbox_id);
  }

  /**
   * Count active sandboxes for a tenant (for admission control).
   */
  async countActive(tenantId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as cnt FROM sandbox_state
       WHERE tenant_id = $1 AND status NOT IN ('destroyed', 'error')`,
      [tenantId],
    );
    return parseInt(result.rows[0].cnt, 10);
  }

  private mapRow(row: Record<string, unknown>): SandboxStateRecord {
    return {
      sandboxId: row.sandbox_id as string,
      sessionId: row.session_id as string,
      tenantId: row.tenant_id as string,
      agentId: row.agent_id as string,
      invocationId: row.invocation_id as string,
      status: row.status as SandboxStatus,
      template: row.template as ExecutionEnvironmentType,
      createdAt: new Date(row.created_at as string),
      lastHeartbeat: new Date(row.last_heartbeat as string),
      destroyedAt: row.destroyed_at ? new Date(row.destroyed_at as string) : null,
      capabilities: (row.capabilities as Array<'shell' | 'file' | 'browser' | 'vscode'> | null) ?? undefined,
      jwtSecretEncrypted: (row.jwt_secret_encrypted as Buffer | null) ?? undefined,
      imageTag: (row.image_tag as string | null) ?? undefined,
      readyAt: row.ready_at ? new Date(row.ready_at as string) : null,
      mcpDispatchCounter: typeof row.mcp_dispatch_counter === 'number' ? row.mcp_dispatch_counter : undefined,
    };
  }
}
