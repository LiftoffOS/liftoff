// Archival Service Implementation
// GAP-022 FIX: Implement archival and cleanup service

import { Storage } from '@google-cloud/storage';
import { getPool } from '../infrastructure/database';
import { logger, logAudit } from '../infrastructure/logging';
import {
  ArchivedItem,
  ArchivalEntityType,
  ArchivalJob,
  CleanupJob,
  ArchivalStats,
  ArchiveInput,
  RestoreInput,
} from './types';
import * as zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Default retention policies per entity type
const DEFAULT_RETENTION_DAYS: Record<ArchivalEntityType, number> = {
  workflow: 365,
  task: 180,
  action: 180,
  connector_payload: 90,
  audit_log: 730, // 2 years for compliance
  reflection_data: 365,
  agent_snapshot: 90,
};

export class ArchivalService {
  private storage = new Storage();
  private bucketName = `${process.env.GCP_PROJECT_ID}-archives`;

  // Archive an item to Cloud Storage
  async archive(input: ArchiveInput): Promise<ArchivedItem> {
    const pool = getPool();
    const retentionDays = input.retentionDays || DEFAULT_RETENTION_DAYS[input.entityType];
    const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

    // Serialize and compress data
    const dataJson = JSON.stringify(input.data);
    const compressed = await gzip(Buffer.from(dataJson));

    // Generate GCS path
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const gcsPath = `${input.tenantId}/${input.entityType}/${input.entityId}/${timestamp}.json.gz`;

    // Upload to Cloud Storage
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(gcsPath);
    await file.save(compressed, {
      contentType: 'application/gzip',
      metadata: {
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        archivedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        originalSize: dataJson.length.toString(),
        compressedSize: compressed.length.toString(),
      },
    });

    // Create database record
    const result = await pool.query(
      `INSERT INTO archived_items
       (tenant_id, entity_type, entity_id, archived_at, expires_at, gcs_path, size, metadata, retention_days)
       VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.tenantId,
        input.entityType,
        input.entityId,
        expiresAt,
        gcsPath,
        compressed.length,
        JSON.stringify(input.metadata || {}),
        retentionDays,
      ]
    );

    const archived = this.mapArchivedItem(result.rows[0]);

    logger.info('Item archived', {
      archiveId: archived.id,
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      size: compressed.length,
      expiresAt: expiresAt.toISOString(),
    });

    return archived;
  }

  // Retrieve archived item from Cloud Storage
  async retrieve(archiveId: string): Promise<{ item: ArchivedItem; data: unknown }> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM archived_items WHERE id = $1`,
      [archiveId]
    );

    if (!result.rows[0]) {
      throw new Error(`Archived item not found: ${archiveId}`);
    }

    const item = this.mapArchivedItem(result.rows[0]);

    // Download and decompress from Cloud Storage
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(item.gcsPath);
    const [contents] = await file.download();
    const decompressed = await gunzip(contents);
    const data = JSON.parse(decompressed.toString());

    return { item, data };
  }

  // Run cleanup job to delete expired archives
  async runCleanup(tenantId?: string): Promise<CleanupJob> {
    const pool = getPool();
    const jobId = `cleanup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Create job record
    await pool.query(
      `INSERT INTO cleanup_jobs (id, tenant_id, status, started_at)
       VALUES ($1, $2, 'running', NOW())`,
      [jobId, tenantId || null]
    );

    let itemsScanned = 0;
    let itemsDeleted = 0;
    let spaceFreed = 0;
    const errors: string[] = [];

    try {
      // Find expired items
      let query = `SELECT * FROM archived_items WHERE expires_at < NOW()`;
      const params: (string | null)[] = [];

      if (tenantId) {
        query += ` AND tenant_id = $1`;
        params.push(tenantId);
      }

      const expiredItems = await pool.query(query, params);
      itemsScanned = expiredItems.rows.length;

      logger.info('Starting cleanup job', {
        jobId,
        tenantId,
        expiredItemsFound: itemsScanned,
      });

      // Delete each expired item
      const bucket = this.storage.bucket(this.bucketName);
      for (const row of expiredItems.rows) {
        try {
          const item = this.mapArchivedItem(row);

          // Delete from Cloud Storage
          const file = bucket.file(item.gcsPath);
          const [exists] = await file.exists();
          if (exists) {
            await file.delete();
            spaceFreed += item.size;
          }

          // Delete from database
          await pool.query(`DELETE FROM archived_items WHERE id = $1`, [item.id]);
          itemsDeleted++;
        } catch (error) {
          errors.push(`Failed to delete ${row.id}: ${(error as Error).message}`);
          logger.error('Failed to delete archived item', {
            archiveId: row.id,
            error: (error as Error).message,
          });
        }
      }

      // Update job status
      await pool.query(
        `UPDATE cleanup_jobs SET
         status = 'completed',
         items_scanned = $2,
         items_deleted = $3,
         space_freed = $4,
         errors = $5,
         completed_at = NOW()
         WHERE id = $1`,
        [jobId, itemsScanned, itemsDeleted, spaceFreed, JSON.stringify(errors)]
      );

      logger.info('Cleanup job completed', {
        jobId,
        itemsScanned,
        itemsDeleted,
        spaceFreed,
        errorCount: errors.length,
      });

      logAudit('archival.cleanup_completed', { tenantId: tenantId || 'global' }, {
        action: 'cleanup_completed',
        metadata: {
          jobId,
          itemsDeleted,
          spaceFreed,
        },
      });
    } catch (error) {
      await pool.query(
        `UPDATE cleanup_jobs SET
         status = 'failed',
         items_scanned = $2,
         items_deleted = $3,
         errors = $4,
         completed_at = NOW()
         WHERE id = $1`,
        [jobId, itemsScanned, itemsDeleted, JSON.stringify([...errors, (error as Error).message])]
      );

      throw error;
    }

    return {
      id: jobId,
      tenantId: tenantId || null,
      status: 'completed',
      itemsScanned,
      itemsDeleted,
      spaceFreed,
      errors,
      startedAt: new Date(),
      completedAt: new Date(),
    };
  }

  // Archive old workflows and their related data
  async archiveOldWorkflows(tenantId: string, olderThanDays: number): Promise<ArchivalJob> {
    const pool = getPool();
    const jobId = `archive-workflows-${Date.now()}`;
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO archival_jobs (id, tenant_id, status, entity_type, started_at)
       VALUES ($1, $2, 'running', 'workflow', NOW())`,
      [jobId, tenantId]
    );

    let itemsProcessed = 0;
    let itemsArchived = 0;
    let itemsDeleted = 0;
    const errors: string[] = [];

    try {
      // Find completed workflows older than cutoff
      const workflows = await pool.query(
        `SELECT * FROM workflows
         WHERE tenant_id = $1
           AND status IN ('completed', 'failed')
           AND updated_at < $2`,
        [tenantId, cutoffDate]
      );

      itemsProcessed = workflows.rows.length;

      for (const workflow of workflows.rows) {
        try {
          // Gather all related data
          const tasks = await pool.query(
            `SELECT * FROM workflow_tasks WHERE workflow_id = $1`,
            [workflow.id]
          );
          const actions = await pool.query(
            `SELECT * FROM actions WHERE workflow_id = $1`,
            [workflow.id]
          );

          // Archive the complete workflow data
          await this.archive({
            tenantId,
            entityType: 'workflow',
            entityId: workflow.id,
            data: {
              workflow,
              tasks: tasks.rows,
              actions: actions.rows,
            },
            metadata: {
              taskCount: tasks.rows.length,
              actionCount: actions.rows.length,
              originalStatus: workflow.status,
            },
          });
          itemsArchived++;

          // Delete from active tables
          await pool.query(`DELETE FROM actions WHERE workflow_id = $1`, [workflow.id]);
          await pool.query(`DELETE FROM workflow_tasks WHERE workflow_id = $1`, [workflow.id]);
          await pool.query(`DELETE FROM workflows WHERE id = $1`, [workflow.id]);
          itemsDeleted++;
        } catch (error) {
          errors.push(`Workflow ${workflow.id}: ${(error as Error).message}`);
        }
      }

      await pool.query(
        `UPDATE archival_jobs SET
         status = 'completed',
         items_processed = $2,
         items_archived = $3,
         items_deleted = $4,
         errors = $5,
         completed_at = NOW()
         WHERE id = $1`,
        [jobId, itemsProcessed, itemsArchived, itemsDeleted, JSON.stringify(errors)]
      );

      logger.info('Workflow archival completed', {
        jobId,
        tenantId,
        itemsArchived,
        itemsDeleted,
        errorCount: errors.length,
      });
    } catch (error) {
      await pool.query(
        `UPDATE archival_jobs SET status = 'failed', completed_at = NOW() WHERE id = $1`,
        [jobId]
      );
      throw error;
    }

    return {
      id: jobId,
      tenantId,
      status: 'completed',
      entityType: 'workflow',
      itemsProcessed,
      itemsArchived,
      itemsDeleted,
      errors,
      startedAt: new Date(),
      completedAt: new Date(),
    };
  }

  // Archive old audit logs
  async archiveOldAuditLogs(tenantId: string, olderThanDays: number): Promise<ArchivalJob> {
    const pool = getPool();
    const jobId = `archive-audit-${Date.now()}`;
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO archival_jobs (id, tenant_id, status, entity_type, started_at)
       VALUES ($1, $2, 'running', 'audit_log', NOW())`,
      [jobId, tenantId]
    );

    let itemsProcessed = 0;
    let itemsArchived = 0;
    let itemsDeleted = 0;
    const errors: string[] = [];
    const batchSize = 1000;

    try {
      // Process in batches
      let hasMore = true;
      while (hasMore) {
        const logs = await pool.query(
          `SELECT * FROM audit_log
           WHERE tenant_id = $1 AND timestamp < $2
           ORDER BY timestamp
           LIMIT $3`,
          [tenantId, cutoffDate, batchSize]
        );

        if (logs.rows.length === 0) {
          hasMore = false;
          break;
        }

        itemsProcessed += logs.rows.length;

        // Archive batch
        const batchId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        await this.archive({
          tenantId,
          entityType: 'audit_log',
          entityId: batchId,
          data: logs.rows,
          metadata: {
            batchSize: logs.rows.length,
            oldestTimestamp: logs.rows[0].timestamp,
            newestTimestamp: logs.rows[logs.rows.length - 1].timestamp,
          },
          retentionDays: DEFAULT_RETENTION_DAYS.audit_log,
        });
        itemsArchived += logs.rows.length;

        // Delete archived logs
        const ids = logs.rows.map(r => r.id);
        await pool.query(
          `DELETE FROM audit_log WHERE id = ANY($1)`,
          [ids]
        );
        itemsDeleted += logs.rows.length;
      }

      await pool.query(
        `UPDATE archival_jobs SET
         status = 'completed',
         items_processed = $2,
         items_archived = $3,
         items_deleted = $4,
         completed_at = NOW()
         WHERE id = $1`,
        [jobId, itemsProcessed, itemsArchived, itemsDeleted]
      );

      logger.info('Audit log archival completed', {
        jobId,
        tenantId,
        itemsArchived,
        itemsDeleted,
      });
    } catch (error) {
      await pool.query(
        `UPDATE archival_jobs SET status = 'failed', completed_at = NOW() WHERE id = $1`,
        [jobId]
      );
      throw error;
    }

    return {
      id: jobId,
      tenantId,
      status: 'completed',
      entityType: 'audit_log',
      itemsProcessed,
      itemsArchived,
      itemsDeleted,
      errors,
      startedAt: new Date(),
      completedAt: new Date(),
    };
  }

  // Get archival statistics for a tenant
  async getStats(tenantId: string): Promise<ArchivalStats> {
    const pool = getPool();

    const countResult = await pool.query(
      `SELECT
         entity_type,
         COUNT(*) as count,
         SUM(size) as total_size,
         MIN(archived_at) as oldest,
         MAX(archived_at) as newest
       FROM archived_items
       WHERE tenant_id = $1
       GROUP BY entity_type`,
      [tenantId]
    );

    const lastJobResult = await pool.query(
      `SELECT MAX(completed_at) as last_archival FROM archival_jobs WHERE tenant_id = $1`,
      [tenantId]
    );

    const lastCleanupResult = await pool.query(
      `SELECT MAX(completed_at) as last_cleanup FROM cleanup_jobs WHERE tenant_id = $1 OR tenant_id IS NULL`,
      [tenantId]
    );

    const byEntityType: ArchivalStats['byEntityType'] = {} as ArchivalStats['byEntityType'];
    let totalArchivedItems = 0;
    let totalArchivedSize = 0;

    for (const row of countResult.rows) {
      byEntityType[row.entity_type as ArchivalEntityType] = {
        count: parseInt(row.count),
        size: parseInt(row.total_size) || 0,
        oldestItem: row.oldest,
        newestItem: row.newest,
      };
      totalArchivedItems += parseInt(row.count);
      totalArchivedSize += parseInt(row.total_size) || 0;
    }

    return {
      tenantId,
      totalArchivedItems,
      totalArchivedSize,
      byEntityType,
      lastArchivalAt: lastJobResult.rows[0]?.last_archival || null,
      lastCleanupAt: lastCleanupResult.rows[0]?.last_cleanup || null,
    };
  }

  // List archived items with filtering
  async listArchived(
    tenantId: string,
    options?: {
      entityType?: ArchivalEntityType;
      limit?: number;
      offset?: number;
    }
  ): Promise<ArchivedItem[]> {
    const pool = getPool();
    let query = `SELECT * FROM archived_items WHERE tenant_id = $1`;
    const params: unknown[] = [tenantId];
    let paramIndex = 2;

    if (options?.entityType) {
      query += ` AND entity_type = $${paramIndex}`;
      params.push(options.entityType);
      paramIndex++;
    }

    query += ` ORDER BY archived_at DESC`;

    if (options?.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(options.limit);
      paramIndex++;
    }

    if (options?.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(options.offset);
    }

    const result = await pool.query(query, params);
    return result.rows.map(this.mapArchivedItem);
  }

  // Restore archived item to database
  async restore(input: RestoreInput): Promise<unknown> {
    const { item, data } = await this.retrieve(input.archiveId);

    if (input.targetLocation === 'database') {
      // Restore to appropriate table based on entity type
      await this.restoreToDatabase(item, data);
    }

    logger.info('Item restored from archive', {
      archiveId: input.archiveId,
      entityType: item.entityType,
      entityId: item.entityId,
      targetLocation: input.targetLocation,
    });

    return data;
  }

  private async restoreToDatabase(item: ArchivedItem, data: unknown): Promise<void> {
    const pool = getPool();

    switch (item.entityType) {
      case 'workflow': {
        const workflowData = data as { workflow: any; tasks: any[]; actions: any[] };
        await pool.query(
          `INSERT INTO workflows SELECT * FROM json_populate_record(null::workflows, $1)
           ON CONFLICT (id) DO NOTHING`,
          [JSON.stringify(workflowData.workflow)]
        );
        // Restore tasks and actions would follow similar pattern
        break;
      }
      // Other entity types would have their own restore logic
      default:
        throw new Error(`Restore not supported for entity type: ${item.entityType}`);
    }
  }

  private mapArchivedItem(row: Record<string, unknown>): ArchivedItem {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      entityType: row.entity_type as ArchivalEntityType,
      entityId: row.entity_id as string,
      archivedAt: row.archived_at as Date,
      expiresAt: row.expires_at as Date | null,
      gcsPath: row.gcs_path as string,
      size: row.size as number,
      metadata: typeof row.metadata === 'string'
        ? JSON.parse(row.metadata)
        : row.metadata as Record<string, unknown>,
      retentionPolicy: {
        id: 'default',
        name: 'Default',
        retentionDays: row.retention_days as number,
        entityTypes: [row.entity_type as ArchivalEntityType],
        archiveAfterDays: 0,
        deleteAfterArchival: true,
        compressOnArchive: true,
      },
    };
  }
}

export const archivalService = new ArchivalService();
