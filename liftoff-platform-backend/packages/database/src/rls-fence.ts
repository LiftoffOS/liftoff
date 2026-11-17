// Static-analysis fence: every `pool.query(...)` or `client.query(...)`
// in a service handler must be tenant-scoped — lexically inside
// `withTenantContext(...)` / `withTenantScope(...)` / `withAdminScope(...)`,
// OR within a transaction whose earlier `set_config('app.current_tenant_id', …)`
// established the scope (the sanctioned "set_config-in-tx" pattern).
//
// Not flagged: transaction-control statements (BEGIN/COMMIT/ROLLBACK/SAVEPOINT/
// RELEASE) and the `set_config` scope-setter itself — they carry no table access.
//
// Opt-outs for deliberately cross-tenant paths (reconciliation jobs, GDPR
// exports, DDL/partition management):
//   - INLINE `// rls-fence: allow` on the query-call line — suppresses just that
//     line, keeping the rest of the file fenced (preferred).
//   - A standalone `// rls-fence: allow` line anywhere (leading whitespace ok) —
//     skips the WHOLE file. Coarser; use only when the entire file is cross-tenant.
//
// Run as part of each service's CI:
//   node --experimental-specifier-resolution=node \
//     ./node_modules/@liftoffos/database/scripts/rls-fence.js <root>
//
// Exit code 0 = no violations; non-zero = violations printed to stderr.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface RlsFenceViolation {
  file: string;
  line: number;
  code: string;
}

// `.query` followed by `(` OR `<`. The `<` case is the whole point: a call
// written `pool.query<{ count: string }>(...)` puts a type argument between
// `.query` and the paren, and an earlier `\.query\s*\(` missed every one of
// them. That was not academic — it is why this fence passed clean over the
// unscoped `subscriptions` read that took the referral programme down, and it
// left 55 call sites in billing and 310 in platform-backend unexamined.
// Matching on `[<(]` also covers a generic that wraps onto following lines,
// which a line-oriented scan could never balance.
const QUERY_RE = /\b(pool|client)\.query\s*[<(]/g;
const DEFAULT_WRAPPERS = ['withTenantContext', 'withTenantScope', 'withAdminScope'];
const ALLOW_DIRECTIVE = '// rls-fence: allow';

// Transaction-control statements are not tenant-data queries — they carry no
// table access, so they can never leak cross-tenant rows.
const TX_CONTROL_RE = /\.query\s*\(\s*[`'"]\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

// `set_config('app.current_tenant_id', <id>, true)` establishes tenant scope
// for the rest of the transaction — the sanctioned "set_config-in-tx" RLS
// pattern (see each service's CLAUDE.md). A line that sets it both (a) is not
// itself a data query and (b) scopes the queries that follow it in the tx, so
// it counts as a wrapper in the backward scan below.
const SCOPE_SETTER_RE = /set_config\b[^\n]*current_tenant_id|current_tenant_id[^\n]*set_config/;

// Control-flow blocks. These open a `{` too, but they are inside the function,
// not the start of one, so they must NOT end the backward scan.
const CONTROL_KEYWORD = /^(if|else|for|while|do|try|catch|finally|switch|case|default|return|await|const|let|var|throw|new|yield|delete|typeof|void|import|export\s+default)\b/;

// Hard cap so a pathological file cannot make this quadratic. The declaration
// boundary is what normally stops the scan.
const MAX_SCAN = 400;

/** Leading-whitespace width, tabs counted as one. */
function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

/**
 * Does `line` start the function or method that `queryIndent` sits inside?
 *
 * Indentation carries the block structure: a declaration is always outdented
 * relative to its own body. Matching on that rather than on column 0 is what
 * makes class methods work, and class methods are the case that matters —
 * `hasActiveSubscription` is one, and scanning past it found a DIFFERENT
 * method's `withBillingTenant` and declared the query scoped.
 */
function isDeclarationBoundary(line: string, queryIndent: number): boolean {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
  if (indentOf(line) >= queryIndent) return false;
  if (CONTROL_KEYWORD.test(trimmed)) return false;
  // A declaration opens a block. A statement ends in `;` and cannot be one.
  // Without this, `throw new Error('...');` reads as a call signature and ends
  // the scan early, which is exactly how a correctly-scoped query 60 lines
  // inside a handler got reported.
  if (trimmed.endsWith(';')) return false;
  // A call signature: a name, then a parameter list. Covers `function f(`,
  // `private async m(`, `export async function f(` and a bare method `m(`.
  return /^[A-Za-z0-9_$\s]*\b[A-Za-z0-9_$]+\s*\(/.test(trimmed) || /^(export|function|private|public|protected|static|async)\b/.test(trimmed);
}

export interface RlsFenceOptions {
  /** File patterns to skip (e.g. `.test.ts`). Defaults include tests. */
  skipSuffixes?: string[];
  /**
   * Additional function names that establish tenant scope, on top of
   * withTenantContext / withTenantScope / withAdminScope.
   *
   * A service that wraps the shared helper under its own name needs this.
   * billing's `withBillingTenant` is exactly `withTenantScope` with the RLS
   * variable pre-filled, but the fence could not see through the rename, so
   * six correctly-scoped queries were silenced with `rls-fence: allow` just to
   * get CI green. Suppressions added for that reason are indistinguishable from
   * suppressions added because a query really is cross-tenant, which is how a
   * genuine violation goes unnoticed in review.
   */
  extraWrappers?: string[];
}

export async function runRlsFence(root: string, options: RlsFenceOptions = {}): Promise<RlsFenceViolation[]> {
  const skipSuffixes = options.skipSuffixes ?? ['.test.ts', '.spec.ts', '.d.ts'];
  const violations: RlsFenceViolation[] = [];
  const wrapperNames = [...DEFAULT_WRAPPERS, ...(options.extraWrappers ?? [])];
  const wrapperRe = new RegExp(`\\b(${wrapperNames.map(escapeRe).join('|')})\\s*\\(`);

  const files = await walk(root);
  for (const file of files) {
    if (skipSuffixes.some((s) => file.endsWith(s))) continue;
    if (!file.endsWith('.ts')) continue;
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split('\n');
    // File-level opt-out. Tolerate leading whitespace so an indented directive
    // (e.g. inside a function body) still counts — previously only a
    // column-0 directive worked, which silently no-op'd indented ones.
    if (lines.some((l) => l.trimStart().startsWith(ALLOW_DIRECTIVE))) continue;

    // Find query-call sites.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      QUERY_RE.lastIndex = 0;
      if (!QUERY_RE.test(line)) continue;
      // Transaction-control and scope-setter lines are not tenant-data queries.
      if (TX_CONTROL_RE.test(line) || SCOPE_SETTER_RE.test(line)) continue;
      // Per-line opt-out: the directive placed INLINE on the query-call line.
      // Preferred over the file-level directive because it keeps the rest of the
      // file fenced (a genuinely cross-tenant query is suppressed without
      // blinding the fence to future unscoped ones nearby). Inline-only so it
      // can't be confused with a standalone (file-level) directive line.
      if (line.includes(ALLOW_DIRECTIVE)) continue;
      // Scan backward for a wrapper start OR a set_config that established
      // tenant scope, stopping at the enclosing function rather than after an
      // arbitrary number of lines.
      //
      // The old bound was 40 lines, which is not a property of anything. In
      // billing's Stripe consumer the scope is set once at the top of a long
      // handler and every query below inherits it; the setter sits ~60 lines
      // above the first query, so a correctly-scoped file reported violations
      // and the fix was to paper them over with allow directives. Scanning to
      // the function boundary asks the question that actually matters: is this
      // query inside something that established scope?
      //
      // FUNCTION_START only matches at column 0, so a nested callback (the
      // `async (client) => {` inside a wrapper call) does not end the scan —
      // which is the point, because the wrapper line is what we are looking for.
      let wrapperFound = false;
      for (let j = i; j >= Math.max(0, i - MAX_SCAN); j--) {
        if (wrapperRe.test(lines[j]) || SCOPE_SETTER_RE.test(lines[j])) {
          wrapperFound = true;
          break;
        }
        if (j < i && isDeclarationBoundary(lines[j], indentOf(line))) {
          // The declaration is allowed to prove scope by its own type. A
          // function that takes a TenantScopedClient can only be called with one
          // the scope helper minted, so the compiler has already established
          // what this fence would otherwise be guessing at across a call
          // boundary. That guess is the reason these sites accumulated
          // suppressions; a type is the thing a suppression was standing in for.
          if (signatureDeclaresScopedClient(lines, j)) wrapperFound = true;
          break;
        }
      }
      if (!wrapperFound) {
        violations.push({ file, line: i + 1, code: line.trim() });
      }
    }
  }
  return violations;
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue;
      out.push(...(await walk(full)));
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// CLI entry point
 
(async () => {
  if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('rls-fence.js')) {
    const root = process.argv[2];
    if (!root) {
       
      console.error('usage: rls-fence <src-root>');
      process.exit(2);
    }
    const violations = await runRlsFence(root);
    if (violations.length === 0) {
       
      console.log(`[rls-fence] OK — no raw query calls outside withTenantContext under ${root}`);
      return;
    }
     
    console.error(`[rls-fence] FAIL — ${violations.length} violation(s):`);
    for (const v of violations) {
       
      console.error(`  ${v.file}:${v.line}: ${v.code}`);
    }
    process.exit(1);
  }
})();

/** Escapes a wrapper name for embedding in the alternation above. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does the declaration starting at `start` take a TenantScopedClient?
 *
 * Reads forward to the end of the parameter list rather than checking one line:
 * every such signature in billing wraps, putting the parameter on the line AFTER
 * the declaration.
 */
function signatureDeclaresScopedClient(lines: string[], start: number): boolean {
  const SIGNATURE_MAX = 25;
  for (let k = start; k < Math.min(lines.length, start + SIGNATURE_MAX); k++) {
    if (/\bTenantScopedClient\b/.test(lines[k])) return true;
    // Body opens: the parameter list is over.
    if (k > start && /\{\s*$/.test(lines[k])) return false;
  }
  return false;
}
