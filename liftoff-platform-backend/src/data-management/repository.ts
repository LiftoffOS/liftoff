// Data Management Repository
// Per Section 21: SOC 2 and GDPR readiness

import { withAdminScope } from '../infrastructure/database';
import {
  RetentionPolicy,
  ExportJob,
  ExportStatus,
  DeletionRequest,
  DeletionStatus,
  EntityType,
  CreateRetentionPolicyInput,
  CreateExportJobInput,
  CreateDeletionRequestInput,
} from './types';
import { randomUUID } from 'crypto';

// export_jobs and deletion_requests are FORCE RLS (migration 339). This module
// is operator-facing compliance tooling and several of its reads are inherently
// cross-tenant — the pending-export sweep, the scheduled-deletion sweep, and the
// verification-token lookup all run before any tenant is known, because the row
// is what identifies the tenant. Admin scope is the sanctioned primitive for
// that; the router restricts every entry point to authenticated operators.
async function adminQuery(
  text: string,
  values?: unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
  return withAdminScope(
    { caller: 'data-management.repository', reason: 'cross-tenant compliance exports, deletions and retention policy config' },
    async (client) => {
      const r = await client.query(text, values as never);
      return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount };
    },
  );
}

export class DataManagementRepository {
  // Retention Policies
  async createRetentionPolicy(input: CreateRetentionPolicyInput): Promise<RetentionPolicy> {
    const result = await adminQuery(
      `INSERT INTO retention_policies
       (name, entity_type, data_classification, retention_days, deletion_strategy, archive_before_delete, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING *`,
      [
        input.name,
        input.entityType,
        input.dataClassification,
        input.retentionDays,
        input.deletionStrategy,
        input.archiveBeforeDelete ?? false,
      ]
    );
    return this.mapRetentionPolicyRow(result.rows[0]);
  }

  async findRetentionPolicyById(id: string): Promise<RetentionPolicy | null> {
    const result = await adminQuery(
      `SELECT * FROM retention_policies WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapRetentionPolicyRow(result.rows[0]) : null;
  }

  async findRetentionPoliciesByEntityType(entityType: EntityType): Promise<RetentionPolicy[]> {
    const result = await adminQuery(
      `SELECT * FROM retention_policies WHERE entity_type = $1 AND enabled = true`,
      [entityType]
    );
    return result.rows.map(this.mapRetentionPolicyRow);
  }

  async findAllRetentionPolicies(): Promise<RetentionPolicy[]> {
    const result = await adminQuery(
      `SELECT * FROM retention_policies ORDER BY entity_type, created_at`
    );
    return result.rows.map(this.mapRetentionPolicyRow);
  }

  async updateRetentionPolicy(id: string, updates: Partial<CreateRetentionPolicyInput>): Promise<RetentionPolicy> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [id];
    let paramIndex = 2;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.retentionDays !== undefined) {
      setClauses.push(`retention_days = $${paramIndex++}`);
      params.push(updates.retentionDays);
    }
    if (updates.deletionStrategy !== undefined) {
      setClauses.push(`deletion_strategy = $${paramIndex++}`);
      params.push(updates.deletionStrategy);
    }
    if (updates.archiveBeforeDelete !== undefined) {
      setClauses.push(`archive_before_delete = $${paramIndex++}`);
      params.push(updates.archiveBeforeDelete);
    }

    const result = await adminQuery(
      `UPDATE retention_policies SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return this.mapRetentionPolicyRow(result.rows[0]);
  }

  async disableRetentionPolicy(id: string): Promise<void> {
    await adminQuery(
      `UPDATE retention_policies SET enabled = false, updated_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  // Export Jobs
  async createExportJob(input: CreateExportJobInput): Promise<ExportJob> {
    const result = await adminQuery(
      `INSERT INTO export_jobs
       (tenant_id, requested_by, export_type, format, scope, filters, status, progress, total_records, exported_records)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, 0, 0)
       RETURNING *`,
      [
        input.tenantId,
        input.requestedBy,
        input.exportType,
        input.format,
        JSON.stringify(input.scope),
        JSON.stringify(input.filters ?? {}),
      ]
    );
    return this.mapExportJobRow(result.rows[0]);
  }

  async updateExportJobStatus(
    id: string,
    status: ExportStatus,
    updates?: {
      progress?: number;
      totalRecords?: number;
      exportedRecords?: number;
      outputPath?: string;
      downloadUrl?: string;
      downloadExpiresAt?: Date;
      errorMessage?: string;
    }
  ): Promise<ExportJob> {
    const setClauses: string[] = ['status = $2', 'updated_at = NOW()'];
    const params: unknown[] = [id, status];
    let paramIndex = 3;

    if (status === 'running' && !updates?.progress) {
      setClauses.push(`started_at = NOW()`);
    }
    if (status === 'completed' || status === 'failed') {
      setClauses.push(`completed_at = NOW()`);
    }

    if (updates?.progress !== undefined) {
      setClauses.push(`progress = $${paramIndex++}`);
      params.push(updates.progress);
    }
    if (updates?.totalRecords !== undefined) {
      setClauses.push(`total_records = $${paramIndex++}`);
      params.push(updates.totalRecords);
    }
    if (updates?.exportedRecords !== undefined) {
      setClauses.push(`exported_records = $${paramIndex++}`);
      params.push(updates.exportedRecords);
    }
    if (updates?.outputPath !== undefined) {
      setClauses.push(`output_path = $${paramIndex++}`);
      params.push(updates.outputPath);
    }
    if (updates?.downloadUrl !== undefined) {
      setClauses.push(`download_url = $${paramIndex++}`);
      params.push(updates.downloadUrl);
    }
    if (updates?.downloadExpiresAt !== undefined) {
      setClauses.push(`download_expires_at = $${paramIndex++}`);
      params.push(updates.downloadExpiresAt);
    }
    if (updates?.errorMessage !== undefined) {
      setClauses.push(`error_message = $${paramIndex++}`);
      params.push(updates.errorMessage);
    }

    const result = await adminQuery(
      `UPDATE export_jobs SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return this.mapExportJobRow(result.rows[0]);
  }

  async findExportJobById(id: string): Promise<ExportJob | null> {
    const result = await adminQuery(
      `SELECT * FROM export_jobs WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapExportJobRow(result.rows[0]) : null;
  }

  async findExportJobsByTenant(tenantId: string, limit = 20): Promise<ExportJob[]> {
    const result = await adminQuery(
      `SELECT * FROM export_jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows.map(this.mapExportJobRow);
  }

  async findPendingExportJobs(): Promise<ExportJob[]> {
    const result = await adminQuery(
      `SELECT * FROM export_jobs WHERE status = 'pending' ORDER BY created_at ASC`
    );
    return result.rows.map(this.mapExportJobRow);
  }

  // Deletion Requests
  async createDeletionRequest(input: CreateDeletionRequestInput): Promise<DeletionRequest> {
    const verificationToken = randomUUID();
    const scheduledFor = input.scheduledFor ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days by default

    const result = await adminQuery(
      `INSERT INTO deletion_requests
       (tenant_id, requested_by, deletion_type, scope, reason, status, verification_token, scheduled_for, entity_counts)
       VALUES ($1, $2, $3, $4, $5, 'pending_verification', $6, $7, '{}')
       RETURNING *`,
      [
        input.tenantId,
        input.requestedBy,
        input.deletionType,
        JSON.stringify(input.scope),
        input.reason,
        verificationToken,
        scheduledFor,
      ]
    );
    return this.mapDeletionRequestRow(result.rows[0]);
  }

  async verifyDeletionRequest(id: string, token: string): Promise<DeletionRequest | null> {
    const result = await adminQuery(
      `UPDATE deletion_requests
       SET status = 'verified', verified_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND verification_token = $2 AND status = 'pending_verification'
       RETURNING *`,
      [id, token]
    );
    return result.rows[0] ? this.mapDeletionRequestRow(result.rows[0]) : null;
  }

  async updateDeletionRequestStatus(
    id: string,
    status: DeletionStatus,
    updates?: {
      entityCounts?: Record<EntityType, number>;
      errorMessage?: string;
    }
  ): Promise<DeletionRequest> {
    const setClauses: string[] = ['status = $2', 'updated_at = NOW()'];
    const params: unknown[] = [id, status];
    let paramIndex = 3;

    if (status === 'completed') {
      setClauses.push(`executed_at = NOW()`);
    }

    if (updates?.entityCounts !== undefined) {
      setClauses.push(`entity_counts = $${paramIndex++}`);
      params.push(JSON.stringify(updates.entityCounts));
    }
    if (updates?.errorMessage !== undefined) {
      setClauses.push(`error_message = $${paramIndex++}`);
      params.push(updates.errorMessage);
    }

    const result = await adminQuery(
      `UPDATE deletion_requests SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return this.mapDeletionRequestRow(result.rows[0]);
  }

  async findDeletionRequestById(id: string): Promise<DeletionRequest | null> {
    const result = await adminQuery(
      `SELECT * FROM deletion_requests WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapDeletionRequestRow(result.rows[0]) : null;
  }

  async findDeletionRequestsByTenant(tenantId: string): Promise<DeletionRequest[]> {
    const result = await adminQuery(
      `SELECT * FROM deletion_requests WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return result.rows.map(this.mapDeletionRequestRow);
  }

  async findScheduledDeletions(): Promise<DeletionRequest[]> {
    const result = await adminQuery(
      `SELECT * FROM deletion_requests
       WHERE status = 'verified' AND scheduled_for <= NOW()
       ORDER BY scheduled_for ASC`
    );
    return result.rows.map(this.mapDeletionRequestRow);
  }

  // Mappers
  private mapRetentionPolicyRow(row: Record<string, unknown>): RetentionPolicy {
    return {
      id: row.id as string,
      name: row.name as string,
      entityType: row.entity_type as EntityType,
      dataClassification: row.data_classification as RetentionPolicy['dataClassification'],
      retentionDays: row.retention_days as number,
      deletionStrategy: row.deletion_strategy as RetentionPolicy['deletionStrategy'],
      archiveBeforeDelete: row.archive_before_delete as boolean,
      enabled: row.enabled as boolean,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private mapExportJobRow(row: Record<string, unknown>): ExportJob {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      requestedBy: row.requested_by as string,
      exportType: row.export_type as ExportJob['exportType'],
      format: row.format as ExportJob['format'],
      scope: row.scope as ExportJob['scope'],
      filters: row.filters as ExportJob['filters'],
      status: row.status as ExportStatus,
      progress: row.progress as number,
      totalRecords: row.total_records as number,
      exportedRecords: row.exported_records as number,
      outputPath: row.output_path as string | null,
      downloadUrl: row.download_url as string | null,
      downloadExpiresAt: row.download_expires_at ? new Date(row.download_expires_at as string) : null,
      errorMessage: row.error_message as string | null,
      createdAt: new Date(row.created_at as string),
      startedAt: row.started_at ? new Date(row.started_at as string) : null,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
    };
  }

  private mapDeletionRequestRow(row: Record<string, unknown>): DeletionRequest {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      requestedBy: row.requested_by as string,
      deletionType: row.deletion_type as DeletionRequest['deletionType'],
      scope: row.scope as DeletionRequest['scope'],
      reason: row.reason as string,
      status: row.status as DeletionStatus,
      verificationToken: row.verification_token as string | null,
      verifiedAt: row.verified_at ? new Date(row.verified_at as string) : null,
      scheduledFor: new Date(row.scheduled_for as string),
      executedAt: row.executed_at ? new Date(row.executed_at as string) : null,
      entityCounts: row.entity_counts as Record<EntityType, number>,
      errorMessage: row.error_message as string | null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

}
