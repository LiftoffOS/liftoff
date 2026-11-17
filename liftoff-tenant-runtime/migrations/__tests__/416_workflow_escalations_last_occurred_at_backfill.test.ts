// Migration 416 — every escalation row carries last_occurred_at from its first
// occurrence.
//
// createEscalation set last_occurred_at only on the dedupe UPDATE, so a fresh
// row carried NULL until its second occurrence; migration 287 backfilled only
// the rows that existed when the column was added. This executes the real
// statement against Postgres and pins that a NULL row is backfilled from
// created_at, a row that already has a value is left alone, and a re-run is a
// no-op.
//
// Skipped unless TEST_DATABASE_URL is set (the same guard every other migration
// test uses). The migration is applied by the harness before this runs, so the
// rows seeded below are inserted with NULL and re-run through the statement.

import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(__dirname, '..', '416_workflow_escalations_last_occurred_at_backfill.sql'),
  'utf8',
);

const TENANT = '00000000-0000-4000-8000-00000000c416';
const AGENT = '00000000-0000-4000-8000-00000000a416';
const WORKFLOW = '00000000-0000-4000-8000-00000000f416';
const TASK = '00000000-0000-4000-8000-00000000e416';
const NULL_ROW = '00000000-0000-4000-8000-000000000416';
const SET_ROW = '00000000-0000-4000-8000-000000001416';

describeFn('migration 416 — last_occurred_at backfill', () => {
  let pool: Pool;

  async function cleanup() {
    await pool.query('DELETE FROM workflow_escalations WHERE tenant_id = $1', [TENANT]);
    await pool.query('DELETE FROM workflow_tasks WHERE id = $1', [TASK]);
    await pool.query('DELETE FROM workflows WHERE id = $1', [WORKFLOW]);
    await pool.query('DELETE FROM agents WHERE id = $1', [AGENT]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await cleanup();
    // workflows.agent_id is a foreign key, so the escalation's parent chain
    // needs a real agent row: the two columns with no default, the rest theirs.
    await pool.query(
      `INSERT INTO agents (id, tenant_id, name) VALUES ($1, $2, 'mig416')`,
      [AGENT, TENANT],
    );
    await pool.query(
      `INSERT INTO workflows (id, tenant_id, agent_id, objective, status) VALUES ($1, $2, $3, 'x', 'escalated')`,
      [WORKFLOW, TENANT, AGENT],
    );
    await pool.query(
      `INSERT INTO workflow_tasks (id, workflow_id, agent_id, status, idempotency_key) VALUES ($1, $2, $3, 'escalated', 'mig416')`,
      [TASK, WORKFLOW, AGENT],
    );
    // A row the old INSERT would have written: created, never bumped.
    await pool.query(
      `INSERT INTO workflow_escalations (id, workflow_id, task_id, agent_id, tenant_id, reason, status, kind, created_at, last_occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'never bumped', 'pending', 'system_internal', '2026-09-01T00:00:00Z', NULL)`,
      [NULL_ROW, WORKFLOW, TASK, AGENT, TENANT],
    );
    // A row that was bumped: its value must survive the backfill untouched.
    await pool.query(
      `INSERT INTO workflow_escalations (id, workflow_id, task_id, agent_id, tenant_id, reason, status, kind, created_at, last_occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'bumped', 'pending', 'system_internal', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')`,
      [SET_ROW, WORKFLOW, TASK, AGENT, TENANT],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  it('backfills a NULL last_occurred_at from created_at and leaves a set value alone', async () => {
    await pool.query(MIGRATION);
    const { rows } = await pool.query<{ id: string; created_at: Date; last_occurred_at: Date | null }>(
      `SELECT id, created_at, last_occurred_at FROM workflow_escalations WHERE tenant_id = $1 ORDER BY id`,
      [TENANT],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(NULL_ROW)?.last_occurred_at?.toISOString()).toBe(byId.get(NULL_ROW)?.created_at.toISOString());
    expect(byId.get(SET_ROW)?.last_occurred_at?.toISOString()).toBe('2026-09-02T00:00:00.000Z');
  });

  it('is idempotent: a re-run changes nothing', async () => {
    const before = await pool.query(`SELECT id, last_occurred_at FROM workflow_escalations WHERE tenant_id = $1 ORDER BY id`, [TENANT]);
    await pool.query(MIGRATION);
    const after = await pool.query(`SELECT id, last_occurred_at FROM workflow_escalations WHERE tenant_id = $1 ORDER BY id`, [TENANT]);
    expect(after.rows).toEqual(before.rows);
  });

  it('leaves no NULL last_occurred_at anywhere', async () => {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM workflow_escalations WHERE last_occurred_at IS NULL`);
    expect(Number(rows[0].n)).toBe(0);
  });
});
