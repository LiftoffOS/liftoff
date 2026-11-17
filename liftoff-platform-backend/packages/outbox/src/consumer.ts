import type { Pool, PoolClient } from 'pg';

import type { EventEnvelope } from './envelope.js';

export interface OutboxConsumerResult {
  /** True when the event was seen before — handler was NOT invoked. */
  alreadyProcessed: boolean;
}

/**
 * Invoke `handler` exactly-once for a given event. Begins a transaction,
 * inserts into `processed_events` (UNIQUE on event_id), runs the handler,
 * and commits. A duplicate event_id is detected via Postgres unique
 * violation (SQLSTATE 23505) and the handler is skipped.
 *
 * Callers should run their business-state mutations inside `handler`; the
 * dedup row + the mutation commit atomically.
 */
export async function withOutboxConsumer<T>(
  pool: Pool,
  envelope: EventEnvelope<T>,
  handler: (client: PoolClient, envelope: EventEnvelope<T>) => Promise<void>,
): Promise<OutboxConsumerResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2)`,
        [envelope.eventId, envelope.eventType],
      );
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        await client.query('ROLLBACK');
        return { alreadyProcessed: true };
      }
      await client.query('ROLLBACK');
      throw err;
    }

    try {
      await handler(client, envelope);
      await client.query('COMMIT');
      return { alreadyProcessed: false };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
