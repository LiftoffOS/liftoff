// Event Publisher
// Per Section 4: Control plane publishes events to tenant runtime.
//
// Routes through the outbox tables (internal_agent_outbox for
// internal_agent.* events, control_plane_outbox for everything else) for
// at-least-once delivery. A direct-publish path would silently lose events on
// transient Pub/Sub failures (typed wrapper swallowed errors) or rethrow into
// the request handler (other callers handled inconsistently).
//
// Two shapes:
//
//   1. publishEvent(input) — legacy convenience. Opens its own withAdminScope
//      tx, enqueues an outbox row, commits, inline-publishes, returns. Does
//      NOT close the cross-tx window between caller's entity mutation and the
//      outbox INSERT. Use only when refactoring the caller to shape 2 is not
//      yet practical.
//
//   2. publishEventInTx(client, input) — canonical pattern. Enqueues in the
//      caller's transaction and returns an outbox row ref. Caller MUST call
//      publishOutboxRowInline AFTER commit. This is the shape PR-E2 migrates
//      every caller to.
//
// publishEventWithExplicitId is the raw-publish primitive used by the outbox
// workers (so retries reuse the persisted event_id and the runtime-side dedupe
// ledger keys correctly).

import type { PoolClient } from 'pg';
import { PubSub, Topic } from '@google-cloud/pubsub';
import { ControlPlaneEvent, PublishEventInput } from './types';
import { log } from '../infrastructure/logging';
import { withAdminScope } from '../infrastructure/database';
import {
  enqueueControlPlaneOutbox,
  publishControlPlaneOutboxRowInline,
  type ControlPlaneOutboxRowRef,
} from './outbox';
import {
  enqueueInternalAgentOutbox,
  publishOutboxRowInline as publishInternalAgentOutboxRowInline,
  type InternalAgentOutboxEventType,
  type OutboxRowRef as InternalAgentOutboxRowRef,
} from '../internal-agents/outbox';

const pubsub = new PubSub();
const topicCache = new Map<string, Topic>();

function getTopic(topicName: string): Topic {
  if (!topicCache.has(topicName)) {
    topicCache.set(topicName, pubsub.topic(topicName));
  }
  return topicCache.get(topicName)!;
}

export type AnyOutboxRowRef = InternalAgentOutboxRowRef | ControlPlaneOutboxRowRef;

// Shape 1 (legacy). Routes through outbox internally.
//
// Error semantics preserve the pre-outbox contract per event family:
//   - internal_agent.* events: typed wrapper (events.ts:40-43) historically
//     swallowed Pub/Sub failures (the silent-loss failure mode described
//     above). Outbox + reconciler are the new recovery path.
//     So we SWALLOW for backwards compatibility — callers do not need to
//     change.
//   - All other event types (account.*, tenant.activated, model.*, etc.):
//     the original publishEvent at line 71 RETHREW. Callers expected to
//     handle (some explicitly catch + return 5xx). We RETHROW outbox-
//     enqueue failures so those callers see the failure on the request path.
//
// The split keeps behavior compatible with every existing caller while still
// upgrading internal_agent.* to outbox-backed at-least-once delivery.
export async function publishEvent(input: PublishEventInput): Promise<void> {
  try {
    const rowRef = await withAdminScope(
      { caller: 'publishEvent', reason: `enqueue ${input.eventType}` },
      (client) => enqueueAny(client, input),
    );
    await publishOutboxRowInline(rowRef);
  } catch (error) {
    log.error(
      {
        error,
        eventType: input.eventType,
        entityType: input.entityType,
        entityId: input.entityId,
      },
      'Failed to enqueue event into outbox',
    );
    if (input.entityType !== 'internal_agent') {
      // Preserve the rethrow contract for non-internal-agent callers — many
      // explicitly catch and return 5xx (e.g. account creation rolls back).
      throw error;
    }
    // For internal_agent: swallow, matching the legacy typed-wrapper contract.
    // Reconciler catches drift within 5 min.
  }
}

// Shape 2 (canonical). Enqueue in caller's tx; caller publishes inline after commit.
export async function publishEventInTx(
  client: PoolClient,
  input: PublishEventInput,
): Promise<AnyOutboxRowRef> {
  return enqueueAny(client, input);
}

// Shape 3 (canonical helper, plan §5.4). Wraps the entity mutation AND the
// outbox enqueue in a single withAdminScope transaction, then publishes inline
// after commit. Use this when you need ATOMICITY between the entity mutation
// and the event publish — i.e., if the entity row commits, the event WILL
// reach Pub/Sub (inline on the happy path, via worker on transient failure,
// via reconciler in catastrophic failure).
//
// Usage:
//   const tenant = await mutateAndPublishEvent(
//     { caller: 'TenantService.activate', actor: userId, reason: 'activate tenant' },
//     async (client) => {
//       const t = await this.repository.activate(client, id);
//       return {
//         entity: t,
//         eventInput: {
//           entityType: 'tenant', entityId: t.id, eventType: 'tenant.activated',
//           entityVersion: 1, eventVersion: 1, tenantId: t.id, payload: {},
//         },
//       };
//     },
//   );
//
// The repository method MUST accept the provided `client` and use it for all
// DB statements (so they share the tx). Repositories that don't yet accept a
// client param need a `*InTx(client, ...)` variant adding.
export async function mutateAndPublishEvent<T>(
  ctx: { caller: string; actor?: string; reason?: string },
  mutate: (client: PoolClient) => Promise<{ entity: T; eventInput: PublishEventInput | null }>,
): Promise<T> {
  const { entity, rowRef } = await withAdminScope(ctx, async (client) => {
    const { entity, eventInput } = await mutate(client);
    // eventInput === null is the explicit "no mutation happened, do not publish"
    // signal. Used by not-found paths (concurrent delete race, etc.) so we don't
    // pollute the outbox with no-op events the runtime would then have to ignore.
    const ref = eventInput === null ? null : await enqueueAny(client, eventInput);
    return { entity, rowRef: ref };
  });
  if (rowRef !== null) {
    // Tx committed. Inline publish never throws — failures land on outbox-pending
    // and the worker drains within 30s.
    await publishOutboxRowInline(rowRef);
  }
  return entity;
}

async function enqueueAny(client: PoolClient, input: PublishEventInput): Promise<AnyOutboxRowRef> {
  if (input.entityType === 'internal_agent') {
    if (!input.tenantId) {
      throw new Error('internal_agent events require tenantId');
    }
    return enqueueInternalAgentOutbox(client, {
      tenantId: input.tenantId,
      internalAgentId: input.entityId,
      eventType: input.eventType as InternalAgentOutboxEventType,
      entityVersion: input.entityVersion,
      payload: input.payload ?? {},
    });
  }
  return enqueueControlPlaneOutbox(client, {
    tenantId: input.tenantId ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    entityVersion: input.entityVersion,
    payload: input.payload ?? {},
  });
}

export async function publishOutboxRowInline(row: AnyOutboxRowRef): Promise<{ inlinePublished: boolean }> {
  return 'internalAgentId' in row
    ? publishInternalAgentOutboxRowInline(row)
    : publishControlPlaneOutboxRowInline(row);
}

// Raw publish primitive used by the outbox workers. Persists the caller-supplied
// event_id so retries hit runtime-side dedupe (event_processing_ledger
// ON CONFLICT (tenant_id, event_id)) instead of double-processing.
export async function publishEventWithExplicitId(
  input: PublishEventInput & { eventId: string },
): Promise<void> {
  const fullEvent: ControlPlaneEvent = {
    event_id: input.eventId,
    schema_version: input.schemaVersion ?? 1,
    occurred_at: new Date().toISOString(),
    entity_type: input.entityType,
    entity_id: input.entityId,
    event_type: input.eventType,
    // null entity_version is intentionally omitted — subscribers skip the version
    // gate when the field is absent, allowing backfill events to always process.
    ...(input.entityVersion != null && { entity_version: input.entityVersion }),
    event_version: input.eventVersion,
    tenant_id: input.tenantId ?? undefined,
    payload: input.payload,
  };

  const environment = process.env.ENVIRONMENT || 'dev';
  const topicName = `control-plane-events-${environment}`;
  const topic = getTopic(topicName);

  try {
    const messageId = await topic.publishMessage({
      data: Buffer.from(JSON.stringify(fullEvent)),
      attributes: {
        eventType: input.eventType,
        entityType: input.entityType,
        entityId: input.entityId,
        ...(input.tenantId && { tenantId: input.tenantId }),
      },
    });

    log.debug({
      event_id: fullEvent.event_id,
      event_type: input.eventType,
      entity_type: input.entityType,
      entity_id: input.entityId,
      tenant_id: input.tenantId,
      messageId,
    }, 'Event published');
  } catch (error) {
    log.error({
      error,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
    }, 'Failed to publish event');
    throw error;
  }
}

// Batch publish multiple events
export async function publishEvents(inputs: PublishEventInput[]): Promise<void> {
  await Promise.all(inputs.map(publishEvent));
}
