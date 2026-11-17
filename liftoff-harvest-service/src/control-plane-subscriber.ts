import { PubSub } from '@google-cloud/pubsub';
import type { Message, Subscription } from '@google-cloud/pubsub';
import { log } from './infrastructure/logging';
import { handleConnectorDeleted } from './disconnect-handler';

const SUBSCRIPTION_NAME = `control-plane-events-${process.env.ENVIRONMENT ?? 'dev'}-harvest-sub`;

let subscriptionInstance: Subscription | null = null;

export function startControlPlaneSubscriber(): void {
  const pubsub = new PubSub({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  const subscription = pubsub.subscription(SUBSCRIPTION_NAME, {
    flowControl: { maxMessages: 4 },
  });

  subscription.on('message', (message: Message) => {
    void handleMessage(message);
  });
  subscription.on('error', (err: Error) => {
    log.error({ error: err.message }, 'control-plane subscription error');
  });

  subscriptionInstance = subscription;
  log.info({ subscription: SUBSCRIPTION_NAME }, 'control-plane subscriber started');
}

export async function stopControlPlaneSubscriber(): Promise<void> {
  if (!subscriptionInstance) return;
  try {
    await subscriptionInstance.close();
    subscriptionInstance = null;
    log.info('control-plane subscriber closed');
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'control-plane subscriber close error (non-fatal)');
  }
}

/**
 * Core per-message decision for a control-plane event, shared by the Pub/Sub
 * PUSH route (live scale-to-zero path) and the streaming-pull subscriber
 * (retained for tests). Only `connector.deleted` triggers cleanup; everything
 * else acks (drop). Returns 'nack' only when cleanup throws (redeliver).
 */
export async function processControlPlaneEvent(
  attributes: Record<string, string>,
): Promise<'ack' | 'nack'> {
  if (attributes.eventType !== 'connector.deleted') {
    return 'ack';
  }

  const connectorId = attributes.entityId;
  const tenantId = attributes.tenantId;

  if (!connectorId || !tenantId) {
    log.warn({ attributes }, 'connector.deleted missing fields; dropping');
    return 'ack';
  }

  try {
    await handleConnectorDeleted(connectorId, tenantId);
    return 'ack';
  } catch (err) {
    log.error(
      { error: (err as Error).message, connectorId, tenantId },
      'connector.deleted cleanup failed; nacking',
    );
    return 'nack';
  }
}

async function handleMessage(message: Message): Promise<void> {
  const decision = await processControlPlaneEvent(message.attributes ?? {});
  if (decision === 'ack') message.ack();
  else message.nack();
}
