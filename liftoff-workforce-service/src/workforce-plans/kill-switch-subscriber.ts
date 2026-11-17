// Kill-Switch Subscriber — Pub/Sub streaming subscription for tenant kill-switch messages.
//
// Maintains an in-memory Set of kill-switched tenant IDs. The HRBP provisioner
// checks `isKillSwitched()` at the start of each run and at each spec iteration
// so that an operator can halt provisioning mid-batch without waiting for the
// current run to complete.
//
// The kill-switch is a safety feature, NOT a hard dependency. If the Pub/Sub
// subscription is unavailable the service continues to run normally; the
// kill-switch simply won't fire until the subscription recovers.
//
// Config:
//   GOVERNANCE_EVENTS_SUBSCRIPTION — full Pub/Sub subscription path
//     e.g. projects/my-project/subscriptions/workforce-kill-switch-sub
//   If not set, the subscriber is disabled and isKillSwitched() always returns false.
//
// Implementation note:
//   The @google-cloud/pubsub SDK uses an event-driven streaming pull model.
//   We open the subscription, listen for `message` events, ack each one, and
//   handle `error` events without crashing. If the connection drops the SDK
//   reconnects automatically.

import { PubSub, Message } from '@google-cloud/pubsub';
import { log } from '../infrastructure/logging.js';
import { loadConfig } from '../infrastructure/config.js';

// ── In-memory kill-switch state ────────────────────────────────────────

const killSwitchedTenants = new Set<string>();

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Returns true if the tenant has been kill-switched since this process started.
 * This is an in-memory check — no network call is made.
 */
export function isKillSwitched(tenantId: string): boolean {
  return killSwitchedTenants.has(tenantId);
}

/**
 * Start the Pub/Sub streaming subscription for kill-switch events.
 *
 * Opens a streaming pull subscription and processes `kill_switch` messages.
 * Each message is expected to be a JSON payload of the form:
 *   `{ "type": "kill_switch", "tenantId": "<uuid>" }`
 *
 * Messages are acked regardless of parse result to prevent infinite re-delivery.
 *
 * Safe to call multiple times — if GOVERNANCE_EVENTS_SUBSCRIPTION is not set,
 * returns immediately after logging an info message.
 */
export function startKillSwitchSubscriber(): void {
  const subscriptionName = loadConfig().GOVERNANCE_EVENTS_SUBSCRIPTION;

  if (!subscriptionName) {
    log.info(
      {},
      'Kill-switch: GOVERNANCE_EVENTS_SUBSCRIPTION not set — kill-switch subscriber disabled',
    );
    return;
  }

  log.info(
    { subscriptionName },
    'Kill-switch: starting Pub/Sub streaming subscriber',
  );

  try {
    const pubsub = new PubSub();
    const subscription = pubsub.subscription(subscriptionName);

    subscription.on('message', (message: Message) => {
      try {
        const payload = JSON.parse(message.data.toString('utf8')) as unknown;

        if (
          typeof payload === 'object' &&
          payload !== null &&
          'type' in payload &&
          (payload as Record<string, unknown>)['type'] === 'kill_switch' &&
          'tenantId' in payload &&
          typeof (payload as Record<string, unknown>)['tenantId'] === 'string'
        ) {
          const tenantId = (payload as Record<string, unknown>)['tenantId'] as string;
          if (!killSwitchedTenants.has(tenantId)) {
            killSwitchedTenants.add(tenantId);
            log.warn(
              { tenantId },
              'Kill-switch: tenant has been kill-switched — all provisioning halted',
            );
          }
        } else {
          log.warn(
            { payload },
            'Kill-switch: received message with unexpected shape — ignoring',
          );
        }
      } catch (parseErr) {
        log.warn(
          { error: (parseErr as Error).message },
          'Kill-switch: failed to parse Pub/Sub message — ignoring',
        );
      } finally {
        // Always ack to prevent infinite re-delivery.
        message.ack();
      }
    });

    subscription.on('error', (err: Error) => {
      // The SDK will attempt to reconnect — log but do not crash.
      log.warn(
        { error: err.message },
        'Kill-switch: Pub/Sub subscription error — will reconnect automatically',
      );
    });

    subscription.on('close', () => {
      log.warn(
        { subscriptionName },
        'Kill-switch: Pub/Sub subscription closed',
      );
    });
  } catch (err) {
    // If we can't even construct the subscription object, log and continue.
    log.warn(
      { subscriptionName, error: (err as Error).message },
      'Kill-switch: failed to initialise Pub/Sub subscription — kill-switch disabled',
    );
  }
}
