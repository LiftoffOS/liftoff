const mockPoolQuery = jest.fn();

jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  insertSubmission,
  finalizeSubmission,
  markPolled,
  markHookActive,
  selectDueForReconciliation,
  sweepFinalizedSubmissions,
} from '../deep-research-registry';

beforeEach(() => { jest.clearAllMocks(); });

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT  = '22222222-2222-2222-2222-222222222222';
const DR_ID  = '33333333-3333-3333-3333-333333333333';

describe('insertSubmission', () => {
  it('inserts a row with ON CONFLICT DO NOTHING (idempotent)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await insertSubmission({
      deepResearchId:     DR_ID,
      submissionId:       'sub-abc',
      tenantId:           TENANT,
      agentId:            AGENT,
      vendor:             'perplexity',
      reasoningEffort:    'medium',
      estimateCostMicros: 400_000,
    });
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql as string).toMatch(/INSERT INTO deep_research_submissions/);
    expect(sql as string).toMatch(/ON CONFLICT \(deep_research_id\) DO NOTHING/);
    expect(params).toEqual([DR_ID, 'sub-abc', TENANT, AGENT, 'perplexity', 'medium', 400_000]);
  });

  it('accepts null agentId', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await insertSubmission({
      deepResearchId:     DR_ID, submissionId: 'sub-abc', tenantId: TENANT,
      agentId:            null,
      vendor:             'perplexity',
      reasoningEffort:    'low',  estimateCostMicros: 150_000,
    });
    expect(mockPoolQuery.mock.calls[0][1]?.[3]).toBeNull();
  });

  it('records vendor for OpenAI submissions', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await insertSubmission({
      deepResearchId:     DR_ID, submissionId: 'oai-1', tenantId: TENANT,
      agentId:            AGENT,
      vendor:             'openai',
      reasoningEffort:    'high', estimateCostMicros: 3_000_000,
    });
    expect(mockPoolQuery.mock.calls[0][1]?.[4]).toBe('openai');
  });

  it('records vendor for Google submissions', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await insertSubmission({
      deepResearchId:     DR_ID, submissionId: 'g-1', tenantId: TENANT,
      agentId:            AGENT,
      vendor:             'google',
      reasoningEffort:    'medium', estimateCostMicros: 3_000_000,
    });
    expect(mockPoolQuery.mock.calls[0][1]?.[4]).toBe('google');
  });
});

describe('finalizeSubmission', () => {
  it('updates final_status, final_cost_micros, finalized_at where final_status IS NULL', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await finalizeSubmission({ deepResearchId: DR_ID, finalStatus: 'completed', finalCostMicros: 480_000 });
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql as string).toMatch(/UPDATE deep_research_submissions/);
    expect(sql as string).toMatch(/SET final_status\s*=\s*\$2/);
    expect(sql as string).toMatch(/WHERE.*final_status IS NULL/s);
    expect(params).toEqual([DR_ID, 'completed', 480_000]);
  });
});

describe('markPolled', () => {
  it('increments polled_count and updates last_polled_at', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await markPolled(DR_ID);
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/polled_count\s*\+\s*1/);
  });
});

describe('markHookActive (Gap #5 — hook heartbeat)', () => {
  it('UPDATEs hook_active_until = NOW() + ttl seconds', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await markHookActive(DR_ID, 30);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql as string).toMatch(/SET hook_active_until\s*=\s*NOW\(\)\s*\+\s*\(\$2 \|\| ' seconds'\)::interval/);
    expect(params).toEqual([DR_ID, '30']);
  });

  it('defaults ttl to 30 seconds when not provided', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await markHookActive(DR_ID);
    expect(mockPoolQuery.mock.calls[0][1]?.[1]).toBe('30');
  });
});

describe('selectDueForReconciliation — adaptive cadence', () => {
  it('SELECT includes all 4 adaptive cadence branches + hook-active skip + NO row locks', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await selectDueForReconciliation(100);
    const sql = mockPoolQuery.mock.calls[0][0] as string;
    // 4 branches: <5min/60s, 5-30min/120s, 30min-24h/300s, >24h/1h
    expect(sql).toMatch(/INTERVAL '5 minutes'.*INTERVAL '50 seconds'/s);
    expect(sql).toMatch(/INTERVAL '30 minutes'.*INTERVAL '110 seconds'/s);
    expect(sql).toMatch(/INTERVAL '24 hours'.*INTERVAL '290 seconds'/s);
    expect(sql).toMatch(/INTERVAL '24 hours'.*INTERVAL '55 minutes'/s);
    expect(sql).toMatch(/WHERE final_status IS NULL/);
    // Gap #5 — hook-active skip predicate
    expect(sql).toMatch(/hook_active_until IS NULL OR hook_active_until < NOW\(\)/);
    expect(sql).toMatch(/LIMIT \$1/);
    // Gap #1 — NO FOR UPDATE / SKIP LOCKED. Multi-replica safety is
    // achieved via PB ingester idempotency_key dedup, not row locks.
    expect(sql).not.toMatch(/FOR UPDATE/);
    expect(sql).not.toMatch(/SKIP LOCKED/);
  });

  it('maps row shape to camelCase output (vendor included)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        deep_research_id:     DR_ID,
        submission_id:        'sub-abc',
        tenant_id:            TENANT,
        agent_id:             AGENT,
        vendor:               'openai',
        reasoning_effort:     'high',
        estimate_cost_micros: '3000000',
        submitted_at:         new Date('2026-06-01T10:00:00Z'),
        last_polled_at:       null,
        polled_count:         0,
      }],
    });
    const rows = await selectDueForReconciliation(100);
    expect(rows[0]).toMatchObject({
      deepResearchId:     DR_ID,
      submissionId:       'sub-abc',
      tenantId:           TENANT,
      agentId:            AGENT,
      vendor:             'openai',
      reasoningEffort:    'high',
      estimateCostMicros: 3_000_000,
      polledCount:        0,
    });
  });

  it('SELECT projects vendor column', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await selectDueForReconciliation(100);
    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/\bvendor\b/);
  });
});

describe('sweepFinalizedSubmissions', () => {
  it('DELETEs rows past retention; returns deleted count', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 7 });
    const n = await sweepFinalizedSubmissions(90);
    expect(n).toBe(7);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql as string).toMatch(/DELETE FROM deep_research_submissions/);
    expect(sql as string).toMatch(/finalized_at < NOW\(\) - \(\$1 \|\| ' days'\)::interval/);
    expect(params).toEqual(['90']);
  });
});
