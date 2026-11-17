// Payload Archiver
// Per Section 11: Raw payload archived in Cloud Storage

import { Storage } from '@google-cloud/storage';
import { pool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { v4 as uuidv4 } from 'uuid';

const storage = new Storage();
const ARCHIVE_BUCKET = process.env.PAYLOAD_ARCHIVE_BUCKET || 'payload-archive';

export type PayloadType = 'webhook' | 'api_response' | 'poll_result' | 'writeback';

export interface ArchivedPayload {
  id: string;
  tenantId: string;
  connectorId: string;
  payloadType: PayloadType;
  gcsPath: string;
  size: number;
  checksum: string;
  metadata: Record<string, string>;
  createdAt: Date;
  expiresAt?: Date;
}

export interface ArchiveOptions {
  tenantId: string;
  connectorId: string;
  agentId?: string;
  payloadType: PayloadType;
  payload: any;
  metadata?: Record<string, string>;
  retentionDays?: number;
}

export class PayloadArchiver {
  private bucket = storage.bucket(ARCHIVE_BUCKET);

  // Per Section 11: Archive raw payload to Cloud Storage
  async archive(options: ArchiveOptions): Promise<ArchivedPayload> {
    const {
      tenantId,
      connectorId,
      payloadType,
      payload,
      metadata = {},
      retentionDays = 90,
    } = options;

    const id = uuidv4();
    const timestamp = new Date();
    const datePrefix = this.getDatePrefix(timestamp);

    // Build GCS path: tenant/connector/type/date/id.json
    const gcsPath = `${tenantId}/${connectorId}/${payloadType}/${datePrefix}/${id}.json`;

    // Serialize payload
    const serialized = JSON.stringify(payload, null, 2);
    const buffer = Buffer.from(serialized, 'utf-8');
    const size = buffer.length;

    // Calculate checksum
    const crypto = await import('crypto');
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    // Upload to Cloud Storage
    const file = this.bucket.file(gcsPath);
    await file.save(buffer, {
      contentType: 'application/json',
      metadata: {
        tenantId,
        connectorId,
        payloadType,
        archiveId: id,
        checksum,
        ...metadata,
      },
    });

    // Set retention if configured
    const expiresAt = new Date(timestamp.getTime() + retentionDays * 24 * 60 * 60 * 1000);

    // Record in database for indexing
    await pool.query(
      `INSERT INTO archived_payloads
       (id, tenant_id, connector_id, payload_type, gcs_path, size, checksum, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, tenantId, connectorId, payloadType, gcsPath, size, checksum, JSON.stringify(metadata), expiresAt]
    );

    logger.info('Payload archived', {
      id,
      tenantId,
      connectorId,
      payloadType,
      gcsPath,
      size,
    });

    return {
      id,
      tenantId,
      connectorId,
      payloadType,
      gcsPath,
      size,
      checksum,
      metadata,
      createdAt: timestamp,
      expiresAt,
    };
  }

  // Retrieve archived payload
  async retrieve(archiveId: string): Promise<{ payload: any; metadata: ArchivedPayload }> {
    // Get metadata from database
    const result = await pool.query(
      `SELECT * FROM archived_payloads WHERE id = $1`,
      [archiveId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Archived payload not found: ${archiveId}`);
    }

    const row = result.rows[0];
    const metadata: ArchivedPayload = {
      id: row.id,
      tenantId: row.tenant_id,
      connectorId: row.connector_id,
      payloadType: row.payload_type,
      gcsPath: row.gcs_path,
      size: row.size,
      checksum: row.checksum,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };

    // Download from Cloud Storage
    const file = this.bucket.file(metadata.gcsPath);
    const [content] = await file.download();

    // Verify checksum
    const crypto = await import('crypto');
    const actualChecksum = crypto.createHash('sha256').update(content).digest('hex');
    if (actualChecksum !== metadata.checksum) {
      logger.error('Payload checksum mismatch', {
        archiveId,
        expected: metadata.checksum,
        actual: actualChecksum,
      });
      throw new Error('Payload integrity check failed');
    }

    const payload = JSON.parse(content.toString('utf-8'));

    return { payload, metadata };
  }

  // List archived payloads for a tenant
  async list(
    tenantId: string,
    options: {
      connectorId?: string;
      payloadType?: PayloadType;
      startDate?: Date;
      endDate?: Date;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ payloads: ArchivedPayload[]; total: number }> {
    const conditions: string[] = ['tenant_id = $1'];
    const params: any[] = [tenantId];
    let paramIndex = 2;

    if (options.connectorId) {
      conditions.push(`connector_id = $${paramIndex++}`);
      params.push(options.connectorId);
    }

    if (options.payloadType) {
      conditions.push(`payload_type = $${paramIndex++}`);
      params.push(options.payloadType);
    }

    if (options.startDate) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(options.startDate);
    }

    if (options.endDate) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(options.endDate);
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as count FROM archived_payloads WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Get paginated results
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const result = await pool.query(
      `SELECT * FROM archived_payloads
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );

    const payloads = result.rows.map(row => ({
      id: row.id,
      tenantId: row.tenant_id,
      connectorId: row.connector_id,
      payloadType: row.payload_type,
      gcsPath: row.gcs_path,
      size: row.size,
      checksum: row.checksum,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));

    return { payloads, total };
  }

  // Delete expired payloads
  async cleanupExpired(): Promise<number> {
    // Get expired payloads
    const result = await pool.query(
      `SELECT id, gcs_path FROM archived_payloads WHERE expires_at < NOW()`
    );

    let deletedCount = 0;

    for (const row of result.rows) {
      try {
        // Delete from Cloud Storage
        const file = this.bucket.file(row.gcs_path);
        await file.delete({ ignoreNotFound: true });

        // Delete from database
        await pool.query(`DELETE FROM archived_payloads WHERE id = $1`, [row.id]);

        deletedCount++;
      } catch (error) {
        logger.error('Failed to delete expired payload', {
          archiveId: row.id,
          gcsPath: row.gcs_path,
          error,
        });
      }
    }

    logger.info('Expired payloads cleaned up', { deletedCount });
    return deletedCount;
  }

  // Replay payloads for reconciliation or debugging
  async getPayloadsForReplay(
    tenantId: string,
    connectorId: string,
    startDate: Date,
    endDate: Date
  ): Promise<ArchivedPayload[]> {
    const result = await pool.query(
      `SELECT * FROM archived_payloads
       WHERE tenant_id = $1
         AND connector_id = $2
         AND created_at >= $3
         AND created_at <= $4
       ORDER BY created_at ASC`,
      [tenantId, connectorId, startDate, endDate]
    );

    return result.rows.map(row => ({
      id: row.id,
      tenantId: row.tenant_id,
      connectorId: row.connector_id,
      payloadType: row.payload_type,
      gcsPath: row.gcs_path,
      size: row.size,
      checksum: row.checksum,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  private getDatePrefix(date: Date): string {
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  }
}

export const payloadArchiver = new PayloadArchiver();
