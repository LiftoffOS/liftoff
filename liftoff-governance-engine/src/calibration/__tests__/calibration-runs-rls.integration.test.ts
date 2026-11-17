/**
 * RLS cross-tenant denial for calibration_runs (migration 023) — the census for this table in
 * the owning repo's suite.
 *
 * Requires the governance-pg container (127.0.0.1:55433). Skips gracefully when unreachable so
 * a bare `npm test` on a host without docker stays green. RLS is exercised under a NON-owner
 * role via SET ROLE so FORCE row-level security actually applies.
 */

import { Pool } from 'pg';

const GOV = {
  host: process.env.BACKFILL_TEST_GOV_HOST ?? '127.0.0.1',
  port: Number(process.env.BACKFILL_TEST_GOV_PORT ?? 55433),
  database: 'governance_engine',
  user: 'governance_admin',
  password: 'governance_pw',
};

const TENANT_A = 'calib-tenant-a';
const TENANT_B = 'calib-tenant-b';

const DDL = `
  CREATE TABLE IF NOT EXISTS calibration_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL, constant_name TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL, window_end TIMESTAMPTZ NOT NULL,
    sample_count INT NOT NULL, estimator_output DOUBLE PRECISION,
    applied_value DOUBLE PRECISION,
    outcome TEXT NOT NULL CHECK (outcome IN ('hold','promote','rollback')),
    guardrail_delta JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE calibration_runs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE calibration_runs FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS calibration_runs_tenant_isolation ON calibration_runs;
  CREATE POLICY calibration_runs_tenant_isolation ON calibration_runs
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calib_rls_test') THEN
      CREATE ROLE calib_rls_test NOLOGIN;
    END IF;
  END $$;
  GRANT SELECT, INSERT ON calibration_runs TO calib_rls_test;
`;

let pool: Pool | null = null;
let reachable = false;

beforeAll(async () => {
  pool = new Pool({ ...GOV, connectionTimeoutMillis: 1500 });
  try {
    const c = await pool.connect();
    try {
      await c.query(DDL);
      await c.query(`DELETE FROM calibration_runs WHERE tenant_id IN ($1,$2)`, [TENANT_A, TENANT_B]);
      for (const t of [TENANT_A, TENANT_B]) {
        await c.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [t]);
        await c.query(
          `INSERT INTO calibration_runs (tenant_id, constant_name, window_start, window_end, sample_count, applied_value, outcome)
           VALUES ($1, 'TRUST_AUTO_PASS_RATE', now() - interval '7 days', now(), 100, 0.95, 'hold')`,
          [t],
        );
      }
      reachable = true;
    } finally {
      c.release();
    }
  } catch {
    reachable = false;
  }
});

afterAll(async () => { await pool?.end(); });

async function asRlsRole<T>(tenantId: string, fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const c = await pool!.connect();
  try {
    await c.query('SET ROLE calib_rls_test');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);
    return await fn(c);
  } finally {
    await c.query('RESET ROLE').catch(() => {});
    c.release();
  }
}

describe('calibration_runs RLS', () => {
  it('a tenant sees ONLY its own rows (cross-tenant read denied)', async () => {
    if (!reachable) { console.warn('governance-pg unreachable — skipping RLS integration test'); return; }
    const a = await asRlsRole(TENANT_A, (c) => c.query('SELECT tenant_id FROM calibration_runs'));
    expect(a.rows.every((r) => r.tenant_id === TENANT_A)).toBe(true);
    expect(a.rows.length).toBeGreaterThan(0);

    const b = await asRlsRole(TENANT_B, (c) => c.query('SELECT tenant_id FROM calibration_runs'));
    expect(b.rows.some((r) => r.tenant_id === TENANT_A)).toBe(false);
  });

  it('WITH CHECK blocks inserting another tenant\'s row', async () => {
    if (!reachable) { console.warn('governance-pg unreachable — skipping RLS integration test'); return; }
    await expect(
      asRlsRole(TENANT_B, (c) => c.query(
        `INSERT INTO calibration_runs (tenant_id, constant_name, window_start, window_end, sample_count, applied_value, outcome)
         VALUES ($1, 'TRUST_AUTO_PASS_RATE', now() - interval '7 days', now(), 10, 0.9, 'hold')`,
        [TENANT_A], // GUC is TENANT_B → writing a TENANT_A row must fail WITH CHECK
      )),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});
