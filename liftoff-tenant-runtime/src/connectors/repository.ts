// Connector Repository

import { pool } from '../infrastructure/database';
import type { Connector, ConnectorStatus, NormalizedRecord } from '@liftoffos/connector-types';

// SyncStats was local to the tenant runtime and not exported by
// @liftoffos/connector-types. Per-connector sync bookkeeping (last run,
// rolling totals, per-session stats) is unique to the webhook/poller
// lifecycle that stays in this repo, so inline here rather than coin a
// new shared package just for this shape.
export interface SyncStats {
  connectorId: string;
  lastSyncAt: Date;
  lastSyncStatus: 'success' | 'partial' | 'failed';
  lastSyncDuration: number;
  lastError?: string;
  lastErrorAt?: Date;
  totalItemsSynced: number;
  totalErrors: number;
  totalSyncs: number;
  averageSyncDuration: number;
  itemsSyncedThisSession: number;
  errorsThisSession: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SyncStatsUpdate {
  lastSyncAt?: Date;
  itemsSynced?: number;
  errors?: number;
  syncDuration?: number;
  lastError?: string;
}

export class ConnectorRepository {
  async listConnectors(): Promise<Connector[]> {
    const result = await pool.query(`SELECT * FROM connectors ORDER BY name`);
    return result.rows.map(this.mapConnector);
  }

  async getConnector(id: string): Promise<Connector | null> {
    const result = await pool.query(`SELECT * FROM connectors WHERE id = $1`, [id]);
    return result.rows[0] ? this.mapConnector(result.rows[0]) : null;
  }

  async getStatus(connectorId: string): Promise<ConnectorStatus> {
    const result = await pool.query(
      `SELECT
        c.id as connector_id,
        c.status,
        c.last_sync_at,
        cs.last_sync_status,
        cs.records_processed,
        cs.error_count
       FROM connectors c
       LEFT JOIN connector_sync_stats cs ON c.id = cs.connector_id
       WHERE c.id = $1`,
      [connectorId]
    );

    const row = result.rows[0];
    return {
      connectorId: row?.connector_id || connectorId,
      status: this.mapHealthStatus(row?.status),
      lastSyncAt: row?.last_sync_at,
      lastSyncStatus: row?.last_sync_status,
      recordsProcessed: row?.records_processed || 0,
      errorCount: row?.error_count || 0,
    };
  }

  async writeNormalizedRecords(tenantId: string, records: NormalizedRecord[]): Promise<void> {
    // Per Section 12: Normalized records are written into tenant Cloud SQL
    for (const record of records) {
      await pool.query(
        `INSERT INTO connector_records (connector_id, entity_type, external_id, data, synced_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (connector_id, entity_type, external_id)
         DO UPDATE SET data = $4, synced_at = $5`,
        [record.connectorId, record.entityType, record.externalId, JSON.stringify(record.data), record.syncedAt]
      );
    }
  }

  private mapConnector(row: any): Connector {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      type: row.type,
      name: row.name,
      status: row.status,
      config: row.config,
      lastSyncAt: row.last_sync_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapHealthStatus(status: string): 'healthy' | 'degraded' | 'error' {
    switch (status) {
      case 'active':
        return 'healthy';
      case 'paused':
        return 'degraded';
      default:
        return 'error';
    }
  }

  // List connectors by tenant
  async listConnectorsByTenant(tenantId: string): Promise<Connector[]> {
    const result = await pool.query(
      `SELECT * FROM connectors WHERE tenant_id = $1 ORDER BY name`,
      [tenantId]
    );
    return result.rows.map(this.mapConnector);
  }

  // Get sync stats for a connector
  async getSyncStats(connectorId: string): Promise<SyncStats | null> {
    const result = await pool.query(
      `SELECT * FROM connector_sync_stats WHERE connector_id = $1`,
      [connectorId]
    );

    if (!result.rows[0]) return null;

    return this.mapSyncStats(result.rows[0]);
  }

  // Update sync stats for a connector (upsert)
  async updateSyncStats(connectorId: string, stats: SyncStats): Promise<void> {
    await pool.query(
      `INSERT INTO connector_sync_stats (
        connector_id,
        last_sync_at,
        last_sync_status,
        last_sync_duration,
        last_error,
        last_error_at,
        total_items_synced,
        total_errors,
        total_syncs,
        average_sync_duration,
        items_synced_this_session,
        errors_this_session,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (connector_id) DO UPDATE SET
        last_sync_at = $2,
        last_sync_status = $3,
        last_sync_duration = $4,
        last_error = $5,
        last_error_at = $6,
        total_items_synced = $7,
        total_errors = $8,
        total_syncs = $9,
        average_sync_duration = $10,
        items_synced_this_session = $11,
        errors_this_session = $12,
        updated_at = $14`,
      [
        connectorId,
        stats.lastSyncAt,
        stats.lastSyncStatus,
        stats.lastSyncDuration,
        stats.lastError,
        stats.lastErrorAt,
        stats.totalItemsSynced,
        stats.totalErrors,
        stats.totalSyncs,
        stats.averageSyncDuration,
        stats.itemsSyncedThisSession,
        stats.errorsThisSession,
        stats.createdAt,
        stats.updatedAt,
      ]
    );
  }

  // Update connector's last sync timestamp
  async updateConnectorLastSync(connectorId: string, lastSyncAt: Date): Promise<void> {
    await pool.query(
      `UPDATE connectors SET last_sync_at = $1, updated_at = NOW() WHERE id = $2`,
      [lastSyncAt, connectorId]
    );
  }

  // Per-connector health summary for GetConnectorHealth RPC.
  // connector_sync_stats has no last_success_at or consecutive_failures columns;
  // approximate lastSuccessAt from last_sync_at when status is 'success'.
  async listConnectorHealthByTenant(tenantId: string): Promise<Array<{
    connectorId: string;
    connectorType: string;
    status: string;
    lastSuccessAt: Date | null;
    consecutiveFailures: number;
  }>> {
    const result = await pool.query(
      `SELECT c.id AS connector_id,
              c.type AS connector_type,
              COALESCE(css.last_sync_status, 'unknown') AS status,
              CASE WHEN css.last_sync_status = 'success' THEN css.last_sync_at ELSE NULL END AS last_success_at
       FROM connectors c
       LEFT JOIN connector_sync_stats css ON css.connector_id = c.id
       WHERE c.tenant_id = $1
         AND c.status = 'active'
       ORDER BY c.id`,
      [tenantId],
    );
    return result.rows.map(r => ({
      connectorId: r.connector_id as string,
      connectorType: r.connector_type as string,
      status: r.status as string,
      lastSuccessAt: r.last_success_at ? new Date(r.last_success_at as string) : null,
      consecutiveFailures: 0,
    }));
  }

  // Map database row to SyncStats
  private mapSyncStats(row: any): SyncStats {
    return {
      connectorId: row.connector_id,
      lastSyncAt: row.last_sync_at,
      lastSyncStatus: row.last_sync_status,
      lastSyncDuration: row.last_sync_duration,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
      totalItemsSynced: row.total_items_synced,
      totalErrors: row.total_errors,
      totalSyncs: row.total_syncs,
      averageSyncDuration: row.average_sync_duration,
      itemsSyncedThisSession: row.items_synced_this_session,
      errorsThisSession: row.errors_this_session,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // Rate limit state management
  async updateRateLimitState(connectorId: string, state: {
    isRateLimited: boolean;
    retryAfter?: number;
    remainingRequests?: number;
    resetAt?: Date;
    rateLimitedAt?: Date;
    rateLimitCount: number;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO connector_rate_limits (connector_id, is_rate_limited, retry_after, remaining_requests, reset_at, rate_limited_at, rate_limit_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (connector_id) DO UPDATE SET
         is_rate_limited = $2,
         retry_after = $3,
         remaining_requests = $4,
         reset_at = $5,
         rate_limited_at = $6,
         rate_limit_count = $7,
         updated_at = NOW()`,
      [connectorId, state.isRateLimited, state.retryAfter, state.remainingRequests, state.resetAt, state.rateLimitedAt, state.rateLimitCount]
    );
  }

  async getRateLimitState(connectorId: string): Promise<{
    isRateLimited: boolean;
    retryAfter?: number;
    remainingRequests?: number;
    resetAt?: Date;
    rateLimitedAt?: Date;
    rateLimitCount: number;
  } | null> {
    const result = await pool.query(
      `SELECT * FROM connector_rate_limits WHERE connector_id = $1`,
      [connectorId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      isRateLimited: row.is_rate_limited,
      retryAfter: row.retry_after,
      remainingRequests: row.remaining_requests,
      resetAt: row.reset_at,
      rateLimitedAt: row.rate_limited_at,
      rateLimitCount: row.rate_limit_count,
    };
  }
}
