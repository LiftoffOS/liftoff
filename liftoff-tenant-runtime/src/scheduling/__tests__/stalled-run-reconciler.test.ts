const mockQuery = jest.fn();
const mockIsExecutionAllowed = jest.fn();
const mockInsertAuditLog = jest.fn();

jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => ({ query: mockQuery }) }));
const mockLogAudit = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));
jest.mock('../../entitlements-client/service', () => ({
  isExecutionAllowed: (...a: unknown[]) => mockIsExecutionAllowed(...a),
}));
jest.mock('../../audit', () => ({ insertAuditLog: (...a: unknown[]) => mockInsertAuditLog(...a) }));

import { runStalledRunReconciliation, closeStalledHumanRuns } from '../stalled-run-reconciler';

const tid = '11111111-1111-1111-1111-111111111111';

describe('stalled-run-reconciler (plan §1)', () => {
  beforeEach(() => {
    // Every query not given an explicit answer below finds nothing. The human
    // sweep runs after the autonomous one, so most tests here end with its
    // (empty) claim.
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockIsExecutionAllowed.mockReset();
    mockInsertAuditLog.mockReset().mockResolvedValue(undefined);
    mockLogAudit.mockReset();
    process.env.STALLED_RUN_RECONCILER_ENABLED = '1';
  });

  it('disabled flag → no-op (no DB touch)', async () => {
    process.env.STALLED_RUN_RECONCILER_ENABLED = '0';
    expect(await runStalledRunReconciliation(tid)).toEqual({ reconciled: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('tenant not execution-allowed → skip', async () => {
    mockIsExecutionAllowed.mockResolvedValue(false);
    expect(await runStalledRunReconciliation(tid)).toEqual({ reconciled: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('(a) completes a top-level cron orphan as error/stalled + posts the agent_execution audit', async () => {
    mockIsExecutionAllowed.mockResolvedValue(true);
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'inv1', agent_id: 'a1', triggered_by: 'cron', thread_id: 't1', parent_invocation_id: null }],
      }) // main claim UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }); // agent_run_states → failed
    const r = await runStalledRunReconciliation(tid);
    expect(r).toEqual({ reconciled: 1 });
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
    const [, auditTenant, entry] = mockInsertAuditLog.mock.calls[0];
    expect(auditTenant).toBe(tid);
    expect(entry).toMatchObject({
      internalAgentId: 'a1',
      invocationId: 'inv1',
      threadId: 't1',
      action: 'agent_execution',
      outcome: 'error',
      errorCode: 'run_stalled',
      triggeredBy: 'cron', // coarse — conformed to 'cron' downstream; do NOT pass a label
    });
  });

  it('(e) defense-in-depth: a parent-set row posts NO audit (the claim SQL now also excludes children)', async () => {
    mockIsExecutionAllowed.mockResolvedValue(true);
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'inv2', agent_id: 'a1', triggered_by: 'agent', thread_id: null, parent_invocation_id: 'parent1' }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    const r = await runStalledRunReconciliation(tid);
    expect(r).toEqual({ reconciled: 1 });
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
  });

  it('no orphans → reconciled 0, no run-state update, no audit', async () => {
    mockIsExecutionAllowed.mockResolvedValue(true);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const r = await runStalledRunReconciliation(tid);
    expect(r).toEqual({ reconciled: 0 });
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
    // Only the two claim UPDATEs: autonomous, then human. Nothing follows an empty claim.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toMatch(/i\.triggered_by = 'human'/);
  });

  it('(b,c,d) claim SQL excludes paused/interrupted/heartbeating runs and bounds by grace', async () => {
    mockIsExecutionAllowed.mockResolvedValue(true);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await runStalledRunReconciliation(tid);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/outcome IS NULL AND i\.completed_at IS NULL/);
    expect(sql).toMatch(/started_at < NOW\(\) - INTERVAL '15 minutes'/);
    // scoped to autonomous top-level runs (cron/event, parent NULL) — calibration finding:
    // the un-scoped predicate would sweep dead chat (human) runs and mislabel them 'stalled'
    expect(sql).toMatch(/triggered_by IN \('cron', 'event'\)/);
    expect(sql).toMatch(/parent_invocation_id IS NULL/);
    // (b) pending scheduled resume excluded (HITL/clarification/delay/delegation/followup)
    expect(sql).toMatch(/agent_scheduled_invocations/);
    expect(sql).toMatch(/scheduled_by_invocation_id = i\.id::text AND asi\.status = 'pending'/);
    // (c) terminal/paused run-states (complete/failed/interrupted) excluded — a completed
    //     or failed run-state is a missed-completion or pause, not a stall
    expect(sql).toMatch(/IN \('interrupted', 'complete', 'failed'\)/);
    // (d) fresh-heartbeat running run-state excluded
    expect(sql).toMatch(/updated_at >= NOW\(\) - INTERVAL '10 minutes'/);
    // The class is split: a run past the grace window is 'stalled', a routine
    // still active past its own deadline is 'routine_hard_bound'. Both are
    // still written by this one statement.
    expect(sql).toMatch(/ELSE 'stalled' END/);
    expect(sql).toMatch(/THEN 'routine_hard_bound'/);
    expect(sql).toMatch(/reconciliation_status = 'pending'/);
  });
});

describe('stalled-run-reconciler: runs a person started', () => {
  const USER = '22222222-2222-4222-8222-222222222222';
  const stuck = {
    id: 'inv-h1', agent_id: 'agent-1', thread_id: 'thread-1', parent_invocation_id: null,
    triggered_by_user_id: USER, last_rss_bytes: '104857600', last_progress_at: new Date('2026-09-24T04:10:38Z'),
    quiet: false,
  };
  const sqlOf = (re: RegExp) => mockQuery.mock.calls.map((c) => c[0] as string).find((q) => re.test(q));
  const callOf = (re: RegExp) => mockQuery.mock.calls.find((c) => re.test(c[0] as string));

  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockIsExecutionAllowed.mockReset().mockResolvedValue(true);
    mockInsertAuditLog.mockReset().mockResolvedValue(undefined);
    mockLogAudit.mockReset();
    process.env.STALLED_RUN_RECONCILER_ENABLED = '1';
  });

  /** Answer the human claim with `rows`, and the agents reset with `idle`. */
  function stage(rows: object[], idle: { rows: object[] } = { rows: [{ id: 'agent-1' }] }) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/i\.triggered_by = 'human'/.test(sql)) return { rows };
      if (/UPDATE agents a SET runtime_status = 'IDLE'/.test(sql)) return idle;
      return { rows: [], rowCount: 1 };
    });
  }

  it('closes a stuck human run with the stall close, and the agent goes IDLE', async () => {
    stage([stuck]);
    expect(await runStalledRunReconciliation(tid)).toEqual({ reconciled: 1 });

    const claim = sqlOf(/i\.triggered_by = 'human'/)!;
    expect(claim).toMatch(/outcome = 'error'/);
    expect(claim).toMatch(/failure_class = 'stalled'/);
    expect(claim).toMatch(/THEN 'stalled: no run progress within grace window \(reconciler\)'/);
    expect(claim).toMatch(/completed_at = NOW\(\)/);
    // Billing goes through the stalled-billing reconciler exactly as a cron stall does.
    expect(claim).toMatch(/reconciliation_status = CASE WHEN i\.started_at > NOW\(\) - INTERVAL '7 days' THEN 'pending'/);

    // run state -> failed
    const rs = callOf(/UPDATE agent_run_states SET state = jsonb_set\(state,'\{status\}','"failed"'\)/)!;
    expect(rs[1]).toEqual([['inv-h1']]);

    // agent RUNNING -> IDLE, logged the way the lifecycle service logs a transition
    const idle = callOf(/UPDATE agents a SET runtime_status = 'IDLE'/)!;
    expect(idle[0]).toMatch(/a\.runtime_status = 'RUNNING'/);
    expect(idle[1]).toEqual(['agent-1', tid]);
    expect(mockLogAudit).toHaveBeenCalledWith(
      'agent.runtime_status_changed',
      expect.objectContaining({ tenantId: tid, agentId: 'agent-1' }),
      expect.objectContaining({ previousState: { runtimeStatus: 'RUNNING' }, newState: { runtimeStatus: 'IDLE' } }),
    );
  });

  it('consumes the pending abort and frees the thread lock', async () => {
    stage([stuck]);
    await closeStalledHumanRuns(tid);
    const signals = callOf(/UPDATE agent_invocation_signals SET consumed_at = NOW\(\)/)!;
    expect(signals[0]).toMatch(/signal_kind = 'abort' AND consumed_at IS NULL/);
    expect(signals[1]).toEqual([['inv-h1']]);
    const lock = callOf(/DELETE FROM chat_turn_locks/)!;
    expect(lock[1]).toEqual([tid, ['inv-h1']]);
  });

  it('posts the terminal agent_execution error a failed run posts, attributed to the person', async () => {
    stage([stuck]);
    await closeStalledHumanRuns(tid);
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
    const [, auditTenant, entry] = mockInsertAuditLog.mock.calls[0];
    expect(auditTenant).toBe(tid);
    expect(entry).toMatchObject({
      internalAgentId: 'agent-1',
      userId: USER,
      invocationId: 'inv-h1',
      threadId: 'thread-1',
      action: 'agent_execution',
      outcome: 'error',
      errorCode: 'run_stalled',
      triggeredBy: `human:${USER}`, // the same value the run's own start row carried
    });
  });

  it('never sends a non-uuid originator (slack:<uid>) as the audit userId', async () => {
    stage([{ ...stuck, triggered_by_user_id: 'slack:U123' }]);
    await closeStalledHumanRuns(tid);
    const [, , entry] = mockInsertAuditLog.mock.calls[0];
    expect(entry.userId).toBeUndefined();
    expect(entry.triggeredBy).toBe('human:slack:U123');
  });

  it('an agent with another open run stays RUNNING', async () => {
    // The reset is one conditional statement; with another open invocation it matches nothing.
    stage([stuck], { rows: [] });
    expect(await closeStalledHumanRuns(tid)).toEqual({ closed: 1, idled: 0 });
    const idle = sqlOf(/UPDATE agents a SET runtime_status = 'IDLE'/)!;
    expect(idle).toMatch(/NOT EXISTS \(SELECT 1 FROM invocations o\s+WHERE o\.tenant_id = \$2::uuid AND o\.agent_id = \$1::uuid AND o\.completed_at IS NULL\)/);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('two stuck runs of one agent reset it once', async () => {
    stage([stuck, { ...stuck, id: 'inv-h2', thread_id: 'thread-2' }]);
    expect(await closeStalledHumanRuns(tid)).toEqual({ closed: 2, idled: 1 });
    expect(mockQuery.mock.calls.filter((c) => /UPDATE agents a SET/.test(c[0] as string))).toHaveLength(1);
  });

  it('the claim leaves alone a run that is still making progress, or waiting on a person', async () => {
    await closeStalledHumanRuns(tid);
    const claim = sqlOf(/i\.triggered_by = 'human'/)!;
    expect(claim).toMatch(/i\.outcome IS NULL AND i\.completed_at IS NULL/);
    // started long enough ago AND silent long enough: both, never either
    expect(claim).toMatch(/i\.started_at < NOW\(\) - INTERVAL '30 minutes'/);
    expect(claim).toMatch(/ars\.state->>'status' = 'running'\s+AND ars\.updated_at < NOW\(\) - INTERVAL '30 minutes'/);
    // no heartbeat source at all: a much longer bound
    expect(claim).toMatch(/NOT EXISTS \(SELECT 1 FROM agent_run_states ars WHERE ars\.invocation_id = i\.id::text\)\s+AND i\.started_at < NOW\(\) - INTERVAL '2 hours'/);
    // paused: a pending resume or a pending approval
    expect(claim).toMatch(/scheduled_by_invocation_id = i\.id::text AND asi\.status = 'pending'/);
    expect(claim).toMatch(/hitl_approval_requests h\s+WHERE h\.tenant_id = i\.tenant_id AND h\.invocation_id = i\.id AND h\.status = 'pending'/);
  });

  it('nothing stuck: one claim, no follow-up writes', async () => {
    expect(await closeStalledHumanRuns(tid)).toEqual({ closed: 0, idled: 0 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
  });

  it('scopes to one invocation for the Stop fallback', async () => {
    await closeStalledHumanRuns(tid, { invocationId: 'inv-h1' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/\(\$2::uuid IS NULL OR i\.id = \$2::uuid\)/);
    expect(params).toEqual([tid, 'inv-h1']);
  });

  it('the sweep looks back 7 days; Stop has no age limit', async () => {
    await closeStalledHumanRuns(tid);
    const claim = sqlOf(/i\.triggered_by = 'human'/)!;
    // $2 is the Stop's invocation id: null for the sweep, which is then bounded.
    expect(claim).toMatch(/AND \(\$2::uuid IS NOT NULL OR i\.started_at > NOW\(\) - INTERVAL '7 days'\)/);
  });

  it('an old run closed on Stop is quiet: no audit row, nothing for billing', async () => {
    stage([{ ...stuck, quiet: true }]);
    expect(await closeStalledHumanRuns(tid, { invocationId: 'inv-h1' })).toEqual({ closed: 1, idled: 1 });
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
    const claim = sqlOf(/i\.triggered_by = 'human'/)!;
    // Outside the window: neither billing path selects it (both read only 'pending').
    expect(claim).toMatch(/ELSE 'unrecoverable' END/);
    expect(claim).toMatch(/billing_queued = CASE WHEN i\.started_at > NOW\(\) - INTERVAL '7 days' THEN i\.billing_queued ELSE 'expired' END/);
    expect(claim).toMatch(/ELSE 'stalled: stale run older than 7 days closed on Stop; not billed, no Activity entry' END/);
    // The rest of the close still happens: the thread and the agent are freed.
    expect(callOf(/DELETE FROM chat_turn_locks/)).toBeDefined();
    expect(callOf(/UPDATE agent_invocation_signals SET consumed_at = NOW\(\)/)).toBeDefined();
    expect(callOf(/UPDATE agents a SET runtime_status = 'IDLE'/)).toBeDefined();
  });

  it('disabled flag: no DB touch', async () => {
    process.env.STALLED_RUN_RECONCILER_ENABLED = '0';
    expect(await closeStalledHumanRuns(tid, { invocationId: 'inv-h1' })).toEqual({ closed: 0, idled: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('cron/event sweep is unchanged: still first, still cron/event only, and never resets runtime status', async () => {
    mockQuery.mockReset()
      .mockResolvedValueOnce({ rows: [{ id: 'inv1', agent_id: 'a1', triggered_by: 'cron', thread_id: null, parent_invocation_id: null }] })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await runStalledRunReconciliation(tid)).toEqual({ reconciled: 1 });
    const first = mockQuery.mock.calls[0][0] as string;
    expect(first).toMatch(/triggered_by IN \('cron', 'event'\)/);
    expect(first).not.toMatch(/'human'/);
    expect(mockQuery.mock.calls.some((c) => /UPDATE agents/.test(c[0] as string))).toBe(false);
    expect(mockQuery.mock.calls.some((c) => /agent_invocation_signals|chat_turn_locks/.test(c[0] as string))).toBe(false);
  });
});
