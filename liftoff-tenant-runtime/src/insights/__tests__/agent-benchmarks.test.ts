// B6 — benchmark trend normalization + compute. The pool is mocked; the point is that trend
// direction is normalized PER METRIC so 'improving' always means the agent got better.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({ pool: { query: (...a: unknown[]) => mockQuery(...a) } }));
jest.mock('../../security/service-auth', () => ({ requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { normalizeTrend, computeAgentBenchmarks } from '../agent-benchmarks';

describe('normalizeTrend', () => {
  it('UPWARD metrics: rising = improving, falling = declining', () => {
    expect(normalizeTrend('taskSuccess', 0.9, 0.7)).toBe('improving');
    expect(normalizeTrend('taskSuccess', 0.6, 0.9)).toBe('declining');
    expect(normalizeTrend('autonomy', 0.8, 0.5)).toBe('improving');
  });

  it('DOWNWARD metrics: falling = improving, rising = declining', () => {
    // fewer corrections / escalations is BETTER.
    expect(normalizeTrend('corrections', 0.1, 0.4)).toBe('improving');
    expect(normalizeTrend('corrections', 0.4, 0.1)).toBe('declining');
    expect(normalizeTrend('escalations', 0.05, 0.3)).toBe('improving');
    expect(normalizeTrend('escalations', 0.3, 0.05)).toBe('declining');
  });

  it('a move within epsilon is stable', () => {
    expect(normalizeTrend('taskSuccess', 0.90, 0.895)).toBe('stable');
    expect(normalizeTrend('corrections', 0.10, 0.11)).toBe('stable');
  });

  it('an UNKNOWN endpoint has no trend — it is not "stable"', () => {
    expect(normalizeTrend('autonomy', null, 0.5)).toBeNull();
    expect(normalizeTrend('autonomy', 0.5, null)).toBeNull();
    expect(normalizeTrend('autonomy', null, null)).toBeNull();
    // The trap this replaces: coercing both nulls to 0 lands inside epsilon.
    expect(normalizeTrend('autonomy', 0, 0)).toBe('stable');
  });
});

describe('computeAgentBenchmarks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('maps latest values + per-metric normalized trends for each agent', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          agent_id: 'a1', name: 'Engineer',
          latest_success: '0.92', latest_autonomy: '0.7', latest_escalation: '0.05', latest_correction: '0.02',
          base_success: '0.8', base_autonomy: '0.6', base_escalation: '0.2', base_correction: '0.15',
        },
      ],
    });
    const out = await computeAgentBenchmarks('tenant-1', 8);
    expect(out).toHaveLength(1);
    expect(out[0].agentId).toBe('a1');
    expect(out[0].metrics.taskSuccess).toEqual({ value: 0.92, trend: 'improving' }); // up = better
    expect(out[0].metrics.autonomy.trend).toBe('improving');
    expect(out[0].metrics.escalations).toEqual({ value: 0.05, trend: 'improving' }); // down = better
    expect(out[0].metrics.corrections.trend).toBe('improving');
    // scopes by tenant + weeks and only ACTIVE agents (SQL contains the guards).
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/agent_performance_snapshots/);
    expect(sql).toMatch(/lifecycle = 'ACTIVE'/);
    expect(params).toEqual(['tenant-1', '8']);
  });

  it('treats missing snapshot values as 0 without throwing', async () => {
    mockQuery.mockResolvedValue({ rows: [{ agent_id: 'a2', name: 'New', latest_success: null, base_success: null, latest_autonomy: null, base_autonomy: null, latest_escalation: null, base_escalation: null, latest_correction: null, base_correction: null }] });
    const out = await computeAgentBenchmarks('tenant-1', 4);
    expect(out[0].metrics.taskSuccess.value).toBe(0);
    expect(out[0].metrics.taskSuccess.trend).toBe('stable');
  });

  it('propagates an UNKNOWN autonomy rate instead of reporting 0 / stable', async () => {
    mockQuery.mockResolvedValue({ rows: [{ agent_id: 'a3', name: 'Quiet', latest_success: '0.5', base_success: '0.5', latest_autonomy: null, base_autonomy: null, latest_escalation: '0', base_escalation: '0', latest_correction: '0', base_correction: '0' }] });
    const out = await computeAgentBenchmarks('tenant-1', 4);
    expect(out[0].metrics.autonomy.value).toBeNull();
    expect(out[0].metrics.autonomy.trend).toBeNull();
    // The siblings still read as numbers — only the nullable column propagates.
    expect(out[0].metrics.taskSuccess.value).toBe(0.5);
  });
});
