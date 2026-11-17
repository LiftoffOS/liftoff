import { tryAcquireAgentLock, releaseAgentLock } from '../agent-lock';
import type { Pool } from 'pg';

const T = 'tenant-1', A = 'agent-1';

function mockPool(rowCount = 1): jest.Mocked<Pool> {
  return { query: jest.fn().mockResolvedValue({ rowCount, rows: [] }) } as unknown as jest.Mocked<Pool>;
}

describe('tryAcquireAgentLock', () => {
  it('returns handle when INSERT succeeds', async () => {
    const pool = mockPool(1);
    const handle = await tryAcquireAgentLock(pool, T, A);
    expect(handle).not.toBeNull();
    expect(handle?.agentId).toBe(A);
    if (handle) clearTimeout(handle.heartbeatTask!);
  });

  it('returns null on INSERT conflict (rowCount=0)', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })  // DELETE stale
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }), // INSERT conflict
    } as unknown as jest.Mocked<Pool>;
    expect(await tryAcquireAgentLock(pool, T, A)).toBeNull();
  });

  it('gracefully degrades when table is missing (42P01)', async () => {
    const pool = {
      query: jest.fn().mockRejectedValue(Object.assign(new Error('no relation'), { code: '42P01' })),
    } as unknown as jest.Mocked<Pool>;
    const handle = await tryAcquireAgentLock(pool, T, A);
    expect(handle).not.toBeNull();
  });
});

describe('releaseAgentLock', () => {
  it('is idempotent — only one DELETE is issued', async () => {
    const pool = mockPool(1);
    const handle = await tryAcquireAgentLock(pool, T, A);
    if (handle) clearTimeout(handle.heartbeatTask!);
    handle!.heartbeatTask = null;
    // Reset call history so only release-phase queries are counted
    (pool.query as jest.Mock).mockClear();
    await releaseAgentLock(pool, handle!);
    await releaseAgentLock(pool, handle!);
    const deleteCalls = (pool.query as jest.Mock).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('DELETE FROM agent_execution_locks'),
    );
    expect(deleteCalls.length).toBe(1);
  });
});
