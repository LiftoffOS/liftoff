// The schema facts the run-identity rule is built on, checked against the
// migrated database rather than assumed from a migration file.
//
// The rule: a run's workflow/task id is a well-formed uuid or absent; a blank
// is never written. Whether "absent" may become NULL or must become a real id
// depends on the column, and that is exactly what a migration can change
// (081 dropped NOT NULL on usage_events.workflow_id; 031 on the approval
// columns). These assertions pin the current answers so a future migration
// that tightens a column fails here, next to the code that relies on it.
//
// Skipped unless TEST_DATABASE_URL points at a migrated database.

import { Pool } from 'pg';

const pool = process.env.TEST_DATABASE_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_URL })
  : (undefined as unknown as Pool);

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function nullable(table: string, column: string): Promise<boolean> {
  const r = await pool.query<{ is_nullable: string; data_type: string }>(
    `SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0].data_type).toBe('uuid');
  return r.rows[0].is_nullable === 'YES';
}

async function failsWith(sql: string, params: unknown[]): Promise<string> {
  try {
    await pool.query(sql, params);
    return 'no-error';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describeFn('run identity against the migrated schema', () => {
  afterAll(async () => { await pool.end(); });

  describe('nullable sinks: absence becomes NULL and the record is kept', () => {
    it('usage_events.workflow_id and action_id are nullable uuids', async () => {
      expect(await nullable('usage_events', 'workflow_id')).toBe(true);
      expect(await nullable('usage_events', 'action_id')).toBe(true);
    });

    it('hitl_approval_requests.workflow_id and task_id are nullable uuids', async () => {
      expect(await nullable('hitl_approval_requests', 'workflow_id')).toBe(true);
      expect(await nullable('hitl_approval_requests', 'task_id')).toBe(true);
    });

    it('a blank is rejected by the column, which is why it must never be written', async () => {
      // 22P02 = invalid_text_representation: the exact failure a blank produces.
      expect(await failsWith(
        `INSERT INTO usage_events (tenant_id, agent_id, workflow_id, action_id, event_type, credits, metadata)
         VALUES ($1, $2, $3, $4, 'llm_step', 0, '{}')`,
        ['00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e002', '', null],
      )).toBe('22P02');
    });
  });

  describe('required sinks: absence must become a real id', () => {
    it('workflow_escalations.workflow_id and task_id are NOT NULL uuids', async () => {
      expect(await nullable('workflow_escalations', 'workflow_id')).toBe(false);
      expect(await nullable('workflow_escalations', 'task_id')).toBe(false);
    });

    it('workflows.id is a NOT NULL uuid (a primary key)', async () => {
      expect(await nullable('workflows', 'id')).toBe(false);
    });
  });
});
