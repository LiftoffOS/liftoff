// Liftoff Chat Repository Tests
//
// Pins down the permission matrix exhaustively (owner/admin/member/viewer x
// list/get/delete) plus pagination cursor behavior.
//
// Since migration 351 the matrix is deliberately lopsided: READS are
// workspace-wide, so every role sees every thread, and the tests that used to
// assert a member could not reach a colleague's thread now assert the opposite.
// WRITES did not move, so the delete and rename cells still refuse. Both halves
// are worth pinning: the first is the feature, and the second is what stops the
// first from quietly taking the rest of the matrix with it.
//
// The scope wrappers are asserted too, not just the SQL. `liftoff_chat_threads`
// is FORCE-RLS, so a thread read that skipped withTenantScope would return zero
// rows in production while every mock-backed test stayed green.

const mockQuery = jest.fn();
(global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery = mockQuery;

const mockWithTenantScope = jest.fn();
const mockWithAdminScope = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({
    query: (...args: unknown[]) =>
      (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args),
  }),
  // Thread ops run under withTenantScope and the two auth/internal primitives
  // (getCallerRole, touchThread) under withAdminScope. Both wrappers delegate
  // to the same mockQuery the rest of the suite uses, so mockResolvedValueOnce
  // chains still read in call order, while the spies let a test assert WHICH
  // wrapper a given call went through.
  withTenantScope: (...args: unknown[]) => mockWithTenantScope(...args),
  withAdminScope: (...args: unknown[]) => mockWithAdminScope(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import {
  appendMessage,
  createThread,
  deleteThread,
  getCallerRole,
  getDelegationByDelegateThread,
  getThread,
  getThreadRollingSummary,
  getUnreadThreadCount,
  listMessages,
  listThreadDelegations,
  listThreads,
  markThreadRead,
  updateThreadRollingSummary,
  updateThreadTitle,
  updateThreadTitleInternal,
  type LiftoffMessageAttachment,
  type TenantMemberRole,
} from '../chat-repository';
import type { ConversationSummary } from '../../insights/conversation-summarization';

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
    title: 'Rewrite the onboarding email',
    deleted_at: null,
    created_at: new Date('2026-08-01T00:00:00Z'),
    updated_at: new Date('2026-08-05T00:00:00Z'),
    ...overrides,
  };
}

function makeMessageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000200',
    thread_id: THREAD_OWNED_BY_MEMBER,
    role: 'user',
    content: 'Can you tidy up this draft?',
    // The column is sparse: most messages carry nothing, so NULL is the
    // default a row comes back with.
    attachments: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: new Date('2026-08-05T12:00:00Z'),
    ...overrides,
  };
}

/** The fake scoped client both wrappers hand to their callback. */
function scopedClient() {
  return {
    query: (...args: unknown[]) =>
      (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  mockWithTenantScope.mockImplementation(
    async (_tenantId: string, fn: (client: ReturnType<typeof scopedClient>) => Promise<unknown>) =>
      fn(scopedClient()),
  );
  mockWithAdminScope.mockImplementation(
    async (_ctx: unknown, fn: (client: ReturnType<typeof scopedClient>) => Promise<unknown>) =>
      fn(scopedClient()),
  );
});

describe('chat-repository / createThread', () => {
  it('inserts a thread with the given title', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeThreadRow()] });

    const thread = await createThread({
      tenantId: TENANT_A,
      accountId: ACCOUNT_MEMBER,
      title: 'Rewrite the onboarding email',
    });

    expect(thread.tenantId).toBe(TENANT_A);
    expect(thread.accountId).toBe(ACCOUNT_MEMBER);
    expect(thread.title).toBe('Rewrite the onboarding email');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO liftoff_chat_threads'),
      [TENANT_A, ACCOUNT_MEMBER, 'Rewrite the onboarding email'],
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

describe('chat-repository / listThreads: workspace-wide', () => {
  // Every role gets the same query: no visibility narrowing by account, ever.
  // The reader's account became a bind param in migration 433, but only for
  // the read-marker join; the proof visibility did not narrow is that no
  // t.account_id filter appears in the WHERE.
  for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
    it(`lists without an account filter for ${role}`, async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeThreadRow()] });

      await listThreads(TENANT_A, ACCOUNT_MEMBER);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('FROM liftoff_chat_threads');
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

  it('runs inside a tenant scope, because the threads table is FORCE-RLS', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_A, ACCOUNT_MEMBER);

    expect(mockWithTenantScope).toHaveBeenCalledWith(TENANT_A, expect.any(Function));
    expect(mockWithAdminScope).not.toHaveBeenCalled();
  });

  it('returns nextCursor when more rows exist than the limit', async () => {
    // Limit defaults to 20; return 21 rows so the repo signals hasMore=true.
    const rows = Array.from({ length: 21 }, (_, i) =>
      makeThreadRow({
        id: `thread-${i}`,
        updated_at: new Date(`2026-08-${String(5 - (i % 5)).padStart(2, '0')}T00:00:00Z`),
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

    await listThreads(TENANT_A, ACCOUNT_MEMBER, { cursor: '2026-08-05T00:00:00.000Z' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('t.updated_at < $3');
    expect(params[2]).toBeInstanceOf(Date);
    expect((params[2] as Date).toISOString()).toBe('2026-08-05T00:00:00.000Z');
  });

  it('clamps limit above the cap', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_A, ACCOUNT_MEMBER, { limit: 9999 });

    // MAX_THREAD_LIMIT is 100, plus the +1 for hasMore detection.
    const params = mockQuery.mock.calls[0][1];
    expect(params[params.length - 1]).toBe(101);
  });
});

describe('chat-repository / getThread: workspace-wide', () => {
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
  // which is what made a Liftoff thread impossible to hand to a colleague.
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

  it('excludes soft-deleted threads in the query itself', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getThread(THREAD_OWNED_BY_MEMBER, TENANT_A);

    expect(mockQuery.mock.calls[0][0]).toContain('deleted_at IS NULL');
  });

  it('reads through withTenantScope, never the bare pool', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeThreadRow()] });

    await getThread(THREAD_OWNED_BY_MEMBER, TENANT_A);

    expect(mockWithTenantScope).toHaveBeenCalledWith(TENANT_A, expect.any(Function));
    expect(mockWithAdminScope).not.toHaveBeenCalled();
  });

  // The surface is tenant-wide, so reading is not narrowed by who is asking.
  // Acting on somebody else's thread still is: see the delete tests above.
  it('returns a thread another account started', async () => {
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
});

// The deliberate exception to migration 351. Everyone can now READ everyone
// else's thread; destroying one is still the author's or a privileged role's.
// The check used to fall out of getThread returning null and is now written
// explicitly, which is exactly the kind of move that silently loses a rule, so
// every cell is re-asserted here.
describe('chat-repository / deleteThread: still restricted', () => {
  it('owner can soft-delete any thread in tenant', async () => {
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
    // Soft delete: the row stays, the timestamp hides it from every read path.
    expect(mockQuery.mock.calls[1][0]).toContain('UPDATE liftoff_chat_threads');
    expect(mockQuery.mock.calls[1][0]).toContain('deleted_at = NOW()');
    expect(mockQuery.mock.calls[1][0]).not.toContain('DELETE FROM');
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

  it('returns false when the row was already deleted between check and update', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeThreadRow({ account_id: ACCOUNT_MEMBER })] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const ok = await deleteThread(
      THREAD_OWNED_BY_MEMBER,
      TENANT_A,
      ACCOUNT_MEMBER,
      'member',
    );

    expect(ok).toBe(false);
  });
});

// Renaming carries the same rule as deleting, and for the same reason: it
// rewrites how the author finds their own conversation again.
describe('chat-repository / updateThreadTitle: still restricted', () => {
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
  it("issues an UPDATE with title_source='ai' and tenant_id in WHERE", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await updateThreadTitleInternal(THREAD_OWNED_BY_MEMBER, TENANT_A, 'AI Title');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    // Tenant isolation enforced at the SQL level (no permission gate).
    expect(sql).toMatch(/UPDATE\s+liftoff_chat_threads/);
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
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      updateThreadTitleInternal(THREAD_OWNED_BY_MEMBER, TENANT_A, 'whatever'),
    ).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(1);
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
      content: 'Can you tidy up this draft?',
    });

    expect(message.role).toBe('user');
    expect(message.content).toBe('Can you tidy up this draft?');

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO liftoff_chat_messages');
    expect(insertCall[1]).toEqual([
      THREAD_OWNED_BY_MEMBER,
      'user',
      'Can you tidy up this draft?',
      null, // attachments
      null, // author: Liftoff itself, never a colleague, on a user message
      null, // author_label
      null, // visualization_blocks
      null, // message_type: ordinary speech, not a status row
      // media (migration 391): sparse, so a message carrying none stores NULL
      // rather than an empty array.
      null,
      0, // input_tokens
      0, // output_tokens
      // sender_account_id (migration 492): the person who wrote it.
      '00000000-0000-0000-0000-000000000042',
      // files (migration 546): a card SHOWN into the message, sparse for the
      // same reason as media beside it.
      null,
      // turn_id (migration 547): the turn this row was written inside. NULL
      // here because this caller opened none; the chat service always does.
      null,
    ]);

    const touchCall = mockQuery.mock.calls[1];
    expect(touchCall[0]).toContain('UPDATE liftoff_chat_threads');
    expect(touchCall[0]).toContain('updated_at = NOW()');
  });

  it('records token usage on the assistant message', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          makeMessageRow({
            role: 'assistant',
            content: 'Here is a tighter version.',
            input_tokens: 100,
            output_tokens: 25,
          }),
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Here is a tighter version.',
      inputTokens: 100,
      outputTokens: 25,
    });

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[1][9]).toBe(100);
    expect(insertCall[1][10]).toBe(25);
    expect(message.inputTokens).toBe(100);
    expect(message.outputTokens).toBe(25);
  });

  // The row a paused handover posts about itself. Marked so the transcript
  // renders it as a status line rather than as something a colleague said, and
  // so the next turn's prompt can leave it out.
  it('marks a status row so it is not read back as speech', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          makeMessageRow({
            role: 'assistant',
            content: 'Support Team is waiting on an approval before it can continue.',
            author: 'agent-7',
            author_label: 'Support Team',
            message_type: 'hitl_status',
          }),
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Support Team is waiting on an approval before it can continue.',
      author: 'agent-7',
      authorLabel: 'Support Team',
      messageType: 'hitl_status',
    });

    expect(mockQuery.mock.calls[0][1][7]).toBe('hitl_status');
    expect(message.messageType).toBe('hitl_status');
  });

  // The author pair is the record; `contributors` is its list-shaped reading,
  // the shape every other surface stores, so one renderer draws the chips on
  // all of them. Derived on read, never stored a second time.
  it('reads a hand-over back as a one-element contributors list derived from the author pair', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [makeMessageRow({ role: 'assistant', author: 'caio', author_label: 'Chief AI Officer' })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Here is the team I propose.',
      author: 'caio',
      authorLabel: 'Chief AI Officer',
    });

    expect(message.contributors).toEqual([{ id: 'caio', label: 'Chief AI Officer' }]);
    // Nothing new on the INSERT: the pair is still what is written.
    expect(mockQuery.mock.calls[0][0]).not.toContain('contributors');
  });

  it('reads a reply Liftoff wrote itself back with no contributors', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ role: 'assistant' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Happy to help.',
    });

    expect(message.author).toBeNull();
    expect(message.contributors).toEqual([]);
  });

  it('falls back to the id as the label for a row that named a colleague but stored no label', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ role: 'assistant', author: 'insights', author_label: null })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Costs are up 4%.',
      author: 'insights',
    });

    expect(message.contributors).toEqual([{ id: 'insights', label: 'insights' }]);
  });

  // Every row written before migration 352 comes back this way, so a caller
  // never has to tell "speech" apart from "written before the column existed".
  it('reads a row with no kind back as ordinary speech', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'user',
      senderAccountId: '00000000-0000-0000-0000-000000000042',
      content: 'Can you tidy up this draft?',
    });

    expect(message.messageType).toBeNull();
  });

  it('touches the parent by primary key under withAdminScope, with no tenant in scope', async () => {
    // appendMessage only carries a threadId. The caller already checked
    // visibility with getThread, so the recency bump is a by-PK write with no
    // tenant context to scope it by. Messages themselves are not RLS, so the
    // INSERT stays on the default pool.
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'user',
      senderAccountId: '00000000-0000-0000-0000-000000000042',
      content: 'Can you tidy up this draft?',
    });

    expect(mockWithTenantScope).not.toHaveBeenCalled();
    expect(mockWithAdminScope).toHaveBeenCalledWith(
      expect.objectContaining({ caller: 'liftoff.touchThread' }),
      expect.any(Function),
    );
    expect(mockQuery.mock.calls[1][1]).toEqual([THREAD_OWNED_BY_MEMBER]);
  });
});

// ── Unread state ────────────────────────────────────────────────────────
//
// Migration 433. The same assertions agent chat pins for its unread
// mechanics: the list consults the reader's markers without narrowing
// visibility, the marker write is an idempotent upsert, and the reply clock
// moves only when Liftoff speaks.

describe('chat-repository / unread state', () => {
  it("joins the reader's markers and selects the unread expression in listThreads", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_A, ACCOUNT_MEMBER);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(
      /LEFT JOIN\s+liftoff_chat_thread_reads\s+r\s+ON\s+r\.thread_id\s*=\s*t\.id\s+AND\s+r\.account_id\s*=\s*\$2/,
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

  it('marks a thread read with an idempotent upsert under tenant scope', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await markThreadRead(TENANT_A, ACCOUNT_MEMBER, THREAD_OWNED_BY_MEMBER);

    expect(mockWithTenantScope).toHaveBeenCalledWith(TENANT_A, expect.any(Function));
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO liftoff_chat_thread_reads/);
    expect(sql).toMatch(/ON CONFLICT \(thread_id, account_id\)/);
    expect(params).toEqual([THREAD_OWNED_BY_MEMBER, ACCOUNT_MEMBER, TENANT_A]);
  });

  it('counts unread threads for the reader across the tenant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ unread: 3 }] });

    const count = await getUnreadThreadCount(TENANT_A, ACCOUNT_MEMBER);

    expect(count).toBe(3);
    expect(mockWithTenantScope).toHaveBeenCalledWith(TENANT_A, expect.any(Function));
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('COUNT(*)::int AS unread');
    expect(sql).toContain('t.deleted_at IS NULL');
    expect(params).toEqual([TENANT_A, ACCOUNT_MEMBER]);
  });

  it('stamps the reply clock when Liftoff speaks, and only then', async () => {
    // Assistant append: the recency touch carries the clock.
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ role: 'assistant' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Here is the tidied draft.',
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
      content: 'Can you tidy up this draft?',
    });
    expect(mockQuery.mock.calls[3][0]).not.toContain('last_assistant_message_at');
  });
});

// ── Attachment metadata ─────────────────────────────────────────────────
//
// Attachments are the one thing this surface stores that the insights chat
// does not, and the reason to store them at all is that a reloaded thread
// should still show the chips. What must NOT survive the turn is the upload's
// text: it is a one-turn model input, and eight of them at 4000 characters
// apiece would put a second copy of every document into this table.

const UPLOAD_META: LiftoffMessageAttachment = { kind: 'upload', name: 'q3-notes.md' };
const CONNECTOR_META: LiftoffMessageAttachment = {
  kind: 'connector',
  name: 'Q3 board deck',
  connectorType: 'google_drive',
  connectorId: 'conn-1',
  externalId: 'file-123',
  sourceUrl: 'https://drive.example.com/file-123',
};

/** The JSONB payload the INSERT was handed, parsed back out. */
function storedAttachments(): unknown {
  const raw = mockQuery.mock.calls[0][1][3];
  return raw === null ? null : JSON.parse(raw as string);
}

describe('chat-repository / appendMessage: attachment metadata', () => {
  it('serializes upload metadata as JSONB and reads it back on the returned message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ attachments: [UPLOAD_META] })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'user',
      senderAccountId: '00000000-0000-0000-0000-000000000042',
      content: 'Can you tidy up this draft?',
      attachments: [UPLOAD_META],
    });

    expect(mockQuery.mock.calls[0][0]).toContain('attachments');
    expect(storedAttachments()).toEqual([{ kind: 'upload', name: 'q3-notes.md' }]);
    expect(message.attachments).toEqual([UPLOAD_META]);
  });

  it('keeps every connector identifier, so a chip can be resolved later', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ attachments: [CONNECTOR_META] })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'user',
      senderAccountId: '00000000-0000-0000-0000-000000000042',
      content: 'What does this say?',
      attachments: [CONNECTOR_META],
    });

    expect(storedAttachments()).toEqual([CONNECTOR_META]);
    expect(message.attachments).toEqual([CONNECTOR_META]);
  });

  it('never writes upload CONTENT, whatever the caller hands it', async () => {
    // The projection lives in chat-service, but the repository is the last
    // place a body could still slip into the table, so it is asserted here too.
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ attachments: [UPLOAD_META] })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'user',
      senderAccountId: '00000000-0000-0000-0000-000000000042',
      content: 'Summarise this for me.',
      attachments: [UPLOAD_META],
    });

    const stored = storedAttachments() as Array<Record<string, unknown>>;
    expect(stored[0]).not.toHaveProperty('content');
    expect(Object.keys(stored[0])).toEqual(['kind', 'name']);
    expect(JSON.stringify(stored)).not.toContain('The quarter closed');
  });

  it('stores NULL when the message carried nothing, and reads it back as an empty list', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'user',
      senderAccountId: '00000000-0000-0000-0000-000000000042',
      content: 'Just a question.',
    });

    expect(storedAttachments()).toBeNull();
    expect(message.attachments).toEqual([]);
  });

  it('stores NULL for an empty list rather than an empty JSON array', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage({
      threadId: THREAD_OWNED_BY_MEMBER,
      role: 'assistant',
      content: 'Here is a tighter version.',
      attachments: [],
    });

    expect(storedAttachments()).toBeNull();
  });
});

describe('chat-repository / listMessages: attachment metadata', () => {
  it('selects the column and returns the metadata for each message', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeMessageRow({ id: 'msg-with', attachments: [UPLOAD_META, CONNECTOR_META] }),
        makeMessageRow({ id: 'msg-without' }),
      ],
    });

    const result = await listMessages(THREAD_OWNED_BY_MEMBER);

    expect(mockQuery.mock.calls[0][0]).toContain('attachments');
    expect(result.messages[0].attachments).toEqual([UPLOAD_META, CONNECTOR_META]);
    // Never undefined and never null: the frontend maps over this field.
    expect(result.messages[1].attachments).toEqual([]);
  });

  it('reads a row written before the column existed as an empty list', async () => {
    // Belt and braces for the pre-feature rows a redeployed environment can
    // still hold: anything that is not an array is an empty list, not garbage.
    mockQuery.mockResolvedValueOnce({
      rows: [makeMessageRow({ attachments: undefined })],
    });

    const result = await listMessages(THREAD_OWNED_BY_MEMBER);

    expect(result.messages[0].attachments).toEqual([]);
  });
});

describe('chat-repository / listMessages', () => {
  it('orders by created_at DESC for reverse scrollback', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeMessageRow()] });

    await listMessages(THREAD_OWNED_BY_MEMBER);

    expect(mockQuery.mock.calls[0][0]).toContain('ORDER BY created_at DESC');
  });

  it('returns nextCursor when more rows exist than the limit', async () => {
    // Default limit is 20; return 21 rows so the repo signals hasMore=true.
    const rows = Array.from({ length: 21 }, (_, i) =>
      makeMessageRow({
        id: `msg-${i}`,
        created_at: new Date(`2026-08-05T${String(12 - (i % 12)).padStart(2, '0')}:00:00Z`),
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
      cursor: '2026-08-05T12:00:00.000Z',
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

  it('looks the role up under withAdminScope, before any tenant context exists', async () => {
    // The role is what decides whether the caller may proceed, so it cannot be
    // read from inside a scope that assumes they already belong.
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'member' }] });

    await getCallerRole(TENANT_A, ACCOUNT_MEMBER);

    expect(mockWithAdminScope).toHaveBeenCalledWith(
      expect.objectContaining({ caller: 'liftoff.getCallerRole' }),
      expect.any(Function),
    );
    expect(mockQuery.mock.calls[0][1]).toEqual([TENANT_A, ACCOUNT_MEMBER]);
  });
});

// ── Rolling summary ─────────────────────────────────────────────────────

const FAKE_SUMMARY: ConversationSummary = {
  userIntent: 'Editing the onboarding email',
  keyFacts: ['Draft is too long'],
  openQuestions: ['Who signs it off?'],
  previousFindings: [],
  nextSteps: [],
  summarizedThrough: '2026-08-05T00:00:00Z',
  messageCount: 8,
};

describe('chat-repository / getThreadRollingSummary', () => {
  it('returns the parsed summary when present', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ rolling_summary: FAKE_SUMMARY }],
    });

    const summary = await getThreadRollingSummary(THREAD_OWNED_BY_MEMBER, TENANT_A);

    expect(summary).toEqual(FAKE_SUMMARY);
    // Tenant isolation enforced at the query level as well as by the scope.
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

// The pairing, read in both directions. Forward is the client asking where a
// colleague named on a status row can be opened; backward is a resume that knows
// only the colleague's own thread and has to find the conversation that asked
// for the work.
describe('chat-repository / paired colleague threads', () => {
  it('lists every colleague this conversation has a thread with', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { target_kind: 'team', target_id: 'agent-7', delegate_thread_id: 'delegate-1' },
        { target_kind: 'caio', target_id: null, delegate_thread_id: 'delegate-2' },
      ],
    });

    const delegations = await listThreadDelegations(THREAD_OWNED_BY_MEMBER);

    expect(delegations).toEqual([
      { targetKind: 'team', targetId: 'agent-7', delegateThreadId: 'delegate-1' },
      { targetKind: 'caio', targetId: null, delegateThreadId: 'delegate-2' },
    ]);
    expect(mockQuery.mock.calls[0][1]).toEqual([THREAD_OWNED_BY_MEMBER]);
  });

  it('finds the conversation a colleague thread belongs to', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ liftoff_thread_id: THREAD_OWNED_BY_MEMBER, target_id: 'agent-7' }],
    });

    const pairing = await getDelegationByDelegateThread('delegate-1', 'team');

    expect(pairing).toEqual({
      liftoffThreadId: THREAD_OWNED_BY_MEMBER,
      targetId: 'agent-7',
    });
  });

  // The three colleague surfaces keep their thread ids in three different
  // tables, so a workforce team-plan id that happened to collide with an
  // agent-chat one must not resolve.
  it('narrows the backward lookup by kind', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getDelegationByDelegateThread('delegate-1', 'team');

    expect(mockQuery.mock.calls[0][1]).toEqual(['delegate-1', 'team']);
  });

  it('returns null for a thread that belongs to nobody', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(getDelegationByDelegateThread('delegate-1', 'team')).resolves.toBeNull();
  });
});
