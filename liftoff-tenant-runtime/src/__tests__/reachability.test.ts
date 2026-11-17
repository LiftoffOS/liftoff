// Nothing new may ship unreachable.
//
// This is the gate for the failure that has cost more time in this codebase
// than any other, and that no other check can see: a feature implemented at one
// end only. Lint passes, typecheck passes, its own tests pass — and it never
// runs, because unit tests on either side of a seam cannot see the seam.
//
// It is a RATCHET rather than a clean assertion. The tree already carried 138
// such exports when this landed; demanding they all be resolved first would
// have meant not landing it. So the existing set is frozen as visible debt and
// anything new fails.
//
// The same shape the RLS census uses, and for the same reason: an invariant
// worth having is worth having imperfectly today rather than perfectly never.

import { findOrphanExports, orphanKey } from './reachability';
import { KNOWN_ORPHAN_EXPORTS } from './known-orphan-exports';

describe('everything shipped is reachable', () => {
  const found = findOrphanExports(process.cwd()).map(orphanKey);
  const baseline = new Set(KNOWN_ORPHAN_EXPORTS);

  it('adds no new export that nothing calls', () => {
    const fresh = found.filter((k) => !baseline.has(k));
    if (fresh.length > 0) {
      throw new Error(
        `${fresh.length} exported symbol(s) have no caller in production code:\n\n`
        + fresh.map((k) => `  ${k}`).join('\n')
        + '\n\nAn export nothing calls is a feature that does not run. Every time this\n'
        + 'has happened here, it shipped green and was found weeks later.\n\n'
        + 'Fix it one of these ways:\n'
        + '  1. Wire it — find the seam it was meant to plug into and call it there.\n'
        + '     This is almost always the answer.\n'
        + '  2. Delete it — if nothing needs it, it is not a feature.\n'
        + '  3. Rename it with a leading underscore, if it truly exists for tests.\n'
        + '  4. Add it to known-orphan-exports.ts WITH a comment saying why the\n'
        + '     checker cannot see its caller. Rare, and a reviewer should ask.\n',
      );
    }
  });

  it('does not let the debt list rot', () => {
    // A baseline entry that is no longer an orphan has been fixed — good — and
    // leaving it listed means the next genuine orphan at that name slips
    // through silently. Prune it.
    const stale = [...baseline].filter((k) => !found.includes(k));
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} baseline entr(ies) are no longer unreachable and should be removed `
        + `from known-orphan-exports.ts:\n\n${stale.map((k) => `  ${k}`).join('\n')}\n\n`
        + 'Leaving them listed means a future orphan with the same name ships unnoticed.\n',
      );
    }
  });
});

describe('the checker itself', () => {
  it('treats a leading underscore as "exported for tests"', () => {
    const { exportedValueSymbols } = require('./reachability');
    expect(exportedValueSymbols('export function _resetForTest(): void {}')).toEqual([]);
    expect(exportedValueSymbols('export function doTheThing(): void {}')).toEqual(['doTheThing']);
  });

  it('looks at values, not types', () => {
    // An unused type is a documentation choice. An unused function is a feature
    // that does not run, and only the second is what this is for.
    const { exportedValueSymbols } = require('./reachability');
    expect(exportedValueSymbols('export interface Thing { a: string }')).toEqual([]);
    expect(exportedValueSymbols('export type Other = string;')).toEqual([]);
    expect(exportedValueSymbols('export const REAL = 1;')).toEqual(['REAL']);
  });

  it('counts a test as no caller at all', () => {
    // The whole point. A symbol whose only caller is its own test is exactly
    // the defect: the test proves the logic works and nothing proves it runs.
    const { isTestFile } = require('./reachability');
    expect(isTestFile('src/foo/__tests__/bar.test.ts')).toBe(true);
    expect(isTestFile('src/foo/bar.ts')).toBe(false);
  });
});
