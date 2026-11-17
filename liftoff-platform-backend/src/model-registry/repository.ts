// Model Registry Repository
// Per Section 17: LLM management
//
// RLS note (FORCE census): `models` is a GLOBAL, non-RLS model catalog → stays
// on the default pool. `model_configs` and `model_rollouts` are RLS-enabled.
// model_configs is per-tenant (every method has tenantId → withTenantScope).
// model_rollouts is an operator surface for the by-PK approval workflow (no
// tenant context on updateStatus/approve/... → withAdminScope); tenantId-bearing
// reads/create use withTenantScope; optional-tenantId lists branch.

import { getPool, withTenantScope, withAdminScope } from '../infrastructure/database';
import { resetVisionCache } from '../llm/vision';
import {
  Model,
  ModelConfig,
  ModelTier,
  RegisterModelInput,
  RoutingPolicy,
  normalizePolicyTiers,
  ModelRollout,
  RolloutStatus,
  RolloutConfig,
  RolloutMetrics,
  CreateRolloutInput,
} from './types';
import { randomUUID } from 'crypto';

export class ModelRepository {
  // `models` is a global, non-RLS catalog — no tenant scope needed.
  async findAll(): Promise<Model[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM models ORDER BY name`
    );
    return result.rows.map(this.mapModelRow);
  }

  async findApproved(): Promise<Model[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM models WHERE status = 'approved' ORDER BY name`
    );
    return result.rows.map(this.mapModelRow);
  }

  async findById(id: string): Promise<Model | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM models WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapModelRow(result.rows[0]) : null;
  }

  async create(input: RegisterModelInput): Promise<Model> {
    // A newly registered model's capabilities are read by the vision gate,
    // which caches them for a minute. Dropping the cache here means a model
    // registered with `vision` can see a picture on the next turn rather than
    // on the next minute — and, more importantly, that a model registered
    // WITHOUT it is never briefly believed to have it.
    resetVisionCache();
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO models (name, provider, model_id, tier, capabilities, context_window)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.name, input.provider, input.modelId, input.tier ?? null, JSON.stringify(input.capabilities),
       input.contextWindow ?? null]
    );
    return this.mapModelRow(result.rows[0]);
  }

  /** Whether `model_pricing` publishes a rate for this model.
   *
   *  The DB half of the approval gate; `hasStaticRate` in llm/pricing.ts is the
   *  code half. Keyed (provider, model_id) — the bare-model-id fallback
   *  `pricingKeysFor` also returns only ever matches the STATIC table, because
   *  every row here carries a provider.
   *
   *  `model_pricing` is a global rate table, not RLS — no tenant scope. */
  async hasSyncedRate(provider: string, modelId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM model_pricing WHERE provider = $1 AND model_id = $2 LIMIT 1`,
      [provider, modelId],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async updateStatus(id: string, status: 'approved' | 'deprecated' | 'disabled'): Promise<Model> {
    // The vision gate only counts APPROVED models, so a status change moves a
    // model in or out of its answer. Same invalidation as create.
    resetVisionCache();
    const pool = getPool();
    const result = await pool.query(
      `UPDATE models SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, status]
    );
    return this.mapModelRow(result.rows[0]);
  }

  /** Record (or clear, with null) a model's context window.
   *
   *  Without this the column was settable on INSERT only, so every model
   *  registered before it existed stayed NULL with no way to correct it — and a
   *  NULL window is read as a provider floor, which may never drive a
   *  destructive decision in the runtime. The whole per-model window path was
   *  therefore inert for the entire approved catalog. */
  async updateContextWindow(id: string, contextWindow: number | null): Promise<Model | null> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE models SET context_window = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, contextWindow]
    );
    return result.rows[0] ? this.mapModelRow(result.rows[0]) : null;
  }

  async findByTierAndProvider(tier: ModelTier, provider: string): Promise<Model | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM models WHERE tier = $1 AND provider = $2 AND status = 'approved' ORDER BY created_at DESC LIMIT 1`,
      [tier, provider]
    );
    return result.rows[0] ? this.mapModelRow(result.rows[0]) : null;
  }

  private mapModelRow(row: Record<string, unknown>): Model {
    return {
      id: row.id as string,
      name: row.name as string,
      provider: row.provider as Model['provider'],
      modelId: row.model_id as string,
      tier: (row.tier as ModelTier) || undefined,
      // NULL stays undefined rather than becoming a number: "not recorded" and
      // "recorded as N" are different facts and consumers act on them differently.
      contextWindow: row.context_window == null ? undefined : Number(row.context_window),
      status: row.status as 'approved' | 'deprecated' | 'disabled',
      capabilities: (row.capabilities as string[]) || [],
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}

export class ModelConfigRepository {
  async findByTenantId(tenantId: string): Promise<ModelConfig[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT mc.*, m.name as model_name, m.provider
       FROM model_configs mc
       JOIN models m ON mc.model_id = m.id
       WHERE mc.tenant_id = $1`,
      [tenantId]
    ));
    return result.rows.map(this.mapConfigRow);
  }

  async findByTenantAndModel(tenantId: string, modelId: string): Promise<ModelConfig | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM model_configs WHERE tenant_id = $1 AND model_id = $2`,
      [tenantId, modelId]
    ));
    return result.rows[0] ? this.mapConfigRow(result.rows[0]) : null;
  }

  async upsert(tenantId: string, modelId: string, routingPolicy: RoutingPolicy): Promise<ModelConfig> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `INSERT INTO model_configs (tenant_id, model_id, routing_policy)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, model_id)
       DO UPDATE SET
         routing_policy = $3,
         version = model_configs.version + 1,
         updated_at = NOW()
       RETURNING *`,
      [tenantId, modelId, JSON.stringify(routingPolicy)]
    ));
    return this.mapConfigRow(result.rows[0]);
  }

  async delete(tenantId: string, modelId: string): Promise<void> {
    await withTenantScope(tenantId, (client) => client.query(
      `DELETE FROM model_configs WHERE tenant_id = $1 AND model_id = $2`,
      [tenantId, modelId]
    ));
  }

  private mapConfigRow(row: Record<string, unknown>): ModelConfig {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      modelId: row.model_id as string,
      version: row.version as number,
      routingPolicy: normalizePolicyTiers((row.routing_policy as RoutingPolicy) || { defaultModel: '', taskOverrides: {} }),
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}

// Per Section 17: Model Rollout Repository for approval workflows
export class ModelRolloutRepository {
  async findAll(tenantId?: string): Promise<ModelRollout[]> {
    let query = `SELECT * FROM model_rollouts`;
    const params: string[] = [];

    if (tenantId) {
      query += ` WHERE tenant_id = $1`;
      params.push(tenantId);
    }

    query += ` ORDER BY created_at DESC`;

    const result = tenantId
      ? await withTenantScope(tenantId, (client) => client.query(query, params))
      : await withAdminScope(
          { caller: 'model-registry.rollout.findAll', reason: 'operator list-all model rollouts across tenants (no tenant filter)' },
          (client) => client.query(query, params),
        );
    return result.rows.map(this.mapRolloutRow);
  }

  async findById(id: string): Promise<ModelRollout | null> {
    const result = await withAdminScope(
      { caller: 'model-registry.rollout.findById', reason: 'operator by-PK model rollout lookup (no tenant context)' },
      (client) => client.query(`SELECT * FROM model_rollouts WHERE id = $1`, [id]),
    );
    return result.rows[0] ? this.mapRolloutRow(result.rows[0]) : null;
  }

  async findPending(tenantId?: string): Promise<ModelRollout[]> {
    let query = `SELECT * FROM model_rollouts WHERE status = 'pending'`;
    const params: string[] = [];

    if (tenantId) {
      query += ` AND tenant_id = $1`;
      params.push(tenantId);
    }

    query += ` ORDER BY created_at ASC`;

    const result = tenantId
      ? await withTenantScope(tenantId, (client) => client.query(query, params))
      : await withAdminScope(
          { caller: 'model-registry.rollout.findPending', reason: 'operator cross-tenant pending model-rollout scan (no tenant filter)' },
          (client) => client.query(query, params),
        );
    return result.rows.map(this.mapRolloutRow);
  }

  async findInProgress(tenantId?: string): Promise<ModelRollout[]> {
    let query = `SELECT * FROM model_rollouts WHERE status = 'in_progress'`;
    const params: string[] = [];

    if (tenantId) {
      query += ` AND tenant_id = $1`;
      params.push(tenantId);
    }

    const result = tenantId
      ? await withTenantScope(tenantId, (client) => client.query(query, params))
      : await withAdminScope(
          { caller: 'model-registry.rollout.findInProgress', reason: 'operator cross-tenant in-progress model-rollout scan (no tenant filter)' },
          (client) => client.query(query, params),
        );
    return result.rows.map(this.mapRolloutRow);
  }

  async create(input: CreateRolloutInput): Promise<ModelRollout> {
    const id = randomUUID();

    return withTenantScope(input.tenantId, async (client) => {
      // Get current model for the tenant to set as previous
      const currentConfig = await client.query(
        `SELECT model_id FROM model_configs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [input.tenantId]
      );
      const previousModelId = currentConfig.rows[0]?.model_id || null;

      const defaultMetrics: RolloutMetrics = {
        requestsTotal: 0,
        requestsSuccess: 0,
        requestsFailed: 0,
        averageLatencyMs: 0,
        p99LatencyMs: 0,
        errorRate: 0,
      };

      const result = await client.query(
        `INSERT INTO model_rollouts
         (id, tenant_id, model_id, previous_model_id, version, status, strategy, config,
          requested_by, requested_at, metrics, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, 'pending', $5, $6, $7, NOW(), $8, NOW(), NOW())
         RETURNING *`,
        [
          id,
          input.tenantId,
          input.modelId,
          previousModelId,
          input.strategy,
          JSON.stringify(input.config),
          input.requestedBy,
          JSON.stringify(defaultMetrics),
        ]
      );

      return this.mapRolloutRow(result.rows[0]);
    });
  }

  async updateStatus(
    id: string,
    status: RolloutStatus,
    additionalFields?: Record<string, unknown>
  ): Promise<ModelRollout> {
    let setClause = `status = $2, updated_at = NOW()`;
    const params: unknown[] = [id, status];
    let paramIndex = 3;

    if (additionalFields) {
      for (const [key, value] of Object.entries(additionalFields)) {
        const snakeKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
        setClause += `, ${snakeKey} = $${paramIndex}`;
        params.push(value);
        paramIndex++;
      }
    }

    const result = await withAdminScope(
      { caller: 'model-registry.rollout.updateStatus', reason: 'operator by-PK model rollout status change (no tenant context)' },
      (client) => client.query(
        `UPDATE model_rollouts SET ${setClause} WHERE id = $1 RETURNING *`,
        params
      ),
    );

    return this.mapRolloutRow(result.rows[0]);
  }

  async approve(id: string, approvedBy: string): Promise<ModelRollout> {
    return this.updateStatus(id, 'approved', {
      approvedBy,
      approvedAt: new Date(),
    });
  }

  async reject(id: string, rejectedBy: string, reason: string): Promise<ModelRollout> {
    return this.updateStatus(id, 'rejected', {
      rejectedBy,
      rejectedAt: new Date(),
      rejectionReason: reason,
    });
  }

  async startRollout(id: string): Promise<ModelRollout> {
    return this.updateStatus(id, 'in_progress', {
      startedAt: new Date(),
    });
  }

  async completeRollout(id: string): Promise<ModelRollout> {
    return this.updateStatus(id, 'completed', {
      completedAt: new Date(),
    });
  }

  async rollback(id: string, reason: string): Promise<ModelRollout> {
    return this.updateStatus(id, 'rolled_back', {
      rollbackedAt: new Date(),
      rollbackReason: reason,
    });
  }

  async updateMetrics(id: string, metrics: RolloutMetrics): Promise<void> {
    await withAdminScope(
      { caller: 'model-registry.rollout.updateMetrics', reason: 'operator by-PK model rollout metrics update (no tenant context)' },
      (client) => client.query(
        `UPDATE model_rollouts SET metrics = $2, updated_at = NOW() WHERE id = $1`,
        [id, JSON.stringify(metrics)]
      ),
    );
  }

  private mapRolloutRow(row: Record<string, unknown>): ModelRollout {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      modelId: row.model_id as string,
      previousModelId: row.previous_model_id as string | null,
      version: row.version as number,
      status: row.status as RolloutStatus,
      strategy: row.strategy as ModelRollout['strategy'],
      config: (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as RolloutConfig,
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
      metrics: (typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics) as RolloutMetrics,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
