// C2 — the wake loop breaker.
//
// The behaviour under test is the one that was missing entirely: a wake whose
// resume kills the process must eventually stop being handed out. Before this,
// `resume_attempts` was incremented on every claim and never read, so the
// stale-lease reconciler recycled a poisoned row indefinitely.
//
// These assert the SQL contract (what the queries must and must not do) rather
// than exercising a live database, which is what the integration suite is for.

import { WAKE_MAX_RESUME_ATTEMPTS, agentScheduledInvocationsRepo } from '../agent-scheduled-invocations-repo';
import { wakeWaitSetRepo } from '../wake-wait-set-repo';

const query = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => query(...args) }),
  getPoolForService: () => ({ query: (...args: unknown[]) => query(...args) }),
}));

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('the attempt budget', () => {
  it('is a real, positive number', () => {
    expect(WAKE_MAX_RESUME_ATTEMPTS).toBeGreaterThan(0);
    expect(Number.isFinite(WAKE_MAX_RESUME_ATTEMPTS)).toBe(true);
  });
});

describe('claimWakeForResume', () => {
  it('refuses to claim a row that has spent its budget', async () => {
    await agentScheduledInvocationsRepo.claimWakeForResume('wake-1', 'tenant-1');

    const [sql, params] = query.mock.calls[0];
    // The cap is enforced in the WHERE clause, so the refusal is atomic with
    // the claim — two workers cannot both slip past it.
    expect(sql).toMatch(/resume_attempts\s*<\s*\$3/);
    expect(params).toContain(WAKE_MAX_RESUME_ATTEMPTS);
  });

  it('still only claims rows that are pending', async () => {
    await agentScheduledInvocationsRepo.claimWakeForResume('wake-1', 'tenant-1');
    expect(query.mock.calls[0][0]).toMatch(/status = 'pending'/);
  });

  it('still increments the attempt counter, so the budget can be spent', async () => {
    await agentScheduledInvocationsRepo.claimWakeForResume('wake-1', 'tenant-1');
    expect(query.mock.calls[0][0]).toMatch(/resume_attempts = resume_attempts \+ 1/);
  });

  it('returns null when the row was not claimable', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(agentScheduledInvocationsRepo.claimWakeForResume('wake-1', 'tenant-1'))
      .resolves.toBeNull();
  });
});

describe('claimForResume (wait sets)', () => {
  it('applies the same budget', async () => {
    await wakeWaitSetRepo.claimForResume('set-1', 'tenant-1');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/resume_attempts\s*<\s*\$3/);
    expect(params).toContain(WAKE_MAX_RESUME_ATTEMPTS);
  });
});

describe('parkExhaustedWakes', () => {
  it('parks only pending rows that are out of attempts', async () => {
    await agentScheduledInvocationsRepo.parkExhaustedWakes();
    const [sql, params] = query.mock.calls[0];

    expect(sql).toMatch(/SET status = 'parked'/);
    expect(sql).toMatch(/status = 'pending' AND resume_attempts >= \$1/);
    expect(params[0]).toBe(WAKE_MAX_RESUME_ATTEMPTS);
  });

  it('clears the lease so a parked row cannot look claimed', async () => {
    await agentScheduledInvocationsRepo.parkExhaustedWakes();
    expect(query.mock.calls[0][0]).toMatch(/lease_token = NULL/);
  });

  it('takes rows with SKIP LOCKED so two instances never fight over one', async () => {
    await agentScheduledInvocationsRepo.parkExhaustedWakes();
    expect(query.mock.calls[0][0]).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('returns the parked rows so the caller can alert', async () => {
    query.mockResolvedValue({ rows: [{ id: 'wake-1', resume_attempts: 5 }] });
    await expect(agentScheduledInvocationsRepo.parkExhaustedWakes())
      .resolves.toEqual([{ id: 'wake-1', resume_attempts: 5 }]);
  });
});

describe('parkExhaustedWaitSets', () => {
  it('parks exhausted wait sets the same way', async () => {
    await wakeWaitSetRepo.parkExhaustedWaitSets();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'parked'/);
    expect(sql).toMatch(/status = 'pending' AND resume_attempts >= \$1/);
    expect(params[0]).toBe(WAKE_MAX_RESUME_ATTEMPTS);
  });
});
