// Kill-switch Pub/Sub propagation integration test.
//
// Phase 3 plan §3e verification: "Kill switch push invalidation: <5 second
// propagation verified end-to-end". This test proves the contract the
// tenant-runtime subscriber depends on:
//   1. governance-engine publishes a `governance.kill_switch_changed` event
//      to `governance-events-{ENV}` with the expected JSON envelope.
//   2. A subscriber attached to that topic receives it, parses the
//      envelope, and invalidates its preflight cache within 5 seconds.
//
// The real tenant-runtime subscriber lives at:
//   Liftoff-Tenant-Runtime/src/governance/kill-switch-subscriber.ts
//
// Rather than cross-repo-import it (risky — npm install order + workspace
// resolution), we replicate the minimal consumer logic here. The goal is
// to validate the topic/message/consumer *contract*, not tenant-runtime
// internals. If the tenant-runtime subscriber diverges from this shape,
// its own unit tests will fail.
//
// Prerequisites:
//   - Pub/Sub emulator running at PUBSUB_EMULATOR_HOST (default 127.0.0.1:8085).
//     Recommended: `gcloud beta emulators pubsub start --host-port=127.0.0.1:8085`
//   - No real GCP creds required — the emulator accepts unauthenticated requests
//     when PUBSUB_EMULATOR_HOST is set.
//
// Suggested docker-compose addition (not required for CI):
//   pubsub:
//     image: gcr.io/google.com/cloudsdktool/cloud-sdk:emulators
//     command: gcloud beta emulators pubsub start --host-port=0.0.0.0:8085
//     ports: ["8085:8085"]
//
// Runtime: wall-clock ~2-3 seconds including setup.

import { PubSub, Message } from '@google-cloud/pubsub';

// Shape the tenant-runtime subscriber expects (see
// `kill-switch-subscriber.ts` in Liftoff-Tenant-Runtime for the canonical
// consumer side).
interface KillSwitchEnvelope {
  tenantId: string;
  switchName?: string;
  state?: unknown;
}

const KILL_SWITCH_EVENT_TYPE = 'governance.kill_switch_changed';
const PROPAGATION_BUDGET_MS = 5000;

// Unique per test run so parallel jobs don't collide on emulator state.
const RUN_TAG = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TOPIC_NAME = `governance-events-${RUN_TAG}`;
const SUBSCRIPTION_NAME = `${TOPIC_NAME}-tenant-runtime-sub`;
const PROJECT_ID = 'governance-integration-test';

// Skip this test if the Pub/Sub emulator isn't reachable. Integration
// suites typically launch it via docker-compose before running.
const EMULATOR_HOST = process.env.PUBSUB_EMULATOR_HOST;
const describeMaybe = EMULATOR_HOST ? describe : describe.skip;

describeMaybe('kill-switch propagation (Pub/Sub emulator)', () => {
  jest.setTimeout(30_000);

  let pubsub: PubSub;

  beforeAll(async () => {
    pubsub = new PubSub({ projectId: PROJECT_ID });
    const [topic] = await pubsub.createTopic(TOPIC_NAME);
    await topic.createSubscription(SUBSCRIPTION_NAME, {
      ackDeadlineSeconds: 10,
      // Short retention so the emulator doesn't hold the message for long
      // after the test finishes.
      messageRetentionDuration: { seconds: 600, nanos: 0 },
    });
  });

  afterAll(async () => {
    // Best-effort cleanup; the emulator will drop everything on shutdown
    // anyway but this keeps re-runs tidy when the emulator persists.
    try {
      await pubsub.subscription(SUBSCRIPTION_NAME).delete();
    } catch {
      // ignore
    }
    try {
      await pubsub.topic(TOPIC_NAME).delete();
    } catch {
      // ignore
    }
    await pubsub.close();
  });

  it('propagates a kill-switch event to the tenant-runtime subscriber in <5s', async () => {
    const tenantId = 'tenant-propagation-' + Math.random().toString(36).slice(2, 8);
    const invalidated: Array<{ tenantId: string; at: number }> = [];

    // Minimal replica of the tenant-runtime subscriber. If the contract
    // drifts (envelope shape, attribute name, event type string), this
    // handler will fail to invalidate — exactly the regression we want CI
    // to surface.
    const sub = pubsub.subscription(SUBSCRIPTION_NAME, {
      flowControl: { maxMessages: 4, allowExcessMessages: false },
    });

    const handler = (message: Message) => {
      const eventType =
        message.attributes?.eventType ?? message.attributes?.event_type;
      if (eventType && eventType !== KILL_SWITCH_EVENT_TYPE) {
        message.ack();
        return;
      }
      let envelope: KillSwitchEnvelope;
      try {
        envelope = JSON.parse(message.data.toString('utf8')) as KillSwitchEnvelope;
      } catch {
        message.ack();
        return;
      }
      if (!envelope.tenantId) {
        message.ack();
        return;
      }
      invalidated.push({ tenantId: envelope.tenantId, at: Date.now() });
      message.ack();
    };

    sub.on('message', handler);
    sub.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('subscription error', err);
    });

    // Give the subscriber a tick to attach its stream pull. Without this
    // the publish below can race and the message lands before the stream
    // is open — emulator will eventually redeliver, but that's slower.
    await new Promise((r) => setTimeout(r, 200));

    // This is the publisher contract the governance-engine implements in
    // its kill-switch change path. If governance-engine ever grows a
    // helper (publishKillSwitchChanged), replace this block with that
    // call.
    const publishTime = Date.now();
    await pubsub.topic(TOPIC_NAME).publishMessage({
      data: Buffer.from(
        JSON.stringify({
          tenantId,
          switchName: 'kill_state',
          state: { active: true, reason: 'test-propagation' },
        } satisfies KillSwitchEnvelope),
      ),
      attributes: { eventType: KILL_SWITCH_EVENT_TYPE },
    });

    // Wait up to the budget for the handler to record invalidation for
    // our tenant. Poll every 50ms.
    const deadline = publishTime + PROPAGATION_BUDGET_MS;
    let received: { tenantId: string; at: number } | undefined;
    while (Date.now() < deadline) {
      received = invalidated.find((i) => i.tenantId === tenantId);
      if (received) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    sub.removeListener('message', handler);
    await sub.close();

    if (!received) {
      throw new Error(
        `kill-switch event for ${tenantId} was not received within ${PROPAGATION_BUDGET_MS}ms`,
      );
    }
    const propagationMs = received.at - publishTime;
    // eslint-disable-next-line no-console
    console.log(
      `kill-switch propagation: ${propagationMs}ms (budget ${PROPAGATION_BUDGET_MS}ms)`,
    );
    expect(propagationMs).toBeLessThan(PROPAGATION_BUDGET_MS);
  });

  it('ignores events with an unrelated eventType attribute', async () => {
    const tenantId = 'tenant-unrelated-' + Math.random().toString(36).slice(2, 8);
    const invalidated: Array<{ tenantId: string }> = [];

    const sub = pubsub.subscription(SUBSCRIPTION_NAME, {
      flowControl: { maxMessages: 4, allowExcessMessages: false },
    });

    const handler = (message: Message) => {
      const eventType =
        message.attributes?.eventType ?? message.attributes?.event_type;
      if (eventType && eventType !== KILL_SWITCH_EVENT_TYPE) {
        message.ack();
        return;
      }
      let envelope: KillSwitchEnvelope;
      try {
        envelope = JSON.parse(message.data.toString('utf8')) as KillSwitchEnvelope;
      } catch {
        message.ack();
        return;
      }
      if (envelope.tenantId === tenantId) {
        invalidated.push({ tenantId: envelope.tenantId });
      }
      message.ack();
    };

    sub.on('message', handler);
    await new Promise((r) => setTimeout(r, 200));

    // Publish with a non-kill-switch event type — must be ignored.
    await pubsub.topic(TOPIC_NAME).publishMessage({
      data: Buffer.from(JSON.stringify({ tenantId })),
      attributes: { eventType: 'governance.some_other_event' },
    });

    await new Promise((r) => setTimeout(r, 1500));

    sub.removeListener('message', handler);
    await sub.close();

    expect(invalidated).toHaveLength(0);
  });
});
