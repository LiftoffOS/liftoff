// Shared chat presence repository tests.
//
// Presence is a heartbeat table: one row per (surface, thread, account),
// rewritten every few seconds, read through a staleness window. The contract
// worth pinning is that a poll does the write and the read in one call, that
// stale rows never surface, that typing decays faster than presence, and that
// the two surfaces stay separated by the discriminator rather than by luck.
//
// The surface is also what picks the message and lock tables, and getting that
// wrong would show one chat's activity on the other, so every statement's table
// is asserted per surface rather than for one of them and assumed for the rest.

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

import {
  heartbeatAndListPresence,
  clearPresence,
  type PresenceSurface,
} from '../chat-presence-repository';
import { LIVE_LOCK_PREDICATE } from '../turn-registry';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const THREAD_ID = '00000000-0000-0000-0000-000000000002';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000003';

const SURFACES: ReadonlyArray<[PresenceSurface, string, string]> = [
  ['liftoff', 'liftoff_chat_messages', 'liftoff_turn_locks'],
  ['insights', 'insights_chat_messages', 'insights_turn_locks'],
];

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

describe('common / chat-presence-repository / heartbeatAndListPresence', () => {
  it.each(SURFACES)(
    'upserts the caller then reads the roster in one call (%s)',
    async (surface) => {
      mockPoll([]);

      await heartbeatAndListPresence(surface, TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

      expect(mockQuery).toHaveBeenCalledTimes(5);
      const [upsertSql, upsertParams] = mockQuery.mock.calls[0];
      expect(upsertSql).toMatch(/INSERT INTO platform_chat_presence/);
      // Re-polling the same thread must refresh the row, never accumulate rows.
      expect(upsertSql).toMatch(/ON CONFLICT \(surface, thread_id, account_id\)/);
      expect(upsertSql).toMatch(/DO UPDATE SET state = EXCLUDED\.state, last_seen_at = NOW\(\)/);
      expect(upsertParams).toEqual([surface, THREAD_ID, ACCOUNT_ID, TENANT_ID, 'viewing']);
    },
  );

  it.each(SURFACES)(
    'sweeps only its own thread on its own surface (%s)',
    async (surface) => {
      mockPoll([]);

      await heartbeatAndListPresence(surface, TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

      const [deleteSql, deleteParams] = mockQuery.mock.calls[1];
      expect(deleteSql).toMatch(/DELETE FROM platform_chat_presence/);
      expect(deleteSql).toMatch(/surface = \$1 AND thread_id = \$2/);
      expect(deleteParams).toEqual([surface, THREAD_ID]);
    },
  );

  // The table is shared, so the discriminator is the only thing keeping a
  // Liftoff thread's roster out of an Insights thread's poll.
  it.each(SURFACES)('filters the roster by surface as well as thread (%s)', async (surface) => {
    mockPoll([]);

    await heartbeatAndListPresence(surface, TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

    const [rosterSql, rosterParams] = mockQuery.mock.calls[2];
    expect(rosterSql).toMatch(/FROM platform_chat_presence p/);
    expect(rosterSql).toMatch(/p\.surface = \$1/);
    expect(rosterParams).toEqual([surface, THREAD_ID]);
  });

  it('filters the roster by the staleness window rather than a leave signal', async () => {
    mockPoll([]);

    await heartbeatAndListPresence('liftoff', TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing');

    const [rosterSql] = mockQuery.mock.calls[2];
    expect(rosterSql).toMatch(/JOIN accounts a ON a\.id = p\.account_id/);
    expect(rosterSql).toMatch(/last_seen_at > NOW\(\) - INTERVAL '45 seconds'/);
  });

  it('decays typing faster than presence, so a dead client stops typing first', async () => {
    mockPoll([]);

    await heartbeatAndListPresence('liftoff', TENANT_ID, THREAD_ID, ACCOUNT_ID, 'typing');

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

    const result = await heartbeatAndListPresence(
      'liftoff', TENANT_ID, THREAD_ID, ACCOUNT_ID, 'typing',
    );

    expect(result.viewers).toEqual([
      {
        accountId: ACCOUNT_ID, firstName: 'Ada', lastName: 'Lovelace',
        email: 'ada@example.com', avatarUrl: null, typing: true,
      },
    ]);
  });

  // Each surface has its own message table, and reading the wrong one would
  // report the wrong chat's activity as this thread's.
  it.each(SURFACES)(
    'reads the newest message from the %s messages table',
    async (surface, messagesTable) => {
      mockPoll([], new Date('2026-08-11T10:00:00.000Z'));

      const result = await heartbeatAndListPresence(
        surface, TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing',
      );

      const [latestSql, latestParams] = mockQuery.mock.calls[3];
      expect(latestSql).toMatch(new RegExp(`FROM ${messagesTable}`));
      // Neither messages table carries tenant_id: tenancy is inherited from the
      // thread the router already resolved.
      expect(latestParams).toEqual([THREAD_ID]);
      expect(result.latestMessageAt).toBe('2026-08-11T10:00:00.000Z');
    },
  );

  it('returns null latestMessageAt on a thread with no messages', async () => {
    mockPoll([], null);

    const result = await heartbeatAndListPresence(
      'insights', TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing',
    );

    expect(result.latestMessageAt).toBeNull();
  });

  // Neither surface records per-turn execution events, so the live turn comes
  // from the lock, which exists for exactly as long as the turn does.
  it.each(SURFACES)(
    'reports the live turn from the %s lock table',
    async (surface, _messagesTable, locksTable) => {
      mockPoll([], null, '00000000-0000-0000-0000-0000000000ff');

      const result = await heartbeatAndListPresence(
        surface, TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing',
      );

      expect(result.liveTurnId).toBe('00000000-0000-0000-0000-0000000000ff');
      const [liveSql, liveParams] = mockQuery.mock.calls[4];
      expect(liveSql).toMatch(new RegExp(`FROM ${locksTable}`));
      // Directly above this file's own query there used to be a comment saying
      // "an expired lock does not count — a container that died mid-turn must
      // not leave the thread looking busy for the rest of the expiry window",
      // and the query under it read `expires_at > NOW()`, which does exactly
      // that. The predicate is the registry's now, and it is what this asserts.
      expect(liveSql).toContain(LIVE_LOCK_PREDICATE);
      expect(liveParams).toEqual([TENANT_ID, THREAD_ID]);
    },
  );

  it('reports no live turn when nothing is streaming', async () => {
    mockPoll([], null, null);

    const result = await heartbeatAndListPresence(
      'liftoff', TENANT_ID, THREAD_ID, ACCOUNT_ID, 'viewing',
    );

    expect(result.liveTurnId).toBeNull();
  });
});

describe('common / chat-presence-repository / clearPresence', () => {
  it.each(SURFACES)('deletes only this account on this thread on %s', async (surface) => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await clearPresence(surface, TENANT_ID, THREAD_ID, ACCOUNT_ID);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM platform_chat_presence/);
    expect(params).toEqual([surface, THREAD_ID, ACCOUNT_ID]);
  });
});
