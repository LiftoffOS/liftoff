// Tenant Promotion Router
// Per Section 22 Phase 5: Tenant promotion tooling
// Routes for promoting tenants from shared DB to dedicated instances
// Per Phase 0.3: SE-004 - Fix x-user-id header spoofing vulnerability

import { Router, Request, Response, NextFunction } from 'express';
import { TenantPromotionService, TenantPromotionConfig } from './service';
import { PromotionRequest, PromotionValidation, InstanceSize } from './types';
import { logAudit } from '../infrastructure/logging';
import { getPool, withTenantScope } from '../infrastructure/database';
import { getOptionalAuthenticatedUserId } from '../infrastructure/auth-helpers';
import { verifyTenantOwnership } from '../infrastructure/tenant-role-auth';

export const tenantPromotionRouter = Router();
const service = new TenantPromotionService();

// Instance size cost estimates (monthly, in USD)
const INSTANCE_COSTS: Record<InstanceSize, { base: number; storage: number }> = {
  small: { base: 50, storage: 0.17 },     // db-custom-1-3840, per GB
  medium: { base: 100, storage: 0.17 },   // db-custom-2-7680
  large: { base: 200, storage: 0.17 },    // db-custom-4-15360
  xlarge: { base: 400, storage: 0.17 },   // db-custom-8-30720
};

// Validate promotion request before starting
tenantPromotionRouter.post('/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request: PromotionRequest = req.body;

    if (!request.tenantId || !request.targetTier || !request.instanceSize) {
      return res.status(400).json({
        error: 'tenantId, targetTier, and instanceSize are required',
      });
    }

    const validation = await validatePromotionRequest(request);
    res.json(validation);
  } catch (error) {
    next(error);
  }
});

// Start a new promotion
// Per SE-004: Use authenticated user context instead of spoofable header
tenantPromotionRouter.post('/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request: PromotionRequest = req.body;
    const userId = getOptionalAuthenticatedUserId(req);

    if (!request.tenantId || !request.targetTier || !request.instanceSize || !request.targetRegion) {
      return res.status(400).json({
        error: 'tenantId, targetTier, instanceSize, and targetRegion are required',
      });
    }

    // Validate first
    const validation = await validatePromotionRequest(request);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Promotion validation failed',
        validation,
      });
    }

    // Get source database info
    const pool = getPool();
    const tenantResult = await pool.query(
      `SELECT database_connection FROM tenants WHERE id = $1`,
      [request.tenantId]
    );

    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const config: TenantPromotionConfig = {
      tenantId: request.tenantId,
      targetTier: request.targetTier,
      sourceDatabase: tenantResult.rows[0].database_connection || 'shared',
      targetRegion: request.targetRegion,
      instanceSize: request.instanceSize,
      highAvailability: request.highAvailability ?? false,
      pointInTimeRecovery: request.pointInTimeRecovery ?? true,
    };

    const promotion = await service.startPromotion(config);

    logAudit('tenant_promotion.started', req.ctx, {
      promotionId: promotion.promotionId,
      tenantId: request.tenantId,
      targetTier: request.targetTier,
      instanceSize: request.instanceSize,
      requestedBy: userId,
      reason: request.reason,
    });

    res.status(202).json(promotion);
  } catch (error) {
    next(error);
  }
});

// Get promotion status
tenantPromotionRouter.get('/promotions/:promotionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { promotionId } = req.params;

    const promotion = await service.getPromotionStatus(promotionId);

    if (!promotion) {
      return res.status(404).json({ error: 'Promotion not found' });
    }

    res.json(promotion);
  } catch (error) {
    next(error);
  }
});

// List promotions for a tenant
tenantPromotionRouter.get('/tenants/:tenantId/promotions', verifyTenantOwnership, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params;

    const promotions = await service.listTenantPromotions(tenantId);
    res.json(promotions);
  } catch (error) {
    next(error);
  }
});

// Get current database tier for a tenant
tenantPromotionRouter.get('/tenants/:tenantId/database-tier', verifyTenantOwnership, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params;

    // entitlements is RLS-enabled; scope to the tenant being inspected.
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT t.id, t.database_tier, t.database_connection, t.promoted_at,
              e.dedicated_db_allowed
       FROM tenants t
       LEFT JOIN entitlements e ON e.tenant_id = t.id
       WHERE t.id = $1`,
      [tenantId]
    ));

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const row = result.rows[0];
    res.json({
      tenantId: row.id,
      currentTier: row.database_tier || 'shared',
      connectionName: row.database_connection,
      promotedAt: row.promoted_at,
      canPromote: row.dedicated_db_allowed === true,
    });
  } catch (error) {
    next(error);
  }
});

// Get available instance sizes and costs
tenantPromotionRouter.get('/instance-options', async (_req: Request, res: Response) => {
  res.json({
    instanceSizes: [
      {
        id: 'small',
        name: 'Small',
        specs: '1 vCPU, 3.75 GB RAM',
        tier: 'db-custom-1-3840',
        recommendedFor: 'Development, small production workloads',
        estimatedMonthlyCost: INSTANCE_COSTS.small.base,
        storagePerGBCost: INSTANCE_COSTS.small.storage,
      },
      {
        id: 'medium',
        name: 'Medium',
        specs: '2 vCPUs, 7.5 GB RAM',
        tier: 'db-custom-2-7680',
        recommendedFor: 'Standard production workloads',
        estimatedMonthlyCost: INSTANCE_COSTS.medium.base,
        storagePerGBCost: INSTANCE_COSTS.medium.storage,
      },
      {
        id: 'large',
        name: 'Large',
        specs: '4 vCPUs, 15 GB RAM',
        tier: 'db-custom-4-15360',
        recommendedFor: 'High-volume production workloads',
        estimatedMonthlyCost: INSTANCE_COSTS.large.base,
        storagePerGBCost: INSTANCE_COSTS.large.storage,
      },
      {
        id: 'xlarge',
        name: 'Extra Large',
        specs: '8 vCPUs, 30 GB RAM',
        tier: 'db-custom-8-30720',
        recommendedFor: 'Enterprise, very high-volume workloads',
        estimatedMonthlyCost: INSTANCE_COSTS.xlarge.base,
        storagePerGBCost: INSTANCE_COSTS.xlarge.storage,
      },
    ],
    tierOptions: [
      {
        id: 'pooled_dedicated',
        name: 'Pooled Dedicated',
        description: 'Dedicated database instance shared with other enterprise tenants. Better isolation than shared, lower cost than fully dedicated.',
      },
      {
        id: 'fully_dedicated',
        name: 'Fully Dedicated',
        description: 'Completely isolated database instance for your tenant only. Maximum isolation and performance guarantees.',
      },
    ],
    regions: [
      { id: 'us-central1', name: 'US Central (Iowa)' },
      { id: 'us-east1', name: 'US East (South Carolina)' },
      { id: 'us-west1', name: 'US West (Oregon)' },
      { id: 'europe-west1', name: 'Europe West (Belgium)' },
      { id: 'europe-west2', name: 'Europe West (London)' },
      { id: 'asia-east1', name: 'Asia East (Taiwan)' },
      { id: 'asia-northeast1', name: 'Asia Northeast (Tokyo)' },
    ],
  });
});

// Get cost estimate for a promotion
tenantPromotionRouter.post('/estimate-cost', verifyTenantOwnership, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, instanceSize, highAvailability } = req.body;

    if (!tenantId || !instanceSize) {
      return res.status(400).json({ error: 'tenantId and instanceSize are required' });
    }

    const pool = getPool();

    // Get tenant data size estimate
    const sizeResult = await pool.query(
      `SELECT
         pg_size_pretty(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename)))) as total_size,
         SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))) as total_bytes
       FROM pg_tables
       WHERE schemaname = 'public'`,
      []
    );

    // Rough estimate based on tenant's proportion of total data
    const tenantDataResult = await pool.query(
      `SELECT COUNT(*) as workflow_count FROM workflows WHERE tenant_id = $1`,
      [tenantId]
    );

    const totalWorkflows = await pool.query(`SELECT COUNT(*) as count FROM workflows`);
    const tenantRatio = totalWorkflows.rows[0].count > 0
      ? tenantDataResult.rows[0].workflow_count / totalWorkflows.rows[0].count
      : 0.1;

    const totalBytes = parseInt(sizeResult.rows[0]?.total_bytes || '0', 10);
    const estimatedTenantBytes = totalBytes * tenantRatio;
    const estimatedTenantGB = Math.max(10, Math.ceil(estimatedTenantBytes / (1024 * 1024 * 1024)));

    const costs = INSTANCE_COSTS[instanceSize as InstanceSize];
    const haMultiplier = highAvailability ? 2 : 1;

    const estimatedMonthlyCost =
      (costs.base * haMultiplier) + (estimatedTenantGB * costs.storage);

    res.json({
      estimatedDataSizeGB: estimatedTenantGB,
      instanceCost: costs.base * haMultiplier,
      storageCost: estimatedTenantGB * costs.storage,
      totalMonthlyCost: Math.round(estimatedMonthlyCost * 100) / 100,
      breakdown: {
        instanceSize,
        highAvailability,
        instanceBaseCost: costs.base,
        haMultiplier,
        storagePerGB: costs.storage,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Helper function to validate promotion request
async function validatePromotionRequest(request: PromotionRequest): Promise<PromotionValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pool = getPool();  // for the non-RLS data-size probes below (workflows etc.)

  // Check tenant exists. entitlements is RLS-enabled; scope to the target tenant.
  const tenantResult = await withTenantScope(request.tenantId, (client) => client.query(
    `SELECT t.id, t.database_tier, e.dedicated_db_allowed
     FROM tenants t
     LEFT JOIN entitlements e ON e.tenant_id = t.id
     WHERE t.id = $1`,
    [request.tenantId]
  ));

  if (tenantResult.rows.length === 0) {
    errors.push('Tenant not found');
    return { valid: false, errors, warnings, estimatedDataSize: 0, estimatedMigrationTime: 0, estimatedMonthlyCost: 0 };
  }

  const tenant = tenantResult.rows[0];

  // Check current tier
  if (tenant.database_tier === request.targetTier) {
    errors.push(`Tenant is already on ${request.targetTier} tier`);
  }

  // Check entitlements
  if (request.targetTier === 'fully_dedicated' && !tenant.dedicated_db_allowed) {
    errors.push('Tenant is not entitled to fully dedicated database. Please upgrade plan first.');
  }

  // Check for active promotions
  const activePromotions = await withTenantScope(request.tenantId, (client) => client.query(
    `SELECT id FROM tenant_promotions
     WHERE tenant_id = $1 AND status NOT IN ('completed', 'failed', 'rolled_back')`,
    [request.tenantId]
  ));

  if (activePromotions.rows.length > 0) {
    errors.push('Tenant already has an active promotion in progress');
  }

  // Get data size estimate
  const dataStats = await pool.query(
    `SELECT
       COUNT(*) as total_records,
       pg_size_pretty(SUM(pg_column_size(t.*))) as estimated_size
     FROM (
       SELECT * FROM workflows WHERE tenant_id = $1
       UNION ALL SELECT * FROM agents WHERE tenant_id = $1
       UNION ALL SELECT * FROM actions WHERE tenant_id = $1
     ) t`,
    [request.tenantId]
  );

  const recordCount = parseInt(dataStats.rows[0]?.total_records || '0', 10);
  const estimatedDataSize = Math.max(1, Math.ceil(recordCount / 1000)); // Rough MB estimate

  // Estimate migration time (very rough: 1 min per 100MB)
  const estimatedMigrationTime = Math.max(5, Math.ceil(estimatedDataSize / 100)) * 60;

  // Cost estimate
  const costs = INSTANCE_COSTS[request.instanceSize];
  const haMultiplier = request.highAvailability ? 2 : 1;
  const estimatedMonthlyCost = (costs.base * haMultiplier) + (Math.ceil(estimatedDataSize / 1024) * costs.storage);

  // Warnings
  if (estimatedDataSize > 10000) {
    warnings.push('Large data volume may result in extended migration time');
  }

  if (request.targetTier === 'fully_dedicated' && !request.highAvailability) {
    warnings.push('Consider enabling high availability for fully dedicated instances in production');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    estimatedDataSize,
    estimatedMigrationTime,
    estimatedMonthlyCost,
  };
}
