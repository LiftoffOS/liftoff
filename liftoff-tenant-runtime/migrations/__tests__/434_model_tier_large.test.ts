// Migration 434 — a stored agent config naming the top tier 'flagship' names it
// 'large', and nothing else in the config moves.
//
// Executes the real statement against Postgres: a retired-name row is
// rewritten with its other keys intact, rows on other tiers and rows with no
// tier are untouched, and a re-run is a no-op.
//
// Skipped unless TEST_DATABASE_URL is set (the same guard every other migration
// test uses).

import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '..', '434_model_tier_large.sql'), 'utf8');

const TENANT = '00000000-0000-4000-8000-00000000c434';
const RETIRED = '00000000-0000-4000-8000-000000000434';
const MEDIUM = '00000000-0000-4000-8000-000000001434';
const NO_TIER = '00000000-0000-4000-8000-000000002434';

describeFn('migration 434 — the top tier is large', () => {
  let pool: Pool;

  const configOf = async (id: string) =>
    (await pool.query<{ model_config: Record<string, unknown> }>(
      'SELECT model_config FROM agents WHERE id = $1', [id],
    )).rows[0].model_config;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query('DELETE FROM agents WHERE tenant_id = $1', [TENANT]);
    const insert = (id: string, config: object) => pool.query(
      `INSERT INTO agents (id, tenant_id, name, model_config) VALUES ($1, $2, 'mig434', $3)`,
      [id, TENANT, JSON.stringify(config)],
    );
    await insert(RETIRED, { tier: 'flagship', provider: 'anthropic', maxTokens: 4096 });
    await insert(MEDIUM, { tier: 'medium', provider: 'openai' });
    await insert(NO_TIER, { modelId: 'claude-opus-5-5', provider: 'anthropic' });
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM agents WHERE tenant_id = $1', [TENANT]);
      await pool.end();
    }
  });

  it('renames the retired tier and keeps the rest of the config', async () => {
    await pool.query(MIGRATION);
    expect(await configOf(RETIRED)).toEqual({ tier: 'large', provider: 'anthropic', maxTokens: 4096 });
  });

  it('leaves other tiers and tierless configs alone', async () => {
    expect(await configOf(MEDIUM)).toEqual({ tier: 'medium', provider: 'openai' });
    expect(await configOf(NO_TIER)).toEqual({ modelId: 'claude-opus-5-5', provider: 'anthropic' });
  });

  it('is a no-op on re-run', async () => {
    const result = await pool.query(MIGRATION);
    expect(result.rowCount).toBe(0);
    expect(await configOf(RETIRED)).toEqual({ tier: 'large', provider: 'anthropic', maxTokens: 4096 });
  });
});
