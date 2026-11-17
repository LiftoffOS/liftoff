// Migration 309 verification — goal_ledger table for invariant subscriptions.
//
// Confirms: the table exists with the status CHECK constraint, accepts
// satisfied/violated rows, rejects any other status, and cascades on
// reactive_subscriptions delete. Skipped unless TEST_DATABASE_URL is set (the
// migration must already be applied to that database).

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const TENANT_ID = '00000000-0000-0000-0000-000000000d09';
const AGENT_ID = '00000000-0000-0000-0000-00000000ad09';

describeFn('Migration 309 — goal_ledger', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => { await pool.end(); });

  async function insertSubscription(): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO reactive_subscriptions
         (tenant_id, agent_id, label, source_kind, source_spec, objective,
          next_poll_at, poll_interval_seconds)
       VALUES ($1, $2, 'invariant-test', 'computed_metric',
               '{"connectorRef":"c","fn":"f","pollIntervalSeconds":60,"mode":"invariant"}'::jsonb,
               'keep it holding', NOW(), 60)
       RETURNING id`,
      [TENANT_ID, AGENT_ID],
    );
    return r.rows[0].id;
  }

  afterEach(async () => {
    // Cascade cleans goal_ledger via the FK.
    await pool.query(`DELETE FROM reactive_subscriptions WHERE tenant_id = $1`, [TENANT_ID]);
  });

  it('accepts satisfied and violated rows', async () => {
    const subId = await insertSubscription();
    await pool.query(
      `INSERT INTO goal_ledger (subscription_id, tenant_id, agent_id, value, status, escalated)
       VALUES ($1,$2,$3, 50, 'satisfied', false), ($1,$2,$3, 150, 'violated', true)`,
      [subId, TENANT_ID, AGENT_ID],
    );
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM goal_ledger WHERE subscription_id = $1`,
      [subId],
    );
    expect(Number(rows[0].count)).toBe(2);
  });

  it('rejects a status outside the CHECK constraint', async () => {
    const subId = await insertSubscription();
    await expect(
      pool.query(
        `INSERT INTO goal_ledger (subscription_id, tenant_id, agent_id, status)
         VALUES ($1,$2,$3,'unknown')`,
        [subId, TENANT_ID, AGENT_ID],
      ),
    ).rejects.toThrow();
  });

  it('cascades ledger rows when the subscription is deleted', async () => {
    const subId = await insertSubscription();
    await pool.query(
      `INSERT INTO goal_ledger (subscription_id, tenant_id, agent_id, status)
       VALUES ($1,$2,$3,'violated')`,
      [subId, TENANT_ID, AGENT_ID],
    );
    await pool.query(`DELETE FROM reactive_subscriptions WHERE id = $1`, [subId]);
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM goal_ledger WHERE subscription_id = $1`,
      [subId],
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});
