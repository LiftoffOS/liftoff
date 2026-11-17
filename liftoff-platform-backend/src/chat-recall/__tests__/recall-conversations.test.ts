// What the recall search is scoped to, when it spends on an embedding, and what
// the model reads back.
//
// The statements themselves are executed against a migrated database by
// queries.integration — a mocked client can pin their TEXT and say nothing about
// whether Postgres will take them. What is pinned here is the decisions around
// them: the scope, the arm choice, and the wording.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (c: { query: typeof mockQuery }) => unknown) =>
    fn({ query: mockQuery })),
}));

const mockGetQueryEmbedding = jest.fn();
jest.mock('../../agent-chat/turn-embedding-service', () => ({
  getRecallQueryEmbedding: (...a: unknown[]) => mockGetQueryEmbedding(...a),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { keywordSql, recallConversations, semanticSql } from '../recall-conversations';

const CTX = {
  surface: 'liftoff' as const,
  tenantId: 'ten-1',
  accountId: 'acct-1',
};

function hit(overrides: Record<string, unknown> = {}) {
  return {
    turn_id: 'turn-1',
    thread_id: 'thr-1',
    title: 'Invoice chasing',
    created_at: new Date('2026-09-01T09:15:00.000Z'),
    messages: [
      { role: 'user', preview: 'the deadline is 3 March', created_at: '2026-09-01T09:15:00.000Z' },
      { role: 'assistant', preview: 'noted', created_at: '2026-09-01T09:16:00.000Z' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RECALL_SEMANTIC_READ_ENABLED;
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('the statements', () => {
  it('reference every parameter they are given, per arm', () => {
    // Postgres infers a parameter's type from its use, so one passed and never
    // mentioned fails the whole statement with "could not determine data type".
    // The two arms therefore do not share one positional list.
    const keyword = keywordSql('liftoff');
    for (const n of [1, 2, 3, 4, 5, 6]) expect(keyword).toContain(`$${n}`);
    expect(keyword).not.toContain('$7');

    const semantic = semanticSql('liftoff');
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(semantic).toContain(`$${n}`);
    expect(semantic).not.toContain('$9');
  });

  it('reads only its own surface\'s tables', () => {
    for (const sql of [keywordSql('liftoff'), semanticSql('liftoff')]) {
      expect(sql).toContain('liftoff_chat_turns');
      expect(sql).not.toContain('insights_chat');
      expect(sql).not.toContain('agent_chat');
    }
    for (const sql of [keywordSql('insights'), semanticSql('insights')]) {
      expect(sql).toContain('insights_chat_turns');
      expect(sql).not.toContain('liftoff_chat');
      expect(sql).not.toContain('agent_chat');
    }
  });

  it('scopes to the asking person and excludes deleted conversations', () => {
    for (const sql of [keywordSql('liftoff'), semanticSql('liftoff')]) {
      expect(sql).toContain('tr.sender_account_id = $2');
      expect(sql).toContain('th.deleted_at IS NULL');
    }
  });

  it('returns at most one hit per conversation on the semantic arm', () => {
    expect(semanticSql('liftoff')).toContain('DISTINCT ON (tr.thread_id)');
  });

  it('excludes the platform\'s own narration from the previews', () => {
    // Built from transcript-context's set, so a seventh type added there is
    // excluded here on the same edit.
    const sql = keywordSql('liftoff');
    expect(sql).toContain("'hitl_status'");
    expect(sql).toContain("'delegation_status'");
    expect(sql).toContain("'run_progress'");
  });
});

describe('scope', () => {
  it('passes the tenant, the person, the excerpt window and the turn to exclude', async () => {
    await recallConversations({ ...CTX, excludeTurnId: 'turn-now' }, { query: 'Deadline' });

    const params = mockQuery.mock.calls[0][1];
    expect(params[0]).toBe('ten-1');
    expect(params[1]).toBe('acct-1');
    // Lowered for the excerpt window, which is matched against lower(content).
    expect(params[3]).toBe('deadline');
    expect(params[4]).toBe('turn-now');
    // NOT lowered: the search predicate is ILIKE, which is case-insensitive on
    // its own, so folding the case here would only lose the person's wording.
    expect(params[5]).toBe('%Deadline%');
  });

  it('LIKE-escapes the query, so a model\'s percent is a literal and not a wildcard', async () => {
    await recallConversations(CTX, { query: '100% margin' });

    expect(mockQuery.mock.calls[0][1][5]).toBe('%100\\% margin%');
  });

  it('clamps the limit into 1-10 and defaults to 5', async () => {
    await recallConversations(CTX, { limit: 500 });
    expect(mockQuery.mock.calls[0][1][2]).toBe(10);

    mockQuery.mockClear();
    await recallConversations(CTX, {});
    expect(mockQuery.mock.calls[0][1][2]).toBe(5);
  });
});

describe('the two arms', () => {
  it('runs keyword alone when it filled every slot: no embed charge for nothing', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';
    mockQuery.mockResolvedValueOnce({ rows: [hit(), hit({ turn_id: 't2' })] });

    await recallConversations(CTX, { query: 'deadline', limit: 2 });

    expect(mockGetQueryEmbedding).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('runs keyword alone in recent mode: there is nothing to embed', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';

    await recallConversations(CTX, {});

    expect(mockGetQueryEmbedding).not.toHaveBeenCalled();
  });

  it('adds the semantic arm when keyword left room, and merges without duplicating a turn', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';
    mockGetQueryEmbedding.mockResolvedValue({ vector: [0.1, 0.2], provider: 'google', model: 'gemini-embedding-001' });
    mockQuery
      .mockResolvedValueOnce({ rows: [hit({ turn_id: 'shared' })] })
      .mockResolvedValueOnce({ rows: [hit({ turn_id: 'shared' }), hit({ turn_id: 'fresh', title: 'Another' })] });

    const out = await recallConversations(CTX, { query: 'deadline', limit: 5 });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    // 'shared' appears once, not twice.
    expect(out.match(/Invoice chasing/g)).toHaveLength(1);
    expect(out).toContain('Another');
  });

  it('charges the semantic query to this assistant, not to an agent', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';
    mockGetQueryEmbedding.mockResolvedValue({ vector: [0.1], provider: 'google', model: 'm' });

    await recallConversations(CTX, { query: 'deadline' });

    expect(mockGetQueryEmbedding).toHaveBeenCalledWith('deadline', {
      tenantId: 'ten-1',
      purpose: 'liftoff_recall_query',
    });
  });

  it('keeps the keyword rows when the query embedding fails', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';
    mockGetQueryEmbedding.mockResolvedValue(null);
    mockQuery.mockResolvedValueOnce({ rows: [hit()] });

    const out = await recallConversations(CTX, { query: 'deadline' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(out).toContain('Invoice chasing');
  });

  it('does not run the semantic arm at all when the read flag is off', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await recallConversations(CTX, { query: 'deadline' });

    expect(mockGetQueryEmbedding).not.toHaveBeenCalled();
  });
});

describe('what the model reads', () => {
  it('names each conversation, when it was, and who said what', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [hit()] });

    const out = await recallConversations(CTX, { query: 'deadline' });

    expect(out).toContain('Invoice chasing');
    expect(out).toContain('2026-09-01 09:15');
    expect(out).toContain('Person: the deadline is 3 March');
    expect(out).toContain('You: noted');
  });

  it('points at the thread read, so a model that aimed here for the wrong question can correct', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [hit()] });

    expect(await recallConversations(CTX, {})).toContain('read_conversation_history');
  });

  it('distinguishes "no other conversations" from "nothing matched"', async () => {
    expect(await recallConversations(CTX, {}))
      .toBe('There are no other conversations with this person yet.');
    expect(await recallConversations(CTX, { query: 'deadline' }))
      .toBe('No other conversation with this person mentions "deadline".');
  });

  it('answers a failure in words rather than throwing, and never as an empty history', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pool is down'));

    const out = await recallConversations(CTX, { query: 'deadline' });

    expect(out).toContain('could not be searched');
    expect(out).not.toContain('no other conversations');
  });
});
