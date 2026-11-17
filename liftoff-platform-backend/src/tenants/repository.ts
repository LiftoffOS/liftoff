// Tenant Repository
// Per Section 1: Control plane owns tenant provisioning

import type { PoolClient } from 'pg';
import { getPool } from '../infrastructure/database';
import { Tenant, TenantTier, HostingMode, ProvisionTenantInput, MigrationStatus, MigrationHistoryEntry, OnboardingProgressUpdate, OnboardingPath, OnboardingStepId } from './types';
import { assertGcpProjectIdMatchesEnv } from './validate-gcp-project-id';

export class TenantRepository {
  async create(input: ProvisionTenantInput): Promise<Tenant> {
    const pool = getPool();
    return this.insertRow(pool, input);
  }

  // Transaction-scoped variant for use inside withAdminScope BEGIN/COMMIT.
  // TenantService.provision wraps this + members + entitlements in one tx
  // so a failure in any step rolls back the others (no orphan tenants).
  async createInTx(client: PoolClient, input: ProvisionTenantInput): Promise<Tenant> {
    return this.insertRow(client, input);
  }

  private async insertRow(
    runner: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
    input: ProvisionTenantInput,
  ): Promise<Tenant> {
    // tier defaults to 'standard'; hosting_mode is INDEPENDENT of tier — it
    // always defaults to 'shared' on signup. Dedicated hosting is a manual
    // post-creation upgrade via POST /api/admin/tenants/:id/upgrade-to-dedicated.
    // Stripe billing tier (Stripe plan) is also independent — it's tracked on
    // billing_controls / subscriptions, not here.
    const tier = input.tier || 'standard';
    const hostingMode: HostingMode = input.hostingMode || 'shared';
    const onboardingPath: OnboardingPath | null = input.onboardingPath ?? null;
    const result = await runner.query(
      `INSERT INTO tenants (account_id, name, tier, hosting_mode, status, migration_status, onboarding_path)
       VALUES ($1, $2, $3, $4, 'pending', 'pending', $5)
       RETURNING *`,
      [input.accountId, input.name, tier, hostingMode, onboardingPath],
    );
    return this.mapRow(result.rows[0] as Record<string, unknown>);
  }

  async findById(id: string): Promise<Tenant | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM tenants WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByGcpProjectId(gcpProjectId: string): Promise<Tenant | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM tenants WHERE gcp_project_id = $1 LIMIT 1`,
      [gcpProjectId]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByAccountId(accountId: string): Promise<Tenant[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM tenants WHERE account_id = $1 ORDER BY created_at DESC`,
      [accountId]
    );
    return result.rows.map(this.mapRow);
  }

  async findAll(): Promise<Tenant[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM tenants ORDER BY created_at DESC`
    );
    return result.rows.map(this.mapRow);
  }

  async updateStatus(id: string, status: 'pending' | 'active' | 'suspended'): Promise<Tenant> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE tenants SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, status]
    );
    if (!result.rows[0]) {
      throw new Error(`Tenant not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async updateMigrationStatus(id: string, status: 'pending' | 'in_progress' | 'completed' | 'failed'): Promise<Tenant> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE tenants SET migration_status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, status]
    );
    if (!result.rows[0]) {
      throw new Error(`Tenant not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async updateGcpProject(id: string, gcpProjectId: string, databaseName: string): Promise<Tenant> {
    assertGcpProjectIdMatchesEnv(gcpProjectId);
    const pool = getPool();
    const result = await pool.query(
      `UPDATE tenants SET gcp_project_id = $2, database_name = $3, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, gcpProjectId, databaseName]
    );
    if (!result.rows[0]) {
      throw new Error(`Tenant not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async updateRuntimeUrl(id: string, runtimeUrl: string): Promise<Tenant> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE tenants SET runtime_url = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, runtimeUrl],
    );
    if (!result.rows[0]) {
      throw new Error(`Tenant not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async markHasCreatedInternalAgent(id: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE tenants SET has_created_internal_agent = TRUE, updated_at = NOW() WHERE id = $1 AND has_created_internal_agent = FALSE`,
      [id]
    );
  }

  async updateName(id: string, name: string): Promise<Tenant> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE tenants SET name = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, name]
    );
    if (!result.rows[0]) {
      throw new Error(`Tenant not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async updateOnboardingProgress(
    id: string,
    fields: OnboardingProgressUpdate,
  ): Promise<Tenant> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    let n = 1;

    if (fields.step !== undefined) {
      n++;
      sets.push(`onboarding_step = $${n}`);
      params.push(fields.step);
    }
    if (fields.persona !== undefined) {
      n++;
      sets.push(`onboarding_persona = $${n}`);
      params.push(fields.persona);
    }
    if (fields.completed === true) {
      sets.push(`onboarding_completed_at = COALESCE(onboarding_completed_at, NOW())`);
    } else if (fields.completed === false) {
      sets.push(`onboarding_completed_at = NULL`);
    }
    // Fused-onboarding fields (migration 260)
    if (fields.onboardingPath !== undefined) {
      n++;
      sets.push(`onboarding_path = $${n}`);
      params.push(fields.onboardingPath);
    }
    if (fields.onboardingStepId !== undefined) {
      n++;
      sets.push(`onboarding_step_id = $${n}`);
      params.push(fields.onboardingStepId);
    }
    // The onboarding_hire_input / onboarding_hire_chosen_status writes that
    // lived here are gone (ADR-050): the first hire left onboarding, so nothing
    // carries it across the payment boundary any more. Removed ahead of the
    // migration that drops those columns — a writer surviving into that deploy
    // would 42703 while the previous revision is still serving.

    if (sets.length === 0) {
      // Nothing to update — return current row so callers don't have to special-case.
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Tenant not found: ${id}`);
      return existing;
    }

    sets.push(`updated_at = NOW()`);
    const pool = getPool();
    const result = await pool.query(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    if (!result.rows[0]) {
      throw new Error(`Tenant not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  // updateFullDistillStatus lived here: the writer for the three
  // onboarding_full_distill_* columns, driven by the deferred post-payment
  // distill. Both its callers (the restart endpoint and the worker) are gone
  // with the in-onboarding hire (ADR-050), and the columns are dropped in the
  // follow-up release.


  async getMigrationStatus(tenantId: string): Promise<MigrationStatus | null> {
    const pool = getPool();

    // First get the tenant's basic migration status
    const tenantResult = await pool.query(
      `SELECT id, migration_status FROM tenants WHERE id = $1`,
      [tenantId]
    );

    if (!tenantResult.rows[0]) {
      return null;
    }

    // Get detailed migration status from migration_jobs table if exists
    const migrationResult = await pool.query(
      `SELECT
         tenant_id,
         status,
         progress_percentage,
         started_at,
         completed_at,
         current_step,
         total_steps,
         completed_steps,
         error_message
       FROM migration_jobs
       WHERE tenant_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [tenantId]
    );

    if (migrationResult.rows[0]) {
      return this.mapMigrationStatusRow(migrationResult.rows[0]);
    }

    // Return basic status from tenant if no detailed migration job exists
    return {
      tenant_id: tenantId,
      status: tenantResult.rows[0].migration_status,
      progress_percentage: tenantResult.rows[0].migration_status === 'completed' ? 100 : 0,
      started_at: null,
      completed_at: null,
      current_step: null,
      total_steps: 0,
      completed_steps: 0,
      error_message: null,
    };
  }

  async getMigrationHistory(tenantId: string): Promise<MigrationHistoryEntry[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT
         id,
         tenant_id,
         from_version,
         to_version,
         status,
         started_at,
         completed_at,
         duration_ms,
         records_migrated,
         error_message
       FROM migration_history
       WHERE tenant_id = $1
       ORDER BY started_at DESC
       LIMIT 50`,
      [tenantId]
    );
    return result.rows.map(this.mapMigrationHistoryRow);
  }

  private mapRow(row: Record<string, unknown>): Tenant {
    return {
      id: row.id as string,
      accountId: row.account_id as string,
      name: row.name as string,
      tier: (row.tier as TenantTier) || 'standard',
      hostingMode: (row.hosting_mode as HostingMode) || 'shared',
      status: row.status as 'pending' | 'active' | 'suspended',
      gcpProjectId: row.gcp_project_id as string | null,
      databaseName: row.database_name as string | null,
      runtimeUrl: (row.runtime_url as string) || null,
      migrationStatus: row.migration_status as 'pending' | 'in_progress' | 'completed' | 'failed',
      hasCreatedInternalAgent: row.has_created_internal_agent as boolean,
      harvestEnabled: row.harvest_enabled as boolean,
      onboardingStep: (row.onboarding_step as number) ?? 0,
      onboardingPersona: (row.onboarding_persona as string | null) ?? null,
      onboardingCompletedAt: (row.onboarding_completed_at as Date | null) ?? null,
      // Fused-onboarding fields (migration 260). The hire_input / chosen_status
      // / full_distill_* mappings are gone with the in-onboarding hire
      // (ADR-050); their columns are dropped in the follow-up release.
      onboardingPath: (row.onboarding_path as OnboardingPath | null) ?? null,
      onboardingStepId: (row.onboarding_step_id as OnboardingStepId | null) ?? null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }

  private mapMigrationStatusRow(row: Record<string, unknown>): MigrationStatus {
    return {
      tenant_id: row.tenant_id as string,
      status: row.status as 'pending' | 'in_progress' | 'completed' | 'failed',
      progress_percentage: row.progress_percentage as number,
      started_at: row.started_at as Date | null,
      completed_at: row.completed_at as Date | null,
      current_step: row.current_step as string | null,
      total_steps: row.total_steps as number,
      completed_steps: row.completed_steps as number,
      error_message: row.error_message as string | null,
    };
  }

  private mapMigrationHistoryRow(row: Record<string, unknown>): MigrationHistoryEntry {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      from_version: row.from_version as string,
      to_version: row.to_version as string,
      status: row.status as 'completed' | 'failed' | 'rolled_back',
      started_at: row.started_at as Date,
      completed_at: row.completed_at as Date | null,
      duration_ms: row.duration_ms as number | null,
      records_migrated: row.records_migrated as number,
      error_message: row.error_message as string | null,
    };
  }
}
