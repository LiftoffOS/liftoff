// Entitlements Client Repository
// Per Section 4: Local cache of control-plane data

import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { normalizeTier } from '../llm/types';
import {
  TenantEntitlement,
  TenantQuotas,
  ApprovedDeployment,
  ModelConfig,
  ModelTier,
  PromptBundle,
  FeatureFlags,
  RoutingPolicy,
} from './types';

/** The cached policy's tier intent under current tier names. The cache holds
 *  the control plane's policy verbatim, so it can carry a tier's retired name
 *  until it refreshes; see normalizeTier. */
function withCurrentTierNames(policy: RoutingPolicy): RoutingPolicy {
  const tier = (t: ModelTier | undefined) => normalizeTier(t) as ModelTier | undefined;
  const overrides = policy.taskTierOverrides;
  return {
    ...policy,
    ...(policy.defaultTier !== undefined && { defaultTier: tier(policy.defaultTier) }),
    ...(overrides && {
      taskTierOverrides: Object.fromEntries(
        Object.entries(overrides).map(([task, t]) => [task, tier(t) as ModelTier]),
      ),
    }),
  };
}

// All quota columns the cached_entitlements row carries. Single source of
// truth — used by both getEntitlement() and getQuotas() (which are now the
// same thing post-migration 060).
const ENTITLEMENT_SELECT = `
  tenant_id,
  operational_status,
  agent_execution_allowed,
  billing_suspended,
  remaining_credits,
  overage_allowed,
  included_monthly_credits,
  overage_ceiling,
  entity_version,
  updated_at
`;

// Shared INSERT ... ON CONFLICT body for both cached_entitlements write paths.
// The two variants differ ONLY in the trailing WHERE clause (see
// upsertEntitlementFromEvent / upsertEntitlementFromFetch), so the column list
// and the parameter order live in one place and cannot drift apart.
const UPSERT_ENTITLEMENT_SQL = `
  INSERT INTO cached_entitlements (
    tenant_id, operational_status, agent_execution_allowed, billing_suspended,
    remaining_credits, overage_allowed, included_monthly_credits,
    overage_ceiling, entity_version, updated_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
  ON CONFLICT (tenant_id) DO UPDATE SET
    operational_status = EXCLUDED.operational_status,
    agent_execution_allowed = EXCLUDED.agent_execution_allowed,
    billing_suspended = EXCLUDED.billing_suspended,
    remaining_credits = EXCLUDED.remaining_credits,
    overage_allowed = EXCLUDED.overage_allowed,
    included_monthly_credits = EXCLUDED.included_monthly_credits,
    overage_ceiling = EXCLUDED.overage_ceiling,
    entity_version = EXCLUDED.entity_version,
    updated_at = NOW()`;

function upsertEntitlementParams(entitlement: TenantEntitlement): unknown[] {
  return [
    entitlement.tenantId,
    entitlement.operationalStatus,
    entitlement.agentExecutionAllowed,
    entitlement.billingSuspended,
    entitlement.remainingIncludedCredits,
    entitlement.overageAllowed,
    entitlement.includedMonthlyCredits,
    entitlement.overageCeiling,
    entitlement.entityVersion,
  ];
}

function mapEntitlementRow(row: Record<string, any>): TenantEntitlement {
  return {
    tenantId: row.tenant_id,
    operationalStatus: row.operational_status,
    agentExecutionAllowed: row.agent_execution_allowed,
    // `?? false`, not `!!`: a row written before migration 346 (or by a
    // control plane that has not shipped the field) carries no opinion, and
    // "no opinion" must read as "not billing-suspended".
    billingSuspended: row.billing_suspended ?? false,
    remainingIncludedCredits: row.remaining_credits,
    overageAllowed: row.overage_allowed,
    includedMonthlyCredits: row.included_monthly_credits,
    overageCeiling: row.overage_ceiling,
    entityVersion: row.entity_version,
    updatedAt: row.updated_at,
  };
}

export class EntitlementsRepository {
  // Get cached entitlement for a tenant
  async getEntitlement(tenantId: string): Promise<TenantEntitlement | null> {
    const result = await getPool().query(
      `SELECT ${ENTITLEMENT_SELECT} FROM cached_entitlements WHERE tenant_id = $1`,
      [tenantId]
    );
    return result.rows[0] ? mapEntitlementRow(result.rows[0]) : null;
  }

  // Get full quotas — alias for getEntitlement post-migration 060.
  // Kept as a separate method for call-site clarity (admission controllers
  // call getQuotas; status checks call getEntitlement).
  async getQuotas(tenantId: string): Promise<TenantQuotas | null> {
    return this.getEntitlement(tenantId);
  }

  // Get approved deployment
  async getApprovedDeployment(tenantId: string): Promise<ApprovedDeployment | null> {
    const result = await getPool().query(
      `SELECT
        deployment_id,
        tenant_id,
        artifact_ref,
        version,
        status,
        approved_at,
        entity_version
      FROM cached_deployments
      WHERE tenant_id = $1 AND status = 'approved'
      ORDER BY approved_at DESC
      LIMIT 1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      deploymentId: row.deployment_id,
      tenantId: row.tenant_id,
      artifactRef: row.artifact_ref,
      version: row.version,
      status: row.status,
      approvedAt: row.approved_at,
      entityVersion: row.entity_version,
    };
  }

  // Get model configs for a tenant
  async getModelConfigs(tenantId: string): Promise<ModelConfig[]> {
    const result = await getPool().query(
      `SELECT
        id,
        tenant_id,
        model_id,
        routing_policy,
        version,
        entity_version
      FROM cached_model_configs
      WHERE tenant_id = $1`,
      [tenantId]
    );

    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      modelId: row.model_id,
      routingPolicy: withCurrentTierNames(typeof row.routing_policy === 'string' ? JSON.parse(row.routing_policy) : (row.routing_policy || {})),
      version: row.version,
      entityVersion: row.entity_version,
    }));
  }

  // Get prompt bundle
  async getPromptBundle(tenantId: string, bundleId: string): Promise<PromptBundle | null> {
    const result = await getPool().query(
      `SELECT
        bundle_id,
        tenant_id,
        name,
        version,
        status,
        templates,
        approved_at,
        entity_version
      FROM cached_prompt_bundles
      WHERE tenant_id = $1 AND bundle_id = $2`,
      [tenantId, bundleId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      bundleId: row.bundle_id,
      tenantId: row.tenant_id,
      name: row.name,
      version: row.version,
      status: row.status,
      templates: row.templates,
      approvedAt: row.approved_at,
      entityVersion: row.entity_version,
    };
  }

  // Get approved prompt bundles for a tenant
  async getApprovedPromptBundles(tenantId: string): Promise<PromptBundle[]> {
    const result = await getPool().query(
      `SELECT
        bundle_id,
        tenant_id,
        name,
        version,
        status,
        templates,
        approved_at,
        entity_version
      FROM cached_prompt_bundles
      WHERE tenant_id = $1 AND status = 'approved'`,
      [tenantId]
    );

    return result.rows.map((row) => ({
      bundleId: row.bundle_id,
      tenantId: row.tenant_id,
      name: row.name,
      version: row.version,
      status: row.status,
      templates: row.templates,
      approvedAt: row.approved_at,
      entityVersion: row.entity_version,
    }));
  }

  // Get feature flags
  async getFeatureFlags(tenantId: string): Promise<FeatureFlags | null> {
    const result = await getPool().query(
      `SELECT
        tenant_id,
        flags,
        entity_version
      FROM cached_feature_flags
      WHERE tenant_id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      tenantId: row.tenant_id,
      flags: row.flags,
      entityVersion: row.entity_version,
    };
  }

  // Update cached deployment (used by event subscriber or service)
  async upsertDeployment(deployment: ApprovedDeployment): Promise<void> {
    await getPool().query(
      `INSERT INTO cached_deployments (
        deployment_id, tenant_id, artifact_ref, version, status,
        approved_at, entity_version, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (tenant_id, deployment_id) DO UPDATE SET
        artifact_ref = EXCLUDED.artifact_ref,
        version = EXCLUDED.version,
        status = EXCLUDED.status,
        approved_at = EXCLUDED.approved_at,
        entity_version = EXCLUDED.entity_version,
        updated_at = NOW()
      WHERE cached_deployments.entity_version < EXCLUDED.entity_version`,
      [
        deployment.deploymentId,
        deployment.tenantId,
        deployment.artifactRef,
        deployment.version,
        deployment.status,
        deployment.approvedAt,
        deployment.entityVersion,
      ]
    );
  }

  // Update cached entitlement — EVENT path.
  //
  // Events can arrive out of order (redelivery, competing subscribers), so the
  // stored `entity_version` is the tiebreak: an older event must never clobber
  // a newer snapshot. Only this variant carries that guard.
  async upsertEntitlementFromEvent(entitlement: TenantEntitlement): Promise<void> {
    await getPool().query(
      `${UPSERT_ENTITLEMENT_SQL}
      WHERE cached_entitlements.entity_version < EXCLUDED.entity_version`,
      upsertEntitlementParams(entitlement),
    );
  }

  // Update cached entitlement — FETCH path.
  //
  // No version guard, on purpose. A read straight from the control plane is by
  // definition the current truth; it cannot be stale relative to itself, so
  // there is nothing to order it against. Guarding it is what silently broke
  // the refresh: the control plane served the same `entity_version` every
  // time, `entity_version < EXCLUDED.entity_version` was never true, and the
  // fetch "succeeded" while writing nothing — leaving cached rows months old
  // and `isCacheStale` permanently true, because `updated_at` never moved.
  // Writing unconditionally is what gives `updated_at` (and therefore
  // `isCacheStale`) meaning again.
  async upsertEntitlementFromFetch(entitlement: TenantEntitlement): Promise<void> {
    await getPool().query(UPSERT_ENTITLEMENT_SQL, upsertEntitlementParams(entitlement));
  }

  // Check if cache is stale (older than TTL)
  // Per Section 4: TTL-based cache staleness check
  async isCacheStale(tenantId: string, ttlMs: number): Promise<boolean> {
    // Use parameterized interval to avoid SQL injection
    const result = await getPool().query(
      `SELECT updated_at FROM cached_entitlements
       WHERE tenant_id = $1 AND updated_at > NOW() - ($2 || ' milliseconds')::interval`,
      [tenantId, ttlMs.toString()]
    );

    return result.rows.length === 0;
  }

  // Get the stored entity version for stale-event checking
  async getStoredVersion(
    tenantId: string,
    entityType: string,
    entityId: string
  ): Promise<number | null> {
    const result = await getPool().query(
      `SELECT entity_version FROM event_versions
       WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3`,
      [tenantId, entityType, entityId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].entity_version;
  }

  // ============================================
  // Per Section 4: Cache invalidation methods
  // Supports explicit invalidation on events
  // ============================================

  // Invalidate entitlement cache for a tenant
  async invalidateEntitlement(tenantId: string): Promise<void> {
    await getPool().query(
      `DELETE FROM cached_entitlements WHERE tenant_id = $1`,
      [tenantId]
    );

    logger.info('Invalidated entitlement cache', { tenantId });
  }

  // Invalidate all caches for a tenant (for suspension/termination)
  async invalidateAllCaches(tenantId: string): Promise<void> {
    const pool = getPool();

    await Promise.all([
      pool.query('DELETE FROM cached_entitlements WHERE tenant_id = $1', [tenantId]),
      pool.query('DELETE FROM cached_deployments WHERE tenant_id = $1', [tenantId]),
      pool.query('DELETE FROM cached_model_configs WHERE tenant_id = $1', [tenantId]),
      pool.query('DELETE FROM cached_prompt_bundles WHERE tenant_id = $1', [tenantId]),
      pool.query('DELETE FROM cached_feature_flags WHERE tenant_id = $1', [tenantId]),
    ]);

    logger.info('Invalidated all caches for tenant', { tenantId });
  }

  // Invalidate model config cache
  async invalidateModelConfig(tenantId: string, modelId?: string): Promise<void> {
    if (modelId) {
      await getPool().query(
        `DELETE FROM cached_model_configs WHERE tenant_id = $1 AND model_id = $2`,
        [tenantId, modelId]
      );
    } else {
      await getPool().query(
        `DELETE FROM cached_model_configs WHERE tenant_id = $1`,
        [tenantId]
      );
    }

    logger.info('Invalidated model config cache', { tenantId, modelId });
  }

  // Invalidate feature flags cache
  async invalidateFeatureFlags(tenantId: string): Promise<void> {
    await getPool().query(
      `DELETE FROM cached_feature_flags WHERE tenant_id = $1`,
      [tenantId]
    );

    logger.info('Invalidated feature flags cache', { tenantId });
  }

  // Invalidate prompt bundle cache
  async invalidatePromptBundle(tenantId: string, bundleId?: string): Promise<void> {
    if (bundleId) {
      await getPool().query(
        `DELETE FROM cached_prompt_bundles WHERE tenant_id = $1 AND bundle_id = $2`,
        [tenantId, bundleId]
      );
    } else {
      await getPool().query(
        `DELETE FROM cached_prompt_bundles WHERE tenant_id = $1`,
        [tenantId]
      );
    }

    logger.info('Invalidated prompt bundle cache', { tenantId, bundleId });
  }

  // Cleanup expired cache entries (called by background job)
  async cleanupExpiredEntries(maxAgeMs: number): Promise<number> {
    const pool = getPool();
    let totalDeleted = 0;

    const tables = [
      'cached_entitlements',
      'cached_deployments',
      'cached_model_configs',
      'cached_prompt_bundles',
      'cached_feature_flags',
    ];

    for (const table of tables) {
      const result = await pool.query(
        `DELETE FROM ${table}
         WHERE updated_at < NOW() - ($1 || ' milliseconds')::interval
         RETURNING 1`,
        [maxAgeMs.toString()]
      );
      totalDeleted += result.rowCount ?? 0;
    }

    if (totalDeleted > 0) {
      logger.info('Cleaned up expired cache entries', { totalDeleted, maxAgeMs });
    }

    return totalDeleted;
  }
}
