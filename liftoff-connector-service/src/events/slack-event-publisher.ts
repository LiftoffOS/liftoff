// Slack-event publisher.
//
// Publishes each Slack Events API delivery TWICE, to two consumers on two
// different planes. Both are load-bearing; neither is a fallback for the other.
//
//   1. `connector-events-${env}` in the CONTROL project, in the same envelope
//      polling-derived `connector.record.synced` events use (see
//      src/polling/event-publisher.ts) so consumers do not fork by delivery
//      mode. Subscriber: harvest-service.
//
//   2. `connector.webhook_event_received` on `control-plane-events-${env}` —
//      the only route from this service that reaches an AGENT. The
//      `connector-events-${env}` the tenant runtime subscribes to is a
//      different topic of the same name in a different project, with no
//      subscription bridging the two. See connector-webhook-event.ts.
//
// (1) alone does NOT satisfy ADR-019's "reactive subscriptions and event-
// triggered agents consume one stream", which this header used to claim: no
// tenant-runtime subscriber is attached to the control-project topic in any
// environment. (2) is what makes `nativeEventDelivery: true` on the Slack
// catalog row true of more than the webhook.
//
// The only difference between (1)'s envelope and polling's is the
// `delivery: 'push'` attribute (vs polling's absent/`poll`) for ops dashboards
// splitting push vs poll volumes.

import { randomUUID } from 'node:crypto';
import { PubSubPublisher } from '@liftoffos/pubsub';
import { logger } from '../infra/logging.js';
import { publishConnectorWebhookEvent } from './connector-webhook-event.js';

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
export function __setSlackEventPublisher(p: PubSubPublisher | null): void {
  publisherInstance = p;
}

function resolveTopicName(): string {
  const environment = process.env.ENVIRONMENT ?? 'dev';
  return `connector-events-${environment}`;
}

/**
 * Derive the entityType label from a Slack inner-event payload.
 *
 *   message / app_mention             → 'Message'
 *   reaction_added / reaction_removed → 'Reaction'
 *   anything else                     → 'SlackEvent' (catch-all)
 *
 * Kept narrow because the reactive-subscription evaluator's predicate
 * tree filters on entityType + payload fields; widening the entityType
 * surface is a contract change for downstream consumers.
 */
function deriveEntityType(slackEventType: string | undefined): string {
  if (!slackEventType) return 'SlackEvent';
  if (slackEventType === 'message' || slackEventType === 'app_mention') return 'Message';
  if (slackEventType === 'reaction_added' || slackEventType === 'reaction_removed') return 'Reaction';
  return 'SlackEvent';
}

/**
 * Derive the canonical entityId from a Slack inner-event payload.
 *
 *   message / app_mention             → event.ts                 (the message's timestamp-id)
 *   reaction_added / reaction_removed → event.item.ts (best effort: item references the message)
 *   anything else                     → event_id (fallback)
 *
 * Slack's `ts` is the canonical stable identifier for messages; reactions
 * reference the message they were added to via `item.ts`.
 */
function deriveEntityId(slackEvent: Record<string, unknown>, eventId: string): string {
  const ts = slackEvent.ts;
  if (typeof ts === 'string' && ts.length > 0) return ts;
  const item = slackEvent.item as { ts?: string } | undefined;
  if (item?.ts) return item.ts;
  return eventId;
}

export interface PublishSlackEventInput {
  /** The connectors.id (UUID) of the active Slack workspace connector. */
  connectorId: string;
  /** Tenant UUID resolved from the Slack team_id. */
  tenantId: string;
  /** Slack workspace id (T...). Carried for attribute-level filtering. */
  slackTeamId: string;
  /** Slack-generated event id (Ev...) — globally unique within Slack. */
  eventId: string;
  /** The inner Slack event payload (body.event from the webhook). */
  slackEvent: Record<string, unknown>;
}

/**
 * Publish a Slack webhook event to the shared connector-events topic.
 *
 * The envelope is identical to polling-derived events so reactive
 * subscriptions can express predicates without caring about delivery
 * mode. Failures are surfaced to the caller — the webhook handler treats
 * publish failure as non-fatal but logs and metrics-emits separately.
 */
export async function publishSlackEvent(input: PublishSlackEventInput): Promise<void> {
  const { connectorId, tenantId, slackTeamId, eventId, slackEvent } = input;
  const slackEventType = slackEvent.type as string | undefined;
  const entityType = deriveEntityType(slackEventType);
  const entityId = deriveEntityId(slackEvent, eventId);

  // Slack's `ts` is a string-encoded float of seconds since epoch.
  // For events that don't carry `ts` we fall back to now.
  let occurredAtMs = Date.now();
  const ts = slackEvent.ts;
  if (typeof ts === 'string' && ts.length > 0) {
    const parsed = Number.parseFloat(ts);
    if (Number.isFinite(parsed)) occurredAtMs = Math.floor(parsed * 1000);
  }

  const messageBody = {
    eventId,
    eventUUID: randomUUID(),
    tenantId,
    connectorId,
    entityType,
    entityId,
    eventType: 'connector.record.synced',
    occurredAt: new Date(occurredAtMs).toISOString(),
    payload: {
      source: 'slack',
      data: slackEvent,
    },
  };

  const attributes: Record<string, string> = {
    tenantId,
    entityType,
    source: 'slack',
    eventType: 'connector.record.synced',
    connectorId,
    delivery: 'push',
    slack_team_id: slackTeamId,
  };

  try {
    await getPublisher().publish(resolveTopicName(), messageBody, { attributes });
    logger.info(
      { tenantId, connectorId, entityType, entityId, eventId, slackEventType },
      'slack event published',
    );
    // The agent-reaching hop. Inside the same try on purpose: if this throws
    // while the harvest publish succeeded, the event reached no agent, and
    // returning normally would report that as a success. The caller treats a
    // throw as non-fatal and logs it.
    await publishConnectorWebhookEvent({
      source: 'slack',
      subtype: slackEventType,
      entityType,
      entityId,
      tenantId,
      connectorId,
      eventId,
      data: slackEvent,
      occurredAt: new Date(occurredAtMs).toISOString(),
    });
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        tenantId,
        connectorId,
        entityType,
        entityId,
        eventId,
      },
      'failed to publish slack event',
    );
    throw err;
  }
}
