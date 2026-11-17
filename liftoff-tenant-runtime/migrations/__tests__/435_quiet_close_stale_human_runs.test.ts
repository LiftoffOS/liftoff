// Migration 435 — human-triggered runs stuck for more than 7 days are closed,
// quietly: marked failed/stalled with nothing for billing, Activity or webhooks.
//
// Executes the real file against a migrated Postgres, then runs both billing
// reconcilers' own queries over the result: neither may pick up a row this
// closed, while a control row each proves the query would have.
//
// Everything happens in one transaction that is rolled back. The migration is
// not tenant-scoped, so committing would close other suites' old fixtures (the
// stalled-human-runs suite seeds an 8-day-old stuck run on purpose); rolled
// back, a concurrent suite at most waits on a row lock.
//
// Skipped unless TEST_DATABASE_URL is set (the same guard every other migration
// test uses).

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

let mockClient: Client;
jest.mock('../../src/infrastructure/database', () => ({
  getPoolForService: () => mockClient,
  getPool: () => mockClient,
  get pool() { return mockClient; },
}));
jest.mock('../../src/infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
const mockPublish = jest.fn<Promise<string>, unknown[]>(async () => 'msg-id');
jest.mock('../../src/infrastructure/pubsub', () => ({
  publisher: { publish: (...a: unknown[]) => mockPublish(...a) },
}));
jest.mock('../../src/invocations/service', () => ({
  invocationsService: { markBillingQueued: jest.fn(async () => undefined) },
}));

import { reconcileStalledBilling } from '../../src/scheduling/stalled-run-billing-reconciler';
import { runBillingQueuedReconciliation } from '../../src/jobs/billing-queued-reconciliation';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '..', '435_quiet_close_stale_human_runs.sql'), 'utf8');

const TENANT = '00000000-0000-4000-8000-00000000c435';
const USER = '00000000-0000-4000-8000-00000000c4ff';
const AGENT = {
  old: '00000000-0000-4000-8000-000000c43501', // one stuck run, nothing else
  noState: '00000000-0000-4000-8000-000000c43502', // stuck, never wrote a run state
  waiting: '00000000-0000-4000-8000-000000c43503', // WAITING_FOR_HUMAN, not ours to reset
  busy: '00000000-0000-4000-8000-000000c43504', // an old stuck run beside a recent one
  guarded: '00000000-0000-4000-8000-000000c43505', // old runs that must be left alone
};
const INV = {
  oldStuck: '00000000-0000-4000-8000-000000c43601',
  oldNoState: '00000000-0000-4000-8000-000000c43602',
  waitingOld: '00000000-0000-4000-8000-000000c43603',
  busyOld: '00000000-0000-4000-8000-000000c43604',
  busyRecent: '00000000-0000-4000-8000-000000c43605',
  pendingResume: '00000000-0000-4000-8000-000000c43606',
  pendingApproval: '00000000-0000-4000-8000-000000c43607',
  interrupted: '00000000-0000-4000-8000-000000c43608',
  progressing: '00000000-0000-4000-8000-000000c43609',
  cron: '00000000-0000-4000-8000-000000c4360a',
  finished: '00000000-0000-4000-8000-000000c4360b',
  // Billing controls: rows each reconciler SHOULD pick up.
  ctrlStalled: '00000000-0000-4000-8000-000000c4360c',
  ctrlQueued: '00000000-0000-4000-8000-000000c4360d',
};
const CLOSED = [INV.oldStuck, INV.oldNoState, INV.waitingOld, INV.busyOld];
const UNTOUCHED = [INV.busyRecent, INV.pendingResume, INV.pendingApproval, INV.interrupted, INV.progressing, INV.cron];
const THREAD = '00000000-0000-4000-8000-000000c43701';
const DAY = 24 * 60;

describeFn('migration 435 — stale human runs are closed quietly', () => {
  const q = (sql: string, params: unknown[] = []) => mockClient.query(sql, params);

  async function seedRun(o: {
    id: string; agent: string; startedMinAgo: number; heartbeatMinAgo?: number;
    runState?: 'running' | 'interrupted'; triggeredBy?: 'human' | 'cron';
  }) {
    const human = (o.triggeredBy ?? 'human') === 'human';
    await q(
      `INSERT INTO invocations (id, tenant_id, agent_id, triggered_by, provider, started_at,
                                triggered_by_user_id, accountable_user_id)
       VALUES ($1, $2, $3, $4, 'anthropic', NOW() - ($5::int * INTERVAL '1 minute'), $6, $6)`,
      [o.id, TENANT, o.agent, o.triggeredBy ?? 'human', o.startedMinAgo, human ? USER : null],
    );
    if (o.heartbeatMinAgo !== undefined) {
      await q(
        `INSERT INTO agent_run_states (invocation_id, tenant_id, agent_id, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'), NOW() - ($6::int * INTERVAL '1 minute'))`,
        [o.id, TENANT, o.agent, JSON.stringify({ status: o.runState ?? 'running' }), o.startedMinAgo, o.heartbeatMinAgo],
      );
    }
  }

  async function usage(invocationId: string) {
    await q(
      `INSERT INTO llm_usage_log (provider, model, input_tokens, output_tokens, success, tenant_id, agent_id, invocation_id)
       VALUES ('anthropic', 'claude-sonnet-4.5', 120000, 8000, true, $1, $2, $3)`,
      [TENANT, AGENT.old, invocationId],
    );
  }

  const invocation = async (id: string) => (await q(
    `SELECT outcome, failure_class, error_message, completed_at, reconciliation_status, billing_queued
       FROM invocations WHERE id = $1`, [id])).rows[0];
  const runState = async (id: string) =>
    (await q(`SELECT state->>'status' AS s FROM agent_run_states WHERE invocation_id = $1`, [id])).rows[0]?.s;
  const runtimeStatus = async (id: string) =>
    (await q(`SELECT runtime_status FROM agents WHERE id = $1`, [id])).rows[0].runtime_status;
  /** Everything this suite seeded, for comparing before and after a re-run. */
  const snapshot = async () => ({
    invocations: (await q(`SELECT * FROM invocations WHERE tenant_id = $1 ORDER BY id`, [TENANT])).rows,
    runStates: (await q(`SELECT * FROM agent_run_states WHERE tenant_id = $1 ORDER BY invocation_id`, [TENANT])).rows,
    signals: (await q(`SELECT * FROM agent_invocation_signals WHERE invocation_id = ANY($1::uuid[]) ORDER BY id`, [Object.values(INV)])).rows,
    locks: (await q(`SELECT * FROM chat_turn_locks WHERE tenant_id = $1`, [TENANT])).rows,
    agents: (await q(`SELECT * FROM agents WHERE tenant_id = $1 ORDER BY id`, [TENANT])).rows,
  });

  beforeAll(async () => {
    mockClient = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await mockClient.connect();
    await q('BEGIN');
    await q(`INSERT INTO tenants (id, external_id) VALUES ($1, 'mig435-fixture')`, [TENANT]);
    for (const [key, id] of Object.entries(AGENT)) {
      await q(
        `INSERT INTO agents (id, tenant_id, name, lifecycle, runtime_status) VALUES ($1, $2, $3, 'ACTIVE', $4)`,
        [id, TENANT, `mig435-${key}`, key === 'waiting' ? 'WAITING_FOR_HUMAN' : 'RUNNING'],
      );
    }

    // The target shape: a chat run hung for weeks, with the Stop that never reached it,
    // the thread lock it still holds, and real LLM spend in llm_usage_log.
    await seedRun({ id: INV.oldStuck, agent: AGENT.old, startedMinAgo: 60 * DAY, heartbeatMinAgo: 60 * DAY });
    await q(`INSERT INTO agent_invocation_signals (invocation_id, signal_kind, payload) VALUES ($1, 'abort', '{}')`, [INV.oldStuck]);
    await q(`INSERT INTO agent_invocation_signals (invocation_id, signal_kind, payload) VALUES ($1, 'user_message', '{}')`, [INV.oldStuck]);
    await q(`INSERT INTO chat_turn_locks (tenant_id, thread_id, acquired_by_invocation_id) VALUES ($1, $2, $3)`,
      [TENANT, THREAD, INV.oldStuck]);
    await usage(INV.oldStuck);

    await seedRun({ id: INV.oldNoState, agent: AGENT.noState, startedMinAgo: 90 * DAY });
    await seedRun({ id: INV.waitingOld, agent: AGENT.waiting, startedMinAgo: 60 * DAY, heartbeatMinAgo: 60 * DAY });

    await seedRun({ id: INV.busyOld, agent: AGENT.busy, startedMinAgo: 20 * DAY, heartbeatMinAgo: 20 * DAY });
    // Inside the 7 days: the sweep's to close, not this migration's.
    await seedRun({ id: INV.busyRecent, agent: AGENT.busy, startedMinAgo: DAY, heartbeatMinAgo: DAY });

    await seedRun({ id: INV.pendingResume, agent: AGENT.guarded, startedMinAgo: 20 * DAY, heartbeatMinAgo: 20 * DAY });
    await q(
      `INSERT INTO agent_scheduled_invocations
         (tenant_id, agent_id, context_ref, schedule_key, fires_at, objective, scheduled_by_invocation_id)
       VALUES ($1, $2, 'ctx', 'key-c435', NOW() + INTERVAL '1 day', 'hitl-expiry', $3)`,
      [TENANT, AGENT.guarded, INV.pendingResume],
    );
    await seedRun({ id: INV.pendingApproval, agent: AGENT.guarded, startedMinAgo: 20 * DAY, heartbeatMinAgo: 20 * DAY });
    await q(
      `INSERT INTO hitl_approval_requests
         (tenant_id, agent_id, hitl_level, pending_tool_calls, tool_calls_hash, reason, invocation_id)
       VALUES ($1, $2, 3, '[]', 'h', 'fixture', $3)`,
      [TENANT, AGENT.guarded, INV.pendingApproval],
    );
    await seedRun({ id: INV.interrupted, agent: AGENT.guarded, startedMinAgo: 20 * DAY, heartbeatMinAgo: 20 * DAY, runState: 'interrupted' });
    // Old, but heartbeated a minute ago: making progress, however long it has taken.
    await seedRun({ id: INV.progressing, agent: AGENT.guarded, startedMinAgo: 20 * DAY, heartbeatMinAgo: 1 });
    await seedRun({ id: INV.cron, agent: AGENT.guarded, startedMinAgo: 20 * DAY, heartbeatMinAgo: 20 * DAY, triggeredBy: 'cron' });
    await seedRun({ id: INV.finished, agent: AGENT.guarded, startedMinAgo: 20 * DAY });
    await q(`UPDATE invocations SET outcome = 'success', completed_at = started_at + INTERVAL '2 minutes' WHERE id = $1`, [INV.finished]);

    // Controls, completed 10 minutes ago: one the stalled-billing reconciler takes
    // (a loud stall close with spend), one billing-queued-reconciliation replays.
    for (const id of [INV.ctrlStalled, INV.ctrlQueued]) {
      await seedRun({ id, agent: AGENT.old, startedMinAgo: 40 });
    }
    await q(
      `UPDATE invocations SET outcome = 'error', failure_class = 'stalled', reconciliation_status = 'pending',
                              completed_at = NOW() - INTERVAL '10 minutes'
        WHERE id = $1`, [INV.ctrlStalled]);
    await usage(INV.ctrlStalled);
    await q(`UPDATE invocations SET outcome = 'success', completed_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [INV.ctrlQueued]);
  });

  afterAll(async () => {
    if (mockClient) {
      await q('ROLLBACK');
      await mockClient.end();
    }
  });

  it('runs', async () => {
    const { rows } = await q(MIGRATION);
    // Not tenant-scoped, so other suites' rows can add to these; ours are at least this.
    expect(Number(rows[0].closed)).toBeGreaterThanOrEqual(4);
  });

  it('closes each old stuck run as failed/stalled, marked as a bulk stale close', async () => {
    for (const id of CLOSED) {
      const inv = await invocation(id);
      expect(inv).toMatchObject({
        outcome: 'error',
        failure_class: 'stalled',
        error_message: 'stalled: closed in bulk as a stale run older than 7 days (migration 435); not billed, no Activity entry',
        reconciliation_status: 'unrecoverable',
        billing_queued: 'expired',
      });
      expect(inv.completed_at).not.toBeNull();
    }
    expect(await runState(INV.oldStuck)).toBe('failed');
    expect(await runState(INV.busyOld)).toBe('failed');
    expect(await runState(INV.oldNoState)).toBeUndefined();
  });

  it('consumes the abort, leaves a stranded message alone, and frees the thread', async () => {
    const { rows } = await q(
      `SELECT signal_kind, consumed_at FROM agent_invocation_signals WHERE invocation_id = $1`, [INV.oldStuck]);
    expect(rows.find((r) => r.signal_kind === 'abort').consumed_at).not.toBeNull();
    expect(rows.find((r) => r.signal_kind === 'user_message').consumed_at).toBeNull();
    expect((await q(`SELECT 1 FROM chat_turn_locks WHERE acquired_by_invocation_id = $1`, [INV.oldStuck])).rowCount).toBe(0);
  });

  it('leaves recent, progressing, paused, interrupted, cron and finished runs alone', async () => {
    for (const id of UNTOUCHED) {
      const inv = await invocation(id);
      expect(inv.completed_at).toBeNull();
      expect(inv.outcome).toBeNull();
    }
    expect(await runState(INV.busyRecent)).toBe('running');
    expect(await runState(INV.progressing)).toBe('running');
    expect(await runState(INV.pendingResume)).toBe('running');
    expect(await runState(INV.interrupted)).toBe('interrupted');
    expect(await invocation(INV.finished)).toMatchObject({ outcome: 'success', failure_class: null });
  });

  it('resets RUNNING to IDLE only when nothing else of the agent is open, and never any other status', async () => {
    expect(await runtimeStatus(AGENT.old)).toBe('IDLE');
    expect(await runtimeStatus(AGENT.noState)).toBe('IDLE');
    expect(await runtimeStatus(AGENT.busy)).toBe('RUNNING'); // busyRecent is still open
    expect(await runtimeStatus(AGENT.guarded)).toBe('RUNNING');
    expect(await runtimeStatus(AGENT.waiting)).toBe('WAITING_FOR_HUMAN');
  });

  it('writes no audit row and no outbox row: no Activity entry, no webhook', async () => {
    expect((await q(`SELECT 1 FROM audit_logs WHERE invocation_id = ANY($1::uuid[])`, [CLOSED])).rowCount).toBe(0);
    expect((await q(
      `SELECT 1 FROM control_plane_outbox WHERE ${CLOSED.map((_, i) => `payload::text LIKE '%' || $${i + 1} || '%'`).join(' OR ')}`,
      CLOSED,
    )).rowCount).toBe(0);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const before = await snapshot();
    await q(MIGRATION);
    expect(await snapshot()).toEqual(before);
  });

  it('the stalled-billing reconciler takes the control and none of the closed runs', async () => {
    process.env.STALLED_RUN_RECONCILER_ENABLED = '1';
    mockPublish.mockClear();
    const result = await reconcileStalledBilling(TENANT);
    const published = mockPublish.mock.calls.map((c) => (c[1] as { invocationId: string }).invocationId);
    expect(published).toContain(INV.ctrlStalled);
    expect(result.drained).toBe(1);
    for (const id of CLOSED) {
      expect(published).not.toContain(id);
      expect((await invocation(id)).reconciliation_status).toBe('unrecoverable');
    }
    // Real spend sits in llm_usage_log for oldStuck; it is still not billed.
    expect((await q(`SELECT 1 FROM llm_usage_log WHERE invocation_id = $1`, [INV.oldStuck])).rowCount).toBe(1);
  });

  it('billing-queued-reconciliation replays the control and none of the closed runs', async () => {
    mockPublish.mockClear();
    await runBillingQueuedReconciliation();
    const published = mockPublish.mock.calls.map((c) => (c[1] as { invocationId: string }).invocationId);
    expect(published).toContain(INV.ctrlQueued);
    for (const id of CLOSED) {
      expect(published).not.toContain(id);
      expect((await invocation(id)).billing_queued).toBe('expired');
    }
  });
});
