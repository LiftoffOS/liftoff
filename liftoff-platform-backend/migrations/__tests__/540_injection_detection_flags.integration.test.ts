// Migration 540 — the two injection-detection flag rows exist after a
// from-scratch migrate, with the values that put every tenant in shadow.
//
// The database in front of this test has had every migration applied, so the
// first half reads the END STATE. The second half proves the row is what
// FeatureFlagService.isEnabled reads: the service returns false for a missing
// row, which is exactly why the detector was inert, and a row whose `enabled`
// is wrong would be inert or blocking rather than shadow.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     migrations/__tests__/540_injection_detection_flags.integration.test.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient, QueryResult } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const DETECTION = 'injection_detection';
const ENFORCE = 'injection_detection_enforce';

/** The migration without its own BEGIN / COMMIT, so it runs inside the test's
 *  transaction and is rolled back with it. */
const MIGRATION_BODY = readFileSync(join(__dirname, '..', '540_seed_injection_detection_flags.sql'), 'utf8')
  .split('\n')
  .filter((line) => !/^(BEGIN|COMMIT);\s*$/.test(line))
  .join('\n');

describeFn('migration 540: the injection-detection flags are seeded', () => {
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

  it('both rows exist, with the names, descriptions and polarity the rollout needs', async () => {
    const res = await client.query<{ key: string; name: string; description: string; enabled: boolean; tenant_overrides: Record<string, boolean> }>(
      `SELECT key, name, description, enabled, tenant_overrides FROM feature_flags
        WHERE key IN ($1, $2) ORDER BY key`,
      [DETECTION, ENFORCE],
    );
    expect(res.rows.map((r) => r.key)).toEqual([DETECTION, ENFORCE]);

    const detection = res.rows[0];
    expect(detection.name).toBe('Injection detection');
    expect(detection.description).toBe(
      'Runs the deterministic injection detector at every screened ingress. false = off everywhere (the state before this row existed).',
    );
    // true = every tenant in shadow. This is the whole change.
    expect(detection.enabled).toBe(true);
    expect(detection.tenant_overrides).toEqual({});

    const enforce = res.rows[1];
    expect(enforce.name).toBe('Injection detection enforcement');
    expect(enforce.description).toBe(
      'With injection_detection on, a block verdict refuses at the placements PLACEMENT_MAY_BLOCK allows (chat, persistence). Tool ingress and the runtime never refuse.',
    );
    // TRUE here, and 540 is not what makes it true — migration 543 is. This
    // assertion reads the END STATE of the whole chain, so it belongs to
    // whichever migration currently owns the value; the tests below pin what
    // 540's own body does, which is still to seed it false.
    expect(enforce.enabled).toBe(true);
    expect(enforce.tenant_overrides).toEqual({});
  });

  it('the rows are what isEnabled reads: no override, so the flag IS the global default', async () => {
    // FeatureFlagService.isEnabled: a tenant override wins, else flag.enabled.
    // Asserted as SQL rather than through the service so this test needs no
    // application wiring, and reads the same two columns the service does.
    const evaluated = await client.query<{ key: string; effective: boolean }>(
      `SELECT key,
              COALESCE((tenant_overrides ->> $1)::boolean, enabled) AS effective
         FROM feature_flags WHERE key IN ($2, $3) ORDER BY key`,
      ['11111111-1111-4111-8111-111111111111', DETECTION, ENFORCE],
    );
    // Both true after the chain: 540 seeds detection on, 543 turns enforcement
    // on. A tenant with no override gets the global default, which is now
    // "screen everything, and refuse a block at chat and persistence".
    expect(evaluated.rows).toEqual([
      { key: DETECTION, effective: true },
      { key: ENFORCE, effective: true },
    ]);
  });

  it('a second run changes nothing, and never overwrites an operator\'s flip', async () => {
    await client.query('BEGIN');
    try {
      // An operator has turned enforcement on globally. ON CONFLICT DO NOTHING
      // must leave that alone: a re-run of the chain is not a policy decision.
      await client.query(`UPDATE feature_flags SET enabled = true WHERE key = $1`, [ENFORCE]);

      // node-pg returns an ARRAY of results only for a multi-statement query;
      // this migration is one INSERT, so it comes back as a single result.
      // Migration 534's test reads `.filter` directly because its body carries
      // five UPDATEs — copying that shape here threw `rerun.filter is not a
      // function`, which the pre-push gate caught before this reached anyone.
      const rerun = await client.query(MIGRATION_BODY);
      const results = (Array.isArray(rerun) ? rerun : [rerun]) as unknown as QueryResult[];
      const inserts = results.filter((r) => r.command === 'INSERT');
      expect(inserts.length).toBe(1);
      // ON CONFLICT DO NOTHING matched both rows and wrote neither.
      expect(inserts[0].rowCount).toBe(0);

      const after = await client.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flags WHERE key = $1`,
        [ENFORCE],
      );
      expect(after.rows[0].enabled).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('inserts both rows into a table that has neither, from the migration body itself', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`DELETE FROM feature_flags WHERE key IN ($1, $2)`, [DETECTION, ENFORCE]);
      await client.query(MIGRATION_BODY);
      const res = await client.query<{ key: string; enabled: boolean }>(
        `SELECT key, enabled FROM feature_flags WHERE key IN ($1, $2) ORDER BY key`,
        [DETECTION, ENFORCE],
      );
      expect(res.rows).toEqual([
        { key: DETECTION, enabled: true },
        { key: ENFORCE, enabled: false },
      ]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
