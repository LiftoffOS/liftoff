// Schema invariants for the DAG child executor — parses the migration corpus (no
// DB required) and asserts the decouplings the executor DEPENDS ON are present.
//
// These guard the two production-only bugs that mocked coordinator tests can't
// catch (the pool is mocked, so FK/NOT-NULL violations never surface in unit
// tests): C1 (child_tasks parent/workflow are free UUIDs) and C2 (dependency
// edges store child_tasks ids, so workflow_task_dependencies must not FK to
// workflow_tasks). If a future migration/refactor re-introduces either FK, the
// executor throws on the first real spawn_task_graph call — these tests fail loudly
// first.

import * as fs from 'fs';
import * as path from 'path';

function loadMigrationSql(): string {
  const dir = path.join(__dirname, '../../../migrations');
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => fs.readFileSync(path.join(dir, f), 'utf-8'))
    .join('\n');
}

/** True if the corpus contains a name-agnostic DO-block that drops foreign-key
 *  constraints on `table`'s columns, covering every column in `cols`. Matches the
 *  migration-305 pattern: a block filtering `rel.relname = '<table>'`,
 *  `con.contype = 'f'`, and `att.attname IN (...cols)`. */
function dropsForeignKeysOn(sql: string, table: string, cols: string[]): boolean {
  const blockRe = /DO \$\$[\s\S]*?END \$\$;/g;
  for (const block of sql.match(blockRe) ?? []) {
    const isThisTable = block.includes(`rel.relname = '${table}'`);
    const isFk = block.includes("con.contype = 'f'");
    const coversCols = cols.every(c => new RegExp(`att\\.attname[\\s\\S]*?'${c}'`).test(block));
    const dropsFk = /DROP CONSTRAINT/i.test(block);
    if (isThisTable && isFk && coversCols && dropsFk) return true;
  }
  return false;
}

describe('DAG schema invariants', () => {
  const sql = loadMigrationSql();

  it('C1: child_tasks FKs on parent_task_id + workflow_id are dropped (free-UUID grouping keys)', () => {
    expect(dropsForeignKeysOn(sql, 'child_tasks', ['parent_task_id', 'workflow_id'])).toBe(true);
  });

  it('C1: child_tasks.workflow_id NOT NULL is relaxed', () => {
    expect(/ALTER TABLE child_tasks\s+ALTER COLUMN workflow_id DROP NOT NULL/i.test(sql)).toBe(true);
  });

  it('C2: workflow_task_dependencies FKs on task_id + depends_on_task_id are dropped (they store child_tasks ids)', () => {
    expect(dropsForeignKeysOn(sql, 'workflow_task_dependencies', ['task_id', 'depends_on_task_id'])).toBe(true);
  });

  it('C2: the ON CONFLICT dedup target still exists (unique on task_id, depends_on_task_id)', () => {
    // The executor persists edges with ON CONFLICT DO NOTHING; the UNIQUE must survive.
    expect(/UNIQUE\s*\(\s*task_id\s*,\s*depends_on_task_id\s*\)/i.test(sql)).toBe(true);
  });

  it('child_tasks.agent_id is nullable (NULL = inherit from parent agent)', () => {
    expect(/ALTER TABLE child_tasks\s+ALTER COLUMN agent_id DROP NOT NULL/i.test(sql)).toBe(true);
  });

  it('child_tasks has the columns the repository inserts (objective, input_data, task_type)', () => {
    for (const col of ['objective', 'input_data', 'task_type']) {
      expect(new RegExp(`child_tasks ADD COLUMN[\\s\\S]*?${col}`, 'i').test(sql)).toBe(true);
    }
  });
});
