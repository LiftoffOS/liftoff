// Smoke test: proves the 4-Postgres + Pub/Sub emulator harness is up
// and reachable. Real cross-service tests (preflight → authorize → record,
// execute batch shadow comparison) will live alongside the service code
// they exercise once Phases 1 and 3 are underway.

import { Pool } from 'pg';
import { PubSub } from '@google-cloud/pubsub';

async function query(url: string): Promise<number> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const r = await pool.query('SELECT 1 AS n');
    return r.rows[0].n as number;
  } finally {
    await pool.end();
  }
}

// The harness depends on a live multi-Postgres + Pub/Sub-emulator
// docker-compose stack. CI doesn't bring that stack up for the standard
// unit-test job, and the four database URLs aren't injected — every
// assertion below would 5xx out as connect-refused. Gate the whole suite
// on HARNESS_SMOKE=1 so a developer can opt in locally
// (`HARNESS_SMOKE=1 CONTROL_PLANE_PG_URL=... npm test`) while CI skips.
const describeOrSkip = process.env.HARNESS_SMOKE === '1' ? describe : describe.skip;

describeOrSkip('multi-service harness smoke', () => {
  it('control-plane-pg is reachable', async () => {
    expect(await query(process.env.CONTROL_PLANE_PG_URL!)).toBe(1);
  });

  it('connector-pg is reachable', async () => {
    expect(await query(process.env.CONNECTOR_PG_URL!)).toBe(1);
  });

  it('governance-pg is reachable', async () => {
    expect(await query(process.env.GOVERNANCE_PG_URL!)).toBe(1);
  });

  it('tenant-pg is reachable', async () => {
    expect(await query(process.env.TENANT_PG_URL!)).toBe(1);
  });

  it('pubsub emulator accepts topic create + publish + pull', async () => {
    const pubsub = new PubSub({ projectId: process.env.PUBSUB_PROJECT_ID });
    const topicName = `smoke-topic-${Date.now()}`;
    const subName = `smoke-sub-${Date.now()}`;

    const [topic] = await pubsub.createTopic(topicName);
    const [sub] = await topic.createSubscription(subName);

    await topic.publishMessage({ data: Buffer.from(JSON.stringify({ ok: true })) });

    const received: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('pubsub pull timed out')),
        10_000,
      );
      sub.on('message', (msg) => {
        received.push(JSON.parse(msg.data.toString('utf8')));
        msg.ack();
        clearTimeout(timer);
        resolve();
      });
      sub.on('error', reject);
    });

    expect(received).toEqual([{ ok: true }]);

    await sub.delete();
    await topic.delete();
  });
});
