// Every writer that can CREATE a billing_controls row must decide, at that
// moment, whether the account is charged.
//
// `billing_exempt` defaults to FALSE at the column level, which is the right
// default for a customer and the wrong one for us: an internal account whose
// row is created by any path that forgets the column silently becomes
// chargeable, and the only symptom is a Stripe invoice raised against
// ourselves. Migration 334 seeds the flag for accounts that already have a
// row; this keeps every future row correct.
//
// A source-level ratchet on purpose. The failure it guards against is a NEW
// insert site added months from now by someone who has never read migration
// 333 — no behavioural test can cover code that does not exist yet, but this
// fails the build the moment it appears.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(path: string): boolean {
  return path.includes('__tests__') || path.endsWith('.test.ts') || path.includes('/test-utils/');
}

/** Each `INSERT INTO billing_controls …` statement found in production code,
 *  as `{ file, sql }` with whitespace collapsed. */
function insertStatements(): { file: string; sql: string }[] {
  const found: { file: string; sql: string }[] = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    if (isTestFile(file)) continue;
    const source = readFileSync(file, 'utf8');
    // From the INSERT keyword to the end of the template literal that holds it.
    const re = /INSERT INTO billing_controls[\s\S]*?`/g;
    for (const match of source.match(re) ?? []) {
      found.push({ file: file.slice(SRC_ROOT.length + 1), sql: match.replace(/\s+/g, ' ') });
    }
  }
  return found;
}

describe('billing_controls insert sites', () => {
  const statements = insertStatements();

  it('finds the known writers (guards against the scan silently matching nothing)', () => {
    // If this drops to zero the ratchet below passes vacuously, which would be
    // worse than no test at all.
    expect(statements.length).toBeGreaterThanOrEqual(3);
    const files = new Set(statements.map(s => s.file));
    expect(files).toContain('billing/spend-subscriber.ts');
    expect(files).toContain('billing/billing-controls-internal-router.ts');
    expect(files).toContain('admin/router.ts');
  });

  it.each(insertStatements())(
    'seeds billing_exempt from accounts.is_internal — $file',
    ({ sql }) => {
      expect(sql).toContain('billing_exempt');
      expect(sql).toMatch(/SELECT is_internal FROM accounts WHERE id = \$1/);
    },
  );

  it.each(insertStatements())(
    'never resets billing_exempt on conflict — $file',
    ({ sql }) => {
      // An exemption an operator set by hand (contractor, design partner,
      // staff on a personal address) must survive a re-init. The column may
      // appear in the INSERT column list and in the seeding subselect, but
      // never in a `billing_exempt = …` assignment inside DO UPDATE SET.
      const doUpdate = sql.split(/DO UPDATE\s+SET/i)[1];
      if (!doUpdate) return; // DO NOTHING / plain INSERT — nothing to check.
      expect(doUpdate).not.toMatch(/billing_exempt\s*=/);
    },
  );
});
