// Platform-agent trust-boundary regression: the migration-193
// mutual-exclusion invariant. A row is EITHER a system agent (tenant_id NULL,
// is_system=TRUE, system_role set) OR a tenant agent (tenant_id set,
// is_system=FALSE, system_role NULL) — never a mix. This guards the CAIO/HRBP vs
// tenant-agent boundary the multi-engine work must preserve. Skipped unless
// TEST_DATABASE_URL is set (migration 193 applied to the test DB).

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn(' — system/tenant agent mutual exclusion (migration 193)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function constraintDef(): Promise<string> {
    const res = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'internal_agents_system_role_chk'`,
);
    return res.rows[0]?.def as string;
  }

  it('the mutual-exclusion CHECK constraint exists over (is_system, system_role, tenant_id)', async () => {
    const def = await constraintDef();
    expect(def).toBeDefined();
    expect(def).toContain('is_system');
    expect(def).toContain('system_role');
    expect(def).toContain('tenant_id');
  });

  it('accepts valid system + tenant agents and REJECTS every mixed combination', async () => {
    const def = await constraintDef();
    const client = await pool.connect();
    try {
      await client.query('CREATE TEMP TABLE _agent_probe (tenant_id uuid, is_system boolean NOT NULL DEFAULT false, system_role text)');
      await client.query(`ALTER TABLE _agent_probe ADD CONSTRAINT _probe ${def}`);

      // Valid: system agent (no tenant, is_system, role set).
      await expect(client.query(`INSERT INTO _agent_probe (tenant_id, is_system, system_role) VALUES (NULL, true, 'caio')`)).resolves.toBeDefined();
      // Valid: tenant agent (tenant set, not system, no role).
      await expect(client.query(`INSERT INTO _agent_probe (tenant_id, is_system, system_role) VALUES (gen_random_uuid(), false, NULL)`)).resolves.toBeDefined();

      // INVALID: a system agent cannot carry a tenant_id.
      await expect(client.query(`INSERT INTO _agent_probe (tenant_id, is_system, system_role) VALUES (gen_random_uuid(), true, 'hrbp')`)).rejects.toThrow();
      // INVALID: a tenant agent cannot be is_system.
      await expect(client.query(`INSERT INTO _agent_probe (tenant_id, is_system, system_role) VALUES (gen_random_uuid(), true, NULL)`)).rejects.toThrow();
      // INVALID: a non-system agent must have a tenant_id.
      await expect(client.query(`INSERT INTO _agent_probe (tenant_id, is_system, system_role) VALUES (NULL, false, NULL)`)).rejects.toThrow();
      // INVALID: a system agent must declare a system_role.
      await expect(client.query(`INSERT INTO _agent_probe (tenant_id, is_system, system_role) VALUES (NULL, true, NULL)`)).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it('the system-agent config query returns ONLY is_system rows, with the narrow projection (cannot leak tenant-agent config)', async () => {
    const client = await pool.connect();
    try {
      await client.query(
        `CREATE TEMP TABLE _sysagent_probe (
           id uuid PRIMARY KEY, tenant_id uuid, is_system boolean NOT NULL,
           system_role text, system_prompt text, model_config jsonb, deleted_at timestamptz)`,
);
      const sysId = '00000000-0000-0000-0000-0000000000a1';
      const tenantAgentId = '00000000-0000-0000-0000-0000000000a2';
      await client.query(
        `INSERT INTO _sysagent_probe (id, tenant_id, is_system, system_role, system_prompt, model_config) VALUES ($1, NULL, true, 'caio', 'sys', '{}'::jsonb)`,
        [sysId],
);
      await client.query(
        `INSERT INTO _sysagent_probe (id, tenant_id, is_system, system_role) VALUES ($1, gen_random_uuid(), false, NULL)`,
        [tenantAgentId],
);

      // Mirror the systemAgentById endpoint query (internal-agents/router.ts).
      const q = (id: string) => client.query(
        `SELECT id, system_role, system_prompt, model_config FROM _sysagent_probe WHERE id = $1 AND is_system = TRUE AND deleted_at IS NULL`,
        [id],
);

      const sys = await q(sysId);
      expect(sys.rows).toHaveLength(1);
      // Narrow shape: exactly the 4 projected columns, no tenant_id / tenant data.
      expect(Object.keys(sys.rows[0]).sort()).toEqual(['id', 'model_config', 'system_prompt', 'system_role']);

      // A TENANT agent id returns nothing — the endpoint cannot return tenant-agent config.
      const tenantResult = await q(tenantAgentId);
      expect(tenantResult.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });
});
