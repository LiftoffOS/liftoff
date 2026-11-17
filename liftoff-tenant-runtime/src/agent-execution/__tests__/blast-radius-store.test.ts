// The persisted blast-radius counter, against a real database.
//
// The reason this is persisted at all is that three dispatch paths reach a
// connector and one of them arrives over HTTP on a possibly-different pod. So
// what is pinned here is the shared-counter behaviour: concurrent increments
// ADD rather than overwrite, a reader in another process sees what a writer
// already counted, and a database fault degrades to a number rather than an
// exception inside a governance decision.
//
// Skipped unless TEST_DATABASE_URL is set (migration 371 applied).

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const T1 = '00000000-0000-0000-0000-0000000ce001';
const T2 = '00000000-0000-0000-0000-0000000ce002';
const INV = '00000000-0000-0000-0000-00000000in01'.replace(/in01/, '0001');

let pool: Pool;

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: async (tenantId: string, fn: (c: unknown) => Promise<unknown>) => {
    const client = await (pool as Pool).connect();
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
      return await fn(client);
    } finally {
      client.release();
    }
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { incrementRunTotals, pruneOldRunTotals, readRunTotals } from '../blast-radius-store';

const batch = (entities: number, destructive = 0, cleared = 0) => ({
  entitiesTouched: entities,
  destructiveOps: destructive,
  clearedFields: cleared,
});

describeFn('blast-radius store', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    // `invocation_blast_radius.tenant_id` is a foreign key. Without the parent
    // rows every increment fails the constraint, the store swallows it by
    // design, and the suite would pass or fail depending on what an unrelated
    // test left behind.
    await pool.query(
      `INSERT INTO tenants (id, external_id) VALUES ($1, 'blast-t1'), ($2, 'blast-t2')
       ON CONFLICT (id) DO NOTHING`,
      [T1, T2],
    );
  });

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      for (const t of [T1, T2]) {
        await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [t]);
        await client.query(`DELETE FROM invocation_blast_radius WHERE tenant_id = $1`, [t]);
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('reports zeroes for a run that has not dispatched anything', async () => {
    expect(await readRunTotals(T1, INV)).toEqual(batch(0, 0, 0));
  });

  it('actually persists — a silently-swallowed write would make this suite lie', async () => {
    // The store never throws, so a broken write looks exactly like a run that
    // changed nothing. This asserts the row exists rather than trusting the
    // return value.
    await incrementRunTotals(T1, INV, batch(1));
    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [T1]);
      const { rows } = await client.query(
        `SELECT entities_touched FROM invocation_blast_radius WHERE tenant_id = $1 AND invocation_id = $2`,
        [T1, INV],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].entities_touched).toBe(1);
    } finally {
      client.release();
    }
  });

  it('records the first batch', async () => {
    const out = await incrementRunTotals(T1, INV, batch(3, 2, 1));
    expect(out).toEqual({ entitiesTouched: 3, destructiveOps: 2, clearedFields: 1 });
    expect(await readRunTotals(T1, INV)).toEqual({ entitiesTouched: 3, destructiveOps: 2, clearedFields: 1 });
  });

  it('ADDS rather than overwrites — the whole reason the increment is in SQL', async () => {
    await incrementRunTotals(T1, INV, batch(2, 1));
    await incrementRunTotals(T1, INV, batch(5, 4));
    expect(await readRunTotals(T1, INV)).toEqual({ entitiesTouched: 7, destructiveOps: 5, clearedFields: 0 });
  });

  it('adds correctly when two paths increment concurrently', async () => {
    // The LLM loop and a sandbox script dispatching at the same time. A
    // read-modify-write would lose one of these, and the lost one is exactly
    // the evidence the gate is accumulating.
    await Promise.all(Array.from({ length: 10 }, () => incrementRunTotals(T1, INV, batch(1, 1))));
    expect(await readRunTotals(T1, INV)).toEqual({ entitiesTouched: 10, destructiveOps: 10, clearedFields: 0 });
  });

  it('keeps runs separate', async () => {
    const other = '00000000-0000-0000-0000-000000000002';
    await incrementRunTotals(T1, INV, batch(5, 5));
    await incrementRunTotals(T1, other, batch(1));
    expect((await readRunTotals(T1, other)).destructiveOps).toBe(0);
  });

  it('keeps tenants separate', async () => {
    await incrementRunTotals(T1, INV, batch(9, 9));
    expect(await readRunTotals(T2, INV)).toEqual(batch(0, 0, 0));
  });

  it('reports zeroes rather than throwing when the read fails', async () => {
    // This runs inside a governance decision; an exception here would fail an
    // agent's turn over a database hiccup.
    const bad = '00000000-0000-0000-0000-00000000dead';
    expect(await readRunTotals(bad, 'not-a-uuid')).toEqual(batch(0, 0, 0));
  });

  it('returns null rather than throwing when the write fails', async () => {
    expect(await incrementRunTotals(T1, 'not-a-uuid', batch(1))).toBeNull();
  });

  it('prunes counters whose run finished long ago', async () => {
    await incrementRunTotals(T1, INV, batch(1));
    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [T1]);
      await client.query(
        `UPDATE invocation_blast_radius SET updated_at = NOW() - interval '10 days' WHERE tenant_id = $1`,
        [T1],
      );
    } finally {
      client.release();
    }

    expect(await pruneOldRunTotals(T1, 72)).toBe(1);
    expect(await readRunTotals(T1, INV)).toEqual(batch(0, 0, 0));
  });

  it('leaves a live run alone', async () => {
    await incrementRunTotals(T1, INV, batch(1));
    expect(await pruneOldRunTotals(T1, 72)).toBe(0);
    expect((await readRunTotals(T1, INV)).entitiesTouched).toBe(1);
  });
});
