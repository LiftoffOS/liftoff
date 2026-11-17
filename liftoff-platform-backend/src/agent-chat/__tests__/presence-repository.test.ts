// Agent-chat presence repository tests.
//
// Presence is a heartbeat table: one row per (thread, account), rewritten
// every few seconds, read through a staleness window. The contract worth
// pinning is that a poll does the write and the read in one call, that stale
// rows never surface, and that typing decays faster than presence.

const mockQuery = jest.fn();
(global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery = mockQuery;

jest.mock('../../infrastructure/database', () => {
  const q = (...args: unknown[]) =>
    (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args);
  const mkClient = () => ({ query: q, release: jest.fn() });
  return {
    getPool: () => ({ query: q }),
    withTenantScope: (_t: string, fn: (c: unknown) => unknown) => fn(mkClient()),
  };
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { heartbeatAndListPresence, clearPresence } from '../presence-repository';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const THREAD_ID = '00000000-0000-0000-0000-000000000002';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000003';

// heartbeatAndListPresence issues five statements in order: upsert, cleanup,
// roster, latest-message, live-turn.
function mockPoll(
  viewerRows: Array<Record<string, unknown>>,
  latest: Date | null = null,
  liveTurnId: string | null = null,
) {
  mockQuery
    .mockResolvedValueOnce({ rowCount: 1, rows: [] })
    .mockResolvedValueOnce({ rowCount: 0, rows: [] })
    .mockResolvedValueOnce({ rows: viewerRows })
    .mockResolvedValueOnce({ rows: [{ latest_message_at: latest }] })
    .mockResolvedValueOnce({ rows: liveTurnId ? [{ turn_id: liveTurnId }] : [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe('agent-chat / presence-repository / heartbeatAndListPresence', () => {
  it('upserts the caller then reads the roster in one call', async () => {
    mockPoll([]);

    await heartbeatAndListPresence(TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

    expect(mockQuery).toHaveBeenCalledTimes(5);
    const [upsertSql, upsertParams] = mockQuery.mock.calls[0];
    expect(upsertSql).toMatch(/INSERT INTO agent_chat_presence/);
    // Re-polling the same thread must refresh the row, never accumulate rows.
    expect(upsertSql).toMatch(/ON CONFLICT \(thread_id, account_id\)/);
    expect(upsertSql).toMatch(/DO UPDATE SET state = EXCLUDED\.state, last_seen_at = NOW\(\)/);
    expect(upsertParams).toEqual([THREAD_ID, ACCOUNT_ID, TENANT_ID, 'viewing']);
  });

  it('sweeps only its own thread, so the delete stays a handful of rows', async () => {
    mockPoll([]);

    await heartbeatAndListPresence(TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

    const [deleteSql, deleteParams] = mockQuery.mock.calls[1];
    expect(deleteSql).toMatch(/DELETE FROM agent_chat_presence/);
    expect(deleteSql).toMatch(/thread_id = \$1/);
    expect(deleteParams).toEqual([THREAD_ID]);
  });

  it('filters the roster by the staleness window rather than a leave signal', async () => {
    mockPoll([]);

    await heartbeatAndListPresence(TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

    const [rosterSql] = mockQuery.mock.calls[2];
    expect(rosterSql).toMatch(/JOIN accounts a ON a\.id = p\.account_id/);
    expect(rosterSql).toMatch(/last_seen_at > NOW\(\) - INTERVAL '45 seconds'/);
  });

  it('decays typing faster than presence, so a dead client stops typing first', async () => {
    mockPoll([]);

    await heartbeatAndListPresence(TENANT_ID, THREAD_ID, ACCOUNT_ID, 'typing');

    const [rosterSql] = mockQuery.mock.calls[2];
    expect(rosterSql).toMatch(/state = 'typing'/);
    expect(rosterSql).toMatch(/INTERVAL '8 seconds'/);
  });

  it('maps joined account columns onto each viewer', async () => {
    mockPoll([
      {
        account_id: ACCOUNT_ID, first_name: 'Ada', last_name: 'Lovelace',
        email: 'ada@example.com', avatar_url: null, typing: true,
      },
    ]);

    const result = await heartbeatAndListPresence(TENANT_ID, THREAD_ID, ACCOUNT_ID, 'typing');

    expect(result.viewers).toEqual([
      {
        accountId: ACCOUNT_ID, firstName: 'Ada', lastName: 'Lovelace',
        email: 'ada@example.com', avatarUrl: null, typing: true,
      },
    ]);
  });

  it('returns the newest message timestamp so a second viewer notices new messages', async () => {
    mockPoll([], new Date('2026-07-27T10:00:00.000Z'));

    const result = await heartbeatAndListPresence(TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

    expect(result.latestMessageAt).toBe('2026-07-27T10:00:00.000Z');
  });

  // A viewer who is not the sender has no SSE stream, so the poll they already
  // run is how they learn a turn is worth following.
  it('reports the live turn so a non-sender can follow it', async () => {
    mockPoll([], null, '00000000-0000-0000-0000-0000000000ff');

    const result = await heartbeatAndListPresence(TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

    expect(result.liveTurnId).toBe('00000000-0000-0000-0000-0000000000ff');
    const [liveSql] = mockQuery.mock.calls[4];
    // A turn that emitted 'done' is finished, however recently it did so.
    expect(liveSql).toMatch(/kind = 'done'/);
  });

  it('reports no live turn when nothing is streaming', async () => {
    mockPoll([], null, null);

    const result = await heartbeatAndListPresence(TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

    expect(result.liveTurnId).toBeNull();
  });

  it('returns null latestMessageAt on a thread with no messages', async () => {
    mockPoll([], null);

    const result = await heartbeatAndListPresence(TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

    expect(result.latestMessageAt).toBeNull();
  });
});

describe('agent-chat / presence-repository / clearPresence', () => {
  it('deletes only this account on this thread', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await clearPresence(TENANT_ID, THREAD_ID, ACCOUNT_ID);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM agent_chat_presence/);
    expect(params).toEqual([THREAD_ID, ACCOUNT_ID]);
  });
});
