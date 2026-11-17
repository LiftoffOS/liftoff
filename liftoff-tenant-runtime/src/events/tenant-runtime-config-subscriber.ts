// Part 3 — tenant-runtime-config cache invalidation subscriber.
//
// Mirrors the existing internal-agents events subscriber pattern in
// src/events/subscriber.ts: pull subscription, JSON parse, ack on success,
// ack-and-drop on malformed payload (no retry on garbage). The
// cross-project topic `tenant-runtime-config-updated-${env}` lives in
// `YOUR_GCP_PROJECT`; the per-tenant pull subscription
// `tenant-runtime-config-updated-sub-${tenant_id}` is provisioned via
// terraform/projects/tenant-runtime-template/tenant_runtime_config_invalidation.tf
// and the tenant-runtime SA is granted pubsub.viewer on the topic +
// pubsub.subscriber on the subscription.

import { PubSub, type Message } from '@google-cloud/pubsub';
import { invalidateTenantRuntimeConfig } from '../tenant-runtime-config/service';
import { logger as log } from '../infrastructure/logging';

let subscriberInstance: ReturnType<PubSub['subscription']> | null = null;

export function startTenantRuntimeConfigSubscriber(): void {
  if (subscriberInstance) return;
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) {
    log.warn({ message: 'TENANT_ID not set; tenant-runtime-config subscriber not started' });
    return;
  }
  const subscriptionName = `tenant-runtime-config-updated-sub-${tenantId}`;
  const pubsub = new PubSub();
  const subscription = pubsub.subscription(subscriptionName, { flowControl: { maxMessages: 10 } });

  subscription.on('message', (msg: Message) => {
    try {
      const payload = JSON.parse(msg.data.toString()) as { tenantId?: string };
      // Only invalidate the cache entry that matches the message — we
      // never want to flush the whole LRU on a misrouted message.
      if (payload.tenantId && payload.tenantId === tenantId) {
        invalidateTenantRuntimeConfig(payload.tenantId);
      }
      msg.ack();
    } catch (err) {
      log.warn({ message: 'tenant-runtime-config message parse failed', err: (err as Error).message });
      msg.ack();  // malformed payload — ack to drop, will not retry
    }
  });
  subscription.on('error', (err) => {
    log.error({ message: 'tenant-runtime-config subscriber error', err: (err as Error).message });
  });
  subscriberInstance = subscription;
}
