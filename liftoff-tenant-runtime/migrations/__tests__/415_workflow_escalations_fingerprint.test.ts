// Migration 415 — workflow_escalations gets reason_fingerprint + instruction_version.
//
// The columns let createEscalation narrow its dedupe from "the newest open row
// for this agent and kind" to "the same failure class on the same graph
// version" (engine/escalation-helper.ts). The helper's own semantics are
// covered in engine/__tests__/escalation-helper.test.ts against an in-memory
// table; this file executes the real statements against a real Postgres and
// pins the two things a unit test cannot: that the columns and the index exist
// with the declared types, and that the migration is idempotent, because it
// is written with IF NOT EXISTS throughout and a re-run must be a no-op.
//
// Skipped unless TEST_DATABASE_URL is set (the same guard every other migration
// test uses). The migration is applied by the harness before this runs.

import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', '415_workflow_escalations_fingerprint.sql'),
  'utf8',
);

describeFn('migration 415 — escalation fingerprint columns', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('adds reason_fingerprint (text, nullable) and instruction_version (integer, nullable)', async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'workflow_escalations'
          AND column_name IN ('reason_fingerprint', 'instruction_version')
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'instruction_version', data_type: 'integer', is_nullable: 'YES' },
      { column_name: 'reason_fingerprint', data_type: 'text', is_nullable: 'YES' },
    ]);
  });

  it('adds the dedupe index over (tenant, agent, kind, status, fingerprint, version)', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'workflow_escalations' AND indexname = 'workflow_escalations_fingerprint_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('(tenant_id, agent_id, kind, status, reason_fingerprint, instruction_version)');
  });

  it('is idempotent: re-running the migration is a no-op', async () => {
    await expect(pool.query(MIGRATION)).resolves.toBeDefined();
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_indexes
        WHERE tablename = 'workflow_escalations' AND indexname = 'workflow_escalations_fingerprint_idx'`,
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('IS NOT DISTINCT FROM matches NULL with NULL and nothing else', async () => {
    // The comparison the helper's dedupe relies on, stated against the engine
    // rather than assumed: a caller that supplies no fingerprint must merge
    // only with rows that supply none.
    const { rows } = await pool.query<{ a: boolean; b: boolean; c: boolean }>(
      `SELECT (NULL::text IS NOT DISTINCT FROM NULL::text) AS a,
              ('x'::text IS NOT DISTINCT FROM NULL::text) AS b,
              (NULL::integer IS NOT DISTINCT FROM 0) AS c`,
    );
    expect(rows[0]).toEqual({ a: true, b: false, c: false });
  });
});
