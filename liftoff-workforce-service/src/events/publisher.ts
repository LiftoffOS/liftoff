// Outbox-based event publisher for liftoff-workforce-service.
//
// publishEvent() inserts an event record into the outbox_events table.
// The outbox-worker picks these up and delivers them to Pub/Sub, guaranteeing
// at-least-once delivery even if the Cloud Run instance restarts mid-request.
//
// Pass a PoolClient to insert atomically within the caller's transaction.
// Omit it to use a standalone pool query (no transaction guarantees).

import { getPool } from '../infrastructure/database.js';
import { log } from '../infrastructure/logging.js';
import type { PoolClient } from 'pg';

export interface EventPayload {
  entityType: string;
  entityId: string;
  eventType: string;
  entityVersion: number;
  eventVersion: number;
  tenantId: string;
  payload: Record<string, unknown>;
}

/**
 * Inserts an event into the outbox_events table. Pass a PoolClient to
 * insert atomically with the calling transaction; omit to use a fresh
 * connection from the pool.
 */
export async function publishEvent(
  event: EventPayload,
  client?: PoolClient,
): Promise<void> {
  const sql = `
    INSERT INTO outbox_events
      (entity_type, entity_id, event_type, entity_version, event_version, tenant_id, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  `;
  const params = [
    event.entityType,
    event.entityId,
    event.eventType,
    event.entityVersion,
    event.eventVersion,
    event.tenantId,
    JSON.stringify(event.payload),
  ];

  try {
    if (client) {
      await client.query(sql, params);
    } else {
      await getPool().query(sql, params);
    }
  } catch (err) {
    log.error({ err, event }, 'Failed to insert event into outbox_events');
    throw err;
  }
}
