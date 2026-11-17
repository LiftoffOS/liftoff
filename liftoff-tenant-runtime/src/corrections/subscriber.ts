// Correction Event Subscriber
// Per implementation plan: Event subscription for correction.requested events

import { PubSub, Message } from '@google-cloud/pubsub';
import { logger } from '../infrastructure/logging';
import { isKnownTenant } from '../infrastructure/tenant-registry';
import { executeCorrection } from './executor';
import { sendToDeadLetterQueue, reportCorrectionFailure, reportCorrectionTimeout } from './dlq-handler';
import { CorrectionRequestedEvent, BulkCorrectionRequestedEvent } from './types';
import { v4 as uuidv4 } from 'uuid';

const pubsub = new PubSub();

// Retry configuration
const BACKOFF_BASE_MS = 5000;
const MAX_BACKOFF_MS = 300000; // 5 minutes

/** The control plane publishes correction events onto its shared
 *  `control-plane-events-<env>` topic. Subscriptions are per tenant and live in
 *  the tenant's own project, matching the tenant-runtime-config subscriber.
 *
 *  Named by the tenant SLUG, because that is what Terraform names it with
 *  (`var.tenant_id`) and what TENANT_ID carries. The tenant UUID is a different
 *  value entirely and is used for the isolation check in handleMessage. */
function subscriptionNameFor(tenantSlug: string): string {
  return `correction-events-${tenantSlug}`;
}

/**
 * Initialize correction event subscriber
 */
export function initCorrectionSubscriber(): void {
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) {
    logger.warn('TENANT_ID not set; correction subscriber not started');
    return;
  }

  const subscriptionName = subscriptionNameFor(tenantId);
  const subscription = pubsub.subscription(subscriptionName);

  subscription.on('message', (message: Message) => {
    void handleMessage(message);
  });
  subscription.on('error', (error) => {
    logger.error('Correction subscription error', { error: error.message });
  });

  logger.info('Correction event subscriber initialized', { subscription: subscriptionName });
}

/**
 * Handle incoming Pub/Sub message
 */
async function handleMessage(message: Message): Promise<void> {
  const traceId = uuidv4();
  let event: CorrectionRequestedEvent | BulkCorrectionRequestedEvent;

  try {
    const data = JSON.parse(message.data.toString());
    const eventType = data.event_type || message.attributes?.eventType;

    // The topic is shared across tenants and the handlers below act on the
    // tenant named in the event, not on this runtime's own. This check is the
    // isolation boundary, not the subscription filter — a filter is
    // configuration and cannot be tested from here.
    //
    // A MEMBERSHIP question, not an equality check against one id. A runtime
    // serves every tenant in its database, so testing the event against a single
    // "own" tenant drops every other tenant's corrections — and drops them
    // silently, because the message is acked as handled. Comparing against
    // process.env.TENANT_ID is worse still: that is the tenant SLUG while every
    // id on the wire is a UUID, so it would reject all of them including this
    // runtime's own.
    const eventTenantId = data.tenant_id ?? message.attributes?.tenantId ?? data.payload?.tenantId;
    if (eventTenantId && !(await isKnownTenant(eventTenantId))) {
      logger.warn('Correction event for a tenant this runtime does not serve, dropping', {
        eventTenantId,
        traceId,
      });
      message.ack();
      return;
    }

    if (eventType === 'correction.requested') {
      event = data.payload as CorrectionRequestedEvent;
      await handleCorrectionEvent(event, traceId);
    } else if (eventType === 'correction.bulk_requested') {
      event = data.payload as BulkCorrectionRequestedEvent;
      await handleBulkCorrectionEvent(event, traceId);
    } else {
      logger.warn('Unknown correction event type', { eventType, traceId });
      message.ack();
      return;
    }

    message.ack();
  } catch (error) {
    logger.error('Failed to process correction event', {
      error: error instanceof Error ? error.message : String(error),
      traceId,
    });

    // BE-007: Nack with delay to implement backoff
    // Pub/Sub will use exponential backoff based on delivery attempts
    const deliveryAttempt = parseInt(message.attributes?.deliveryAttempt || '1', 10);
    const backoffSeconds = Math.min(Math.pow(2, deliveryAttempt - 1) * 5, 300);

    logger.info('Nacking message with backoff', {
      deliveryAttempt,
      backoffSeconds,
      traceId,
    });

    // Nack the message and let Pub/Sub's retry policy handle backoff
    // The subscription's retry policy controls redelivery timing
    message.nack();
  }
}

/**
 * Handle single correction event
 */
async function handleCorrectionEvent(
  event: CorrectionRequestedEvent,
  traceId: string
): Promise<void> {
  const { timeout, maxRetries, retryCount } = event;

  logger.info('Processing correction event', {
    correctionRequestId: event.correctionRequestId,
    tenantId: event.tenantId,
    correctionToolName: event.correctionToolName,
    retryCount,
    traceId,
  });

  // Check if timed out
  if (new Date(timeout) < new Date()) {
    await reportCorrectionTimeout(event, traceId);
    return;
  }

  try {
    await executeCorrection({
      tenantId: event.tenantId,
      correctionRequestId: event.correctionRequestId,
      originalAuditLogId: event.originalAuditLogId,
      correctionToolName: event.correctionToolName,
      correctionType: event.correctionType,
      requiresPreviousState: event.requiresPreviousState,
      reason: event.reason,
      requestedBy: event.requestedBy,
      traceId,
    });

    logger.info('Correction executed successfully', {
      correctionRequestId: event.correctionRequestId,
      traceId,
    });
  } catch (error) {
    const isRetryable = isRetryableError(error);

    if (retryCount < maxRetries && isRetryable) {
      await republishWithBackoff(event, retryCount + 1);
    } else {
      await sendToDeadLetterQueue(event, error, traceId);
      await reportCorrectionFailure(event, error, traceId);
    }
  }
}

/**
 * Handle bulk correction event
 */
async function handleBulkCorrectionEvent(
  event: BulkCorrectionRequestedEvent,
  traceId: string
): Promise<void> {
  logger.info('Processing bulk correction event', {
    correctionCount: event.corrections.length,
    tenantId: event.tenantId,
    traceId,
  });

  // Check if timed out
  if (new Date(event.timeout) < new Date()) {
    logger.warn('Bulk correction event timed out', { traceId });
    return;
  }

  // Process each correction
  for (const correction of event.corrections) {
    try {
      await executeCorrection({
        tenantId: event.tenantId,
        correctionRequestId: correction.correctionRequestId,
        originalAuditLogId: correction.originalAuditLogId,
        correctionToolName: correction.correctionToolName,
        correctionType: correction.correctionType,
        requiresPreviousState: correction.requiresPreviousState,
        reason: event.reason,
        requestedBy: event.requestedBy,
        traceId,
      });

      logger.info('Bulk correction item executed', {
        correctionRequestId: correction.correctionRequestId,
        traceId,
      });
    } catch (error) {
      logger.error('Bulk correction item failed', {
        correctionRequestId: correction.correctionRequestId,
        error: error instanceof Error ? error.message : String(error),
        traceId,
      });

      // Continue processing other corrections
    }
  }
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;

  const nonRetryablePatterns = [
    'not found',
    'invalid',
    'forbidden',
    'unauthorized',
    'permission denied',
    'validation failed',
  ];

  const message = error.message.toLowerCase();
  return !nonRetryablePatterns.some((pattern) => message.includes(pattern));
}

/**
 * Republish event with exponential backoff
 */
async function republishWithBackoff(
  event: CorrectionRequestedEvent,
  newRetryCount: number
): Promise<void> {
  const backoffMs = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, newRetryCount - 1),
    MAX_BACKOFF_MS
  );

  logger.info('Republishing correction event with backoff', {
    correctionRequestId: event.correctionRequestId,
    retryCount: newRetryCount,
    backoffMs,
  });

  // Update retry count
  const updatedEvent: CorrectionRequestedEvent = {
    ...event,
    retryCount: newRetryCount,
  };

  // Republish to the topic the event came from. That topic lives in the
  // control-plane project, not this tenant's, so it has to be fully qualified —
  // a bare name resolves against the runtime's own project, where it does not
  // exist, and every retry would fail on a missing topic instead of retrying.
  const environment = process.env.ENVIRONMENT || 'dev';
  const controlPlaneProject =
    process.env.CONTROL_PLANE_PROJECT_ID ?? `YOUR_GCP_PROJECT`;
  const topicName =
    `projects/${controlPlaneProject}/topics/control-plane-events-${environment}`;
  const topic = pubsub.topic(topicName);

  await topic.publishMessage({
    data: Buffer.from(JSON.stringify({
      event_type: 'correction.requested',
      tenant_id: event.tenantId,
      payload: updatedEvent,
    })),
    attributes: {
      eventType: 'correction.requested',
      // Carried so the per-tenant subscription filter matches the retry too;
      // without it a retried event is filtered out and silently lost.
      tenantId: event.tenantId,
      retryCount: String(newRetryCount),
    },
  });
}
