// Regenerates eslint-rules/rls-tables.json, the table list r5/no-raw-pool-on-rls-table
// checks against (INV-PB-001).
//
// Usage:
//   DATABASE_URL=<url-to-a-migrated-db> npm run rls:tables
//
// The database is the source of truth, not the migrations. That is a deliberate
// choice, made after trying the other way: parsing migrations/*.sql for tables
// with a tenant_id column diverges from `pg_class.relrowsecurity` in BOTH
// directions -- it misses the partition children entirely, and it over-reports
// 16 tables that carry a tenant_id but were never RLS-enabled. A lint rule fed
// by that parse would both miss real violations and invent false ones.
//
// Partition children are dropped on purpose. They are RLS-enabled, but they are
// created on a rolling monthly cadence, so listing them would guarantee this
// file goes stale. Code names the parent; nothing queries a child directly.
//
// The 'tenantIdColumnButNotRls' list is carried forward untouched -- it is
// consumed by scripts/__tests__/rls-table-list-ratchet.test.ts, which needs to
// know which tenant_id tables are non-RLS on purpose so it does not cry wolf.

import { Pool } from 'pg';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const OUTPUT = join(__dirname, '..', 'eslint-rules', 'rls-tables.json');
const PARTITION_CHILD = /_(y\d{4}m\d{2}|\d{4}_\d{2}|default)$/;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required. Point it at a fully migrated database.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  try {
    const { rows } = await pool.query<{ relname: string; relforcerowsecurity: boolean }>(
      // relkind IN ('r','p') — 'p' is a partitioned PARENT, and filtering to 'r'
      // alone silently drops them. That is not academic: it is how
      // cost_attribution_events and tenant_resource_usage were missing from the
      // first version of this list, which are precisely the names code writes
      // (nothing queries a partition child directly). Postgres applies the
      // child's policy to a query against the parent, so an unscoped read of the
      // parent throws just the same.
      // relforcerowsecurity is carried alongside because FORCE is a strictly
      // stronger condition than RLS and the two fences need different sets. A
      // migration runs as the table owner, and an owner is exempt from RLS
      // UNLESS the table is FORCEd -- so only the FORCE subset must drop the
      // fence before writing. See scripts/ci-fences/migration-force-rls-fence.sh.
      `SELECT c.relname, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relrowsecurity
        ORDER BY c.relname`,
    );

    const all = rows.map((r) => r.relname);
    const tables = all.filter((t) => !PARTITION_CHILD.test(t));
    const skipped = all.filter((t) => PARTITION_CHILD.test(t));
    const forceTables = rows
      .filter((r) => r.relforcerowsecurity)
      .map((r) => r.relname)
      .filter((t) => !PARTITION_CHILD.test(t));

    const existing = JSON.parse(readFileSync(OUTPUT, 'utf8')) as {
      _comment: string[];
      generatedFrom: string;
      tables: string[];
      forceTables?: string[];
      tenantIdColumnButNotRls: string[];
    };

    const added = tables.filter((t) => !existing.tables.includes(t));
    const removed = existing.tables.filter((t) => !tables.includes(t));

    writeFileSync(
      OUTPUT,
      JSON.stringify(
        { ...existing, tables, forceTables, tenantIdColumnButNotRls: existing.tenantIdColumnButNotRls },
        null,
        2,
      ) + '\n',
    );

    console.log(`${tables.length} RLS tables written (${skipped.length} partition children skipped)`);
    console.log(`${forceTables.length} of them carry FORCE row-level security`);
    if (added.length) console.log(`  added:   ${added.join(', ')}`);
    if (removed.length) console.log(`  removed: ${removed.join(', ')}`);
    if (!added.length && !removed.length) console.log('  no change');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
