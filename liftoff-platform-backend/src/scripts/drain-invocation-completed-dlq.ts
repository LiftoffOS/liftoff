// Cron-triggered Cloud Run Job. Drains the invocation-completed billing DLQ
// by republishing dead-lettered spend events to the live topic.
//
// Why this exists (ADR-018, second occurrence): the push subscription
// dead-letters an event after 5 failed deliveries, and the DLQ drain sub has
// no consumer — so dead-lettered billing events silently age out at the
// 7-day retention. The spend-event handler is idempotent three ways
// (cross-ledger isDuplicate under FOR UPDATE, ON CONFLICT DO NOTHING, and
// the Stripe meter dedup on identifier=invocationId), and the pull-based
// runtime-ingester backstops the same events, so republishing is always
// safe: already-billed events are no-ops.
//
// Poison-message guard: each republish stamps a drain_attempt attribute.
// Messages that come back after MAX_DRAIN_ATTEMPTS republishes are acked
// WITHOUT republishing (abandoned to the runtime-ingester backstop) and
// logged at error so the alert trail shows what was given up.

import { PubSub, v1 } from '@google-cloud/pubsub';
import { log } from '../infrastructure/logging';

const MAX_MESSAGES_PER_RUN = 100;
const PULL_TIMEOUT_MS = 30_000;
const MAX_DRAIN_ATTEMPTS = 3;

interface SpendEventPayload {
  tenantId?: string;
  invocationId?: string;
  costUsd?: number;
  internalAgentId?: string;
  occurredAt?: string;
}

export interface DrainResult {
  pulled: number;
  republished: number;
  abandoned: number;
  unparseable: number;
}

export async function runDrain(): Promise<DrainResult> {
  const dlqSubFqn = process.env.DLQ_SUBSCRIPTION;
  const liveTopicFqn = process.env.LIVE_TOPIC;
  if (!dlqSubFqn || !liveTopicFqn) {
    throw new Error('DLQ_SUBSCRIPTION and LIVE_TOPIC required');
  }
  const dlqProject = dlqSubFqn.split('/')[1];
  const dlqSubName = dlqSubFqn.split('/').pop()!;
  const liveTopicProject = liveTopicFqn.split('/')[1];
  const liveTopicName = liveTopicFqn.split('/').pop()!;

  const liveTopic = new PubSub({ projectId: liveTopicProject }).topic(liveTopicName);
  const subscriberClient = new v1.SubscriberClient();
  const formattedSub = subscriberClient.subscriptionPath(dlqProject, dlqSubName);

  const [pullResponse] = await subscriberClient.pull(
    { subscription: formattedSub, maxMessages: MAX_MESSAGES_PER_RUN },
    { timeout: PULL_TIMEOUT_MS },
  );
  const received = pullResponse.receivedMessages ?? [];
  log.info({ dlqSubName, count: received.length }, 'billing-dlq-drainer: pulled batch');

  const result: DrainResult = { pulled: received.length, republished: 0, abandoned: 0, unparseable: 0 };
  const ackIds: string[] = [];

  for (const rm of received) {
    const msg = rm.message;
    if (!msg || !rm.ackId) continue;

    const dataBuf = typeof msg.data === 'string'
      ? Buffer.from(msg.data, 'base64')
      : Buffer.from((msg.data as Uint8Array | null | undefined) ?? []);
    const attributes = (msg.attributes ?? {}) as Record<string, string>;

    let payload: SpendEventPayload | null = null;
    try {
      payload = JSON.parse(dataBuf.toString('utf8')) as SpendEventPayload;
    } catch {
      result.unparseable += 1;
    }

    const drainAttempt = Number(attributes.drain_attempt ?? '0');
    const logCtx = {
      tenantId: payload?.tenantId,
      invocationId: payload?.invocationId,
      costUsd: payload?.costUsd,
      internalAgentId: payload?.internalAgentId,
      occurredAt: payload?.occurredAt,
      deliveryCount: attributes.CloudPubSubDeadLetterSourceDeliveryCount,
      drainAttempt,
    };

    if (payload === null) {
      // Unparseable can never be delivered; ack it out with a loud log.
      log.error({ ...logCtx, dataBase64: dataBuf.toString('base64') }, 'billing-dlq-drainer: unparseable message acked without republish');
      ackIds.push(rm.ackId);
      continue;
    }

    if (drainAttempt >= MAX_DRAIN_ATTEMPTS) {
      log.error(logCtx, 'billing-dlq-drainer: max drain attempts reached, abandoning to runtime-ingester backstop');
      result.abandoned += 1;
      ackIds.push(rm.ackId);
      continue;
    }

    await liveTopic.publishMessage({
      data: dataBuf,
      attributes: {
        ...attributes,
        manual_retry: 'true',
        drain_attempt: String(drainAttempt + 1),
      },
    });
    log.info(logCtx, 'billing-dlq-drainer: republished to live topic');
    result.republished += 1;
    ackIds.push(rm.ackId);
  }

  if (ackIds.length > 0) {
    await subscriberClient.acknowledge({ subscription: formattedSub, ackIds });
  }

  log.info({ ...result }, 'billing-dlq-drainer: run complete');
  return result;
}

async function main(): Promise<void> {
  await runDrain();
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      log.error({ error: (err as Error).message }, 'billing-dlq-drainer: run failed');
      process.exit(1);
    },
  );
}
