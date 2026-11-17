// Wait-set (wake_on_any / wake_on_all) durable layer: fenced-lease transitions on wake_wait_sets and
// the member methods on agent_scheduled_invocations. Verifies the SQL of each transition without a live
// DB by mocking getPool — same technique as wake-lease.test.ts — so the fencing (lease_token), the
// tenant-binding, and the status transitions are asserted.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({ getPool: () => ({ query: mockQuery }) }));

import { wakeWaitSetRepo } from '../wake-wait-set-repo';
import { WAKE_MAX_RESUME_ATTEMPTS, agentScheduledInvocationsRepo } from '../agent-scheduled-invocations-repo';

describe('wake_wait_sets fenced lease state machine', () => {
  beforeEach(() => mockQuery.mockReset());

  it('claimForResume claims a PENDING set, tenant-bound, minting a fenced lease', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ws1', lease_token: 'tok', mode: 'any' }], rowCount: 1 });
    const row = await wakeWaitSetRepo.claimForResume('ws1', 't1');
    expect(row).toEqual({ id: 'ws1', lease_token: 'tok', mode: 'any' });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'resume_inflight'/);
    expect(sql).toMatch(/lease_token = gen_random_uuid\(\)/);
    expect(sql).toMatch(/WHERE id = \$1 AND tenant_id = \$2 AND status = 'pending'/);
    // C2: the same attempt cap applies to wait sets.
    expect(mockQuery.mock.calls[0][1]).toEqual(['ws1', 't1', WAKE_MAX_RESUME_ATTEMPTS]);
  });

  it('claimForResume returns null when not claimable', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await wakeWaitSetRepo.claimForResume('ws1', 't1')).toBeNull();
  });

  it('EVERY post-claim transition is fenced by lease_token = $2', async () => {
    const run = async (p: () => Promise<unknown>) => {
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
      await p();
      expect(mockQuery.mock.calls[0][0] as string).toMatch(/lease_token\s*=\s*\$2/);
    };
    await run(() => wakeWaitSetRepo.heartbeat('ws1', 'tok'));
    await run(() => wakeWaitSetRepo.persistResult('ws1', 'tok', { r: 1 }));
    await run(() => wakeWaitSetRepo.settle('ws1', 'tok'));
    await run(() => wakeWaitSetRepo.releaseLease('ws1', 'tok'));
    await run(() => wakeWaitSetRepo.markErrored('ws1', 'tok', 'boom'));
  });

  it('persistResult: resume_inflight -> settlement_pending', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    expect(await wakeWaitSetRepo.persistResult('ws1', 'tok', { r: 1 })).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'settlement_pending'/);
    expect(sql).toMatch(/status = 'resume_inflight'/);
  });

  it('settle: settlement_pending -> fired', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    expect(await wakeWaitSetRepo.settle('ws1', 'tok')).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'fired'/);
    expect(sql).toMatch(/status = 'settlement_pending'/);
  });

  it('releaseLease returns the set to pending (retryable, never fired)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await wakeWaitSetRepo.releaseLease('ws1', 'tok');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'pending'/);
    expect(sql).not.toMatch(/status = 'fired'/);
  });

  it('reclaimStaleLeases resets stale sets to pending', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ws1' }], rowCount: 1 });
    const rows = await wakeWaitSetRepo.reclaimStaleLeases();
    expect(rows).toEqual([{ id: 'ws1' }]);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/SET status = 'pending'/);
    expect(sql).toMatch(/lease_until IS NOT NULL AND lease_until < NOW\(\)/);
  });

  it('cancelById is tenant-bound and only cancels live sets', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    expect(await wakeWaitSetRepo.cancelById('t1', 'ws1')).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'cancelled'/);
    expect(sql).toMatch(/tenant_id = \$2/);
    expect(sql).toMatch(/status IN \('pending','resume_inflight','settlement_pending'\)/);
  });

  it('cancelByContextRef returns the cancelled set id (or null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ws1' }], rowCount: 1 });
    expect(await wakeWaitSetRepo.cancelByContextRef('t1', 'a1', 'waitset:a1:label:x')).toBe('ws1');
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await wakeWaitSetRepo.cancelByContextRef('t1', 'a1', 'waitset:a1:label:x')).toBeNull();
  });
});

describe('wait-set members on agent_scheduled_invocations', () => {
  beforeEach(() => mockQuery.mockReset());

  it('fireWaitSetMember: resume_inflight -> fired, fenced by lease_token', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    expect(await agentScheduledInvocationsRepo.fireWaitSetMember('m1', 'tok')).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'fired'/);
    expect(sql).toMatch(/lease_token = \$2/);
    expect(sql).toMatch(/status = 'resume_inflight'/);
  });

  it("countUnfiredWaitSetMembers counts members not in ('fired','cancelled','errored')", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '2' }] });
    expect(await agentScheduledInvocationsRepo.countUnfiredWaitSetMembers('ws1')).toBe(2);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/wait_set_id = \$1/);
    expect(sql).toMatch(/status NOT IN \('fired','cancelled','errored'\)/);
  });

  it('cancelWaitSetMembers excludes the fired member (any-mode) and only cancels live rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm2' }, { id: 'm3' }], rowCount: 2 });
    const rows = await agentScheduledInvocationsRepo.cancelWaitSetMembers('ws1', 'm1');
    expect(rows).toHaveLength(2);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'cancelled'/);
    expect(sql).toMatch(/id <> \$2/);
    expect(sql).toMatch(/status IN \('pending','resume_inflight','settlement_pending'\)/);
    expect(mockQuery.mock.calls[0][1]).toEqual(['ws1', 'm1']);
  });

  it('bumpResumeRate upserts with a window reset and returns the post-bump count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 3 }] });
    expect(await agentScheduledInvocationsRepo.bumpResumeRate('t1', 'a1', 60)).toBe(3);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/INSERT INTO wake_resume_rate/);
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, agent_id\) DO UPDATE/);
    expect(sql).toMatch(/window_start < NOW\(\) - \(\$3 \|\| ' seconds'\)::interval/);
  });

  it('reconcileChildWakeTtl clamps the child wake fires_at to the parent saga deadline (LEAST)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ fires_at: new Date('2030-01-01T00:00:00Z') }] });
    const out = await agentScheduledInvocationsRepo.reconcileChildWakeTtl('w1', 'c1');
    expect(out).toBeInstanceOf(Date);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/SET fires_at = LEAST\(w\.fires_at, p\.fires_at\)/);
    expect(sql).toMatch(/context_ref = 'deleg:' \|\| c\.parent_task_id/);
  });
});
