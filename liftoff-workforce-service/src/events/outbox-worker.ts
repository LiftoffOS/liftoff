// Outbox Worker
//
// Polls outbox_events at a configurable interval. For each batch it:
//   1. Claims the row with an optimistic lock (locked_until = NOW() + 5 min).
//   2. Publishes the event to the configured Pub/Sub topic.
//   3. On success: deletes from outbox_events, inserts into processed_events.
//   4. On failure: leaves the row for the next poll cycle.
//
// After MAX_ATTEMPTS failures the row is moved to a dead-letter log entry and
// deleted so it never blocks the queue permanently.

import { PubSub } from '@google-cloud/pubsub';
import { loadConfig } from '../infrastructure/config.js';
import { getPool } from '../infrastructure/database.js';
import { log } from '../infrastructure/logging.js';

const MAX_ATTEMPTS = 10;

const pubsub = new PubSub();

interface OutboxRow {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  entity_version: number;
  event_version: number;
  tenant_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
}

async function processBatch(): Promise<void> {
  const config = loadConfig();
  const pool = getPool();

  // 1. Fetch unlocked (or expired-lock) rows
  const fetchResult = await pool.query<OutboxRow>(
    `SELECT id, entity_type, entity_id, event_type, entity_version, event_version,
            tenant_id, payload, attempts, created_at
     FROM outbox_events
     WHERE locked_until IS NULL OR locked_until < NOW()
     ORDER BY created_at ASC
     LIMIT $1`,
    [config.OUTBOX_BATCH_SIZE],
  );

  if (fetchResult.rows.length === 0) return;

  const topic = pubsub.topic(config.WORKFORCE_EVENTS_TOPIC);

  for (const row of fetchResult.rows) {
    // 2. Optimistic lock: claim the row
    const lockResult = await pool.query(
      `UPDATE outbox_events
       SET locked_until = NOW() + INTERVAL '5 minutes',
           attempts = attempts + 1
       WHERE id = $1
         AND (locked_until IS NULL OR locked_until < NOW())`,
      [row.id],
    );

    // Another worker grabbed it — skip
    if ((lockResult.rowCount ?? 0) === 0) continue;

    const currentAttempts = row.attempts + 1; // +1 for the increment we just did

    // Dead-letter after MAX_ATTEMPTS
    if (currentAttempts > MAX_ATTEMPTS) {
      log.error(
        {
          outboxId: row.id,
          entityType: row.entity_type,
          entityId: row.entity_id,
          eventType: row.event_type,
          tenantId: row.tenant_id,
          attempts: currentAttempts,
        },
        'Outbox event exceeded max attempts — moving to dead letter and discarding',
      );
      await pool.query(`DELETE FROM outbox_events WHERE id = $1`, [row.id]);
      continue;
    }

    // 3. Publish to Pub/Sub
    try {
      const data = Buffer.from(
        JSON.stringify({
          entityType: row.entity_type,
          entityId: row.entity_id,
          eventType: row.event_type,
          entityVersion: row.entity_version,
          eventVersion: row.event_version,
          tenantId: row.tenant_id,
          payload: row.payload,
          publishedAt: new Date().toISOString(),
        }),
      );

      await topic.publish(data, {
        entityType: row.entity_type,
        eventType: row.event_type,
        tenantId: row.tenant_id,
      });

      // 4. Success — delete from outbox, insert into processed_events
      await pool.query(`DELETE FROM outbox_events WHERE id = $1`, [row.id]);

      // processed_events schema is the slim (event_id, processed_at) dedup
      // log from migration 011 — not a full event archive. Inserting the full
      // outbox row threw "column id ... does not exist", left the outbox row
      // in place, and caused duplicate Pub/Sub publishes on every retry cycle.
      await pool.query(
        `INSERT INTO processed_events (event_id)
         VALUES ($1)
         ON CONFLICT (event_id) DO NOTHING`,
        [row.id],
      );

      log.debug(
        { outboxId: row.id, eventType: row.event_type, tenantId: row.tenant_id },
        'Outbox event published and acknowledged',
      );
    } catch (err) {
      // 5. Failure — leave the row; it will be retried next poll
      log.warn(
        {
          outboxId: row.id,
          eventType: row.event_type,
          tenantId: row.tenant_id,
          attempts: currentAttempts,
          err: (err as Error).message,
        },
        'Failed to publish outbox event — will retry on next poll',
      );
    }
  }
}

/**
 * Start the outbox polling loop. Returns the interval handle so the caller
 * can stop it cleanly during server shutdown.
 */
export function startOutboxWorker(): NodeJS.Timeout {
  const config = loadConfig();
  const intervalMs = config.OUTBOX_POLL_INTERVAL_MS;

  log.info({ intervalMs }, 'Outbox worker started');

  const handle = setInterval(() => {
    processBatch().catch(err => {
      log.error({ err: (err as Error).message }, 'Outbox worker poll cycle failed');
    });
  }, intervalMs);

  return handle;
}

/**
 * Stop the outbox polling loop.
 */
export function stopOutboxWorker(handle: NodeJS.Timeout): void {
  clearInterval(handle);
  log.info('Outbox worker stopped');
}
