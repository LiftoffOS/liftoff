// Migration 357 — invocations.accountable_user_id + attribution_source.
//
// What matters here is not that the columns exist but that the one-way
// invariant is ENFORCED: an originator, when present, IS the accountable party,
// and no derivation may overwrite them. A CHECK left NOT VALID would police new
// rows while tolerating every older row that already broke the rule — half an
// invariant, and the half that is hardest to notice missing. So the test asserts
// convalidated, and that the backfill which makes validation possible actually
// ran.
//
// Skipped unless TEST_DATABASE_URL is set (the same guard every other migration
// test uses).

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('migration 357 — accountable user', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('adds both columns as nullable TEXT', async () => {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'invocations'
          AND column_name IN ('accountable_user_id', 'attribution_source')
        ORDER BY column_name`,
    );
    expect(cols.rows).toHaveLength(2);
    for (const row of cols.rows) {
      expect(row.data_type).toBe('text');
      expect(row.is_nullable).toBe('YES');
    }
  });

  it('enforces the one-way invariant, and the constraint is VALIDATED', async () => {
    const chk = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated
         FROM pg_constraint
        WHERE conname = 'invocations_accountable_follows_originator'`,
    );
    expect(chk.rows[0]).toBeDefined();
    expect(chk.rows[0].def).toMatch(/triggered_by_user_id IS NULL/);
    expect(chk.rows[0].def).toMatch(/accountable_user_id IS NOT DISTINCT FROM triggered_by_user_id/);
    // The whole point: an unvalidated constraint would leave historical rows
    // exempt from the rule it exists to state.
    expect(chk.rows[0].convalidated).toBe(true);
  });

  it('leaves no row where an originator is not the accountable party', async () => {
    const bad = await pool.query(
      `SELECT count(*)::int AS n FROM invocations
        WHERE triggered_by_user_id IS NOT NULL
          AND accountable_user_id IS DISTINCT FROM triggered_by_user_id`,
    );
    expect(bad.rows[0].n).toBe(0);
  });

  it('does not invent an attribution for rows that never had an originator', async () => {
    // NULL/NULL is a pre-357 row that predates the question. Writing
    // 'unattributed' across them would erase the difference between "we asked
    // and there was nobody" and "we never asked".
    const invented = await pool.query(
      `SELECT count(*)::int AS n FROM invocations
        WHERE triggered_by_user_id IS NULL
          AND accountable_user_id IS NOT NULL`,
    );
    expect(invented.rows[0].n).toBe(0);
  });

  it('indexes the query it exists for', async () => {
    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'invocations' AND indexname = 'idx_invocations_accountable_user'`,
    );
    expect(idx.rows[0]?.indexdef).toMatch(/tenant_id, accountable_user_id/);
    expect(idx.rows[0]?.indexdef).toMatch(/WHERE \(accountable_user_id IS NOT NULL\)/);
  });
});

describeFn('migration 357 — the source and the id agree', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
  afterAll(async () => { if (pool) await pool.end(); });

  it('enforces the relationship, and the constraint is VALIDATED', async () => {
    const chk = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated
         FROM pg_constraint
        WHERE conname = 'invocations_attribution_source_matches_id'`,
    );
    expect(chk.rows[0]).toBeDefined();
    expect(chk.rows[0].convalidated).toBe(true);
  });

  it('leaves no row where the source and the id contradict each other', async () => {
    const bad = await pool.query(
      `SELECT count(*)::int AS n FROM invocations
        WHERE attribution_source IS NOT NULL
          AND (attribution_source = 'unattributed') IS DISTINCT FROM (accountable_user_id IS NULL)`,
    );
    expect(bad.rows[0].n).toBe(0);
  });

  // Deliberately not enumerated, following failure_class (migration 308): a new
  // class should be a code change, not a migration.
  it('does not bound the source VALUES', async () => {
    const chks = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'invocations'::regclass AND contype = 'c'`,
    );
    const defs = chks.rows.map((r: { def: string }) => r.def).join(' ');
    expect(defs).not.toMatch(/attribution_source[^)]*IN \(/);
  });
});
