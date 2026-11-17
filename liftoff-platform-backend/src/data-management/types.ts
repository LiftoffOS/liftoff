// Data Management Types
// Per Section 21: SOC 2 and GDPR readiness

// Retention Policies
export interface RetentionPolicy {
  id: string;
  name: string;
  entityType: EntityType;
  dataClassification: DataClassification;
  retentionDays: number;
  deletionStrategy: DeletionStrategy;
  archiveBeforeDelete: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type EntityType =
  | 'workflow'
  | 'action'
  | 'usage_event'
  | 'audit_log'
  | 'connector_record'
  | 'reflection'
  | 'feedback'
  | 'account'
  | 'tenant';

export type DataClassification =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'restricted'
  | 'pii';

export type DeletionStrategy =
  | 'hard_delete'
  | 'soft_delete'
  | 'anonymize'
  | 'archive_then_delete';

// Export Jobs
export interface ExportJob {
  id: string;
  tenantId: string;
  requestedBy: string;
  exportType: ExportType;
  format: ExportFormat;
  scope: ExportScope;
  filters: ExportFilters;
  status: ExportStatus;
  progress: number;
  totalRecords: number;
  exportedRecords: number;
  outputPath: string | null;
  downloadUrl: string | null;
  downloadExpiresAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export type ExportType =
  | 'full_tenant_export'
  | 'user_data_export'
  | 'workflow_export'
  | 'audit_log_export'
  | 'usage_export';

export type ExportFormat = 'json' | 'csv' | 'parquet';

export type ExportStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'expired';

export interface ExportScope {
  entityTypes: EntityType[];
  dateRange?: {
    start: Date;
    end: Date;
  };
  userIds?: string[];
  agentIds?: string[];
}

export interface ExportFilters {
  includeDeleted?: boolean;
  includePii?: boolean;
  /**
   * Apply anonymization to the export output.
   *
   * Requires `EXPORT_ANONYMIZE_ENABLED=true` in the environment;
   * `executeExport` throws if this flag is true but the env gate is unset.
   *
   * Three layers:
   *   1. Structured columns listed in PII_COLUMNS are nulled with '[REDACTED]'.
   *   2. All remaining string leaves (including those inside JSONB) are
   *      scrubbed via redactPii (pattern-based).
   *   3. A `compliance.export_anonymized` audit row records the redaction
   *      version, layer-1 column-kill count, and per-pattern layer-2 counts.
   *      Output blob metadata is tagged with `anonymized: true` and
   *      `redaction-version: <semver>`.
   *
   * NOT a re-identification-bounded guarantee — names, addresses, and
   * non-pattern PII pass through. Operator-only use; not exposed via any
   * customer-facing route.
   */
  anonymize?: boolean;
}

// Deletion Requests
export interface DeletionRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  deletionType: DeletionType;
  scope: DeletionScope;
  reason: string;
  status: DeletionStatus;
  verificationToken: string | null;
  verifiedAt: Date | null;
  scheduledFor: Date;
  executedAt: Date | null;
  entityCounts: Record<EntityType, number>;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DeletionType =
  | 'tenant_deletion'
  | 'user_data_deletion'
  | 'data_category_deletion'
  | 'retention_cleanup';

export type DeletionStatus =
  | 'pending_verification'
  | 'verified'
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface DeletionScope {
  entityTypes: EntityType[];
  tenantId?: string;
  userId?: string;
  olderThan?: Date;
}

// Input types
export interface CreateRetentionPolicyInput {
  name: string;
  entityType: EntityType;
  dataClassification: DataClassification;
  retentionDays: number;
  deletionStrategy: DeletionStrategy;
  archiveBeforeDelete?: boolean;
}

export interface CreateExportJobInput {
  tenantId: string;
  requestedBy: string;
  exportType: ExportType;
  format: ExportFormat;
  scope: ExportScope;
  filters?: ExportFilters;
}

export interface CreateDeletionRequestInput {
  tenantId: string;
  requestedBy: string;
  deletionType: DeletionType;
  scope: DeletionScope;
  reason: string;
  scheduledFor?: Date;
}

export interface VerifyDeletionInput {
  requestId: string;
  verificationToken: string;
}
