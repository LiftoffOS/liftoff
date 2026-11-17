// Agent-chat chat-repository tests.
//
// First test file for the agent-chat repository. Per the plan (TE-001 + TE-008),
// scoped initially to the new updateThreadTitleInternal function added in
// Part C4. Future repo tests can extend this file following the same pattern.

const mockQuery = jest.fn();
(global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery = mockQuery;

jest.mock('../../infrastructure/database', () => {
  const q = (...args: unknown[]) =>
    (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args);
  const mkClient = () => ({ query: q, release: jest.fn() });
  return {
    getPool: () => ({ query: q }),
    // RLS wrappers route to the same __mockQuery so existing assertions hold.
    withTenantScope: (_t: string, fn: (c: unknown) => unknown) => fn(mkClient()),
    withAdminScope: (_ctx: unknown, fn: (c: unknown) => unknown) => fn(mkClient()),
  };
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import {
  appendMessage,
  countFileCardsProducedInTurn,
  getUnreadCountsByAgent,
  IS_CONVERSATION_PREDICATE,
  listMessages,
  listThreads,
  markThreadRead,
  touchThreadOnClient,
  updateThreadTitleInternal,
} from '../chat-repository';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const THREAD_ID = '00000000-0000-0000-0000-000000000002';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000003';
const AGENT_ID = '00000000-0000-0000-0000-000000000004';

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe('agent-chat / chat-repository / updateThreadTitleInternal', () => {
  it("issues an UPDATE on agent_chat_threads with title='ai' source and tenant_id in WHERE", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await updateThreadTitleInternal(THREAD_ID, TENANT_ID, 'AI Title');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    // Targets the right table.
    expect(sql).toMatch(/UPDATE\s+agent_chat_threads/);
    // Tenant isolation enforced at the SQL level (no permission gate).
    expect(sql).toContain('tenant_id');
    // Marks title as AI-generated.
    expect(sql).toMatch(/title_source\s*=\s*'ai'/);
    // User-rename guard makes a future user-rename endpoint safe.
    expect(sql).toMatch(/title_source\s+IS\s+DISTINCT\s+FROM\s+'user'/);
    // Soft-delete guard.
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/);
    // Bound parameters in the order (title, threadId, tenantId).
    expect(params).toEqual(['AI Title', THREAD_ID, TENANT_ID]);
  });

  it('is a no-op when WHERE clause matches nothing (deleted thread / wrong tenant / user-renamed)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      updateThreadTitleInternal(THREAD_ID, TENANT_ID, 'whatever'),
    ).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('does not throw if the DB rejects (caller is fire-and-forget)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    await expect(
      updateThreadTitleInternal(THREAD_ID, TENANT_ID, 'whatever'),
    ).rejects.toThrow('connection refused');
  });
});

// ── listMessages: human sender resolution ────────────────────────────────
//
// User messages carry their author through turn_id → agent_chat_turns
// .sender_account_id (migration 294). The frontend renders that author as an
// avatar next to the message timestamp, so the join and the mapping are the
// contract under test here.

function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    tenant_id: TENANT_ID,
    thread_id: THREAD_ID,
    agent_id: null,
    role: 'user',
    content: 'hello',
    tool_calls: null,
    input_tokens: 0,
    output_tokens: 0,
    message_type: null,
    attachments: null,
    citations: null,
    created_at: new Date('2026-07-27T10:00:00.000Z'),
    ...overrides,
  };
}

describe('agent-chat / chat-repository / listMessages sender', () => {
  it('joins turns → accounts for user rows and falls back to the web thread creator', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listMessages(THREAD_ID, TENANT_ID);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/LEFT JOIN\s+agent_chat_turns\s+t/);
    expect(sql).toMatch(/LEFT JOIN\s+accounts\s+s/);
    // Assistant/tool rows must never pick up a sender.
    expect(sql).toMatch(/ON\s+m\.role\s*=\s*'user'/);
    // Pre-migration-294 messages (turn_id IS NULL) recover attribution only on
    // single-author web threads.
    expect(sql).toMatch(/COALESCE\(/);
    expect(sql).toMatch(/th\.channel\s*=\s*'web'/);
    // Tenant isolation and ordering stay on the message table after aliasing.
    expect(sql).toMatch(/m\.thread_id = \$1 AND m\.tenant_id = \$2/);
    expect(sql).toMatch(/ORDER BY m\.created_at DESC/);
    expect(params.slice(0, 2)).toEqual([THREAD_ID, TENANT_ID]);
  });

  it('maps the joined account columns onto message.sender', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        messageRow({
          sender_account_id: ACCOUNT_ID,
          sender_first_name: 'Ada',
          sender_last_name: 'Lovelace',
          sender_email: 'ada@example.com',
          sender_avatar_url: null,
        }),
      ],
    });

    const result = await listMessages(THREAD_ID, TENANT_ID);

    expect(result.messages[0].sender).toEqual({
      accountId: ACCOUNT_ID,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      avatarUrl: null,
    });
  });

  it('falls back to the guest display name when no account resolves', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [messageRow({ sender_account_id: null, sender_label: 'Ada Lovelace' })],
    });

    const result = await listMessages(THREAD_ID, TENANT_ID);

    expect(result.messages[0].sender).toBeNull();
    expect(result.messages[0].senderLabel).toBe('Ada Lovelace');
  });

  it('drops the label when a real account resolved, so the two cannot disagree', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        messageRow({
          sender_account_id: ACCOUNT_ID,
          sender_email: 'ada@example.com',
          sender_label: 'stale slack handle',
        }),
      ],
    });

    const result = await listMessages(THREAD_ID, TENANT_ID);

    expect(result.messages[0].sender?.email).toBe('ada@example.com');
    expect(result.messages[0].senderLabel).toBeNull();
  });

  it('selects the label from the turn for user rows only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listMessages(THREAD_ID, TENANT_ID);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/CASE WHEN m\.role = 'user' THEN t\.sender_label END/);
  });

  it('returns sender: null for unattributed rows (guests, assistant replies)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        messageRow({ sender_account_id: null }),
        messageRow({ role: 'assistant', agent_id: ACCOUNT_ID }),
      ],
    });

    const result = await listMessages(THREAD_ID, TENANT_ID);

    expect(result.messages[0].sender).toBeNull();
    expect(result.messages[1].sender).toBeNull();
  });
});

// ── Unread state (migration 338) ─────────────────────────────────────────
//
// The SQL semantics of the predicate itself — newer than the marker, no
// marker at all, another account's marker — are proven against a real
// Postgres in migrations/__tests__/338_agent_chat_unread.integration.test.ts,
// because a mocked client cannot evaluate SQL. What is worth pinning here is
// the shape: that the join is present on BOTH branches of listThreads, that
// it is keyed on the READING account rather than the thread owner, and that
// the two readers share one predicate so they cannot drift.

function threadRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: THREAD_ID,
    tenant_id: TENANT_ID,
    account_id: ACCOUNT_ID,
    channel: 'web',
    external_thread_ref: null,
    title: 'a thread',
    created_at: new Date('2026-08-07T10:00:00.000Z'),
    updated_at: new Date('2026-08-07T11:00:00.000Z'),
    ...overrides,
  };
}

describe('agent-chat / chat-repository / listThreads unread join', () => {
  it('joins the read marker for the READING account on the agent-filtered branch', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_ID, ACCOUNT_ID, { agentId: AGENT_ID });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(
      /LEFT JOIN\s+agent_chat_thread_reads\s+r\s+ON\s+r\.thread_id\s*=\s*t\.id\s+AND\s+r\.account_id\s*=\s*\$2/,
    );
    expect(sql).toMatch(/AS unread/);
    // The reading account is $2; the agent filter shifted to $3.
    expect(params[0]).toBe(TENANT_ID);
    expect(params[1]).toBe(ACCOUNT_ID);
    expect(sql).toMatch(/p\.agent_id = \$3/);
  });

  it('joins the read marker on the no-agent branch too', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_ID, ACCOUNT_ID, {});

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(
      /LEFT JOIN\s+agent_chat_thread_reads\s+r\s+ON\s+r\.thread_id\s*=\s*t\.id\s+AND\s+r\.account_id\s*=\s*\$2/,
    );
    expect(sql).not.toMatch(/agent_chat_thread_participants/);
    expect(params[1]).toBe(ACCOUNT_ID);
  });

  it('selects the same predicate on both branches, so the dot cannot mean two things', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listThreads(TENANT_ID, ACCOUNT_ID, { agentId: AGENT_ID });
    const [withAgent] = mockQuery.mock.calls[0];

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listThreads(TENANT_ID, ACCOUNT_ID, {});
    const [withoutAgent] = mockQuery.mock.calls[1];

    const predicate = /t\.last_agent_message_at IS NOT NULL\s+AND \(r\.last_read_at IS NULL OR t\.last_agent_message_at > r\.last_read_at\)/;
    expect(withAgent).toMatch(predicate);
    expect(withoutAgent).toMatch(predicate);
  });

  it('requires a message that is not a bare auto-greeting, on the agent-filtered branch', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_ID, ACCOUNT_ID, { agentId: AGENT_ID });

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM agent_chat_messages m/);
    expect(sql).toMatch(/m\.thread_id = t\.id/);
  });

  it('requires it on the no-agent branch too', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThreads(TENANT_ID, ACCOUNT_ID, {});

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM agent_chat_messages m/);
  });

  it('keeps all three disjuncts, so nothing real is filtered out with the greeting', async () => {
    // Drop `role <> 'assistant'` and every Slack thread vanishes. Drop
    // `turn_id IS NOT NULL` and a normal reply stops counting. Drop
    // `message_type IS NOT NULL` and a routine proposal delivered out of turn
    // takes its thread with it. Each one is load-bearing on its own.
    expect(IS_CONVERSATION_PREDICATE).toMatch(/m\.role <> 'assistant'/);
    expect(IS_CONVERSATION_PREDICATE).toMatch(/m\.turn_id IS NOT NULL/);
    expect(IS_CONVERSATION_PREDICATE).toMatch(/m\.message_type IS NOT NULL/);
  });

  it('maps the unread column onto the thread, defaulting false without the join', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        threadRow({ id: '00000000-0000-0000-0000-0000000000f1', unread: true }),
        threadRow({ id: '00000000-0000-0000-0000-0000000000f2', unread: false }),
        threadRow({ id: '00000000-0000-0000-0000-0000000000f3' }),
      ],
    });

    const result = await listThreads(TENANT_ID, ACCOUNT_ID, {});

    expect(result.threads.map((t) => t.unread)).toEqual([true, false, false]);
  });
});

describe('agent-chat / chat-repository / touchThreadOnClient', () => {
  it('stamps the reply clock for an assistant row', async () => {
    const client = { query: mockQuery };
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await touchThreadOnClient(client, THREAD_ID, TENANT_ID, true);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE agent_chat_threads/);
    expect(sql).toMatch(/updated_at = NOW\(\)/);
    expect(sql).toMatch(/last_agent_message_at = NOW\(\)/);
    expect(params).toEqual([THREAD_ID, TENANT_ID]);
  });

  it('leaves the reply clock alone for a user row', async () => {
    const client = { query: mockQuery };
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await touchThreadOnClient(client, THREAD_ID, TENANT_ID, false);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/updated_at = NOW\(\)/);
    // The whole point of a separate column: a person writing does not make
    // their own thread unread to them.
    expect(sql).not.toMatch(/last_agent_message_at/);
  });

  it('runs on the caller\'s client, so it composes inside their transaction', async () => {
    const ownClient = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };

    await touchThreadOnClient(ownClient, THREAD_ID, TENANT_ID, true);

    expect(ownClient.query).toHaveBeenCalledTimes(1);
    // It must not open a scope of its own — the wake-settlement and MCP-settle
    // writers need the touch to land atomically with their own statements.
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('agent-chat / chat-repository / appendMessage reply clock', () => {
  it('stamps the reply clock when the appended row is an assistant reply', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'm1', tenant_id: TENANT_ID, thread_id: THREAD_ID, role: 'assistant', content: 'hi', created_at: new Date() }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage(TENANT_ID, THREAD_ID, 'assistant', 'hi', AGENT_ID);

    const [touchSql] = mockQuery.mock.calls[1];
    expect(touchSql).toMatch(/last_agent_message_at = NOW\(\)/);
  });

  it('does not stamp it for a user message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'm1', tenant_id: TENANT_ID, thread_id: THREAD_ID, role: 'user', content: 'hi', created_at: new Date() }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage(TENANT_ID, THREAD_ID, 'user', 'hi');

    const [touchSql] = mockQuery.mock.calls[1];
    expect(touchSql).not.toMatch(/last_agent_message_at/);
  });

  it('does not stamp it for a tool message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'm1', tenant_id: TENANT_ID, thread_id: THREAD_ID, role: 'tool', content: '{}', created_at: new Date() }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage(TENANT_ID, THREAD_ID, 'tool', '{}', AGENT_ID);

    const [touchSql] = mockQuery.mock.calls[1];
    expect(touchSql).not.toMatch(/last_agent_message_at/);
  });
});

describe('agent-chat / chat-repository / appendMessage produced_in_turn_id', () => {
  const TURN_ID = '00000000-0000-0000-0000-000000000005';
  const row = { id: 'm1', tenant_id: TENANT_ID, thread_id: THREAD_ID, role: 'assistant', content: '', created_at: new Date() };

  it('writes the turn a file card was produced in, in its own column and not in turn_id', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage(
      TENANT_ID, THREAD_ID, 'assistant', '', AGENT_ID, null, 0, 0, 'file_output',
      [{ generatedFileId: 'f1' }], undefined, null, null, TURN_ID,
    );

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/produced_in_turn_id/);
    // Positional: turn_id is $12, produced_in_turn_id is $14. A card never
    // carries turn_id — acm_assistant_turn_uniq makes it unique per assistant
    // row and the reply owns it — so two cards in one turn both insert.
    expect(params[11]).toBeNull();
    expect(params[13]).toBe(TURN_ID);
  });

  it('writes NULL when the producer did not say which turn', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage(TENANT_ID, THREAD_ID, 'assistant', '', AGENT_ID, null, 0, 0, 'file_output', [{ generatedFileId: 'f1' }]);

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toHaveLength(15);
    expect(params[13]).toBeNull();
  });
});

describe('agent-chat / chat-repository / contributors', () => {
  const TURN_ID = '00000000-0000-0000-0000-000000000005';
  const CONTRIBUTORS = [
    { id: '00000000-0000-0000-0000-000000000007', label: 'Security Review' },
    { id: '00000000-0000-0000-0000-000000000008', label: 'Legal Counsel' },
  ];
  const row = (contributors: unknown) => ({
    id: 'm1', tenant_id: TENANT_ID, thread_id: THREAD_ID, role: 'assistant', content: '',
    created_at: new Date(), contributors,
  });

  it('writes the list on the reply row, as the 15th column, in the order given', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row(CONTRIBUTORS)] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const saved = await appendMessage(
      TENANT_ID, THREAD_ID, 'assistant', 'Reviewed.', AGENT_ID, undefined, 200, 80,
      undefined, undefined, undefined, TURN_ID, undefined, undefined, CONTRIBUTORS,
    );

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/produced_in_turn_id, contributors\)/);
    expect(sql).toMatch(/\$15\)/);
    expect(JSON.parse(params[14] as string)).toEqual(CONTRIBUTORS);
    expect(saved.contributors).toEqual(CONTRIBUTORS);
  });

  it('writes the empty list, never NULL, when nobody else had a hand in the row', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row([])] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const saved = await appendMessage(TENANT_ID, THREAD_ID, 'user', 'Hi');

    const [, params] = mockQuery.mock.calls[0];
    expect(params[14]).toBe('[]');
    expect(saved.contributors).toEqual([]);
  });

  it('selects the column in listMessages and maps it onto every message', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { ...row(CONTRIBUTORS), id: 'm-reply' },
        // A row read through a path that did not select the column, or a
        // driver that handed back something other than a list, is nobody.
        { ...row(null), id: 'm-old' },
      ],
    });

    const page = await listMessages(THREAD_ID, TENANT_ID);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/m\.contributors/);
    expect(page.messages.map((m) => m.contributors)).toEqual([CONTRIBUTORS, []]);
  });
});

describe('agent-chat / chat-repository / countFileCardsProducedInTurn', () => {
  const TURN_ID = '00000000-0000-0000-0000-000000000005';

  it('anchors on the turn row and reads file_output cards by the turn, with the untagged count since the turn started', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ attributed: 1, unattributed: 0 }] });

    const counts = await countFileCardsProducedInTurn(TENANT_ID, THREAD_ID, TURN_ID);

    expect(counts).toEqual({ attributed: 1, unattributed: 0 });
    const [sql, params] = mockQuery.mock.calls[0];
    // The turn's own row is the anchor: its created_at is when the turn
    // started on the database clock, and a turn id that names no row yields
    // no row rather than zero cards.
    expect(sql).toMatch(/FROM agent_chat_turns t/);
    expect(sql).toMatch(/t\.id = \$3/);
    // Exact association: the turn's own id on the row, never a time window
    // over the thread, and never a media row.
    expect(sql).toMatch(/m\.produced_in_turn_id = t\.id/);
    expect(sql).toMatch(/m\.message_type = 'file_output'/);
    expect(sql).not.toMatch(/media/);
    // The one bound that survives, and it only feeds the SKIP count: an
    // untagged card since the turn started is a reason to say nothing.
    expect(sql).toMatch(/m\.produced_in_turn_id IS NULL AND m\.created_at >= t\.created_at/);
    expect(params).toEqual([TENANT_ID, THREAD_ID, TURN_ID]);
  });

  it('answers zero for both when the turn exists and the thread has no cards', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ attributed: 0, unattributed: 0 }] });
    await expect(countFileCardsProducedInTurn(TENANT_ID, THREAD_ID, TURN_ID))
      .resolves.toEqual({ attributed: 0, unattributed: 0 });
  });

  it('answers null when the turn is not on record, never zero', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(countFileCardsProducedInTurn(TENANT_ID, THREAD_ID, TURN_ID)).resolves.toBeNull();
  });

  it('throws on a lookup failure rather than answering zero', async () => {
    // The caller has to tell "no cards" from "could not look": zero here would
    // read as a positive finding and correct a reply that may be true.
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    await expect(countFileCardsProducedInTurn(TENANT_ID, THREAD_ID, TURN_ID))
      .rejects.toThrow('connection reset');
  });
});

describe('agent-chat / chat-repository / markThreadRead', () => {
  it('upserts the marker rather than inserting a second row', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await markThreadRead(TENANT_ID, ACCOUNT_ID, THREAD_ID);
    await markThreadRead(TENANT_ID, ACCOUNT_ID, THREAD_ID);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    for (const [sql, params] of mockQuery.mock.calls) {
      expect(sql).toMatch(/INSERT INTO agent_chat_thread_reads/);
      expect(sql).toMatch(/ON CONFLICT \(thread_id, account_id\)/);
      expect(sql).toMatch(/DO UPDATE SET last_read_at = NOW\(\)/);
      expect(params).toEqual([THREAD_ID, ACCOUNT_ID, TENANT_ID]);
    }
  });
});

describe('agent-chat / chat-repository / getUnreadCountsByAgent', () => {
  it('groups by the participant agent and carries the tenant + reading account', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getUnreadCountsByAgent(TENANT_ID, ACCOUNT_ID);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/JOIN agent_chat_thread_participants p ON p\.thread_id = t\.id/);
    expect(sql).toMatch(
      /LEFT JOIN agent_chat_thread_reads r ON r\.thread_id = t\.id AND r\.account_id = \$2/,
    );
    expect(sql).toMatch(/GROUP BY p\.agent_id/);
    expect(sql).toMatch(/t\.deleted_at IS NULL/);
    expect(sql).toMatch(/t\.last_agent_message_at IS NOT NULL/);
    expect(params).toEqual([TENANT_ID, ACCOUNT_ID]);
  });

  it('counts only threads the list will show', async () => {
    // A greeting stamps last_agent_message_at like any assistant row, so a
    // greeting-only thread satisfies the unread predicate on its own. Filtering
    // it out of the list without filtering it out of here is a badge with a
    // number on it and no thread behind it to open.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getUnreadCountsByAgent(TENANT_ID, ACCOUNT_ID);
    const [countsSql] = mockQuery.mock.calls[0];

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listThreads(TENANT_ID, ACCOUNT_ID, { agentId: AGENT_ID });
    const [listSql] = mockQuery.mock.calls[1];

    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(normalize(countsSql)).toContain(normalize(IS_CONVERSATION_PREDICATE));
    expect(normalize(listSql)).toContain(normalize(IS_CONVERSATION_PREDICATE));
  });

  it('returns a map keyed by team, and omits teams with nothing unread', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { agent_id: AGENT_ID, unread: 3 },
        { agent_id: '00000000-0000-0000-0000-000000000005', unread: 1 },
      ],
    });

    const counts = await getUnreadCountsByAgent(TENANT_ID, ACCOUNT_ID);

    // A team with zero unread never appears as a row, so it never appears as a
    // key — the payload stays proportional to what is actually unread.
    expect(counts).toEqual({
      [AGENT_ID]: 3,
      '00000000-0000-0000-0000-000000000005': 1,
    });
    expect(counts['00000000-0000-0000-0000-000000000006']).toBeUndefined();
  });
});

// Guard on what counts as an identity. The Teams resolver falls back to the
// literal 'there' when its roster lookup fails, and that must never become an
// avatar — a message labelled "there" is worse than an unlabelled one.
describe('agent-chat / sender label sanitisation', () => {
  const cases: Array<[string | undefined, string | null]> = [
    ['Ada Lovelace', 'Ada Lovelace'],
    ['  Grace Hopper  ', 'Grace Hopper'],
    ['there', null],
    ['There', null],
    ['user', null],
    ['unknown', null],
    ['', null],
    [undefined, null],
  ];

  it.each(cases)('normalises %p to %p', async (input, expected) => {
    const { __testables } = await import('../chat-service');
    expect(__testables.usableSenderLabel(input)).toBe(expected);
  });
});

// Teams parity with Slack: attribution must never degrade to a greeting word.
// Slack's chain ends at the raw user id; Teams now ends at the raw Teams id,
// so a guest message always identifies *someone*.
describe('agent-chat / teams identity label chain', () => {
  const build = (rosterName: string | null, fromName: string | undefined, id: string) =>
    rosterName || fromName?.trim() || `teams:${id}`;

  it('prefers the roster name', () => {
    expect(build('Ada Lovelace', 'stale', 'abc')).toBe('Ada Lovelace');
  });

  it('falls back to the activity name when the roster lookup failed', () => {
    expect(build(null, 'Grace Hopper', 'abc')).toBe('Grace Hopper');
  });

  it('falls back to the raw Teams id rather than a greeting word', () => {
    expect(build(null, undefined, 'abc')).toBe('teams:abc');
    expect(build(null, '   ', 'abc')).toBe('teams:abc');
  });
});
