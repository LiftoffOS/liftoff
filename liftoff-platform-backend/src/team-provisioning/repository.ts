// Team-preset provisioning — durable state store.
//
// Three tenant-scoped, FORCE-RLS tables (migration 299): the run (idempotency +
// lease + terminal status), per-role progress (crash-safe resume), and agent
// provenance (the crash-safe create key — existence per (run_id, role_key)). All
// access goes through withTenantScope so RLS is satisfied.

import type { PoolClient } from 'pg';
import { armStrandedProvisioningSweep } from '../jobs/maintenance-targets';
import { withTenantScope } from '../infrastructure/database';

export type RunStatus = 'pending' | 'completed' | 'compensated' | 'failed';
export type RoleStatus = 'pending' | 'creating' | 'created' | 'failed' | 'compensated';

export interface ProvisioningRun {
  id: string;
  tenantId: string;
  presetId: string;
  idempotencyKey: string;
  requestHash: string;
  status: RunStatus;
  createdAgentIds: string[];
  workforcePlanId: string | null;
  error: string | null;
  lockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunRole {
  runId: string;
  roleKey: string;
  agentId: string;
  status: RoleStatus;
  error: string | null;
}

function mapRun(r: Record<string, unknown>): ProvisioningRun {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    presetId: r.preset_id as string,
    idempotencyKey: r.idempotency_key as string,
    requestHash: r.request_hash as string,
    status: r.status as RunStatus,
    createdAgentIds: (r.created_agent_ids as string[]) ?? [],
    workforcePlanId: (r.workforce_plan_id as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    lockedAt: (r.locked_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

export class TeamProvisioningRepository {
  /** Look up a run by its tenant-scoped idempotency key. */
  async findRun(tenantId: string, idempotencyKey: string): Promise<ProvisioningRun | null> {
    return withTenantScope(tenantId, async (c) => {
      const r = await c.query(
        `SELECT * FROM team_provisioning_runs WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      return r.rows[0] ? mapRun(r.rows[0]) : null;
    });
  }

  /** Insert a new pending run with a fresh lease. Relies on the UNIQUE(tenant_id,
   *  idempotency_key) to make concurrent creates race-safe (ON CONFLICT returns the
   *  existing row so the caller can apply retry semantics). */
  async createRun(input: {
    tenantId: string;
    presetId: string;
    idempotencyKey: string;
    requestHash: string;
    workforcePlanId: string | null;
  }): Promise<{ run: ProvisioningRun; created: boolean }> {
    return withTenantScope(input.tenantId, async (c) => {
      const r = await c.query(
        `INSERT INTO team_provisioning_runs
           (tenant_id, preset_id, idempotency_key, request_hash, status, workforce_plan_id, locked_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, now())
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [input.tenantId, input.presetId, input.idempotencyKey, input.requestHash, input.workforcePlanId],
      );
      if (r.rows[0]) {
        // The sweep that rolls back a run still pending after 30 minutes.
        armStrandedProvisioningSweep();
        return { run: mapRun(r.rows[0]), created: true };
      }
      const existing = await c.query(
        `SELECT * FROM team_provisioning_runs WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey],
      );
      return { run: mapRun(existing.rows[0]), created: false };
    });
  }

  /** Reclaim a pending run whose lease is stale (worker died). Refreshes locked_at
   *  atomically; returns the run only if the reclaim won the race. */
  async reclaimStaleLease(tenantId: string, runId: string, staleAfterMs: number): Promise<ProvisioningRun | null> {
    return withTenantScope(tenantId, async (c) => {
      const r = await c.query(
        `UPDATE team_provisioning_runs
            SET locked_at = now(), updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
            AND (locked_at IS NULL OR locked_at < now() - ($3::int * INTERVAL '1 millisecond'))
          RETURNING *`,
        [runId, tenantId, staleAfterMs],
      );
      return r.rows[0] ? mapRun(r.rows[0]) : null;
    });
  }

  /** Flip a terminal-but-fixable run (failed / compensated) back to pending with a fresh
   *  lease and cleared error, so a retry re-validates against LIVE tenant data — the
   *  reconciler then converges once whatever caused the failure (e.g. a connector scope
   *  recorded after the first attempt) is corrected, instead of replaying the first error
   *  forever. Atomic; returns the run only if it was actually in a retryable terminal state
   *  (a 'completed' run, or one a concurrent caller already reclaimed, yields null). */
  async reclaimForRetry(tenantId: string, runId: string): Promise<ProvisioningRun | null> {
    return withTenantScope(tenantId, async (c) => {
      const r = await c.query(
        `UPDATE team_provisioning_runs
            SET status = 'pending', locked_at = now(), error = NULL, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status IN ('failed', 'compensated')
          RETURNING *`,
        [runId, tenantId],
      );
      return r.rows[0] ? mapRun(r.rows[0]) : null;
    });
  }

  async setRunStatus(
    tenantId: string,
    runId: string,
    status: RunStatus,
    fields?: { error?: string | null; createdAgentIds?: string[] },
  ): Promise<void> {
    await withTenantScope(tenantId, async (c) => {
      await c.query(
        `UPDATE team_provisioning_runs
            SET status = $3,
                error = COALESCE($4, error),
                created_agent_ids = COALESCE($5, created_agent_ids),
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [runId, tenantId, status, fields?.error ?? null, fields?.createdAgentIds ?? null],
      );
    });
  }

  async listRunRoles(tenantId: string, runId: string): Promise<RunRole[]> {
    return withTenantScope(tenantId, async (c) => {
      const r = await c.query(
        `SELECT run_id, role_key, agent_id, status, error FROM team_provisioning_run_roles WHERE run_id = $1 AND tenant_id = $2`,
        [runId, tenantId],
      );
      return r.rows.map((row) => ({
        runId: row.run_id as string,
        roleKey: row.role_key as string,
        agentId: row.agent_id as string,
        status: row.status as RoleStatus,
        error: (row.error as string | null) ?? null,
      }));
    });
  }

  async upsertRunRole(
    tenantId: string,
    input: { runId: string; roleKey: string; agentId: string; status: RoleStatus; error?: string | null },
  ): Promise<void> {
    await withTenantScope(tenantId, async (c) => {
      await c.query(
        `INSERT INTO team_provisioning_run_roles (run_id, tenant_id, role_key, agent_id, status, error)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (run_id, role_key) DO UPDATE
           SET agent_id = EXCLUDED.agent_id, status = EXCLUDED.status, error = EXCLUDED.error, updated_at = now()`,
        [input.runId, tenantId, input.roleKey, input.agentId, input.status, input.error ?? null],
      );
    });
  }

  /** The crash-safe create key: does an agent already exist for (run_id, role_key)?
   *  Returns its agent_id if so. Run inside the caller's transaction so the
   *  check-then-create is atomic with the agent+provenance insert. */
  async findProvenanceInTx(client: PoolClient, tenantId: string, runId: string, roleKey: string): Promise<string | null> {
    const r = await client.query(
      `SELECT agent_id FROM internal_agent_provenance
        WHERE tenant_id = $1 AND provisioning_run_id = $2 AND role_key = $3 LIMIT 1`,
      [tenantId, runId, roleKey],
    );
    return r.rows[0] ? (r.rows[0].agent_id as string) : null;
  }

  /** EVERY agent stamped for this run, keyed by role. The authoritative record of what was
   *  created — compensation deletes by THIS, not by run-role agent_id, so an agent stamped
   *  before its run-role reached 'created' (a crash between the agent insert and the mark) is
   *  never orphaned. */
  async listProvenanceAgents(tenantId: string, runId: string): Promise<Array<{ agentId: string; roleKey: string }>> {
    return withTenantScope(tenantId, async (c) => {
      const r = await c.query(
        `SELECT agent_id, role_key FROM internal_agent_provenance
          WHERE tenant_id = $1 AND provisioning_run_id = $2`,
        [tenantId, runId],
      );
      return r.rows.map((row) => ({ agentId: row.agent_id as string, roleKey: row.role_key as string }));
    });
  }

  /** Stamp provenance in the SAME transaction as the agent-row insert. */
  async insertProvenanceInTx(
    client: PoolClient,
    input: { agentId: string; tenantId: string; provisioningRunId: string; roleKey: string; workforcePlanId: string | null },
  ): Promise<void> {
    await client.query(
      `INSERT INTO internal_agent_provenance (agent_id, tenant_id, provisioning_run_id, role_key, workforce_plan_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id) DO NOTHING`,
      [input.agentId, input.tenantId, input.provisioningRunId, input.roleKey, input.workforcePlanId],
    );
  }

  /** Runs stuck 'pending' past the terminal deadline with no live lease — the sweep
   *  compensates these. Cross-run within a tenant, so scoped per tenant by the caller. */
  async findStrandedRuns(tenantId: string, terminalDeadlineMs: number): Promise<ProvisioningRun[]> {
    return withTenantScope(tenantId, async (c) => {
      const r = await c.query(
        `SELECT * FROM team_provisioning_runs
          WHERE tenant_id = $1 AND status = 'pending'
            AND created_at < now() - ($2::int * INTERVAL '1 millisecond')`,
        [tenantId, terminalDeadlineMs],
      );
      return r.rows.map(mapRun);
    });
  }
}

export const teamProvisioningRepository = new TeamProvisioningRepository();
