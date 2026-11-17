// Export Service
// Per Section 21: Data export workflows for GDPR compliance

import { Storage } from '@google-cloud/storage';
import { DataManagementRepository } from './repository';
import {
  ExportJob,
  CreateExportJobInput,
  EntityType,
  ExportScope,
  ExportFilters,
} from './types';
import { pool, withTenantScope } from '../infrastructure/database';
import { log, logAudit } from '../infrastructure/logging';
import { publishEvent } from '../events/publisher';
import { parquetWriter } from './parquet-writer';
import { AccountService } from '../accounts/service';
// `dist/redaction` path (not the cleaner `/redaction` subpath) because
// this repo's tsconfig uses classic node moduleResolution, which does not
// honor the proto package's `exports` map.
import {
  REDACTION_VERSION,
  redactPiiDeep,
  redactPiiWithCounters,
  type RedactionCounters,
} from '@liftoffos/proto-gen/dist/redaction';

// `requestedBy` in our types is the Firebase UID (pre-existing column
// shape). The unified audit feed filters `audit_log.user_id IS NOT NULL`
// AND requires user_id to be a valid UUID. Firebase UIDs are 28 chars,
// not UUIDs — they'd be NULLed by the flush's validateUuid and the audit
// row wouldn't surface. Resolve to accountId here.
const _accountService = new AccountService();
async function actorAccountId(firebaseUidOrAccountId: string): Promise<string | undefined> {
  // If the caller already passed an accountId (UUID), return it as-is.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(firebaseUidOrAccountId)) {
    return firebaseUidOrAccountId;
  }
  const account = await _accountService.getByFirebaseUid(firebaseUidOrAccountId);
  return account?.id;
}

// Table mappings for each entity type
const ENTITY_TABLE_MAP: Record<EntityType, string> = {
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

// Structured PII columns to null wholesale when anonymize=true (Layer 1).
// JSONB columns and unstructured text are additionally handled by Layer 2
// (recursive pattern scrub via redactPiiDeep) so we don't need every
// possible PII shape listed here — only the structured columns whose
// values are typed PII that may not lexically match any regex (e.g., a
// `name` column where the value is "Alice Smith").
//
// At runtime, validatePiiColumnsAgainstSchema() asserts every name here
// actually exists on the live table; a rename causes a loud failure
// rather than a silent skip.
const PII_COLUMNS: Record<EntityType, string[]> = {
  workflow: [],
  action: [],
  usage_event: [],
  // platform-backend audit_log (control plane) — actual columns from
  // migrations/002_audit_log.sql. previous_state/new_state/metadata are
  // JSONB; layer 2 walks them.
  audit_log: ['ip_address', 'user_agent'],
  // connector_records.data is JSONB holding raw third-party payloads
  // (HRIS, Slack, Salesforce, etc.). Layer 2 walks it; no Layer 1 entry
  // — we don't want to null the entire blob, we want pattern scrub on
  // its string leaves.
  connector_record: [],
  reflection: [],
  feedback: ['description', 'context'],
  account: ['email', 'name'],
  // tenants table (001_initial_schema.sql:31) carries the company name as
  // `name`. The original plan listed billing_email/contact_name, neither of
  // which has ever existed on the tenants table — schema-assert would have
  // hard-failed any tenant-scoped anonymized export.
  tenant: ['name'],
};

// Live-schema check: every column in PII_COLUMNS[entityType] must exist
// on its table, otherwise a rename has happened and we'd silently skip
// the redaction. Cache is per-instance (see ExportService) so test isolation
// works; in prod the service is constructed once per process and the cache
// behaves like a process-lifetime memo.

export class ExportService {
  private repository = new DataManagementRepository();
  private storage = new Storage();
  private bucketName = process.env.EXPORT_BUCKET || 'exports';
  private schemaCache = new Map<string, Set<string>>();

  private async loadTableColumns(tableName: string): Promise<Set<string>> {
    const cached = this.schemaCache.get(tableName);
    if (cached) return cached;
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [tableName],
    );
    const cols = new Set<string>(result.rows.map((r: { column_name: string }) => r.column_name));
    this.schemaCache.set(tableName, cols);
    return cols;
  }

  private async assertPiiColumnsExist(entityTypes: EntityType[]): Promise<void> {
    for (const entityType of entityTypes) {
      const cols = PII_COLUMNS[entityType] ?? [];
      if (cols.length === 0) continue;
      const tableName = ENTITY_TABLE_MAP[entityType];
      if (!tableName) continue;
      const live = await this.loadTableColumns(tableName);
      if (live.size === 0) {
        throw new Error(
          `PII_COLUMNS schema drift: table=${tableName} does not exist in the database. ` +
          `Either remove the entity from PII_COLUMNS / ENTITY_TABLE_MAP, or add the table.`,
        );
      }
      const missing = cols.filter(c => !live.has(c));
      if (missing.length > 0) {
        throw new Error(
          `PII_COLUMNS schema drift: table=${tableName} missing=${missing.join(',')}. ` +
          `Update PII_COLUMNS in export-service.ts to match the live schema.`,
        );
      }
    }
  }

  async createExportJob(input: CreateExportJobInput): Promise<ExportJob> {
    const job = await this.repository.createExportJob(input);

    const userId = await actorAccountId(input.requestedBy);
    logAudit(
      'compliance.export_requested',
      { tenantId: input.tenantId, userId },
      {
        resourceType: 'export_job',
        resourceId: job.id,
        newState: {
          exportType: input.exportType,
          format: input.format,
          scope: input.scope,
        },
      },
    );

    log.info({
      jobId: job.id,
      tenantId: input.tenantId,
      exportType: input.exportType,
    }, 'Export job created');

    return job;
  }

  async executeExport(jobId: string): Promise<ExportJob> {
    const job = await this.repository.findExportJobById(jobId);
    if (!job) throw new Error(`Export job ${jobId} not found`);
    if (job.status !== 'pending') {
      throw new Error(`Export job ${jobId} is not in pending state`);
    }

    // Layer 3 — runtime guard. anonymize=true requires explicit env enable.
    if (job.filters.anonymize && process.env.EXPORT_ANONYMIZE_ENABLED !== 'true') {
      await this.repository.updateExportJobStatus(jobId, 'failed', {
        errorMessage: 'Anonymized export attempted with EXPORT_ANONYMIZE_ENABLED unset',
      });
      throw new Error(
        'Anonymized export attempted but EXPORT_ANONYMIZE_ENABLED is not "true". ' +
        'Anonymized exports are operator-only and require the env gate to be set ' +
        'in the Cloud Run service config.',
      );
    }

    // If anonymizing, assert PII_COLUMNS matches the live schema for the
    // tables we'll touch. Loud failure beats silent skip. On throw we
    // mark the job 'failed' so processPendingExports won't retry it
    // every poll cycle.
    if (job.filters.anonymize) {
      try {
        await this.assertPiiColumnsExist(job.scope.entityTypes);
      } catch (error) {
        await this.repository.updateExportJobStatus(jobId, 'failed', {
          errorMessage: error instanceof Error ? error.message : 'Schema drift check failed',
        });
        throw error;
      }
    }

    await this.repository.updateExportJobStatus(jobId, 'running');

    try {
      const totalRecords = await this.countRecords(job.tenantId, job.scope);
      await this.repository.updateExportJobStatus(jobId, 'running', { totalRecords });

      // Accumulate Layer 1 + Layer 2 counters across the whole export
      // for the compliance.export_anonymized audit row.
      const redactionCounters: { layer1Kills: number; layer2: RedactionCounters } = {
        layer1Kills: 0,
        layer2: {},
      };

      const outputPath = await this.exportData(job, totalRecords, redactionCounters);
      const downloadUrl = await this.generateDownloadUrl(outputPath);
      const downloadExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const completedJob = await this.repository.updateExportJobStatus(
        jobId,
        'completed',
        {
          progress: 100,
          exportedRecords: totalRecords,
          outputPath,
          downloadUrl,
          downloadExpiresAt,
        },
      );

      const userId = await actorAccountId(job.requestedBy);
      logAudit(
        'compliance.export_completed',
        { tenantId: job.tenantId, userId },
        {
          resourceType: 'export_job',
          resourceId: jobId,
          newState: { jobId, totalRecords, outputPath },
        },
      );

      if (job.filters.anonymize) {
        logAudit(
          'compliance.export_anonymized',
          { tenantId: job.tenantId, userId },
          {
            resourceType: 'export_job',
            resourceId: jobId,
            newState: {
              jobId,
              redactionVersion: REDACTION_VERSION,
              layer1Kills: redactionCounters.layer1Kills,
              layer2Counters: redactionCounters.layer2,
              totalRecords,
            },
          },
        );
      }

      await publishEvent({
        entityType: 'export_job',
        entityId: jobId,
        eventType: 'data.export.completed',
        entityVersion: 1,
        eventVersion: 1,
        tenantId: job.tenantId,
        payload: { downloadUrl, expiresAt: downloadExpiresAt },
      });

      log.info({ jobId, tenantId: job.tenantId, totalRecords }, 'Export completed');
      return completedJob;
    } catch (error) {
      log.error({ error, jobId }, 'Export failed');
      await this.repository.updateExportJobStatus(jobId, 'failed', {
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private async countRecords(tenantId: string, scope: ExportScope): Promise<number> {
    let totalCount = 0;

    for (const entityType of scope.entityTypes) {
      const tableName = ENTITY_TABLE_MAP[entityType];
      if (!tableName) continue;

      const conditions: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let paramIndex = 2;

      if (scope.dateRange) {
        conditions.push(`created_at >= $${paramIndex++}`);
        params.push(scope.dateRange.start);
        conditions.push(`created_at <= $${paramIndex++}`);
        params.push(scope.dateRange.end);
      }

      // Only count non-deleted records unless includeDeleted
      conditions.push(`deleted_at IS NULL`);

      // Dynamic ${tableName} from ENTITY_TABLE_MAP; audit_log is RLS-enabled.
      // Per-tenant export (WHERE tenant_id = $1) → withTenantScope.
      const result = await withTenantScope(tenantId, (client) => client.query(
        `SELECT COUNT(*) as count FROM ${tableName} WHERE ${conditions.join(' AND ')}`,
        params
      ));

      totalCount += parseInt(result.rows[0].count, 10);
    }

    return totalCount;
  }

  private async exportData(
    job: ExportJob,
    totalRecords: number,
    counters: { layer1Kills: number; layer2: RedactionCounters },
  ): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = `exports/${job.tenantId}/${job.id}/${timestamp}.${job.format}`;

    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(outputPath);

    const allData: Record<string, unknown[]> = {};
    let exportedCount = 0;

    for (const entityType of job.scope.entityTypes) {
      const tableName = ENTITY_TABLE_MAP[entityType];
      if (!tableName) continue;

      const data = await this.fetchEntityData(
        tableName,
        entityType,
        job.tenantId,
        job.scope,
        job.filters,
        counters,
      );

      allData[entityType] = data;
      exportedCount += data.length;

      const progress = Math.round((exportedCount / totalRecords) * 100);
      await this.repository.updateExportJobStatus(job.id, 'running', {
        progress,
        exportedRecords: exportedCount,
      });
    }

    let content: string | Buffer;
    if (job.format === 'json') {
      content = JSON.stringify(allData, null, 2);
    } else if (job.format === 'csv') {
      content = this.convertToCSV(allData as Record<string, Record<string, unknown>[]>);
    } else if (job.format === 'parquet') {
      content = await parquetWriter.writeMultipleEntityTypes(
        allData as Record<EntityType, Record<string, unknown>[]>,
      );
      log.info({ jobId: job.id, parquetSize: content.length }, 'Generated Parquet export');
    } else {
      content = JSON.stringify(allData, null, 2);
    }

    // Tag the output blob with the anonymization version for downstream
    // verification. Only set when anonymize is enabled.
    const blobMetadata: Record<string, string> = {
      tenantId: job.tenantId,
      jobId: job.id,
      exportType: job.exportType,
    };
    if (job.filters.anonymize) {
      blobMetadata.anonymized = 'true';
      blobMetadata.redactionVersion = REDACTION_VERSION;
    }

    await file.save(content, {
      contentType: this.getContentType(job.format),
      metadata: blobMetadata,
    });

    return outputPath;
  }

  private async fetchEntityData(
    tableName: string,
    entityType: EntityType,
    tenantId: string,
    scope: ExportScope,
    filters: ExportFilters,
    counters: { layer1Kills: number; layer2: RedactionCounters },
  ): Promise<Record<string, unknown>[]> {
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let paramIndex = 2;

    if (scope.dateRange) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(scope.dateRange.start);
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(scope.dateRange.end);
    }

    if (!filters.includeDeleted) {
      conditions.push(`deleted_at IS NULL`);
    }

    // Dynamic ${tableName} from ENTITY_TABLE_MAP; audit_log is RLS-enabled.
    // Per-tenant export (WHERE tenant_id = $1) → withTenantScope.
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM ${tableName} WHERE ${conditions.join(' AND ')}`,
      params,
    ));

    let data: Record<string, unknown>[] = result.rows;

    if (filters.anonymize) {
      data = this.anonymizeData(data, entityType, counters);
    }

    return data;
  }

  /**
   * Three-layer anonymization (gate already validated in executeExport):
   *
   *   Layer 1: structured PII columns nulled with '[REDACTED]'.
   *   Layer 2: every remaining string leaf scrubbed via redactPiiDeep
   *            (recursive — handles JSONB blobs like connector_records.data).
   *
   * Counter mutation is intentional: executeExport accumulates totals
   * across all entity types for the compliance.export_anonymized audit
   * row.
   */
  private anonymizeData(
    data: Record<string, unknown>[],
    entityType: EntityType,
    counters: { layer1Kills: number; layer2: RedactionCounters },
  ): Record<string, unknown>[] {
    const piiColumns = PII_COLUMNS[entityType] ?? [];

    return data.map(row => {
      // Layer 1: null structured PII columns.
      const layer1: Record<string, unknown> = { ...row };
      for (const column of piiColumns) {
        if (layer1[column] !== null && layer1[column] !== undefined) {
          layer1[column] = '[REDACTED]';
          counters.layer1Kills++;
        }
      }

      // Layer 2: recursive pattern scrub on what survives.
      // We do this per-row rather than once per export so the layer-2
      // counter accumulates correctly per field.
      const scrubbed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(layer1)) {
        if (typeof v === 'string') {
          const { redacted, counters: hits } = redactPiiWithCounters(v);
          scrubbed[k] = redacted;
          for (const [pattern, n] of Object.entries(hits)) {
            counters.layer2[pattern] = (counters.layer2[pattern] ?? 0) + n;
          }
        } else {
          // For objects/arrays/JSONB, redactPiiDeep does the walking.
          // Note: redactPiiDeep here uses redactPii internally so the
          // per-pattern counters are not accumulated for nested leaves;
          // the aggregate "scrubbed N records" is still accurate for the
          // audit-row narrative. (If finer-grained nested counters are
          // ever needed, swap to a recursive variant that accepts a
          // counter accumulator — out of scope for this change.)
          scrubbed[k] = redactPiiDeep(v);
        }
      }
      return scrubbed;
    });
  }

  private convertToCSV(data: Record<string, Record<string, unknown>[]>): string {
    const lines: string[] = [];

    for (const [entityType, records] of Object.entries(data)) {
      if (records.length === 0) continue;

      // Add entity type header
      lines.push(`# ${entityType}`);

      // Add column headers
      const headers = Object.keys(records[0]);
      lines.push(headers.join(','));

      // Add data rows
      for (const record of records) {
        const values = headers.map(h => {
          const value = record[h];
          if (value === null || value === undefined) return '';
          if (typeof value === 'object') return JSON.stringify(value);
          return String(value).includes(',') ? `"${value}"` : String(value);
        });
        lines.push(values.join(','));
      }

      lines.push(''); // Blank line between entity types
    }

    return lines.join('\n');
  }

  private getContentType(format: string): string {
    switch (format) {
      case 'json':
        return 'application/json';
      case 'csv':
        return 'text/csv';
      case 'parquet':
        return 'application/octet-stream';
      default:
        return 'application/octet-stream';
    }
  }

  private async generateDownloadUrl(outputPath: string): Promise<string> {
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(outputPath);

    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    });

    return signedUrl;
  }

  async getExportJob(jobId: string): Promise<ExportJob | null> {
    return this.repository.findExportJobById(jobId);
  }

  async getTenantExportJobs(tenantId: string, limit?: number): Promise<ExportJob[]> {
    return this.repository.findExportJobsByTenant(tenantId, limit);
  }

  async logDownload(jobId: string, userId: string, ipAddress: string | null): Promise<void> {
    const job = await this.repository.findExportJobById(jobId);
    if (!job) return;

    const resolvedUserId = await actorAccountId(userId);
    logAudit(
      'compliance.export_downloaded',
      { tenantId: job.tenantId, userId: resolvedUserId },
      {
        resourceType: 'export_job',
        resourceId: jobId,
        newState: { jobId },
        ipAddress: ipAddress ?? undefined,
      },
    );
  }

  async processPendingExports(): Promise<number> {
    const pending = await this.repository.findPendingExportJobs();
    let processedCount = 0;

    for (const job of pending) {
      try {
        await this.executeExport(job.id);
        processedCount++;
      } catch (error) {
        log.error({
          error,
          jobId: job.id,
        }, 'Failed to process pending export');
      }
    }

    return processedCount;
  }
}
