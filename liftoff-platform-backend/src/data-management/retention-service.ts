// Retention Service
// Per Section 21: Retention schedules by data class

import { DataManagementRepository } from './repository';
import { DeletionService } from './deletion-service';
import {
  RetentionPolicy,
  CreateRetentionPolicyInput,
  EntityType,
} from './types';
import { pool, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { publishEvent } from '../events/publisher';

// Default retention policies
const DEFAULT_RETENTION_POLICIES: CreateRetentionPolicyInput[] = [
  {
    name: 'Workflow Data - Standard',
    entityType: 'workflow',
    dataClassification: 'confidential',
    retentionDays: 365,
    deletionStrategy: 'soft_delete',
    archiveBeforeDelete: true,
  },
  {
    name: 'Action Ledger - Standard',
    entityType: 'action',
    dataClassification: 'confidential',
    retentionDays: 365,
    deletionStrategy: 'soft_delete',
    archiveBeforeDelete: true,
  },
  {
    name: 'Usage Events - Billing',
    entityType: 'usage_event',
    dataClassification: 'internal',
    retentionDays: 730, // 2 years for billing records
    deletionStrategy: 'archive_then_delete',
    archiveBeforeDelete: true,
  },
  {
    name: 'Audit Logs - Compliance',
    entityType: 'audit_log',
    dataClassification: 'confidential',
    retentionDays: 2555, // 7 years for SOC 2 compliance
    deletionStrategy: 'archive_then_delete',
    archiveBeforeDelete: true,
  },
  {
    name: 'Connector Records - Standard',
    entityType: 'connector_record',
    dataClassification: 'confidential',
    retentionDays: 365,
    deletionStrategy: 'soft_delete',
    archiveBeforeDelete: false,
  },
  {
    name: 'Reflections - Standard',
    entityType: 'reflection',
    dataClassification: 'internal',
    retentionDays: 180,
    deletionStrategy: 'soft_delete',
    archiveBeforeDelete: false,
  },
  {
    name: 'Feedback - Standard',
    entityType: 'feedback',
    dataClassification: 'confidential',
    retentionDays: 365,
    deletionStrategy: 'soft_delete',
    archiveBeforeDelete: true,
  },
];

export class RetentionService {
  private repository = new DataManagementRepository();
  private deletionService = new DeletionService();

  async initializeDefaultPolicies(): Promise<void> {
    const existingPolicies = await this.repository.findAllRetentionPolicies();

    for (const defaultPolicy of DEFAULT_RETENTION_POLICIES) {
      const exists = existingPolicies.some(
        p => p.entityType === defaultPolicy.entityType && p.name === defaultPolicy.name
      );

      if (!exists) {
        await this.repository.createRetentionPolicy(defaultPolicy);
        log.info({
          name: defaultPolicy.name,
          entityType: defaultPolicy.entityType,
        }, 'Created default retention policy');
      }
    }
  }

  async createPolicy(input: CreateRetentionPolicyInput): Promise<RetentionPolicy> {
    const policy = await this.repository.createRetentionPolicy(input);

    log.info({
      policyId: policy.id,
      name: input.name,
      entityType: input.entityType,
      retentionDays: input.retentionDays,
    }, 'Retention policy created');

    // Log compliance audit
    return policy;
  }

  async updatePolicy(id: string, updates: Partial<CreateRetentionPolicyInput>): Promise<RetentionPolicy> {
    const policy = await this.repository.updateRetentionPolicy(id, updates);

    log.info({
      policyId: id,
      updates,
    }, 'Retention policy updated');

    return policy;
  }

  async disablePolicy(id: string): Promise<void> {
    await this.repository.disableRetentionPolicy(id);

    log.info({ policyId: id }, 'Retention policy disabled');

  }

  async getPolicy(id: string): Promise<RetentionPolicy | null> {
    return this.repository.findRetentionPolicyById(id);
  }

  async getAllPolicies(): Promise<RetentionPolicy[]> {
    return this.repository.findAllRetentionPolicies();
  }

  async getPoliciesForEntityType(entityType: EntityType): Promise<RetentionPolicy[]> {
    return this.repository.findRetentionPoliciesByEntityType(entityType);
  }

  async runRetentionCleanup(): Promise<RetentionCleanupResult> {
    const result: RetentionCleanupResult = {
      processedPolicies: 0,
      deletedRecords: {},
      errors: [],
    };

    const policies = await this.repository.findAllRetentionPolicies();

    for (const policy of policies) {
      if (!policy.enabled) continue;

      try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - policy.retentionDays);

        const deletedCount = await this.applyRetentionPolicy(policy, cutoffDate);

        result.deletedRecords[policy.entityType] =
          (result.deletedRecords[policy.entityType] || 0) + deletedCount;
        result.processedPolicies++;

        log.info({
          policyId: policy.id,
          entityType: policy.entityType,
          cutoffDate,
          deletedCount,
        }, 'Applied retention policy');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({
          policyId: policy.id,
          entityType: policy.entityType,
          error: errorMessage,
        });

        log.error({
          error,
          policyId: policy.id,
        }, 'Failed to apply retention policy');
      }
    }

    // Publish summary event
    await publishEvent({
      entityType: 'retention_cleanup',
      entityId: new Date().toISOString(),
      eventType: 'data.retention.cleanup_completed',
      entityVersion: 1,
      eventVersion: 1,
      payload: result as unknown as Record<string, unknown>,
    });

    return result;
  }

  private async applyRetentionPolicy(
    policy: RetentionPolicy,
    cutoffDate: Date
  ): Promise<number> {
    // Get all tenants
    const tenantsResult = await pool.query(
      `SELECT id FROM tenants WHERE deleted_at IS NULL`
    );

    let totalDeleted = 0;

    for (const tenant of tenantsResult.rows) {
      // Create a deletion request for retention cleanup
      const request = await this.deletionService.createDeletionRequest({
        tenantId: tenant.id,
        requestedBy: 'retention-service',
        deletionType: 'retention_cleanup',
        scope: {
          entityTypes: [policy.entityType],
          tenantId: tenant.id,
          olderThan: cutoffDate,
        },
        reason: `Retention policy: ${policy.name}`,
        scheduledFor: new Date(), // Execute immediately
      });

      // Auto-verify for system-initiated cleanup
      await this.deletionService.verifyDeletion(
        request.id,
        request.verificationToken!
      );

      // Execute the deletion
      const completedRequest = await this.deletionService.executeDeletion(request.id);

      totalDeleted += completedRequest.entityCounts[policy.entityType] || 0;
    }

    return totalDeleted;
  }

  async getRetentionStats(): Promise<RetentionStats> {
    const policies = await this.repository.findAllRetentionPolicies();
    const stats: RetentionStats = {
      totalPolicies: policies.length,
      enabledPolicies: policies.filter(p => p.enabled).length,
      byEntityType: {},
      recordCountsByType: {},
    };

    for (const policy of policies) {
      stats.byEntityType[policy.entityType] = {
        retentionDays: policy.retentionDays,
        deletionStrategy: policy.deletionStrategy,
      };
    }

    // Get current record counts
    const entityTypes: EntityType[] = [
      'workflow',
      'action',
      'usage_event',
      'audit_log',
      'connector_record',
      'reflection',
      'feedback',
    ];

    for (const entityType of entityTypes) {
      const tableName = this.getTableName(entityType);
      if (tableName) {
        // Cross-tenant stats aggregation (no tenant filter); dynamic
        // ${tableName} includes audit_log (RLS-enabled) → withAdminScope.
        const result = await withAdminScope(
          { caller: 'retention-service.getRetentionStats', reason: 'cross-tenant record-count stats across all tenants (no tenant filter)' },
          (client) => client.query(
            `SELECT COUNT(*) as count FROM ${tableName} WHERE deleted_at IS NULL`
          ),
        );
        stats.recordCountsByType[entityType] = parseInt(result.rows[0].count, 10);
      }
    }

    return stats;
  }

  private getTableName(entityType: EntityType): string | null {
    const map: Record<EntityType, string> = {
      workflow: 'workflows',
      action: 'actions',
      usage_event: 'usage_events',
      audit_log: 'audit_log',
      connector_record: 'connector_records',
      reflection: 'reflections',
      feedback: 'feedback_requests',
      account: 'accounts',
      tenant: 'tenants',
    };
    return map[entityType] || null;
  }
}

export interface RetentionCleanupResult {
  processedPolicies: number;
  deletedRecords: Partial<Record<EntityType, number>>;
  errors: Array<{
    policyId: string;
    entityType: EntityType;
    error: string;
  }>;
}

export interface RetentionStats {
  totalPolicies: number;
  enabledPolicies: number;
  byEntityType: Partial<Record<
    EntityType,
    { retentionDays: number; deletionStrategy: string }
  >>;
  recordCountsByType: Partial<Record<EntityType, number>>;
}
