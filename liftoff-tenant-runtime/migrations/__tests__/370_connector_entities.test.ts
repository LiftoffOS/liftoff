// Census: connector_entities and connector_enumeration_state are FORCE-RLS on
// app.tenant_id — a tenant can never read another tenant's inventory.
//
// The fail-loud policy form matters more here than on most tables: this one
// answers "what exists in your systems", so a silently-empty result reads as a
// truthful "nothing" rather than as the missing tenant context it actually is.
// Skipped unless TEST_DATABASE_URL is set (migration 370 applied).

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const T1 = '00000000-0000-0000-0000-0000000ce001';
const T2 = '00000000-0000-0000-0000-0000000ce002';
const CONNECTOR = '00000000-0000-0000-0000-0000000cc001';

describeFn('connector_entities RLS', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    for (const t of [T1, T2]) {
      await pool.query(
        `INSERT INTO tenants (id, external_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [t, `census-test-${t.slice(-4)}`],
      );
      await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [t]);
      await pool.query(`DELETE FROM connector_entities WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM connector_enumeration_state WHERE tenant_id = $1`, [t]);
      await pool.query(
        `INSERT INTO connector_entities
           (tenant_id, connector_id, connector_type, remote_id, entity_type, title, projected_path)
         VALUES ($1, $2, 'slack', 'C123', 'channel', 'engineering', 'slack/channels/engineering')`,
        [t, CONNECTOR],
      );
      await pool.query(
        `INSERT INTO connector_enumeration_state (tenant_id, connector_id, connector_type, scope)
         VALUES ($1, $2, 'slack', 'channels')`,
        [t, CONNECTOR],
      );
    }
  });

  afterAll(async () => {
    if (!pool) return;
    for (const t of [T1, T2]) {
      await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [t]);
      await pool.query(`DELETE FROM connector_entities WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM connector_enumeration_state WHERE tenant_id = $1`, [t]);
    }
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[T1, T2]]);
    await pool.end();
  });

  it('a tenant sees ONLY its own entities', async () => {
    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [T1]);
    const mine = await pool.query(`SELECT tenant_id FROM connector_entities`);
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(mine.rows.every((r) => r.tenant_id === T1)).toBe(true);

    const other = await pool.query(
      `SELECT count(*)::int AS n FROM connector_entities WHERE tenant_id = $1`,
      [T2],
    );
    expect(other.rows[0].n).toBe(0);
  });

  it('a tenant sees ONLY its own enumeration checkpoints', async () => {
    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [T2]);
    const mine = await pool.query(`SELECT tenant_id FROM connector_enumeration_state`);
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(mine.rows.every((r) => r.tenant_id === T2)).toBe(true);
  });

  it('cannot write a row belonging to another tenant', async () => {
    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [T1]);
    await expect(
      pool.query(
        `INSERT INTO connector_entities
           (tenant_id, connector_id, connector_type, remote_id, entity_type, projected_path)
         VALUES ($1, $2, 'slack', 'C999', 'channel', 'slack/channels/smuggled')`,
        [T2, CONNECTOR],
      ),
    ).rejects.toThrow();
  });

  it('RAISES with no tenant context instead of returning an empty inventory', async () => {
    // The distinction the fail-loud policy form buys. With the silent variant
    // this query would succeed and return zero rows, and an agent would read
    // that as "this workspace has nothing in it".
    await pool.query(`RESET app.tenant_id`);
    await expect(pool.query(`SELECT * FROM connector_entities`)).rejects.toThrow();
  });

  it('keeps a disappeared entity as deleted rather than removing the row', async () => {
    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [T1]);
    await pool.query(
      `UPDATE connector_entities SET deleted = TRUE WHERE tenant_id = $1 AND remote_id = 'C123'`,
      [T1],
    );
    const res = await pool.query(
      `SELECT deleted FROM connector_entities WHERE tenant_id = $1 AND remote_id = 'C123'`,
      [T1],
    );
    expect(res.rows[0].deleted).toBe(true);
  });

  it('rejects an unmodelled hydration state', async () => {
    await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [T1]);
    await expect(
      pool.query(
        `INSERT INTO connector_entities
           (tenant_id, connector_id, connector_type, remote_id, entity_type, projected_path, hydration_state)
         VALUES ($1, $2, 'slack', 'C777', 'channel', 'slack/channels/x', 'partially-ish')`,
        [T1, CONNECTOR],
      ),
    ).rejects.toThrow();
  });
});
