/**
 * Postgres-backed integration tests for sweepWebFetchExpired().
 *
 * Gated on TEST_DATABASE_URL. Verifies the janitor:
 *  - deletes expired web_inflight_requests rows AND fires pg_notify so
 *    waiters wake when releases stopped coming naturally (all holders
 *    crashed)
 *  - deletes expired web_waiters rows
 *  - leaves a merely-expired web_session for the REAPER, and closes one only
 *    as a backstop once it is an hour past expiry
 *  - deletes token_buckets rows older than 24h
 *  - is a no-op when nothing is stale
 */

import { Pool } from 'pg';

const SKIP = !process.env.TEST_DATABASE_URL;
const describeFn = SKIP ? describe.skip : describe;

let testPool: Pool;
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => testPool,
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { sweepWebFetchExpired } from '../janitor';

const T1 = '11111111-1111-1111-1111-111111111111';
const A1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function reset(p: Pool): Promise<void> {
  await p.query(`DELETE FROM web_inflight_requests`);
  await p.query(`DELETE FROM web_waiters`);
  // web_sessions / token_buckets cleaned only for our test ids to avoid
  // disturbing other concurrent tests.
  await p.query(`DELETE FROM web_sessions WHERE tenant_id = $1`, [T1]);
  await p.query(`DELETE FROM token_buckets WHERE bucket_key LIKE $1`, [`${T1}:%`]);
}

describeFn('janitor — Postgres integration', () => {
  beforeAll(async () => {
    testPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await testPool.end();
  });

  beforeEach(async () => {
    await reset(testPool);
  });

  it('deletes expired inflight rows but leaves fresh ones', async () => {
    // One expired, one fresh.
    await testPool.query(
      `INSERT INTO web_inflight_requests (request_id, tenant_id, agent_id, vendor, tool_name, expires_at)
       VALUES (gen_random_uuid(), $1, $2, 'anchor', 'web_fetch_advanced', NOW() - INTERVAL '1 minute'),
              (gen_random_uuid(), $1, $2, 'anchor', 'web_fetch_advanced', NOW() + INTERVAL '5 minutes')`,
      [T1, A1],
    );
    await sweepWebFetchExpired();
    const { rows } = await testPool.query(`SELECT COUNT(*)::int AS n FROM web_inflight_requests`);
    expect(rows[0].n).toBe(1);
  });

  it('fires pg_notify for each reclaimed inflight row so waiters wake', async () => {
    // Subscribe via a dedicated Client so we can observe the NOTIFY.
    const { Client } = await import('pg');
    const listenClient = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await listenClient.connect();
    await listenClient.query('LISTEN web_fetch_release');
    const seen: string[] = [];
    listenClient.on('notification', (msg) => { if (msg.payload) seen.push(msg.payload); });
    try {
      await testPool.query(
        `INSERT INTO web_inflight_requests (request_id, tenant_id, agent_id, vendor, tool_name, expires_at)
         VALUES (gen_random_uuid(), $1, $2, 'anchor', 'web_fetch_advanced', NOW() - INTERVAL '1 minute'),
                (gen_random_uuid(), $1, $2, 'webclaw', 'web_fetch_advanced', NOW() - INTERVAL '1 minute')`,
        [T1, A1],
      );
      await sweepWebFetchExpired();
      await new Promise(r => setTimeout(r, 500));
      expect(seen.sort()).toEqual(['anchor', 'webclaw']);
    } finally {
      await listenClient.end();
    }
  }, 10_000);

  it('deletes expired waiter rows', async () => {
    await testPool.query(
      `INSERT INTO web_waiters (waiter_id, vendor, tenant_id, expires_at)
       VALUES (gen_random_uuid(), 'anchor', $1, NOW() - INTERVAL '1 minute'),
              (gen_random_uuid(), 'anchor', $1, NOW() + INTERVAL '1 minute')`,
      [T1],
    );
    await sweepWebFetchExpired();
    const { rows } = await testPool.query(`SELECT COUNT(*)::int AS n FROM web_waiters`);
    expect(rows[0].n).toBe(1);
  });

  it('leaves a merely-expired session for the reaper, and closes one only an hour past expiry', async () => {
    // The reaper is the only path that stops the session at the VENDOR and
    // settles its cost. This sweep selected on the same predicate and ran every
    // 60s against the reaper's 5 minutes, so it took the row first almost every
    // time: the slot was freed, the vendor kept charging its upfront window,
    // and the cost was recorded nowhere.
    await testPool.query(
      `INSERT INTO web_sessions (tenant_id, agent_id, caller_session_id, vendor, vendor_session_id, vendor_metadata, expires_at, closed_at)
       VALUES
         ($1, $2, 'sid-expired',   'anchor', 'v-1', '{}'::jsonb, NOW() - INTERVAL '1 minute', NULL),
         ($1, $2, 'sid-abandoned', 'anchor', 'v-4', '{}'::jsonb, NOW() - INTERVAL '2 hours',  NULL),
         ($1, $2, 'sid-fresh',     'anchor', 'v-2', '{}'::jsonb, NOW() + INTERVAL '5 minutes', NULL),
         ($1, $2, 'sid-already',   'anchor', 'v-3', '{}'::jsonb, NOW() - INTERVAL '1 minute', NOW())`,
      [T1, A1],
    );
    await sweepWebFetchExpired();
    const { rows } = await testPool.query(
      `SELECT caller_session_id, closed_at, closed_reason FROM web_sessions WHERE tenant_id = $1 ORDER BY caller_session_id`,
      [T1],
    );
    const byId = Object.fromEntries(rows.map(r => [r.caller_session_id, r]));

    // Just expired: the reaper's to settle. Taking it here is the bug.
    expect(byId['sid-expired'].closed_at).toBeNull();
    // An hour past expiry means the reaper never came. Free the slot and say so.
    expect(byId['sid-abandoned'].closed_at).not.toBeNull();
    expect(byId['sid-abandoned'].closed_reason).toBe('failed');

    expect(byId['sid-fresh'].closed_at).toBeNull();
    expect(byId['sid-already'].closed_at).not.toBeNull();
  });

  it('deletes token_buckets rows last_refilled_at older than 24h', async () => {
    await testPool.query(
      `INSERT INTO token_buckets (bucket_key, tokens, capacity, refill_rate_per_sec, last_refilled_at)
       VALUES ($1, 1, 10, 0.01, NOW() - INTERVAL '25 hours'),
              ($2, 1, 10, 0.01, NOW())`,
      [`${T1}:anchor:web_task`, `${T1}:anchor:web_fetch_advanced`],
    );
    await sweepWebFetchExpired();
    const { rows } = await testPool.query(
      `SELECT bucket_key FROM token_buckets WHERE bucket_key LIKE $1 ORDER BY bucket_key`,
      [`${T1}:%`],
    );
    expect(rows.map(r => r.bucket_key)).toEqual([`${T1}:anchor:web_fetch_advanced`]);
  });

  it('is a no-op when nothing is stale', async () => {
    await expect(sweepWebFetchExpired()).resolves.toBeUndefined();
  });
});
