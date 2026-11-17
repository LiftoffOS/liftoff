// Migrations 321 (invocations.execution_engine) + 322 (agent_trajectories:
// execution_engine + nested_engine). Validates the columns and the bounded
// CHECK constraints exist with the exact allowed engine sets. Skipped unless
// TEST_DATABASE_URL is set (i.e. the migrations have been applied to the test DB
// — the same guard every other migration test uses). Locally validated against a
// scratch Postgres during implementation; this keeps it enforced in CI.

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('engine-provenance migrations (321, 322)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('321 — invocations.execution_engine is a nullable TEXT column', async () => {
    const col = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'invocations' AND column_name = 'execution_engine'`,
);
    expect(col.rows[0]?.data_type).toBe('text');
    expect(col.rows[0]?.is_nullable).toBe('YES');
  });

  it('321 — chk_invocations_execution_engine bounds the value set (incl. unknown-legacy, allows NULL)', async () => {
    const chk = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_invocations_execution_engine'`,
);
    const def = chk.rows[0]?.def as string | undefined;
    expect(def).toBeDefined();
    for (const e of ['claude-agent-sdk', 'openai-agents', 'openai-codex', 'google-genai', 'google-adk', 'openrouter-openai-wire', 'opencode', 'unknown-legacy']) {
      expect(def).toContain(e);
    }
    expect(def).toMatch(/execution_engine IS NULL/);
  });

  it('322 — agent_trajectories carries execution_engine + nested_engine columns', async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_trajectories' AND column_name IN ('execution_engine', 'nested_engine')`,
);
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(['execution_engine', 'nested_engine']);
  });

  it('322 — nested_engine CHECK bounds the specialist set (all 4 runners)', async () => {
    const chk = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_agent_trajectories_nested_engine'`,
);
    const def = chk.rows[0]?.def as string | undefined;
    expect(def).toBeDefined();
    for (const e of ['claude-code-session', 'codex-code-session', 'gemini-code-session', 'opencode-code-session']) {
      expect(def).toContain(e);
    }
  });

  it('321 — the CHECK actually rejects an unrecognized engine (behavioral)', async () => {
    // Exercise the exact predicate on a scratch table so we do not have to
    // satisfy every invocations NOT NULL column; the constraint text is copied
    // from the live constraint so the predicate under test is identical. A single
    // dedicated client is used because a TEMP table is connection-scoped and the
    // pool would otherwise run follow-up statements on a different connection.
    const def = (await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_invocations_execution_engine'`,
)).rows[0].def as string;
    const client = await pool.connect();
    try {
      await client.query('CREATE TEMP TABLE _engine_probe (execution_engine TEXT)');
      await client.query(`ALTER TABLE _engine_probe ADD CONSTRAINT _probe_chk ${def}`);
      await expect(client.query(`INSERT INTO _engine_probe VALUES ('bogus-engine')`)).rejects.toThrow();
      await expect(client.query(`INSERT INTO _engine_probe VALUES ('openai-codex')`)).resolves.toBeDefined();
      await expect(client.query(`INSERT INTO _engine_probe VALUES (NULL)`)).resolves.toBeDefined();
    } finally {
      client.release();
    }
  });
});
