// Counts Service Tests
//
// Verifies the three all-time count probes and the empty-state verdict.
// The point of the service is to gate the expensive report fan-out, so the
// key correctness properties are: tenant_id scoping, the same row filters
// the report uses, and an accurate isEmpty boolean.

const mockQuery = jest.fn();

jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  getPool: () => ({ query: mockQuery }),
};
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__db.getPool());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__db.getPool());
  return __db;
});

import {
  countAgents,
  countInvocations,
  countAuditActions,
  getInsightsCounts,
} from '../counts-service';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  mockQuery.mockReset();
});

describe('countAgents', () => {
  it('returns the count from the first row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    expect(await countAgents(TENANT_ID)).toBe(7);
  });

  it('returns 0 when the row set is empty', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await countAgents(TENANT_ID)).toBe(0);
  });

  it('filters by tenant_id and excludes deleted agents', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    await countAgents(TENANT_ID);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/FROM internal_agents/);
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(mockQuery.mock.calls[0][1]).toEqual([TENANT_ID]);
  });
});

describe('countInvocations', () => {
  it('returns the count from the first row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '42' }] });
    expect(await countInvocations(TENANT_ID)).toBe(42);
  });

  it('mirrors the row filters used by getInvocationStats', async () => {
    // Without this, a tenant whose only events are platform_overhead would
    // be misreported as "non-empty" and we'd run the full report fan-out
    // only to render zeroed cards.
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    await countInvocations(TENANT_ID);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/FROM cost_attribution_events/);
    expect(sql).toMatch(/source\s+= 'tenant_runtime'/);
    expect(sql).toMatch(/event_type\s+= 'llm_invocation'/);
    expect(sql).toMatch(/cost_bucket\s+<> 'platform_overhead'/);
  });
});

describe('countAuditActions', () => {
  it('returns the count from the first row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '999' }] });
    expect(await countAuditActions(TENANT_ID)).toBe(999);
  });

  it('filters by tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    await countAuditActions(TENANT_ID);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/FROM agent_audit_logs/);
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(mockQuery.mock.calls[0][1]).toEqual([TENANT_ID]);
  });
});

describe('getInsightsCounts', () => {
  function mockCounts(agentCount: number, invocationCount: number, auditCount: number) {
    // The orchestrator runs the three queries in Promise.all, so the order
    // is deterministic: agents, invocations, audit (per countsService source).
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: String(agentCount) }] })
      .mockResolvedValueOnce({ rows: [{ count: String(invocationCount) }] })
      .mockResolvedValueOnce({ rows: [{ count: String(auditCount) }] });
  }

  it('reports isEmpty=true only when all three counts are zero', async () => {
    mockCounts(0, 0, 0);
    expect(await getInsightsCounts(TENANT_ID)).toEqual({
      agentCount: 0,
      invocationCount: 0,
      auditCount: 0,
      isEmpty: true,
    });
  });

  it('reports isEmpty=false when only agents exist (e.g. fresh agent, no run yet)', async () => {
    mockCounts(2, 0, 0);
    const result = await getInsightsCounts(TENANT_ID);
    expect(result.isEmpty).toBe(false);
    expect(result.agentCount).toBe(2);
  });

  it('reports isEmpty=false when only invocations exist (e.g. hard-deleted agents)', async () => {
    mockCounts(0, 5, 0);
    const result = await getInsightsCounts(TENANT_ID);
    expect(result.isEmpty).toBe(false);
    expect(result.invocationCount).toBe(5);
  });

  it('reports isEmpty=false when only audit history exists', async () => {
    mockCounts(0, 0, 8);
    const result = await getInsightsCounts(TENANT_ID);
    expect(result.isEmpty).toBe(false);
    expect(result.auditCount).toBe(8);
  });

  it('runs the three count queries in parallel', async () => {
    mockCounts(1, 1, 1);
    await getInsightsCounts(TENANT_ID);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});
