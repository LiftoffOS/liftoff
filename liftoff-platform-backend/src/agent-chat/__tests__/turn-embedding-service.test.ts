// Plan v6 Change 8.2 — turn-embedding-service outcome contract + query-side
// deadline threading. All DB access is through withTenantScope; the embed
// client is the workspace package singleton (mocked here).

const mockEmbed = jest.fn();
jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: { embed: (...args: unknown[]) => mockEmbed(...args) },
}));

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, cb: (c: { query: typeof mockQuery }) => unknown) =>
    cb({ query: mockQuery })),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ log: mockLog }));

import {
  buildTurnEmbeddingText,
  embedTurn,
  getRecallQueryEmbedding,
} from '../turn-embedding-service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TURN = '55555555-5555-4555-8555-555555555555';
const AGENT = '22222222-2222-4222-8222-222222222222';
const SENDER = '44444444-4444-4444-8444-444444444444';

/** Queue the two load queries (turn row, messages) for embedTurn. */
function loadQueue(
  turn: { sender_account_id: string | null; agent_id: string } | undefined,
  messages: Array<{ role: string; content: string }>,
) {
  mockQuery
    .mockResolvedValueOnce({ rows: turn ? [turn] : [] })
    .mockResolvedValueOnce({ rows: messages });
}

describe('embedTurn outcome contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("missing turn row → 'missing'", async () => {
    loadQueue(undefined, []);
    await expect(embedTurn(TENANT, TURN)).resolves.toBe('missing');
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("guest turn (sender NULL) → 'skipped_guest', embed never called", async () => {
    loadQueue({ sender_account_id: null, agent_id: AGENT }, [{ role: 'user', content: 'hi' }]);
    await expect(embedTurn(TENANT, TURN)).resolves.toBe('skipped_guest');
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("empty content → 'skipped_empty'", async () => {
    loadQueue({ sender_account_id: SENDER, agent_id: AGENT }, []);
    await expect(embedTurn(TENANT, TURN)).resolves.toBe('skipped_empty');
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("provider throw → 'failed' + log.error, no UPDATE issued", async () => {
    loadQueue({ sender_account_id: SENDER, agent_id: AGENT }, [{ role: 'user', content: 'hello' }]);
    mockEmbed.mockRejectedValueOnce(new Error('vertex down'));
    await expect(embedTurn(TENANT, TURN)).resolves.toBe('failed');
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, turnId: TURN, err: 'vertex down' }),
      'turn embedding failed',
    );
    // Only the two load queries ran — no UPDATE.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("UPDATE rowCount 0 → 'failed' + warn", async () => {
    loadQueue({ sender_account_id: SENDER, agent_id: AGENT }, [{ role: 'user', content: 'hello' }]);
    mockEmbed.mockResolvedValueOnce({
      embeddings: [[0.5, 0.25]], promptTokens: 2, provider: 'google', model: 'gemini-embedding-001',
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    await expect(embedTurn(TENANT, TURN)).resolves.toBe('failed');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, turnId: TURN }),
      'turn embedding update affected 0 rows',
    );
  });

  it("success → 'embedded'; UPDATE params = vector literal + provider + model; embed context carries agentId + purpose", async () => {
    loadQueue(
      { sender_account_id: SENDER, agent_id: AGENT },
      [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }],
    );
    mockEmbed.mockResolvedValueOnce({
      embeddings: [[0.5, 0.25]], promptTokens: 3, provider: 'google', model: 'gemini-embedding-001',
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await expect(embedTurn(TENANT, TURN)).resolves.toBe('embedded');

    const embedCall = mockEmbed.mock.calls[0][0] as Record<string, unknown>;
    expect(embedCall.input).toBe('question\nanswer');
    expect(embedCall.dimensions).toBe(768);
    expect(embedCall.taskType).toBe('retrieval_document');
    expect(embedCall.context).toEqual({
      tenantId: TENANT, agentId: AGENT, purpose: 'conversation_recall', itemId: TURN,
    });

    const updateArgs = mockQuery.mock.calls[2][1] as unknown[];
    expect(updateArgs).toEqual(['[0.5,0.25]', 'google', 'gemini-embedding-001', TURN, TENANT]);
  });
});

describe('buildTurnEmbeddingText', () => {
  it('joins contents in given order with newline', () => {
    expect(buildTurnEmbeddingText([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])).toBe('a\nb');
  });

  it('truncates at the 4000-char budget', () => {
    const text = buildTurnEmbeddingText([{ role: 'user', content: 'x'.repeat(5000) }]);
    expect(text).toHaveLength(4000);
  });
});

describe('getRecallQueryEmbedding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RECALL_QUERY_EMBED_DEADLINE_MS;
  });

  afterAll(() => {
    delete process.env.RECALL_QUERY_EMBED_DEADLINE_MS;
  });

  it('passes timeoutMs (default 2500) + retries: 0 and returns {vector, provider, model}', async () => {
    mockEmbed.mockResolvedValueOnce({
      embeddings: [[0.1, 0.2]], promptTokens: 1, provider: 'voyage', model: 'voyage-4',
    });
    const result = await getRecallQueryEmbedding('find atlas', { tenantId: TENANT, agentId: AGENT });
    expect(result).toEqual({ vector: [0.1, 0.2], provider: 'voyage', model: 'voyage-4' });
    const call = mockEmbed.mock.calls[0][0] as Record<string, unknown>;
    expect(call.timeoutMs).toBe(2500);
    expect(call.retries).toBe(0);
    expect(call.taskType).toBe('retrieval_query');
    expect(call.context).toEqual({
      tenantId: TENANT, agentId: AGENT, purpose: 'conversation_recall_query',
    });
  });

  it('honors a valid RECALL_QUERY_EMBED_DEADLINE_MS override', async () => {
    process.env.RECALL_QUERY_EMBED_DEADLINE_MS = '1200';
    mockEmbed.mockResolvedValueOnce({
      embeddings: [[0.1]], promptTokens: 1, provider: 'google', model: 'm',
    });
    await getRecallQueryEmbedding('q', { tenantId: TENANT, agentId: AGENT });
    expect((mockEmbed.mock.calls[0][0] as Record<string, unknown>).timeoutMs).toBe(1200);
  });

  it('rejects out-of-range deadlines (negative, zero, > 30000, garbage) back to 2500', async () => {
    for (const bad of ['-500', '0', '30001', 'abc']) {
      process.env.RECALL_QUERY_EMBED_DEADLINE_MS = bad;
      mockEmbed.mockResolvedValueOnce({
        embeddings: [[0.1]], promptTokens: 1, provider: 'google', model: 'm',
      });
      await getRecallQueryEmbedding('q', { tenantId: TENANT, agentId: AGENT });
      const call = mockEmbed.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(call.timeoutMs).toBe(2500);
    }
  });

  it('returns null on provider throw (deadline/failure) without surfacing', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('voyage request timed out after 2500ms'));
    await expect(
      getRecallQueryEmbedding('q', { tenantId: TENANT, agentId: AGENT }),
    ).resolves.toBeNull();
  });
});
