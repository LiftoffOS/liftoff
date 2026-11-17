import type { Pool } from 'pg';
import type { PubSub, Topic } from '@google-cloud/pubsub';

import { type EventEnvelope, serializeEnvelope } from './envelope.js';

export interface OutboxPublisherOptions {
  /** Topic name mapping for a given envelope. Receives the envelope; returns topic name. */
  topicResolver: (env: EventEnvelope) => string;
  /**
   * Optional SQL LIKE patterns for event_type values that this publisher
   * should skip. Rows whose event_type matches any pattern are excluded from
   * the SELECT query entirely, leaving them for other workers (e.g. an HTTP
   * delivery worker) to process.
   *
   * Example: `['audit.%']` excludes all audit.* events so they are never
   * accidentally published to Pub/Sub.
   */
  excludeEventTypePatterns?: string[];
  /** Milliseconds between poll iterations when the last batch was empty. */
  pollIntervalMs?: number;
  /** Max rows to publish per iteration. */
  batchSize?: number;
  /** Upper-bound on backoff when publish fails. */
  maxBackoffMs?: number;
  /** Optional logger; falls back to console. */
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface OutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  schema_version: number;
  tenant_id: string;
  occurred_at: Date;
  source_service: string;
  trace_id: string | null;
  payload: unknown;
}

/**
 * Background worker that drains `outbox_events.published_at IS NULL`
 * to Pub/Sub. Crash-safe by design: duplicate publishes are dedup'd by
 * consumers via `processed_events.event_id UNIQUE`.
 *
 * Call `start()` once at service boot and inject `stop()` into the
 * SIGTERM graceful-shutdown handler (@liftoffos/service-runtime) so
 * the final iteration drains before exit.
 */
export class OutboxPublisher {
  private readonly pool: Pool;
  private readonly pubsub: PubSub;
  private readonly opts: Required<Pick<OutboxPublisherOptions, 'pollIntervalMs' | 'batchSize' | 'maxBackoffMs'>> &
    Pick<OutboxPublisherOptions, 'topicResolver' | 'logger' | 'excludeEventTypePatterns'>;
  private readonly topics = new Map<string, Topic>();
  private running = false;
  private currentIteration: Promise<void> | null = null;
  private stopSignal: (() => void) | null = null;

  constructor(pool: Pool, pubsub: PubSub, options: OutboxPublisherOptions) {
    this.pool = pool;
    this.pubsub = pubsub;
    this.opts = {
      pollIntervalMs: options.pollIntervalMs ?? 500,
      batchSize: options.batchSize ?? 100,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      topicResolver: options.topicResolver,
      logger: options.logger,
      excludeEventTypePatterns: options.excludeEventTypePatterns,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  /** Resolves after the in-flight iteration completes. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.stopSignal) this.stopSignal();
    if (this.currentIteration) {
      try {
        await this.currentIteration;
      } catch {
        /* already logged */
      }
    }
  }

  /** Exposed for graceful-shutdown `drainFn` — publishes any outstanding batch synchronously once. */
  async drain(): Promise<number> {
    return this.iterateOnce();
  }

  private async loop(): Promise<void> {
    let backoffMs = 0;
    while (this.running) {
      this.currentIteration = this.iterateOnce()
        .then((count) => {
          backoffMs = count > 0 ? 0 : Math.min(this.opts.maxBackoffMs, Math.max(backoffMs * 2, this.opts.pollIntervalMs));
        })
        .catch((err) => {
          this.log('error', 'outbox.publisher.iteration_failed', { err: String(err) });
          backoffMs = Math.min(this.opts.maxBackoffMs, Math.max(backoffMs * 2, this.opts.pollIntervalMs));
        })
        .then(() => undefined);
      await this.currentIteration;
      if (!this.running) break;
      await this.sleep(backoffMs || this.opts.pollIntervalMs);
    }
  }

  private async iterateOnce(): Promise<number> {
    // Build optional exclusion clauses for event_type patterns that should be
    // handled by other workers (e.g. audit.* delivered via HTTP instead of Pub/Sub).
    const excludePatterns = this.opts.excludeEventTypePatterns ?? [];
    const excludeClauses = excludePatterns
      .map((_, i) => `AND event_type NOT LIKE $${i + 2}`)
      .join('\n         ');

    const { rows } = await this.pool.query<OutboxRow>(
      `SELECT id, event_id, event_type, schema_version, tenant_id,
              occurred_at, source_service, trace_id, payload
       FROM outbox_events
       WHERE published_at IS NULL
         ${excludeClauses}
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [this.opts.batchSize, ...excludePatterns],
    );
    if (rows.length === 0) return 0;

    let published = 0;
    for (const row of rows) {
      const env: EventEnvelope = {
        eventId: row.event_id,
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        tenantId: row.tenant_id,
        occurredAt: row.occurred_at,
        sourceService: row.source_service,
        traceId: row.trace_id,
        payload: row.payload,
      };
      const topicName = this.opts.topicResolver(env);
      const topic = this.getTopic(topicName);
      try {
        await topic.publishMessage({
          data: Buffer.from(serializeEnvelope(env), 'utf-8'),
          orderingKey: env.tenantId,
          attributes: {
            event_id: env.eventId,
            event_type: env.eventType,
            schema_version: String(env.schemaVersion),
            trace_id: env.traceId ?? '',
          },
        });
        await this.pool.query(
          `UPDATE outbox_events SET published_at = NOW() WHERE id = $1`,
          [row.id],
        );
        published++;
      } catch (err) {
        this.log('warn', 'outbox.publisher.publish_failed', {
          eventId: env.eventId,
          eventType: env.eventType,
          err: String(err),
        });
        // Bail out of this iteration — the row stays unpublished and will
        // be picked up on the next poll. This keeps ordering intact.
        break;
      }
    }
    return published;
  }

  private getTopic(name: string): Topic {
    const cached = this.topics.get(name);
    if (cached) return cached;
    const topic = this.pubsub.topic(name, { messageOrdering: true });
    this.topics.set(name, topic);
    return topic;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.stopSignal = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
    if (this.opts.logger) {
      this.opts.logger[level](msg, meta);
    } else {
      // eslint-disable-next-line no-console
      console[level](msg, meta);
    }
  }
}

/** Helper for the write-path — insert a row into outbox_events inside the business transaction. */
export async function enqueueOutboxEvent<T>(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  env: EventEnvelope<T>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (
       event_id, event_type, schema_version, tenant_id,
       occurred_at, source_service, trace_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      env.eventId,
      env.eventType,
      env.schemaVersion,
      env.tenantId,
      env.occurredAt,
      env.sourceService,
      env.traceId,
      JSON.stringify(env.payload),
    ],
  );
}
