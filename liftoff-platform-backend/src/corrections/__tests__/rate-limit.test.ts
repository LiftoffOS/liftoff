// Correction Protocol Rate Limit Window Transition Tests
// [TE-006] Test rate limit window transitions

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

describe('Rate Limit Window Transitions', () => {
  let repository: CorrectionRepository;
  const tenantId = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    jest.resetModules();
    repository = new CorrectionRepository();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // [TE-006] Reset rate limit after minute window
  it('should reset rate limit after minute window', async () => {
    jest.useFakeTimers();

    const baseTime = new Date('2024-06-15T12:00:00Z');
    jest.setSystemTime(baseTime);

    // checkRateLimit calls: getRateLimits (1 query), then getRateUsage x3 (3 queries)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 2, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // minute at limit
      .mockResolvedValueOnce({ rows: [{ count: 50 }] }) // hour
      .mockResolvedValueOnce({ rows: [{ count: 200 }] }); // day

    const { _checkRateLimit: checkRateLimit } = require('../rate-limiter');

    // Should be rate limited
    let result = await checkRateLimit(tenantId);
    expect(result.allowed).toBe(false);

    // Advance past minute window
    jest.advanceTimersByTime(61 * 1000);

    // Reset mock for second check
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 2, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // minute reset
      .mockResolvedValueOnce({ rows: [{ count: 50 }] }) // hour
      .mockResolvedValueOnce({ rows: [{ count: 200 }] }); // day

    // Should be allowed again
    result = await checkRateLimit(tenantId);
    expect(result.allowed).toBe(true);
  });

  // [TE-006] Hour window transition
  it('should handle hour window transition', async () => {
    jest.useFakeTimers();

    const baseTime = new Date('2024-06-15T12:59:00Z');
    jest.setSystemTime(baseTime);

    // At hour limit
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // minute ok
      .mockResolvedValueOnce({ rows: [{ count: 100 }] }) // hour at limit
      .mockResolvedValueOnce({ rows: [{ count: 200 }] }); // day

    const { _checkRateLimit: checkRateLimit } = require('../rate-limiter');

    let result = await checkRateLimit(tenantId);
    expect(result.allowed).toBe(false);

    // Advance to next hour
    jest.advanceTimersByTime(2 * 60 * 1000);

    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // minute reset
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // hour reset
      .mockResolvedValueOnce({ rows: [{ count: 200 }] }); // day

    result = await checkRateLimit(tenantId);
    expect(result.allowed).toBe(true);
  });

  // [TE-006] Day window transition
  it('should handle day window transition', async () => {
    jest.useFakeTimers();

    const baseTime = new Date('2024-06-15T23:59:00Z');
    jest.setSystemTime(baseTime);

    // At day limit
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // minute
      .mockResolvedValueOnce({ rows: [{ count: 50 }] }) // hour
      .mockResolvedValueOnce({ rows: [{ count: 500 }] }); // day at limit

    const { _checkRateLimit: checkRateLimit } = require('../rate-limiter');

    let result = await checkRateLimit(tenantId);
    expect(result.allowed).toBe(false);

    // Advance to next day
    jest.advanceTimersByTime(2 * 60 * 1000);

    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // minute
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // hour
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }); // day reset

    result = await checkRateLimit(tenantId);
    expect(result.allowed).toBe(true);
  });

  // [TE-006] Cleanup old rate usage windows
  it('should cleanup old rate usage windows', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 15,
    });

    const _result = await repository.cleanupOldRateUsage();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE'),
      expect.any(Array)
    );
  });

  // [TE-006] Atomic rate limit check and increment
  it('should use atomic check and increment for rate limits', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT/UPDATE minute
      .mockResolvedValueOnce({ rows: [] }) // INSERT/UPDATE hour
      .mockResolvedValueOnce({ rows: [] }) // INSERT/UPDATE day
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await repository.checkAndIncrementRateUsage(tenantId);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      expect.any(Array)
    );
  });

  // [TE-006] Return correct retry-after value
  it('should return correct retry-after value for minute limit', async () => {
    jest.useFakeTimers();

    const baseTime = new Date('2024-06-15T12:00:30Z');
    jest.setSystemTime(baseTime);

    // checkRateLimit: 1 getRateLimits + 3 getRateUsage
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 2, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // minute at limit
      .mockResolvedValueOnce({ rows: [{ count: 50 }] }) // hour
      .mockResolvedValueOnce({ rows: [{ count: 200 }] }); // day

    const { _checkRateLimit: checkRateLimit } = require('../rate-limiter');
    const result = await checkRateLimit(tenantId);

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(60);
  });

  // [TE-006] Default limits when no custom config
  it('should use default limits when tenant has no custom config', async () => {
    // getRateLimits returns no rows → defaults used; then 3 getRateUsage
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // No custom limits → defaults
      .mockResolvedValueOnce({ rows: [] }) // minute usage (0)
      .mockResolvedValueOnce({ rows: [] }) // hour usage (0)
      .mockResolvedValueOnce({ rows: [] }); // day usage (0)

    const { _checkRateLimit: checkRateLimit } = require('../rate-limiter');
    const result = await checkRateLimit(tenantId);

    expect(result.allowed).toBe(true);
  });

  // [TE-006] Multiple window types tracked separately
  it('should track minute, hour, and day windows separately', async () => {
    // getRateLimits + 3 getRateUsage
    mockQuery
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // minute: 5
      .mockResolvedValueOnce({ rows: [{ count: 50 }] }) // hour: 50
      .mockResolvedValueOnce({ rows: [{ count: 200 }] }); // day: 200

    const { _checkRateLimit: checkRateLimit } = require('../rate-limiter');
    const result = await checkRateLimit(tenantId);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toEqual({
      minute: 5,
      hour: 50,
      day: 300,
    });
  });

  // [TE-006] Concurrent rate limit increments
  it('should handle concurrent rate limit increments atomically', async () => {
    mockQuery
      // First request
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ count: 8 }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
      // Second request
      .mockResolvedValueOnce({ rows: [{ max_per_minute: 10, max_per_hour: 100, max_per_day: 500 }] })
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ count: 9 }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const [result1, result2] = await Promise.all([
      repository.checkAndIncrementRateUsage(tenantId),
      repository.checkAndIncrementRateUsage(tenantId),
    ]);

    expect(result1.allowed).toBe(true);
    expect(result2.allowed).toBe(true);
  });
});
