// Every table this service soft-deletes must be purged by something.
//
// The purge pass names its tables explicitly, because a blind sweep of every
// table with a deleted_at column cannot know that an account also has state
// in Stripe and Firebase, or that a conversation has to be deleted by thread
// so it goes whole. The price of an explicit list is that it rots the moment
// somebody soft-deletes a new table, and the rot is invisible: the new table
// keeps working, the rows disappear from every read, and they are simply
// never removed. Nothing fails. That is this repo's dominant defect class -
// wired at one end - applied to a privacy promise.
//
// So this test reads the soft-delete sites out of the source and fails when
// one names a table that nothing purges. It is a coverage check, not a
// behaviour test: it asserts the LIST is complete, which is the part no
// runtime test can see.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { PURGE_TABLES } from '../purge-soft-deleted';

const SRC = join(__dirname, '..', '..');

/**
 * Tables purged by a path of their own rather than the generic sweep.
 * Each one is purged - this is not an exemption list.
 */
const PURGED_SEPARATELY = new Set([
  // Purged as a unit by purgeSoftDeleted: its conversations are deleted by
  // thread first, then the row, so the cascades take the versions and the
  // rest with it.
  'internal_agents',
  // Handed to AccountService.cascadeDelete, which also revokes OAuth grants,
  // deletes the sign-in identity and scrubs the billing customer.
  'accounts',
]);

/**
 * Tables already hard-deleted by a sweep of their own, on a SHORTER clock than
 * the purge. Listing them here rather than in PURGE_TABLES keeps the stricter
 * schedule as the one that governs: adding them to the purge would not make
 * them go sooner, and would imply the 30-day window applies to credentials.
 */
const PURGED_BY_A_STRICTER_SWEEP: Record<string, string> = {
  // maintenanceRouter POST /prune-byok-gateway, in
  // src/maintenance/expire-agent-messages.ts: deleted once expired an hour or
  // revoked seven days. The replay detection that reads a dead token row is
  // bounded by that same window by design.
  oauth_access_tokens: 'swept at expiry + 1h / revocation + 7d',
  oauth_refresh_tokens: 'swept at expiry + 1h / revocation + 7d',
};

/**
 * Soft-delete writes that are NOT a deletion of the row's own subject, with
 * the reason each is out of scope. Keep this small and keep the reasons
 * concrete: a wrong entry here is a table that silently never gets purged.
 */
const NOT_A_SUBJECT_DELETION: Record<string, string> = {
  // A membership being revoked, not a person being deleted. The row is the
  // link between a person and an agent; it is purged by the generic sweep
  // under its own entry in PURGE_TABLES, and these call sites are the
  // ordinary "unassign" path rather than a deletion request.
  person_agent_assignments: 'listed in PURGE_TABLES; these sites are unassignment',
};

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
      tsFiles(p, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Find `UPDATE <table> … SET … deleted_at = NOW()`.
 *
 * Matched across newlines because the statements in this repo wrap, and the
 * UPDATE is routinely on a different line from its SET. A `${…}` table name
 * is a dynamic statement and is handled separately below.
 */
function softDeletedTables(source: string): string[] {
  const found: string[] = [];
  const re = /UPDATE\s+([A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\})[\s\S]{0,200}?SET[\s\S]{0,200}?deleted_at\s*=\s*NOW\(\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) found.push(m[1]);
  return found;
}

describe('every soft-deleted table is purged by something', () => {
  const files = tsFiles(SRC);
  const listed = new Set(PURGE_TABLES.map((t) => t.table));

  it('finds soft-delete sites at all, so this cannot pass vacuously', () => {
    const hits = files.flatMap((f) => softDeletedTables(readFileSync(f, 'utf8')));
    expect(hits.length).toBeGreaterThan(5);
    expect(PURGE_TABLES.length).toBeGreaterThan(5);
  });

  it('purges every table a static soft-delete names', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const table of softDeletedTables(readFileSync(file, 'utf8'))) {
        if (table.startsWith('${')) continue;  // dynamic: covered below
        if (listed.has(table)) continue;
        if (PURGED_SEPARATELY.has(table)) continue;
        if (table in PURGED_BY_A_STRICTER_SWEEP) continue;
        if (table in NOT_A_SUBJECT_DELETION) continue;
        offenders.push(`${file.replace(SRC, 'src')} soft-deletes "${table}"`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} soft-delete site(s) name a table nothing purges:\n\n`
        + offenders.map((o) => `  ${o}`).join('\n')
        + '\n\nA soft-deleted table nothing purges keeps its rows for ever while the\n'
        + 'product reports them deleted. Fix it one of these ways:\n'
        + '  1. Add the table to PURGE_TABLES in src/maintenance/purge-soft-deleted.ts.\n'
        + '     This is almost always the answer.\n'
        + '  2. Give it a purge path of its own, if a plain DELETE is not enough —\n'
        + '     state outside this database, or rows that must be deleted as a unit.\n'
        + '     Then add it to PURGED_SEPARATELY here.\n'
        + '  3. Add it to NOT_A_SUBJECT_DELETION, WITH a reason, if the write is not\n'
        + '     deleting the row\'s own subject. Rare, and a reviewer should ask.\n',
      );
    }
  });

  it('purges every table the data-management erasure path can target', () => {
    // That service soft-deletes through `UPDATE ${tableName}` with the table
    // chosen from ENTITY_TABLE_MAP, so the regex above sees a placeholder and
    // the real names are only in the map.
    const svc = readFileSync(join(SRC, 'data-management', 'deletion-service.ts'), 'utf8');
    const block = svc.slice(svc.indexOf('const ENTITY_TABLE_MAP'));
    const mapped = [...block.slice(0, block.indexOf('};')).matchAll(/:\s*'([a-z_]+)'/g)]
      .map((m) => m[1]);

    expect(mapped.length).toBeGreaterThan(5);
    // `tenant` is in the map but is refused by deleteEntities: the tenants
    // table has no deleted_at column, so this path could only ever raise a
    // SQL error. Deleting a workspace is the account cascade's job.
    const refused = new Set(['tenants']);
    const unpurged = mapped.filter(
      (t) => !listed.has(t) && !PURGED_SEPARATELY.has(t) && !refused.has(t),
    );
    if (unpurged.length > 0) {
      throw new Error(
        'ENTITY_TABLE_MAP lets a deletion request target these tables, but nothing\n'
        + `purges them, so the request marks rows that are never removed:\n\n`
        + unpurged.map((t) => `  ${t}`).join('\n')
        + '\n\nAdd each to PURGE_TABLES in src/maintenance/purge-soft-deleted.ts.\n',
      );
    }
  });

  it('gives every purge entry a stated reason', () => {
    // The list answers "which tables hold a deleted person's data". A bare
    // table name does not answer it.
    const bare = PURGE_TABLES.filter((e) => e.why.trim().length < 10).map((e) => e.table);
    if (bare.length > 0) {
      throw new Error(
        `These purge entries need a stated reason: ${bare.join(', ')}.\n`
        + 'The list answers "which tables hold a deleted person\'s data"; a bare\n'
        + 'table name does not answer it.\n',
      );
    }
  });
});
