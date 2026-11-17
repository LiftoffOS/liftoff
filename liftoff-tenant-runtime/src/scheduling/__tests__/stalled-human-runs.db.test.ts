/**
 * The human-run close, executed rather than inspected.
 *
 * The unit suite pins the SQL's shape. This runs it against a migrated Postgres
 * and reads the rows back: which runs it closes, which it leaves, what it writes
 * on the invocation, the run state, the abort signal, the turn lock and the
 * agent's runtime_status.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated database.
 */
import { Pool } from 'pg';

const realPool = process.env.TEST_DATABASE_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_URL })
  : null;

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => realPool,
  getPool: () => realPool,
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../entitlements-client/service', () => ({ isExecutionAllowed: async () => true }));
const mockInsertAuditLog = jest.fn(async () => undefined);
jest.mock('../../audit', () => ({ insertAuditLog: (...a: unknown[]) => mockInsertAuditLog(...(a as [])) }));

import { runStalledRunReconciliation, closeStalledHumanRuns } from '../stalled-run-reconciler';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-00000000a500';
const USER = '00000000-0000-4000-8000-00000000a5ff';
const AGENT = {
  alone: '00000000-0000-4000-8000-00000000a501', // one stuck run, nothing else
  busy: '00000000-0000-4000-8000-00000000a502', // one stuck run beside a live one
  guarded: '00000000-0000-4000-8000-00000000a503', // runs that must be left alone
  waiting: '00000000-0000-4000-8000-00000000a504', // WAITING_FOR_HUMAN, not ours to reset
  stop: '00000000-0000-4000-8000-00000000a505', // the Stop fallback
  window: '00000000-0000-4000-8000-00000000a506', // one stuck run each side of the 7 days
  stopOld: '00000000-0000-4000-8000-00000000a507', // Stop on a run older than the window
};
const INV = {
  stuck: '00000000-0000-4000-8000-0000000b0001',
  busyStuck: '00000000-0000-4000-8000-0000000b0002',
  busyLive: '00000000-0000-4000-8000-0000000b0003',
  pendingResume: '00000000-0000-4000-8000-0000000b0004',
  pendingApproval: '00000000-0000-4000-8000-0000000b0005',
  interrupted: '00000000-0000-4000-8000-0000000b0006',
  young: '00000000-0000-4000-8000-0000000b0007',
  noHeartbeatYoung: '00000000-0000-4000-8000-0000000b0008',
  noHeartbeatOld: '00000000-0000-4000-8000-0000000b0009',
  cron: '00000000-0000-4000-8000-0000000b000a',
  waitingStuck: '00000000-0000-4000-8000-0000000b000b',
  stopTarget: '00000000-0000-4000-8000-0000000b000c',
  stopOther: '00000000-0000-4000-8000-0000000b000d',
  eightDaysOld: '00000000-0000-4000-8000-0000000b000e',
  oneDayOld: '00000000-0000-4000-8000-0000000b000f',
  stopOld: '00000000-0000-4000-8000-0000000b0010',
};
const THREAD_OLD = '00000000-0000-4000-8000-0000000c0002';
const DAY = 24 * 60;
const THREAD = '00000000-0000-4000-8000-0000000c0001';

const q = (sql: string, params: unknown[] = []) => realPool!.query(sql, params);

async function seedRun(opts: {
  id: string; agent: string; startedMinAgo: number;
  heartbeatMinAgo?: number; runState?: 'running' | 'interrupted';
  triggeredBy?: 'human' | 'cron';
}) {
  await q(
    `INSERT INTO invocations (id, tenant_id, agent_id, triggered_by, provider, started_at,
                              triggered_by_user_id, accountable_user_id)
     VALUES ($1, $2, $3, $4, 'anthropic', NOW() - ($5::int * INTERVAL '1 minute'), $6, $6)`,
    [opts.id, TENANT, opts.agent, opts.triggeredBy ?? 'human', opts.startedMinAgo,
      (opts.triggeredBy ?? 'human') === 'human' ? USER : null],
  );
  if (opts.heartbeatMinAgo !== undefined) {
    await q(
      `INSERT INTO agent_run_states (invocation_id, tenant_id, agent_id, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'), NOW() - ($6::int * INTERVAL '1 minute'))`,
      [opts.id, TENANT, opts.agent, JSON.stringify({ status: opts.runState ?? 'running' }),
        opts.startedMinAgo, opts.heartbeatMinAgo],
    );
  }
}

const invocation = async (id: string) => (await q(
  `SELECT outcome, failure_class, error_message, completed_at, reconciliation_status, billing_queued
     FROM invocations WHERE id = $1`, [id])).rows[0];
const runState = async (id: string) =>
  (await q(`SELECT state->>'status' AS s FROM agent_run_states WHERE invocation_id = $1`, [id])).rows[0]?.s;
const runtimeStatus = async (id: string) =>
  (await q(`SELECT runtime_status FROM agents WHERE id = $1`, [id])).rows[0].runtime_status;

async function cleanup() {
  await q(`DELETE FROM chat_turn_locks WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM agent_run_states WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM agent_scheduled_invocations WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM hitl_approval_requests WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM invocations WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM agents WHERE tenant_id = $1`, [TENANT]);
  await q(`DELETE FROM tenants WHERE id = $1`, [TENANT]);
}

describeFn('closing stalled human-triggered runs against a real database', () => {
  const H = 60;

  beforeAll(async () => {
    process.env.STALLED_RUN_RECONCILER_ENABLED = '1';
    await cleanup();
    await q(`INSERT INTO tenants (id, external_id) VALUES ($1, 'stalled-human-fixture')`, [TENANT]);
    for (const [key, id] of Object.entries(AGENT)) {
      await q(
        `INSERT INTO agents (id, tenant_id, name, lifecycle, runtime_status) VALUES ($1, $2, $3, 'ACTIVE', $4)`,
        [id, TENANT, `fixture-${key}`, key === 'waiting' ? 'WAITING_FOR_HUMAN' : 'RUNNING'],
      );
    }

    // Hung in one await since the start: the shape a real stalled run takes.
    await seedRun({ id: INV.stuck, agent: AGENT.alone, startedMinAgo: 3 * H, heartbeatMinAgo: 3 * H });
    await q(`INSERT INTO agent_invocation_signals (invocation_id, signal_kind, payload) VALUES ($1, 'abort', '{}')`, [INV.stuck]);
    await q(`INSERT INTO agent_invocation_signals (invocation_id, signal_kind, payload) VALUES ($1, 'user_message', '{}')`, [INV.stuck]);
    await q(
      `INSERT INTO chat_turn_locks (tenant_id, thread_id, acquired_by_invocation_id) VALUES ($1, $2, $3)`,
      [TENANT, THREAD, INV.stuck],
    );

    await seedRun({ id: INV.busyStuck, agent: AGENT.busy, startedMinAgo: 3 * H, heartbeatMinAgo: 3 * H });
    // Old but heartbeating a minute ago: working, however long it has taken.
    await seedRun({ id: INV.busyLive, agent: AGENT.busy, startedMinAgo: 2 * H, heartbeatMinAgo: 1 });

    await seedRun({ id: INV.pendingResume, agent: AGENT.guarded, startedMinAgo: 3 * H, heartbeatMinAgo: 3 * H });
    await q(
      `INSERT INTO agent_scheduled_invocations
         (tenant_id, agent_id, context_ref, schedule_key, fires_at, objective, scheduled_by_invocation_id)
       VALUES ($1, $2, 'ctx', 'key-a5', NOW() + INTERVAL '1 day', 'hitl-expiry', $3)`,
      [TENANT, AGENT.guarded, INV.pendingResume],
    );
    await seedRun({ id: INV.pendingApproval, agent: AGENT.guarded, startedMinAgo: 3 * H, heartbeatMinAgo: 3 * H });
    await q(
      `INSERT INTO hitl_approval_requests
         (tenant_id, agent_id, hitl_level, pending_tool_calls, tool_calls_hash, reason, invocation_id)
       VALUES ($1, $2, 3, '[]', 'h', 'fixture', $3)`,
      [TENANT, AGENT.guarded, INV.pendingApproval],
    );
    await seedRun({ id: INV.interrupted, agent: AGENT.guarded, startedMinAgo: 3 * H, heartbeatMinAgo: 3 * H, runState: 'interrupted' });
    // Silent from the start, but only 20 minutes in: inside one long model call.
    await seedRun({ id: INV.young, agent: AGENT.guarded, startedMinAgo: 20, heartbeatMinAgo: 20 });
    await seedRun({ id: INV.noHeartbeatYoung, agent: AGENT.guarded, startedMinAgo: H });
    await seedRun({ id: INV.noHeartbeatOld, agent: AGENT.guarded, startedMinAgo: 3 * H });
    await seedRun({ id: INV.cron, agent: AGENT.guarded, startedMinAgo: 3 * H, heartbeatMinAgo: 3 * H, triggeredBy: 'cron' });

    await seedRun({ id: INV.waitingStuck, agent: AGENT.waiting, startedMinAgo: 3 * H, heartbeatMinAgo: 3 * H });

    await seedRun({ id: INV.stopTarget, agent: AGENT.stop, startedMinAgo: 3 * H, heartbeatMinAgo: 3 * H });
    await seedRun({ id: INV.stopOther, agent: AGENT.stop, startedMinAgo: 3 * H, heartbeatMinAgo: 3 * H });

    // The same hang, eight days and one day in.
    await seedRun({ id: INV.eightDaysOld, agent: AGENT.window, startedMinAgo: 8 * DAY, heartbeatMinAgo: 8 * DAY });
    await seedRun({ id: INV.oneDayOld, agent: AGENT.window, startedMinAgo: DAY, heartbeatMinAgo: DAY });

    await seedRun({ id: INV.stopOld, agent: AGENT.stopOld, startedMinAgo: 30 * DAY, heartbeatMinAgo: 30 * DAY });
    await q(`INSERT INTO agent_invocation_signals (invocation_id, signal_kind, payload) VALUES ($1, 'abort', '{}')`, [INV.stopOld]);
    await q(
      `INSERT INTO chat_turn_locks (tenant_id, thread_id, acquired_by_invocation_id) VALUES ($1, $2, $3)`,
      [TENANT, THREAD_OLD, INV.stopOld],
    );
  });

  afterAll(async () => {
    if (realPool) {
      await cleanup();
      await realPool.end();
    }
  });

  it('the Stop fallback closes only the run it was asked about', async () => {
    expect(await closeStalledHumanRuns(TENANT, { invocationId: INV.stopTarget })).toEqual({ closed: 1, idled: 0 });
    expect((await invocation(INV.stopTarget)).outcome).toBe('error');
    expect((await invocation(INV.stopOther)).completed_at).toBeNull();
    // The other stuck run is still open, so the agent is not idle yet.
    expect(await runtimeStatus(AGENT.stop)).toBe('RUNNING');
  });

  it('Stop closes a run older than the window, quietly', async () => {
    mockInsertAuditLog.mockClear();
    expect(await closeStalledHumanRuns(TENANT, { invocationId: INV.stopOld })).toEqual({ closed: 1, idled: 1 });
    expect(await invocation(INV.stopOld)).toMatchObject({
      outcome: 'error',
      failure_class: 'stalled',
      error_message: 'stalled: stale run older than 7 days closed on Stop; not billed, no Activity entry',
      // Neither billing path selects these: both read only 'pending'.
      reconciliation_status: 'unrecoverable',
      billing_queued: 'expired',
    });
    // No terminal audit row: no Activity entry, no run.failed webhook.
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
    // The rest of the close is the same: run state, abort, lock, agent.
    expect(await runState(INV.stopOld)).toBe('failed');
    const { rows } = await q(`SELECT consumed_at FROM agent_invocation_signals WHERE invocation_id = $1`, [INV.stopOld]);
    expect(rows[0].consumed_at).not.toBeNull();
    expect((await q(`SELECT 1 FROM chat_turn_locks WHERE acquired_by_invocation_id = $1`, [INV.stopOld])).rowCount).toBe(0);
    expect(await runtimeStatus(AGENT.stopOld)).toBe('IDLE');
  });

  it('the sweep closes every stalled run, cron through the unchanged path', async () => {
    mockInsertAuditLog.mockClear();
    // stuck, busyStuck, noHeartbeatOld, waitingStuck, stopOther, oneDayOld (human) + cron (autonomous).
    // Not eightDaysOld: it is outside the window, and this count holds whether or not
    // migration 435's test has closed it meanwhile.
    expect(await runStalledRunReconciliation(TENANT)).toEqual({ reconciled: 7 });
    // The 1-day-old run posts its terminal row; the 8-day-old one posts nothing.
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, TENANT, expect.objectContaining({ invocationId: INV.oneDayOld }));
    expect(mockInsertAuditLog).not.toHaveBeenCalledWith(null, TENANT, expect.objectContaining({ invocationId: INV.eightDaysOld }));
  });

  it('only looks back 7 days: a 1-day-old stuck run is closed, an 8-day-old one is not', async () => {
    expect(await invocation(INV.oneDayOld)).toMatchObject({
      outcome: 'error', failure_class: 'stalled', reconciliation_status: 'pending',
    });
    const old = await invocation(INV.eightDaysOld);
    expect(old.completed_at).toBeNull();
    expect(old.reconciliation_status).not.toBe('pending');
    // The old run is still open, so its agent is not reset.
    expect(await runtimeStatus(AGENT.window)).toBe('RUNNING');
  });

  it('writes the stall close on a stuck run', async () => {
    const inv = await invocation(INV.stuck);
    expect(inv).toMatchObject({
      outcome: 'error',
      failure_class: 'stalled',
      error_message: 'stalled: no run progress within grace window (reconciler)',
      reconciliation_status: 'pending',
    });
    expect(inv.completed_at).not.toBeNull();
    expect(await runState(INV.stuck)).toBe('failed');
  });

  it('consumes the abort, leaves a stranded message alone, and frees the thread', async () => {
    const { rows } = await q(
      `SELECT signal_kind, consumed_at FROM agent_invocation_signals WHERE invocation_id = $1`, [INV.stuck]);
    expect(rows.find((r) => r.signal_kind === 'abort').consumed_at).not.toBeNull();
    expect(rows.find((r) => r.signal_kind === 'user_message').consumed_at).toBeNull();
    expect((await q(`SELECT 1 FROM chat_turn_locks WHERE acquired_by_invocation_id = $1`, [INV.stuck])).rowCount).toBe(0);
  });

  it('an agent with nothing else open goes IDLE; the Stop agent does once its last run closes', async () => {
    expect(await runtimeStatus(AGENT.alone)).toBe('IDLE');
    expect(await runtimeStatus(AGENT.stop)).toBe('IDLE');
  });

  it('an agent with another open run stays RUNNING, and that run is untouched', async () => {
    expect((await invocation(INV.busyStuck)).outcome).toBe('error');
    expect((await invocation(INV.busyLive)).completed_at).toBeNull();
    expect(await runState(INV.busyLive)).toBe('running');
    expect(await runtimeStatus(AGENT.busy)).toBe('RUNNING');
  });

  it('leaves paused, interrupted, young and heartbeat-less-but-young runs open', async () => {
    for (const id of [INV.pendingResume, INV.pendingApproval, INV.interrupted, INV.young, INV.noHeartbeatYoung]) {
      expect((await invocation(id)).completed_at).toBeNull();
    }
    expect(await runState(INV.pendingResume)).toBe('running');
    expect(await runtimeStatus(AGENT.guarded)).toBe('RUNNING');
  });

  it('closes a run with no run-state row once it passes the longer bound', async () => {
    expect((await invocation(INV.noHeartbeatOld)).failure_class).toBe('stalled');
  });

  it('cron is still closed by the autonomous sweep (outcome, class) and never resets status', async () => {
    expect((await invocation(INV.cron)).failure_class).toBe('stalled');
    expect(await runtimeStatus(AGENT.guarded)).toBe('RUNNING');
  });

  it('never moves an agent that is not RUNNING', async () => {
    expect((await invocation(INV.waitingStuck)).outcome).toBe('error');
    expect(await runtimeStatus(AGENT.waiting)).toBe('WAITING_FOR_HUMAN');
  });

  it('a second sweep finds nothing: the close is not repeated', async () => {
    mockInsertAuditLog.mockClear();
    expect(await closeStalledHumanRuns(TENANT)).toEqual({ closed: 0, idled: 0 });
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
  });
});
