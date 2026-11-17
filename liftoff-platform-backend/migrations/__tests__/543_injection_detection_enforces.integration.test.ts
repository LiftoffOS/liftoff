// Migration 543 — the detector enforces.
//
// 540 put every tenant in shadow; this is the flip. What the test has to pin
// is not just "the row says true" but the three ways an UPDATE like this goes
// wrong: it touches a row it should not, it is not idempotent, or it silently
// does nothing because the row it names is absent.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     migrations/__tests__/543_injection_detection_enforces.integration.test.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient, QueryResult } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const DETECTION = 'injection_detection';
const ENFORCE = 'injection_detection_enforce';

/** The migration without its own BEGIN / COMMIT, so it runs inside the test's
 *  transaction and is rolled back with it. */
const MIGRATION_BODY = readFileSync(join(__dirname, '..', '543_injection_detection_enforces.sql'), 'utf8')
  .split('\n')
  .filter((line) => !/^(BEGIN|COMMIT);\s*$/.test(line))
  .join('\n');

/** node-pg returns an ARRAY of results only for a multi-statement body; this
 *  migration is one UPDATE, so it comes back as a single result. */
function results(r: unknown): QueryResult[] {
  return (Array.isArray(r) ? r : [r]) as QueryResult[];
}

describeFn('migration 543: the injection detector enforces', () => {
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

  it('the applied chain leaves enforcement ON, with no tenant override needed', async () => {
    const res = await client.query<{ enabled: boolean; tenant_overrides: Record<string, boolean> }>(
      `SELECT enabled, tenant_overrides FROM feature_flags WHERE key = $1`,
      [ENFORCE],
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].enabled).toBe(true);
    expect(res.rows[0].tenant_overrides).toEqual({});
  });

  it('enforcement is meaningless without detection, so detection is still on too', async () => {
    // `resolveInjectionMode` reads detection FIRST and returns 'off' when it is
    // false — an enforce flag on top of a detection flag off is not "enforce",
    // it is nothing at all.
    const res = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flags WHERE key = $1`,
      [DETECTION],
    );
    expect(res.rows[0].enabled).toBe(true);
  });

  it('flips the row from false, and a second run changes nothing', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE feature_flags SET enabled = false WHERE key = $1`, [ENFORCE]);

      const first = results(await client.query(MIGRATION_BODY));
      expect(first.filter((r) => r.command === 'UPDATE').map((r) => r.rowCount)).toEqual([1]);
      const after = await client.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flags WHERE key = $1`, [ENFORCE],
      );
      expect(after.rows[0].enabled).toBe(true);

      // Idempotent: the `IS DISTINCT FROM true` guard means a re-run matches no
      // row at all, rather than rewriting the same value and bumping updated_at
      // on every deploy.
      const second = results(await client.query(MIGRATION_BODY));
      expect(second.filter((r) => r.command === 'UPDATE').map((r) => r.rowCount)).toEqual([0]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('touches only its own row, and never the detection flag beside it', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE feature_flags SET enabled = false WHERE key IN ($1, $2)`, [DETECTION, ENFORCE]);
      await client.query(MIGRATION_BODY);
      const rows = await client.query<{ key: string; enabled: boolean }>(
        `SELECT key, enabled FROM feature_flags WHERE key IN ($1, $2) ORDER BY key`,
        [DETECTION, ENFORCE],
      );
      // detection is left exactly as it was found: this migration has one job.
      expect(rows.rows).toEqual([
        { key: DETECTION, enabled: false },
        { key: ENFORCE, enabled: true },
      ]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('writes nothing when the row is absent, rather than creating one 540 never wrote', async () => {
    // An UPDATE that silently matches nothing is the failure mode this guards:
    // if 540 were ever reverted, this must not conjure an enforcing flag out of
    // an environment that has no detector rows at all.
    await client.query('BEGIN');
    try {
      await client.query(`DELETE FROM feature_flags WHERE key = $1`, [ENFORCE]);
      const r = results(await client.query(MIGRATION_BODY));
      expect(r.filter((x) => x.command === 'UPDATE').map((x) => x.rowCount)).toEqual([0]);
      const gone = await client.query(`SELECT 1 FROM feature_flags WHERE key = $1`, [ENFORCE]);
      expect(gone.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
