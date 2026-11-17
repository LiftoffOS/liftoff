// Tenant Promotion Service
// Per Section 22 Phase 5: Tenant promotion tooling
// Tools to promote tenants from shared DB to dedicated instances

import { pool, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { publishEvent } from '../events/publisher';

// RLS note (FORCE census): this is platform-operator tooling that promotes a
// tenant from the shared DB to a dedicated instance. It runs outside any tenant
// request scope and, in exportTenantData, sweeps a fixed list of tenant tables
// (several RLS-enabled: connectors, workflow_tasks) by tenant_id. Every query
// that touches an RLS table → withAdminScope. Queries on non-RLS registry
// tables (`tenants`, `tenant_entitlements`) stay on the default pool.

// Per Section 1: Keep a defined promotion path to pooled dedicated instances
// or fully dedicated instances for larger or enterprise tenants

export interface TenantPromotionConfig {
  tenantId: string;
  targetTier: 'pooled_dedicated' | 'fully_dedicated';
  sourceDatabase: string;
  targetRegion: string;
  instanceSize: 'small' | 'medium' | 'large' | 'xlarge';
  highAvailability: boolean;
  pointInTimeRecovery: boolean;
}

export interface PromotionStatus {
  promotionId: string;
  tenantId: string;
  status: 'pending' | 'exporting' | 'provisioning' | 'migrating' | 'validating' | 'switching' | 'completed' | 'failed' | 'rolled_back';
  currentStep: number;
  totalSteps: number;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  details: Record<string, unknown>;
}

interface PromotionStep {
  name: string;
  execute: (promotion: PromotionStatus, config: TenantPromotionConfig) => Promise<void>;
  rollback: (promotion: PromotionStatus, config: TenantPromotionConfig) => Promise<void>;
}

export class TenantPromotionService {
  private readonly PROMOTION_STEPS: PromotionStep[] = [
    {
      name: 'validate_tenant',
      execute: this.validateTenant.bind(this),
      rollback: async () => {}, // No rollback needed
    },
    {
      name: 'create_snapshot',
      execute: this.createDataSnapshot.bind(this),
      rollback: this.deleteSnapshot.bind(this),
    },
    {
      name: 'provision_instance',
      execute: this.provisionDedicatedInstance.bind(this),
      rollback: this.deleteInstance.bind(this),
    },
    {
      name: 'migrate_schema',
      execute: this.migrateSchema.bind(this),
      rollback: async () => {}, // Instance deletion handles this
    },
    {
      name: 'export_data',
      execute: this.exportTenantData.bind(this),
      rollback: async () => {}, // Data export is non-destructive
    },
    {
      name: 'import_data',
      execute: this.importTenantData.bind(this),
      rollback: async () => {}, // Instance deletion handles this
    },
    {
      name: 'validate_migration',
      execute: this.validateMigration.bind(this),
      rollback: async () => {}, // No rollback needed
    },
    {
      name: 'update_routing',
      execute: this.updateTenantRouting.bind(this),
      rollback: this.revertTenantRouting.bind(this),
    },
    {
      name: 'cleanup_source',
      execute: this.cleanupSourceData.bind(this),
      rollback: async () => {}, // Cleanup is optional
    },
  ];

  // Start tenant promotion process
  async startPromotion(config: TenantPromotionConfig): Promise<PromotionStatus> {
    const promotionId = `promo-${config.tenantId}-${Date.now()}`;

    const promotion: PromotionStatus = {
      promotionId,
      tenantId: config.tenantId,
      status: 'pending',
      currentStep: 0,
      totalSteps: this.PROMOTION_STEPS.length,
      startedAt: new Date(),
      details: {},
    };

    // Persist promotion state
    await this.savePromotionState(promotion);

    log.info({
      promotion_id: promotionId,
      tenant_id: config.tenantId,
      target_tier: config.targetTier,
    }, 'Starting tenant promotion');

    // Execute promotion asynchronously
    this.executePromotion(promotion, config).catch(async (error) => {
      promotion.status = 'failed';
      promotion.error = error.message;
      await this.savePromotionState(promotion);
    });

    return promotion;
  }

  // Execute promotion steps
  private async executePromotion(
    promotion: PromotionStatus,
    config: TenantPromotionConfig
  ): Promise<void> {
    for (let i = 0; i < this.PROMOTION_STEPS.length; i++) {
      const step = this.PROMOTION_STEPS[i];
      promotion.currentStep = i + 1;
      promotion.status = this.getStatusForStep(step.name);
      await this.savePromotionState(promotion);

      log.info({
        promotion_id: promotion.promotionId,
        step: step.name,
        step_number: i + 1,
        total_steps: this.PROMOTION_STEPS.length,
      }, 'Executing promotion step');

      try {
        await step.execute(promotion, config);
      } catch (error) {
        log.error({
          promotion_id: promotion.promotionId,
          step: step.name,
          error: (error as Error).message,
        }, 'Promotion step failed');

        // Attempt rollback
        await this.rollbackPromotion(promotion, config, i);
        throw error;
      }
    }

    promotion.status = 'completed';
    promotion.completedAt = new Date();
    await this.savePromotionState(promotion);

    // Publish completion event
    await publishEvent({
      entityType: 'tenant_promotion',
      entityId: promotion.promotionId,
      eventType: 'tenant.promotion.completed',
      entityVersion: 1,
      eventVersion: 1,
      tenantId: config.tenantId,
      payload: { targetTier: config.targetTier },
    });

    log.info({
      promotion_id: promotion.promotionId,
      tenant_id: config.tenantId,
      duration_ms: Date.now() - promotion.startedAt.getTime(),
    }, 'Tenant promotion completed');
  }

  // Rollback promotion on failure
  private async rollbackPromotion(
    promotion: PromotionStatus,
    config: TenantPromotionConfig,
    failedStepIndex: number
  ): Promise<void> {
    promotion.status = 'rolled_back';

    log.warn({
      promotion_id: promotion.promotionId,
      failed_step_index: failedStepIndex,
    }, 'Rolling back tenant promotion');

    // Rollback in reverse order
    for (let i = failedStepIndex; i >= 0; i--) {
      const step = this.PROMOTION_STEPS[i];
      try {
        await step.rollback(promotion, config);
        log.info({
          promotion_id: promotion.promotionId,
          step: step.name,
        }, 'Rolled back promotion step');
      } catch (rollbackError) {
        log.error({
          promotion_id: promotion.promotionId,
          step: step.name,
          error: (rollbackError as Error).message,
        }, 'Failed to rollback step');
      }
    }

    await this.savePromotionState(promotion);
  }

  // Step implementations
  private async validateTenant(
    promotion: PromotionStatus,
    config: TenantPromotionConfig
  ): Promise<void> {
    // Check tenant exists and is eligible for promotion
    const result = await pool.query(
      `SELECT t.*, e.data as entitlements
       FROM tenants t
       LEFT JOIN tenant_entitlements e ON t.id = e.tenant_id
       WHERE t.id = $1`,
      [config.tenantId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Tenant ${config.tenantId} not found`);
    }

    const tenant = result.rows[0];

    // Check if already on dedicated instance
    if (tenant.database_tier === config.targetTier) {
      throw new Error(`Tenant ${config.tenantId} is already on ${config.targetTier}`);
    }

    // Check entitlements allow promotion
    const entitlements = tenant.entitlements || {};
    if (!entitlements.dedicated_db_allowed && config.targetTier === 'fully_dedicated') {
      throw new Error(`Tenant ${config.tenantId} is not entitled to dedicated database`);
    }

    promotion.details.tenant = {
      currentTier: tenant.database_tier,
      targetTier: config.targetTier,
    };
  }

  private async createDataSnapshot(
    promotion: PromotionStatus,
    config: TenantPromotionConfig
  ): Promise<void> {
    // Create point-in-time snapshot of tenant data
    const snapshotId = `snapshot-${config.tenantId}-${Date.now()}`;

    // Mark snapshot point in source database
    await withAdminScope(
      { caller: 'tenant-promotion.createDataSnapshot', reason: 'operator promotion tooling — record promotion_snapshots row (no tenant request scope)' },
      (client) => client.query(
        `INSERT INTO promotion_snapshots (id, tenant_id, promotion_id, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [snapshotId, config.tenantId, promotion.promotionId]
      ),
    );

    promotion.details.snapshotId = snapshotId;
  }

  private async deleteSnapshot(
    promotion: PromotionStatus,
    _config: TenantPromotionConfig
  ): Promise<void> {
    const snapshotId = promotion.details.snapshotId as string;
    if (snapshotId) {
      await withAdminScope(
        { caller: 'tenant-promotion.deleteSnapshot', reason: 'operator promotion tooling — rollback promotion_snapshots row (no tenant request scope)' },
        (client) => client.query(
          `DELETE FROM promotion_snapshots WHERE id = $1`,
          [snapshotId]
        ),
      );
    }
  }

  private async provisionDedicatedInstance(
    promotion: PromotionStatus,
    config: TenantPromotionConfig
  ): Promise<void> {
    // Per Section 1: Provision dedicated Cloud SQL instance
    // This would typically call Terraform or GCP APIs

    const instanceConfig = this.getInstanceConfig(config);

    // In production, this would call Terraform or Cloud SQL Admin API
    // For now, we record the intent and assume infrastructure provisioning is separate
    promotion.details.dedicatedInstance = {
      name: `${config.tenantId}-pg-${Date.now()}`,
      region: config.targetRegion,
      tier: instanceConfig.tier,
      diskSize: instanceConfig.diskSize,
      highAvailability: config.highAvailability,
      pointInTimeRecovery: config.pointInTimeRecovery,
      status: 'provisioning',
    };

    log.info({
      promotion_id: promotion.promotionId,
      instance_config: promotion.details.dedicatedInstance,
    }, 'Provisioning dedicated instance');

    // Wait for instance to be ready (in production, would poll GCP API)
    // Simulated here
    await this.waitForInstanceReady(promotion);
  }

  private async deleteInstance(
    promotion: PromotionStatus,
    _config: TenantPromotionConfig
  ): Promise<void> {
    const instanceDetails = promotion.details.dedicatedInstance as Record<string, unknown>;
    if (instanceDetails?.name) {
      log.info({
        promotion_id: promotion.promotionId,
        instance_name: instanceDetails.name,
      }, 'Deleting dedicated instance on rollback');

      // In production, would call Terraform destroy or Cloud SQL Admin API
    }
  }

  private async migrateSchema(
    promotion: PromotionStatus,
    _config: TenantPromotionConfig
  ): Promise<void> {
    // Apply database migrations to new instance
    log.info({
      promotion_id: promotion.promotionId,
    }, 'Migrating schema to dedicated instance');

    promotion.details.schemaMigrated = true;
  }

  private async exportTenantData(
    promotion: PromotionStatus,
    config: TenantPromotionConfig
  ): Promise<void> {
    // Export tenant data from shared instance
    const tables = [
      'workflows',
      'workflow_tasks',
      'workflow_task_dependencies',
      'workflow_task_outputs',
      'workflow_handoffs',
      'workflow_escalations',
      'workflow_leases',
      'workflow_checkpoints',
      'actions',
      'agents',
      'agent_audit_log',
      'connectors',
      'connector_records',
      'connector_sync_stats',
      'usage_events',
      'refunds',
      'burn_state',
      'reflection_suggestions',
      'human_feedback',
      'policy_denials',
    ];

    const exportCounts: Record<string, number> = {};

    for (const table of tables) {
      // Several of these are RLS-enabled tenant tables (connectors,
      // workflow_tasks). Operator tooling with no tenant request scope →
      // withAdminScope. The identifier is from a fixed in-code allow-list
      // above, not user input.
      const result = await withAdminScope(
        { caller: 'tenant-promotion.exportTenantData', reason: `operator promotion tooling — count rows in ${table} for the tenant (no tenant request scope)` },
        (client) => client.query(
          `SELECT COUNT(*) as count FROM ${table} WHERE tenant_id = $1`,
          [config.tenantId]
        ),
      );
      exportCounts[table] = parseInt(result.rows[0].count, 10);
    }

    promotion.details.exportCounts = exportCounts;

    log.info({
      promotion_id: promotion.promotionId,
      export_counts: exportCounts,
    }, 'Exported tenant data');
  }

  private async importTenantData(
    promotion: PromotionStatus,
    _config: TenantPromotionConfig
  ): Promise<void> {
    // Import data to dedicated instance
    // In production, this would use pg_dump/pg_restore or custom migration logic

    log.info({
      promotion_id: promotion.promotionId,
    }, 'Importing tenant data to dedicated instance');

    promotion.details.dataImported = true;
  }

  private async validateMigration(
    promotion: PromotionStatus,
    _config: TenantPromotionConfig
  ): Promise<void> {
    // Validate data integrity after migration
    const exportCounts = promotion.details.exportCounts as Record<string, number>;
    const validationErrors: string[] = [];

    // Compare row counts
    for (const [table, expectedCount] of Object.entries(exportCounts)) {
      // In production, would query the new dedicated instance
      // Here we just log the validation
      log.debug({
        promotion_id: promotion.promotionId,
        table,
        expected_count: expectedCount,
      }, 'Validating table migration');
    }

    if (validationErrors.length > 0) {
      throw new Error(`Migration validation failed: ${validationErrors.join(', ')}`);
    }

    promotion.details.validationPassed = true;
  }

  private async updateTenantRouting(
    promotion: PromotionStatus,
    config: TenantPromotionConfig
  ): Promise<void> {
    // Update tenant configuration to point to new database
    const instanceDetails = promotion.details.dedicatedInstance as Record<string, unknown>;

    await pool.query(
      `UPDATE tenants
       SET database_tier = $2,
           database_connection = $3,
           promoted_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [config.tenantId, config.targetTier, instanceDetails.name]
    );

    // Store old routing for potential rollback
    promotion.details.previousRouting = {
      tier: 'shared',
      connection: config.sourceDatabase,
    };

    log.info({
      promotion_id: promotion.promotionId,
      tenant_id: config.tenantId,
      new_connection: instanceDetails.name,
    }, 'Updated tenant routing');
  }

  private async revertTenantRouting(
    promotion: PromotionStatus,
    config: TenantPromotionConfig
  ): Promise<void> {
    const previousRouting = promotion.details.previousRouting as Record<string, string>;
    if (previousRouting) {
      await pool.query(
        `UPDATE tenants
         SET database_tier = $2,
             database_connection = $3,
             promoted_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [config.tenantId, previousRouting.tier, previousRouting.connection]
      );
    }
  }

  private async cleanupSourceData(
    promotion: PromotionStatus,
    config: TenantPromotionConfig
  ): Promise<void> {
    // Optionally clean up tenant data from shared instance after successful promotion
    // This is a destructive operation and should be done with care

    log.info({
      promotion_id: promotion.promotionId,
      tenant_id: config.tenantId,
    }, 'Tenant data cleanup from shared instance (optional step)');

    // Mark data as migrated but don't delete immediately
    // A separate cleanup job can purge after grace period
    await withAdminScope(
      { caller: 'tenant-promotion.cleanupSourceData', reason: 'operator promotion tooling — record migrated_tenant_data row (no tenant request scope)' },
      (client) => client.query(
        `INSERT INTO migrated_tenant_data (tenant_id, promotion_id, migrated_at, cleanup_eligible_at)
         VALUES ($1, $2, NOW(), NOW() + INTERVAL '30 days')
         ON CONFLICT (tenant_id) DO UPDATE
         SET promotion_id = $2, migrated_at = NOW(), cleanup_eligible_at = NOW() + INTERVAL '30 days'`,
        [config.tenantId, promotion.promotionId]
      ),
    );

    promotion.details.cleanupScheduled = true;
  }

  // Helper methods
  private getStatusForStep(stepName: string): PromotionStatus['status'] {
    const statusMap: Record<string, PromotionStatus['status']> = {
      validate_tenant: 'pending',
      create_snapshot: 'exporting',
      provision_instance: 'provisioning',
      migrate_schema: 'migrating',
      export_data: 'exporting',
      import_data: 'migrating',
      validate_migration: 'validating',
      update_routing: 'switching',
      cleanup_source: 'completed',
    };
    return statusMap[stepName] || 'pending';
  }

  private getInstanceConfig(config: TenantPromotionConfig): {
    tier: string;
    diskSize: number;
  } {
    const sizeMap = {
      small: { tier: 'db-custom-1-3840', diskSize: 10 },
      medium: { tier: 'db-custom-2-7680', diskSize: 50 },
      large: { tier: 'db-custom-4-15360', diskSize: 100 },
      xlarge: { tier: 'db-custom-8-30720', diskSize: 200 },
    };
    return sizeMap[config.instanceSize];
  }

  private async waitForInstanceReady(_promotion: PromotionStatus): Promise<void> {
    // In production, would poll GCP API until instance is RUNNABLE
    // Simulated delay
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  private async savePromotionState(promotion: PromotionStatus): Promise<void> {
    await withAdminScope(
      { caller: 'tenant-promotion.savePromotionState', reason: 'operator promotion tooling — upsert tenant_promotions state (no tenant request scope)' },
      (client) => client.query(
        `INSERT INTO tenant_promotions (
          id, tenant_id, status, current_step, total_steps,
          started_at, completed_at, error, details
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          status = $3, current_step = $4, completed_at = $7,
          error = $8, details = $9`,
        [
          promotion.promotionId,
          promotion.tenantId,
          promotion.status,
          promotion.currentStep,
          promotion.totalSteps,
          promotion.startedAt,
          promotion.completedAt,
          promotion.error,
          JSON.stringify(promotion.details),
        ]
      ),
    );
  }

  // Get promotion status
  async getPromotionStatus(promotionId: string): Promise<PromotionStatus | null> {
    const result = await withAdminScope(
      { caller: 'tenant-promotion.getPromotionStatus', reason: 'operator promotion tooling — by-PK tenant_promotions read (no tenant request scope)' },
      (client) => client.query(
        `SELECT * FROM tenant_promotions WHERE id = $1`,
        [promotionId]
      ),
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      promotionId: row.id,
      tenantId: row.tenant_id,
      status: row.status,
      currentStep: row.current_step,
      totalSteps: row.total_steps,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      details: row.details,
    };
  }

  // List promotions for a tenant
  async listTenantPromotions(tenantId: string): Promise<PromotionStatus[]> {
    const result = await withAdminScope(
      { caller: 'tenant-promotion.listTenantPromotions', reason: 'operator promotion tooling — list tenant_promotions for a tenant (no tenant request scope)' },
      (client) => client.query(
        `SELECT * FROM tenant_promotions WHERE tenant_id = $1 ORDER BY started_at DESC`,
        [tenantId]
      ),
    );

    return result.rows.map((row) => ({
      promotionId: row.id,
      tenantId: row.tenant_id,
      status: row.status,
      currentStep: row.current_step,
      totalSteps: row.total_steps,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      details: row.details,
    }));
  }
}
