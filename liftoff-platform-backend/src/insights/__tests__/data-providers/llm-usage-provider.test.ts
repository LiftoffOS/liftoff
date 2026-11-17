// LLM Usage Provider Tests
//
// Three methods:
//   getAgentLLMCosts        — agent-attributed entries grouped by agent_id + purpose
//   getAgentlessLLMCosts    — agent_id IS NULL entries, one row per purpose
//
// All three read from `cost_attribution_events` and surface `customer_cost_usd`
// as `estimatedCostUsd` (the bucket-rated charge already computed upstream by
// the cost-attribution pipeline). Per-model pricing happens at ingest time —
// these providers do NOT recompute it from token counts.
//
// failedAttemptsCostUsd uses `CASE WHEN correlation_confidence = 'unmatched'`
// to break out the unmatched portion of customer_cost_usd. It is INCLUDED in
// estimatedCostUsd (breakdown field, not additive).
//
// Unit-style mocks per Q4 — no real Postgres.

const mockQuery = jest.fn();
jest.mock('../../../infrastructure/database', () => {
  const __db: any = {
  getPool: jest.fn(() => ({ query: mockQuery })),
};
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__db.getPool());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__db.getPool());
  return __db;
});

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import {
  getAgentLLMCosts,
  getAgentlessLLMCosts,
} from '../../data-providers/llm-usage-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';
const range = {
  start: new Date('2026-04-01T00:00:00Z'),
  end: new Date('2026-04-08T00:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

// ── getAgentLLMCosts ──────────────────────────────────────────────────────

describe('getAgentLLMCosts', () => {
  it('groups by agent + purpose and surfaces customer_cost_usd as estimatedCostUsd', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          agent_id: 'a1',
          purpose: 'distill',
          input_tokens: '50000',
          output_tokens: '10000',
          cost_usd: '0.30',           // wholesale compute
          ou_consumed: '5.5',
          customer_cost_usd: '0.55',  // bucket-rated charge
          failed_cost_usd: '0',
        },
        {
          agent_id: 'a1',
          purpose: 'capability_analysis',
          input_tokens: '20000',
          output_tokens: '4000',
          cost_usd: '0.10',
          ou_consumed: '2.2',
          customer_cost_usd: '0.22',
          failed_cost_usd: '0',
        },
      ],
    });

    const result = await getAgentLLMCosts(tenantId, range);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      agentId: 'a1',
      purpose: 'distill',
      totalInputTokens: 50000,
      totalOutputTokens: 10000,
      estimatedCostUsd: 0.55,
      rawModelCostUsd: 0.30,
      ouConsumed: 5.5,
      failedAttemptsCostUsd: 0,
    });
    expect(result[1].purpose).toBe('capability_analysis');
    expect(result[1].estimatedCostUsd).toBe(0.22);
  });

  it('returns one row per agent+purpose group (DB-side aggregation, not client-side)', async () => {
    // GROUP BY agent_id, purpose happens in SQL — the provider just maps
    // rows 1:1. A single row per group is what the implementation expects.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          agent_id: 'a1',
          purpose: 'distill',
          input_tokens: '15000',
          output_tokens: '3000',
          cost_usd: '0.09',
          ou_consumed: '1.5',
          customer_cost_usd: '0.18',
          failed_cost_usd: '0',
        },
      ],
    });

    const result = await getAgentLLMCosts(tenantId, range);
    expect(result).toHaveLength(1);
    expect(result[0].totalInputTokens).toBe(15000);
    expect(result[0].totalOutputTokens).toBe(3000);
    expect(result[0].estimatedCostUsd).toBe(0.18);
  });

  it('returns empty array when no agent-attributed usage exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getAgentLLMCosts(tenantId, range);
    expect(result).toEqual([]);
  });

  it('returns empty array on query error (fail-soft)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));
    const result = await getAgentLLMCosts(tenantId, range);
    expect(result).toEqual([]);
  });

  it('passes tenantId + range bind params and filters agent_id IS NOT NULL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getAgentLLMCosts(tenantId, range);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([tenantId, range.start, range.end]);
    expect(sql).toContain('agent_id       IS NOT NULL');
    // Implementation filters source=platform_llm + event_type=llm_invocation
    // + excludes platform_overhead bucket — operator-cost rows only.
    expect(sql).toContain("source         = 'platform_llm'");
    expect(sql).toContain("event_type     = 'llm_invocation'");
    expect(sql).toContain("cost_bucket    <> 'platform_overhead'");
    expect(sql).toMatch(/GROUP\s+BY\s+agent_id,\s*purpose/i);
  });

  it('tracks failedAttemptsCostUsd as a breakdown of estimatedCostUsd (unmatched portion)', async () => {
    // CASE WHEN correlation_confidence = 'unmatched' THEN customer_cost_usd
    // → failed_cost_usd. The DB returns the unmatched-only portion of cost.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          agent_id: 'a1',
          purpose: 'distill',
          input_tokens: '50000',
          output_tokens: '10000',
          cost_usd: '0.30',
          ou_consumed: '5.5',
          customer_cost_usd: '0.55',  // total (successful + unmatched)
          failed_cost_usd: '0.11',    // unmatched portion only
        },
      ],
    });

    const result = await getAgentLLMCosts(tenantId, range);
    expect(result).toHaveLength(1);
    expect(result[0].estimatedCostUsd).toBe(0.55);
    expect(result[0].failedAttemptsCostUsd).toBe(0.11);
  });

  it('null token columns are coerced to 0', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          agent_id: 'a1',
          purpose: 'distill',
          input_tokens: null,
          output_tokens: null,
          cost_usd: '0',
          ou_consumed: '0',
          customer_cost_usd: '0',
          failed_cost_usd: '0',
        },
      ],
    });
    const result = await getAgentLLMCosts(tenantId, range);
    expect(result[0].totalInputTokens).toBe(0);
    expect(result[0].totalOutputTokens).toBe(0);
  });
});

// ── getAgentlessLLMCosts ──────────────────────────────────────────────────

describe('getAgentlessLLMCosts', () => {
  it('returns one row per purpose', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { purpose: 'liftoff_chat', input_tokens: '12345', output_tokens: '6789',
          cost_usd: '0.50', ou_consumed: '15.0', customer_cost_usd: '1.20' },
        { purpose: 'caio_workforce_planning', input_tokens: '8000', output_tokens: '2000',
          cost_usd: '0.20', ou_consumed: '6.0', customer_cost_usd: '0.60' },
      ],
    });

    const result = await getAgentlessLLMCosts(tenantId, range);

    expect(result).toEqual([
      { purpose: 'liftoff_chat', totalInputTokens: 12345, totalOutputTokens: 6789,
        estimatedCostUsd: 1.20, rawModelCostUsd: 0.50, ouConsumed: 15.0 },
      { purpose: 'caio_workforce_planning', totalInputTokens: 8000, totalOutputTokens: 2000,
        estimatedCostUsd: 0.60, rawModelCostUsd: 0.20, ouConsumed: 6.0 },
    ]);
  });

  it('returns nothing when the workspace spent nothing agentless', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getAgentlessLLMCosts(tenantId, range)).toEqual([]);
  });

  it('returns nothing on query error (fail-soft)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    expect(await getAgentlessLLMCosts(tenantId, range)).toEqual([]);
  });

  it('names no purpose of its own — the bucket is the whole filter', async () => {
    // This replaced two queries whose only difference was a hand-maintained
    // list of CAIO purposes, one selecting `NOT IN` and the other `IN`. Keeping
    // them complementary by hand is how a purpose in neither became money that
    // reached no reader. Chargeability lives in event-classification.ts and is
    // read here as `cost_bucket`, so a purpose list appearing in this SQL again
    // would be that defect coming back.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getAgentlessLLMCosts(tenantId, range);
    const [sql, params] = mockQuery.mock.calls[0];

    expect(params).toEqual([tenantId, range.start, range.end]);
    expect(sql).toContain('agent_id     IS NULL');
    expect(sql).toContain("cost_bucket <> 'platform_overhead'");
    expect(sql).toContain('GROUP BY purpose');
    expect(sql).not.toMatch(/purpose\s+(NOT\s+)?IN/i);
    for (const purpose of [
      "'caio_workforce_planning'", "'liftoff_chat'", "'insights_chat'", "'agent_chat'",
    ]) {
      expect(sql).not.toContain(purpose);
    }
  });
});
