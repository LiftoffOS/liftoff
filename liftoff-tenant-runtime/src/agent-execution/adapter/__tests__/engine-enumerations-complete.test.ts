// A hand-written list of engines is a list that falls behind, and the falling
// behind is invisible: the short list still passes, over a smaller set than it
// claims to cover.
//
// It has now happened five times in this repo, each found separately and fixed
// only where it was noticed. `resolveExecutionEngine` recorded a NULL engine for
// every Grok run because the provider list beside its switch went stale.
// `startup-validation` reported an unrecognized engine from the one check whose
// job is to notice that at boot. The live certification job and the
// cross-adapter equivalence suite each iterated seven of eight. The canary that
// exists to catch an unrebuildable conversation never asked about the engine
// every Grok run uses. None of them failed anything on the way in.
//
// So this asserts the property directly rather than waiting for the sixth: a
// collection of engine-id literals ANYWHERE in the tree covers every engine a
// vendor can resolve to, or says why not.
//
// Tests are in scope, and are most of the defect. Five of the eight short lists
// were in test files, which is not a lesser problem: a harness that iterates
// seven of eight engines does not report a gap, it reports a pass.
//
// EXEMPTING ONE. Put `ENGINE_SUBSET_OK:` with a reason in the declaration's
// comment. A deliberate partition is fine — `ENGINES_WITHOUT_FORCING` is half a
// pair whose other half is an exhaustive switch — and the marker is what makes
// it a decision a reviewer can see rather than an omission nobody can tell from
// one.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../types';

const SRC_ROOT = join(__dirname, '..', '..', '..');

/** Flat `[...]` literals only: a nested bracket or brace means the elements are
 *  not bare strings, and a fixture list of objects is not this defect. */
const BLOCK = /\[[^[\]{}]*\]/gs;
const QUOTED = /'([^']*)'|"([^"]*)"/g;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // `__tests__` is IN scope; only this file is excluded, since it names every
    // engine in its own explanatory prose.
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && entry !== 'engine-enumerations-complete.test.ts') out.push(full);
  }
  return out;
}

interface Enumeration { file: string; line: number; engines: string[]; exempt: boolean }

function engineEnumerations(): Enumeration[] {
  const engines = new Set<string>(RESOLVABLE_EXECUTION_ENGINE_IDS);
  const found: Enumeration[] = [];
  for (const file of tsFilesUnder(SRC_ROOT)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(BLOCK)) {
      const strings = [...m[0].matchAll(QUOTED)].map((q) => q[1] ?? q[2]);
      // Two or more, and nothing in the literal that is not an engine: one id
      // beside unrelated strings is an argument list, not an enumeration.
      if (strings.length < 2 || !strings.every((s) => engines.has(s))) continue;
      const before = src.slice(0, m.index);
      found.push({
        file: file.slice(SRC_ROOT.length + 1),
        line: before.split('\n').length,
        engines: strings,
        // The declaration's own comment block, which is where a reason belongs.
        exempt: before.slice(-1200).includes('ENGINE_SUBSET_OK'),
      });
    }
  }
  return found;
}

describe('every engine enumeration in the tree is complete', () => {
  const enumerations = engineEnumerations();

  it('finds enumerations at all, so this cannot pass vacuously', () => {
    expect(enumerations.length).toBeGreaterThan(0);
  });

  it('lists every resolvable engine, or is marked a deliberate subset', () => {
    const incomplete = enumerations
      .filter((e) => !e.exempt)
      .map((e) => ({
        ...e,
        missing: RESOLVABLE_EXECUTION_ENGINE_IDS.filter((id) => !e.engines.includes(id)),
      }))
      .filter((e) => e.missing.length > 0)
      .map((e) => `${e.file}:${e.line} omits ${e.missing.join(', ')}`);

    expect(incomplete).toEqual([]);
  });
});
