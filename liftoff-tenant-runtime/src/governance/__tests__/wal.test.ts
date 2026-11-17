// WAL writer + drainer tests.
//
// pg is mocked via a simple { query: jest.fn() } pool (matching the
// pattern in tool-gateway/__tests__/execute-batch.test.ts). The
// governance-engine client is mocked at the method level.

import type { Pool } from 'pg';
import { writeWalEntry, drainWal } from '../wal';

interface MockPool {
  query: jest.Mock;
}

function makePool(): MockPool {
  return { query: jest.fn() };
}

describe('writeWalEntry', () => {
  it('serializes action_payload JSON and inserts with ON CONFLICT DO NOTHING', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rowCount: 1, rows: [] });

    await writeWalEntry(
      {
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        idempotencyKey: 'idem-1',
        actionPayload: { connector: 'slack', actionType: 'send' },
        result: { ok: true },
        costUsd: 0.005,
        vendorLatencyMs: 123,
      },
      pool as unknown as Pool,
    );

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO governance_wal');
    expect(sql).toContain('ON CONFLICT (tenant_id, idempotency_key) DO NOTHING');
    expect(params[0]).toBe('tenant-1');
    expect(params[1]).toBe('agent-1');
    expect(params[2]).toBe('idem-1');
    // action_payload is JSON text (not an object) — casted to jsonb in SQL.
    expect(typeof params[3]).toBe('string');
    expect(JSON.parse(params[3])).toEqual({ connector: 'slack', actionType: 'send' });
    expect(typeof params[4]).toBe('string');
    expect(JSON.parse(params[4])).toEqual({ ok: true });
    expect(params[5]).toBe(0.005);
    expect(params[6]).toBe(123);
  });

  it('base64-encodes Uint8Array fields and stringifies bigints in action_payload', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rowCount: 1, rows: [] });

    const payload = {
      durationMs: 42n,
      externalResponse: new Uint8Array([1, 2, 3]),
      nested: { big: 99n },
    };

    await writeWalEntry(
      {
        tenantId: 't',
        agentId: null,
        idempotencyKey: 'idem-2',
        actionPayload: payload as unknown as Record<string, unknown>,
      },
      pool as unknown as Pool,
    );

    const [, params] = pool.query.mock.calls[0];
    const parsed = JSON.parse(params[3]);
    expect(parsed.durationMs).toBe('42');
    expect(parsed.externalResponse).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(parsed.nested.big).toBe('99');
    expect(params[4]).toBeNull();
    expect(params[5]).toBeNull();
    expect(params[6]).toBeNull();
  });
});

describe('drainWal', () => {
  function makeClient(recordImpl: (req: unknown) => Promise<unknown>) {
    return {
      preflight: jest.fn(),
      authorize: jest.fn(),
      record: jest.fn(recordImpl),
      listApprovals: jest.fn(),
    } as unknown as Parameters<typeof drainWal>[0];
  }

  it('returns zero counts when no unreplicated rows', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const client = makeClient(async () => ({ accepted: true }));

    const result = await drainWal(client, 50, pool as unknown as Pool);
    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('calls Record for every unreplicated row and marks them replicated', async () => {
    const pool = makePool();
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'row-1',
            tenant_id: 'tenant-a',
            action_payload: {
              preflightToken: 'tok-a',
              idempotencyKey: 'idem-a',
              connector: 'slack',
              entityType: 'message',
              actionType: 'send',
              targetRef: 'C123',
              traceId: 'trc-a',
              durationMs: '100',
              status: 3,
              costUsd: 0.001,
            },
          },
          {
            id: 'row-2',
            tenant_id: 'tenant-b',
            action_payload: {
              preflightToken: 'tok-b',
              idempotencyKey: 'idem-b',
              connector: 'github',
              entityType: 'issue',
              actionType: 'create',
              targetRef: 'owner/repo',
              traceId: 'trc-b',
              durationMs: '200',
              status: 3,
              costUsd: 0,
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 2 });
    const recordImpl = jest.fn(async () => ({ accepted: true }));
    const client = makeClient(recordImpl);

    const result = await drainWal(client, 50, pool as unknown as Pool);

    expect(result).toEqual({ attempted: 2, succeeded: 2, failed: 0 });
    expect(recordImpl).toHaveBeenCalledTimes(2);
    // Second query is the UPDATE marking rows replicated.
    const updateCall = pool.query.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE governance_wal');
    expect(updateCall[0]).toContain('SET replicated = true');
    expect(updateCall[1][0]).toEqual(['row-1', 'row-2']);
  });

  it('reports failed rows without marking them replicated', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'row-ok',
          tenant_id: 'tenant-a',
          action_payload: { idempotencyKey: 'idem-ok', durationMs: '10', status: 3, costUsd: 0 },
        },
        {
          id: 'row-fail',
          tenant_id: 'tenant-b',
          action_payload: { idempotencyKey: 'idem-fail', durationMs: '10', status: 3, costUsd: 0 },
        },
      ],
    });
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const recordImpl = jest.fn(async (req: unknown) => {
      if ((req as { idempotencyKey: string }).idempotencyKey === 'idem-fail') {
        throw new Error('rpc boom');
      }
      return { accepted: true };
    });
    const client = makeClient(recordImpl);

    const result = await drainWal(client, 50, pool as unknown as Pool);
    expect(result).toEqual({ attempted: 2, succeeded: 1, failed: 1 });
    // The UPDATE should only include the succeeded row.
    const updateCall = pool.query.mock.calls[1];
    expect(updateCall[1][0]).toEqual(['row-ok']);
  });

  it('skips the UPDATE entirely if every row failed', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'row-fail-1',
          tenant_id: 'tenant-a',
          action_payload: { idempotencyKey: 'k1', durationMs: '10', status: 3, costUsd: 0 },
        },
      ],
    });
    const recordImpl = jest.fn(async () => {
      throw new Error('rpc boom');
    });
    const client = makeClient(recordImpl);

    const result = await drainWal(client, 50, pool as unknown as Pool);
    expect(result).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    // Only the SELECT happened; no UPDATE.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
