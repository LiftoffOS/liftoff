/**
 * RLS cross-tenant denial for action_trust_decisions (migration 021).
 *
 * Requires the governance-pg container (127.0.0.1:55433). Skips gracefully when it is
 * unreachable so a bare `npm test` on a host without docker stays green. RLS is exercised
 * under a NON-owner role via SET ROLE, so FORCE row-level security actually applies (a
 * superuser/owner would otherwise bypass it).
 */

import { Pool } from 'pg';

const GOV = {
  host: process.env.BACKFILL_TEST_GOV_HOST ?? '127.0.0.1',
  port: Number(process.env.BACKFILL_TEST_GOV_PORT ?? 55433),
  database: 'governance_engine',
  user: 'governance_admin',
  password: 'governance_pw',
};

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const DDL = `
  CREATE TABLE IF NOT EXISTS action_trust_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, action_class TEXT NOT NULL,
    gate_reason TEXT NOT NULL, decision TEXT NOT NULL, decided_by TEXT NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL, source TEXT NOT NULL DEFAULT 'hitl_resolve',
    source_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, source_key)
  );
  ALTER TABLE action_trust_decisions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE action_trust_decisions FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS atd_tenant_isolation ON action_trust_decisions;
  CREATE POLICY atd_tenant_isolation ON action_trust_decisions
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atd_rls_test') THEN
      CREATE ROLE atd_rls_test NOLOGIN;
    END IF;
  END $$;
  GRANT SELECT, INSERT ON action_trust_decisions TO atd_rls_test;
`;

let pool: Pool | null = null;
let reachable = false;

beforeAll(async () => {
  pool = new Pool({ ...GOV, connectionTimeoutMillis: 1500 });
  try {
    const c = await pool.connect();
    try {
      await c.query(DDL);
      await c.query(`DELETE FROM action_trust_decisions WHERE tenant_id IN ($1,$2)`, [TENANT_A, TENANT_B]);
      // Seed one row per tenant (owner path, GUC set so WITH CHECK passes).
      for (const t of [TENANT_A, TENANT_B]) {
        await c.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [t]);
        await c.query(
          `INSERT INTO action_trust_decisions (tenant_id, agent_id, action_class, gate_reason, decision, decided_by, decided_at, source_key)
           VALUES ($1, 'ag', 'send', 'sensitive_work', 'approved', 'u', now(), $2)`,
          [t, `${t}-key`],
        );
      }
      reachable = true;
    } finally {
      c.release();
    }
  } catch {
    reachable = false; // container not up — skip
  }
});

afterAll(async () => { await pool?.end(); });

async function asRlsRole<T>(tenantId: string, fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const c = await pool!.connect();
  try {
    await c.query('SET ROLE atd_rls_test');                                  // non-owner → RLS applies
    await c.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);
    return await fn(c);
  } finally {
    await c.query('RESET ROLE').catch(() => {});
    c.release();
  }
}

describe('action_trust_decisions RLS', () => {
  it('a tenant sees ONLY its own rows (cross-tenant read denied)', async () => {
    if (!reachable) { console.warn('governance-pg unreachable — skipping RLS integration test'); return; }
    const a = await asRlsRole(TENANT_A, (c) => c.query('SELECT tenant_id FROM action_trust_decisions'));
    expect(a.rows.every((r) => r.tenant_id === TENANT_A)).toBe(true);
    expect(a.rows.length).toBeGreaterThan(0);

    const b = await asRlsRole(TENANT_B, (c) => c.query('SELECT tenant_id FROM action_trust_decisions'));
    expect(b.rows.every((r) => r.tenant_id === TENANT_B)).toBe(true);
    // Tenant B cannot see tenant A's seeded row.
    expect(b.rows.some((r) => r.tenant_id === TENANT_A)).toBe(false);
  });

  it('WITH CHECK blocks inserting another tenant\'s row', async () => {
    if (!reachable) { console.warn('governance-pg unreachable — skipping RLS integration test'); return; }
    await expect(
      asRlsRole(TENANT_B, (c) => c.query(
        `INSERT INTO action_trust_decisions (tenant_id, agent_id, action_class, gate_reason, decision, decided_by, decided_at, source_key)
         VALUES ($1, 'ag', 'send', 'sensitive_work', 'approved', 'u', now(), 'x-key')`,
        [TENANT_A], // GUC is TENANT_B → writing a TENANT_A row must fail WITH CHECK
      )),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});
