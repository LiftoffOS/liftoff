// The decisions around the CAIO's conversation search: the bounds, the escaping,
// which arm runs, and what the model is handed back.
//
// What this canNOT cover is whether the statements mean what they say — which
// rows come back, and whether the scope leaks. That needs a database and rows,
// and lives in scripts/verify-recall-sql.mjs, which is run against a migrated
// one. A mocked client here would only prove the text is unchanged.

const mockQuery = jest.fn();
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: jest.fn(async (_tenantId: string, fn: (c: { query: typeof mockQuery }) => unknown) =>
    fn({ query: mockQuery })),
}));

const mockRequestEmbedding = jest.fn();
jest.mock('../workforce-plans/turn-embedding.js', () => ({
  requestEmbedding: (...a: unknown[]) => mockRequestEmbedding(...a),
}));

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  KEYWORD_SQL,
  SEMANTIC_SQL,
  recallConversationsTool,
} from '../workforce-plans/tools/recall-conversations.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

const CTX: WorkforcePlanToolContext = {
  tenantId: 'ten-1',
  accountId: 'acct-1',
  role: 'owner',
  threadId: 'thr-1',
  turnId: 'turn-now',
};

function hit(overrides: Record<string, unknown> = {}) {
  return {
    turn_id: 'turn-1',
    thread_id: 'thr-9',
    title: 'Invoice chasing',
    created_at: new Date('2026-09-01T09:15:00.000Z'),
    messages: [
      { role: 'user', preview: 'set up the invoice chasing team' },
      { role: 'assistant', preview: 'done' },
    ],
    ...overrides,
  };
}

type Result = {
  conversations: Array<{ threadId: string; title: string; at: string; excerpts: Array<{ speaker: string; text: string }> }>;
  excerptsOnly: boolean;
  readWhole: string;
};

const run = (input: Record<string, unknown>, ctx: WorkforcePlanToolContext = CTX) =>
  recallConversationsTool.execute(input, ctx) as Promise<Result>;

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('the statements', () => {
  it('reference every parameter they are given, per arm', () => {
    // Postgres infers a parameter's type from its use, so one passed and never
    // mentioned fails the whole statement with "could not determine data type".
    // That is why the two arms do not share one positional list.
    for (const n of [1, 2, 3, 4, 5, 6]) expect(KEYWORD_SQL).toContain(`$${n}`);
    expect(KEYWORD_SQL).not.toContain('$7');

    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(SEMANTIC_SQL).toContain(`$${n}`);
    expect(SEMANTIC_SQL).not.toContain('$9');
  });

  it('scopes to the asking person rather than to thread ownership', () => {
    // Team-plan threads are readable workspace-wide, so scoping by the thread's
    // owner would let one person's search surface another person's words.
    for (const sql of [KEYWORD_SQL, SEMANTIC_SQL]) {
      expect(sql).toContain('tr.account_id = $2');
      expect(sql).toContain('tr.tenant_id = $1');
      expect(sql).toContain('th.deleted_at IS NULL');
    }
  });

  it('returns at most one hit per conversation on the semantic arm', () => {
    expect(SEMANTIC_SQL).toContain('DISTINCT ON (tr.thread_id)');
  });

  it('compares only vectors from the same space', () => {
    expect(SEMANTIC_SQL).toContain('tr.content_embedding_provider = $7');
    expect(SEMANTIC_SQL).toContain('tr.content_embedding_model = $8');
  });

  it('quotes speech only, never the platform\'s own narration', () => {
    expect(KEYWORD_SQL).toContain('m.message_type IS NULL');
  });
});

describe('what it sends', () => {
  it('passes the tenant, the person, the excerpt window, the excluded turn and the pattern', async () => {
    await run({ query: 'Invoice' });

    const params = mockQuery.mock.calls[0][1];
    expect(params[0]).toBe('ten-1');
    expect(params[1]).toBe('acct-1');
    expect(params[2]).toBe(5);
    // Lowered for the excerpt window, which matches against lower(content).
    expect(params[3]).toBe('invoice');
    expect(params[4]).toBe('turn-now');
    // NOT lowered: the predicate is ILIKE, already case-insensitive.
    expect(params[5]).toBe('%Invoice%');
  });

  it('LIKE-escapes the query, so a model\'s percent cannot match every conversation', async () => {
    await run({ query: '100% margin' });

    expect(mockQuery.mock.calls[0][1][5]).toBe('%100\\% margin%');
  });

  it('excludes nothing when the turn carries no id (a threadless greeting)', async () => {
    await run({}, { ...CTX, turnId: undefined });

    expect(mockQuery.mock.calls[0][1][4]).toBeNull();
  });

  it('clamps the limit into 1-10 and defaults to 5', async () => {
    await run({ limit: 500 });
    expect(mockQuery.mock.calls[0][1][2]).toBe(10);

    mockQuery.mockClear();
    await run({ limit: 0 });
    expect(mockQuery.mock.calls[0][1][2]).toBe(1);
  });
});

describe('the two arms', () => {
  it('runs keyword alone when it filled every slot: no embed charge for nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [hit(), hit({ turn_id: 't2' })] });

    await run({ query: 'invoice', limit: 2 });

    expect(mockRequestEmbedding).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('runs keyword alone in recent mode: there is nothing to embed', async () => {
    await run({});

    expect(mockRequestEmbedding).not.toHaveBeenCalled();
  });

  it('adds the semantic arm when keyword left room, without duplicating a turn', async () => {
    mockRequestEmbedding.mockResolvedValue({ vector: [0.1], provider: 'google', model: 'gemini-embedding-001' });
    mockQuery
      .mockResolvedValueOnce({ rows: [hit({ turn_id: 'shared' })] })
      .mockResolvedValueOnce({ rows: [hit({ turn_id: 'shared' }), hit({ turn_id: 'fresh', thread_id: 'thr-8', title: 'Payroll' })] });

    const out = await run({ query: 'invoice', limit: 5 });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(out.conversations).toHaveLength(2);
    expect(out.conversations.map((c) => c.title)).toEqual(['Invoice chasing', 'Payroll']);
  });

  it('charges the query embed to the Chief AI Officer\'s own purpose', async () => {
    mockRequestEmbedding.mockResolvedValue({ vector: [0.1], provider: 'google', model: 'm' });

    await run({ query: 'invoice' });

    expect(mockRequestEmbedding).toHaveBeenCalledWith('ten-1', 'invoice', 'retrieval_query', 'caio_recall_query');
  });

  it('keeps the keyword rows when the embed could not be had', async () => {
    mockRequestEmbedding.mockResolvedValue(null);
    mockQuery.mockResolvedValueOnce({ rows: [hit()] });

    const out = await run({ query: 'invoice' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(out.conversations).toHaveLength(1);
  });
});

describe('what the model reads', () => {
  it('names the conversation and hands back the id conversation__read takes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [hit()] });

    const out = await run({ query: 'invoice' });

    expect(out.conversations[0]).toEqual({
      threadId: 'thr-9',
      title: 'Invoice chasing',
      at: '2026-09-01T09:15:00.000Z',
      excerpts: [
        { speaker: 'person', text: 'set up the invoice chasing team' },
        { speaker: 'you', text: 'done' },
      ],
    });
    // So a model that has found the right conversation reads it whole rather than
    // answering from an excerpt.
    expect(out.excerptsOnly).toBe(true);
    expect(out.readWhole).toBe('conversation__read');
  });

  it('gives an untitled conversation a readable name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [hit({ title: null })] });

    expect((await run({})).conversations[0].title).toBe('Untitled conversation');
  });

  it('describes itself as the search, and points at the whole read', () => {
    const description = recallConversationsTool.definition.description;
    expect(description).toContain('OTHER conversations');
    expect(description).toContain('conversation__read');
    // The product's own words: the software is an "agent", never an "AI team".
    expect(description).not.toMatch(/\bAI teams?\b/i);
  });
});
