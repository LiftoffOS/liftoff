// Cross-surface Chat History merge. The four surface listings are mocked, so
// these assert the merge: order, the cut at `limit`, the cursor, the team
// lookup, and what a missing Chief AI Officer does to the page.

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockQuery = jest.fn();
jest.mock('../infrastructure/database', () => ({
  withTenantScope: (_tenantId: string, fn: (client: { query: typeof mockQuery }) => unknown) =>
    fn({ query: mockQuery }),
}));

const mockAgentList = jest.fn();
jest.mock('../agent-chat/chat-repository', () => ({
  listThreads: (...args: unknown[]) => mockAgentList(...args),
}));
const mockLiftoffList = jest.fn();
jest.mock('../liftoff/chat-repository', () => ({
  listThreads: (...args: unknown[]) => mockLiftoffList(...args),
}));
const mockInsightsList = jest.fn();
jest.mock('../insights/chat-repository', () => ({
  listThreads: (...args: unknown[]) => mockInsightsList(...args),
}));
const mockTeamPlanPage = jest.fn();
jest.mock('../workforce-plans/team-plan-thread-client', () => ({
  listTeamPlanThreadPage: (...args: unknown[]) => mockTeamPlanPage(...args),
}));

import { listAllChatThreads } from './service';

const caller = { tenantId: 'tenant-1', accountId: 'account-1', role: 'member' };

function page(threads: Array<{ id: string; updatedAt: string; unread?: boolean }>, hasMore = false) {
  return {
    threads: threads.map((t) => ({ title: `Chat ${t.id}`, unread: false, ...t })),
    nextCursor: hasMore ? threads[threads.length - 1].updatedAt : null,
    hasMore,
  };
}

const empty = page([]);

beforeEach(() => {
  jest.clearAllMocks();
  mockAgentList.mockResolvedValue(empty);
  mockLiftoffList.mockResolvedValue(empty);
  mockInsightsList.mockResolvedValue(empty);
  mockTeamPlanPage.mockResolvedValue(empty);
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('listAllChatThreads', () => {
  it('merges every surface newest first, tagged with its kind', async () => {
    mockLiftoffList.mockResolvedValue(page([{ id: 'l1', updatedAt: '2026-09-20T10:00:00.000Z' }]));
    mockInsightsList.mockResolvedValue(page([{ id: 'i1', updatedAt: '2026-09-22T10:00:00.000Z', unread: true }]));
    mockTeamPlanPage.mockResolvedValue(page([{ id: 'c1', updatedAt: '2026-09-21T10:00:00.000Z' }]));
    mockAgentList.mockResolvedValue(page([{ id: 'a1', updatedAt: '2026-09-23T10:00:00.000Z' }]));
    mockQuery.mockResolvedValue({ rows: [{ thread_id: 'a1', id: 'agent-9', role: 'Code Reviewer', deleted_at: null }] });

    const result = await listAllChatThreads(caller);

    expect(result.threads.map((t) => [t.id, t.kind])).toEqual([
      ['a1', 'agent'],
      ['i1', 'insights'],
      ['c1', 'team_plan'],
      ['l1', 'liftoff'],
    ]);
    expect(result.threads[0].agent).toEqual({ id: 'agent-9', name: 'Code Reviewer' });
    expect(result.threads[1]).toMatchObject({ unread: true, agent: null });
    expect(result).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('asks every source for the page after the same cursor', async () => {
    await listAllChatThreads(caller, { cursor: '2026-09-20T00:00:00.000Z', limit: 5 });

    const expected = { cursor: '2026-09-20T00:00:00.000Z', limit: 5 };
    expect(mockAgentList).toHaveBeenCalledWith('tenant-1', 'account-1', expected);
    expect(mockLiftoffList).toHaveBeenCalledWith('tenant-1', 'account-1', expected);
    expect(mockInsightsList).toHaveBeenCalledWith('tenant-1', 'account-1', expected);
    expect(mockTeamPlanPage).toHaveBeenCalledWith(caller, expected);
  });

  it('cuts the union at the limit and continues from the last row kept', async () => {
    mockLiftoffList.mockResolvedValue(page([
      { id: 'l1', updatedAt: '2026-09-23T10:00:00.000Z' },
      { id: 'l2', updatedAt: '2026-09-21T10:00:00.000Z' },
    ]));
    mockInsightsList.mockResolvedValue(page([
      { id: 'i1', updatedAt: '2026-09-22T10:00:00.000Z' },
      { id: 'i2', updatedAt: '2026-09-20T10:00:00.000Z' },
    ]));

    const result = await listAllChatThreads(caller, { limit: 2 });

    expect(result.threads.map((t) => t.id)).toEqual(['l1', 'i1']);
    expect(result).toMatchObject({ hasMore: true, nextCursor: '2026-09-22T10:00:00.000Z' });
  });

  it('has more when any one source has more, even under the limit', async () => {
    mockLiftoffList.mockResolvedValue(page([{ id: 'l1', updatedAt: '2026-09-23T10:00:00.000Z' }], true));

    const result = await listAllChatThreads(caller, { limit: 20 });

    expect(result).toMatchObject({ hasMore: true, nextCursor: '2026-09-23T10:00:00.000Z' });
  });

  it('leaves out a team thread whose team was deleted, and still moves the cursor past it', async () => {
    mockAgentList.mockResolvedValue(page([
      { id: 'a1', updatedAt: '2026-09-23T10:00:00.000Z' },
      { id: 'a2', updatedAt: '2026-09-22T10:00:00.000Z' },
    ], true));
    mockQuery.mockResolvedValue({ rows: [
      { thread_id: 'a1', id: 'agent-live', role: 'Live Team', deleted_at: null },
      { thread_id: 'a2', id: 'agent-gone', role: 'Gone Team', deleted_at: new Date() },
    ] });

    const result = await listAllChatThreads(caller);

    expect(result.threads.map((t) => t.id)).toEqual(['a1']);
    expect(result.nextCursor).toBe('2026-09-22T10:00:00.000Z');
  });

  it('lists the other surfaces when the Chief AI Officer cannot be reached', async () => {
    mockLiftoffList.mockResolvedValue(page([{ id: 'l1', updatedAt: '2026-09-23T10:00:00.000Z' }]));
    mockTeamPlanPage.mockRejectedValue(new Error('workforce-service refused the thread list (503)'));

    const result = await listAllChatThreads(caller);

    expect(result.threads.map((t) => t.id)).toEqual(['l1']);
  });

  it('skips the team lookup when the page holds no team threads', async () => {
    mockLiftoffList.mockResolvedValue(page([{ id: 'l1', updatedAt: '2026-09-23T10:00:00.000Z' }]));

    await listAllChatThreads(caller);

    expect(mockQuery).not.toHaveBeenCalled();
  });
});
