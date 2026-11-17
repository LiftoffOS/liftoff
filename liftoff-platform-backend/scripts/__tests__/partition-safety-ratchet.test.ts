// Every range-partitioned table must be able to survive running out of runway.
//
// Partitions here are hand-written into migrations. When the list ends,
// Postgres raises 23514 on insert rather than inventing a partition, and every
// writer in this estate catches that and lets the request succeed — so the rows
// are lost with no failing request, no alert and no exception. That is not
// hypothetical: workforce_audit_log lost days of audit writes exactly this way,
// and tenant_resource_usage sat past its last partition for five weeks.
//
// A DEFAULT partition converts silent loss into rows parked somewhere
// recoverable. It is a net, not a mechanism — scheduled maintenance still has
// to create each month — but it is the one property that makes the failure
// survivable, and it costs a single statement.
//
// This fence re-derives partitioned parents from migrations/*.sql with no
// database, and fails when one has neither a DEFAULT partition nor an entry in
// the exemption list below.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

// Parents that deliberately have no DEFAULT partition, each with the reason.
// Adding a line here should be rare enough that a reviewer asks why.
const EXEMPT: Record<string, string> = {};

interface Parent {
  table: string;
  migration: string;
}

function readMigrations(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }));
}

function uncommented(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

// `CREATE TABLE x (...) PARTITION BY RANGE (col)` — the shape this repo uses.
//
// Replays CREATE and DROP in migration order, so a table that a later migration
// retires stops being something this fence demands a DEFAULT partition for.
// Without that, dropping a dead partitioned table fails the check that exists to
// protect live ones.
//
// Commented-out DDL is skipped: migration 011 carries a `-- ) PARTITION BY
// RANGE (created_at);` line describing a table it never created.
export function findPartitionedParents(
  migrations: Array<{ file: string; sql: string }>,
): Parent[] {
  const live = new Map<string, string>();
  for (const { file, sql } of migrations) {
    const body = uncommented(sql);

    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\b[\s\S]*?PARTITION\s+BY\s+RANGE/gi;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(body)) !== null) live.set(m[1], file);

    const dropRe = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    while ((m = dropRe.exec(body)) !== null) live.delete(m[1]);
  }
  return Array.from(live, ([table, migration]) => ({ table, migration }));
}

// `CREATE TABLE x_default PARTITION OF x DEFAULT;`
export function findDefaultPartitions(
  migrations: Array<{ file: string; sql: string }>,
): Set<string> {
  const covered = new Set<string>();
  for (const { sql } of migrations) {
    const live = uncommented(sql);
    const re = /PARTITION\s+OF\s+([a-z_][a-z0-9_]*)\s+DEFAULT/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(live)) !== null) covered.add(m[1]);
  }
  return covered;
}

describe('every partitioned table can survive its runway ending', () => {
  const migrations = readMigrations();

  it('finds the partitioned parents this repo declares', () => {
    // A guard on the guard: if the parse silently stops matching, the fence
    // passes vacuously and protects nothing.
    const parents = findPartitionedParents(migrations).map((p) => p.table);
    expect(parents).toContain('cost_attribution_events');
  });

  it('forgets a partitioned table a later migration drops', () => {
    // Otherwise retiring a dead partitioned table fails the check that exists
    // to protect the live ones.
    const parents = findPartitionedParents([
      { file: '001.sql', sql: 'CREATE TABLE gone (id UUID, at TIMESTAMPTZ) PARTITION BY RANGE (at);' },
      { file: '002.sql', sql: 'DROP TABLE IF EXISTS gone CASCADE;' },
    ]);
    expect(parents).toEqual([]);
  });

  it('ignores commented-out partition DDL', () => {
    const parents = findPartitionedParents([
      { file: 'x.sql', sql: '-- CREATE TABLE ghost (\n--   id UUID\n-- ) PARTITION BY RANGE (created_at);' },
    ]);
    expect(parents).toEqual([]);
  });

  it('reads a DEFAULT partition declaration', () => {
    const covered = findDefaultPartitions([
      { file: 'x.sql', sql: 'CREATE TABLE foo_default PARTITION OF foo DEFAULT;' },
    ]);
    expect(covered.has('foo')).toBe(true);
  });

  it('reports a partitioned parent that has no DEFAULT partition', () => {
    // Proves the fence bites. Without this, a parse that quietly stops matching
    // leaves the check passing over an empty set and protecting nothing.
    const synthetic = [
      { file: 'fake.sql', sql: 'CREATE TABLE naked (id UUID, at TIMESTAMPTZ) PARTITION BY RANGE (at);' },
    ];
    const parents = findPartitionedParents(synthetic).map((p) => p.table);
    const covered = findDefaultPartitions(synthetic);

    expect(parents).toEqual(['naked']);
    expect(covered.has('naked')).toBe(false);
  });

  it('gives every partitioned parent a DEFAULT partition or a documented exemption', () => {
    const parents = findPartitionedParents(migrations);
    const covered = findDefaultPartitions(migrations);

    const unprotected = parents
      .filter((p) => !covered.has(p.table) && !(p.table in EXEMPT))
      .map((p) => `  ${p.table}  (${p.migration})`);

    expect({
      unprotected,
      hint:
        unprotected.length === 0
          ? 'ok'
          : 'These tables lose rows silently when their partitions run out. Add ' +
            '`CREATE TABLE <t>_default PARTITION OF <t> DEFAULT;` in a migration, ' +
            'or add the table to EXEMPT with the reason it cannot have one.',
    }).toEqual({ unprotected: [], hint: 'ok' });
  });
});
