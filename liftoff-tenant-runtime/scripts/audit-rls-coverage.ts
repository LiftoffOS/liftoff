#!/usr/bin/env npx ts-node
/**
 * Effective row-level protection, per tenant-scoped table, against a REAL database.
 *
 * `src/__tests__/rls-coverage.test.ts` is the ratchet and reads migrations, which
 * is what lets it gate a pull request. It cannot answer the question that
 * decides whether a policy binds at all: OWNERSHIP.
 *
 * Postgres exempts a table's owner from its own policies unless the table is
 * FORCE. The runtime connects as `tenant_app`, and `tenant_app` owns many of
 * these tables — so on those, `ENABLE ROW LEVEL SECURITY` without FORCE is
 * decoration. On the tables owned by someone else, ENABLE alone does bind. The
 * same DDL therefore means two different things depending on who owns the
 * table, and only the catalog knows which.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx ts-node scripts/audit-rls-coverage.ts
 *   DATABASE_URL=... APP_ROLE=tenant_app npx ts-node scripts/audit-rls-coverage.ts
 *
 * Read-only. Exits 1 when any table is unprotected against APP_ROLE, so it can
 * be run as a periodic check rather than only by hand.
 */

import { Pool } from 'pg';

const APP_ROLE = process.env.APP_ROLE ?? 'tenant_app';

interface Row {
  table_name: string;
  owner: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policies: number;
}

/** Whether RLS actually constrains `APP_ROLE` on this table.
 *
 *  Owner + not forced is the case that reads as protected and is not: the DDL
 *  says ENABLE, the catalog says enabled, and the role the runtime connects as
 *  walks straight past it. A table with RLS enabled and no policy is also
 *  unprotected in the direction that matters here — it denies everything rather
 *  than scoping anything, which shows up as a broken query, not a leak. */
function binds(r: Row): boolean {
  if (!r.rls_enabled) return false;
  if (r.policies === 0) return false;
  if (r.owner === APP_ROLE && !r.rls_forced) return false;
  return true;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required.');
    process.exit(2);
  }
  const pool = new Pool({ connectionString });

  const { rows } = await pool.query<Row>(`
    SELECT c.relname                                   AS table_name,
           pg_get_userbyid(c.relowner)                 AS owner,
           c.relrowsecurity                            AS rls_enabled,
           c.relforcerowsecurity                       AS rls_forced,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r'
       AND EXISTS (
             SELECT 1 FROM information_schema.columns col
              WHERE col.table_schema = 'public'
                AND col.table_name = c.relname
                AND col.column_name = 'tenant_id')
     ORDER BY c.relname
  `);

  const unprotected = rows.filter((r) => !binds(r));

  console.log(`Tenant-scoped tables: ${rows.length}`);
  console.log(`Effectively protected against ${APP_ROLE}: ${rows.length - unprotected.length}`);
  console.log(`Unprotected: ${unprotected.length}\n`);

  if (unprotected.length > 0) {
    console.log('table                                    owner            rls  force  policies  why');
    for (const r of unprotected) {
      const why = !r.rls_enabled ? 'no RLS'
        : r.policies === 0 ? 'RLS on, no policy'
          : 'owner bypasses (needs FORCE)';
      console.log(
        `${r.table_name.padEnd(40)} ${r.owner.padEnd(16)} `
        + `${String(r.rls_enabled).padEnd(5)} ${String(r.rls_forced).padEnd(6)} `
        + `${String(r.policies).padEnd(9)} ${why}`,
      );
    }
  }

  await pool.end();
  process.exit(unprotected.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
