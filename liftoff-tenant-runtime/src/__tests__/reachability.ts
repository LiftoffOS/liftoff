// Finding code that nothing can reach.
//
// This exists because one failure has recurred more than any other in this
// codebase, and it is invisible to every other check we run: a feature that is
// completely implemented, fully typed, carefully tested — and wired at only one
// end. A spill target nothing set. A deferred-tools map stashed where the
// dispatcher never read. A queue nothing enqueued to. A role whose boundary no
// invocation could ever reach. Each one passed lint, passed typecheck, and
// passed its own unit tests, because unit tests on either side of a seam cannot
// see the seam.
//
// The shared shape is always an EXPORT WITH NO CALLER. So that is what this
// looks for.
//
// It is deliberately a blunt instrument. It matches by name across the
// production tree rather than resolving the import graph, which means it can be
// fooled — a symbol referenced only through a string, or reached only by
// reflection, reads as unreachable. That is the right trade: a false positive
// costs one line in the baseline with a reason attached, while a false negative
// is the exact defect this exists to catch.
//
// The blunt instrument has one structural gap: a symbol the declaring file uses
// is treated as reachable, so an export that only ever calls itself stays
// invisible even when nothing imports the module. An Express router is the
// common shape — `someRouter.get(...)` in its own file counts as a use, so a
// router that is never mounted looks alive. `findUnmountedRouters` below closes
// that case by refusing to count self-references for routers, which is sound
// because mounting always happens in another file. Other shapes of self-calling
// export still need transitive reachability from the process entry point, which
// is an import-graph walk this does not do.

import * as fs from 'fs';
import * as path from 'path';

export interface OrphanExport {
  /** Repo-relative path. */
  file: string;
  symbol: string;
}

const SOURCE_ROOT = 'src';

/** Files whose exports are consumed from outside the source tree, so "nothing
 *  in src imports this" says nothing about whether it is reachable. */
const ENTRY_POINT_PATTERNS = [
  /^src\/index\.ts$/,
  /\/migrations\//,
  /\.d\.ts$/,
];

function isEntryPoint(file: string): boolean {
  return ENTRY_POINT_PATTERNS.some((re) => re.test(file));
}

export function isTestFile(file: string): boolean {
  return file.includes('__tests__')
    || file.endsWith('.test.ts')
    || file.endsWith('.spec.ts')
    || file.includes('/test-utils/');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(p, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Exported value symbols in a file.
 *
 * Values only — types, interfaces and enums are excluded. An unused type is a
 * documentation choice; an unused function is a feature that does not run, and
 * only the second is what this is for.
 *
 * A leading underscore means "exported for tests" and is exempt by convention,
 * which is why the convention is worth having.
 */
export function exportedValueSymbols(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /^export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^export\s+(?:const|let)\s+(\w+)/gm,
    /^export\s+(?:abstract\s+)?class\s+(\w+)/gm,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (!m[1].startsWith('_')) out.push(m[1]);
    }
  }
  return [...new Set(out)];
}

/** Does this line DECLARE the symbol, rather than use it? */
function isDeclarationLine(line: string, symbol: string): boolean {
  return new RegExp(
    `^\\s*export\\s+(?:async\\s+)?(?:function|const|let|abstract\\s+class|class)\\s+${symbol}\\b`,
  ).test(line);
}

/** `export { X } from './y'` NAMES a symbol; it does not USE it. Counting a
 *  re-export as a use lets any dead export hide behind a barrel file — it adds a
 *  consumer without adding a checked export, so the symbol can never be
 *  reported. A real consumer writes `import { X } from './y'`, which is not
 *  matched here and still counts.
 *
 *  Matched over the whole source rather than per line, because a barrel commonly
 *  spreads one specifier list across many lines and a line-scoped test would see
 *  only the bare symbol in the middle of it. */
const RE_EXPORT_STATEMENT = /export\s*(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s*from\s*['"][^'"]*['"]/g;

/** Character ranges covered by re-export statements, so a match inside one can
 *  be skipped wherever it falls. */
function reExportRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = new RegExp(RE_EXPORT_STATEMENT.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function usesSymbol(source: string, symbol: string, isOwnFile: boolean): boolean {
  const skip = reExportRanges(source);
  const re = new RegExp(`\\b${symbol}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const at = m.index;
    if (skip.some(([start, end]) => at >= start && at < end)) continue;
    if (!isOwnFile) return true;
    const lineStart = source.lastIndexOf('\n', at) + 1;
    const lineEnd = source.indexOf('\n', at);
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    // A symbol used elsewhere in its own file is reachable — an exported helper
    // that its own module calls is not an orphan.
    if (!isDeclarationLine(line, symbol)) return true;
  }
  return false;
}

/**
 * Every exported value in the production tree that nothing in the production
 * tree names.
 *
 * Tests are excluded from the "who uses it" side on purpose. A symbol whose
 * only caller is its own test is exactly the defect: the test proves the logic
 * works and nothing proves it runs.
 */
export function findOrphanExports(repoRoot: string): OrphanExport[] {
  const abs = (f: string): string => path.join(repoRoot, f);
  const production = walk(path.join(repoRoot, SOURCE_ROOT))
    .map((f) => path.relative(repoRoot, f))
    .filter((f) => !isTestFile(f));

  // Two different sets, and conflating them is a false-positive factory.
  //
  //   * CHECKED — files whose exports must have a caller. Entry points are out:
  //     `index.ts` exports for the process boundary, so "nothing in src imports
  //     this" says nothing about whether it runs.
  //   * CONSUMERS — files that count as using something. Entry points are very
  //     much IN: `index.ts` is where the process wires the modules together,
  //     and excluding it would report every top-level wiring call as dead.
  const checked = production.filter((f) => !isEntryPoint(f));

  const sources = new Map<string, string>();
  for (const f of production) sources.set(f, fs.readFileSync(abs(f), 'utf8'));

  const orphans: OrphanExport[] = [];
  for (const file of checked) {
    const source = sources.get(file)!;
    for (const symbol of exportedValueSymbols(source)) {
      let used = false;
      for (const [other, otherSource] of sources) {
        if (usesSymbol(otherSource, symbol, other === file)) { used = true; break; }
      }
      if (!used) orphans.push({ file, symbol });
    }
  }
  return orphans.sort((a, b) => `${a.file}::${a.symbol}`.localeCompare(`${b.file}::${b.symbol}`));
}

/** Match the declaration, not the name. `stopSubscriptionRouter` is a function
 *  and `webFetchRouter` is a vendor-dispatch class; both end in "Router" and
 *  neither is mounted anywhere, so a name test reports them forever. Only a
 *  symbol bound to `Router()` is the shape this check reasons about. */
function isExpressRouter(source: string, symbol: string): boolean {
  return new RegExp(
    `\\b${symbol}\\s*(?::[^=]+)?=\\s*(?:express\\.)?Router\\s*\\(`,
  ).test(source);
}

/**
 * Every exported Express router that no OTHER file names.
 *
 * This is the one export shape `findOrphanExports` structurally cannot judge.
 * A router calls itself to declare its routes — `someRouter.get(...)` sits in
 * the declaring file — and a self-use counts as reachable there, so a router
 * nothing mounts reads as alive. Mounting, however, always happens somewhere
 * else. So for this shape, and only this shape, a self-reference proves nothing
 * and is not counted.
 *
 * Re-export ranges are skipped by `usesSymbol`, so a barrel that forwards a
 * router does not launder it into looking mounted.
 */
export function findUnmountedRouters(repoRoot: string): OrphanExport[] {
  const abs = (f: string): string => path.join(repoRoot, f);
  const production = walk(path.join(repoRoot, SOURCE_ROOT))
    .map((f) => path.relative(repoRoot, f))
    .filter((f) => !isTestFile(f));

  const sources = new Map<string, string>();
  for (const f of production) sources.set(f, fs.readFileSync(abs(f), 'utf8'));

  const unmounted: OrphanExport[] = [];
  for (const [file, source] of sources) {
    for (const symbol of exportedValueSymbols(source)) {
      if (!isExpressRouter(source, symbol)) continue;
      let mounted = false;
      for (const [other, otherSource] of sources) {
        if (other === file) continue;
        if (usesSymbol(otherSource, symbol, false)) { mounted = true; break; }
      }
      if (!mounted) unmounted.push({ file, symbol });
    }
  }
  return unmounted.sort((a, b) => `${a.file}::${a.symbol}`.localeCompare(`${b.file}::${b.symbol}`));
}

export function orphanKey(o: OrphanExport): string {
  return `${o.file}::${o.symbol}`;
}
