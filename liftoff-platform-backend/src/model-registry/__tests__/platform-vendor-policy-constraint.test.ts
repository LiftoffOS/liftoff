// The migration's CHECK constraints and the TypeScript vocabulary are the same
// two lists.
//
// A hand-written SQL copy of a TS union is the shape that has been missed six
// times on `invocations.provider`, and it fails in the worst way: the code
// resolves the new vendor happily, the INSERT is the thing that raises 23514,
// and it raises at the end of a call that already spent money. Nothing compares
// the two unless something like this does.
//
// Read from the migration TEXT rather than from a database, because the unit
// suite has none — and because the text is what a from-scratch rebuild applies,
// which is the copy that has to be right.

import fs from 'fs';
import path from 'path';
import { PLATFORM_VENDOR_AREAS } from '../platform-vendor-policy';
import { WORKSPACE_AI_SELECTIONS } from '../workspace-ai-vendors';

const MIGRATIONS_DIR = path.join(__dirname, '../../../migrations');

/** Migration 553's own text: where the rows were SEEDED. */
const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '553_platform_vendor_policy.sql'), 'utf8');

/**
 * The area renames applied after 553, read out of the migrations that applied
 * them rather than restated here.
 *
 * 553 seeded one row per area under the names it knew. An applied migration is
 * never edited, so those are the names it will always show, while the rows
 * themselves have since been renamed by a later migration. Comparing 553's text
 * directly to the current TypeScript compares two things that were never meant
 * to match.
 */
function currentAreaName(area: string): string {
  const later = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && Number.parseInt(f.split('_')[0], 10) > 553)
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  let name = area;
  for (const f of later) {
    const text = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    if (!text.includes('platform_vendor_policy')) continue;
    for (const m of text.matchAll(/SET area = '([^']+)' WHERE area = '([^']+)'/g)) {
      if (m[2] === name) name = m[1];
    }
  }
  return name;
}

/**
 * The quoted literals inside the LAST `CHECK (<column> IN (...))` any migration
 * declares.
 *
 * It used to read one named file. That was right while one migration owned the
 * constraint and wrong the moment a second one redefined it: an applied
 * migration is never edited, so 553 states the vocabulary it was written with
 * forever, and a later migration dropping and re-adding the CHECK leaves 553
 * describing a constraint no database has. Reading the last declaration is
 * reading what a from-scratch rebuild ends up with, which is the copy that has
 * to match the TypeScript.
 *
 * Numeric order, not lexicographic: "1000_x.sql" sorts before "553_x.sql" as a
 * string, and that would silently pick the wrong one the day the chain passes
 * a thousand.
 */
function checkList(column: string): string[] {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ f, n: Number.parseInt(f.split('_')[0], 10) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n);

  let found: string[] | null = null;
  const re = new RegExp(`CHECK\\s*\\(${column}\\s+IN\\s*\\(([^)]*)\\)`, 'gi');
  for (const { f } of files) {
    const text = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    // Only migrations that touch THIS table. A column name on its own is not
    // unique across the chain — `vendor` in particular appears on several
    // tables — and matching one of those would quietly swap in another table's
    // vocabulary, which is a worse failure than not finding one at all.
    if (!text.includes('platform_vendor_policy')) continue;
    for (const m of text.matchAll(re)) {
      found = [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]);
    }
  }
  if (!found) throw new Error(`no CHECK (${column} IN (...)) on platform_vendor_policy in any migration`);
  return found;
}

describe('platform_vendor_policy CHECK constraints', () => {
  it('admits exactly the Workspace AI vocabulary, no more and no less', () => {
    // Both directions. A MISSING vendor raises 23514 on the write; an EXTRA one
    // is a value the resolver has no branch for, which reads as configured and
    // routes nowhere.
    expect(checkList('vendor').sort()).toEqual([...WORKSPACE_AI_SELECTIONS].sort());
  });

  it('admits exactly the four areas', () => {
    expect(checkList('area').sort()).toEqual([...PLATFORM_VENDOR_AREAS].sort());
  });

  it('seeds every area to the default, so applying it changes no routing', () => {
    // An area with no row would make the admin surface show three levers and
    // force every reader to tell "not configured" from "missing".
    const seeded = [...sql.matchAll(/\('(\w+)',\s*'(\w+)',\s*'migration-553'\)/g)];
    expect(seeded.map((s) => currentAreaName(s[1])).sort()).toEqual([...PLATFORM_VENDOR_AREAS].sort());
    for (const s of seeded) expect(s[2]).toBe('default');
  });
});
