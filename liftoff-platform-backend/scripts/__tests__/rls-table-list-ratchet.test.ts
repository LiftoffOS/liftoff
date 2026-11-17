// Keeps eslint-rules/rls-tables.json from rotting (INV-PB-001).
//
// The list is generated from the database, which CI cannot reach. Without a
// guard it would drift the moment somebody adds a tenant table: the new table
// gets RLS from migration 200's DO-loop, the lint rule has never heard of it,
// and raw pool.query against it sails through review — which is exactly the
// failure that put /api/internal/account-profiles into a prod 500 loop.
//
// So this test re-derives the candidate set from migrations/*.sql, with no
// database, and fails when a migration introduces a tenant_id table the list
// does not account for. The parse is NOT accurate enough to BE the list (see
// scripts/generate-rls-tables.ts for why), but it is more than accurate enough
// to answer "did something new appear that nobody classified?", because
// CREATE TABLE ... tenant_id is the one shape it reads reliably.
//
// When this fails you have two honest options:
//   - the new table is RLS (the default): run `npm run rls:tables` against a
//     migrated database and commit the regenerated file.
//   - it is deliberately NOT RLS: add it to `tenantIdColumnButNotRls` with a
//     comment saying why, the same way migration 200's exclusion list does.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const LIST = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'eslint-rules', 'rls-tables.json'), 'utf8'),
) as { tables: string[]; tenantIdColumnButNotRls: string[] };

/** Excluded by migrations 095 / 200 / 286 as platform-global. */
const PLATFORM_GLOBAL = new Set([
  'accounts', 'plans', 'subscriptions', 'staff_roles', 'tenants',
  'invite_requests', 'feature_flags', 'passkeys',
  'schema_migrations', 'migration_jobs', 'migration_history',
  'distillation_cache', 'tool_classification_cache',
]);

const PARTITION_CHILD = /_(y\d{4}m\d{2}|\d{4}_\d{2}|default)$/;

/** Tables that migrations create with a tenant_id column. */
function tablesWithTenantIdFromMigrations(): Set<string> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const withTenantId = new Set<string>();
  const dropped = new Set<string>();
  const renames: Array<[string, string]> = [];

  for (const file of files) {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // Strip line comments so commented-out DDL never registers.
    const sql = raw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(sql)) !== null) {
      // Scan to the matching close paren so we only read this table's body.
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') depth--;
        i++;
      }
      const body = sql.slice(m.index + m[0].length, i - 1);
      if (/(^|[\s,(])tenant_id\s+/i.test(body)) withTenantId.add(m[1].toLowerCase());
    }

    const addColRe =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?tenant_id"?/gi;
    while ((m = addColRe.exec(sql)) !== null) withTenantId.add(m[1].toLowerCase());

    const dropColRe =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?tenant_id"?/gi;
    while ((m = dropColRe.exec(sql)) !== null) withTenantId.delete(m[1].toLowerCase());

    const dropRe = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi;
    while ((m = dropRe.exec(sql)) !== null) dropped.add(m[1].toLowerCase());

    const renameRe =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s+RENAME\s+TO\s+"?([a-z0-9_]+)"?/gi;
    while ((m = renameRe.exec(sql)) !== null) renames.push([m[1].toLowerCase(), m[2].toLowerCase()]);
  }

  for (const [from, to] of renames) {
    if (withTenantId.delete(from)) withTenantId.add(to);
    dropped.delete(from);
  }
  for (const d of dropped) withTenantId.delete(d);
  for (const g of PLATFORM_GLOBAL) withTenantId.delete(g);
  for (const t of [...withTenantId]) if (PARTITION_CHILD.test(t)) withTenantId.delete(t);

  return withTenantId;
}

describe('rls-tables.json stays in step with the migrations', () => {
  const derived = tablesWithTenantIdFromMigrations();
  const listed = new Set(LIST.tables);
  const knownNonRls = new Set(LIST.tenantIdColumnButNotRls);

  it('classifies every tenant_id table a migration creates', () => {
    const unclassified = [...derived]
      .filter((t) => !listed.has(t) && !knownNonRls.has(t))
      .sort();

    expect({
      unclassified,
      hint:
        unclassified.length === 0
          ? 'ok'
          : 'A migration added these tables with a tenant_id column and nothing has classified them. ' +
            'If they are RLS (the default), run `DATABASE_URL=<migrated-db> npm run rls:tables` and commit ' +
            'the result. If they are deliberately NOT RLS, add them to tenantIdColumnButNotRls in ' +
            'eslint-rules/rls-tables.json with a reason.',
    }).toEqual({ unclassified: [], hint: 'ok' });
  });

  it('does not carry exceptions for tables that no longer exist', () => {
    // A stale exception is a table that can never be re-flagged. Cheap to catch.
    const stale = [...knownNonRls].filter((t) => !derived.has(t)).sort();
    expect(stale).toEqual([]);
  });

  it('never lists a table as both RLS and deliberately-not-RLS', () => {
    const both = [...listed].filter((t) => knownNonRls.has(t)).sort();
    expect(both).toEqual([]);
  });

  it('has a non-trivial list, so a truncated file cannot pass silently', () => {
    expect(LIST.tables.length).toBeGreaterThan(80);
  });

  // A regeneration run against a database, with a relkind='r' filter, drops
  // partitioned parents without a word — which is how these went missing the
  // first time. They are the tables every cost and metering query names, so
  // losing them silently un-guards that whole surface. Pinned by name because
  // this file cannot see pg_class.
  //
  // tenant_resource_usage was pinned here too until migration 340 retired it.
  // Its pin outlived it: the drop landed without regenerating rls-tables.json,
  // so the stale entry kept this green and the pin only failed once the file
  // was regenerated against a real database. Removed rather than kept, because
  // a pin on a table that no longer exists guards nothing and hides the next
  // regeneration.
  it.each(['cost_attribution_events'])(
    'still lists the partitioned parent %s',
    (parent) => {
      expect(LIST.tables).toContain(parent);
    },
  );
});
