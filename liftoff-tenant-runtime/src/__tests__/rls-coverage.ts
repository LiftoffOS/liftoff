// Which tenant-scoped tables this runtime's schema protects, read from the
// migrations.
//
// The control plane has had an RLS ratchet for a long time (a generated table
// list, a lint rule that fails a raw pool query naming an RLS table, and a
// census test). This repo had none, because it was designed one tenant per
// database: with a single tenant per deployment, row-level isolation inside the
// database buys nothing, and every table is "the tenant's" by construction.
//
// That premise stopped holding when a runtime began serving more than one
// tenant, and nothing in the schema noticed. The point of this scanner is that
// a NEW tenant-scoped table now has to be classified deliberately, so the debt
// stops growing while it is being paid down.
//
// Read from migrations rather than from a live database because the unit suite
// has none. That makes it a schema-shape check, not a proof about production:
// ownership decides whether RLS without FORCE binds at all (a table owner
// bypasses its own non-FORCE policies), and ownership is not in the migrations.
// `scripts/audit-rls-coverage.ts` answers the production question against a
// real database; this answers the one that can gate a pull request.

import * as fs from 'fs';
import * as path from 'path';

export type Protection = 'force' | 'rls' | 'none';

export interface TenantTable {
  table: string;
  protection: Protection;
  /** Migration file that last changed this table's protection, for triage. */
  lastTouchedBy: string;
}

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/** `001_foo.sql` → 1. Files without a numeric prefix sort last, by name. */
function migrationOrder(file: string): [number, string] {
  const m = /^(\d+)_/.exec(file);
  return [m ? Number(m[1]) : Number.MAX_SAFE_INTEGER, file];
}

export function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => {
      const [na, sa] = migrationOrder(a);
      const [nb, sb] = migrationOrder(b);
      return na - nb || sa.localeCompare(sb);
    });
}

/** Strip `-- line` and block comments so a table named only in prose (these
 *  migrations carry long design notes) is never mistaken for a statement. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

function unquote(name: string): string {
  return name.replace(/"/g, '').trim().toLowerCase();
}

const CREATE_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)\s*(\(|PARTITION\s+OF)/gi;
const ADD_TENANT_COL_RE =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?tenant_id"?/gi;
const DROP_TABLE_RE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/gi;
const RENAME_TABLE_RE =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)\s+RENAME\s+TO\s+("?[\w.]+"?)/gi;
const RLS_RE =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)\s+(NO\s+FORCE|FORCE|ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY/gi;

/** Body of a `CREATE TABLE x ( ... )`, balanced on parentheses. */
function tableBody(sql: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return sql.slice(openParenIndex + 1, i);
    }
  }
  return sql.slice(openParenIndex + 1);
}

/**
 * Replay every migration in order and report the tenant-scoped tables that
 * survive, with the protection each ended up with.
 *
 * Replayed rather than summed because a rename is not a new table and a drop is
 * not a table at all — reading the files as an unordered set counts renamed
 * tables twice and resurrects dropped ones. Migration 347's `NO FORCE` / `FORCE`
 * pair is the same reasoning at statement level: the last one wins.
 */
export function scanTenantTables(): TenantTable[] {
  const hasTenantId = new Set<string>();
  const protection = new Map<string, Protection>();
  const lastTouchedBy = new Map<string, string>();

  for (const file of migrationFiles()) {
    const sql = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));

    for (const m of sql.matchAll(CREATE_TABLE_RE)) {
      const table = unquote(m[1]);
      // A partition inherits its parent's policies; classifying it separately
      // would double-count one logical table.
      if (/PARTITION\s+OF/i.test(m[2])) continue;
      const body = tableBody(sql, m.index! + m[0].length - 1);
      if (/(^|[\s,("])tenant_id\b/i.test(body)) {
        hasTenantId.add(table);
        if (!protection.has(table)) protection.set(table, 'none');
        lastTouchedBy.set(table, file);
      }
    }

    for (const m of sql.matchAll(ADD_TENANT_COL_RE)) {
      const table = unquote(m[1]);
      hasTenantId.add(table);
      if (!protection.has(table)) protection.set(table, 'none');
      lastTouchedBy.set(table, file);
    }

    for (const m of sql.matchAll(RENAME_TABLE_RE)) {
      const from = unquote(m[1]);
      const to = unquote(m[2]);
      if (hasTenantId.delete(from)) {
        hasTenantId.add(to);
        protection.set(to, protection.get(from) ?? 'none');
        protection.delete(from);
        lastTouchedBy.set(to, file);
      }
    }

    for (const m of sql.matchAll(DROP_TABLE_RE)) {
      const table = unquote(m[1]);
      hasTenantId.delete(table);
      protection.delete(table);
      lastTouchedBy.delete(table);
    }

    // Migration 079 enables RLS in a DO-block loop over every table that HAD a
    // tenant_id column when it ran, minus a literal exclusion list. A statement
    // parser cannot see the loop body, and reading only the explicit ALTERs
    // reports ~80 already-protected tables as unprotected — a baseline that
    // wrong is worse than none, because the debt list stops meaning anything.
    // Model the loop against the tables known at this point in the replay,
    // which is exactly the set the loop's catalog query would have returned.
    const bulk = /FOR\s+rec\s+IN[\s\S]*?column_name\s*=\s*'tenant_id'[\s\S]*?LOOP/i.exec(sql);
    if (bulk) {
      const excluded = new Set<string>();
      const arr = /excluded_tables\s+TEXT\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/i.exec(sql);
      if (arr) {
        for (const q of arr[1].matchAll(/'([^']+)'/g)) excluded.add(q[1].toLowerCase());
      }
      for (const table of hasTenantId) {
        if (excluded.has(table)) continue;
        if (protection.get(table) !== 'force') protection.set(table, 'rls');
        lastTouchedBy.set(table, file);
      }
    }

    // Last statement wins, which is what makes the NO FORCE / FORCE pair used
    // for a cross-tenant maintenance write read as `force` rather than as a
    // table that lost its protection.
    for (const m of sql.matchAll(RLS_RE)) {
      const table = unquote(m[1]);
      const verb = m[2].toUpperCase().replace(/\s+/g, ' ');
      if (!hasTenantId.has(table)) continue;
      if (verb === 'FORCE') protection.set(table, 'force');
      else if (verb === 'ENABLE') {
        if (protection.get(table) !== 'force') protection.set(table, 'rls');
      } else if (verb === 'NO FORCE') protection.set(table, 'rls');
      else if (verb === 'DISABLE') protection.set(table, 'none');
      lastTouchedBy.set(table, file);
    }
  }

  return [...hasTenantId]
    .sort()
    .map((table) => ({
      table,
      protection: protection.get(table) ?? 'none',
      lastTouchedBy: lastTouchedBy.get(table) ?? '',
    }));
}
