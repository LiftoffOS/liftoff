// Insights Rate Limiter Tests
// Tests: atomic check-and-increment, per-tenant and per-user limits, fail-open

const mockQuery = jest.fn();
(global as any).__mockQuery = mockQuery;

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({
    query: (...args: unknown[]) => (global as any).__mockQuery(...args),
  }),
  // chat-rate-limiter now runs its ledger queries under withTenantScope
  // (RLS-force); route the client to the same mockQuery so the ordered
  // check-then-rollback sequences still line up.
  withTenantScope: (_tenantId: string, cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...args: unknown[]) => (global as any).__mockQuery(...args) }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { checkAndIncrementInsightsRateLimit } from '../rate-limiter';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';
const accountId = '223e4567-e89b-12d3-a456-426614174000';

describe('checkAndIncrementInsightsRateLimit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  it('should allow when under all limits', async () => {
    // Atomic insert + count query
    mockQuery.mockResolvedValueOnce({
      rows: [{
        tenant_minute: '1', tenant_hour: '5', tenant_day: '20',
        user_minute: '1', user_hour: '3', user_day: '10',
      }],
    });

    const result = await checkAndIncrementInsightsRateLimit(tenantId, accountId);
    expect(result.allowed).toBe(true);
    expect(result.remaining.minute).toBeGreaterThan(0);
    expect(result.remaining.hour).toBeGreaterThan(0);
    expect(result.remaining.day).toBeGreaterThan(0);
  });

  it('should deny when tenant minute limit exceeded and rollback', async () => {
    // Atomic insert + count: tenant_minute exceeds 20
    mockQuery.mockResolvedValueOnce({
      rows: [{
        tenant_minute: '21', tenant_hour: '50', tenant_day: '100',
        user_minute: '1', user_hour: '3', user_day: '10',
      }],
    });
    // Rollback delete
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await checkAndIncrementInsightsRateLimit(tenantId, accountId);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.remaining.minute).toBe(0);
    // Verify rollback was called
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('should deny when user minute limit exceeded and rollback', async () => {
    // Tenant OK but user_minute exceeds 5
    mockQuery.mockResolvedValueOnce({
      rows: [{
        tenant_minute: '5', tenant_hour: '50', tenant_day: '100',
        user_minute: '6', user_hour: '10', user_day: '30',
      }],
    });
    // Rollback delete
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await checkAndIncrementInsightsRateLimit(tenantId, accountId);
    expect(result.allowed).toBe(false);
    expect(result.remaining.minute).toBe(0);
  });

  it('should deny when tenant hour limit exceeded', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        tenant_minute: '5', tenant_hour: '121', tenant_day: '200',
        user_minute: '1', user_hour: '3', user_day: '10',
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await checkAndIncrementInsightsRateLimit(tenantId, accountId);
    expect(result.allowed).toBe(false);
    expect(result.remaining.hour).toBe(0);
  });

  it('should deny when tenant day limit exceeded', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        tenant_minute: '5', tenant_hour: '50', tenant_day: '501',
        user_minute: '1', user_hour: '3', user_day: '10',
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await checkAndIncrementInsightsRateLimit(tenantId, accountId);
    expect(result.allowed).toBe(false);
    expect(result.remaining.day).toBe(0);
  });

  it('should fail open on database error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Connection failed'));

    const result = await checkAndIncrementInsightsRateLimit(tenantId, accountId);
    expect(result.allowed).toBe(true);
  });

  it('should use CTE for atomic insert + count', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        tenant_minute: '1', tenant_hour: '1', tenant_day: '1',
        user_minute: '1', user_hour: '1', user_day: '1',
      }],
    });

    await checkAndIncrementInsightsRateLimit(tenantId, accountId);

    // First query should be the CTE with INSERT
    const firstCallSql = mockQuery.mock.calls[0][0] as string;
    expect(firstCallSql).toContain('WITH inserted AS');
    expect(firstCallSql).toContain('INSERT INTO insights_rate_limit_events');
  });
});
