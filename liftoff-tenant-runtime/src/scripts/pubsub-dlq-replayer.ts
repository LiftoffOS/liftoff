// WS-4.4 — DLQ replayer Cloud Run Job.
//
// Pulls messages off a DLQ subscription, records each in dlq_replay_audit,
// re-publishes to the source topic with `replayed_from_dlq: 'true'`
// attribute, acks the DLQ delivery.
//
// Runs for 5 minutes then exits. Configured per-topic via Terraform.

import { PubSub } from '@google-cloud/pubsub';
import { Pool } from 'pg';
import { getManagedSecret } from '../infrastructure/secret-store';

const SOURCE_TOPIC = process.env.SOURCE_TOPIC!;
const DLQ_SUBSCRIPTION = process.env.DLQ_SUBSCRIPTION!;
const REPLAY_AUDIT_TABLE = 'dlq_replay_audit';

async function main() {
  if (!SOURCE_TOPIC || !DLQ_SUBSCRIPTION) {
    console.error('SOURCE_TOPIC and DLQ_SUBSCRIPTION env vars are required');
    process.exit(2);
  }
  const pubsub = new PubSub();
  const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: getManagedSecret('DB_PASSWORD'),
    database: process.env.DB_NAME,
  });
  const sub = pubsub.subscription(DLQ_SUBSCRIPTION);
  const topic = pubsub.topic(SOURCE_TOPIC);

  let replayed = 0;
  let errored = 0;

  sub.on('message', async (msg) => {
    try {
      // Record audit before replay so a crash doesn't replay-twice silently.
      await pool.query(
        `INSERT INTO ${REPLAY_AUDIT_TABLE} (message_id, source_topic, dlq_subscription, replayed_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (message_id) DO NOTHING`,
        [msg.id, SOURCE_TOPIC, DLQ_SUBSCRIPTION],
      );
      // Re-publish with the same data + attributes; add a marker.
      await topic.publishMessage({
        data: msg.data,
        attributes: { ...msg.attributes, replayed_from_dlq: 'true' },
      });
      msg.ack();
      replayed++;
    } catch (err) {
      console.error('replay failed', { err: (err as Error).message, msg_id: msg.id });
      msg.nack();
      errored++;
    }
  });

  // Run for 5 minutes then exit.
  await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
  await sub.close();
  console.log(`DLQ replay complete: replayed=${replayed} errored=${errored}`);
  await pool.end();
  process.exit(errored > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
