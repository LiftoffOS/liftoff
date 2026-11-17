// Dead Letter Queue Handling
// Per Section 7: DLQ for failed tasks after retry exhaustion

import { PubSub, Message } from '@google-cloud/pubsub';
import { logger } from './logging';
import { pool } from './database';

// DLQ message structure
export interface DLQMessage {
  id: string;
  originalTopic: string;
  originalMessageId: string;
  tenantId: string;
  workflowId?: string;
  taskId?: string;
  payload: unknown;
  error: string;
  deliveryAttempt: number;
  maxDeliveryAttempts: number;
  firstReceivedAt: Date;
  failedAt: Date;
  status: 'pending' | 'processing' | 'resolved' | 'discarded';
  /** Triage class written into dlq_messages.failure_class. Defaults to
   *  'transient' because every topic routed through this service has a
   *  registered retry handler (dlq-handlers.ts), so replay is the expected
   *  remediation. A caller that knows better should say so. */
  failureClass?: 'transient' | 'permanent';
}

// DLQ handler registry
type DLQHandler = (message: DLQMessage) => Promise<{
  resolved: boolean;
  action: 'retried' | 'compensated' | 'escalated' | 'discarded';
  details?: string;
}>;

export class DLQService {
  private pubsub = new PubSub();
  private handlers: Map<string, DLQHandler> = new Map();
  private dlqTopicName: string;
  private dlqSubscriptionName: string;

  constructor() {
    const env = process.env.ENVIRONMENT || 'dev';
    this.dlqTopicName = `dlq-${env}`;
    this.dlqSubscriptionName = `dlq-processor-${env}`;
  }

  // Register a handler for a specific original topic
  registerHandler(originalTopic: string, handler: DLQHandler): void {
    this.handlers.set(originalTopic, handler);
    logger.info('Registered DLQ handler', { originalTopic });
  }

  // Move a failed message to DLQ
  async moveToDeadLetter(
    originalTopic: string,
    originalMessageId: string,
    payload: unknown,
    error: string,
    metadata: {
      tenantId: string;
      workflowId?: string;
      taskId?: string;
      deliveryAttempt: number;
      maxDeliveryAttempts: number;
      firstReceivedAt: Date;
    }
  ): Promise<string> {
    const dlqMessage: DLQMessage = {
      id: `dlq-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      originalTopic,
      originalMessageId,
      tenantId: metadata.tenantId,
      workflowId: metadata.workflowId,
      taskId: metadata.taskId,
      payload,
      error,
      deliveryAttempt: metadata.deliveryAttempt,
      maxDeliveryAttempts: metadata.maxDeliveryAttempts,
      firstReceivedAt: metadata.firstReceivedAt,
      failedAt: new Date(),
      status: 'pending',
    };

    // Persist to database for tracking
    await this.persistDLQMessage(dlqMessage);

    // Publish to DLQ topic
    const topic = this.pubsub.topic(this.dlqTopicName);
    const _messageId = await topic.publishMessage({
      json: dlqMessage,
      attributes: {
        originalTopic,
        tenantId: metadata.tenantId,
        workflowId: metadata.workflowId || '',
        taskId: metadata.taskId || '',
      },
    });

    logger.warn('Message moved to DLQ', {
      dlqId: dlqMessage.id,
      originalTopic,
      originalMessageId,
      tenantId: metadata.tenantId,
      workflowId: metadata.workflowId,
      taskId: metadata.taskId,
      error,
    });

    return dlqMessage.id;
  }

  // Start processing DLQ messages
  async startProcessing(): Promise<void> {
    const subscription = this.pubsub.subscription(this.dlqSubscriptionName);

    subscription.on('message', async (message: Message) => {
      try {
        await this.processMessage(message);
        message.ack();
      } catch (error) {
        logger.error('Failed to process DLQ message', {
          messageId: message.id,
          error: (error as Error).message,
        });
        message.nack();
      }
    });

    subscription.on('error', (error) => {
      logger.error('DLQ subscription error', { error: error.message });
    });

    logger.info('Started DLQ processor', {
      subscription: this.dlqSubscriptionName,
      registeredHandlers: Array.from(this.handlers.keys()),
    });
  }

  // Process a single DLQ message
  private async processMessage(message: Message): Promise<void> {
    const dlqMessage: DLQMessage = JSON.parse(message.data.toString());

    logger.info('Processing DLQ message', {
      dlqId: dlqMessage.id,
      originalTopic: dlqMessage.originalTopic,
      tenantId: dlqMessage.tenantId,
    });

    // Update status to processing
    await this.updateDLQStatus(dlqMessage.id, 'processing');

    const handler = this.handlers.get(dlqMessage.originalTopic);
    if (!handler) {
      // No handler - escalate for manual review
      logger.warn('No DLQ handler for topic', {
        dlqId: dlqMessage.id,
        originalTopic: dlqMessage.originalTopic,
      });
      await this.escalateForManualReview(dlqMessage);
      return;
    }

    try {
      const result = await handler(dlqMessage);

      if (result.resolved) {
        await this.updateDLQStatus(dlqMessage.id, 'resolved', result.action, result.details);
        logger.info('DLQ message resolved', {
          dlqId: dlqMessage.id,
          action: result.action,
          details: result.details,
        });
      } else {
        await this.escalateForManualReview(dlqMessage, result.details);
      }
    } catch (error) {
      logger.error('DLQ handler failed', {
        dlqId: dlqMessage.id,
        error: (error as Error).message,
      });
      await this.escalateForManualReview(dlqMessage, (error as Error).message);
    }
  }

  // Escalate to human for manual review
  private async escalateForManualReview(message: DLQMessage, reason?: string): Promise<void> {
    await pool.query(
      `INSERT INTO dlq_escalations (
        dlq_message_id, tenant_id, workflow_id, task_id,
        original_topic, error, reason, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        message.id,
        message.tenantId,
        message.workflowId,
        message.taskId,
        message.originalTopic,
        message.error,
        reason || 'No handler available',
      ]
    );

    logger.warn('DLQ message escalated for manual review', {
      dlqId: message.id,
      tenantId: message.tenantId,
      reason: reason || 'No handler available',
    });
  }

  // Persist DLQ message to database
  private async persistDLQMessage(message: DLQMessage): Promise<void> {
    await pool.query(
      `INSERT INTO dlq_messages (
        id, original_topic, original_message_id, tenant_id, workflow_id, task_id,
        payload, error, delivery_attempt, max_delivery_attempts,
        first_received_at, failed_at, status, failure_class
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        message.id,
        message.originalTopic,
        message.originalMessageId,
        message.tenantId,
        message.workflowId,
        message.taskId,
        JSON.stringify(message.payload),
        message.error,
        message.deliveryAttempt,
        message.maxDeliveryAttempts,
        message.firstReceivedAt,
        message.failedAt,
        message.status,
        message.failureClass ?? 'transient',
      ]
    );
  }

  // Update DLQ message status
  private async updateDLQStatus(
    id: string,
    status: DLQMessage['status'],
    resolution?: string,
    details?: string
  ): Promise<void> {
    await pool.query(
      `UPDATE dlq_messages
       SET status = $2, resolution = $3, resolution_details = $4, resolved_at = NOW()
       WHERE id = $1`,
      [id, status, resolution, details]
    );
  }

  // List pending DLQ messages for a tenant
  async listPending(tenantId?: string): Promise<DLQMessage[]> {
    const query = tenantId
      ? 'SELECT * FROM dlq_messages WHERE status = $1 AND tenant_id = $2 ORDER BY failed_at DESC'
      : 'SELECT * FROM dlq_messages WHERE status = $1 ORDER BY failed_at DESC';
    const params = tenantId ? ['pending', tenantId] : ['pending'];

    const result = await pool.query(query, params);
    return result.rows.map(this.rowToMessage);
  }

  // Get DLQ metrics
  async getMetrics(tenantId?: string): Promise<{
    pending: number;
    processing: number;
    resolved: number;
    discarded: number;
    byTopic: Record<string, number>;
  }> {
    const whereClause = tenantId ? 'WHERE tenant_id = $1' : '';
    const params = tenantId ? [tenantId] : [];

    const statusQuery = `
      SELECT status, COUNT(*) as count
      FROM dlq_messages
      ${whereClause}
      GROUP BY status
    `;

    const topicQuery = `
      SELECT original_topic, COUNT(*) as count
      FROM dlq_messages
      ${whereClause} ${tenantId ? 'AND status = $2' : 'WHERE status = $1'}
      GROUP BY original_topic
    `;

    const [statusResult, topicResult] = await Promise.all([
      pool.query(statusQuery, params),
      pool.query(topicQuery, tenantId ? [tenantId, 'pending'] : ['pending']),
    ]);

    const statusCounts: Record<string, number> = {};
    for (const row of statusResult.rows) {
      statusCounts[row.status] = parseInt(row.count, 10);
    }

    const topicCounts: Record<string, number> = {};
    for (const row of topicResult.rows) {
      topicCounts[row.original_topic] = parseInt(row.count, 10);
    }

    return {
      pending: statusCounts.pending || 0,
      processing: statusCounts.processing || 0,
      resolved: statusCounts.resolved || 0,
      discarded: statusCounts.discarded || 0,
      byTopic: topicCounts,
    };
  }

  // Manual retry a DLQ message
  async manualRetry(id: string): Promise<{ success: boolean; error?: string }> {
    const result = await pool.query('SELECT * FROM dlq_messages WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return { success: false, error: 'Message not found' };
    }

    const message = this.rowToMessage(result.rows[0]);

    // Re-publish to original topic
    const topic = this.pubsub.topic(message.originalTopic);
    await topic.publishMessage({
      json: message.payload,
      attributes: {
        dlqRetry: 'true',
        dlqMessageId: id,
        tenantId: message.tenantId,
      },
    });

    await this.updateDLQStatus(id, 'resolved', 'retried', 'Manual retry triggered');

    logger.info('Manually retried DLQ message', {
      dlqId: id,
      originalTopic: message.originalTopic,
      tenantId: message.tenantId,
    });

    return { success: true };
  }

  // Discard a DLQ message (mark as not actionable)
  async discard(id: string, reason: string): Promise<void> {
    await this.updateDLQStatus(id, 'discarded', 'discarded', reason);

    logger.info('Discarded DLQ message', { dlqId: id, reason });
  }

  private rowToMessage(row: any): DLQMessage {
    return {
      id: row.id,
      originalTopic: row.original_topic,
      originalMessageId: row.original_message_id,
      tenantId: row.tenant_id,
      workflowId: row.workflow_id,
      taskId: row.task_id,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      error: row.error,
      deliveryAttempt: row.delivery_attempt,
      maxDeliveryAttempts: row.max_delivery_attempts,
      firstReceivedAt: new Date(row.first_received_at),
      failedAt: new Date(row.failed_at),
      status: row.status,
      failureClass: row.failure_class ?? undefined,
    };
  }
}

// Singleton instance
export const dlqService = new DLQService();
