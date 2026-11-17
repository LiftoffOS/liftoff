// Migration 359 — agent_run_states items get id + parentId (schema 1.2).
//
// This migration once had a form Postgres refuses to run at all:
// `LAG(...) OVER (...)` inside `jsonb_agg(...)` raises "aggregate function
// calls cannot contain window function calls" (42803). That takes the migrate
// job down, and with node-pg-migrate running the pending set in one
// transaction, an unrelated migration rolls back with it. A migration that
// cannot parse is not a subtle bug, and nothing in the suite would have caught
// it, so this file executes the real statements against a real Postgres.
//
// The subtler property tested here is the parent linkage. gen_random_uuid() is
// volatile and each id is read twice — as this item's `id` and as the next
// item's `parentId`. If the planner ever inlines the call into both reference
// sites instead of reading one materialized value, every link points at an id
// that does not exist, and nothing about the migration looks wrong: it
// succeeds, the row count is right, and the data is quietly broken. The bulk
// case exists because that choice is a planner decision, and planners change
// their minds as row counts grow.
//
// Skipped unless TEST_DATABASE_URL is set (the same guard every other migration
// test uses). The migration is applied by the harness before this runs, so the
// fixtures below are inserted at 1.1 and re-run through the statements.

import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', '359_agent_run_states_schema_1_2.sql'),
  'utf8',
);

const TENANT = 'mig359-tenant';

interface Item { id?: string; parentId?: string | null; k?: unknown }

describeFn('migration 359 — run-state item identity', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM agent_run_states WHERE tenant_id = $1', [TENANT]);
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM agent_run_states WHERE tenant_id = $1', [TENANT]);
  });

  async function seed(invocationId: string, version: string, state: unknown) {
    await pool.query(
      `INSERT INTO agent_run_states (invocation_id, tenant_id, agent_id, schema_version, state)
       VALUES ($1, $2, 'mig359-agent', $3, $4)`,
      [invocationId, TENANT, version, JSON.stringify(state)],
    );
  }

  async function read(invocationId: string) {
    const res = await pool.query<{ schema_version: string; state: { $schemaVersion: string; items?: Item[] } }>(
      'SELECT schema_version, state FROM agent_run_states WHERE invocation_id = $1',
      [invocationId],
    );
    return res.rows[0];
  }

  /** The statements as shipped. Running the file rather than a paraphrase is
   *  the point: a paraphrase would not have caught the 42803. */
  const run = () => pool.query(MIGRATION);

  it('runs at all', async () => {
    // The regression that motivated this file. Everything below assumes it.
    await expect(run()).resolves.toBeDefined();
  });

  it('chains parentId to the previous item id', async () => {
    await seed('m359-three', '1.1', {
      $schemaVersion: '1.1',
      items: [{ k: 'a' }, { k: 'b' }, { k: 'c' }],
    });

    await run();

    const row = await read('m359-three');
    expect(row.schema_version).toBe('1.2');
    expect(row.state.$schemaVersion).toBe('1.2');
    const items = row.state.items!;
    expect(items.map((i) => i.k)).toEqual(['a', 'b', 'c']);
    expect(items[0].parentId).toBeNull();
    // The linkage, which is the whole reason the window function is here.
    expect(items[1].parentId).toBe(items[0].id);
    expect(items[2].parentId).toBe(items[1].id);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
  });

  it('gives a single item an id and no parent', async () => {
    await seed('m359-one', '1.1', { $schemaVersion: '1.1', items: [{ k: 'solo' }] });
    await run();
    const items = (await read('m359-one')).state.items!;
    expect(items).toHaveLength(1);
    expect(items[0].id).toEqual(expect.any(String));
    expect(items[0].parentId).toBeNull();
  });

  it('advances a row with an empty items array', async () => {
    // It produces no rows to explode, so the first statement cannot see it. The
    // second statement is what carries it to 1.2.
    await seed('m359-empty', '1.1', { $schemaVersion: '1.1', items: [] });
    await run();
    const row = await read('m359-empty');
    expect(row.schema_version).toBe('1.2');
    expect(row.state.$schemaVersion).toBe('1.2');
    expect(row.state.items).toEqual([]);
  });

  it('advances a row with no items key without inventing one', async () => {
    await seed('m359-noitems', '1.1', { $schemaVersion: '1.1' });
    await run();
    const row = await read('m359-noitems');
    expect(row.schema_version).toBe('1.2');
    expect(row.state.$schemaVersion).toBe('1.2');
    expect(row.state.items).toBeUndefined();
  });

  it('leaves 1.0 rows for migration 325 and 1.2 rows alone', async () => {
    await seed('m359-legacy', '1.0', { $schemaVersion: '1.0', items: [{ k: 'old' }] });
    await seed('m359-done', '1.2', {
      $schemaVersion: '1.2',
      items: [{ k: 'x', id: 'keep-me', parentId: null }],
    });

    await run();

    expect((await read('m359-legacy')).state.$schemaVersion).toBe('1.0');
    expect((await read('m359-done')).state.items![0].id).toBe('keep-me');
  });

  it('is a no-op on a second run', async () => {
    // Not merely "does not error". A second pass that re-minted ids would break
    // every parent link already recorded, and the row count would look fine.
    await seed('m359-idem', '1.1', {
      $schemaVersion: '1.1',
      items: [{ k: 'a' }, { k: 'b' }],
    });
    await run();
    const first = await read('m359-idem');

    await run();
    const second = await read('m359-idem');

    expect(second.state).toEqual(first.state);
  });

  it('keeps every link intact across many rows', async () => {
    // The volatile-uuid hazard is a planner decision, so it has to be checked at
    // a size where the planner might decide differently.
    await pool.query(
      `INSERT INTO agent_run_states (invocation_id, tenant_id, agent_id, schema_version, state)
       SELECT 'm359-bulk-' || g, $1, 'mig359-agent', '1.1',
              jsonb_build_object('$schemaVersion', '1.1', 'items',
                (SELECT jsonb_agg(jsonb_build_object('k', i)) FROM generate_series(1, 12) i))
         FROM generate_series(1, 200) g`,
      [TENANT],
    );

    await run();

    const broken = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM agent_run_states a
              CROSS JOIN LATERAL jsonb_array_elements(a.state->'items')
                                 WITH ORDINALITY t(e, o)
        WHERE a.tenant_id = $1
          AND t.o > 1
          AND t.e->>'parentId' IS DISTINCT FROM (a.state->'items'->(t.o::int - 2)->>'id')`,
      [TENANT],
    );
    expect(broken.rows[0].n).toBe('0');

    const orphaned = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM agent_run_states a
              CROSS JOIN LATERAL jsonb_array_elements(a.state->'items') t(e)
        WHERE a.tenant_id = $1 AND t.e->>'id' IS NULL`,
      [TENANT],
    );
    expect(orphaned.rows[0].n).toBe('0');
  });

  it('does not link one run into another', async () => {
    // PARTITION BY invocation_id. Without it the LAG would run across the whole
    // exploded set and the first item of each run would inherit the last item
    // of whichever run sorted before it.
    await seed('m359-p1', '1.1', { $schemaVersion: '1.1', items: [{ k: 1 }, { k: 2 }] });
    await seed('m359-p2', '1.1', { $schemaVersion: '1.1', items: [{ k: 3 }, { k: 4 }] });

    await run();

    expect((await read('m359-p1')).state.items![0].parentId).toBeNull();
    expect((await read('m359-p2')).state.items![0].parentId).toBeNull();
  });
});
