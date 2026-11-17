// Control-plane event publisher.
//
// Ported from platform-backend/src/events/publisher.ts — publishes the same
// wire envelope (event_id / occurred_at / entity_type / event_type /
// entity_version / event_version / tenant_id / payload) onto the shared
// `control-plane-events-{env}` topic so existing subscribers (tenant-runtime,
// billing, audit) keep working unchanged.
//
// Uses @liftoffos/pubsub's PubSubPublisher under the hood so topic handles
// are cached and logging is unified with the rest of the service.

import { randomUUID } from 'node:crypto';
import { PubSubPublisher } from '@liftoffos/pubsub';
import { logger } from '../infra/logging.js';

export interface ControlPlaneEvent {
  event_id: string;
  schema_version?: number;
  tenant_id?: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  entity_version?: number;
  event_version: number;
  occurred_at: string;
  payload?: Record<string, unknown>;
}

export interface PublishEventInput {
  entityType: string;
  entityId: string;
  eventType: string;
  entityVersion?: number;
  eventVersion: number;
  schemaVersion?: number;
  tenantId?: string;
  payload?: Record<string, unknown>;
  /**
   * Extra Pub/Sub message attributes to merge onto the default
   * `{ eventType, entityType, entityId, tenantId }` set. Useful for
   * letting subscribers filter on payload-level fields (e.g. connectorType)
   * without having to deserialize the JSON body.
   */
  attributes?: Record<string, string>;
}

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
export function __setPublisher(p: PubSubPublisher | null): void {
  publisherInstance = p;
}

function resolveTopicName(): string {
  const environment = process.env.ENVIRONMENT ?? 'dev';
  return `control-plane-events-${environment}`;
}

export async function publishEvent(input: PublishEventInput): Promise<void> {
  const fullEvent: ControlPlaneEvent = {
    event_id: randomUUID(),
    schema_version: input.schemaVersion ?? 1,
    occurred_at: new Date().toISOString(),
    entity_type: input.entityType,
    entity_id: input.entityId,
    event_type: input.eventType,
    entity_version: input.entityVersion,
    event_version: input.eventVersion,
    tenant_id: input.tenantId,
    payload: input.payload,
  };

  const attributes: Record<string, string> = {
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
  };
  if (input.tenantId) {
    attributes.tenantId = input.tenantId;
  }
  if (input.attributes) {
    for (const [k, v] of Object.entries(input.attributes)) {
      if (typeof v === 'string' && v.length > 0) {
        attributes[k] = v;
      }
    }
  }

  try {
    await getPublisher().publish(resolveTopicName(), fullEvent, { attributes });
    logger.debug(
      {
        event_id: fullEvent.event_id,
        event_type: input.eventType,
        entity_type: input.entityType,
        entity_id: input.entityId,
        tenant_id: input.tenantId,
      },
      'event published',
    );
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        eventType: input.eventType,
        entityType: input.entityType,
        entityId: input.entityId,
      },
      'failed to publish event',
    );
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────
// connector.credentials_stored — fire-and-forget
//
// Published after a successful OAuth / API-key / keypair credential store
// so downstream services (e.g. platform-backend's internal-agents module)
// can resolve `pending_integrations → integrations` on the freshly
// connected connector. This signal is a downstream convenience — the
// source of truth is the connector_credentials row + Secret Manager
// entry, which are already persisted when this fires. Never fail the
// OAuth callback if the publish fails: log at warn level and move on.
// ──────────────────────────────────────────────────────────────────────

export interface CredentialsStoredInput {
  tenantId: string;
  connectorId: string;
  connectorType: string;
  /**
   * Composio cutover-completion (C5): for composio_managed connectors,
   * the OAuth callback passes Composio's connectedAccountId here so the
   * downstream tenant-runtime subscriber can persist it on the manifest
   * row (connector_manifests.external_account_id). tenant-runtime's
   * composio-dispatcher reads it from manifest.externalAccountId and
   * passes it as composio.tools.execute({ connectedAccountId: ... })
   * to disambiguate multi-account tenants (allowMultiple: true at
   * install). Absent for native connectors.
   */
  composioConnectedAccountId?: string;
}

export async function publishCredentialsStored(
  input: CredentialsStoredInput,
): Promise<void> {
  try {
    await publishEvent({
      entityType: 'connector',
      entityId: input.connectorId,
      eventType: 'connector.credentials_stored',
      eventVersion: 1,
      tenantId: input.tenantId,
      payload: {
        connectorId: input.connectorId,
        connectorType: input.connectorType,
        timestamp: Date.now(),
        ...(input.composioConnectedAccountId
          ? { composioConnectedAccountId: input.composioConnectedAccountId }
          : {}),
      },
      attributes: {
        connectorType: input.connectorType,
      },
    });
  } catch (err) {
    // Fire-and-forget: credential storage is the source of truth; this
    // event is a downstream convenience. Warn and swallow so the caller
    // (the OAuth callback / API-key handler) still returns success.
    logger.warn(
      {
        err: (err as Error).message,
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        connectorType: input.connectorType,
      },
      'failed to publish connector.credentials_stored (non-fatal)',
    );
  }
}

/**
 * Non-blocking variant used by OAuth/API-key/keypair handlers. Kicks off
 * the publish on the event loop and returns immediately so the HTTP
 * response is not held up by Pub/Sub latency, flakes, or misconfig. Any
 * eventual failure is warned inside publishCredentialsStored.
 */
export function emitCredentialsStored(input: CredentialsStoredInput): void {
  // Explicitly discard the promise — publishCredentialsStored handles its
  // own errors, so there is nothing for the caller to do.
  void publishCredentialsStored(input);
}
