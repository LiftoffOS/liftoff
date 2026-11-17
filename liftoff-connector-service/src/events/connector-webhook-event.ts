// The hop that carries a vendor webhook delivery to the tenant runtime.
//
// TWO TOPICS SHARE THE NAME `connector-events-${env}`, in two projects, with
// disjoint subscribers:
//
//   YOUR_GCP_PROJECT  — what this service publishes to, because
//                                      GCP_PROJECT_ID is the control project.
//                                      Subscriber: harvest-service.
//   tenant-${slug}-${env}            — what the tenant runtime subscribes to.
//                                      Nothing here can reach it.
//
// No subscription bridges them. Publishing to the first in order to wake an
// agent therefore succeeds and does nothing.
//
// The route that does reach an agent is the one Composio triggers take:
//
//   this service
//     → control-plane-events-${env}                     [control project]
//     → `control-plane-events-${env}-coordinator-push`  [per tenant project]
//     → coordinator-service POST /internal/pubsub/control-plane-events
//     → handleConnectorWebhookEventReceived             [tenant runtime]
//     → connector-events-${env}                         [tenant project]
//     → agent-service handleConnectorEvent
//
// Every hop exists except the tenant-runtime handler, which is the paired half
// of this change (Liftoff-Tenant-Runtime `src/events/subscriber.ts`,
// `case 'connector.webhook_event_received'`). Changing the event type or the
// payload keys here without changing it there stops waking agents silently: the
// coordinator's default branch records an unrecognised event as completed.
//
// NOT a replacement for the existing `connector-events-${env}` publishes.
// harvest-service is a real subscriber of that topic and keeps its feed; see
// `slack-event-publisher.ts`, which does both.

import { publishEvent } from './publisher.js';
import { logger } from '../infra/logging.js';

/** The control-plane event type the tenant runtime's coordinator dispatches on. */
export const CONNECTOR_WEBHOOK_EVENT_TYPE = 'connector.webhook_event_received';

export interface PublishConnectorWebhookEventInput {
  /**
   * Connector type, lowercase — `github`, `slack`. The runtime lowercases this
   * to index its routing map, so it must match the catalog key, not a display
   * name.
   */
  source: string;
  /**
   * The vendor's own event name (`pull_request`, `issues`, `message`). Carried
   * for logging and vendor-vocabulary filters; the runtime routes on
   * `entityType`, not on this.
   */
  subtype?: string;
  /** Shared entity vocabulary — `PullRequest`, `Issue`, `Message`. */
  entityType: string;
  /** Vendor id for the entity, stable across redeliveries of the same thing. */
  entityId: string;
  tenantId: string;
  connectorId: string;
  /**
   * The vendor's delivery id (GitHub `X-GitHub-Delivery`, Slack `event_id`).
   *
   * The runtime's dedupe key: it goes into `connector_event_seen` via
   * `markEventSeen`, so a vendor redelivery is dropped rather than re-running
   * the agent. It travels in the payload because `publishEvent` mints the
   * control-plane `event_id` itself, and a fresh UUID per publish would dedupe
   * nothing.
   */
  eventId: string;
  /**
   * The vendor body, verbatim apart from permission-key stripping, which the
   * caller does.
   *
   * Verbatim is a requirement, not a convenience: the runtime's
   * `githubEventMatches` reads `action`, `pull_request.draft`,
   * `pull_request.merged`, `repository.full_name`, `pull_request.base.ref` and
   * `pull_request.user.login` off this object. A reshaped payload makes every
   * one of those filters unmatchable while still looking like a delivered event.
   */
  data: unknown;
  /** Vendor timestamp when known; defaults to now. */
  occurredAt?: string;
}

/**
 * Publish one vendor webhook delivery for one tenant.
 *
 * Throws on publish failure. Callers are webhook handlers that have already
 * ACKed the vendor, so they catch and log rather than propagate — a vendor must
 * not retry into us because our Pub/Sub call failed.
 */
export async function publishConnectorWebhookEvent(
  input: PublishConnectorWebhookEventInput,
): Promise<void> {
  const { source, subtype, entityType, entityId, tenantId, connectorId, eventId, data } = input;

  await publishEvent({
    entityType,
    entityId,
    eventType: CONNECTOR_WEBHOOK_EVENT_TYPE,
    eventVersion: 1,
    tenantId,
    payload: {
      source,
      subtype,
      connectorId,
      entityType,
      entityId,
      eventId,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      data,
    },
    attributes: {
      source,
      connectorId,
      delivery: 'push',
      ...(subtype ? { vendorEvent: subtype } : {}),
    },
  });

  logger.info(
    { tenant_id: tenantId, connector_id: connectorId, source, subtype, entity_type: entityType, entity_id: entityId, event_id: eventId },
    'connector webhook event published to control plane',
  );
}
