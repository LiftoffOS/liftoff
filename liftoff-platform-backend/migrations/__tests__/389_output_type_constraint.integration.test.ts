// Migration 389 — the live CHECK constraint accepts every output type the API does.
//
// The unit test beside the router (src/generated-files/__tests__/
// output-type-constraint.test.ts) compares the zod enum to the constraint as
// WRITTEN in the migrations. This one compares it to the constraint as APPLIED,
// which is the other half of the same failure: migration 389 can be correct and
// still not be in the database in front of you.
//
// Every value is INSERTED rather than string-matched. The constraint is read
// back with pg_get_constraintdef and re-attached to a temporary table, so the
// rows go through the real expression, and nothing is written to
// generated_files — no tenant, no agent, no RLS scope, no cleanup.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     migrations/__tests__/389_output_type_constraint.integration.test.ts

import { Pool, PoolClient } from 'pg';
import { outputTypeSchema } from '../../src/generated-files/store';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('generated_files.output_type constraint (migration 389)', () => {
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

  it('exists on the table', async () => {
    const res = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'generated_files'::regclass
         AND conname = 'generated_files_output_type_check'`,
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].def).toMatch(/output_type/);
  });

  it('accepts a row for every member of outputTypeSchema', async () => {
    const res = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'generated_files'::regclass
         AND conname = 'generated_files_output_type_check'`,
    );
    const def = res.rows[0].def;

    await client.query('BEGIN');
    try {
      await client.query(
        'CREATE TEMP TABLE output_type_probe (output_type TEXT) ON COMMIT DROP',
      );
      await client.query(`ALTER TABLE output_type_probe ADD CONSTRAINT probe ${def}`);

      const rejected: Array<{ value: string; code: string }> = [];
      for (const value of outputTypeSchema.options) {
        try {
          await client.query('SAVEPOINT one_value');
          await client.query('INSERT INTO output_type_probe (output_type) VALUES ($1)', [value]);
          await client.query('RELEASE SAVEPOINT one_value');
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT one_value');
          rejected.push({ value, code: (err as { code?: string }).code ?? 'unknown' });
        }
      }
      // 23514 is check_violation — the exact error every browser PDF save and
      // every browser download returned for two months.
      expect(rejected).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
