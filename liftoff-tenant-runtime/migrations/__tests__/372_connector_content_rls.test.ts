// connector_content is FORCE-RLS on app.tenant_id as of migration 372.
//
// This table holds redacted-but-real customer business content — mail bodies,
// documents, ticket text — for thirty days. It went from migration 114 to 372
// with a tenant_id column and no policy, which was survivable only while its
// only writer was off: `content-indexer` returns on line one unless
// CONNECTOR_CONTENT_INDEXING_ENABLED is 'true'. The same change turns that writer on, so the policy has to hold before
// there is anything to protect.
//
// Skipped unless TEST_DATABASE_URL is set (migration 372 applied).

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const T1 = '00000000-0000-0000-0000-0000000cd001';
const T2 = '00000000-0000-0000-0000-0000000cd002';

describeFn('connector_content RLS', () => {
  let pool: Pool;

  const asTenant = async (t: string, sql: string, params: unknown[] = []) => {
    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [t]);
    return pool.query(sql, params);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    for (const t of [T1, T2]) {
      await pool.query(
        `INSERT INTO tenants (id, external_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [t, `cc-rls-${t.slice(-4)}`],
      );
      await asTenant(t, `DELETE FROM connector_content WHERE tenant_id = $1`, [t]);
      await asTenant(
        t,
        `INSERT INTO connector_content
           (tenant_id, connector_type, entity_id, entity_type, agent_id,
            chunk_index, content, content_hash, expires_at, updated_at)
         VALUES ($1, 'slack', $2, 'message', NULL, 0, $3, 'hash', NOW() + INTERVAL '30 days', NOW())`,
        [t, `slack:${t.slice(-4)}`, `content belonging to ${t.slice(-4)}`],
      );
    }
  });

  afterAll(async () => {
    for (const t of [T1, T2]) {
      await asTenant(t, `DELETE FROM connector_content WHERE tenant_id = $1`, [t]);
    }
    await pool.end();
  });

  it('is ENABLE + FORCE, so even the owning role is subject to the policy', async () => {
    const res = await pool.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'connector_content'`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
    expect(res.rows[0].relforcerowsecurity).toBe(true);
  });

  it('shows a tenant only its own rows', async () => {
    const mine = await asTenant(T1, `SELECT tenant_id FROM connector_content`);
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(mine.rows.every((r: { tenant_id: string }) => r.tenant_id === T1)).toBe(true);
  });

  it('hides another tenant even when its id is named explicitly', async () => {
    const res = await asTenant(T1, `SELECT * FROM connector_content WHERE tenant_id = $1`, [T2]);
    expect(res.rowCount).toBe(0);
  });

  it('refuses a cross-tenant INSERT via WITH CHECK', async () => {
    await expect(
      asTenant(
        T1,
        `INSERT INTO connector_content
           (tenant_id, connector_type, entity_id, entity_type, agent_id,
            chunk_index, content, content_hash, expires_at, updated_at)
         VALUES ($1, 'slack', 'smuggled', 'message', NULL, 0, 'x', 'h', NOW() + INTERVAL '1 day', NOW())`,
        [T2],
      ),
    ).rejects.toThrow();
  });

  it('RAISES off a scope rather than returning an empty result', async () => {
    // The whole point of the fail-loud form. `current_setting(...)` without the
    // `true` second argument raises 42704 when the GUC is unset. The silent
    // variant would compare tenant_id to NULL, return zero rows and SUCCEED —
    // and for a retrieval source, zero rows reads as "this workspace has
    // nothing indexed", which is exactly the confident falsehood the
    // indexed-context source exists to avoid.
    const fresh = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await expect(fresh.query('SELECT * FROM connector_content')).rejects.toThrow(/42704|unrecognized configuration/);
    } finally {
      await fresh.end();
    }
  });
});
