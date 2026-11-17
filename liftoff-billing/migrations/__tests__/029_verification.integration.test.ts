// Migration 029 verification tests (integration; requires TEST_DATABASE_URL).
//
// The background-read lanes on subscriptions and payment_methods must survive a
// RECYCLED connection, not merely a fresh one. Releasing a tenant scope RESETs
// the GUC, and PostgreSQL leaves a custom GUC as the EMPTY STRING rather than
// NULL, so from the first tenant-scoped request onward every pooled connection
// carries ''. A policy that tests `IS NULL` closes the lane at that point, and
// the tenant policy beside it then tries to cast '' to uuid and raises 22P02.
//
// That is not hypothetical: it is how subscription-reconciliation and
// card-expiring-reminders behave on any connection the pool has reused, and both
// read `deps.pool` directly with no tenant bound.
//
// Run after migrations complete:
//   npx jest --config jest.integration.config.js migrations/__tests__/029_verification.integration.test.ts

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const GUC = 'app.current_tenant_id';
const TABLES = ['subscriptions', 'payment_methods'] as const;

describeFn('Migration 029 — background SELECT survives a recycled connection', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each(TABLES)('%s keeps both SELECT policies', async (table) => {
    const r = await pool.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE tablename = $1 AND cmd = 'SELECT'
        ORDER BY policyname`,
      [table],
    );
    expect(r.rows.map((x) => x.policyname)).toEqual([
      `${table}_background_select`,
      `${table}_tenant_select`,
    ]);
  });

  // The property the migration exists for. `IS NULL` would fail this.
  it.each(TABLES)(
    '%s treats an EMPTY tenant id as unbound, not as a uuid to cast',
    async (table) => {
      const r = await pool.query<{ qual: string }>(
        `SELECT qual FROM pg_policies WHERE tablename = $1 AND policyname = $2`,
        [table, `${table}_background_select`],
      );
      expect(r.rows[0]?.qual).toContain('COALESCE');
      // An IS NULL test is exactly what this migration replaces.
      expect(r.rows[0]?.qual).not.toMatch(/IS NULL/i);
    },
  );

  // CASE is load-bearing: PostgreSQL does not guarantee evaluation order in a
  // USING clause, so an AND-guard can still reach the cast. Migration 011 tried
  // the guard and migration 012 had to replace it for exactly this reason.
  it.each(TABLES)('%s guards the uuid cast with CASE, not an AND', async (table) => {
    const r = await pool.query<{ qual: string }>(
      `SELECT qual FROM pg_policies WHERE tablename = $1 AND policyname = $2`,
      [table, `${table}_tenant_select`],
    );
    expect(r.rows[0]?.qual).toContain('CASE');
  });

  // Writes are deliberately untouched: an unscoped write should keep failing
  // loudly rather than being quietly denied.
  it.each(TABLES)('%s still refuses an unscoped INSERT at the policy level', async (table) => {
    const r = await pool.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE tablename = $1 AND cmd = 'INSERT'`,
      [table],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].policyname).toBe(`${table}_tenant_write`);
  });

  // The five tables still on migration 002's strict policy must stay strict.
  // Opening a lane nothing needs would let any connection that forgot to scope
  // itself read every tenant's invoices.
  it.each(['invoices', 'meter_events', 'credit_balances', 'billing_audit_log'])(
    '%s has no background read lane',
    async (table) => {
      const r = await pool.query(
        `SELECT policyname FROM pg_policies
          WHERE tablename = $1 AND policyname LIKE '%_background_%'`,
        [table],
      );
      expect(r.rowCount).toBe(0);
    },
  );
});
