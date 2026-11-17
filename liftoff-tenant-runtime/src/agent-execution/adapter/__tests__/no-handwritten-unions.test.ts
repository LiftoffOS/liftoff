// A closed set is written down ONCE, and everything else derives from it.
//
// `VENDORS` is the vendor record and `ExecutionEngineId` the engine union; both
// have derived exports — `ResolvedProvider`, `RESOLVED_PROVIDERS`,
// `VENDOR_ENGINE_IDS` — that are meant to be the only way to name the set.
//
// They were not. Twenty-two hand-written copies of
// `'anthropic' | 'anthropic-vertex' | 'openai' | 'google' | 'openrouter' | 'xai'`
// sat across seven files, and that is why adding three approved providers to the
// record produced a type error in each of them rather than working: a copy does
// not widen when the source does. The same shape had already cost a day
// elsewhere — engine lists that iterated seven of eight, a certification that
// skipped the engine nobody remembered.
//
// A copy is not wrong the day it is written. It is wrong the day the source
// changes, and by then nobody connects the two. So the rule is structural: name
// the set through its derived type, or say why this one place cannot.
//
// A NARROWING IS NOT A COPY, and the difference is the whole rule. BYOK names
// four providers because a customer can hold a key for exactly those; the
// web-fetch router names two because two have hosted search. Those are claims
// about a subset, they stay true when a provider is added, and writing them out
// is correct. What is never correct is reproducing the set ENTIRE — that is the
// derived type with extra steps, and the only thing it adds is a copy that stops
// matching.
//
// So this flags a union that names every member and nothing else. Exempt one
// with `CLOSED_SET_LITERAL_OK:` and a reason if a full enumeration is ever
// genuinely meant.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { RESOLVED_PROVIDERS } from '../types';
import { VENDOR_ENGINE_IDS } from '../vendors';

const SRC = join(__dirname, '..', '..', '..');

/** Where the sets are DEFINED. A definition naming its own members is the point. */
const DEFINING_FILES = ['adapter/vendors.ts', 'adapter/types.ts'];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** A union of two or more quoted members, e.g. `'a' | 'b' | 'c'`. */
const UNION = /'[^']+'(?:\s*\|\s*'[^']+')+/g;

describe('a closed set is named through its derived type', () => {
  const known = new Set<string>([...RESOLVED_PROVIDERS, ...VENDOR_ENGINE_IDS]);

  const offenders = tsFilesUnder(SRC).flatMap((file) => {
    const rel = file.slice(SRC.length + 1);
    if (DEFINING_FILES.some((d) => rel.endsWith(d))) return [];
    const src = readFileSync(file, 'utf8');
    return [...src.matchAll(UNION)].flatMap((m) => {
      const members = new Set([...m[0].matchAll(/'([^']+)'/g)].map((q) => q[1]));
      // A COPY names every member of a closed set and nothing else. A subset is
      // a narrowing — a true claim about some of them — and stays true when the
      // set grows, so it is not this rule's business.
      if (![...members].every((v) => known.has(v))) return [];
      // FIVE is the line between a narrowing and a copy, and it is a judgement
      // rather than a law. Real narrowings in this codebase are small and say
      // something true about a subset: BYOK names the four providers a customer
      // can hold a key for, the web-fetch router names the two with hosted
      // search, code-session names the CLIs that exist. A union naming five or
      // more is not making a claim about some of them — it is trying to be the
      // set, and a copy of the set is the derived type with extra steps.
      //
      // A strict "names every member" rule was tried and it missed the live
      // instance: `LLMProvider` held six of nine and had ALREADY gone stale,
      // which is the exact state this exists to prevent. A copy is never wrong
      // the day it is written; it is wrong the day the source changes.
      if (members.size < 5) return [];
      const before = src.slice(Math.max(0, m.index! - 600), m.index!);
      if (before.includes('CLOSED_SET_LITERAL_OK')) return [];
      return [`${rel}: ${m[0].slice(0, 70)}`];
    });
  });

  it('finds files to check, so this cannot pass vacuously', () => {
    expect(tsFilesUnder(SRC).length).toBeGreaterThan(50);
  });

  it('has no hand-written copy of the provider or engine set', () => {
    expect(offenders).toEqual([]);
  });
});
