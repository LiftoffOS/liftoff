// Connector Service Implementation
// Per Section 12: Connectors and ingestion
// Per Section 11: Raw payload archived in Cloud Storage

import type { Connector, ConnectorStatus, NormalizedRecord as RepositoryNormalizedRecord } from '@liftoffos/connector-types';
import { ConnectorRepository, SyncStats, SyncStatsUpdate } from './repository';
import { Storage } from '@google-cloud/storage';
import { PubSub } from '@google-cloud/pubsub';
import { CloudTasksClient } from '@google-cloud/tasks';
import { normalizePayload as normalize, NormalizedRecord } from './normalizers';
import { payloadArchiver, PayloadType } from './payload-archiver';
import { dataMinimizationService } from '../data-minimization';
import { logger } from '../infrastructure/logging';
import { pool } from '../infrastructure/database';
import { AutonomousLoopController } from '../execution-environments/loop-controller';

const loopController = new AutonomousLoopController();

export class ConnectorService {
  private repository = new ConnectorRepository();
  private storage = new Storage();
  private pubsub = new PubSub();
  private tasksClient = new CloudTasksClient();

  // Per Section 12: For each connector:
  // - credentials live in Secret Manager
  // - webhook or poller runs on Cloud Run
  // - raw payloads are archived in Cloud Storage
  // - normalized records are written into tenant Cloud SQL
  // - change events are emitted
  // - writebacks go through Cloud Tasks and the tool gateway

  async listConnectors(): Promise<Connector[]> {
    return this.repository.listConnectors();
  }

  async getStatus(connectorId: string): Promise<ConnectorStatus> {
    return this.repository.getStatus(connectorId);
  }

  // Per Section 12: Webhook handler
  async handleWebhook(connectorId: string, payload: unknown): Promise<void> {
    const connector = await this.repository.getConnector(connectorId);
    if (!connector) throw new Error('Connector not found');

    logger.info('Processing webhook', {
      connectorId,
      connectorType: connector.type,
      tenantId: connector.tenantId,
    });

    // Step 1: Archive raw payload to Cloud Storage
    await this.archivePayload(connector.tenantId, connectorId, payload);

    // Step 2: Normalize records using connector-specific normalizer
    const normalizedRecords = this.normalizePayload(connector.type, payload);

    // Slack loop control commands: "stop", "continue", "resume"
    if (connector.type === 'slack') {
      for (const record of normalizedRecords) {
        if (record.entityType !== 'message') continue;
        const text = String((record.data as Record<string, unknown>)?.text ?? '').trim();
        if (!/^(stop|stop loop|pause|continue|resume)$/i.test(text)) continue;
        const connRow = await pool.query(
          `SELECT agent_id FROM connectors WHERE id = $1 AND tenant_id = $2`,
          [connectorId, connector.tenantId],
        ).catch(() => null);
        const targetAgentId = connRow?.rows[0]?.agent_id;
        if (!targetAgentId) continue;
        const activeLoop = await loopController.getActiveLoop(connector.tenantId, targetAgentId).catch(() => null);
        if (!activeLoop) continue;
        if (/^(stop|stop loop|pause)$/i.test(text) &&
            (activeLoop.status === 'running' || activeLoop.status === 'pending')) {
          await loopController.stopLoop(activeLoop.id, 'user requested via Slack').catch(() => {});
        } else if (/^(continue|resume)$/i.test(text) && activeLoop.status === 'paused') {
          await loopController.resumeLoop(activeLoop.id).catch(() => {});
        }
      }
    }

    logger.info({
      message: 'Normalized records',
      connectorId,
      recordCount: normalizedRecords.length,
    });

    // Step 2.5: Per Section 21 - Apply data minimization at ingestion
    const minimizedRecords = await Promise.all(
      normalizedRecords.map(async (record) => {
        const minimizationResult = await dataMinimizationService.minimizeData(
          connector.tenantId,
          connector.type,
          record.data as Record<string, unknown>
        );

        if (minimizationResult.redactedFields.length > 0 || minimizationResult.removedFields.length > 0) {
          logger.debug('Applied data minimization', {
            connectorId,
            entityType: record.entityType,
            redactedFields: minimizationResult.redactedFields.length,
            removedFields: minimizationResult.removedFields.length,
          });
        }

        return {
          ...record,
          data: minimizationResult.minimizedData,
        };
      })
    );

    // Step 3: Transform and write to tenant Cloud SQL
    const repositoryRecords: RepositoryNormalizedRecord[] = minimizedRecords.map((record) => ({
      connectorId,
      entityType: record.entityType,
      externalId: record.externalId,
      data: record.data as Record<string, any>,
      syncedAt: record.metadata.syncedAt,
    }));
    await this.repository.writeNormalizedRecords(connector.tenantId, repositoryRecords);

    // Step 4: Emit change events
    await this.emitChangeEvents(connector.tenantId, normalizedRecords);

    // Update sync stats using the service method
    await this.updateSyncStats(connectorId, {
      lastSyncAt: new Date(),
      itemsSynced: normalizedRecords.length,
      errors: 0,
    });
  }

  async triggerSync(connectorId: string): Promise<void> {
    const connector = await this.repository.getConnector(connectorId);
    if (!connector) throw new Error('Connector not found');

    // Per Section 12: Poller runs on Cloud Run via Cloud Tasks
    const projectId = process.env.GCP_PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'us-west1';
    const queue = 'connector-sync';

    const parent = this.tasksClient.queuePath(projectId!, location, queue);
    const serviceUrl = process.env.CONNECTOR_SYNC_URL || `https://connector-sync-${projectId}.run.app`;

    await this.tasksClient.createTask({
      parent,
      task: {
        httpRequest: {
          httpMethod: 'POST',
          url: `${serviceUrl}/sync/${connectorId}`,
          headers: {
            'Content-Type': 'application/json',
          },
          body: Buffer.from(JSON.stringify({
            connectorId,
            tenantId: connector.tenantId,
            connectorType: connector.type,
          })).toString('base64'),
        },
      },
    });

    logger.info('Triggered connector sync', { connectorId, connectorType: connector.type });
  }

  // Per Section 11 & 12: Raw payloads are archived in Cloud Storage
  // This supports replay, reconciliation, auditable writes, and durable downstream processing
  private async archivePayload(
    tenantId: string,
    connectorId: string,
    payload: unknown,
    payloadType: PayloadType = 'webhook',
    agentId?: string,
  ): Promise<string> {
    try {
      const archived = await payloadArchiver.archive({
        tenantId,
        connectorId,
        agentId,
        payloadType,
        payload,
        metadata: {
          source: 'connector_ingestion',
          connectorId,
        },
        retentionDays: 90, // Default 90-day retention
      });

      logger.debug('Archived payload', {
        tenantId,
        connectorId,
        archiveId: archived.id,
        gcsPath: archived.gcsPath,
        size: archived.size,
      });

      return archived.id;
    } catch (error) {
      // Log but don't fail the webhook processing
      logger.error('Failed to archive payload', {
        tenantId,
        connectorId,
        error: (error as Error).message,
      });

      // Fall back to basic archival without database tracking
      const bucketName = `${process.env.GCP_PROJECT_ID}-connector-archives`;
      const bucket = this.storage.bucket(bucketName);
      const filename = `${tenantId}/${connectorId}/${Date.now()}.json`;

      await bucket.file(filename).save(JSON.stringify(payload), {
        contentType: 'application/json',
        metadata: {
          tenantId,
          connectorId,
          archivedAt: new Date().toISOString(),
        },
      });

      return filename;
    }
  }

  // Retrieve archived payloads for replay/debugging
  async getArchivedPayloads(
    tenantId: string,
    connectorId: string,
    startDate: Date,
    endDate: Date
  ) {
    return payloadArchiver.getPayloadsForReplay(tenantId, connectorId, startDate, endDate);
  }

  // Retrieve a specific archived payload
  async getArchivedPayload(archiveId: string) {
    return payloadArchiver.retrieve(archiveId);
  }

  private normalizePayload(connectorType: string, payload: unknown): NormalizedRecord[] {
    // Per Section 12: Normalized records are written into tenant Cloud SQL
    // Uses connector-specific normalizers
    return normalize(connectorType, payload);
  }

  private async emitChangeEvents(tenantId: string, records: NormalizedRecord[]): Promise<void> {
    // Per Section 12: Change events are emitted
    const topicName = `connector-events-${process.env.ENVIRONMENT || 'dev'}`;
    const topic = this.pubsub.topic(topicName);

    for (const record of records) {
      const event = {
        eventId: `${record.externalId}-${record.metadata.version}`,
        tenantId,
        entityType: record.entityType,
        entityId: record.externalId,
        eventType: 'connector.record.synced',
        occurredAt: new Date().toISOString(),
        payload: {
          source: record.metadata.source,
          data: record.data,
        },
      };

      await topic.publishMessage({
        json: event,
        attributes: {
          tenantId,
          entityType: record.entityType,
          source: record.metadata.source,
        },
      });
    }

    logger.info('Emitted change events', { tenantId, eventCount: records.length });
  }

  // Per Section 12: Track sync statistics for connectors
  // Tracks: last sync time, items synced, errors, sync duration
  async updateSyncStats(connectorId: string, update: SyncStatsUpdate): Promise<void> {
    const connector = await this.repository.getConnector(connectorId);
    if (!connector) {
      logger.warn({ message: 'Cannot update sync stats: connector not found', connectorId });
      return;
    }

    logger.debug({
      message: 'Updating sync stats',
      connectorId,
      tenantId: connector.tenantId,
      itemsSynced: update.itemsSynced,
      errors: update.errors,
      syncDuration: update.syncDuration,
    });

    try {
      // Get existing stats to calculate totals
      const existingStats = await this.repository.getSyncStats(connectorId);

      // Build the updated stats
      const updatedStats: SyncStats = {
        connectorId,
        lastSyncAt: update.lastSyncAt || new Date(),
        lastSyncStatus: update.errors && update.errors > 0 ? 'failed' : 'success',
        lastSyncDuration: update.syncDuration || 0,
        lastError: update.lastError,
        lastErrorAt: update.lastError ? new Date() : existingStats?.lastErrorAt,

        // Totals - accumulate from existing
        totalItemsSynced: (existingStats?.totalItemsSynced || 0) + (update.itemsSynced || 0),
        totalErrors: (existingStats?.totalErrors || 0) + (update.errors || 0),
        totalSyncs: (existingStats?.totalSyncs || 0) + 1,

        // Running averages
        averageSyncDuration: this.calculateAverageDuration(
          existingStats?.averageSyncDuration || 0,
          existingStats?.totalSyncs || 0,
          update.syncDuration || 0
        ),

        // Session stats (for current sync)
        itemsSyncedThisSession: update.itemsSynced || 0,
        errorsThisSession: update.errors || 0,

        // Timestamps
        createdAt: existingStats?.createdAt || new Date(),
        updatedAt: new Date(),
      };

      // Persist to database
      await this.repository.updateSyncStats(connectorId, updatedStats);

      // Update connector's lastSyncAt field
      await this.repository.updateConnectorLastSync(connectorId, updatedStats.lastSyncAt);

      logger.info({
        message: 'Sync stats updated',
        connectorId,
        lastSyncStatus: updatedStats.lastSyncStatus,
        itemsSynced: update.itemsSynced,
        totalItemsSynced: updatedStats.totalItemsSynced,
        duration: update.syncDuration,
      });
    } catch (error) {
      logger.error({
        message: 'Failed to update sync stats',
        connectorId,
        error: (error as Error).message,
      });
      // Don't throw - sync stats update failure shouldn't fail the overall sync
    }
  }

  // Get sync statistics for a connector
  async getSyncStats(connectorId: string): Promise<SyncStats | null> {
    return this.repository.getSyncStats(connectorId);
  }

  // Get sync statistics summary for all connectors of a tenant
  async getTenantSyncStatsSummary(tenantId: string): Promise<{
    totalConnectors: number;
    healthyConnectors: number;
    failedConnectors: number;
    totalItemsSynced: number;
    totalErrors: number;
    lastSyncAt: Date | null;
  }> {
    const connectors = await this.repository.listConnectorsByTenant(tenantId);
    const stats = await Promise.all(
      connectors.map((c) => this.repository.getSyncStats(c.id))
    );

    let totalItemsSynced = 0;
    let totalErrors = 0;
    let lastSyncAt: Date | null = null;
    let healthyConnectors = 0;
    let failedConnectors = 0;

    for (const stat of stats) {
      if (!stat) continue;

      totalItemsSynced += stat.totalItemsSynced || 0;
      totalErrors += stat.totalErrors || 0;

      if (!lastSyncAt || (stat.lastSyncAt && stat.lastSyncAt > lastSyncAt)) {
        lastSyncAt = stat.lastSyncAt;
      }

      if (stat.lastSyncStatus === 'success') {
        healthyConnectors++;
      } else if (stat.lastSyncStatus === 'failed') {
        failedConnectors++;
      }
    }

    return {
      totalConnectors: connectors.length,
      healthyConnectors,
      failedConnectors,
      totalItemsSynced,
      totalErrors,
      lastSyncAt,
    };
  }

  // Per-connector health for GetConnectorHealth RPC.
  async listConnectorSyncStats(tenantId: string): Promise<Array<{
    connectorId: string;
    connectorType: string;
    status: string;
    lastSuccessAt: Date | null;
    consecutiveFailures: number;
  }>> {
    return this.repository.listConnectorHealthByTenant(tenantId);
  }

  // Calculate running average for sync duration
  private calculateAverageDuration(
    currentAverage: number,
    currentCount: number,
    newDuration: number
  ): number {
    if (currentCount === 0) return newDuration;
    // Weighted average: (current_avg * count + new_value) / (count + 1)
    return Math.round((currentAverage * currentCount + newDuration) / (currentCount + 1));
  }

  // ===========================================
  // GAP-003 FIX: Connector Writeback Implementation
  // Per Section 11 & 12: Writebacks go through Cloud Tasks and the tool gateway
  // ===========================================

  async writebackToConnector(input: ConnectorWritebackInput): Promise<ConnectorWritebackResult> {
    const connector = await this.repository.getConnector(input.connectorId);
    if (!connector) {
      throw new Error(`Connector ${input.connectorId} not found`);
    }

    logger.info('Processing connector writeback', {
      connectorId: input.connectorId,
      connectorType: connector.type,
      tenantId: connector.tenantId,
      entityType: input.entityType,
      actionType: input.actionType,
    });

    // Step 1: Validate writeback payload against schema
    const validationResult = await this.validateWritebackPayload(
      connector.type,
      input.entityType,
      input.payload
    );

    if (!validationResult.valid) {
      logger.error('Writeback validation failed', {
        connectorId: input.connectorId,
        errors: validationResult.errors,
      });
      return {
        success: false,
        error: `Validation failed: ${validationResult.errors.join(', ')}`,
      };
    }

    // Step 2: Check for conflicts if snapshot provided
    if (input.snapshot) {
      const conflictResult = await this.checkWritebackConflict(
        connector,
        input.entityType,
        input.entityId,
        input.snapshot
      );

      if (conflictResult.hasConflict) {
        logger.warn('Writeback conflict detected', {
          connectorId: input.connectorId,
          entityId: input.entityId,
          conflictingFields: conflictResult.conflictingFields,
        });

        if (input.conflictResolution === 'fail') {
          return {
            success: false,
            error: 'Conflict detected',
            conflict: conflictResult,
          };
        }
        // Apply conflict resolution strategy
        input.payload = await this.resolveWritebackConflict(
          input.payload,
          conflictResult,
          input.conflictResolution || 'last-write-wins'
        );
      }
    }

    // Step 3: Archive writeback payload before sending
    const archiveId = await this.archivePayload(
      connector.tenantId,
      input.connectorId,
      { ...input, archived_at: new Date().toISOString() },
      'writeback',
      input.agentId,
    );

    // Step 4: Enqueue writeback via Cloud Tasks for durability
    const projectId = process.env.GCP_PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'us-west1';
    const queue = 'connector-writeback';

    const parent = this.tasksClient.queuePath(projectId!, location, queue);
    const serviceUrl = process.env.TOOL_GATEWAY_URL || `https://tool-gateway-${projectId}.run.app`;

    const taskId = `wb_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    await this.tasksClient.createTask({
      parent,
      task: {
        name: `${parent}/tasks/${taskId}`,
        httpRequest: {
          httpMethod: 'POST',
          url: `${serviceUrl}/execute`,
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': input.idempotencyKey || taskId,
            'X-Trace-ID': input.traceId || taskId,
          },
          body: Buffer.from(JSON.stringify({
            tenantId: connector.tenantId,
            agentId: input.agentId,
            instructionVersion: input.instructionVersion || 1,
            traceId: input.traceId || taskId,
            idempotencyKey: input.idempotencyKey || taskId,
            connector: connector.type,
            entityType: input.entityType,
            actionType: input.actionType,
            payload: {
              ...input.payload,
              id: input.entityId,
            },
            snapshot: input.snapshot,
          })).toString('base64'),
        },
      },
    });

    logger.info('Writeback enqueued via Cloud Tasks', {
      connectorId: input.connectorId,
      taskId,
      archiveId,
      entityType: input.entityType,
      actionType: input.actionType,
    });

    // Step 5: Emit writeback event
    await this.emitWritebackEvent(connector.tenantId, {
      connectorId: input.connectorId,
      entityType: input.entityType,
      entityId: input.entityId,
      actionType: input.actionType,
      taskId,
      status: 'enqueued',
      agentId: input.agentId,
    });

    return {
      success: true,
      taskId,
      archiveId,
    };
  }

  // Validate writeback payload against connector schema
  private async validateWritebackPayload(
    connectorType: string,
    entityType: string,
    payload: Record<string, unknown>
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Required field validation based on connector and entity type
    const requiredFields = this.getRequiredFieldsForEntity(connectorType, entityType);

    for (const field of requiredFields) {
      if (payload[field] === undefined || payload[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // Type validation
    const fieldTypes = this.getFieldTypesForEntity(connectorType, entityType);
    for (const [field, expectedType] of Object.entries(fieldTypes)) {
      if (payload[field] !== undefined) {
        const actualType = typeof payload[field];
        if (actualType !== expectedType) {
          errors.push(`Field ${field} expected ${expectedType}, got ${actualType}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // Get required fields for entity type (connector-specific)
  private getRequiredFieldsForEntity(connectorType: string, entityType: string): string[] {
    const schemas: Record<string, Record<string, string[]>> = {
      salesforce: {
        Account: ['Name'],
        Contact: ['LastName'],
        Opportunity: ['Name', 'StageName', 'CloseDate'],
        Lead: ['LastName', 'Company'],
      },
      hubspot: {
        contacts: ['email'],
        companies: ['name'],
        deals: ['dealname', 'pipeline', 'dealstage'],
      },
      slack: {
        message: ['channel', 'text'],
      },
      zoom: {
        meetings: ['topic'],
      },
    };

    return schemas[connectorType]?.[entityType] || [];
  }

  // Get field types for validation
  private getFieldTypesForEntity(_connectorType: string, _entityType: string): Record<string, string> {
    // Simplified type mapping - would be expanded per connector
    return {};
  }

  // Check for writeback conflicts with current external state
  private async checkWritebackConflict(
    _connector: Connector,
    _entityType: string,
    _entityId: string,
    _snapshot: Record<string, unknown>
  ): Promise<{ hasConflict: boolean; conflictingFields: string[]; currentState?: Record<string, unknown> }> {
    // Would fetch current state from connector and compare with snapshot
    // For now, return no conflict - actual implementation would use state fetcher
    return { hasConflict: false, conflictingFields: [] };
  }

  // Resolve writeback conflicts based on strategy
  private async resolveWritebackConflict(
    payload: Record<string, unknown>,
    conflict: { conflictingFields: string[]; currentState?: Record<string, unknown> },
    strategy: string
  ): Promise<Record<string, unknown>> {
    switch (strategy) {
      case 'last-write-wins':
        return payload; // Use our payload as-is
      case 'merge':
        // Merge non-conflicting fields from current state
        if (conflict.currentState) {
          const merged = { ...conflict.currentState };
          for (const [key, value] of Object.entries(payload)) {
            merged[key] = value;
          }
          return merged;
        }
        return payload;
      case 'remote-wins':
        // Use remote state but apply only non-conflicting local changes
        if (conflict.currentState) {
          const result = { ...conflict.currentState };
          for (const [key, value] of Object.entries(payload)) {
            if (!conflict.conflictingFields.includes(key)) {
              result[key] = value;
            }
          }
          return result;
        }
        return payload;
      default:
        return payload;
    }
  }

  // Emit writeback event to Pub/Sub
  private async emitWritebackEvent(
    tenantId: string,
    event: {
      connectorId: string;
      entityType: string;
      entityId: string;
      actionType: string;
      taskId: string;
      status: string;
      agentId?: string;
    }
  ): Promise<void> {
    const topicName = `connector-writeback-events-${process.env.ENVIRONMENT || 'dev'}`;
    const topic = this.pubsub.topic(topicName);

    await topic.publishMessage({
      json: {
        eventId: `${event.taskId}-${Date.now()}`,
        tenantId,
        agentId: event.agentId ?? null,
        eventType: 'connector.writeback.enqueued',
        occurredAt: new Date().toISOString(),
        payload: event,
      },
      attributes: {
        tenantId,
        connectorId: event.connectorId,
        entityType: event.entityType,
        ...(event.agentId ? { agentId: event.agentId } : {}),
      },
    });
  }

  // ===========================================
  // GAP-021 FIX: Connector Rate Limit Tracking
  // Per Section 12: Track and respect connector API rate limits
  // ===========================================

  private rateLimitState: Map<string, RateLimitState> = new Map();

  // Track rate limit response from connector
  async trackRateLimitResponse(
    connectorId: string,
    response: {
      rateLimited: boolean;
      retryAfter?: number;
      remainingRequests?: number;
      resetAt?: Date;
    }
  ): Promise<void> {
    const key = connectorId;
    const existing = this.rateLimitState.get(key) || this.createDefaultRateLimitState();

    if (response.rateLimited) {
      existing.isRateLimited = true;
      existing.retryAfter = response.retryAfter || 60;
      existing.rateLimitedAt = new Date();
      existing.rateLimitCount++;

      logger.warn('Connector rate limited', {
        connectorId,
        retryAfter: existing.retryAfter,
        rateLimitCount: existing.rateLimitCount,
      });

      // Persist to repository for cross-instance awareness
      await this.repository.updateRateLimitState(connectorId, existing);
    } else {
      existing.remainingRequests = response.remainingRequests;
      existing.resetAt = response.resetAt;
      existing.isRateLimited = false;
    }

    this.rateLimitState.set(key, existing);
  }

  // Check if connector is currently rate limited
  async isRateLimited(connectorId: string): Promise<{ limited: boolean; retryAfter?: number }> {
    // Check in-memory state first
    let state = this.rateLimitState.get(connectorId);

    // Fall back to repository for cross-instance state
    if (!state) {
      state = await this.repository.getRateLimitState(connectorId);
      if (state) {
        this.rateLimitState.set(connectorId, state);
      }
    }

    if (!state || !state.isRateLimited) {
      return { limited: false };
    }

    // Check if rate limit period has expired
    if (state.rateLimitedAt) {
      const expiresAt = new Date(state.rateLimitedAt.getTime() + (state.retryAfter || 60) * 1000);
      if (new Date() > expiresAt) {
        state.isRateLimited = false;
        this.rateLimitState.set(connectorId, state);
        return { limited: false };
      }

      const retryAfter = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
      return { limited: true, retryAfter };
    }

    return { limited: true, retryAfter: state.retryAfter };
  }

  // Get rate limit statistics for a connector
  async getRateLimitStats(connectorId: string): Promise<RateLimitStats> {
    const state = this.rateLimitState.get(connectorId) ||
      await this.repository.getRateLimitState(connectorId);

    if (!state) {
      return {
        connectorId,
        isRateLimited: false,
        rateLimitCount: 0,
        remainingRequests: undefined,
        resetAt: undefined,
      };
    }

    return {
      connectorId,
      isRateLimited: state.isRateLimited,
      rateLimitCount: state.rateLimitCount,
      remainingRequests: state.remainingRequests,
      resetAt: state.resetAt,
      lastRateLimitedAt: state.rateLimitedAt,
    };
  }

  // Preemptively check if we should throttle requests
  shouldThrottle(connectorId: string): boolean {
    const state = this.rateLimitState.get(connectorId);
    if (!state) return false;

    // Throttle if remaining requests is below threshold
    if (state.remainingRequests !== undefined && state.remainingRequests < 10) {
      logger.debug('Preemptive throttling', {
        connectorId,
        remainingRequests: state.remainingRequests,
      });
      return true;
    }

    return state.isRateLimited;
  }

  private createDefaultRateLimitState(): RateLimitState {
    return {
      isRateLimited: false,
      rateLimitCount: 0,
    };
  }
}

// Rate limit tracking types
interface RateLimitState {
  isRateLimited: boolean;
  retryAfter?: number;
  remainingRequests?: number;
  resetAt?: Date;
  rateLimitedAt?: Date;
  rateLimitCount: number;
}

interface RateLimitStats {
  connectorId: string;
  isRateLimited: boolean;
  rateLimitCount: number;
  remainingRequests?: number;
  resetAt?: Date;
  lastRateLimitedAt?: Date;
}

// Writeback input type
interface ConnectorWritebackInput {
  connectorId: string;
  agentId: string;
  entityType: string;
  entityId: string;
  actionType: 'create' | 'update' | 'patch' | 'delete';
  payload: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  conflictResolution?: 'fail' | 'last-write-wins' | 'merge' | 'remote-wins';
  idempotencyKey?: string;
  traceId?: string;
  instructionVersion?: number;
}

// Writeback result type
interface ConnectorWritebackResult {
  success: boolean;
  taskId?: string;
  archiveId?: string;
  error?: string;
  conflict?: {
    hasConflict: boolean;
    conflictingFields: string[];
  };
}

export const connectorService = new ConnectorService();
