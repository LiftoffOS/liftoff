// Insights Chat Repository Tests
//
// Pins down the permission matrix exhaustively (owner/admin/member/viewer ×
// list/get/delete) plus pagination cursor behavior.
//
// Since migration 351 the matrix is deliberately lopsided: READS are
// workspace-wide, so every role sees every thread, and the tests that used to
// assert a member could not reach a colleague's thread now assert the opposite.
// WRITES did not move, so the delete and rename cells still refuse. Both halves
// are worth pinning: the first is the feature, and the second is what stops the
// first from quietly taking the rest of the matrix with it.

const mockQuery = jest.fn();
(global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery = mockQuery;

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({
    query: (...args: unknown[]) =>
      (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args),
  }),
  // getCallerRole runs under withAdminScope and thread ops under
  // withTenantScope (RLS-force wrapping) so the tenant_members / thread
  // queries work once RLS enforces. Both mocks delegate to the same mockQuery
  // the rest of the suite uses, so existing mockResolvedValueOnce chains still
  // work.
  withTenantScope: async (
    _tenantId: string,
    fn: (client: { query: typeof mockQuery }) => Promise<unknown>,
  ) =>
    fn({
      query: (...args: unknown[]) =>
        (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args),
    }),
  withAdminScope: async (
    _ctx: unknown,
    fn: (client: { query: typeof mockQuery }) => Promise<unknown>,
  ) =>
    fn({
      query: (...args: unknown[]) =>
        (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args),
    }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import {
  appendMessage,
  createThread,
  deleteThread,
  getCallerRole,
  getThread,
  getThreadRollingSummary,
  getUnreadThreadCount,
  listMessages,
  listThreads,
  markThreadRead,
  updateThreadRollingSummary,
  updateThreadTitle,
  updateThreadTitleInternal,
  type TenantMemberRole,
} from '../chat-repository';
import type { ConversationSummary } from '../types';

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-000000000002';
const ACCOUNT_OWNER = '00000000-0000-0000-0000-000000000010';
const ACCOUNT_MEMBER = '00000000-0000-0000-0000-000000000020';
const ACCOUNT_OTHER_MEMBER = '00000000-0000-0000-0000-000000000030';
const THREAD_OWNED_BY_MEMBER = '00000000-0000-0000-0000-000000000100';
const THREAD_OWNED_BY_OTHER = '00000000-0000-0000-0000-000000000101';

function makeThreadRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: THREAD_OWNED_BY_MEMBER,
    tenant_id: TENANT_A,
    account_id: ACCOUNT_MEMBER,
    title: 'Q4 spend by agent',
    deleted_at: null,
    created_at: new Date('2026-04-01T00:00:00Z'),
    updated_at: new Date('2026-04-05T00:00:00Z'),
    ...overrides,
  };
}

function makeMessageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000200',
    thread_id: THREAD_OWNED_BY_MEMBER,
    role: 'user',
    content: 'How much did agents cost last week?',
    visualization_blocks: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: new Date('2026-04-05T12:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe('chat-repository / createThread', () => {
  it('inserts a thread with the given title', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeThreadRow()] });

    const thread = await createThread({
      tenantId: TENANT_A,
      accountId: ACCOUNT_MEMBER,
      title: 'Q4 spend by agent',
    });

    expect(thread.tenantId).toBe(TENANT_A);
    expect(thread.accountId).toBe(ACCOUNT_MEMBER);
    expect(thread.title).toBe('Q4 spend by agent');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO insights_chat_threads'),
      [TENANT_A, ACCOUNT_MEMBER, 'Q4 spend by agent'],
    );
  });

  it('persists null title when not provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeThreadRow({ title: null })] });

    const thread = await createThread({ tenantId: TENANT_A, accountId: ACCOUNT_MEMBER });

    expect(thread.title).toBeNull();
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [
      TENANT_A,
      ACCOUNT_MEMBER,
      null,
    ]);
  });
});

describe('chat-repository / listThreads — workspace-wide', () => {
  // Every role gets the same query: no visibility narrowing by account, ever.
  // The reader's account became a bind param in migration 434, but only for
  // the read-marker join; the proof visibility did not narrow is that no
  // t.account_id filter appears in the WHERE.
  for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
    it(`lists without an account filter for ${role}`, async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeThreadRow()] });

      await listThreads(TENANT_A, ACCOUNT_MEMBER);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('FROM insights_chat_threads');
      expect(sql).toContain('WHERE t.tenant_id = $1');
      expect(sql).not.toContain('t.account_id = $');
      expect(params).toEqual([TENANT_A, ACCOUNT_MEMBER, 21]);
    });
  }

  // The history list is the surface the widening is most visible on: a member
  // opening it now finds conversations they never started.
  it("includes other people's threads", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeThreadRow({ account_id: ACCOUNT_MEMBER }),
        makeThreadRow({ id: THREAD_OWNED_BY_OTHER, account_id: ACCOUNT_OTHER_MEMBER }),
      ],
    });

    const result = await listThreads(TENANT_A, ACCOUNT_MEMBER);

    expect(result.threads.map((t) => t.accountId)).toEqual([
      ACCOUNT_MEMBER,
      ACCOUNT_OTHER_MEMBER,
    ]);
  });

  it('always filters out deleted threads', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_A, ACCOUNT_MEMBER);

    expect(mockQuery.mock.calls[0][0]).toContain('deleted_at IS NULL');
  });

  it('orders by updated_at DESC for newest activity first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_A, ACCOUNT_MEMBER);

    expect(mockQuery.mock.calls[0][0]).toContain('ORDER BY t.updated_at DESC');
  });

  it('returns nextCursor when more rows exist than the limit', async () => {
    // Limit defaults to 20; return 21 rows so the repo signals hasMore=true.
    const rows = Array.from({ length: 21 }, (_, i) =>
      makeThreadRow({
        id: `thread-${i}`,
        updated_at: new Date(`2026-04-${String(5 - (i % 5)).padStart(2, '0')}T00:00:00Z`),
      }),
    );
    mockQuery.mockResolvedValueOnce({ rows });

    const result = await listThreads(TENANT_A, ACCOUNT_MEMBER);

    expect(result.threads).toHaveLength(20);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(result.threads[19].updatedAt);
  });

  it('returns null nextCursor when no more rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeThreadRow()] });

    const result = await listThreads(TENANT_A, ACCOUNT_MEMBER);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('passes cursor as a second bind param when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_A, ACCOUNT_MEMBER, { cursor: '2026-04-05T00:00:00.000Z' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('t.updated_at < $3');
    expect(params[2]).toBeInstanceOf(Date);
    expect((params[2] as Date).toISOString()).toBe('2026-04-05T00:00:00.000Z');
  });

  it('clamps limit above the cap', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_A, ACCOUNT_MEMBER, { limit: 9999 });

    // MAX_THREAD_LIMIT is 100, plus the +1 for hasMore detection.
    const params = mockQuery.mock.calls[0][1];
    expect(params[params.length - 1]).toBe(101);
  });
});

describe('chat-repository / getThread — workspace-wide', () => {
  function eachRoleCanReadOwn(role: TenantMemberRole) {
    it(`${role} can read their own thread`, async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeThreadRow({ account_id: ACCOUNT_MEMBER })],
      });

      const thread = await getThread(THREAD_OWNED_BY_MEMBER, TENANT_A);

      expect(thread).not.toBeNull();
      expect(thread!.id).toBe(THREAD_OWNED_BY_MEMBER);
    });
  }
  eachRoleCanReadOwn('owner');
  eachRoleCanReadOwn('admin');
  eachRoleCanReadOwn('member');
  eachRoleCanReadOwn('viewer');

  // The change migration 351 made. Before it, these two roles got null here,
  // which is why a shared link to an Insights conversation 404'd for the
  // colleague it was sent to.
  for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
    it(`${role} can read another account's thread in the same tenant`, async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeThreadRow({
            id: THREAD_OWNED_BY_OTHER,
            account_id: ACCOUNT_OTHER_MEMBER,
          }),
        ],
      });

      const thread = await getThread(THREAD_OWNED_BY_OTHER, TENANT_A);

      expect(thread).not.toBeNull();
      expect(thread!.accountId).toBe(ACCOUNT_OTHER_MEMBER);
    });
  }

  // Widening stopped at the workspace edge. This is the one boundary that was
  // never negotiable, so it is asserted separately from the role cells.
  it('returns null for cross-tenant lookups', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeThreadRow({ tenant_id: TENANT_B })],
    });

    const thread = await getThread(THREAD_OWNED_BY_MEMBER, TENANT_A);

    expect(thread).toBeNull();
  });

  it('returns null for non-existent threads', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const thread = await getThread(THREAD_OWNED_BY_MEMBER, TENANT_A);

    expect(thread).toBeNull();
  });
});

// The deliberate exception to migration 351. Everyone can now READ everyone
// else's thread; destroying one is still the author's or a privileged role's.
// The check used to fall out of getThread returning null and is now written
// explicitly, which is exactly the kind of move that silently loses a rule, so
// every cell is re-asserted here.
describe('chat-repository / deleteThread — still restricted', () => {
  it('owner can delete any thread in tenant', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [makeThreadRow({ account_id: ACCOUNT_OTHER_MEMBER })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const ok = await deleteThread(
      THREAD_OWNED_BY_OTHER,
      TENANT_A,
      ACCOUNT_OWNER,
      'owner',
    );

    expect(ok).toBe(true);
    expect(mockQuery.mock.calls[1][0]).toContain('deleted_at = NOW()');
  });

  it('member can delete their own thread', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [makeThreadRow({ account_id: ACCOUNT_MEMBER })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const ok = await deleteThread(
      THREAD_OWNED_BY_MEMBER,
      TENANT_A,
      ACCOUNT_MEMBER,
      'member',
    );

    expect(ok).toBe(true);
  });

  // Reading the row succeeds now, so the refusal has to come from the
  // ownership check rather than from an empty SELECT. The call count is what
  // proves it: the row was fetched and then declined.
  for (const role of ['member', 'viewer'] as const) {
    it(`${role} CANNOT delete another account's thread (returns false, no UPDATE issued)`, async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeThreadRow({ account_id: ACCOUNT_OTHER_MEMBER })],
      });

      const ok = await deleteThread(
        THREAD_OWNED_BY_OTHER,
        TENANT_A,
        ACCOUNT_MEMBER,
        role,
      );

      expect(ok).toBe(false);
      // Only the ownership-check SELECT happened, never the UPDATE.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  }

  it('a member CAN read the very thread they are refused permission to delete', async () => {
    // The two halves of the split rule, in one place: same thread, same caller,
    // read allowed and delete denied.
    mockQuery
      .mockResolvedValueOnce({
        rows: [makeThreadRow({ id: THREAD_OWNED_BY_OTHER, account_id: ACCOUNT_OTHER_MEMBER })],
      })
      .mockResolvedValueOnce({
        rows: [makeThreadRow({ id: THREAD_OWNED_BY_OTHER, account_id: ACCOUNT_OTHER_MEMBER })],
      });

    const readable = await getThread(THREAD_OWNED_BY_OTHER, TENANT_A);
    const deleted = await deleteThread(
      THREAD_OWNED_BY_OTHER,
      TENANT_A,
      ACCOUNT_MEMBER,
      'member',
    );

    expect(readable).not.toBeNull();
    expect(deleted).toBe(false);
  });

  it('returns false for non-existent threads with no UPDATE', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const ok = await deleteThread(
      THREAD_OWNED_BY_MEMBER,
      TENANT_A,
      ACCOUNT_OWNER,
      'owner',
    );

    expect(ok).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

// Renaming carries the same rule as deleting, and for the same reason: it
// rewrites how the author finds their own conversation again.
describe('chat-repository / updateThreadTitle — still restricted', () => {
  it("updates an owned thread's title", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [makeThreadRow({ account_id: ACCOUNT_MEMBER })],
      })
      .mockResolvedValueOnce({
        rows: [makeThreadRow({ account_id: ACCOUNT_MEMBER, title: 'New title' })],
      });

    const updated = await updateThreadTitle(
      THREAD_OWNED_BY_MEMBER,
      TENANT_A,
      ACCOUNT_MEMBER,
      'member',
      'New title',
    );

    expect(updated?.title).toBe('New title');
  });

  it("returns null when renaming somebody else's thread", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeThreadRow({ account_id: ACCOUNT_OTHER_MEMBER })],
    });

    const updated = await updateThreadTitle(
      THREAD_OWNED_BY_OTHER,
      TENANT_A,
      ACCOUNT_MEMBER,
      'viewer',
      'Sneaky',
    );

    expect(updated).toBeNull();
    // The ownership-check SELECT and nothing else.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('lets an admin rename a thread they did not start', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [makeThreadRow({ account_id: ACCOUNT_OTHER_MEMBER })],
      })
      .mockResolvedValueOnce({
        rows: [makeThreadRow({ account_id: ACCOUNT_OTHER_MEMBER, title: 'Tidied up' })],
      });

    const updated = await updateThreadTitle(
      THREAD_OWNED_BY_OTHER,
      TENANT_A,
      ACCOUNT_OWNER,
      'admin',
      'Tidied up',
    );

    expect(updated?.title).toBe('Tidied up');
  });
});

describe('chat-repository / updateThreadTitleInternal', () => {
  it("issues an UPDATE with title='ai' source and tenant_id in WHERE", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await updateThreadTitleInternal(THREAD_OWNED_BY_MEMBER, TENANT_A, 'AI Title');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    // Tenant isolation enforced at the SQL level (no permission gate).
    expect(sql).toMatch(/UPDATE\s+insights_chat_threads/);
    expect(sql).toContain('tenant_id');
    expect(sql).toMatch(/title_source\s*=\s*'ai'/);
    // User-rename guard.
    expect(sql).toMatch(/title_source\s+IS\s+DISTINCT\s+FROM\s+'user'/);
    // Soft-delete guard.
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/);
    // Bound parameters in the order (title, threadId, tenantId).
    expect(params).toEqual(['AI Title', THREAD_OWNED_BY_MEMBER, TENANT_A]);
  });

  it('is a no-op when the WHERE clause matches nothing (deleted thread / wrong tenant / user-renamed)', async () => {
    // Postgres pool.query returns rowCount: 0 for a no-op UPDATE.
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      updateThreadTitleInternal(THREAD_OWNED_BY_MEMBER, TENANT_A, 'whatever'),
    ).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('does not throw if the DB rejects (caller is fire-and-forget)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    // updateThreadTitleInternal does NOT swallow errors; the maybeGenerateThreadTitle
    // wrapper does. Verify the error propagates so callers can still log it.
    await expect(
      updateThreadTitleInternal(THREAD_OWNED_BY_MEMBER, TENANT_A, 'whatever'),
    ).rejects.toThrow('connection refused');
  });
});

describe('chat-repository / appendMessage', () => {
  it('inserts the message and bubbles the parent thread', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'user',
      senderAccountId: '00000000-0000-0000-0000-000000000042',
      content: 'How much did agents cost last week?',
    });

    expect(message.role).toBe('user');
    expect(message.content).toBe('How much did agents cost last week?');

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO insights_chat_messages');
    expect(insertCall[1]).toEqual([
      THREAD_OWNED_BY_MEMBER,
      'user',
      'How much did agents cost last week?',
      null, // visualization_blocks
      0, // input_tokens
      0, // output_tokens
      // message_type (migration 387): null for ordinary speech, set only on a
      // row that reports on the conversation rather than taking part in it.
      null,
      // media (migration 391): sparse, so a message carrying none stores NULL
      // rather than an empty array.
      null,
      // attachments (migration 392): what the person attached, metadata only,
      // and sparse for the same reason.
      null,
      // sender_account_id (migration 492): the person who wrote it.
      '00000000-0000-0000-0000-000000000042',
      // contributors (migration 493): NOT sparse, the column is NOT NULL
      // DEFAULT '[]', so nobody is written as the empty list it reads back as.
      '[]',
      // files (migration 546): a card SHOWN into the message, sparse for the
      // same reason as media beside it.
      null,
      // turn_id (migration 547): the turn this row was written inside. NULL
      // here because this caller opened none; the chat service always does.
      null,
    ]);

    const touchCall = mockQuery.mock.calls[1];
    expect(touchCall[0]).toContain('UPDATE insights_chat_threads');
    expect(touchCall[0]).toContain('updated_at = NOW()');
  });

  // The same shape every other surface's message carries, so one renderer
  // draws the chips. Nothing on this surface writes it today; the column is
  // there so the day the Insights Manager brings a colleague in, nothing else
  // has to change.
  it('writes contributors when given, and reads the list back on the message', async () => {
    const contributors = [{ id: 'caio', label: 'Chief AI Officer' }];
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ role: 'assistant', contributors })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Here is what the Chief AI Officer suggests.',
      contributors,
    });

    expect(mockQuery.mock.calls[0][0]).toMatch(/sender_account_id, contributors, files,\n\s+turn_id\)/);
    expect(mockQuery.mock.calls[0][1][10]).toBe(JSON.stringify(contributors));
    expect(message.contributors).toEqual(contributors);
  });

  it('reads a row with no contributors column value back as nobody', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ role: 'assistant', contributors: null })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Costs are up 4%.',
    });

    expect(message.contributors).toEqual([]);
  });

  it('serializes visualization blocks as JSON', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          makeMessageRow({
            role: 'assistant',
            visualization_blocks: [{ type: 'metric_card', label: 'Total', value: 42 }],
          }),
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Here is your total.',
      visualizationBlocks: [{ type: 'metric_card', label: 'Total', value: 42 }],
      inputTokens: 100,
      outputTokens: 25,
    });

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[1][3]).toBe(
      JSON.stringify([{ type: 'metric_card', label: 'Total', value: 42 }]),
    );
    expect(insertCall[1][4]).toBe(100);
    expect(insertCall[1][5]).toBe(25);
    expect(message.visualizationBlocks).toEqual([
      { type: 'metric_card', label: 'Total', value: 42 },
    ]);
  });
});

describe('chat-repository / listMessages', () => {
  it('orders by created_at DESC for reverse scrollback', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeMessageRow()] });

    await listMessages(THREAD_OWNED_BY_MEMBER);

    expect(mockQuery.mock.calls[0][0]).toContain('ORDER BY m.created_at DESC');
  });

  it('resolves the sender of a person\'s message through accounts (migration 492), and none for an assistant row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { ...makeMessageRow(), role: 'user', sender_account_id: 'acc-9', sender_first_name: 'Jane', sender_last_name: 'Doe' },
      { ...makeMessageRow(), role: 'assistant', sender_account_id: null },
    ] });
    const page = await listMessages(THREAD_OWNED_BY_MEMBER);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("LEFT JOIN accounts s ON m.role = 'user' AND s.id = m.sender_account_id");
    expect(page.messages[0].sender).toEqual({ accountId: 'acc-9', firstName: 'Jane', lastName: 'Doe' });
    expect(page.messages[1].sender).toBeNull();
  });

  it('selects contributors, so a listed message carries the same attribution an inserted one does', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeMessageRow()] });

    await listMessages(THREAD_OWNED_BY_MEMBER);

    expect(mockQuery.mock.calls[0][0]).toMatch(/SELECT[\s\S]*\bcontributors\b[\s\S]*FROM insights_chat_messages/);
  });

  it('returns nextCursor when more rows exist than the limit', async () => {
    // Default limit is 20; return 21 rows so the repo signals hasMore=true.
    const rows = Array.from({ length: 21 }, (_, i) =>
      makeMessageRow({
        id: `msg-${i}`,
        created_at: new Date(`2026-04-05T${String(12 - (i % 12)).padStart(2, '0')}:00:00Z`),
      }),
    );
    mockQuery.mockResolvedValueOnce({ rows });

    const result = await listMessages(THREAD_OWNED_BY_MEMBER);

    expect(result.messages).toHaveLength(20);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(result.messages[19].createdAt);
  });

  it('passes cursor as a Date bind param', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listMessages(THREAD_OWNED_BY_MEMBER, {
      cursor: '2026-04-05T12:00:00.000Z',
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('created_at < $2');
    expect(params[1]).toBeInstanceOf(Date);
  });

  it('clamps limit above the cap', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listMessages(THREAD_OWNED_BY_MEMBER, { limit: 9999 });

    const params = mockQuery.mock.calls[0][1];
    // MAX_MESSAGE_LIMIT 200 + 1 for hasMore detection.
    expect(params[params.length - 1]).toBe(201);
  });
});

describe('chat-repository / getCallerRole', () => {
  it('returns the role from tenant_members', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'admin' }] });

    const role = await getCallerRole(TENANT_A, ACCOUNT_OWNER);

    expect(role).toBe('admin');
  });

  it('returns null when not a member', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const role = await getCallerRole(TENANT_A, ACCOUNT_OWNER);

    expect(role).toBeNull();
  });

  it('returns null on database error (logged, fail-closed)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));

    const role = await getCallerRole(TENANT_A, ACCOUNT_OWNER);

    expect(role).toBeNull();
  });
});

// ── Rolling summary (Phase 6) ───────────────────────────────────────────

const FAKE_SUMMARY: ConversationSummary = {
  userIntent: 'Investigating Q1 spend',
  keyFacts: ['Cost up 20%'],
  openQuestions: ['When did it start?'],
  previousFindings: [],
  nextSteps: [],
  summarizedThrough: '2026-04-05T00:00:00Z',
  messageCount: 8,
};

describe('chat-repository / getThreadRollingSummary', () => {
  it('returns the parsed summary when present', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ rolling_summary: FAKE_SUMMARY }],
    });

    const summary = await getThreadRollingSummary(THREAD_OWNED_BY_MEMBER, TENANT_A);
    expect(summary).toEqual(FAKE_SUMMARY);
    // Tenant isolation enforced at the query level
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id = $2'),
      [THREAD_OWNED_BY_MEMBER, TENANT_A],
    );
  });

  it('returns null when the thread exists but has no summary yet', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ rolling_summary: null }] });
    const summary = await getThreadRollingSummary(THREAD_OWNED_BY_MEMBER, TENANT_A);
    expect(summary).toBeNull();
  });

  it('returns null when the thread does not exist / is in a different tenant / is deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const summary = await getThreadRollingSummary(THREAD_OWNED_BY_MEMBER, TENANT_B);
    expect(summary).toBeNull();
  });
});

describe('chat-repository / updateThreadRollingSummary', () => {
  it('serializes the summary as JSONB and returns true on success', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await updateThreadRollingSummary(
      THREAD_OWNED_BY_MEMBER,
      TENANT_A,
      FAKE_SUMMARY,
    );

    expect(result).toBe(true);
    // The third param should be the JSON-stringified summary
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('rolling_summary = $3::jsonb');
    expect(params[0]).toBe(THREAD_OWNED_BY_MEMBER);
    expect(params[1]).toBe(TENANT_A);
    expect(typeof params[2]).toBe('string');
    expect(JSON.parse(params[2] as string)).toEqual(FAKE_SUMMARY);
  });

  it('returns false when the thread is missing / not in the tenant / deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await updateThreadRollingSummary(
      THREAD_OWNED_BY_MEMBER,
      TENANT_B,
      FAKE_SUMMARY,
    );

    expect(result).toBe(false);
  });
});

// ── Unread state ────────────────────────────────────────────────────────
//
// Migration 434. The same assertions agent chat and Liftoff pin for their
// unread mechanics: the list consults the reader's markers without narrowing
// visibility, the marker write is an idempotent upsert, and the reply clock
// moves only for ordinary assistant speech.

describe('chat-repository / unread state', () => {
  it("joins the reader's markers and selects the unread expression in listThreads", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_A, ACCOUNT_MEMBER);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(
      /LEFT JOIN\s+insights_chat_thread_reads\s+r\s+ON\s+r\.thread_id\s*=\s*t\.id\s+AND\s+r\.account_id\s*=\s*\$2/,
    );
    expect(sql).toContain('AS unread');
    expect(sql).toContain('t.last_assistant_message_at IS NOT NULL');
  });

  it('maps unread onto the thread and coerces absence to false', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeThreadRow({ unread: true }),
        makeThreadRow({ id: THREAD_OWNED_BY_OTHER, unread: false }),
      ],
    });

    const result = await listThreads(TENANT_A, ACCOUNT_MEMBER);
    expect(result.threads.map((t) => t.unread)).toEqual([true, false]);

    // Paths that never select the expression (getThread, createThread) come
    // back without the column, which must read as "nothing unread" rather
    // than as anything truthy.
    mockQuery.mockResolvedValueOnce({ rows: [makeThreadRow()] });
    const thread = await getThread(THREAD_OWNED_BY_MEMBER, TENANT_A);
    expect(thread?.unread).toBe(false);
  });

  it('marks a thread read with an idempotent upsert', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await markThreadRead(TENANT_A, ACCOUNT_MEMBER, THREAD_OWNED_BY_MEMBER);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO insights_chat_thread_reads/);
    expect(sql).toMatch(/ON CONFLICT \(thread_id, account_id\)/);
    expect(params).toEqual([THREAD_OWNED_BY_MEMBER, ACCOUNT_MEMBER, TENANT_A]);
  });

  it('counts unread threads for the reader across the tenant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ unread: 4 }] });

    const count = await getUnreadThreadCount(TENANT_A, ACCOUNT_MEMBER);

    expect(count).toBe(4);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('COUNT(*)::int AS unread');
    expect(sql).toContain('t.deleted_at IS NULL');
    expect(params).toEqual([TENANT_A, ACCOUNT_MEMBER]);
  });

  it('stamps the reply clock for ordinary assistant speech, and only that', async () => {
    // The real reply: role assistant, no messageType.
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ role: 'assistant' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Agents cost $412 last week.',
    });
    expect(mockQuery.mock.calls[1][0]).toContain('last_assistant_message_at = NOW()');

    // The person's own message must NOT mark the thread unread: that is the
    // whole reason the clock is not updated_at.
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'user',
      senderAccountId: '00000000-0000-0000-0000-000000000042',
      content: 'How much did agents cost last week?',
    });
    expect(mockQuery.mock.calls[3][0]).not.toContain('last_assistant_message_at');

    // Nor must an assistant row nobody said: the forwarded-context report a
    // delegation writes at thread birth carries a messageType, and stamping it
    // would hand a brand-new delegated thread a dot before anyone answered.
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ role: 'assistant' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Context forwarded from Liftoff.',
      messageType: 'forwarded_context',
    });
    expect(mockQuery.mock.calls[5][0]).not.toContain('last_assistant_message_at');
  });
});
