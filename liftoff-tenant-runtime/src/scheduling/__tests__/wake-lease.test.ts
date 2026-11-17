// Self-wake fenced lease state machine. Verifies the SQL of each transition without a
// live DB by mocking getPool. Asserts the fencing (lease_token) + tenant-binding + status transitions.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({ getPool: () => ({ query: mockQuery }) }));

import { WAKE_MAX_RESUME_ATTEMPTS, agentScheduledInvocationsRepo } from '../agent-scheduled-invocations-repo';

describe('self-wake fenced lease state machine', () => {
  beforeEach(() => mockQuery.mockReset());

  it('claimWakeForResume claims a PENDING row, tenant-bound, minting a fenced lease', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w1', lease_token: 'tok' }], rowCount: 1 });
    const row = await agentScheduledInvocationsRepo.claimWakeForResume('w1', 't1');
    expect(row).toEqual({ id: 'w1', lease_token: 'tok' });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'resume_inflight'/);
    expect(sql).toMatch(/lease_token = gen_random_uuid\(\)/);
    expect(sql).toMatch(/WHERE id = \$1 AND tenant_id = \$2 AND status = 'pending'/);
    // C2 adds the attempt cap as $3, so a row that keeps killing the process
    // that resumes it stops being claimable rather than looping forever.
    expect(mockQuery.mock.calls[0][1]).toEqual(['w1', 't1', WAKE_MAX_RESUME_ATTEMPTS]);
  });

  it('claimWakeForResume returns null when not claimable (already fired/leased)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await agentScheduledInvocationsRepo.claimWakeForResume('w1', 't1')).toBeNull();
  });

  it('EVERY post-claim transition is fenced by lease_token = $2 (no stale-worker overwrite)', async () => {
    const run = async (p: () => Promise<unknown>) => {
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
      await p();
      expect(mockQuery.mock.calls[0][0] as string).toMatch(/lease_token\s*=\s*\$2/);
    };
    await run(() => agentScheduledInvocationsRepo.heartbeatWakeLease('w1', 'tok'));
    await run(() => agentScheduledInvocationsRepo.persistWakeResult('w1', 'tok', { r: 1 }));
    await run(() => agentScheduledInvocationsRepo.settleWake('w1', 'tok'));
    await run(() => agentScheduledInvocationsRepo.releaseWakeLease('w1', 'tok'));
    await run(() => agentScheduledInvocationsRepo.markWakeErrored('w1', 'tok', 'boom'));
    await run(() => agentScheduledInvocationsRepo.rearmPoll('w1', 'tok', 2));
  });

  it('persistWakeResult transitions resume_inflight -> settlement_pending', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    expect(await agentScheduledInvocationsRepo.persistWakeResult('w1', 'tok', { r: 1 })).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'settlement_pending'/);
    expect(sql).toMatch(/status = 'resume_inflight'/);
  });

  it('settleWake transitions settlement_pending -> fired', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    expect(await agentScheduledInvocationsRepo.settleWake('w1', 'tok')).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'fired'/);
    expect(sql).toMatch(/status = 'settlement_pending'/);
  });

  it('releaseWakeLease returns the row to pending (retryable, never fired)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await agentScheduledInvocationsRepo.releaseWakeLease('w1', 'tok');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'pending'/);
    expect(sql).toMatch(/lease_token = NULL/);
    expect(sql).not.toMatch(/status = 'fired'/);
  });

  it('reclaimStaleWakeLeases resets stale rows to pending (ledger replay guards re-run)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w1' }], rowCount: 1 });
    const rows = await agentScheduledInvocationsRepo.reclaimStaleWakeLeases();
    expect(rows).toEqual([{ id: 'w1' }]);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/SET status = 'pending'/);
    expect(sql).toMatch(/lease_until IS NOT NULL AND lease_until < NOW\(\)/);
  });

  it('cancelWakeById is tenant-bound and only cancels live wakes', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    expect(await agentScheduledInvocationsRepo.cancelWakeById('t1', 'w1')).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status='cancelled'/);
    expect(sql).toMatch(/tenant_id=\$2/);
    expect(sql).toMatch(/wake_kind IS NOT NULL/);
  });
});
