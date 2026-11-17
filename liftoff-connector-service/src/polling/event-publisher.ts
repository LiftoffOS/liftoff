// Polling event publisher.
// Publishes connector.record.synced events to the connector-events Pub/Sub topic
// so the tenant runtime can route records to agents (e.g. the pre-meeting AE agent).
//
// Message format is designed to match what the tenant runtime's
// handleConnectorEvent() expects:
//   source     = message.attributes.source || data.payload.source
//   entityType = message.attributes.entityType || data.entityType
//   inputData.eventData = data.payload.data

import { randomUUID } from 'node:crypto';
import { PubSubPublisher } from '@liftoffos/pubsub';
import { logger } from '../infra/logging.js';
import type { NormalizedRecord } from '../normalizers/types.js';
import { publishConnectorRecordSyncedEvent } from '../events/connector-record-synced.js';

let publisherInstance: PubSubPublisher | null = null;

function getPublisher(): PubSubPublisher {
  if (!publisherInstance) {
    publisherInstance = new PubSubPublisher({
      projectId: process.env.GCP_PROJECT_ID,
      logger: {
        debug: (ctx, msg) => logger.debug(ctx, msg),
        error: (ctx, msg) => logger.error(ctx, msg),
      },
    });
  }
  return publisherInstance;
}

// Visible-for-testing — lets tests inject a mock publisher.
export function __setPollingPublisher(p: PubSubPublisher | null): void {
  publisherInstance = p;
}

function resolveTopicName(): string {
  const environment = process.env.ENVIRONMENT ?? 'dev';
  return `connector-events-${environment}`;
}

export async function publishPollingEvent(input: {
  connectorId: string;
  connectorType: string;
  entityType: string;
  tenantId: string;
  record: NormalizedRecord;
}): Promise<void> {
  const { connectorId, connectorType, entityType, tenantId, record } = input;

  const messageBody = {
    eventId: `${record.externalId}-${record.metadata.version}`,
    eventUUID: randomUUID(),
    tenantId,
    connectorId,
    entityType,
    entityId: record.externalId,
    eventType: 'connector.record.synced',
    occurredAt: new Date().toISOString(),
    payload: {
      source: connectorType,
      data: record.data,
    },
  };

  // connectorId is required — if somehow empty, omit it from attributes
  // rather than forwarding an empty string (harvest-service will treat
  // missing attribute as null and skip workspace-level attribution).
  const attributes: Record<string, string> = {
    tenantId,
    entityType,
    source: connectorType,
    eventType: 'connector.record.synced',
    ...(connectorId ? { connectorId } : {}),
  };

  try {
    await getPublisher().publish(resolveTopicName(), messageBody, { attributes });
    logger.debug(
      {
        connectorType,
        entityType,
        externalId: record.externalId,
        tenantId,
      },
      'polling event published',
    );
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        connectorType,
        entityType,
        externalId: record.externalId,
      },
      'failed to publish polling event',
    );
    throw err;
  }

  // The publish above reaches harvest-service and STOPS there: it lands on the
  // control project's `connector-events-${env}`, while the tenant runtime reads
  // a same-named topic in the tenant project that nothing here can publish to.
  // Waking an agent needs the control-plane relay (see connector-record-synced.ts).
  //
  // Deliberately not fatal. The harvest publish has already succeeded, and five
  // consecutive poll failures flip a connector to reconnect-required — a
  // control-plane hiccup must not cost a customer their connector. The poller
  // re-emits every visible record next cycle with the same dedupe key, so a
  // dropped relay self-heals.
  try {
    await publishConnectorRecordSyncedEvent({
      source: connectorType,
      entityType,
      entityId: record.externalId,
      tenantId,
      connectorId,
      eventId: messageBody.eventId,
      data: record.data,
      occurredAt: messageBody.occurredAt,
    });
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        connectorType,
        entityType,
        externalId: record.externalId,
        tenantId,
      },
      'polled record published to harvest but NOT relayed to the tenant runtime',
    );
  }
}
