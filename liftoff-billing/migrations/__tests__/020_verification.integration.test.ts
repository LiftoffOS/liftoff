// Migration 020 verification tests (integration; requires TEST_DATABASE_URL).
// Covers user-initiated account deletion / promo-abuse.
//
// Verifies that migration 020 creates payment_method_fingerprints_seen with
// the expected columns, CHECK constraint, primary key, and index. The table
// is written by the payment_method.attached webhook handler and by the
// soft-scrub endpoint, and read by the promo-eligibility helper.
//
// Run after migrations complete:
//   npx jest --config jest.integration.config.js migrations/__tests__/020_verification.integration.test.ts

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('Migration 020 — payment_method_fingerprints_seen', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => { await pool.end(); });

  it('creates the payment_method_fingerprints_seen table', async () => {
    const r = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'payment_method_fingerprints_seen'`,
    );
    expect(r.rowCount).toBe(1);
  });

  it('has the expected columns including customer_status CHECK', async () => {
    const r = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payment_method_fingerprints_seen'
        ORDER BY ordinal_position`,
    );
    const names = r.rows.map((row) => row.column_name);
    expect(names).toEqual(expect.arrayContaining([
      'fingerprint', 'stripe_customer_id', 'customer_status', 'first_seen_at', 'last_seen_at',
    ]));

    // CHECK constraint rejects unknown statuses.
    await expect(
      pool.query(
        `INSERT INTO payment_method_fingerprints_seen (fingerprint, stripe_customer_id, customer_status)
         VALUES ('fp_bad', 'cus_bad', 'orphan')`,
      ),
    ).rejects.toThrow();
  });

  it('enforces composite primary key (fingerprint, stripe_customer_id)', async () => {
    const fp = `fp_${Date.now()}`;
    const cus = `cus_${Date.now()}`;
    await pool.query(
      `INSERT INTO payment_method_fingerprints_seen (fingerprint, stripe_customer_id, customer_status)
       VALUES ($1, $2, 'active')`,
      [fp, cus],
    );
    await expect(
      pool.query(
        `INSERT INTO payment_method_fingerprints_seen (fingerprint, stripe_customer_id, customer_status)
         VALUES ($1, $2, 'active')`,
        [fp, cus],
      ),
    ).rejects.toThrow();
    await pool.query(
      `DELETE FROM payment_method_fingerprints_seen WHERE fingerprint = $1 AND stripe_customer_id = $2`,
      [fp, cus],
    );
  });

  it('creates the (fingerprint, customer_status) lookup index', async () => {
    const r = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'payment_method_fingerprints_seen'`,
    );
    expect(r.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(['idx_pm_fingerprints_status']),
    );
  });

  it('does NOT have row-level security enabled (internal table)', async () => {
    const r = await pool.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class
        WHERE relname = 'payment_method_fingerprints_seen'`,
    );
    expect(r.rows[0]?.relrowsecurity).toBe(false);
  });
});
