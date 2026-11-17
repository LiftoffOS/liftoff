// Migration 313 verification — reactive_fire_ledger (C3 loop guard).
//
// RLS census: the table must exist with ROW LEVEL SECURITY *forced* and a tenant policy, and it
// must accept a fire row under a set tenant scope. Skipped unless TEST_DATABASE_URL is set.

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const TENANT_ID = '00000000-0000-0000-0000-000000000313';

describeFn('Migration 313 — reactive_fire_ledger', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });
  afterEach(async () => {
    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_ID]);
    await pool.query(`DELETE FROM reactive_fire_ledger WHERE tenant_id = $1`, [TENANT_ID]);
  });

  it('has ROW LEVEL SECURITY forced (census)', async () => {
    const { rows } = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'reactive_fire_ledger'`);
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it('has a tenant isolation policy', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_policies WHERE tablename = 'reactive_fire_ledger'`);
    expect(Number(rows[0].count)).toBeGreaterThan(0);
  });

  it('accepts a fire row within a set tenant scope', async () => {
    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_ID]);
    await pool.query(
      `INSERT INTO reactive_fire_ledger (tenant_id, subscription_id, subject_key, state_sig)
       VALUES ($1, gen_random_uuid(), 'github:PullRequest:1', 'sig-1')`, [TENANT_ID]);
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reactive_fire_ledger WHERE tenant_id = $1`, [TENANT_ID]);
    expect(Number(rows[0].count)).toBe(1);
  });
});
