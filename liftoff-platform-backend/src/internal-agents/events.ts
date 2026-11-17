// Internal Agents Events
// Pub/Sub event publishing for tenant runtime synchronization.
//
// Routes through internal_agent_outbox for at-least-once delivery. A
// direct-publish path that catches and logs Pub/Sub failures swallows them
// silently — exactly the failure mode that leaves a runtime agent with
// NO_INSTRUCTION.
//
// Two callsite shapes:
//
//   1. Legacy (no tx client): publishInternalAgentEvent(...) opens its own
//      withAdminScope tx, enqueues the outbox row, commits, and inline-publishes.
//      The "entity mutation + outbox INSERT same tx" invariant is NOT guaranteed
//      in this shape — if PB crashes between the caller's commit and our tx, the
//      event is lost. The reconciler (Phase 6) catches this within 5 min.
//
//   2. Canonical (tx client): publishInternalAgentEventInTx(client, ...) enqueues
//      the row in the caller's transaction and returns an OutboxRowRef. The
//      caller is responsible for calling publishOutboxRowInline AFTER commit.
//      This shape closes the cross-tx window.
//
// PR-E2 migrates the 12 known callsites from shape 1 to shape 2 file-by-file.

import type { PoolClient } from 'pg';
import { publishEvent } from '../events/publisher';
import {
  enqueueInternalAgentOutbox,
  publishOutboxRowInline,
  type InternalAgentOutboxEventType,
  type OutboxRowRef,
} from './outbox';
import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

export { publishEvent, publishOutboxRowInline };
export type { OutboxRowRef };

export type InternalAgentEventType = InternalAgentOutboxEventType;

// Shape 1 (legacy convenience): opens its own withAdminScope tx to enqueue the
// outbox row, commits, and publishes inline. NEVER throws — failures leave the
// row pending for the worker.
//
// Callers that have access to a tx client should use publishInternalAgentEventInTx
// instead to close the cross-tx window.
export async function publishInternalAgentEvent(
  eventType: InternalAgentEventType,
  internalAgentId: string,
  tenantId: string,
  entityVersion: number | null,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const rowRef = await withAdminScope(
      { caller: 'publishInternalAgentEvent', reason: `enqueue ${eventType}` },
      (client) => enqueueInternalAgentOutbox(client, {
        tenantId,
        internalAgentId,
        eventType,
        entityVersion,
        payload,
      }),
    );
    await publishOutboxRowInline(rowRef);
    log.info({ eventType, internalAgentId, tenantId, entityVersion, eventId: rowRef.eventId }, 'Internal agent event enqueued');
  } catch (error) {
    log.error({ error, eventType, internalAgentId, tenantId }, 'Failed to enqueue internal agent event');
    // Don't throw - matches the prior typed-wrapper contract so existing callers
    // continue to return 2xx on outbox-enqueue failure. Reconciler will catch it.
  }
}

// Shape 2 (canonical): enqueue in caller's tx, return ref. Caller MUST call
// publishOutboxRowInline AFTER commit.
export async function publishInternalAgentEventInTx(
  client: PoolClient,
  eventType: InternalAgentEventType,
  internalAgentId: string,
  tenantId: string,
  entityVersion: number | null,
  payload: Record<string, unknown>,
): Promise<OutboxRowRef> {
  return enqueueInternalAgentOutbox(client, {
    tenantId,
    internalAgentId,
    eventType,
    entityVersion,
    payload,
  });
}
