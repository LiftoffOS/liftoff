// Harvest service Pub/Sub subscriber.
//
// Mirrors the platform-backend control-plane subscriber pattern but pulls
// from the connector-events topic. Each message represents a connector
// payload (Salesforce record, Gmail thread, etc.) that may or may not be
// worth harvesting into institutional memory. The pipeline filter +
// classifier in runner.ts is the source of truth for that decision.

import { PubSub, Message } from '@google-cloud/pubsub';
import { log } from './infrastructure/logging';
import { runHarvestPipeline } from './runner';
import type { HarvestEvent } from './types';

const SHORT_TOPIC_NAME = 'connector-events';

// Flow control: keep concurrent inflight messages low so a burst of
// classifier calls doesn't exhaust LLM gateway quota or the pg pool.
const FLOW_CONTROL_MAX_MESSAGES = 8;

// Conversational connectors are served by real-time thread injection (Item 6).
// Harvesting them creates noise — durable knowledge lives in documents/issues/records.
const HARVEST_EXCLUDED_CONNECTOR_TYPES = new Set([
  'slack',
  'zendesk',
  'intercom',
  'google_mail',
  'microsoft_outlook_mail',
  'microsoft_teams',
]);

interface ConnectorEventEnvelope {
  event_id?: string;
  event_type?: string;
  entity_type?: string;
  entity_id?: string;
  tenant_id?: string;
  connector_id?: string | null;
  connector_type?: string;
  source?: string;
  // The connector-service polling publisher emits the SAME event in camelCase
  // (polling/event-publisher.ts). Both conventions are on this topic, and
  // reading only snake_case silently dropped every polled record — see
  // buildHarvestEvent.
  eventId?: string;
  eventType?: string;
  entityType?: string;
  entityId?: string;
  tenantId?: string;
  connectorId?: string | null;
  connectorType?: string;
  payload?: {
    data?: Record<string, unknown>;
    /**
     * Webhook-derived events set this to false at publish time so the
     * harvest pipeline skips them. Coordinated with the platform-backend
     * inbound-router (`event.custom_received` payload.harvestEligible) per
     * inbound-webhook plan §6.4 layer 4: webhook events are never
     * harvest-eligible, no opt-in.
     */
    harvestEligible?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

let subscriberInstance: ReturnType<PubSub['subscription']> | null = null;
let pubsubInstance: PubSub | null = null;

export function __resetSubscriberForTests(): void {
  subscriberInstance = null;
  pubsubInstance = null;
}

/**
 * Build a HarvestEvent from a Pub/Sub message. Tolerates both attribute-
 * style and body-only messages (older publishers put connectorType into
 * the body; newer ones set it as a Pub/Sub attribute).
 *
 * Returns null when required fields (tenant_id, entity_id) are missing —
 * the caller should ack such messages to drop them off the queue rather
 * than nacking and looping forever.
 */
export function buildHarvestEvent(
  message: Message,
  envelope: ConnectorEventEnvelope,
): HarvestEvent | null {
  const attrs = message.attributes ?? {};

  // Two producers publish to connector-events with two casings, and this
  // reader only knew one of them.
  //
  // platform-backend/tenant-runtime publish snake_case; connector-service's
  // POLLING publisher emits camelCase (`entityId`, `tenantId`, …). `tenantId`
  // survived by accident because it is also a Pub/Sub ATTRIBUTE, but
  // `entityId` is body-only — so every polled record failed the required-field
  // check below and was acked away with "missing required fields". Harvest has
  // therefore classified nothing from the poller.
  //
  // Both casings are read rather than normalising one producer: the topic is
  // shared and neither convention is wrong, so the reader is the honest place
  // to absorb the difference.
  const tenantId =
    envelope.tenant_id ?? envelope.tenantId ?? attrs.tenant_id ?? attrs.tenantId;
  const entityId =
    envelope.entity_id ?? envelope.entityId ?? attrs.entity_id ?? attrs.entityId;
  const entityType =
    envelope.entity_type ?? envelope.entityType
    ?? attrs.entity_type ?? attrs.entityType ?? '';
  const connectorType =
    envelope.connector_type ?? envelope.connectorType
    ?? attrs.source ?? attrs.connectorType ?? envelope.source ?? '';
  // connector_id may be missing on messages published before the
  // event-publisher fix — handle null gracefully through the pipeline.
  const connectorIdRaw =
    envelope.connector_id ?? envelope.connectorId
    ?? attrs.connector_id ?? attrs.connectorId ?? null;
  const connectorId =
    typeof connectorIdRaw === 'string' && connectorIdRaw.length > 0
      ? connectorIdRaw
      : null;
  const data = (envelope.payload?.data ?? {}) as Record<string, unknown>;

  if (!tenantId || !entityId) {
    return null;
  }

  return {
    tenantId,
    connectorId,
    connectorType,
    entityType,
    entityId,
    data,
    messageId: message.id,
  };
}

export type HarvestDecision = 'ack' | 'nack';

/**
 * Core per-message decision for a connector-event, shared by the Pub/Sub PUSH
 * route (the live scale-to-zero path) and the streaming-pull subscriber below
 * (retained for tests / local pull). Returns 'ack' to drop or after a
 * successful harvest, 'nack' only when the pipeline throws (redeliver).
 */
export async function processConnectorEvent(
  rawData: string,
  attributes: Record<string, string>,
  messageId: string,
): Promise<HarvestDecision> {
  let envelope: ConnectorEventEnvelope | null = null;
  try {
    envelope = JSON.parse(rawData) as ConnectorEventEnvelope;
  } catch (err) {
    log.warn(
      { message_id: messageId, error: (err as Error).message },
      'Failed to parse Pub/Sub message body, acking to drop',
    );
    return 'ack';
  }

  // buildHarvestEvent only reads `.attributes` and `.id`; pass a minimal shape
  // so the same builder serves both push (no Message object) and pull.
  const harvestEvent = buildHarvestEvent(
    { attributes, id: messageId } as unknown as Message,
    envelope,
  );
  if (!harvestEvent) {
    log.warn(
      { message_id: messageId, event_id: envelope?.event_id },
      'connector-event missing required fields, acking to drop',
    );
    return 'ack';
  }

  if (HARVEST_EXCLUDED_CONNECTOR_TYPES.has(harvestEvent.connectorType)) {
    return 'ack'; // conversational connectors are served by real-time thread injection
  }

  if (envelope.payload?.harvestEligible === false) {
    log.info(
      { message_id: messageId, tenantId: harvestEvent.tenantId },
      'connector-event marked harvestEligible=false, acking without classification',
    );
    return 'ack';
  }

  try {
    await runHarvestPipeline(harvestEvent);
    return 'ack';
  } catch (err) {
    log.error(
      {
        message_id: messageId,
        tenantId: harvestEvent.tenantId,
        connectorType: harvestEvent.connectorType,
        error: (err as Error).message,
      },
      'harvest pipeline failed',
    );
    return 'nack';
  }
}

export function startHarvestSubscriber(): void {
  if (subscriberInstance) {
    log.warn('startHarvestSubscriber called twice, ignoring');
    return;
  }

  const environment = process.env.ENVIRONMENT ?? 'dev';
  const subscriptionName = `${SHORT_TOPIC_NAME}-${environment}-harvest-sub`;

  pubsubInstance = new PubSub(
    process.env.GCP_PROJECT_ID ? { projectId: process.env.GCP_PROJECT_ID } : {},
  );

  const subscription = pubsubInstance.subscription(subscriptionName, {
    flowControl: {
      maxMessages: FLOW_CONTROL_MAX_MESSAGES,
      allowExcessMessages: false,
    },
  });

  subscription.on('message', async (message: Message) => {
    const decision = await processConnectorEvent(
      message.data.toString(),
      message.attributes ?? {},
      message.id,
    );
    if (decision === 'ack') {
      message.ack();
      return;
    }
    // INF-002: brief client-side backoff before nacking so a tight failure
    // loop (e.g. LLM gateway returning 500) doesn't hammer the gateway within
    // a single ack deadline. Subscription retry_policy handles overall timing.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    message.nack();
  });

  subscription.on('error', (err: Error) => {
    log.error(
      { subscription: subscriptionName, error: err.message },
      'Pub/Sub subscription error',
    );
  });

  subscriberInstance = subscription;

  log.info(
    { subscription: subscriptionName },
    'Subscribed to connector-events (harvest)',
  );
}

export async function stopHarvestSubscriber(): Promise<void> {
  if (!subscriberInstance) return;
  try {
    await subscriberInstance.close();
    subscriberInstance = null;
    log.info('harvest subscriber closed');
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'harvest subscriber close error (non-fatal)');
  }
}
