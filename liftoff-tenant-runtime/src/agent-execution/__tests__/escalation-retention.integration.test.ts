/**
 * Retention, executed rather than inspected.
 *
 * The sibling unit test asserts the SQL's shape: what it is allowed to touch,
 * that it orders oldest-first, that it marks what it sweeps. Shape cannot tell
 * you the statement PARSES, that `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
 * SKIP LOCKED)` is legal, or that the columns exist. This runs it against a real
 * Postgres and checks the rows afterwards.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated database.
 */
import { Pool } from 'pg';

const realPool = process.env.TEST_DATABASE_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_URL })
  : null;

jest.mock('../../infrastructure/database', () => ({
  getPool: () => realPool,
}));

import { runEscalationRetention, RETENTION_DAYS } from '../escalation-retention';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const TENANT = '55555555-5555-4555-8555-555555555555';
const AGENT = '66666666-6666-4666-8666-666666666666';
const WORKFLOW = '77777777-7777-4777-8777-777777777777';
const TASK = '88888888-8888-4888-8888-888888888888';

async function seedEscalation(opts: {
  id: string;
  status: 'pending' | 'resolved';
  kind: 'escalation' | 'system_internal';
  ageDays: number;
}) {
  // resolved_at is decided here rather than in a CASE over $6: reusing one
  // parameter as both a column value and a comparand leaves Postgres unable to
  // settle on its type.
  await realPool!.query(
    `INSERT INTO workflow_escalations
       (id, workflow_id, task_id, agent_id, tenant_id, reason, status, kind, created_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, 'fixture', $6, $7,
             NOW() - ($8::int * INTERVAL '1 day'),
             CASE WHEN $9::bool THEN NOW() - ($8::int * INTERVAL '1 day') ELSE NULL END)`,
    [opts.id, WORKFLOW, TASK, AGENT, TENANT, opts.status, opts.kind, opts.ageDays,
      opts.status === 'resolved'],
  );
}

async function statusOf(id: string): Promise<{ status: string; via: string | null } | null> {
  const { rows } = await realPool!.query(
    `SELECT status, resolution->>'via' AS via FROM workflow_escalations WHERE id = $1`,
    [id],
  );
  return rows[0] ? { status: rows[0].status, via: rows[0].via } : null;
}

const ID = {
  staleInternal: '00000000-0000-4000-8000-0000000000a1',
  freshInternal: '00000000-0000-4000-8000-0000000000a2',
  oldResolved: '00000000-0000-4000-8000-0000000000a3',
  recentResolved: '00000000-0000-4000-8000-0000000000a4',
  customerPending: '00000000-0000-4000-8000-0000000000a5',
};

describeFn('escalation retention against a real database', () => {
  beforeAll(async () => {
    await realPool!.query(
      `INSERT INTO tenants (id, external_id) VALUES ($1, 'retention-fixture')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT],
    );
    await realPool!.query(
      `INSERT INTO agents (id, tenant_id, name) VALUES ($1, $2, 'Retention fixture')
       ON CONFLICT (id) DO NOTHING`,
      [AGENT, TENANT],
    );
    await realPool!.query(
      `INSERT INTO workflows (id, tenant_id, agent_id, objective, status)
       VALUES ($1, $2, $3, 'retention fixture', 'completed')
       ON CONFLICT (id) DO NOTHING`,
      [WORKFLOW, TENANT, AGENT],
    );
    await realPool!.query(
      `INSERT INTO workflow_tasks (id, workflow_id, agent_id, status, idempotency_key)
       VALUES ($1, $2, $3, 'completed', 'retention-fixture')
       ON CONFLICT (id) DO NOTHING`,
      [TASK, WORKFLOW, AGENT],
    );
  });

  beforeEach(async () => {
    await realPool!.query('DELETE FROM workflow_escalations WHERE tenant_id = $1', [TENANT]);
  });

  afterAll(async () => {
    await realPool!.query('DELETE FROM workflow_escalations WHERE tenant_id = $1', [TENANT]);
    await realPool!.end();
  });

  it('runs both statements without error', async () => {
    // The bar this clears that a mock cannot: the SQL parses, the columns
    // exist, and FOR UPDATE SKIP LOCKED inside the subquery is legal here.
    await expect(runEscalationRetention()).resolves.toBeDefined();
  });

  it('sweeps a stale operator record and marks how it was closed', async () => {
    await seedEscalation({
      id: ID.staleInternal, status: 'pending', kind: 'system_internal',
      ageDays: RETENTION_DAYS + 5,
    });

    const result = await runEscalationRetention();

    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect(await statusOf(ID.staleInternal)).toEqual({
      status: 'resolved',
      via: 'retention_sweep',
    });
  });

  it('leaves an operator record still inside the window alone', async () => {
    await seedEscalation({
      id: ID.freshInternal, status: 'pending', kind: 'system_internal',
      ageDays: RETENTION_DAYS - 5,
    });

    await runEscalationRetention();

    expect(await statusOf(ID.freshInternal)).toEqual({ status: 'pending', via: null });
  });

  it('deletes a long-resolved row and keeps a recently resolved one', async () => {
    await seedEscalation({
      id: ID.oldResolved, status: 'resolved', kind: 'escalation',
      ageDays: RETENTION_DAYS + 10,
    });
    await seedEscalation({
      id: ID.recentResolved, status: 'resolved', kind: 'escalation',
      ageDays: RETENTION_DAYS - 10,
    });

    const result = await runEscalationRetention();

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await statusOf(ID.oldResolved)).toBeNull();
    expect(await statusOf(ID.recentResolved)).not.toBeNull();
  });

  it('never touches a customer-facing pending row, however old', async () => {
    // Quietly closing one of these would hide a live request from the only
    // person who could clear it.
    await seedEscalation({
      id: ID.customerPending, status: 'pending', kind: 'escalation',
      ageDays: RETENTION_DAYS + 100,
    });

    const result = await runEscalationRetention();

    expect(await statusOf(ID.customerPending)).toEqual({ status: 'pending', via: null });
    expect(result.customerFacingPending).toBeGreaterThanOrEqual(1);
  });

  it('does not delete the row it just swept, in the same pass', async () => {
    // The sweep stamps resolved_at = NOW(), so the delete pass that follows it
    // must not see that row as old enough to remove. If it did, an operator
    // record would go from unresolved straight to gone with nobody ever able to
    // read it.
    await seedEscalation({
      id: ID.staleInternal, status: 'pending', kind: 'system_internal',
      ageDays: RETENTION_DAYS + 60,
    });

    await runEscalationRetention();

    expect(await statusOf(ID.staleInternal)).toEqual({
      status: 'resolved',
      via: 'retention_sweep',
    });
  });
});
