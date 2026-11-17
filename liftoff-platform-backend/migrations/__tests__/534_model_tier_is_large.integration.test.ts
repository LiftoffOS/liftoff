// Migration 534 — the top routing tier is 'large' again (reversing 196).
//
// Two halves. The database in front of the test has had every migration
// applied, so the first half asserts the END STATE: the CHECK, the registry
// rows, and the models the tier readers resolve. The second half proves the
// REWRITE: stored rows holding the old name are seeded inside a transaction,
// the migration's own body is run over them (twice, for idempotency), and the
// transaction is rolled back, so nothing is left behind.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     migrations/__tests__/534_model_tier_is_large.integration.test.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient, QueryResult } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const OLD = 'flagship';

/** The migration without its own BEGIN / COMMIT, so it runs inside the test's
 *  transaction and is rolled back with it. */
const MIGRATION_BODY = readFileSync(join(__dirname, '..', '534_model_tier_is_large_again.sql'), 'utf8')
  .split('\n')
  .filter((line) => !/^(BEGIN|COMMIT);\s*$/.test(line))
  .join('\n');

describeFn('migration 534: the top tier is large again', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it('the applied CHECK accepts large / medium / small / NULL, and refuses the old name and Frontier', async () => {
    const res = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'models'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%tier%'`,
    );
    expect(res.rowCount).toBe(1);

    await client.query('BEGIN');
    try {
      await client.query('CREATE TEMP TABLE tier_probe (tier TEXT) ON COMMIT DROP');
      await client.query(`ALTER TABLE tier_probe ADD CONSTRAINT probe ${res.rows[0].def}`);
      const accepted: Array<string | null> = [];
      for (const tier of ['large', 'medium', 'small', null, OLD, 'frontier']) {
        await client.query('SAVEPOINT one');
        try {
          await client.query('INSERT INTO tier_probe (tier) VALUES ($1)', [tier]);
          await client.query('RELEASE SAVEPOINT one');
          accepted.push(tier);
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT one');
        }
      }
      expect(accepted).toEqual(['large', 'medium', 'small', null]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('no registry row keeps the old name; large still resolves to Opus 5.5, and Fable keeps its NULL tier', async () => {
    const old = await client.query(`SELECT 1 FROM models WHERE tier = $1`, [OLD]);
    expect(old.rowCount).toBe(0);

    // Exactly the tier readers' query (registry-tier-loader / workspace-ai-vendor-loader).
    const resolved = await client.query<{ model_id: string }>(
      `SELECT DISTINCT ON (provider, tier) model_id FROM models
        WHERE status = 'approved' AND tier IS NOT NULL AND provider = 'anthropic' AND tier = 'large'
        ORDER BY provider, tier, created_at DESC`,
    );
    expect(resolved.rows.map((r) => r.model_id)).toEqual(['claude-opus-5-5']);

    const fable = await client.query<{ tier: string | null }>(
      `SELECT tier FROM models WHERE model_id = 'claude-fable-5-1'`,
    );
    expect(fable.rows).toEqual([{ tier: null }]);
  });

  it('rewrites every stored tier at its key only, and a second run changes nothing', async () => {
    await client.query('BEGIN');
    try {
      // The old CHECK refuses nothing we need: drop it, the migration re-adds.
      await client.query(`ALTER TABLE models DROP CONSTRAINT models_tier_check`);
      const model = await client.query<{ id: string }>(
        `INSERT INTO models (name, provider, model_id, tier, status, capabilities)
         VALUES ('Probe 534', 'probe-534', 'probe-534-model', $1, 'approved', '[]'::jsonb) RETURNING id`,
        [OLD],
      );
      const account = await client.query<{ id: string }>(
        `INSERT INTO accounts (email, first_name, last_name) VALUES ('probe-534@example.com', 'P', 'Q') RETURNING id`,
      );
      const tenant = await client.query<{ id: string }>(
        `INSERT INTO tenants (account_id, name) VALUES ($1, 'Probe 534') RETURNING id`,
        [account.rows[0].id],
      );
      const tenantId = tenant.rows[0].id;

      await client.query(
        `INSERT INTO model_configs (tenant_id, model_id, routing_policy) VALUES ($1, $2, $3)`,
        [tenantId, model.rows[0].id, JSON.stringify({
          defaultTier: OLD,
          defaultModel: 'claude-sonnet-5',
          taskTierOverrides: { planning: OLD, retrieval_hyde: 'small' },
          // A model id that happens to be the word. Not a tier key: untouched.
          taskOverrides: { planning: OLD },
        })],
      );
      const agent = await client.query<{ id: string }>(
        `INSERT INTO internal_agents (tenant_id, role, model_config, system_prompt)
         VALUES ($1, 'Probe', $2, $3) RETURNING id`,
        [tenantId, JSON.stringify({ tier: OLD, modelId: 'ft:acme' }), `Our ${OLD} product.`],
      );
      const untouched = await client.query<{ id: string }>(
        `INSERT INTO internal_agents (tenant_id, role, model_config) VALUES ($1, 'Medium', '{"tier":"medium"}') RETURNING id`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO internal_agent_versions (internal_agent_id, version, role, source, model_config)
         VALUES ($1, 1, 'Probe', 'create', $2)`,
        [agent.rows[0].id, JSON.stringify({ tier: OLD })],
      );

      await client.query(MIGRATION_BODY);

      const m = await client.query(`SELECT tier FROM models WHERE id = $1`, [model.rows[0].id]);
      expect(m.rows[0].tier).toBe('large');

      const mc = await client.query(`SELECT routing_policy FROM model_configs WHERE tenant_id = $1`, [tenantId]);
      expect(mc.rows[0].routing_policy).toEqual({
        defaultTier: 'large',
        defaultModel: 'claude-sonnet-5',
        taskTierOverrides: { planning: 'large', retrieval_hyde: 'small' },
        taskOverrides: { planning: OLD },
      });

      const ia = await client.query(
        `SELECT id, model_config, system_prompt FROM internal_agents WHERE tenant_id = $1 ORDER BY role`,
        [tenantId],
      );
      const byId = new Map(ia.rows.map((r) => [r.id, r]));
      expect(byId.get(agent.rows[0].id)?.model_config).toEqual({ tier: 'large', modelId: 'ft:acme' });
      expect(byId.get(agent.rows[0].id)?.system_prompt).toBe(`Our ${OLD} product.`);
      expect(byId.get(untouched.rows[0].id)?.model_config).toEqual({ tier: 'medium' });

      const v = await client.query(`SELECT model_config FROM internal_agent_versions WHERE internal_agent_id = $1`, [
        agent.rows[0].id,
      ]);
      expect(v.rows[0].model_config).toEqual({ tier: 'large' });

      // Idempotent: a re-run matches no row. A multi-statement query returns
      // one result per statement; every UPDATE must report zero rows.
      const rerun = (await client.query(MIGRATION_BODY)) as unknown as QueryResult[];
      const updates = rerun.filter((r) => r.command === 'UPDATE');
      expect(updates.length).toBe(5);
      expect(updates.map((r) => r.rowCount)).toEqual([0, 0, 0, 0, 0]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
