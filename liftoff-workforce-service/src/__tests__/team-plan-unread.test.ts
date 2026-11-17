// Unread state for team-plan threads (migration 024).
//
// The same assertions platform-backend pins for its three chat surfaces: the
// list consults the reader's markers without widening or narrowing visibility,
// the marker write is an idempotent upsert, the count answers for exactly the
// list the caller's Chat History shows, and the reply clock moves only for
// ordinary assistant speech.

const mockQuery = jest.fn();
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: (_tenantId: string, fn: (c: { query: jest.Mock }) => unknown) =>
    fn({ query: mockQuery }),
}));

import {
  appendMessage,
  getUnreadThreadCount,
  listThreads,
  markThreadRead,
} from '../workforce-plans/chat-repository.js';

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_MEMBER = '00000000-0000-0000-0000-000000000020';
const THREAD_ID = '00000000-0000-0000-0000-000000000100';

function makeThreadRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: THREAD_ID,
    tenant_id: TENANT_A,
    account_id: ACCOUNT_MEMBER,
    title: 'Plan a support pod',
    workforce_plan_id: null,
    deleted_at: null,
    created_at: new Date('2026-09-01T00:00:00Z'),
    updated_at: new Date('2026-09-05T00:00:00Z'),
    ...overrides,
  };
}

function makeMessageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000200',
    thread_id: THREAD_ID,
    role: 'user',
    content: 'Plan me a support pod.',
    visualization_blocks: null,
    attachments: null,
    media: null,
    message_type: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: new Date('2026-09-05T12:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe('listThreads carries the unread flag', () => {
  it("joins the reader's markers without narrowing a privileged list", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_A, ACCOUNT_MEMBER, 'owner');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(
      /LEFT JOIN\s+team_plan_thread_reads\s+r\s+ON\s+r\.thread_id\s*=\s*t\.id\s+AND\s+r\.account_id\s*=\s*\$2/,
    );
    expect(sql).toContain('AS unread');
    // Owner and admin see the whole workspace: the reader param feeds the
    // join, never a visibility filter.
    expect(sql).not.toContain('t.account_id = $2');
    expect(params).toEqual([TENANT_A, ACCOUNT_MEMBER, 21]);
  });

  it('keeps the own-threads filter for a member, on the same bind param', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_A, ACCOUNT_MEMBER, 'member');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('t.account_id = $2');
    expect(params).toEqual([TENANT_A, ACCOUNT_MEMBER, 21]);
  });

  it('maps unread onto the thread and coerces absence to false', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeThreadRow({ unread: true }), makeThreadRow({ id: THREAD_ID.replace(/0$/, '1') })],
    });

    const result = await listThreads(TENANT_A, ACCOUNT_MEMBER, 'member');

    expect(result.threads.map((t) => t.unread)).toEqual([true, false]);
  });
});

describe('markThreadRead', () => {
  it('is an idempotent per-(thread, account) upsert', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await markThreadRead(TENANT_A, ACCOUNT_MEMBER, THREAD_ID);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO team_plan_thread_reads/);
    expect(sql).toMatch(/ON CONFLICT \(thread_id, account_id\)/);
    expect(params).toEqual([THREAD_ID, ACCOUNT_MEMBER, TENANT_A]);
  });
});

describe('getUnreadThreadCount', () => {
  it('answers for exactly the list the caller sees: member counts only their own', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ unread: 2 }] });

    const count = await getUnreadThreadCount(TENANT_A, ACCOUNT_MEMBER, 'member');

    expect(count).toBe(2);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('COUNT(*)::int AS unread');
    expect(sql).toContain('t.account_id = $2');
    // The same threads-with-a-user-message filter the list applies, so the
    // dot never points at a thread the history modal cannot render.
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM team_plan_messages/);
    expect(params).toEqual([TENANT_A, ACCOUNT_MEMBER]);
  });

  it('counts the whole workspace for owner and admin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ unread: 5 }] });

    const count = await getUnreadThreadCount(TENANT_A, ACCOUNT_MEMBER, 'owner');

    expect(count).toBe(5);
    expect(mockQuery.mock.calls[0][0]).not.toContain('t.account_id = $2');
  });

  it('reads an empty result as zero', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    expect(await getUnreadThreadCount(TENANT_A, ACCOUNT_MEMBER, 'member')).toBe(0);
  });
});

describe('the reply clock', () => {
  it('stamps for ordinary assistant speech', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ role: 'assistant' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage({
      threadId: THREAD_ID,
      tenantId: TENANT_A,
      role: 'assistant',
      content: 'Here is the pod I propose.',
    });

    expect(mockQuery.mock.calls[1][0]).toContain('last_assistant_message_at = NOW()');
  });

  it("does NOT stamp for the person's own message", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage({
      threadId: THREAD_ID,
      tenantId: TENANT_A,
      role: 'user',
      senderAccountId: '33333333-3333-4333-8333-333333333333',
      content: 'Plan me a support pod.',
    });

    expect(mockQuery.mock.calls[1][0]).not.toContain('last_assistant_message_at');
  });

  it('does NOT stamp for an assistant row nobody said (forwarded context)', async () => {
    // Delegation writes a forwarded-context report as role assistant at the
    // thread's birth. Stamping it would hand a brand-new delegated thread a
    // dot before anyone has answered anything.
    mockQuery
      .mockResolvedValueOnce({
        rows: [makeMessageRow({ role: 'assistant', message_type: 'forwarded_context' })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage({
      threadId: THREAD_ID,
      tenantId: TENANT_A,
      role: 'assistant',
      content: 'Context forwarded from Liftoff.',
      messageType: 'forwarded_context',
    });

    expect(mockQuery.mock.calls[1][0]).not.toContain('last_assistant_message_at');
  });
});
