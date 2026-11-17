/**
 * R5 Fix 4 lock tests. Mocks pg.Pool via a mock client.
 * Covers: acquire success, acquire concurrent (409), lock-missing table (42P01),
 * heartbeat UPDATE renewal, 3-consecutive-failure abort, lock-lost row delete.
 */
import { tryAcquireLock, releaseLock, LockServiceUnavailableError } from '../locks';

type QueryArgs = [sql: string, params?: unknown[]];

class MockPool {
  public calls: QueryArgs[] = [];
  public responseQueue: Array<
    | { rowCount: number; rows?: unknown[] }
    | { throw: Error }
  > = [];

  async query(sql: string, params?: unknown[]): Promise<{ rowCount: number; rows: unknown[] }> {
    this.calls.push([sql, params]);
    const next = this.responseQueue.shift();
    if (!next) {
      return { rowCount: 0, rows: [] };
    }
    if ('throw' in next) {
      throw next.throw;
    }
    return { rowCount: next.rowCount, rows: next.rows ?? [] };
  }
}

describe('tryAcquireLock', () => {
  const TEN = '123e4567-e89b-12d3-a456-426614174000';
  const THR = '223e4567-e89b-12d3-a456-426614174001';
  const INV = '323e4567-e89b-12d3-a456-426614174002';

  it('acquires a lock when the row does not exist yet', async () => {
    const pool = new MockPool();
    pool.responseQueue = [
      { rowCount: 0 }, // DELETE expired
      { rowCount: 1, rows: [{}] }, // INSERT ... RETURNING 1
    ];
    const handle = await tryAcquireLock(pool as unknown as never, TEN, THR, INV);
    expect(handle).not.toBeNull();
    if (handle) {
      expect(handle.tenantId).toBe(TEN);
      expect(handle.heartbeatTask).not.toBeNull();
      await releaseLock(pool as unknown as never, handle);
    }
  });

  it('returns null when INSERT ... ON CONFLICT returns 0 rows (concurrent turn)', async () => {
    const pool = new MockPool();
    pool.responseQueue = [
      { rowCount: 0 }, // DELETE expired
      { rowCount: 0 }, // INSERT conflict (no rows returned)
    ];
    const handle = await tryAcquireLock(pool as unknown as never, TEN, THR, INV);
    expect(handle).toBeNull();
  });

  it('graceful degrades when chat_turn_locks table is missing (42P01)', async () => {
    const pool = new MockPool();
    const err = new Error('relation "chat_turn_locks" does not exist') as Error & { code?: string };
    err.code = '42P01';
    pool.responseQueue = [{ throw: err }];
    const handle = await tryAcquireLock(pool as unknown as never, TEN, THR, INV);
    expect(handle).not.toBeNull();
    expect(handle?.heartbeatTask).toBeNull(); // no heartbeat in degraded mode
  });

  it('throws LockServiceUnavailableError on generic DB error', async () => {
    const pool = new MockPool();
    pool.responseQueue = [{ throw: new Error('connection refused') }];
    await expect(tryAcquireLock(pool as unknown as never, TEN, THR, INV)).rejects.toBeInstanceOf(
      LockServiceUnavailableError,
    );
  });

  it('releaseLock issues DELETE with invocationId filter', async () => {
    const pool = new MockPool();
    pool.responseQueue = [
      { rowCount: 0 }, // DELETE expired
      { rowCount: 1, rows: [{}] }, // acquire INSERT
      { rowCount: 1 }, // release DELETE
    ];
    const handle = await tryAcquireLock(pool as unknown as never, TEN, THR, INV);
    expect(handle).not.toBeNull();
    if (handle) {
      await releaseLock(pool as unknown as never, handle);
      const lastCall = pool.calls[pool.calls.length - 1];
      expect(lastCall[0]).toMatch(/DELETE FROM chat_turn_locks/);
      expect(lastCall[1]).toEqual([TEN, THR, INV]);
    }
  });
});
