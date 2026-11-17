// Dead Letter Queue Handler
// Per implementation plan: DLQ processing for failed corrections

import { PubSub } from '@google-cloud/pubsub';
import { logger } from '../infrastructure/logging';
import { getPlatformBackendUrl } from '../infrastructure/runtime-env';
import { CorrectionRequestedEvent } from './types';
import { getManagedSecret } from '../infrastructure/secret-store';

const pubsub = new PubSub();
const DLQ_TOPIC = `correction-dead-letter-${process.env.ENVIRONMENT || 'dev'}`;

interface DLQMessage {
  originalEvent: CorrectionRequestedEvent;
  error: string;
  errorStack?: string;
  failedAt: string;
  traceId: string;
  retryCount: number;
}

/**
 * Send failed correction to dead letter queue
 */
export async function sendToDeadLetterQueue(
  event: CorrectionRequestedEvent,
  error: unknown,
  traceId: string
): Promise<void> {
  const dlqMessage: DLQMessage = {
    originalEvent: event,
    error: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack : undefined,
    failedAt: new Date().toISOString(),
    traceId,
    retryCount: event.retryCount,
  };

  try {
    const topic = pubsub.topic(DLQ_TOPIC);
    await topic.publishMessage({
      data: Buffer.from(JSON.stringify(dlqMessage)),
      attributes: {
        tenantId: event.tenantId,
        correctionRequestId: event.correctionRequestId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
    });

    logger.info('Correction sent to DLQ', {
      correctionRequestId: event.correctionRequestId,
      tenantId: event.tenantId,
      error: dlqMessage.error,
      traceId,
    });
  } catch (publishError) {
    logger.error('Failed to publish to DLQ', {
      correctionRequestId: event.correctionRequestId,
      error: publishError instanceof Error ? publishError.message : String(publishError),
      traceId,
    });
  }
}

/**
 * Report correction failure to control plane
 */
export async function reportCorrectionFailure(
  event: CorrectionRequestedEvent,
  error: unknown,
  traceId: string
): Promise<void> {
  // Env-specific platform-backend URL (terraform-set PLATFORM_BACKEND_URL).
  // The legacy CONTROL_PLANE_URL fallback to the prod alias was a cross-env
  // trust footgun (dev → prod audit-log writes).
  const controlPlaneUrl = getPlatformBackendUrl();
  const serviceToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');

  try {
    const response = await fetch(`${controlPlaneUrl}/api/agent-audit-logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Auth': serviceToken || '',
      },
      body: JSON.stringify({
        tenantId: event.tenantId,
        action: 'correction_failed',
        inputArgs: {
          correctionRequestId: event.correctionRequestId,
          originalAuditLogId: event.originalAuditLogId,
          correctionToolName: event.correctionToolName,
          error: error instanceof Error ? error.message : String(error),
          retryCount: event.retryCount,
        },
        outputSummary: `Correction failed after ${event.retryCount} retries: ${error instanceof Error ? error.message : String(error)}`,
        outcome: 'error',
        errorCode: 'CORRECTION_FAILED',
        triggeredBy: 'event:correction',
        correctionOf: event.originalAuditLogId,
      }),
    });

    if (!response.ok) {
      logger.warn('Failed to report correction failure to control plane', {
        correctionRequestId: event.correctionRequestId,
        status: response.status,
        traceId,
      });
    }
  } catch (reportError) {
    logger.error('Error reporting correction failure', {
      correctionRequestId: event.correctionRequestId,
      error: reportError instanceof Error ? reportError.message : String(reportError),
      traceId,
    });
  }
}

/**
 * Report correction timeout
 */
export async function reportCorrectionTimeout(
  event: CorrectionRequestedEvent,
  traceId: string
): Promise<void> {
  logger.warn('Correction request timed out', {
    correctionRequestId: event.correctionRequestId,
    tenantId: event.tenantId,
    timeout: event.timeout,
    traceId,
  });

  // Env-specific platform-backend URL (terraform-set PLATFORM_BACKEND_URL).
  // The legacy CONTROL_PLANE_URL fallback to the prod alias was a cross-env
  // trust footgun (dev → prod audit-log writes).
  const controlPlaneUrl = getPlatformBackendUrl();
  const serviceToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');

  try {
    await fetch(`${controlPlaneUrl}/api/agent-audit-logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Auth': serviceToken || '',
      },
      body: JSON.stringify({
        tenantId: event.tenantId,
        action: 'correction_timeout',
        inputArgs: {
          correctionRequestId: event.correctionRequestId,
          originalAuditLogId: event.originalAuditLogId,
          correctionToolName: event.correctionToolName,
          timeout: event.timeout,
        },
        outputSummary: `Correction timed out at ${event.timeout}`,
        outcome: 'error',
        errorCode: 'CORRECTION_TIMEOUT',
        triggeredBy: 'event:correction',
        correctionOf: event.originalAuditLogId,
      }),
    });
  } catch (error) {
    logger.error('Error reporting correction timeout', {
      correctionRequestId: event.correctionRequestId,
      error: error instanceof Error ? error.message : String(error),
      traceId,
    });
  }
}

// SE-009: Track DLQ recovery attempts to prevent infinite retries
const MAX_DLQ_RECOVERY_ATTEMPTS = 2;

/**
 * Process DLQ message (for manual retry)
 */
export async function processDLQMessage(message: DLQMessage): Promise<boolean> {
  logger.info('Processing DLQ message', {
    correctionRequestId: message.originalEvent.correctionRequestId,
    originalRetryCount: message.retryCount,
    traceId: message.traceId,
  });

  // SE-009: Track DLQ recovery attempts in attributes to prevent infinite retries
  const dlqRecoveryAttempt = (message as DLQMessage & { dlqRecoveryAttempt?: number }).dlqRecoveryAttempt || 0;

  if (dlqRecoveryAttempt >= MAX_DLQ_RECOVERY_ATTEMPTS) {
    logger.error('Max DLQ recovery attempts exceeded', {
      correctionRequestId: message.originalEvent.correctionRequestId,
      dlqRecoveryAttempt,
      traceId: message.traceId,
    });
    return false;
  }

  // Re-publish to main correction topic for retry
  const topicName = `control-plane-events-${process.env.ENVIRONMENT || 'dev'}`;
  const topic = pubsub.topic(topicName);

  try {
    await topic.publishMessage({
      data: Buffer.from(JSON.stringify({
        event_type: 'correction.requested',
        payload: {
          ...message.originalEvent,
          // SE-009: Preserve original retry count, don't reset to 0
          // Only allow limited additional retries after DLQ recovery
          retryCount: message.originalEvent.maxRetries - 1, // One more try
          timeout: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // New 5-minute timeout
        },
      })),
      attributes: {
        eventType: 'correction.requested',
        dlqRecovery: 'true',
        dlqRecoveryAttempt: String(dlqRecoveryAttempt + 1),
      },
    });

    logger.info('DLQ message republished for retry', {
      correctionRequestId: message.originalEvent.correctionRequestId,
      dlqRecoveryAttempt: dlqRecoveryAttempt + 1,
    });

    return true;
  } catch (error) {
    logger.error('Failed to republish DLQ message', {
      correctionRequestId: message.originalEvent.correctionRequestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
