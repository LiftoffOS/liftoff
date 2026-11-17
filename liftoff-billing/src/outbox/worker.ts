// Phase 1e / 0f — outbox publisher worker. Drains
// `outbox_events WHERE published_at IS NULL` to Pub/Sub with
// `ordering_key = tenant_id`. Runs on every billing service instance;
// Postgres `FOR UPDATE SKIP LOCKED` prevents double-publish.
//
// Topic resolution: billing.* event types → `billing-events-${env}`.
// byok.* event types (when billing re-publishes) → `byok-events-${env}`.

import { PubSub } from '@google-cloud/pubsub';
import { OutboxPublisher, type EventEnvelope } from '@liftoffos/outbox';
import { getOutboxPool } from '../infrastructure/database.js';
import { loadConfig } from '../infrastructure/config.js';

// Logger interface compatible with the Fastify-injected Pino root logger
// (server.ts: const app = Fastify({ logger: { level: ... } })). Callers pass
// `app.log` (or any Pino instance) so structured Cloud Logging output is
// preserved with the same correlation context as the rest of the service.
export interface OutboxLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

let publisher: OutboxPublisher | null = null;
let lagInterval: NodeJS.Timeout | null = null;

export async function startOutboxPublisher(deps?: { log?: OutboxLogger }): Promise<OutboxPublisher> {
  if (publisher) return publisher;
  const config = loadConfig();
  const pool = await getOutboxPool();
  const pubsub = new PubSub({ projectId: config.GCP_PROJECT_ID });
  publisher = new OutboxPublisher(pool, pubsub, {
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
    topicResolver: (env: EventEnvelope) => topicFor(env.eventType, config.ENVIRONMENT),
  });
  publisher.start();

  // Emit max-age lag gauge so we can alert at >60s in prod.
  const log = deps?.log;
  if (log) {
    lagInterval = setInterval(async () => {
      try {
        const { rows } = await pool.query<{ age_seconds: string | null }>( // rls-fence: allow (cross-tenant queue health sweep; outbox_events spans every tenant by design)
          // outbox_events has `occurred_at`, not `created_at` (see
          // migrations/001_initial_schema.sql). Querying `created_at` fails
          // every time with `outbox.publisher.lag_query_failed` and the gauge
          // never produces a usable value.
          `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at)))::text AS age_seconds
             FROM outbox_events WHERE published_at IS NULL`,
        );
        const age = rows[0]?.age_seconds ? parseFloat(rows[0].age_seconds) : 0;
        log.info({ outbox_unpublished_age_seconds: age }, 'outbox.publisher.lag');
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'outbox.publisher.lag_query_failed');
      }
    }, 5_000);
  }

  return publisher;
}

export async function stopOutboxPublisher(): Promise<void> {
  if (lagInterval) { clearInterval(lagInterval); lagInterval = null; }
  if (publisher)   { await publisher.stop(); publisher = null; }
}

export async function drainOutboxOnce(): Promise<number> {
  if (!publisher) publisher = await startOutboxPublisher();
  return publisher.drain();
}

function topicFor(eventType: string, env: string): string {
  return `${eventType.split('.')[0]}-events-${env}`;
}
