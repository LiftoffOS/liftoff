#!/usr/bin/env ts-node
// Pulls from a Pub/Sub DLQ subscription, re-publishes each message to the main
// topic, and acks the DLQ message on successful republish.
//
// Distinct from `scripts/replay-dlq.ts` which replays from the local dlq_messages
// table (Cloud Tasks DLQ pattern). This script targets the Pub/Sub DLQ topics
// created by terraform/projects/tenant-runtime-template/agent_creation_resilience.tf.
//
// Usage:
//   npx ts-node scripts/replay-pubsub-dlq.ts \
//     --subscription=control-plane-events-prod-dlq-sub \
//     --project=YOUR_TENANT_PROJECT \
//     [--limit=50] [--dry-run] [--filter-event-type=tenant.internal_agent.created]

import { PubSub, type Message } from '@google-cloud/pubsub';

interface Args {
  subscription: string;
  project: string;
  limit: number;
  dryRun: boolean;
  filterEventType?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  const flag = (k: string) => args.includes(`--${k}`);

  const subscription = get('subscription');
  const project = get('project');
  if (!subscription || !project) {
    console.error('Usage: replay-pubsub-dlq.ts --subscription=<sub> --project=<gcp-project> [--limit=N] [--dry-run] [--filter-event-type=X]');
    process.exit(1);
  }
  return {
    subscription,
    project,
    limit: parseInt(get('limit') ?? '50', 10),
    dryRun: flag('dry-run'),
    filterEventType: get('filter-event-type'),
  };
}

// Derive the source topic from the DLQ sub name. Convention from terraform:
// `<topic>-<env>-dlq-sub` → main topic is `<topic>-<env>`.
function deriveMainTopic(dlqSub: string): string {
  const m = dlqSub.match(/^(.*-(?:dev|staging|prod))-dlq-sub$/);
  if (!m) throw new Error(`DLQ subscription name doesn't match expected pattern <topic>-<env>-dlq-sub: ${dlqSub}`);
  return m[1];
}

async function main() {
  const args = parseArgs();
  const mainTopic = deriveMainTopic(args.subscription);

  const pubsub = new PubSub({ projectId: args.project });
  const sub = pubsub.subscription(args.subscription, { flowControl: { maxMessages: args.limit } });
  const topic = pubsub.topic(mainTopic);

  console.log(`Replaying up to ${args.limit} messages from ${args.subscription} → ${mainTopic}${args.dryRun ? ' (DRY-RUN)' : ''}`);

  let received = 0;
  let replayed = 0;
  let filtered = 0;

  // NOTE: we do NOT seek backwards. The DLQ sub already has 7-day retention
  // (see terraform/projects/tenant-runtime-template/agent_creation_resilience.tf)
  // so all undelivered messages within that window are pull-able. A seek to
  // epoch would force redelivery of already-acked messages and flood the
  // pipeline on every invocation.

  // Idle-deadline pattern: each message processed resets the deadline so we
  // keep draining as long as messages keep arriving. Race-free because we wire
  // listeners synchronously BEFORE arming the first timer.
  const IDLE_MS = 10_000;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    let idleTimer: NodeJS.Timeout | null = null;

    const settle = async (err?: Error) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      try {
        await sub.close();
      } catch { /* close errors are non-fatal here */ }
      err ? reject(err) : resolve();
    };

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => settle(), IDLE_MS);
    };

    const onMessage = async (message: Message) => {
      received++;
      try {
        const attrs = message.attributes ?? {};
        const eventType = attrs.eventType;

        if (args.filterEventType && eventType !== args.filterEventType) {
          filtered++;
          message.modAck(0); // release back to DLQ without acking
        } else if (args.dryRun) {
          console.log(`[dry-run] would replay: eventType=${eventType} entityId=${attrs.entityId}`);
          message.modAck(0);
        } else {
          await topic.publishMessage({ data: message.data, attributes: attrs });
          message.ack();
          replayed++;
          console.log(`replayed: eventType=${eventType} entityId=${attrs.entityId}`);
        }

        if (received >= args.limit) {
          await settle();
        } else {
          armIdle();
        }
      } catch (err) {
        console.error(`failed to replay message: ${(err as Error).message}`);
        message.nack();
        await settle(err as Error);
      }
    };

    // Wire listeners FIRST, then arm the idle timer — guarantees the timer
    // can't fire before message delivery starts.
    sub.on('message', onMessage);
    sub.on('error', (err) => settle(err));
    armIdle();
  });

  console.log(`Done. received=${received} replayed=${replayed} filtered=${filtered}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
