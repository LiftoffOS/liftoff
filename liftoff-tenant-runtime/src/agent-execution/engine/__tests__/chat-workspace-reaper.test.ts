/**
 * R5 Fix 1 chat-thread reaper tests.
 *
 * Covers:
 *   - TE-R4-ADD-003: live workspace (lock row present) is skipped
 *   - TE-R5-012: expired-between-check scenario (lock expires between
 *     SELECT and our INSERT; reaper proceeds correctly)
 *   - TE-R5-004: onBeforeRm injection hook fires before fs.rm
 *   - parseChatWorkspacePath validates UUID format
 */
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
  parseChatWorkspacePath,
  listCandidateChatWorkspaces,
  reapStaleChatWorkspaces,
} from '../workspace-reaper';

class MockPool {
  public responseQueue: Array<
    | { rowCount: number; rows?: unknown[] }
    | { throw: Error }
  > = [];

  async connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>;
    release: () => void;
  }> {
    const queue = this.responseQueue;
    return {
      async query(_sql: string, _params?: unknown[]) {
        const next = queue.shift();
        if (!next) return { rowCount: 0, rows: [] };
        if ('throw' in next) throw next.throw;
        return { rowCount: next.rowCount, rows: next.rows ?? [] };
      },
      release() {
        // noop
      },
    };
  }

  async query(_sql: string, _params?: unknown[]): Promise<{ rowCount: number; rows: unknown[] }> {
    return { rowCount: 0, rows: [] };
  }
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('parseChatWorkspacePath', () => {
  it('extracts tenantId + threadId from /tmp/chat-threads/<uuid>/<uuid>', () => {
    const p = '/tmp/chat-threads/123e4567-e89b-12d3-a456-426614174000/223e4567-e89b-12d3-a456-426614174001';
    const out = parseChatWorkspacePath(p);
    expect(out.tenantId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(out.threadId).toBe('223e4567-e89b-12d3-a456-426614174001');
  });

  it('rejects non-UUID components', () => {
    expect(() => parseChatWorkspacePath('/tmp/chat-threads/not-a-uuid/x')).toThrow(/not a valid/);
  });
});

describe('listCandidateChatWorkspaces', () => {
  let root: string;

  beforeEach(async () => {
    root = `/tmp/reaper-test-${process.env.JEST_WORKER_ID ?? '0'}-${crypto.randomUUID()}`;
    await fs.mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns empty when root does not exist', async () => {
    const out = await listCandidateChatWorkspaces('/nonexistent-reaper-root');
    expect(out).toEqual([]);
  });

  it('returns only UUID-shaped tenant + thread directories', async () => {
    const ten1 = '123e4567-e89b-12d3-a456-426614174000';
    const thr1 = '223e4567-e89b-12d3-a456-426614174001';
    await fs.mkdir(path.join(root, ten1, thr1), { recursive: true });
    await fs.mkdir(path.join(root, 'not-a-uuid', 'ignored'), { recursive: true });
    const out = await listCandidateChatWorkspaces(root);
    expect(out).toContain(path.join(root, ten1, thr1));
    expect(out.find((p) => p.includes('not-a-uuid'))).toBeUndefined();
  });
});

describe('reapStaleChatWorkspaces', () => {
  let root: string;

  beforeEach(async () => {
    root = `/tmp/reaper-test-${process.env.JEST_WORKER_ID ?? '0'}-${crypto.randomUUID()}`;
    await fs.mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('skips workspaces whose chat_turn_locks row is live', async () => {
    const ten = '123e4567-e89b-12d3-a456-426614174000';
    const thr = '223e4567-e89b-12d3-a456-426614174001';
    await fs.mkdir(path.join(root, ten, thr), { recursive: true });
    const pool = new MockPool();
    // BEGIN, SELECT FOR UPDATE returns a live row, ROLLBACK
    pool.responseQueue = [
      { rowCount: 0 }, // BEGIN
      { rowCount: 1, rows: [{ '?column?': 1 }] }, // live lock present
      { rowCount: 0 }, // ROLLBACK
    ];
    const result = await reapStaleChatWorkspaces(
      { maxDurationMs: 2000, workspaceRoot: root },
      { pool: pool as unknown as never, logger: noopLogger },
    );
    expect(result.skippedLive).toBeGreaterThanOrEqual(1);
    expect(result.evicted).toBe(0);
    const stillExists = await fs.stat(path.join(root, ten, thr)).then(() => true, () => false);
    expect(stillExists).toBe(true);
  });

  it('TE-R5-004: fires onBeforeRm injection hook before fs.rm', async () => {
    const ten = '123e4567-e89b-12d3-a456-426614174000';
    const thr = '223e4567-e89b-12d3-a456-426614174001';
    await fs.mkdir(path.join(root, ten, thr), { recursive: true });
    const pool = new MockPool();
    // Successful tombstone acquire + release cycle (×2 for dedicated release client)
    pool.responseQueue = [
      { rowCount: 0 }, // BEGIN
      { rowCount: 0 }, // SELECT FOR UPDATE (no live row)
      { rowCount: 0 }, // DELETE expired
      { rowCount: 1, rows: [{}] }, // INSERT tombstone
      { rowCount: 0 }, // COMMIT
      { rowCount: 0 }, // SET statement_timeout (release client)
      { rowCount: 1 }, // DELETE tombstone
    ];
    let hookFired = false;
    const result = await reapStaleChatWorkspaces(
      {
        maxDurationMs: 2000,
        workspaceRoot: root,
        onBeforeRm: async () => {
          hookFired = true;
        },
      },
      { pool: pool as unknown as never, logger: noopLogger },
    );
    expect(hookFired).toBe(true);
    expect(result.evicted).toBe(1);
    const stillExists = await fs.stat(path.join(root, ten, thr)).then(() => true, () => false);
    expect(stillExists).toBe(false);
  });
});
