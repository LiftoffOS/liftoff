// Census: calibration_runs is FORCE-RLS on app.tenant_id — a tenant can never read another
// tenant's calibration history. Skipped unless TEST_DATABASE_URL is set (migration 320 applied).

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const T1 = '00000000-0000-0000-0000-00000000ca11';
const T2 = '00000000-0000-0000-0000-00000000ca12';

describeFn('calibration_runs RLS', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    for (const t of [T1, T2]) {
      await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [t]);
      await pool.query(`DELETE FROM calibration_runs WHERE tenant_id = $1`, [t]);
      await pool.query(
        `INSERT INTO calibration_runs (tenant_id, constant_name, window_start, window_end, sample_count, estimator_output, applied_value, outcome)
         VALUES ($1,'NEAR_DUP_CUTOFF', now()-interval '7 days', now(), 300, 0.95, 0.96, 'promote')`,
        [t],
      );
    }
  });
  afterAll(async () => {
    if (pool) { for (const t of [T1, T2]) { await pool.query(`SELECT set_config('app.tenant_id',$1,false)`, [t]); await pool.query(`DELETE FROM calibration_runs WHERE tenant_id=$1`, [t]); } await pool.end(); }
  });

  it('a tenant sees ONLY its own calibration rows', async () => {
    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [T1]);
    const mine = await pool.query(`SELECT tenant_id FROM calibration_runs`);
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(mine.rows.every((r) => r.tenant_id === T1)).toBe(true);
    const other = await pool.query(`SELECT count(*)::int AS n FROM calibration_runs WHERE tenant_id = $1`, [T2]);
    expect(other.rows[0].n).toBe(0); // T2's rows are invisible under T1's scope
  });
});
