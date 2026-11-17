// Finding schema that nothing can reach.
//
// The sibling of reachability.ts, for the same defect one layer down. That one
// catches an export with no caller. This catches a TABLE with no query — and
// the two failures that motivated it were both governance-shaped, which is what
// makes them worse than ordinary dead weight:
//
//   * `internal_agents.delegates` — accepted by the API, validated on write
//     (the referenced external agent must exist), versioned, published to the
//     runtime, mirrored into the runtime's own column, and read by nothing. Its
//     fields are `endpoint`, `auth.credentialSecretName`, a `tools` subset and
//     HITL `categories`, so an operator filling it in believes they granted an
//     endpoint with a credential and restricted the tool surface. They granted
//     nothing. Its twin `engine_config`, added in the same commit for the same
//     abstraction, WAS dropped (migration 265) once it read nowhere.
//
//     Both were dropped in migration 335.
//
//     KNOWN LIMITATION, kept because the class outlives the instance: THIS
//     CHECKER COULD NEVER HAVE CAUGHT `delegates`. Reachability here means
//     "some file in this repo names it", and `delegates` was named plenty — the
//     API read it back out to serve it. Its defect was one repo further on: the
//     value was published to the tenant runtime and the runtime ignored it.
//     Catching that needs a cross-repo publish-but-never-consume check with both
//     trees in hand, which does not belong in one repo's test suite. Anything
//     with that shape is still invisible here; `scripts/audit-unreferenced-schema.ts`
//     is the manual fallback.
//
//   * `agent_quotas` — per-agent `max_retries` / `max_child_tasks` /
//     `max_workflow_depth` / `max_external_writes_per_interval`. The runtime
//     dropped its half in migration 078 ("Credits are the only limiter; all
//     max* capacity checks removed from admission"). This half survived.
//
// Both were left behind by the same mechanism: a concept is retired, one repo's
// artifact is dropped, the other repo's is forgotten. Nothing was watching.
//
// FALSE POSITIVES ARE THE HARD PART. A first hand-written pass reported 50
// dead tables. It was wrong twice over — it counted `CREATE TABLE ai_teams` and
// never saw `ALTER TABLE ai_teams RENAME TO internal_agents`, so it declared
// the product's core table dead; and it counted partition children as tables in
// their own right. Four classes have to be excluded or this is noise:
//
//   1. RENAMED AWAY — the old name is not a table any more; the new one is.
//   2. PARTITIONS — reached through the parent, never named in code.
//   3. MIGRATION BACKUPS — `*_pre_NNN` / `*_backfill_NNN`, deliberate snapshots.
//   4. CROSS-SERVICE — schema this repo provisions and another service reads.
//      Not detectable from here, so these live in the baseline with a reason.

import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS_DIR = 'migrations';
const SOURCE_ROOT = 'src';

/** `*_pre_197`, `*_backfill_198` — a snapshot a migration took of a table it
 *  was about to rewrite. Intentionally unreferenced; the migration number in
 *  the name is the whole audit trail. */
const MIGRATION_BACKUP_RE = /_(?:pre|backfill|bak|old|backup)_?\d+$/;

export interface UnreferencedTable {
  table: string;
  /** Migration file that created it, for the reviewer. */
  createdIn: string;
}

export interface UnreferencedColumn {
  table: string;
  column: string;
  /** Migration file that added it, for the reviewer. */
  createdIn: string;
}

/** `table::column`, the stable key the baseline lists. */
export function columnKey(c: UnreferencedColumn): string {
  return `${c.table}::${c.column}`;
}

/**
 * Column names too generic to attribute. `id` or `status` appears in every
 * file for unrelated reasons, so "something in src/ says `status`" proves
 * nothing about whether THIS table's status column is read. Excluding them
 * loses coverage on the columns least likely to be forgotten, and keeps the
 * signal on the ones — `delegates`, `engine_config` — that carry a feature's
 * name and are therefore the ones that rot.
 */
const UNATTRIBUTABLE_COLUMN_NAMES = new Set([
  'id', 'name', 'type', 'status', 'value', 'data', 'config', 'content', 'source',
  'metadata', 'version', 'kind', 'label', 'title', 'description', 'reason',
  'created_at', 'updated_at', 'deleted_at', 'tenant_id', 'agent_id', 'account_id',
  'user_id', 'thread_id', 'message_id', 'invocation_id', 'expires_at', 'enabled',
]);

function readMigrations(repoRoot: string): Array<{ file: string; sql: string }> {
  const dir = path.join(repoRoot, MIGRATIONS_DIR);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ file: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

/**
 * Tables that exist after every migration has run.
 *
 * Order matters: a table can be created, renamed, and dropped across different
 * files, so the statements are replayed in migration order rather than
 * collected into sets. Doing it with sets is how the rename class was missed.
 */
export function liveTables(repoRoot: string): Map<string, string> {
  // table -> migration file it was created in (or renamed into)
  const live = new Map<string, string>();
  const partitions = new Set<string>();

  for (const { file, sql } of readMigrations(repoRoot)) {
    // Strip line comments so a `-- DROP TABLE foo` note is not read as a drop.
    const body = sql.replace(/--[^\n]*/g, '');

    for (const m of body.matchAll(
      /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)([\s\S]{0,200}?)(?:\(|;)/gi,
    )) {
      const table = m[1].toLowerCase();
      if (/PARTITION\s+OF/i.test(m[2] ?? '')) {
        partitions.add(table);
        continue;
      }
      live.set(table, file);
    }
    for (const m of body.matchAll(
      /ALTER TABLE(?:\s+IF EXISTS)?\s+([a-z_][a-z0-9_]*)\s+RENAME TO\s+([a-z_][a-z0-9_]*)/gi,
    )) {
      const from = m[1].toLowerCase();
      const to = m[2].toLowerCase();
      live.set(to, live.get(from) ?? file);
      live.delete(from);
    }
    for (const m of body.matchAll(
      /DROP TABLE(?:\s+IF EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
    )) {
      live.delete(m[1].toLowerCase());
      partitions.delete(m[1].toLowerCase());
    }
  }

  for (const p of partitions) live.delete(p);
  for (const t of [...live.keys()]) {
    if (MIGRATION_BACKUP_RE.test(t)) live.delete(t);
  }
  return live;
}

/**
 * Files that NAME tables in order to inspect them, and so must not count as
 * consumers. Same exclusion the export checker applies to tests, and for the
 * same reason: a file whose purpose is to audit a thing is not evidence that
 * anything uses it.
 *
 * Empty today. It exists because this gate failed on its own first run: a census
 * script named `agent_quotas` in a count query, which made a table with no
 * reader look reachable. That script is gone (its targets were dropped in
 * migration 335), but a checker its own tooling can defeat is not a checker, so
 * the seam stays for the next one.
 */
const INSPECTION_ONLY_FILES = new Set<string>([]);

function productionSources(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        if (entry.name === '__tests__') continue;
        walk(p);
      } else if (
        entry.name.endsWith('.ts')
        && !entry.name.endsWith('.test.ts')
        && !entry.name.endsWith('.spec.ts')
      ) {
        if (INSPECTION_ONLY_FILES.has(path.relative(repoRoot, p))) continue;
        out.push(p);
      }
    }
  };
  walk(path.join(repoRoot, SOURCE_ROOT));
  return out;
}

/**
 * Live tables that no production source names.
 *
 * Matching is by bare identifier rather than by parsing SQL, deliberately: a
 * table reached through dynamic SQL, an ORM, or a string constant still names
 * itself somewhere, and a false NEGATIVE here is worse than a false positive
 * that costs one baseline line with a reason attached.
 *
 * Tests are excluded from the "who references it" side for the same reason as
 * the export checker: a table only its own test touches is exactly the defect.
 */
export function findUnreferencedTables(repoRoot: string): UnreferencedTable[] {
  const live = liveTables(repoRoot);
  const blob = productionSources(repoRoot)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

  // One pass over the corpus rather than one grep per table: 200 tables x a
  // full-tree scan each is slow enough to discourage running the check.
  const named = new Set(blob.match(/[a-z_][a-z0-9_]*/gi)?.map((s) => s.toLowerCase()) ?? []);

  const out: UnreferencedTable[] = [];
  for (const [table, createdIn] of live) {
    if (!named.has(table)) out.push({ table, createdIn });
  }
  return out.sort((a, b) => a.table.localeCompare(b.table));
}

/**
 * Columns ADDED to a live table that no production source names.
 *
 * This is the half that matters most, and the half a table-only checker misses
 * entirely: `internal_agents.delegates` is a COLUMN on the most-referenced
 * table in the schema, so no amount of table-level checking would ever have
 * found it. It was accepted by the API, validated on write, versioned,
 * published and mirrored — and read by nothing, while reading to an operator
 * like a live grant of an endpoint plus a credential.
 *
 * Scope is deliberately `ALTER TABLE ... ADD COLUMN` only, not columns declared
 * inside `CREATE TABLE`. A column added later is a feature bolted onto an
 * existing concept, which is the shape that gets orphaned when the concept is
 * retired; parsing full CREATE TABLE bodies would multiply the false-positive
 * surface for the columns least likely to rot.
 */
export function findUnreferencedColumns(repoRoot: string): UnreferencedColumn[] {
  const live = liveTables(repoRoot);
  const blob = productionSources(repoRoot)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const named = new Set(blob.match(/[a-z_][a-z0-9_]*/gi)?.map((s) => s.toLowerCase()) ?? []);

  // table -> column -> migration file that added it. A column added and later
  // dropped must not be reported, so replay in order like liveTables does.
  const added = new Map<string, Map<string, string>>();
  for (const { file, sql } of readMigrations(repoRoot)) {
    const body = sql.replace(/--[^\n]*/g, '');
    for (const m of body.matchAll(
      /ALTER TABLE(?:\s+IF EXISTS)?\s+([a-z_][a-z0-9_]*)([\s\S]*?);/gi,
    )) {
      const table = m[1].toLowerCase();
      const clause = m[2] ?? '';
      for (const add of clause.matchAll(
        /ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
      )) {
        if (!added.has(table)) added.set(table, new Map());
        added.get(table)!.set(add[1].toLowerCase(), file);
      }
      for (const drop of clause.matchAll(
        /DROP COLUMN(?:\s+IF EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
      )) {
        added.get(table)?.delete(drop[1].toLowerCase());
      }
    }
  }

  const out: UnreferencedColumn[] = [];
  for (const [table, columns] of added) {
    // A column on a table that no longer exists is already gone.
    if (!live.has(table)) continue;
    for (const [column, createdIn] of columns) {
      if (UNATTRIBUTABLE_COLUMN_NAMES.has(column)) continue;
      if (named.has(column)) continue;
      // A snake_case column is often read through its camelCase mapping and
      // never spelled in SQL — `observation_count` surfaces as
      // `observationCount`. Both spellings count as a reference.
      const camel = column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      if (named.has(camel.toLowerCase())) continue;
      out.push({ table, column, createdIn });
    }
  }
  return out.sort((a, b) => columnKey(a).localeCompare(columnKey(b)));
}
