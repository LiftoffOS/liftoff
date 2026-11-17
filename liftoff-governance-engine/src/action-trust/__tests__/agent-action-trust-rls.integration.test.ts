/**
 * RLS integration test for agent_action_trust (migration 019).
 *
 * Prereq: docker-compose -f docker-compose.integration.yml up -d
 * (governance-pg on 127.0.0.1:55433). If unreachable the suite skips so CI
 * stays green on hosts without docker — same convention as the backfill
 * integration test.
 *
 * Verifies the tenant-isolation policy matches every other tenant-scoped
 * table in this repo: a non-BYPASSRLS role, with app.current_tenant_id set to
 * tenant A, sees ONLY tenant A's trust rows — never tenant B's. governance_admin
 * (BYPASSRLS, used by the rollup) sees everything.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

const GOV_DB = {
  host: process.env.BACKFILL_TEST_GOV_HOST ?? '127.0.0.1',
  port: Number(process.env.BACKFILL_TEST_GOV_PORT ?? 55433),
  database: 'governance_engine',
  user: 'governance_admin',
  password: 'governance_pw',
};

const TENANT_A = 'tenant-aaaa';
const TENANT_B = 'tenant-bbbb';

let reachable = false;

async function canConnect(): Promise<boolean> {
  const p = new Pool({ ...GOV_DB, connectionTimeoutMillis: 2000 });
  try {
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await p.end().catch(() => undefined);
  }
}

async function applySchema(pool: Pool): Promise<void> {
  const dir = path.join(__dirname, '..', '..', '..', 'migrations');
  const base = readFileSync(path.join(dir, '001_initial_schema.sql'), 'utf8');
  await pool.query(base).catch((err) => {
    // 001 is only idempotent under DROP; a re-run against a warm container
    // throws "already exists" — harmless here, we just need the objects.
    if (!String(err.message).includes('already exists')) throw err;
  });
  await pool.query('DROP TABLE IF EXISTS agent_action_trust CASCADE');
  const trust = readFileSync(path.join(dir, '019_agent_action_trust.sql'), 'utf8');
  await pool.query(trust);
}

describe('agent_action_trust RLS (migration 019)', () => {
  jest.setTimeout(60000);
  let adminPool: Pool;
  let rlsPool: Pool;

  beforeAll(async () => {
    reachable = await canConnect();
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn('[agent-action-trust-rls] Skipping — governance-pg not up');
      return;
    }
    adminPool = new Pool(GOV_DB);
    await applySchema(adminPool);

    // Seed one trust row per tenant (admin bypasses RLS on write).
    await adminPool.query(
      `INSERT INTO agent_action_trust (tenant_id, agent_id, action_class, runs, passes, rejects, tier)
       VALUES ($1,'a1','update',30,29,1,'auto'), ($2,'a1','update',30,10,20,'watch')`,
      [TENANT_A, TENANT_B],
    );

    // A plain (non-BYPASSRLS) login role stands in for governance_app.
    await adminPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'governance_rls_test') THEN
          CREATE ROLE governance_rls_test WITH LOGIN PASSWORD 'rls_pw';
        END IF;
      END $$;
    `);
    await adminPool.query(
      `GRANT SELECT, INSERT, UPDATE ON agent_action_trust TO governance_rls_test`,
    );
    rlsPool = new Pool({ ...GOV_DB, user: 'governance_rls_test', password: 'rls_pw' });
  });

  afterAll(async () => {
    await rlsPool?.end().catch(() => undefined);
    await adminPool?.end().catch(() => undefined);
  });

  function maybe(name: string, fn: () => Promise<void>): void {
    if (!reachable) {
      it.skip(name, () => undefined);
      return;
    }
    it(name, fn);
  }

  maybe('a scoped non-admin role sees only its own tenant', async () => {
    const client = await rlsPool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
      const a = await client.query(
        `SELECT tenant_id, tier FROM agent_action_trust`,
      );
      expect(a.rows).toHaveLength(1);
      expect(a.rows[0].tenant_id).toBe(TENANT_A);
      expect(a.rows[0].tier).toBe('auto');
    } finally {
      client.release();
    }
  });

  maybe('the other tenant sees zero of A rows', async () => {
    const client = await rlsPool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${TENANT_B}'`);
      const r = await client.query(
        `SELECT COUNT(*)::int AS n FROM agent_action_trust WHERE tenant_id = $1`,
        [TENANT_A],
      );
      expect(r.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  maybe('the WITH CHECK clause blocks cross-tenant writes', async () => {
    const client = await rlsPool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
      await expect(
        client.query(
          `INSERT INTO agent_action_trust (tenant_id, agent_id, action_class, tier)
           VALUES ($1,'a2','delete','watch')`,
          [TENANT_B],
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  maybe('governance_admin (BYPASSRLS) sees every tenant', async () => {
    const r = await adminPool.query(`SELECT COUNT(*)::int AS n FROM agent_action_trust`);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
