// Cloud Run Job. Runs every 10 min via Cloud Scheduler in each tenant project.
// Pulls up to 100 messages from the DLQ subscription, inserts each into
// failed_events for forensics, then republishes parseable payloads to the
// live topic with attribute manual_retry='true'. Acks only after both
// insert + republish succeed.
//
// Republishing is bounded, because unbounded republishing loops. An event that
// fails for a reason republishing cannot change — a bad payload, a bug in the
// handler — comes straight back to the DLQ, gets drained again ten minutes
// later, and loops until someone fixes the underlying cause. Every lap is a
// real redelivery and a real processing attempt, so the loop is not free and
// it is not quiet: it drowns the DLQ-depth alert in flapping until the alert
// stops meaning anything.
//
// So: replay is a remediation with a budget. After MAX_REPLAYS_PER_EVENT
// unsuccessful laps the event stops being republished and stays in
// failed_events with republish_error set, which is the state the retention
// sweep reports and refuses to delete. That converts a silent infinite loop
// into a bounded one that ends in a durable, visible record.

import { PubSub, v1 } from '@google-cloud/pubsub';
import { Pool } from 'pg';
import { logger } from '../infrastructure/logging';
import { getManagedSecret } from '../infrastructure/secret-store';

const MAX_MESSAGES_PER_RUN = 100;
const PULL_TIMEOUT_MS = 30_000;

/** Republishes of one event_id before the drainer gives up on it.
 *
 *  Three, because the failures worth replaying are the ones where a dependency
 *  was briefly down: those clear on the first or second lap. By the third
 *  return trip the evidence says republishing is not the fix. */
export const MAX_REPLAYS_PER_EVENT = 3;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENTINEL_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// failed_events.tenant_id is UUID NOT NULL. Prefer the event payload's
// tenant_id (every control-plane event carries one); fall back to the env
// var; sentinel if neither is a valid UUID. Mirrors the pattern in
// push-handler.ts:writeToDlqMessages.
function pickTenantId(payloadJson: Record<string, unknown> | null, envTenantId: string | undefined): string {
  const fromPayload = typeof payloadJson?.tenant_id === 'string' ? payloadJson.tenant_id : '';
  if (UUID_REGEX.test(fromPayload)) return fromPayload;
  if (envTenantId && UUID_REGEX.test(envTenantId)) return envTenantId;
  return SENTINEL_TENANT_ID;
}

interface ExtractedEvent {
  event_id: string | null;
  payloadJson: Record<string, unknown> | null;
  payloadBase64: string;
  attributes: Record<string, string>;
  publishTime: Date | null;
  deliveryAttempt: number | null;
}

// Structural shape — Pub/Sub's pull() returns IReceivedMessage whose `message`
// is IPubsubMessage with publishTime as ITimestamp; the streaming PubsubMessage
// uses PreciseDate. We don't need either concrete type for extract().
interface ExtractInput {
  data: Buffer;
  attributes: Record<string, string>;
  publishTime: Date | null;
  deliveryAttempt: number | null;
}

function extract(msg: ExtractInput): ExtractedEvent {
  const base64 = msg.data.toString('base64');
  let payloadJson: Record<string, unknown> | null = null;
  let event_id: string | null = null;
  try {
    const decoded = msg.data.toString('utf8');
    payloadJson = JSON.parse(decoded) as Record<string, unknown>;
    event_id = typeof payloadJson.event_id === 'string' ? payloadJson.event_id : null;
  } catch {
    /* leave null */
  }
  return {
    event_id,
    payloadJson,
    payloadBase64: base64,
    attributes: msg.attributes ?? {},
    publishTime: msg.publishTime ?? null,
    deliveryAttempt: msg.deliveryAttempt ?? null,
  };
}

/** Prior successful republishes of this event.
 *
 *  Counted against `republished = TRUE` rows only, and the current message's
 *  row is inserted with republished = FALSE before this runs, so the current
 *  lap never counts itself. An event that has come back MAX_REPLAYS_PER_EVENT
 *  times has that many TRUE rows and is at the cap. */
export async function priorReplayCount(
  pool: Pick<Pool, 'query'>,
  eventId: string,
): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM failed_events
      WHERE original_event_id = $1 AND republished`,
    [eventId],
  );
  return parseInt(res.rows[0]?.n ?? '0', 10);
}

/** Record why a drained message was not republished.
 *
 *  republished stays FALSE and republish_error carries the reason, which is
 *  what makes the row show up in the outstanding count instead of aging out
 *  with the successful replays.
 *
 *  `AND NOT republished` guards the re-drain case. The insert above is
 *  ON CONFLICT (dlq_message_id) DO NOTHING, so a message pulled again after a
 *  failed ack lands on its existing row — which may already have been
 *  republished, and may by now be over the cap. Without the guard this would
 *  stamp an error onto a row that says republished = TRUE, producing a state
 *  the retention sweep reads both ways at once: deleted as finished, invisible
 *  to the backlog count. The two states have to stay mutually exclusive. */
export async function recordNotRepublished(
  pool: Pick<Pool, 'query'>,
  dlqMessageId: string | null | undefined,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE failed_events SET republish_error = $2
      WHERE dlq_message_id = $1 AND NOT republished`,
    [dlqMessageId, reason],
  );
}

export interface DrainTarget {
  dlqSubFqn: string;
  liveTopicFqn: string;
}

/**
 * The DLQs one execution drains.
 *
 * DLQ_PAIRS (`<dlq subscription>|<live topic>`, comma-separated) drains every
 * topic in one execution: one Cloud Scheduler job and one container start a
 * day instead of eight of each, which is the whole cost of a backstop that
 * usually finds nothing. DLQ_SUBSCRIPTION + LIVE_TOPIC is the single-topic
 * form the per-topic jobs (and the replayer's operators) still use.
 */
export function drainTargets(env: NodeJS.ProcessEnv = process.env): DrainTarget[] {
  if (env.DLQ_PAIRS) {
    const targets = env.DLQ_PAIRS.split(',').map((pair) => pair.trim()).filter(Boolean).map((pair) => {
      const [dlqSubFqn, liveTopicFqn] = pair.split('|').map((p) => p.trim());
      if (!dlqSubFqn || !liveTopicFqn) throw new Error(`DLQ_PAIRS entry is not <subscription>|<topic>: ${pair}`);
      return { dlqSubFqn, liveTopicFqn };
    });
    if (targets.length === 0) throw new Error('DLQ_PAIRS is empty');
    return targets;
  }
  if (env.DLQ_SUBSCRIPTION && env.LIVE_TOPIC) {
    return [{ dlqSubFqn: env.DLQ_SUBSCRIPTION, liveTopicFqn: env.LIVE_TOPIC }];
  }
  throw new Error('DLQ_PAIRS, or DLQ_SUBSCRIPTION and LIVE_TOPIC, required');
}

export async function main(): Promise<void> {
  const targets = drainTargets();
  // TENANT_ID is now an OPTIONAL fallback. Every control-plane event carries
  // tenant_id in its payload; pickTenantId() prefers the payload value over
  // the env. Kept for: (a) backwards-compat with the original required-env
  // contract; (b) sentinel use when the payload is unparseable.
  const tenantId = process.env.TENANT_ID;

  const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    database: process.env.DB_NAME,
    password: getManagedSecret('DB_PASSWORD'),
    ssl: false,
  });

  // One topic's failure does not stop the others: each is its own backlog.
  let errors = 0;
  for (const target of targets) {
    try {
      errors += await drainOne(target, pool, tenantId);
    } catch (err) {
      errors++;
      logger.error({ dlq: target.dlqSubFqn, err: (err as Error).message }, 'DLQ drain failed for subscription');
    }
  }
  await pool.end();
  if (errors > 0) process.exit(1);
}

async function drainOne(
  { dlqSubFqn, liveTopicFqn }: DrainTarget,
  pool: Pool,
  tenantId: string | undefined,
): Promise<number> {
  // dlqSubFqn shape: projects/<proj>/subscriptions/<name>
  const dlqSubName = dlqSubFqn.split('/').pop()!;
  const dlqProject = dlqSubFqn.split('/')[1];
  // liveTopicFqn shape: projects/<proj>/topics/<name>
  const liveTopicName = liveTopicFqn.split('/').pop()!;
  const liveTopicProject = liveTopicFqn.split('/')[1];

  const pubsubLive = new PubSub({ projectId: liveTopicProject });
  const liveTopic = pubsubLive.topic(liveTopicName);

  // Synchronous pull pattern for one-shot Cloud Run Job semantics.
  const subscriberClient = new v1.SubscriberClient();
  const formattedSub = subscriberClient.subscriptionPath(dlqProject, dlqSubName);

  const [pullResponse] = await subscriberClient.pull(
    { subscription: formattedSub, maxMessages: MAX_MESSAGES_PER_RUN },
    { timeout: PULL_TIMEOUT_MS },
  );
  const received = pullResponse.receivedMessages ?? [];
  logger.info({ dlqSubName, count: received.length }, 'DLQ pulled batch');

  let drained = 0;
  let republished = 0;
  let capped = 0;
  let errors = 0;
  const ackIds: string[] = [];

  for (const rm of received) {
    const msg = rm.message;
    if (!msg) continue;
    try {
      // pull() returns base64-encoded data; decode to a Buffer before extract().
      const dataBuf = typeof msg.data === 'string'
        ? Buffer.from(msg.data, 'base64')
        : Buffer.from(msg.data as unknown as Uint8Array);
      const publishTime = msg.publishTime
        ? new Date(typeof msg.publishTime === 'string'
            ? msg.publishTime
            // ITimestamp { seconds, nanos } shape from grpc protos.
            : Number((msg.publishTime as { seconds?: string | number }).seconds ?? 0) * 1000)
        : null;
      const ev = extract({
        data: dataBuf,
        attributes: (msg.attributes ?? {}) as Record<string, string>,
        publishTime,
        deliveryAttempt: rm.deliveryAttempt ?? null,
      });

      // 1. Insert into failed_events. failed_events.tenant_id is UUID
      // NOT NULL — derive from the payload, env var, or sentinel.
      const rowTenantId = pickTenantId(ev.payloadJson, tenantId);
      await pool.query(
        `INSERT INTO failed_events
           (tenant_id, original_event_id, original_topic, original_subscription,
            dlq_message_id, payload, payload_raw_base64, attributes,
            publish_time, delivery_attempt_count, republished)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE)
         ON CONFLICT (dlq_message_id) DO NOTHING
         RETURNING id`,
        [rowTenantId, ev.event_id, liveTopicName, dlqSubFqn, msg.messageId,
         ev.payloadJson, ev.payloadBase64, ev.attributes, ev.publishTime, ev.deliveryAttempt],
      );

      // 2. Republish parseable payloads, up to the replay budget.
      //
      // Both refusals below leave republished = FALSE and set republish_error.
      // That pair is the "outstanding" state: the retention sweep counts it,
      // alerts on it, and never deletes it.
      const priorReplays = ev.payloadJson && ev.event_id
        ? await priorReplayCount(pool, ev.event_id)
        : 0;

      if (!ev.payloadJson) {
        await recordNotRepublished(
          pool, msg.messageId,
          'payload is not valid UTF-8 JSON, so there is nothing to republish',
        );
        logger.warn({ dlq_id: msg.messageId }, 'unparseable DLQ payload — left in failed_events for review');
      } else if (!ev.event_id) {
        // Parseable but unidentifiable. Two reasons not to send it: the cap
        // counts laps by event_id, so this payload could loop forever with the
        // budget never noticing; and every control-plane topic requires
        // event_id, so the receiver would reject it as schema-invalid anyway.
        await recordNotRepublished(
          pool, msg.messageId,
          'payload carries no event_id, so a replay could not be bounded and would fail schema validation',
        );
        logger.warn(
          { dlq_id: msg.messageId },
          'DLQ payload has no event_id — left in failed_events for review rather than replayed unbounded',
        );
      } else if (priorReplays >= MAX_REPLAYS_PER_EVENT) {
        capped++;
        await recordNotRepublished(
          pool, msg.messageId,
          `replay cap reached: ${priorReplays} republishes of this event all returned to the DLQ`,
        );
        // ERROR, not warn: this is the end of the automatic path. Whatever is
        // wrong with this event needs a person, and nothing else will say so.
        logger.error(
          {
            event: 'dlq_replay_capped',
            dlq_id: msg.messageId,
            event_id: ev.event_id,
            topic: liveTopicName,
            prior_replays: priorReplays,
            cap: MAX_REPLAYS_PER_EVENT,
          },
          'DLQ replay cap reached; event will not be republished again and is held in failed_events for review',
        );
      } else {
        const newMsgId = await liveTopic.publishMessage({
          data: Buffer.from(ev.payloadBase64, 'base64'),
          attributes: {
            ...ev.attributes,
            manual_retry: 'true',
            republished_from_dlq: 'true',
            original_dlq_message_id: msg.messageId ?? '',
          },
        });
        await pool.query(
          `UPDATE failed_events
              SET republished = TRUE, republished_at = NOW(), republished_message_id = $2,
                  republish_error = NULL
            WHERE dlq_message_id = $1`,
          [msg.messageId, newMsgId],
        );
        republished++;
      }

      ackIds.push(rm.ackId!);
      drained++;
    } catch (err) {
      errors++;
      logger.error({ dlq_id: msg.messageId, err: (err as Error).message }, 'DLQ row failed');
      // Stop on first error so we don't poison-loop and exhaust quota
      break;
    }
  }

  // 3. Bulk ack only after we have a record
  if (ackIds.length > 0) {
    await subscriberClient.acknowledge({ subscription: formattedSub, ackIds });
  }

  logger.info({ dlqSubName, drained, republished, capped, errors }, 'DLQ drain run complete');
  return errors;
}

if (require.main === module) {
  main().catch((e) => {
    logger.error({ err: (e as Error).message, stack: (e as Error).stack }, 'drainer crashed');
    process.exit(1);
  });
}
