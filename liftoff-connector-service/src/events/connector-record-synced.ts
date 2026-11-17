// The hop that carries a POLLED record to the tenant runtime.
//
// Sibling of `connector-webhook-event.ts`, for the same reason and over the
// same route. That file explains the topology; the short version is that
// `connector-events-${env}` names two different topics in two projects:
//
//   YOUR_GCP_PROJECT  — what this service publishes to, because
//                                      GCP_PROJECT_ID is the control project.
//                                      Subscriber: harvest-service.
//   tenant-${slug}-${env}            — what the tenant runtime subscribes to.
//                                      Nothing here can reach it.
//
// So publishing there succeeds and never wakes an agent. A poll-reactive
// connector would advertise event topics that could not fire, because the
// records stop at harvest-service. The control topic's only subscription is `connector-events-${env}-harvest-sub`,
// and the tenant project holds a same-named topic whose subscriber
// (`connector-events-agent-trigger-${env}-sub`) nothing publishes to from here.
//
// The route that does reach an agent is the one Composio triggers and vendor
// webhooks already take:
//
//   this service
//     → control-plane-events-${env}                     [control project]
//     → `control-plane-events-${env}-coordinator-push`  [per tenant project]
//     → coordinator-service POST /internal/pubsub/control-plane-events
//     → handleConnectorRecordSynced                     [tenant runtime]
//     → connector-events-${env}                         [tenant project]
//     → agent-service handleConnectorEvent
//
// Paired consumer: Liftoff-Tenant-Runtime `src/events/subscriber.ts`,
// `case 'connector.record_synced'`. The payload keys read there are the keys
// written here; a rename on either side stops waking agents SILENTLY, because
// the coordinator's default branch records an unrecognised event as completed.
//
// NOT a replacement for the existing `connector-events-${env}` publish.
// harvest-service is a real subscriber of that topic and keeps its feed — this
// is an addition alongside it, the same way `slack-event-publisher.ts` does
// both.

import { publishEvent } from './publisher.js';
import { logger } from '../infra/logging.js';

/** The control-plane event type the tenant runtime's coordinator dispatches on. */
export const CONNECTOR_RECORD_SYNCED_EVENT_TYPE = 'connector.record_synced';

export interface PublishConnectorRecordSyncedInput {
  /**
   * Connector type, lowercase — `attio`, `github`. The runtime lowercases this
   * to index its routing map, so it must match the catalog key, not a display
   * name.
   */
  source: string;
  /** Shared entity vocabulary — `Contact`, `Deal`, `PullRequest`. */
  entityType: string;
  /** Vendor id for the record, stable across polls of the same thing. */
  entityId: string;
  tenantId: string;
  connectorId: string;
  /**
   * Dedupe key, `${externalId}-${version}`.
   *
   * This is what stops a poll waking an agent every 60 seconds. The poller
   * re-emits every record it can still see on every cycle — harvest-service
   * logs the majority of its traffic as `harvest_dropped / reason: unchanged` —
   * so without a key that is STABLE while the record is unchanged, each cycle
   * would look like a new event. The runtime records it via `markEventSeen`.
   *
   * It travels in the payload because `publishEvent` mints the control-plane
   * `event_id` itself, and a fresh UUID per publish would dedupe nothing.
   */
  eventId: string;
  /** The normalized record body, as handed to harvest-service. */
  data: unknown;
  /** Poll timestamp; defaults to now. */
  occurredAt?: string;
}

/**
 * Relay one polled record for one tenant to the control plane.
 *
 * Throws on publish failure. `publishPollingEvent` catches rather than
 * propagates: the harvest publish has already succeeded by then, and a
 * control-plane hiccup must not turn a healthy poll into a failed one (five
 * consecutive poll failures flip a connector to reconnect-required). A dropped
 * relay self-heals on the next cycle, because the poller re-emits the record
 * with the same dedupe key.
 */
export async function publishConnectorRecordSyncedEvent(
  input: PublishConnectorRecordSyncedInput,
): Promise<void> {
  const { source, entityType, entityId, tenantId, connectorId, eventId, data } = input;

  await publishEvent({
    entityType,
    entityId,
    eventType: CONNECTOR_RECORD_SYNCED_EVENT_TYPE,
    eventVersion: 1,
    tenantId,
    payload: {
      source,
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
      delivery: 'poll',
    },
  });

  // INFO, matching the sibling webhook producer. An unobservable hop is what
  // let this defect live: the poller reported success on every cycle while
  // reaching no agent. Volume is bounded by records polled, ~1.7k/day estimated
  // across the estate.
  logger.info(
    {
      tenant_id: tenantId,
      connector_id: connectorId,
      source,
      entity_type: entityType,
      entity_id: entityId,
      event_id: eventId,
    },
    'polled record relayed to control plane',
  );
}
