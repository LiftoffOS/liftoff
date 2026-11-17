// Prompt Registry Repository
// Per Section 17: Prompt template versions
//
// RLS note: prompt_bundles / prompt_templates / prompt_rollouts are RLS-enabled
// (migration 200). This is an OPERATOR surface — the router mounts
// /api/prompt-registry behind Firebase auth + access-gate only, and the by-PK
// write/rollout endpoints carry no tenant context (see router.ts + service.ts
// signatures). So cross-tenant list-all reads and by-PK writes run under
// withAdminScope (BYPASSRLS); the tenant-scoped read/create paths that have a
// tenantId run under withTenantScope. The prompt_bundle_tenant_overrides /
// prompt_bundle_access_restrictions tables are NOT RLS-enabled, so those queries
// stay on the default pool.

import { getPool, withTenantScope, withAdminScope } from '../infrastructure/database';
import {
  PromptBundle,
  PromptTemplate,
  CreateBundleInput,
  CreateTemplateInput,
  PromptRollout,
  CreatePromptRolloutInput,
  PromptRolloutMetrics,
} from './types';

export class PromptBundleRepository {
  async findAll(): Promise<PromptBundle[]> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.bundle.findAll', reason: 'operator list-all bundles across tenants (no tenant filter)' },
      (client) => client.query(`SELECT * FROM prompt_bundles ORDER BY name, version DESC`),
    );
    return result.rows.map(this.mapBundleRow);
  }

  async findByTenantId(tenantId: string): Promise<PromptBundle[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM prompt_bundles WHERE tenant_id = $1 ORDER BY name, version DESC`,
      [tenantId],
    ));
    return result.rows.map(this.mapBundleRow);
  }

  async findById(id: string): Promise<PromptBundle | null> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.bundle.findById', reason: 'operator by-PK bundle lookup (no request tenant context)' },
      (client) => client.query(`SELECT * FROM prompt_bundles WHERE id = $1`, [id]),
    );
    return result.rows[0] ? this.mapBundleRow(result.rows[0]) : null;
  }

  async findByName(tenantId: string, name: string): Promise<PromptBundle[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM prompt_bundles WHERE tenant_id = $1 AND name = $2 ORDER BY version DESC`,
      [tenantId, name],
    ));
    return result.rows.map(this.mapBundleRow);
  }

  async findApproved(): Promise<PromptBundle[]> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.bundle.findApproved', reason: 'operator list-all approved bundles across tenants' },
      (client) => client.query(`SELECT * FROM prompt_bundles WHERE status = 'approved' ORDER BY name, version DESC`),
    );
    return result.rows.map(this.mapBundleRow);
  }

  async findApprovedByTenantId(tenantId: string): Promise<PromptBundle[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM prompt_bundles WHERE tenant_id = $1 AND status = 'approved' ORDER BY name, version DESC`,
      [tenantId],
    ));
    return result.rows.map(this.mapBundleRow);
  }

  async create(input: CreateBundleInput): Promise<PromptBundle> {
    return withTenantScope(input.tenantId, async (client) => {
      // Get next version for this bundle name within tenant
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM prompt_bundles WHERE tenant_id = $1 AND name = $2`,
        [input.tenantId, input.name],
      );
      const nextVersion = versionResult.rows[0].next_version;

      const result = await client.query(
        `INSERT INTO prompt_bundles (tenant_id, name, version, status, templates)
         VALUES ($1, $2, $3, 'draft', $4)
         RETURNING *`,
        [input.tenantId, input.name, nextVersion, JSON.stringify(input.templates)],
      );
      return this.mapBundleRow(result.rows[0]);
    });
  }

  async updateStatus(id: string, status: 'draft' | 'approved' | 'deprecated'): Promise<PromptBundle> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.bundle.updateStatus', reason: 'operator by-PK status change (no request tenant context)' },
      (client) => client.query(
        `UPDATE prompt_bundles
         SET status = $2, approved_at = ${status === 'approved' ? 'NOW()' : 'approved_at'}
         WHERE id = $1
         RETURNING *`,
        [id, status],
      ),
    );
    if (!result.rows[0]) {
      throw new Error(`Bundle not found: ${id}`);
    }
    return this.mapBundleRow(result.rows[0]);
  }

  async updateTemplates(id: string, templates: string[]): Promise<PromptBundle> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.bundle.updateTemplates', reason: 'operator by-PK templates update (no request tenant context)' },
      (client) => client.query(
        `UPDATE prompt_bundles
         SET templates = $2
         WHERE id = $1
         RETURNING *`,
        [id, JSON.stringify(templates)],
      ),
    );
    if (!result.rows[0]) {
      throw new Error(`Bundle not found: ${id}`);
    }
    return this.mapBundleRow(result.rows[0]);
  }

  // GAP-017 FIX: Tenant override methods.
  // prompt_bundle_tenant_overrides / prompt_bundle_access_restrictions are NOT
  // RLS-enabled — these queries stay on the default pool (no FORCE impact).
  async getTenantOverrides(tenantId: string): Promise<Array<{
    bundleId: string;
    settings: Record<string, unknown>;
  }>> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT bundle_id, settings FROM prompt_bundle_tenant_overrides
       WHERE tenant_id = $1 AND enabled = true`,
      [tenantId]
    );
    return result.rows.map(row => ({
      bundleId: row.bundle_id as string,
      settings: typeof row.settings === 'string'
        ? JSON.parse(row.settings)
        : row.settings as Record<string, unknown>,
    }));
  }

  async getTenantRestrictions(bundleId: string): Promise<string[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT tenant_id FROM prompt_bundle_access_restrictions WHERE bundle_id = $1`,
      [bundleId]
    );
    return result.rows.map(row => row.tenant_id as string);
  }

  async setTenantOverride(
    tenantId: string,
    bundleId: string,
    overrideData: {
      type: 'config' | 'variables' | 'disable';
      settings?: Record<string, unknown>;
      enabled?: boolean;
    }
  ): Promise<{ id: string; tenantId: string; bundleId: string; override: typeof overrideData }> {
    const pool = getPool();

    // Upsert the override
    const result = await pool.query(
      `INSERT INTO prompt_bundle_tenant_overrides (tenant_id, bundle_id, override_type, settings, enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, bundle_id)
       DO UPDATE SET override_type = $3, settings = $4, enabled = $5, updated_at = NOW()
       RETURNING id`,
      [
        tenantId,
        bundleId,
        overrideData.type,
        JSON.stringify(overrideData.settings || {}),
        overrideData.enabled !== false,
      ]
    );

    return {
      id: result.rows[0].id as string,
      tenantId,
      bundleId,
      override: overrideData,
    };
  }

  private mapBundleRow(row: Record<string, unknown>): PromptBundle {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      name: row.name as string,
      version: row.version as number,
      status: row.status as 'draft' | 'approved' | 'deprecated',
      templates: (row.templates as string[]) || [],
      createdAt: row.created_at as Date,
      approvedAt: row.approved_at as Date | null,
    };
  }
}

export class PromptTemplateRepository {
  async findAll(): Promise<PromptTemplate[]> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.template.findAll', reason: 'operator list-all templates across tenants (no tenant filter)' },
      (client) => client.query(`SELECT * FROM prompt_templates ORDER BY name, version DESC`),
    );
    return result.rows.map(this.mapTemplateRow);
  }

  async findByTenantId(tenantId: string): Promise<PromptTemplate[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM prompt_templates WHERE tenant_id = $1 ORDER BY name, version DESC`,
      [tenantId],
    ));
    return result.rows.map(this.mapTemplateRow);
  }

  async findById(id: string): Promise<PromptTemplate | null> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.template.findById', reason: 'operator by-PK template lookup (no request tenant context)' },
      (client) => client.query(`SELECT * FROM prompt_templates WHERE id = $1`, [id]),
    );
    return result.rows[0] ? this.mapTemplateRow(result.rows[0]) : null;
  }

  async findByName(tenantId: string, name: string): Promise<PromptTemplate[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM prompt_templates WHERE tenant_id = $1 AND name = $2 ORDER BY version DESC`,
      [tenantId, name],
    ));
    return result.rows.map(this.mapTemplateRow);
  }

  async create(input: CreateTemplateInput): Promise<PromptTemplate> {
    return withTenantScope(input.tenantId, async (client) => {
      // Get next version for this template name within tenant
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM prompt_templates WHERE tenant_id = $1 AND name = $2`,
        [input.tenantId, input.name],
      );
      const nextVersion = versionResult.rows[0].next_version;

      const result = await client.query(
        `INSERT INTO prompt_templates (tenant_id, name, version, content, variables)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [input.tenantId, input.name, nextVersion, input.content, JSON.stringify(input.variables)],
      );
      return this.mapTemplateRow(result.rows[0]);
    });
  }

  async update(id: string, content: string, variables: string[]): Promise<PromptTemplate> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.template.update', reason: 'operator by-PK template update (no request tenant context)' },
      (client) => client.query(
        `UPDATE prompt_templates
         SET content = $2, variables = $3, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, content, JSON.stringify(variables)],
      ),
    );
    if (!result.rows[0]) {
      throw new Error(`Template not found: ${id}`);
    }
    return this.mapTemplateRow(result.rows[0]);
  }

  private mapTemplateRow(row: Record<string, unknown>): PromptTemplate {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      name: row.name as string,
      version: row.version as number,
      content: row.content as string,
      variables: (row.variables as string[]) || [],
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}

// Per Section 15: Prompt Rollout Repository
export class PromptRolloutRepository {
  async findAll(tenantId?: string): Promise<PromptRollout[]> {
    let query = `SELECT * FROM prompt_rollouts`;
    const params: string[] = [];

    if (tenantId) {
      query += ` WHERE tenant_id = $1`;
      params.push(tenantId);
    }

    query += ` ORDER BY created_at DESC`;
    const result = tenantId
      ? await withTenantScope(tenantId, (client) => client.query(query, params))
      : await withAdminScope(
          { caller: 'prompt-registry.rollout.findAll', reason: 'operator list-all rollouts across tenants (no tenant filter)' },
          (client) => client.query(query, params),
        );
    return result.rows.map(this.mapRolloutRow);
  }

  async findById(id: string): Promise<PromptRollout | null> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.rollout.findById', reason: 'operator by-PK rollout lookup (no request tenant context)' },
      (client) => client.query(`SELECT * FROM prompt_rollouts WHERE id = $1`, [id]),
    );
    return result.rows[0] ? this.mapRolloutRow(result.rows[0]) : null;
  }

  async findPending(tenantId?: string): Promise<PromptRollout[]> {
    let query = `SELECT * FROM prompt_rollouts WHERE status = 'pending'`;
    const params: string[] = [];

    if (tenantId) {
      query += ` AND tenant_id = $1`;
      params.push(tenantId);
    }

    query += ` ORDER BY created_at ASC`;
    const result = tenantId
      ? await withTenantScope(tenantId, (client) => client.query(query, params))
      : await withAdminScope(
          { caller: 'prompt-registry.rollout.findPending', reason: 'operator cross-tenant pending-rollout scan (no tenant filter)' },
          (client) => client.query(query, params),
        );
    return result.rows.map(this.mapRolloutRow);
  }

  async findInProgress(tenantId?: string): Promise<PromptRollout[]> {
    let query = `SELECT * FROM prompt_rollouts WHERE status = 'in_progress'`;
    const params: string[] = [];

    if (tenantId) {
      query += ` AND tenant_id = $1`;
      params.push(tenantId);
    }

    query += ` ORDER BY started_at ASC`;
    const result = tenantId
      ? await withTenantScope(tenantId, (client) => client.query(query, params))
      : await withAdminScope(
          { caller: 'prompt-registry.rollout.findInProgress', reason: 'operator cross-tenant in-progress-rollout scan (no tenant filter)' },
          (client) => client.query(query, params),
        );
    return result.rows.map(this.mapRolloutRow);
  }

  async create(input: CreatePromptRolloutInput): Promise<PromptRollout> {
    return withTenantScope(input.tenantId, async (client) => {
      // Get current active bundle for this tenant to track as previous
      const currentResult = await client.query(
        `SELECT pb.id FROM prompt_bundles pb
         WHERE pb.tenant_id = $1 AND pb.status = 'approved'
         ORDER BY pb.version DESC LIMIT 1`,
        [input.tenantId],
      );
      const previousBundleId = currentResult.rows[0]?.id || null;

      const result = await client.query(
        `INSERT INTO prompt_rollouts
         (tenant_id, bundle_id, previous_bundle_id, status, strategy, config, requested_by)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6)
         RETURNING *`,
        [
          input.tenantId,
          input.bundleId,
          previousBundleId,
          input.strategy,
          JSON.stringify(input.config),
          input.requestedBy,
        ],
      );

      return this.mapRolloutRow(result.rows[0]);
    });
  }

  async approve(id: string, approvedBy: string): Promise<PromptRollout> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.rollout.approve', reason: 'operator by-PK rollout approval (no request tenant context)' },
      (client) => client.query(
        `UPDATE prompt_rollouts
         SET status = 'approved', approved_by = $2, approved_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id, approvedBy],
      ),
    );

    if (!result.rows[0]) {
      throw new Error(`Rollout ${id} not found or not pending`);
    }

    return this.mapRolloutRow(result.rows[0]);
  }

  async reject(id: string, rejectedBy: string, reason: string): Promise<PromptRollout> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.rollout.reject', reason: 'operator by-PK rollout rejection (no request tenant context)' },
      (client) => client.query(
        `UPDATE prompt_rollouts
         SET status = 'rejected', rejected_by = $2, rejected_at = NOW(), rejection_reason = $3
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id, rejectedBy, reason],
      ),
    );

    if (!result.rows[0]) {
      throw new Error(`Rollout ${id} not found or not pending`);
    }

    return this.mapRolloutRow(result.rows[0]);
  }

  async startRollout(id: string): Promise<PromptRollout> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.rollout.startRollout', reason: 'operator by-PK rollout start (no request tenant context)' },
      (client) => client.query(
        `UPDATE prompt_rollouts
         SET status = 'in_progress', started_at = NOW()
         WHERE id = $1 AND status = 'approved'
         RETURNING *`,
        [id],
      ),
    );

    if (!result.rows[0]) {
      throw new Error(`Rollout ${id} not found or not approved`);
    }

    return this.mapRolloutRow(result.rows[0]);
  }

  async completeRollout(id: string): Promise<PromptRollout> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.rollout.completeRollout', reason: 'operator by-PK rollout completion (no request tenant context)' },
      (client) => client.query(
        `UPDATE prompt_rollouts
         SET status = 'completed', completed_at = NOW(), current_percentage = 100
         WHERE id = $1 AND status IN ('approved', 'in_progress')
         RETURNING *`,
        [id],
      ),
    );

    if (!result.rows[0]) {
      throw new Error(`Rollout ${id} not found or not in valid state`);
    }

    return this.mapRolloutRow(result.rows[0]);
  }

  async rollback(id: string, reason: string): Promise<PromptRollout> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.rollout.rollback', reason: 'operator by-PK rollout rollback (no request tenant context)' },
      (client) => client.query(
        `UPDATE prompt_rollouts
         SET status = 'rolled_back', rollbacked_at = NOW(), rollback_reason = $2
         WHERE id = $1 AND status IN ('in_progress', 'completed')
         RETURNING *`,
        [id, reason],
      ),
    );

    if (!result.rows[0]) {
      throw new Error(`Rollout ${id} not found or not in valid state`);
    }

    return this.mapRolloutRow(result.rows[0]);
  }

  async updateMetrics(id: string, metrics: PromptRolloutMetrics): Promise<void> {
    await withAdminScope(
      { caller: 'prompt-registry.rollout.updateMetrics', reason: 'operator by-PK rollout metrics update (no request tenant context)' },
      (client) => client.query(
        `UPDATE prompt_rollouts SET metrics = $2 WHERE id = $1`,
        [id, JSON.stringify(metrics)],
      ),
    );
  }

  async advanceStep(id: string, newPercentage: number, nextStepAt: Date | null): Promise<PromptRollout> {
    const result = await withAdminScope(
      { caller: 'prompt-registry.rollout.advanceStep', reason: 'operator by-PK rollout step advance (no request tenant context)' },
      (client) => client.query(
        `UPDATE prompt_rollouts
         SET current_step = current_step + 1, current_percentage = $2, next_step_at = $3
         WHERE id = $1
         RETURNING *`,
        [id, newPercentage, nextStepAt],
      ),
    );

    if (!result.rows[0]) {
      throw new Error(`Rollout ${id} not found`);
    }

    return this.mapRolloutRow(result.rows[0]);
  }

  private mapRolloutRow(row: Record<string, unknown>): PromptRollout {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    const metrics = typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics;

    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      bundleId: row.bundle_id as string,
      previousBundleId: row.previous_bundle_id as string | null,
      version: row.version as number,
      status: row.status as PromptRollout['status'],
      strategy: row.strategy as PromptRollout['strategy'],
      config: config || { healthCheckEnabled: false, notifyOnApproval: [], notifyOnFailure: [] },
      requestedBy: row.requested_by as string,
      requestedAt: row.requested_at as Date,
      approvedBy: row.approved_by as string | null,
      approvedAt: row.approved_at as Date | null,
      rejectedBy: row.rejected_by as string | null,
      rejectedAt: row.rejected_at as Date | null,
      rejectionReason: row.rejection_reason as string | null,
      startedAt: row.started_at as Date | null,
      completedAt: row.completed_at as Date | null,
      rollbackedAt: row.rollbacked_at as Date | null,
      rollbackReason: row.rollback_reason as string | null,
      currentStep: row.current_step as number,
      currentPercentage: row.current_percentage as number,
      nextStepAt: row.next_step_at as Date | null,
      metrics: metrics || {
        requestsTotal: 0,
        requestsSuccess: 0,
        requestsFailed: 0,
        averageLatencyMs: 0,
        p99LatencyMs: 0,
        errorRate: 0,
      },
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
