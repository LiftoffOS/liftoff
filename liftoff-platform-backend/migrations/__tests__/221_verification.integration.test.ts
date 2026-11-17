// Migration 221 verification tests (integration; requires TEST_DATABASE_URL)
// Per implementation plan: user-initiated account deletion.
//
// Verifies that migration 221 creates the accounts_deletion_ledger table
// with its expected columns, default, and indexes. The table is read by the
// HMAC-protected /api/internal/accounts/check-deletion-history endpoint and
// written by AccountService.cascadeDelete (soft-scrub branch).
//
// Run after migrations complete:
//   npx jest --config jest.integration.config.js migrations/__tests__/221_verification.integration.test.ts

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('Migration 221 — accounts_deletion_ledger', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => { await pool.end(); });

  it('creates the accounts_deletion_ledger table', async () => {
    const r = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'accounts_deletion_ledger'`,
    );
    expect(r.rowCount).toBe(1);
  });

  it('has the expected columns', async () => {
    const r = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'accounts_deletion_ledger'
        ORDER BY ordinal_position`,
    );
    const names = r.rows.map((row) => row.column_name);
    expect(names).toEqual(expect.arrayContaining([
      'id', 'email_sha256', 'phone_sha256', 'stripe_customer_id', 'deleted_at',
    ]));
    const phone = r.rows.find((row) => row.column_name === 'phone_sha256');
    expect(phone?.is_nullable).toBe('YES');
    const email = r.rows.find((row) => row.column_name === 'email_sha256');
    expect(email?.is_nullable).toBe('NO');
  });

  it('creates the three indexes (email, phone-partial, customer)', async () => {
    const r = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'accounts_deletion_ledger'`,
    );
    const names = r.rows.map((row) => row.indexname);
    expect(names).toEqual(expect.arrayContaining([
      'idx_accounts_deletion_ledger_email',
      'idx_accounts_deletion_ledger_phone',
      'idx_accounts_deletion_ledger_customer',
    ]));
  });

  it('round-trips a row insert / select', async () => {
    const emailHash = 'a'.repeat(64);
    const customerId = `cus_test_${Date.now()}`;
    const ins = await pool.query<{ id: string; deleted_at: Date }>(
      `INSERT INTO accounts_deletion_ledger (email_sha256, stripe_customer_id)
       VALUES ($1, $2)
       RETURNING id, deleted_at`,
      [emailHash, customerId],
    );
    expect(ins.rows[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ins.rows[0].deleted_at).toBeInstanceOf(Date);

    const sel = await pool.query(
      `SELECT 1 FROM accounts_deletion_ledger WHERE email_sha256 = $1`,
      [emailHash],
    );
    expect(sel.rowCount).toBeGreaterThan(0);

    await pool.query(
      `DELETE FROM accounts_deletion_ledger WHERE stripe_customer_id = $1`,
      [customerId],
    );
  });
});
