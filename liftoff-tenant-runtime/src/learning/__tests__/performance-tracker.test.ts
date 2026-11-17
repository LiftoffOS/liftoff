// Performance Tracker Tests

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { computePerformanceSnapshot, savePerformanceSnapshot } from '../performance-tracker';

beforeEach(() => jest.clearAllMocks());

describe('computePerformanceSnapshot', () => {
  const start = new Date('2026-03-01');
  const end = new Date('2026-03-31');

  it('computes correct rates from invocation data', async () => {
    // invocations (denominator AND the autonomy numerator, one pass)
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '10', successes: '8', escalations: '1', tasks_needing_a_person: '3', avg_duration_ms: '5000', avg_cost: '0.05' }],
    });
    // hitl approval decisions
    mockQuery.mockResolvedValueOnce({ rows: [{ decided: '3', rejected: '1' }] });
    // memory count
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '15' }] });

    const snapshot = await computePerformanceSnapshot('t1', 'a1', start, end);

    expect(snapshot.successRate).toBe(0.8);        // 8/10
    expect(snapshot.autonomyRate).toBe(0.7);        // (10-3)/10
    expect(snapshot.escalationRate).toBe(0.1);      // 1/10
    expect(snapshot.correctionRate).toBeCloseTo(0.333, 2);  // 1 rejected / 3 DECIDED (not 5 raised)
    expect(snapshot.invocationCount).toBe(10);
    expect(snapshot.memoryCount).toBe(15);
  });

  it('counts a task that stopped to ASK a person, not only one that was gated', async () => {
    // The pause-row numerator sees hitl_approval AND ask_user. A run that stopped
    // to ask a question raises no approval row at all, and used to score as fully
    // autonomous.
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '4', successes: '4', escalations: '0', tasks_needing_a_person: '2', avg_duration_ms: '100', avg_cost: '0.01' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ decided: '0', rejected: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const snapshot = await computePerformanceSnapshot('t1', 'a1', start, end);

    expect(snapshot.autonomyRate).toBe(0.5); // 2 of 4 needed a person; zero approvals raised
  });

  it('reads the autonomy numerator off the pause rows, with both sides cast', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '1', successes: '1', escalations: '0', tasks_needing_a_person: '0', avg_duration_ms: '1', avg_cost: '0' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ decided: '0', rejected: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await computePerformanceSnapshot('t1', 'a1', start, end);

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('agent_scheduled_invocations');
    expect(sql).toContain("'hitl_approval','ask_user'");
    expect(sql).toContain('a.scheduled_by_invocation_id::text = i.id::text');
    // Containment is structural now; the clamp that used to hide the mismatch is gone.
    expect(sql).not.toContain('Math.max');
  });

  it('returns a NULL autonomy rate — not zero — when there are no finished runs', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0', successes: '0', escalations: '0', tasks_needing_a_person: '0', avg_duration_ms: null, avg_cost: null }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ decided: '0', rejected: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const snapshot = await computePerformanceSnapshot('t1', 'a1', start, end);

    expect(snapshot.successRate).toBe(0);
    expect(snapshot.autonomyRate).toBeNull();
    expect(snapshot.correctionRate).toBe(0);
    expect(snapshot.invocationCount).toBe(0);
  });

  it('handles null database values without NaN', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '5', successes: '3', escalations: '0', tasks_needing_a_person: '0', avg_duration_ms: null, avg_cost: null }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ decided: '0', rejected: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const snapshot = await computePerformanceSnapshot('t1', 'a1', start, end);

    expect(snapshot.avgCostPerInvocation).toBe(0);
    expect(snapshot.avgDurationMs).toBe(0);
    expect(Number.isNaN(snapshot.successRate)).toBe(false);
  });
});

describe('savePerformanceSnapshot', () => {
  it('uses UPSERT to avoid duplicates', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await savePerformanceSnapshot('t1', {
      agentId: 'a1', periodStart: new Date(), periodEnd: new Date(),
      successRate: 0.9, autonomyRate: 0.8, escalationRate: 0.1, correctionRate: 0.05,
      avgCostPerInvocation: 0.02, avgDurationMs: 3000, memoryCount: 10, invocationCount: 100,
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('ON CONFLICT');
  });

  it('binds a NULL autonomy rate rather than coercing it (migration 374)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await savePerformanceSnapshot('t1', {
      agentId: 'a1', periodStart: new Date(), periodEnd: new Date(),
      successRate: 0.9, autonomyRate: null, escalationRate: 0.1, correctionRate: 0.05,
      avgCostPerInvocation: 0.02, avgDurationMs: 3000, memoryCount: 10, invocationCount: 0,
    });

    // $6 is autonomy_rate in the INSERT's column order.
    expect(mockQuery.mock.calls[0][1][5]).toBeNull();
  });
});
