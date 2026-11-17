// Control-plane event subscriber.
//
// The platform-backend is primarily an event publisher. Phase 2a moved
// connector OAuth (and the synchronous call to resolvePendingIntegrationsForConnector
// that used to live in oauth-router.ts) out into the connector-service. Connector-
// service now publishes a `connector.credentials_stored` event on the shared
// `control-plane-events-{env}` topic once credentials are written to Secret
// Manager. This subscriber picks that up and runs the auto-grant flow that
// used to be synchronous post-OAuth.
//
// Topic/subscription naming mirrors tenant-runtime's subscriber (see
// Liftoff-Tenant-Runtime/src/events/subscriber.ts): short names get an
// env suffix, each subscription is `{topic}-{env}-sub`.

import { PubSub, Message } from '@google-cloud/pubsub';
import { log, insertAuditLogDirect } from '../infrastructure/logging';
import { resolvePendingIntegrationsForConnector } from '../internal-agents/pending-integration-service';
import { agentAuditLogsService } from '../agent-audit-logs/service';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { cleanupWebhooksForConnector, deleteItemsForConnector } from '../knowledge/service';
import * as knowledgeRepo from '../knowledge/repository';
import { extractAndPersistItem } from '../knowledge/service';
import { embedItem } from '../knowledge/embedding-service';
import type { AuditOutcome } from '../agent-audit-logs/types';
import type { AuditPlatformEventPayload } from './types';

// Topic that connector-service publishes to (see
// liftoff-connector-service/src/events/publisher.ts resolveTopicName — also
// `control-plane-events-{env}`). Subscription is `{topic}-{env}-sub`.
const SHORT_TOPIC_NAME = 'control-plane-events';

// Flow control: limit concurrent messages so we don't exhaust the DB pool
// on a burst. Matches the per-subscription cap used by tenant-runtime.
const FLOW_CONTROL_MAX_MESSAGES = 4;

// Inbound envelope shape. Mirrors ControlPlaneEvent published by
// connector-service (src/events/publisher.ts) and platform-backend itself
// (src/events/publisher.ts). Fields are snake_case on the wire.
interface ControlPlaneEventEnvelope {
  event_id?: string;
  event_type: string;
  entity_type?: string;
  entity_id?: string;
  tenant_id?: string;
  entity_version?: number;
  event_version?: number;
  occurred_at?: string;
  payload?: Record<string, unknown>;
}

// Payload shape for connector.credentials_stored — matches what
// connector-service emits after storeCredentials() completes. We only
// need connectorType here; connectorId is on the envelope as entity_id.
interface CredentialsStoredPayload {
  connectorType?: string;
  connector_type?: string; // tolerant to snake_case payloads
}

// Payload shape for connector.deleted — emitted by connector-service when a
// connector is disconnected. connectorType identifies which connector content
// to purge from tenant runtime.
interface ConnectorDeletedPayload {
  connectorType?: string;
  connector_type?: string; // tolerant to snake_case payloads
}

let subscriberInstance: ReturnType<PubSub['subscription']> | null = null;
let pubsubInstance: PubSub | null = null;

// Visible-for-testing: lets tests reset the module state between cases.
export function __resetSubscriberForTests(): void {
  subscriberInstance = null;
  pubsubInstance = null;
}

/**
 * Dispatches a single inbound envelope to its handler. Exported for unit
 * tests so they can exercise the dispatch logic without spinning up the
 * Pub/Sub client.
 *
 * Errors are swallowed and logged at warn level — the underlying
 * resolvePendingIntegrationsForConnector is itself fault-tolerant (its
 * own try/catch returns `{ agentsUpdated: 0, agentIds: [] }` on failure)
 * but we guard here too so an unexpected throw doesn't escape and nack
 * the message. The auto-grant flow is best-effort: a miss leaves the
 * agent in `pending_integrations`, which the user can re-trigger by
 * reconnecting the connector.
 */
/**
 * Shared handler for `audit.platform_event` envelopes from cross-service
 * producers (liftoff-connector-service, liftoff-billing). Used by both:
 *
 *   - `handleControlPlaneEvent` (snake_case envelope from
 *     `control-plane-events-{env}-sub`), and
 *   - the camelCase audit-events subscription in `startEventSubscribers`.
 *
 * Both sites unwrap the producer's payload identically; this function is
 * the single point of truth for the envelope-to-audit-log translation.
 * Drops messages with no userId (system/cron paths).
 */
function handleAuditPlatformEvent(
  rawPayload: Record<string, unknown>,
  envelopeId?: string,
): void {
  const p = rawPayload as unknown as AuditPlatformEventPayload;
  if (!p.userId) {
    log.warn(
      { eventType: p.eventType, event_id: envelopeId },
      'audit.platform_event missing userId — dropping',
    );
    return;
  }
  insertAuditLogDirect({
    eventType: p.eventType,
    timestamp: new Date(p.occurredAt),
    tenantId: p.tenantId,
    userId: p.userId,
    resourceType: p.resourceType,
    resourceId: p.resourceId,
    action: p.action,
    previousState: p.previousState ?? undefined,
    newState: p.newState ?? undefined,
    metadata: p.metadata ?? {},
    ipAddress: p.ipAddress,
    userAgent: p.userAgent,
    traceId: p.traceId,
  });
}

interface KnowledgeItemCreatedPayload {
  tenantId?: string;
  itemId?: string;
}

async function handleKnowledgeItemsCreated(
  rawPayload: Record<string, unknown>,
  envelopeId?: string,
): Promise<void> {
  const p = rawPayload as KnowledgeItemCreatedPayload;
  if (!p.tenantId || !p.itemId) {
    log.warn({ event_id: envelopeId, payload: p }, 'knowledge.items.created missing tenantId/itemId — dropping');
    return;
  }

  // Load the item to confirm it's still pending. Skip if extraction is already
  // done or in-progress (idempotent under at-least-once delivery).
  // NOTE: the repository function is `findById(id, tenantId)` — id-first,
  // tenant-second. Not `getById`. Verified at repository.ts:61.
  const item = await knowledgeRepo.findById(p.itemId, p.tenantId);
  if (!item) {
    log.warn({ itemId: p.itemId, tenantId: p.tenantId, event_id: envelopeId }, 'knowledge.items.created: item not found, dropping');
    return;
  }
  if (item.extractionStatus !== 'pending') {
    log.debug({ itemId: p.itemId, status: item.extractionStatus }, 'knowledge.items.created: item not pending, skipping');
    return;
  }

  // Extract synchronously inline. On success, embed inline. On either failure,
  // state remains in DB (extraction_status='error' or embedding_v2 still NULL)
  // for the hourly backstop cron to retry. Structured log field
  // `processed_via: 'subscriber'` so ops can distinguish event-driven vs cron
  // path attribution (paired with `processed_via: 'cron'` in runExtractionBatch).
  const { ok } = await extractAndPersistItem(item);
  log.info({ itemId: p.itemId, ok, processed_via: 'subscriber', stage: 'extract' }, 'knowledge.items.created: extract done');
  if (!ok) return;
  try {
    await embedItem(p.tenantId, p.itemId);
    log.info({ itemId: p.itemId, processed_via: 'subscriber', stage: 'embed' }, 'knowledge.items.created: embed done');
  } catch {
    // logged inside embedItem; swallow so subscriber acks
  }
}

export async function handleControlPlaneEvent(
  envelope: ControlPlaneEventEnvelope,
): Promise<void> {
  const eventType = envelope.event_type;

  switch (eventType) {
    case 'connector.credentials_stored': {
      const tenantId = envelope.tenant_id;
      const connectorId = envelope.entity_id;
      const payload = (envelope.payload ?? {}) as CredentialsStoredPayload;
      const connectorType = payload.connectorType ?? payload.connector_type;

      if (!tenantId || !connectorId || !connectorType) {
        log.warn(
          {
            event_id: envelope.event_id,
            tenant_id: tenantId,
            connector_id: connectorId,
            has_connector_type: Boolean(connectorType),
          },
          'connector.credentials_stored missing required fields, skipping',
        );
        return;
      }

      try {
        const result = await resolvePendingIntegrationsForConnector(
          tenantId,
          connectorId,
          connectorType,
        );
        log.info(
          {
            event_id: envelope.event_id,
            tenant_id: tenantId,
            connector_id: connectorId,
            connector_type: connectorType,
            agents_updated: result.agentsUpdated,
          },
          'Resolved pending integrations from credentials_stored event',
        );
      } catch (err) {
        // resolvePendingIntegrationsForConnector already swallows its own
        // errors, but if something slipped past (e.g. a programmer error
        // before the try/catch) we still want to ack the message.
        log.warn(
          {
            event_id: envelope.event_id,
            tenant_id: tenantId,
            connector_id: connectorId,
            connector_type: connectorType,
            error: (err as Error).message,
          },
          'credentials_stored handler threw — acking to drop poison message',
        );
      }
      break;
    }

    case 'connector.deleted': {
      const tenantId = envelope.tenant_id;
      const connectorId = envelope.entity_id;
      const payload = (envelope.payload ?? {}) as ConnectorDeletedPayload;
      const connectorType = payload.connectorType ?? payload.connector_type;

      if (tenantId && connectorType) {
        await tenantRuntimeClient.deleteConnectorContent(tenantId, connectorType);
      }

      // Best-effort cleanup of knowledge webhook subscriptions for this connector.
      // Orphaned subscriptions would otherwise keep firing until natural expiry.
      if (tenantId && connectorId) {
        try {
          await cleanupWebhooksForConnector(tenantId, connectorId);
        } catch (err) {
          log.warn(
            { tenantId, connectorId, error: (err as Error).message },
            'connector.deleted: webhook cleanup failed',
          );
        }
      }

      // The binding is deliberately LEFT IN PLACE on internal_agents.
      //
      // This used to scrub the connector UUID out of every agent's
      // integrations[] array, which threw away the only record of what the
      // agent had been configured to use — a Gmail binding carries its own
      // sendAs and query, and once scrubbed there is nothing left to tell the
      // operator which capability the agent lost or to badge it in the UI.
      //
      // The two reasons the scrub gave for itself do not hold:
      //
      //   1. The validator does NOT 400 on the next edit. Disconnect is a soft
      //      delete (connectors.status='disconnected'), connector-service's
      //      /_resolve returns rows at any status, and integration-validator
      //      rejects only `disabled`. Nothing customer-reachable hard-deletes a
      //      connector row: the one hard delete in connector-service's
      //      connector-ops has no callers, and the custom-MCP delete path hits
      //      the same soft-delete endpoint (its raw DELETE targets this
      //      service's dead local mirror, which the validator never consults).
      //
      //   2. The agent does not keep calling a dead tool. Tenant runtime's own
      //      handler for this event flips connector_manifests.enabled = false,
      //      and the manifest query filters on enabled, so the tool leaves the
      //      catalog regardless of what integrations[] still says.
      //
      // What the surviving binding buys is the Teams page being able to say
      // "Gmail is no longer connected" instead of silently dropping an icon.

      // Drop the knowledge imported from this connector. `knowledge_items`
      // carries a connector-service id, which no foreign key in this database
      // can reference, so the delete happens here rather than through a
      // CASCADE (migration 356, ADR-049). Best-effort: a failure here leaves
      // rows that no agent can retrieve anyway, and must not nack an event
      // whose other handlers already ran.
      if (tenantId && connectorId) {
        try {
          const deleted = await deleteItemsForConnector(tenantId, connectorId);
          if (deleted > 0) {
            log.info(
              { tenant_id: tenantId, connector_id: connectorId, deleted },
              'connector.deleted: removed knowledge items for deleted connector',
            );
          }
        } catch (err) {
          log.warn(
            { tenantId, connectorId, error: (err as Error).message },
            'connector.deleted: knowledge item cleanup failed',
          );
        }
      }
      break;
    }

    case 'connector.disconnected': {
      // Audit-only handler for force-disconnect events (currently emitted by
      // connector-service's composio-migrate-reconnect script, and the user-
      // initiated disconnect path in connector-service/src/crud/router.ts).
      //
      // The user-facing "Needs Reconnect" affordance is data-driven: the
      // migration script sets `status='error'` + `config.disconnect_reason`
      // on the connector row, and the frontend's useIntegrations hook
      // surfaces `status='error'` as `needs_reconnect`. No notification row
      // is written here — the row only matters for observability + future
      // hooks (e.g. emailing tenants when a forced reconnect lands).
      const tenantId = envelope.tenant_id;
      const connectorId = envelope.entity_id;
      const payload = (envelope.payload ?? {}) as {
        connectorType?: string;
        connector_type?: string;
        reason?: string;
      };
      const connectorType = payload.connectorType ?? payload.connector_type;
      log.info(
        {
          event_id: envelope.event_id,
          tenant_id: tenantId,
          connector_id: connectorId,
          connector_type: connectorType,
          reason: payload.reason ?? 'unspecified',
        },
        'connector.disconnected received',
      );
      break;
    }

    case 'audit.platform_event': {
      // Cross-service audit bridge. Producers (liftoff-connector-service,
      // liftoff-billing) wrap human-initiated mutations as
      // `audit.platform_event` envelopes; we forward into `audit_log` so
      // they show up in the workspace audit feed. Shared between the
      // snake_case control-plane subscription (this switch) and the
      // camelCase audit-events subscription below — see
      // `handleAuditPlatformEvent`.
      handleAuditPlatformEvent(
        envelope.payload ?? {},
        envelope.event_id,
      );
      break;
    }

    case 'knowledge.items.created': {
      // Event-driven extract→embed: replaces the 5-min cron's happy path.
      // The standing extract-knowledge-content-{env} and
      // embed-knowledge-content-{env} crons drop to hourly cadence as backstops
      // (see Terraform main.tf). Always acks — failures leave DB state for
      // the backstop cron to recover.
      await handleKnowledgeItemsCreated(envelope.payload ?? {}, envelope.event_id);
      break;
    }

    default:
      // Unknown / uninteresting event — ack silently. Platform-backend is a
      // publisher on this same topic so it will see many of its own events
      // echo back through the subscription.
      break;
  }
}

/**
 * Start the Pub/Sub subscriber. Called from src/index.ts at boot.
 *
 * The subscriber installs a single `message` listener on
 * `control-plane-events-{env}-sub` and dispatches to handleControlPlaneEvent.
 * Messages are always acked (even on handler error) — see the doc comment
 * on handleControlPlaneEvent for why.
 */
export function startEventSubscribers(): void {
  if (subscriberInstance) {
    log.warn('startEventSubscribers called twice, ignoring');
    return;
  }

  const environment = process.env.ENVIRONMENT ?? 'dev';
  const subscriptionName = `${SHORT_TOPIC_NAME}-${environment}-sub`;

  pubsubInstance = new PubSub(
    process.env.GCP_PROJECT_ID
      ? { projectId: process.env.GCP_PROJECT_ID }
      : {},
  );

  const subscription = pubsubInstance.subscription(subscriptionName, {
    flowControl: {
      maxMessages: FLOW_CONTROL_MAX_MESSAGES,
      allowExcessMessages: false,
    },
  });

  subscription.on('message', async (message: Message) => {
    let envelope: ControlPlaneEventEnvelope | null = null;
    try {
      envelope = JSON.parse(message.data.toString()) as ControlPlaneEventEnvelope;
    } catch (err) {
      log.warn(
        { message_id: message.id, error: (err as Error).message },
        'Failed to parse Pub/Sub message body, acking to drop',
      );
      message.ack();
      return;
    }

    try {
      await handleControlPlaneEvent(envelope);
    } catch (err) {
      // Final safety net — handleControlPlaneEvent shouldn't throw, but
      // we never want to nack and retry a poison message indefinitely.
      log.warn(
        {
          message_id: message.id,
          event_type: envelope?.event_type,
          error: (err as Error).message,
        },
        'Unhandled error processing control-plane event, acking',
      );
    } finally {
      message.ack();
    }
  });

  subscription.on('error', (err: Error) => {
    const isNotFound = err.message.includes('Resource not found') || err.message.includes('NOT_FOUND');
    if (isNotFound) {
      log.warn(
        { subscription: subscriptionName, error: err.message },
        'Pub/Sub subscription not found — create it via Terraform or gcloud pubsub subscriptions create',
      );
    } else {
      log.error(
        { subscription: subscriptionName, error: err.message },
        'Pub/Sub subscription error',
      );
    }
  });

  subscriberInstance = subscription;

  log.info(
    { subscription: subscriptionName },
    'Subscribed to control-plane-events',
  );

  // Audit events from governance-engine
  const auditSubscriptionName =
    process.env.AUDIT_EVENTS_SUBSCRIPTION ??
    `audit-events-${environment}-platform-backend-sub`;

  const auditSubscription = pubsubInstance.subscription(auditSubscriptionName, {
    flowControl: {
      maxMessages: FLOW_CONTROL_MAX_MESSAGES,
      allowExcessMessages: false,
    },
  });

  auditSubscription.on('message', async (message: Message) => {
    try {
      const envelope = JSON.parse(message.data.toString()) as {
        eventType: string;
        occurredAt: string;
        payload: Record<string, unknown>;
      };

      if (envelope.eventType === 'audit.platform_event') {
        handleAuditPlatformEvent(envelope.payload ?? {});
      } else if (envelope.eventType === 'audit.agent_action') {
        const p = envelope.payload as {
          tenantId: string;
          internalAgentId?: string;
          externalAgentId?: string;
          threadId?: string;
          invocationId?: string;
          action: string;
          inputArgs: Record<string, unknown>;
          outcome: AuditOutcome;
          triggeredBy: string;
          outputSummary?: string;
          errorCode?: string;
          durationMs?: number;
          preActionSnapshot?: Record<string, unknown> | null;
          postActionSnapshot?: Record<string, unknown> | null;
          externalResponse?: Record<string, unknown> | null;
          snapshotStatus?: string;
        };
        await agentAuditLogsService.insertAuditLog({
          tenantId: p.tenantId,
          internalAgentId: p.internalAgentId,
          externalAgentId: p.externalAgentId,
          threadId: p.threadId,
          invocationId: p.invocationId,
          action: p.action,
          inputArgs: p.inputArgs,
          outcome: p.outcome,
          triggeredBy: p.triggeredBy,
          outputSummary: p.outputSummary,
          errorCode: p.errorCode,
          durationMs: p.durationMs,
          preActionSnapshot: p.preActionSnapshot,
          postActionSnapshot: p.postActionSnapshot,
          externalResponse: p.externalResponse,
          snapshotStatus: p.snapshotStatus,
        });
      }
    } catch (err) {
      log.error({ err }, 'audit-events: failed to process message');
    } finally {
      message.ack();
    }
  });

  auditSubscription.on('error', (err: Error) => {
    const isNotFound = err.message.includes('Resource not found') || err.message.includes('NOT_FOUND');
    if (isNotFound) {
      log.warn(
        { subscription: auditSubscriptionName, error: err.message },
        'audit-events Pub/Sub subscription not found — create it via Terraform or gcloud pubsub subscriptions create',
      );
    } else {
      log.error(
        { subscription: auditSubscriptionName, error: err.message },
        'audit-events subscription error',
      );
    }
  });

  log.info(
    { subscription: auditSubscriptionName },
    'Subscribed to audit-events',
  );
}
