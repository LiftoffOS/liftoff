// Memory Cleanup Service Tests

import { runMemoryCleanup } from '../memory-cleanup-service';

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runMemoryCleanup', () => {
  it('deletes expired memories in batches', async () => {
    // First batch returns 100 (BATCH_SIZE), second returns 50 (< BATCH_SIZE → stop)
    mockQuery
      .mockResolvedValueOnce({ rowCount: 100, rows: Array(100).fill({ id: 'x' }) })
      .mockResolvedValueOnce({ rowCount: 50, rows: Array(50).fill({ id: 'x' }) })
      // superseded batches
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      // Change B rollup + events sweeps (mockResolvedValue fallback below covers any extras)
      .mockResolvedValue({ rowCount: 0, rows: [] });

    const result = await runMemoryCleanup('tenant-1');
    expect(result.expiredDeleted).toBe(150);
    expect(result.tenantId).toBe('tenant-1');
  });

  it('deletes superseded memories after retention period', async () => {
    // expired batch
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      // superseded batch
      .mockResolvedValueOnce({ rowCount: 25, rows: Array(25).fill({ id: 'x' }) })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValue({ rowCount: 0, rows: [] });

    const result = await runMemoryCleanup('tenant-1');
    expect(result.supersededDeleted).toBe(25);
  });

  it('returns zero counts for empty tenant', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });

    const result = await runMemoryCleanup('tenant-empty');
    expect(result.expiredDeleted).toBe(0);
    expect(result.supersededDeleted).toBe(0);
  });

  it('uses FOR UPDATE SKIP LOCKED for memories deletes', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });

    await runMemoryCleanup('tenant-1');

    // Only assert FOR UPDATE SKIP LOCKED on queries that DELETE from `memories`
    // and `memory_retrieval_events`. The simple rollup-aggregate DELETE on
    // memory_influence_rollup is tenant-bounded and doesn't need the lock hint.
    const lockedDeleteCalls = mockQuery.mock.calls.filter((call: any[]) =>
      typeof call[0] === 'string' &&
      call[0].includes('DELETE FROM memories') ||
      (typeof call[0] === 'string' && call[0].includes('DELETE FROM memory_retrieval_events')),
    );
    for (const call of lockedDeleteCalls) {
      expect(call[0]).toContain('FOR UPDATE SKIP LOCKED');
    }
    // Sanity: at least one such call was made
    expect(lockedDeleteCalls.length).toBeGreaterThan(0);
  });
});
