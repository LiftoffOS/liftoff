// DLQ Handlers for Common Task Types
// Per Section 7: Automatic handling of common failure scenarios

import { dlqService, DLQMessage } from './dlq';
import { logger } from './logging';
import { pool } from './database';

// Handler for workflow task failures
async function handleWorkflowTaskDLQ(message: DLQMessage) {
  logger.info('Handling workflow task DLQ', {
    dlqId: message.id,
    workflowId: message.workflowId,
    taskId: message.taskId,
  });

  // Check if task still exists and is in a recoverable state
  const taskResult = await pool.query(
    'SELECT * FROM workflow_tasks WHERE id = $1',
    [message.taskId]
  );

  if (taskResult.rows.length === 0) {
    return {
      resolved: true,
      action: 'discarded' as const,
      details: 'Task no longer exists',
    };
  }

  const task = taskResult.rows[0];

  // If task is already completed or compensated, discard the DLQ message
  if (['completed', 'compensated', 'canceled'].includes(task.status)) {
    return {
      resolved: true,
      action: 'discarded' as const,
      details: `Task already in terminal state: ${task.status}`,
    };
  }

  // Check the error type to determine action
  const error = message.error.toLowerCase();

  // Transient errors - safe to retry
  if (
    error.includes('timeout') ||
    error.includes('connection') ||
    error.includes('network') ||
    error.includes('unavailable') ||
    error.includes('rate limit')
  ) {
    // Reset the task for retry
    await pool.query(
      `UPDATE workflow_tasks
       SET status = 'pending', lease_id = NULL, lease_expires_at = NULL,
           retry_count = retry_count + 1, last_error = $2
       WHERE id = $1`,
      [message.taskId, message.error]
    );

    return {
      resolved: true,
      action: 'retried' as const,
      details: 'Task reset for retry due to transient error',
    };
  }

  // Permanent errors - escalate
  return {
    resolved: false,
    action: 'escalated' as const,
    details: 'Permanent error requires manual intervention',
  };
}

// Handler for action ledger failures
async function handleActionDLQ(message: DLQMessage) {
  logger.info('Handling action DLQ', {
    dlqId: message.id,
    workflowId: message.workflowId,
    taskId: message.taskId,
  });

  const payload = message.payload as any;
  const actionId = payload?.actionId;

  if (!actionId) {
    return {
      resolved: false,
      action: 'escalated' as const,
      details: 'No action ID in payload',
    };
  }

  // Check action status
  const actionResult = await pool.query('SELECT * FROM actions WHERE id = $1', [actionId]);

  if (actionResult.rows.length === 0) {
    return {
      resolved: true,
      action: 'discarded' as const,
      details: 'Action no longer exists',
    };
  }

  const action = actionResult.rows[0];

  // If action completed externally but internal commit failed
  if (action.external_response && action.status === 'executing') {
    // Complete the action
    await pool.query(
      `UPDATE actions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [actionId]
    );

    return {
      resolved: true,
      action: 'compensated' as const,
      details: 'Action was externally complete, internal state updated',
    };
  }

  // If action failed but is idempotent, allow retry
  if (payload.idempotencyKey) {
    await pool.query(
      `UPDATE actions SET status = 'pending', error = NULL WHERE id = $1`,
      [actionId]
    );

    return {
      resolved: true,
      action: 'retried' as const,
      details: 'Idempotent action reset for retry',
    };
  }

  return {
    resolved: false,
    action: 'escalated' as const,
    details: 'Non-idempotent action failure requires manual review',
  };
}

// Handler for connector sync failures
async function handleConnectorSyncDLQ(message: DLQMessage) {
  logger.info('Handling connector sync DLQ', {
    dlqId: message.id,
    tenantId: message.tenantId,
  });

  const payload = message.payload as any;
  const connectorId = payload?.connectorId;

  if (!connectorId) {
    return {
      resolved: false,
      action: 'escalated' as const,
      details: 'No connector ID in payload',
    };
  }

  // Check if connector is still active
  const connectorResult = await pool.query(
    'SELECT * FROM connectors WHERE id = $1',
    [connectorId]
  );

  if (connectorResult.rows.length === 0) {
    return {
      resolved: true,
      action: 'discarded' as const,
      details: 'Connector no longer exists',
    };
  }

  const connector = connectorResult.rows[0];

  if (connector.status === 'paused' || connector.status === 'deleted') {
    return {
      resolved: true,
      action: 'discarded' as const,
      details: `Connector is ${connector.status}`,
    };
  }

  // For sync failures, always safe to retry since syncs are idempotent
  return {
    resolved: true,
    action: 'retried' as const,
    details: 'Connector sync is idempotent, scheduled for retry',
  };
}

// Handler for entitlement event failures
async function handleEntitlementEventDLQ(message: DLQMessage) {
  logger.info('Handling entitlement event DLQ', {
    dlqId: message.id,
    tenantId: message.tenantId,
  });

  const payload = message.payload as any;
  const entityVersion = payload?.entityVersion;

  if (!entityVersion) {
    return {
      resolved: false,
      action: 'escalated' as const,
      details: 'No entity version in payload',
    };
  }

  // Check current cached version
  const cacheResult = await pool.query(
    'SELECT entity_version FROM tenant_entitlements_cache WHERE tenant_id = $1',
    [message.tenantId]
  );

  if (cacheResult.rows.length > 0) {
    const cachedVersion = cacheResult.rows[0].entity_version;

    // If we already have a newer version, discard this stale event
    if (cachedVersion >= entityVersion) {
      return {
        resolved: true,
        action: 'discarded' as const,
        details: `Stale event version ${entityVersion}, current is ${cachedVersion}`,
      };
    }
  }

  // Entitlement events are idempotent, retry
  return {
    resolved: true,
    action: 'retried' as const,
    details: 'Entitlement event retry scheduled',
  };
}

// Register all handlers
export function registerDLQHandlers(): void {
  const env = process.env.ENVIRONMENT || 'dev';

  dlqService.registerHandler(`workflow-tasks-${env}`, handleWorkflowTaskDLQ);
  dlqService.registerHandler(`action-execution-${env}`, handleActionDLQ);
  dlqService.registerHandler(`connector-sync-${env}`, handleConnectorSyncDLQ);
  dlqService.registerHandler(`entitlement-events-${env}`, handleEntitlementEventDLQ);

  logger.info('Registered all DLQ handlers');
}
