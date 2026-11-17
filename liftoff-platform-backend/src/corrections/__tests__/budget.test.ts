// Correction Protocol Budget Period Rollover Tests
// [TE-P2-002] Test budget period rollover edge cases

// Mock query function - stable reference
const mockQuery = jest.fn();

// Set global mock reference IMMEDIATELY before jest.mock to avoid hoisting issues
(global as any).__mockQuery = mockQuery;

// Mock external dependencies
jest.mock('../../infrastructure/database', () => {
  const runQuery = (...args: unknown[]) => {
    const sql = typeof args[0] === 'string' ? args[0] : '';
    // RLS: own-tx methods issue SELECT set_config('app.current_tenant_id', ...)
    // right after BEGIN to scope the transaction. Swallow it here so these
    // ordered __mockQuery sequences don't shift (the real ceremony is covered
    // by integration tests).
    if (sql.includes('set_config')) return Promise.resolve({ rows: [] });
    return (global as any).__mockQuery(...args);
  };
  const mkClient = () => ({ query: runQuery, release: jest.fn() });
  return {
    pool: { query: runQuery, connect: () => mkClient() },
    getPool: () => ({ query: runQuery }),
    // RLS wrappers invoke the callback with a mock client so existing
    // __mockQuery assertions still see the real SQL.
    withTenantScope: (_tenantId: string, fn: (c: unknown) => unknown) => fn(mkClient()),
    withAdminScope: (_ctx: unknown, fn: (c: unknown) => unknown) => fn(mkClient()),
  };
});

jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { CorrectionRepository } from '../repository';

describe('Budget Period Rollover', () => {
  let repository: CorrectionRepository;
  const tenantId = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    repository = new CorrectionRepository();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // [TE-P2-002] Handle budget check during period rollover
  it('should handle budget check during period rollover', async () => {
    jest.useFakeTimers();

    // Use mid-day dates to avoid timezone issues (getMonth() uses local time)
    jest.setSystemTime(new Date('2024-01-15T12:00:00Z'));

    // Budget near limit in current period
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          budget_limit: 10,
          budget_used: 9,
          budget_period: 'monthly',
          period_start: new Date('2024-01-02T12:00:00Z'),
          timezone: 'UTC',
        }],
      }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await repository.checkAndDeductBudget(tenantId);

    // Should still have budget in current period
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0); // Last one used
  });

  // [TE-P2-002] Reset budget atomically on new period
  it('should reset budget atomically on new period', async () => {
    jest.useFakeTimers();

    // Budget exhausted in old period
    const oldPeriodStart = new Date('2024-01-01T00:00:00Z');
    jest.setSystemTime(new Date('2024-02-01T00:00:01Z'));

    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          budget_limit: 10,
          budget_used: 10, // Exhausted
          budget_period: 'monthly',
          period_start: oldPeriodStart,
          timezone: 'UTC',
        }],
      }) // SELECT FOR UPDATE - detects old period
      .mockResolvedValueOnce({ rows: [] }) // UPDATE - reset period
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await repository.checkAndDeductBudget(tenantId);

    // Should detect new period and allow (after reset)
    expect(result.allowed).toBe(true);
  });

  // [TE-P2-002] Handle timezone-aware budget periods
  it('should respect timezone for budget period calculation', async () => {
    jest.useFakeTimers();

    // Midnight in UTC, but not in America/New_York
    jest.setSystemTime(new Date('2024-02-01T00:00:00Z')); // Still Jan 31 in NYC

    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          budget_limit: 10,
          budget_used: 5,
          budget_period: 'monthly',
          period_start: new Date('2024-01-01T05:00:00Z'), // Jan 1 midnight EST
          timezone: 'America/New_York',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await repository.checkAndDeductBudget(tenantId);

    // Should still be in January for America/New_York
    expect(result.allowed).toBe(true);
  });

  // [TE-P2-002] Budget period types
  describe('Budget Period Types', () => {
    it('should handle daily budget period', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-06-15T12:00:00Z'));

      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            budget_limit: 100,
            budget_used: 50,
            budget_period: 'daily',
            period_start: new Date('2024-06-15T12:00:00Z'),
            timezone: 'UTC',
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await repository.checkAndDeductBudget(tenantId);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(49);
    });

    it('should handle weekly budget period', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-06-19T12:00:00Z')); // Wednesday

      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            budget_limit: 500,
            budget_used: 200,
            budget_period: 'weekly',
            period_start: new Date('2024-06-17T00:00:00Z'), // Monday
            timezone: 'UTC',
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await repository.checkAndDeductBudget(tenantId);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(299);
    });

    it('should handle quarterly budget period (falls through to monthly check)', async () => {
      jest.useFakeTimers();
      // Same month as period_start so isNewPeriod returns false
      jest.setSystemTime(new Date('2024-01-20T12:00:00Z'));

      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            budget_limit: 1000,
            budget_used: 300,
            budget_period: 'quarterly',
            period_start: new Date('2024-01-15T12:00:00Z'),
            timezone: 'UTC',
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await repository.checkAndDeductBudget(tenantId);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(699);
    });

    it('should handle yearly budget period (falls through to monthly check)', async () => {
      jest.useFakeTimers();
      // Same month as period_start so isNewPeriod returns false
      jest.setSystemTime(new Date('2024-01-20T12:00:00Z'));

      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            budget_limit: 10000,
            budget_used: 5000,
            budget_period: 'yearly',
            period_start: new Date('2024-01-15T12:00:00Z'),
            timezone: 'UTC',
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await repository.checkAndDeductBudget(tenantId);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4999);
    });
  });

  // [TE-P2-002] Unlimited budget (null limit)
  it('should allow unlimited corrections when budget_limit is null', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-15T12:00:00Z'));

    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          budget_limit: null, // Unlimited
          budget_used: 9999,
          budget_period: 'monthly',
          period_start: new Date('2024-01-02T12:00:00Z'),
          timezone: 'UTC',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await repository.checkAndDeductBudget(tenantId);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeNull(); // Unlimited
  });

  // [TE-P2-002] Exactly at budget limit
  it('should deny when exactly at budget limit', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-15T12:00:00Z'));

    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          budget_limit: 100,
          budget_used: 100, // At limit
          budget_period: 'monthly',
          period_start: new Date('2024-01-02T12:00:00Z'),
          timezone: 'UTC',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const result = await repository.checkAndDeductBudget(tenantId);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  // [TE-P2-002] Over budget (shouldn't happen, but handle gracefully)
  it('should deny when over budget limit', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-15T12:00:00Z'));

    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          budget_limit: 100,
          budget_used: 105, // Over limit (edge case)
          budget_period: 'monthly',
          period_start: new Date('2024-01-02T12:00:00Z'),
          timezone: 'UTC',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await repository.checkAndDeductBudget(tenantId);

    expect(result.allowed).toBe(false);
  });

  // [TE-P2-002] No budget configured (defaults)
  it('should use defaults when no budget configured', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT - no budget

    const result = await repository.checkAndDeductBudget(tenantId);

    // No budget = unlimited
    expect(result.allowed).toBe(true);
  });

  // [TE-P2-002] Atomic budget deduction
  it('should use SELECT FOR UPDATE for atomic budget operations', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-15T12:00:00Z'));

    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          budget_limit: 100,
          budget_used: 50,
          budget_period: 'monthly',
          period_start: new Date('2024-01-02T12:00:00Z'),
          timezone: 'UTC',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await repository.checkAndDeductBudget(tenantId);

    // Verify FOR UPDATE is used
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      expect.any(Array)
    );
  });

});
