import { PubSub } from '@google-cloud/pubsub';
import { OutboxPublisher, type EventEnvelope } from '@liftoffos/outbox';
import { getPool } from '../infrastructure/database.js';
import { loadConfig } from '../infrastructure/config.js';
import { resolvePlatformBackendToken } from '../infrastructure/platform-backend-token.js';

// Outbox delivery runs inside requests, never on a timer. developer-proxy is on
// request-based CPU, so a polling loop gets CPU only while some request happens
// to be in flight. drainOutboxes() is awaited by the ingestion-feed request
// (usage/routes.ts) and by shutdown (server.ts). The feed is polled by
// platform-backend's cost pass, which this service arms after recording usage
// (usage/cost-ingest-poke.ts), so an event waits ~10 minutes for Pub/Sub or
// the activity page, and at most a day when a poke is lost.

let publisher: OutboxPublisher | null = null;

async function getOutboxPublisher(): Promise<OutboxPublisher> {
  if (publisher) return publisher;
  const config = loadConfig();
  const pool = await getPool();
  const pubsub = new PubSub({ projectId: config.GCP_PROJECT_ID });
  publisher = new OutboxPublisher(pool, pubsub, {
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
    // Exclude audit.* events from Pub/Sub delivery entirely. AuditLogDeliveryWorker
    // owns the audit.* namespace and delivers those rows via HTTP POST to
    // platform-backend. This prevents the two workers from racing over the same rows.
    excludeEventTypePatterns: ['audit.%'],
    // Terraform-managed analytics topic. Pub/Sub is an
    // analytics/archive delivery path ONLY — it is NOT the OU-charging path;
    // Platform Backend's polling ingester over the usage feed charges OUs.
    // The events carry the same attempt/feed-event identifiers as the polling
    // feed so a later migration can deduplicate safely.
    topicResolver: (_env: EventEnvelope) => `developer-proxy-usage-${config.ENVIRONMENT}`,
  });
  return publisher;
}

// ---------------------------------------------------------------------------
// Audit Log Delivery Worker
// Polls outbox_events for audit.* events that have not yet been published
// and delivers them to the platform-backend /api/agent-audit-logs endpoint
// via HTTP POST using the shared TENANT_RUNTIME_SERVICE_TOKEN.
// ---------------------------------------------------------------------------

export interface AuditLogDeliveryWorkerOptions {
  batchSize?: number;
}

export class AuditLogDeliveryWorker {
  private serviceToken: string | null = null;

  constructor(private readonly opts: AuditLogDeliveryWorkerOptions = {}) {}

  private async resolveServiceToken(): Promise<string> {
    if (!this.serviceToken) this.serviceToken = await resolvePlatformBackendToken();
    return this.serviceToken;
  }

  /** Deliver one batch; returns how many rows it settled (published or abandoned). */
  async deliverBatch(): Promise<number> {
    const config = loadConfig();

    // Skip delivery if platform-backend URL is not configured
    if (!config.CONTROL_PLANE_API_URL) return 0;

    const pool = await getPool();
    const { batchSize = 100 } = this.opts;
    const MAX_RETRIES = 10;

    const { rows } = await pool.query<{
      id: number;
      event_id: string;
      event_type: string;
      tenant_id: string;
      payload: Record<string, unknown>;
      retry_count: number;
    }>(
      `SELECT id, event_id, event_type, tenant_id, payload, retry_count
       FROM outbox_events
       WHERE published_at IS NULL
         AND event_type LIKE 'audit.%'
         AND (retry_count IS NULL OR retry_count < $2)
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize, MAX_RETRIES],
    );

    if (rows.length === 0) return 0;

    const serviceToken = await this.resolveServiceToken();
    let settled = 0;
    const endpoint = `${config.CONTROL_PLANE_API_URL}/api/agent-audit-logs`;

    for (const row of rows) {
      try {
        const res = await (fetch as (url: string, init: unknown) => Promise<Response>)(
          endpoint,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-service-auth': serviceToken,
            },
            body: JSON.stringify(row.payload),
          },
        );

        if (!res.ok) {
          if (res.status >= 500) {
            // Transient server error — increment retry_count and move on.
            // Row stays with published_at NULL and will be retried next iteration.
            const newRetryCount = (row.retry_count ?? 0) + 1;
            const statusText = `HTTP ${res.status}`;
            if (newRetryCount >= MAX_RETRIES) {
              // Permanently failed: abandon this row so it doesn't block the queue.
              console.error('[audit-delivery] max retries reached, abandoning row', {
                eventId: row.event_id,
                eventType: row.event_type,
                retryCount: newRetryCount,
                lastError: statusText,
              });
              await pool.query(
                `UPDATE outbox_events
                 SET retry_count = $2, last_error = $3, published_at = NOW()
                 WHERE id = $1`,
                [row.id, newRetryCount, statusText],
              );
              settled++;
            } else {
              console.warn('[audit-delivery] platform-backend 5xx, incrementing retry count', {
                status: res.status,
                eventId: row.event_id,
                retryCount: newRetryCount,
              });
              await pool.query(
                `UPDATE outbox_events SET retry_count = $2, last_error = $3 WHERE id = $1`,
                [row.id, newRetryCount, statusText],
              );
              return 0; // Back off: the next drain retries this row
            }
            continue;
          }
          // 4xx: validation error — log and mark published so we don't retry bad payloads.
          console.error('[audit-delivery] platform-backend rejected audit log', {
            status: res.status,
            eventId: row.event_id,
            eventType: row.event_type,
          });
        }

        // Mark published (success or unretryable 4xx)
        await pool.query(
          `UPDATE outbox_events SET published_at = NOW() WHERE id = $1`,
          [row.id],
        );
        settled++;
      } catch (err) {
        // Network/transient error — increment retry_count, back off.
        const newRetryCount = (row.retry_count ?? 0) + 1;
        const errorText = String(err);
        if (newRetryCount >= MAX_RETRIES) {
          console.error('[audit-delivery] max retries reached, abandoning row', {
            eventId: row.event_id,
            eventType: row.event_type,
            retryCount: newRetryCount,
            lastError: errorText,
          });
          await pool.query(
            `UPDATE outbox_events
             SET retry_count = $2, last_error = $3, published_at = NOW()
             WHERE id = $1`,
            [row.id, newRetryCount, errorText],
          );
          settled++;
        } else {
          console.error('[audit-delivery] failed to deliver audit log', {
            err: errorText,
            eventId: row.event_id,
            retryCount: newRetryCount,
          });
          await pool.query(
            `UPDATE outbox_events SET retry_count = $2, last_error = $3 WHERE id = $1`,
            [row.id, newRetryCount, errorText],
          ).catch(() => undefined); // best-effort — don't mask original error
          return 0; // Back off: the next drain retries this row
        }
      }
    }
    return settled;
  }
}

let auditWorker: AuditLogDeliveryWorker | null = null;

function getAuditWorker(): AuditLogDeliveryWorker {
  if (!auditWorker) {
    auditWorker = new AuditLogDeliveryWorker({ batchSize: loadConfig().OUTBOX_BATCH_SIZE });
  }
  return auditWorker;
}

/** Most batches one drain delivers per stream, so a backlog cannot hold a request open indefinitely. */
export const MAX_DRAIN_BATCHES = 20;

let draining: Promise<void> = Promise.resolve();

/**
 * Deliver every outstanding outbox row: Pub/Sub for analytics, HTTP to
 * Platform Backend for audit.*. Serialized: a second call waits for the first,
 * because neither delivery path locks its rows and two drains at once would
 * deliver the same row twice.
 */
export function drainOutboxes(): Promise<void> {
  const run = draining.then(drainOnce);
  draining = run.then(() => undefined, () => undefined);
  return run;
}

async function drainOnce(): Promise<void> {
  const pub = await getOutboxPublisher();
  for (let i = 0; i < MAX_DRAIN_BATCHES; i++) {
    if ((await pub.drain()) === 0) break;
  }
  const audit = getAuditWorker();
  for (let i = 0; i < MAX_DRAIN_BATCHES; i++) {
    if ((await audit.deliverBatch()) === 0) break;
  }
}
