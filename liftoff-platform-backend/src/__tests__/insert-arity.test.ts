// Every static `INSERT INTO t (cols) VALUES (exprs)` must name as many columns
// as it supplies expressions.
//
// WHY THIS EXISTS. A mismatch here is a Postgres parse error (42601, "INSERT has
// more target columns than expressions") raised at EXECUTION, in production,
// against a real table — nothing earlier can see it. It is not a type error, so
// tsc is blind to it; the SQL is a template literal, so eslint is blind to it;
// and the query only runs when its feature runs, so a suite that never exercises
// that path is blind to it too.
//
// The cost is real. Shorten the placeholder list of the entitlement_snapshots
// INSERT while leaving its target columns in place, and
// `EntitlementService.update` — which writes a snapshot on every call and is
// the ONLY path that flips `agent_execution_allowed` to TRUE — fails every
// time, so no tenant can be granted execution. The call site catches the
// rejection, logs it and answers 200, so Stripe records a healthy activation
// over an account that cannot run anything, and nothing else says so.
//
// A source-level ratchet, deliberately: the defect class is "a column list and
// an expression list drift apart", and counting them is the whole test. It runs
// over statements it can count with certainty and skips the rest rather than
// guessing — a skipped statement is a gap, a miscounted one is a false failure
// that teaches people to disable the check.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..');

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

/** Strip `-- …` line comments so they cannot contribute commas. */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/**
 * Read a parenthesised list starting at `open` (the index of its `(`).
 * Returns the raw inner text and the index just past the closing `)`,
 * or null when the parentheses never balance.
 */
function readParenList(src: string, open: number): { inner: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { inner: src.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Split on top-level commas only — nested calls and quoted text stay intact. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

interface InsertSite {
  file: string;
  table: string;
  columns: number;
  expressions: number;
  snippet: string;
}

function insertSites(): InsertSite[] {
  const sites: InsertSite[] = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    if (isTestFile(file)) continue;
    const source = stripLineComments(readFileSync(file, 'utf8'));
    const re = /INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const table = match[1];
      const columnOpen = match.index + match[0].length - 1;
      const columnList = readParenList(source, columnOpen);
      if (!columnList) continue;

      // Must be followed by VALUES ( … ). `INSERT … SELECT`, `DEFAULT VALUES`
      // and anything else has no tuple to count against.
      const after = source.slice(columnList.end);
      const valuesMatch = /^\s*VALUES\s*\(/i.exec(after);
      if (!valuesMatch) continue;
      const valuesOpen = columnList.end + valuesMatch[0].length - 1;
      const valueList = readParenList(source, valuesOpen);
      if (!valueList) continue;

      // A list built by string interpolation cannot be counted from source.
      if (columnList.inner.includes('${') || valueList.inner.includes('${')) continue;

      sites.push({
        file: file.slice(SRC_ROOT.length + 1),
        table,
        columns: splitTopLevel(columnList.inner).length,
        expressions: splitTopLevel(valueList.inner).length,
        snippet: `INSERT INTO ${table} (…)`,
      });
    }
  }
  return sites;
}

describe('static INSERT column/expression arity', () => {
  const sites = insertSites();

  it('finds a meaningful number of statements (a scan matching nothing would pass vacuously)', () => {
    expect(sites.length).toBeGreaterThan(30);
    expect(sites.map(s => s.table)).toContain('entitlement_snapshots');
  });

  it('every counted statement supplies one expression per column', () => {
    const mismatched = sites
      .filter(s => s.columns !== s.expressions)
      .map(s => `${s.file}: ${s.snippet} — ${s.columns} columns vs ${s.expressions} expressions`);
    expect(mismatched).toEqual([]);
  });
});
