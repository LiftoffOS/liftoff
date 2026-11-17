// Invocations Provider Tests
//
// Both methods query cost_attribution_events directly (refactored from the
// earlier tenant-runtime-client HTTP wrapper). Tests cover:
//   - SQL bind params (tenantId + range)
//   - Optional agentId filter in getInvocationStats
//   - Customer-cost vs. raw-model-cost separation in getAgentCosts
//   - Empty-rows / null-rows handling
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
  getAgentCosts,
  getInvocationStats,
} from '../../data-providers/invocations-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';
const range = {
  start: new Date('2026-04-01T00:00:00Z'),
  end: new Date('2026-04-08T00:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe('getInvocationStats', () => {
  it('returns summed stats from cost_attribution_events for the tenant + range', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          cost_usd: '12.5',
          input_tokens: '1000',
          output_tokens: '500',
          invocations: '42',
          uncosted_invocations: '3',
          uncosted_input_tokens: '90',
          uncosted_output_tokens: '40',
        },
      ],
    });

    const result = await getInvocationStats(tenantId, range);

    expect(result).toEqual({
      totalCostUsd: 12.5,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      invocationCount: 42,
      // Real tokens, zero dollars. Reported as its own number because a total
      // alone cannot distinguish "this was cheap" from "we never learned what
      // this cost", and only the first is good news.
      uncostedInvocationCount: 3,
      uncostedInputTokens: 90,
      uncostedOutputTokens: 40,
    });
    // Bind params: tenantId, range.start, range.end (no agentId).
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([tenantId, range.start, range.end]);
  });

  it('appends agent_id = $4 filter + bind param when agentId is supplied', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          cost_usd: '1.0',
          input_tokens: '100',
          output_tokens: '50',
          invocations: '1',
        },
      ],
    });

    await getInvocationStats(tenantId, range, 'agent-xyz');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('AND agent_id = $4');
    expect(params).toEqual([tenantId, range.start, range.end, 'agent-xyz']);
  });

  it('does NOT include the agent_id filter when agentId is omitted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cost_usd: '0', input_tokens: null, output_tokens: null, invocations: '0' }] });
    await getInvocationStats(tenantId, range);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('AND agent_id = $4');
  });

  it('returns null when the query returns no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getInvocationStats(tenantId, range);
    expect(result).toBeNull();
  });

  it('coerces null input/output tokens to 0', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ cost_usd: '3.0', input_tokens: null, output_tokens: null, invocations: '5' }],
    });
    const result = await getInvocationStats(tenantId, range);
    expect(result?.totalInputTokens).toBe(0);
    expect(result?.totalOutputTokens).toBe(0);
    expect(result?.invocationCount).toBe(5);
  });

  it('filters tenant_runtime / llm_invocation / non-platform-overhead by SQL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cost_usd: '0', input_tokens: null, output_tokens: null, invocations: '0' }] });
    await getInvocationStats(tenantId, range);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("source       = 'tenant_runtime'");
    expect(sql).toContain("event_type   = 'llm_invocation'");
    expect(sql).toContain("cost_bucket  <> 'platform_overhead'");
  });
});

describe('getAgentCosts', () => {
  it('groups by agent_id and exposes customer cost / raw model cost separately', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          agent_id: 'a1',
          cost_usd: '6.50',          // raw wholesale compute cost
          ou_consumed: '320.0',
          customer_cost_usd: '10.50', // customer-charged (bucket-rated)
          input_tokens: '5000',
          output_tokens: '2500',
          cached_tokens: '0',
          invocations: '20',
          uncosted_invocations: '2',
          uncosted_input_tokens: '300',
          uncosted_output_tokens: '100',
        },
        {
          agent_id: 'a2',
          cost_usd: '2.10',
          ou_consumed: '120.0',
          customer_cost_usd: '4.25',
          input_tokens: '2000',
          output_tokens: '1000',
          cached_tokens: '0',
          invocations: '12',
          uncosted_invocations: '0',
          uncosted_input_tokens: '0',
          uncosted_output_tokens: '0',
        },
      ],
    });

    const result = await getAgentCosts(tenantId, range);

    expect(result.a1).toEqual({
      totalCostUsd: 10.5,        // customer-charged
      rawModelCostUsd: 6.5,      // wholesale compute
      ouConsumed: 320,
      invocationCount: 20,
      totalInputTokens: 5000,
      totalOutputTokens: 2500,
      totalCachedTokens: 0,
      uncostedInvocationCount: 2,
      uncostedInputTokens: 300,
      uncostedOutputTokens: 100,
    });
    expect(result.a2.totalCostUsd).toBe(4.25);
    expect(result.a2.invocationCount).toBe(12);
  });

  it('SQL filters agent_id IS NOT NULL and bucket != platform_overhead', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getAgentCosts(tenantId, range);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('agent_id     IS NOT NULL');
    expect(sql).toContain("cost_bucket  <> 'platform_overhead'");
    expect(params).toEqual([tenantId, range.start, range.end]);
  });

  it('returns an empty object when the query returns no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getAgentCosts(tenantId, range);
    expect(result).toEqual({});
  });

  it('coerces null token columns to 0 per agent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          agent_id: 'a-null-tokens',
          cost_usd: '0',
          ou_consumed: '0',
          customer_cost_usd: '0',
          input_tokens: null,
          output_tokens: null,
          cached_tokens: null,
          invocations: '0',
        },
      ],
    });
    const result = await getAgentCosts(tenantId, range);
    expect(result['a-null-tokens'].totalInputTokens).toBe(0);
    expect(result['a-null-tokens'].totalOutputTokens).toBe(0);
    expect(result['a-null-tokens'].totalCachedTokens).toBe(0);
    // A row with no uncosted_* columns at all (an older shape) reads as zero
    // rather than NaN.
    expect(result['a-null-tokens'].uncostedInvocationCount).toBe(0);
    expect(result['a-null-tokens'].uncostedInputTokens).toBe(0);
    expect(result['a-null-tokens'].uncostedOutputTokens).toBe(0);
  });

  it('splits out the rows that consumed tokens and reported no cost', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getAgentCosts(tenantId, range);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('uncosted_invocations');
    expect(sql).toContain('COALESCE(cost_usd, 0) = 0');
    expect(sql).toContain('COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0');
  });
});
