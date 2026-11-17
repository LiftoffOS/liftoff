// The continuation rows against the REAL schema — DB-backed integration tests.
//
// The unit suite beside this file pins each statement's text with a mocked
// client; it cannot show that the states are what they say. This runs the
// store's statements against a migrated database and asserts on the rows:
// the ordinal follows the last for the message and the sixth is refused; a
// claim takes only a queued row and only once; a re-queued row is queued
// again for the next delivery; the recheck finds a row only while this worker
// holds it; a person's message cancels queued AND claimed rows and leaves a
// running one alone; the status read ranks running over claimed over queued;
// and the supersession test reads the surface's own messages.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     src/chat-continuations/__tests__/store.integration.test.ts

import { Pool, type PoolClient } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

let testPool: Pool | null = null;
jest.mock('../../infrastructure/database', () => ({
  getPool: () => testPool,
  withTenantScope: async (tenantId: string, fn: (client: PoolClient) => Promise<unknown>) => {
    const client = await (testPool as Pool).connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as store from '../store';

const T = '00000000-0000-0000-0000-00000000c0a0';
const OTHER_T = '00000000-0000-0000-0000-00000000c0a9';
const OWNER = '00000000-0000-0000-0000-00000000c0a1';

describeFn('chat-continuations / the rows against the real schema', () => {
  let client: PoolClient;
  let threadId: string;
  let originMessageId: string;

  async function cleanUp(): Promise<void> {
    await client.query(`DELETE FROM chat_continuations WHERE tenant_id = ANY($1::uuid[])`, [[T, OTHER_T]]);
    await client.query(`DELETE FROM liftoff_chat_messages WHERE thread_id IN (SELECT id FROM liftoff_chat_threads WHERE tenant_id = $1)`, [T]);
    await client.query(`DELETE FROM liftoff_chat_threads WHERE tenant_id = $1`, [T]);
    await client.query(`UPDATE tenant_members SET role = 'admin' WHERE tenant_id = ANY($1::uuid[]) AND role = 'owner'`, [[T, OTHER_T]]);
    await client.query(`DELETE FROM tenant_members WHERE tenant_id = ANY($1::uuid[])`, [[T, OTHER_T]]);
    await client.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[T, OTHER_T]]);
    await client.query(`DELETE FROM accounts WHERE id = $1`, [OWNER]);
  }

  beforeAll(async () => {
    testPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await testPool.connect();
    await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [T]);
    await cleanUp();
    await client.query(
      `INSERT INTO accounts (id, firebase_uid, first_name, last_name, email, timezone, version)
       VALUES ($1, 'chat-continuations-owner', 'Ada', 'Continuation', 'cc-owner@example.test', 'UTC', 1) ON CONFLICT (id) DO NOTHING`,
      [OWNER],
    );
    for (const tenant of [T, OTHER_T]) {
      await client.query(
        `INSERT INTO tenants (id, account_id, name, tier, hosting_mode, status, migration_status)
         VALUES ($1, $2, 'Continuations Tenant', 'standard', 'shared', 'pending', 'pending') ON CONFLICT (id) DO NOTHING`,
        [tenant, OWNER],
      );
    }
    threadId = (await client.query(
      `INSERT INTO liftoff_chat_threads (tenant_id, account_id, title) VALUES ($1, $2, 'Long work') RETURNING id`, [T, OWNER],
    )).rows[0].id;
    originMessageId = (await client.query(
      `INSERT INTO liftoff_chat_messages (thread_id, role, content, created_at) VALUES ($1, 'user', 'Summarise every thread.', NOW() - INTERVAL '1 minute') RETURNING id`,
      [threadId],
    )).rows[0].id;
  });

  afterAll(async () => {
    await cleanUp();
    client.release();
    await (testPool as Pool).end();
  });

  beforeEach(async () => {
    await client.query(`DELETE FROM chat_continuations WHERE tenant_id = ANY($1::uuid[])`, [[T, OTHER_T]]);
    await client.query(`DELETE FROM liftoff_chat_messages WHERE thread_id = $1 AND id <> $2`, [threadId, originMessageId]);
  });

  const enqueue = (reason = 'MAX_ITERATIONS') => store.enqueueContinuation({
    tenantId: T, surface: 'liftoff', threadId, accountId: OWNER, originMessageId, reason,
  });
  const statusOf = async (id: string) => (await client.query(`SELECT status, worker_id, claimed_at, finished_at FROM chat_continuations WHERE id = $1`, [id])).rows[0];

  it('queues with the ordinal after the last for the message, and refuses the sixth', async () => {
    const ordinals: number[] = [];
    for (let i = 0; i < 5; i++) {
      const row = await enqueue();
      expect(row).not.toBeNull();
      ordinals.push(row!.ordinal);
      expect(row!.status).toBe('queued');
      expect(row!.accountId).toBe(OWNER);
      expect(row!.originMessageId).toBe(originMessageId);
    }
    expect(ordinals).toEqual([1, 2, 3, 4, 5]);
    expect(await enqueue()).toBeNull();
    expect((await client.query(`SELECT COUNT(*)::int AS n FROM chat_continuations WHERE origin_message_id = $1`, [originMessageId])).rows[0].n).toBe(5);
  });

  it('claim takes a queued row once; requeue hands it back; recheck and running are this worker\'s alone', async () => {
    const row = (await enqueue())!;
    expect(await store.claimContinuation(T, row.id, 'w1')).toMatchObject({ id: row.id, status: 'claimed', workerId: 'w1' });
    // Taken: a second delivery finds nothing to claim.
    expect(await store.claimContinuation(T, row.id, 'w2')).toBeNull();
    // Another worker's recheck finds nothing; this worker's finds the row.
    expect(await store.recheckClaimedContinuation(T, row.id, 'w2')).toBeNull();
    expect(await store.recheckClaimedContinuation(T, row.id, 'w1')).toMatchObject({ id: row.id, status: 'claimed' });
    // The lock was busy: back to queued, cleared, and claimable again.
    expect(await store.requeueContinuation(T, row.id, 'w2')).toBe(false);
    expect(await store.requeueContinuation(T, row.id, 'w1')).toBe(true);
    expect(await statusOf(row.id)).toMatchObject({ status: 'queued', worker_id: null, claimed_at: null });
    expect(await store.claimContinuation(T, row.id, 'w3')).toMatchObject({ status: 'claimed', workerId: 'w3' });
    expect(await store.markContinuationRunning(T, row.id, 'w1')).toBe(false);
    expect(await store.markContinuationRunning(T, row.id, 'w3')).toBe(true);
    expect((await statusOf(row.id)).status).toBe('running');
    await store.finishContinuation(T, row.id, 'w3', 'done', 'completed');
    const done = await statusOf(row.id);
    expect(done.status).toBe('done');
    expect(done.finished_at).not.toBeNull();
    // Terminal: nothing moves it again.
    expect(await store.claimContinuation(T, row.id, 'w4')).toBeNull();
  });

  it('a person\'s message cancels queued and claimed rows and leaves a running one alone', async () => {
    const queued = (await enqueue())!;
    const claimed = (await enqueue())!;
    const running = (await enqueue())!;
    await store.claimContinuation(T, claimed.id, 'w1');
    await store.claimContinuation(T, running.id, 'w2');
    await store.markContinuationRunning(T, running.id, 'w2');
    expect(await store.threadContinuationStatus(T, threadId)).toBe('running');

    expect(await store.cancelThreadContinuations(T, threadId)).toBe(2);
    expect((await statusOf(queued.id)).status).toBe('cancelled');
    expect((await statusOf(claimed.id)).status).toBe('cancelled');
    expect((await statusOf(running.id)).status).toBe('running');
    // The claimed worker learns of it at its recheck.
    expect(await store.recheckClaimedContinuation(T, claimed.id, 'w1')).toBeNull();
    // The status read ranks what is live.
    expect(await store.threadContinuationStatus(T, threadId)).toBe('running');
    await store.finishContinuation(T, running.id, 'w2', 'done', 'completed');
    expect(await store.threadContinuationStatus(T, threadId)).toBeNull();
    const next = (await enqueue())!;
    expect(await store.threadContinuationStatus(T, threadId)).toBe('queued');
    await store.claimContinuation(T, next.id, 'w5');
    expect(await store.threadContinuationStatus(T, threadId)).toBe('claimed');
  });

  it('the supersession test reads the surface\'s own messages: a person\'s row newer than the origin, never an assistant\'s', async () => {
    expect(await store.hasNewerPersonMessage(T, 'liftoff', threadId, originMessageId)).toBe(false);
    await client.query(`INSERT INTO liftoff_chat_messages (thread_id, role, content) VALUES ($1, 'assistant', 'Half done.')`, [threadId]);
    expect(await store.hasNewerPersonMessage(T, 'liftoff', threadId, originMessageId)).toBe(false);
    await client.query(`INSERT INTO liftoff_chat_messages (thread_id, role, content) VALUES ($1, 'user', 'Actually, the other thing.')`, [threadId]);
    expect(await store.hasNewerPersonMessage(T, 'liftoff', threadId, originMessageId)).toBe(true);
  });

  it('is tenant-scoped: another tenant sees and cancels nothing of this one\'s', async () => {
    const row = (await enqueue())!;
    expect(await store.cancelThreadContinuations(OTHER_T, threadId)).toBe(0);
    expect(await store.threadContinuationStatus(OTHER_T, threadId)).toBeNull();
    expect(await store.claimContinuation(OTHER_T, row.id, 'w9')).toBeNull();
    expect((await statusOf(row.id)).status).toBe('queued');
  });
});
