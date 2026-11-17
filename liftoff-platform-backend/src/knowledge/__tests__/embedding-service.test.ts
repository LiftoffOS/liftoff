// Unit tests for the knowledge-item embedding worker + query embedder.
//
// Rewritten for the @liftoffos/embedding migration (Phase 2): mocks the
// shared embeddingClient (not the OpenAI SDK directly). Covers:
//   - runEmbeddingBatch passes itemId attribution, averages chunks, writes
//     to the v2 column.
//   - embedItem per-item helper (event-driven path).
//   - embedQuery forwards full attribution; returns null when the embed call
//     throws (caller falls back to BM25).

const mockEmbed = jest.fn();
jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: { embed: (...args: unknown[]) => mockEmbed(...args) },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockAdminClient = { query: jest.fn() };
const mockTenantClient = { query: jest.fn() };

jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_meta: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn(mockAdminClient),
  ),
  withTenantScope: jest.fn(async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) =>
    fn(mockTenantClient),
  ),
}));

import { runEmbeddingBatch, embedQuery, embedItem } from '../embedding-service';

function vec(seed: number, len = 768): number[] {
  return new Array(len).fill(seed);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default tenant client return for write queries (DELETE/INSERT/UPDATE).
  // SELECT calls are explicitly overridden per-test via mockResolvedValueOnce.
  mockTenantClient.query.mockResolvedValue({});
});

describe('runEmbeddingBatch', () => {
  it('dual-writes per-chunk rows AND per-item averaged embedding_v2 with itemId attribution', async () => {
    mockAdminClient.query.mockResolvedValueOnce({
      rows: [{ id: 'item-1', tenant_id: 'tenant-1', extracted_text: 'short text' }],
    });
    // embedItem's SELECT row load
    mockTenantClient.query.mockResolvedValueOnce({
      rows: [{ id: 'item-1', tenant_id: 'tenant-1', extracted_text: 'short text' }],
    });
    mockEmbed.mockResolvedValueOnce({ embeddings: [vec(0.5)], promptTokens: 10, model: 'gemini-embedding-001', provider: 'google' });

    const result = await runEmbeddingBatch(1);

    expect(result.embedded).toBe(1);
    expect(result.errors).toBe(0);

    expect(mockEmbed).toHaveBeenCalledTimes(1);
    const [call] = mockEmbed.mock.calls[0];
    expect(call.input).toEqual(['short text']);
    expect(call.dimensions).toBe(768);
    expect(call.taskType).toBe('retrieval_document');
    expect(call.context).toEqual({ tenantId: 'tenant-1', purpose: 'knowledge_embedding', itemId: 'item-1' });

    // 4 tenant queries: SELECT (embedItem load) + DELETE + INSERT + UPDATE.
    expect(mockTenantClient.query).toHaveBeenCalledTimes(4);
    const selectSql = mockTenantClient.query.mock.calls[0][0] as string;
    expect(selectSql).toMatch(/SELECT id, tenant_id, extracted_text/);
    const deleteSql = mockTenantClient.query.mock.calls[1][0] as string;
    expect(deleteSql).toMatch(/DELETE FROM knowledge_item_chunks WHERE item_id = \$1/);
    const insertSql = mockTenantClient.query.mock.calls[2][0] as string;
    expect(insertSql).toMatch(/INSERT INTO knowledge_item_chunks .*embedding_provider, embedding_model/);
    const updateSql = mockTenantClient.query.mock.calls[3][0] as string;
    expect(updateSql).toMatch(/UPDATE knowledge_items SET embedding_v2/);
  });

  it('chunks long text > 4000 chars and writes one chunk row per slice + averages to embedding_v2', async () => {
    const longText = 'a'.repeat(9500); // 3 chunks: 4000 + 4000 + 1500
    mockAdminClient.query.mockResolvedValueOnce({
      rows: [{ id: 'item-2', tenant_id: 'tenant-1', extracted_text: longText }],
    });
    mockTenantClient.query.mockResolvedValueOnce({
      rows: [{ id: 'item-2', tenant_id: 'tenant-1', extracted_text: longText }],
    });
    mockEmbed.mockResolvedValueOnce({
      embeddings: [vec(0.3), vec(0.6), vec(0.9)],
      promptTokens: 2400,
      model: 'g',
      provider: 'google',
    });

    await runEmbeddingBatch(1);

    const [call] = mockEmbed.mock.calls[0];
    expect(call.input).toHaveLength(3);
    expect((call.input as string[])[0]).toHaveLength(4000);

    // 7 params per chunk row × 3 chunks = 21 params on the chunk INSERT
    // Index shifted by +1 vs pre-refactor due to the SELECT in embedItem.
    const insertParams = mockTenantClient.query.mock.calls[2][1] as unknown[];
    expect(insertParams).toHaveLength(21);
    const updateParams = mockTenantClient.query.mock.calls[3][1] as unknown[];
    expect(updateParams[0]).toBe('item-2');
    // Average of 0.3 + 0.6 + 0.9 = 0.6
    expect(updateParams[1]).toMatch(/^\[0\.6,/);
  });

  it('writes a single chunk row for short text < 4000 chars', async () => {
    mockAdminClient.query.mockResolvedValueOnce({
      rows: [{ id: 'item-3', tenant_id: 'tenant-1', extracted_text: 'tiny' }],
    });
    mockTenantClient.query.mockResolvedValueOnce({
      rows: [{ id: 'item-3', tenant_id: 'tenant-1', extracted_text: 'tiny' }],
    });
    mockEmbed.mockResolvedValueOnce({ embeddings: [vec(0.5)], promptTokens: 1, model: 'g', provider: 'google' });

    await runEmbeddingBatch(1);
    const insertParams = mockTenantClient.query.mock.calls[2][1] as unknown[];
    expect(insertParams).toHaveLength(7); // exactly one chunk row
  });

  it('queries via NOT EXISTS chunks OR embedding_v2 IS NULL predicate for pending rows', async () => {
    mockAdminClient.query.mockResolvedValueOnce({ rows: [] });
    await runEmbeddingBatch(1);
    const sql = mockAdminClient.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/embedding_v2 IS NULL/);
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM knowledge_item_chunks/);
  });

  it('isolates per-item errors and continues the batch', async () => {
    mockAdminClient.query.mockResolvedValueOnce({
      rows: [
        { id: 'item-a', tenant_id: 't', extracted_text: 'a' },
        { id: 'item-b', tenant_id: 't', extracted_text: 'b' },
      ],
    });
    // SELECT for item-a then SELECT for item-b
    mockTenantClient.query
      .mockResolvedValueOnce({ rows: [{ id: 'item-a', tenant_id: 't', extracted_text: 'a' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'item-b', tenant_id: 't', extracted_text: 'b' }] });
    mockEmbed
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ embeddings: [vec(0.1)], promptTokens: 1, model: 'g', provider: 'google' });

    const result = await runEmbeddingBatch(2);
    expect(result.embedded).toBe(1);
    expect(result.errors).toBe(1);
  });

  it('returns early with no items pending', async () => {
    mockAdminClient.query.mockResolvedValueOnce({ rows: [] });
    const result = await runEmbeddingBatch(5);
    expect(result).toEqual({ embedded: 0, errors: 0 });
    expect(mockEmbed).not.toHaveBeenCalled();
  });

});

describe('embedItem (per-item helper for event-driven path)', () => {
  it('happy path: SELECTs the item, embeds, writes chunks + per-item vector, returns {embedded: true}', async () => {
    mockTenantClient.query.mockResolvedValueOnce({
      rows: [{ id: 'item-x', tenant_id: 't1', extracted_text: 'hello world' }],
    });
    mockEmbed.mockResolvedValueOnce({ embeddings: [vec(0.4)], promptTokens: 5, model: 'g', provider: 'google' });

    const result = await embedItem('t1', 'item-x');
    expect(result).toEqual({ embedded: true });

    expect(mockEmbed).toHaveBeenCalledTimes(1);
    const [call] = mockEmbed.mock.calls[0];
    expect(call.taskType).toBe('retrieval_document');
    expect(call.context).toEqual({ tenantId: 't1', purpose: 'knowledge_embedding', itemId: 'item-x' });

    // SELECT + DELETE + INSERT + UPDATE
    expect(mockTenantClient.query).toHaveBeenCalledTimes(4);
  });

  it('returns {embedded: false} when item has no extracted_text yet (caller should retry after extraction lands)', async () => {
    mockTenantClient.query.mockResolvedValueOnce({ rows: [] });
    const result = await embedItem('t1', 'missing-item');
    expect(result).toEqual({ embedded: false });
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('idempotent re-run: writeChunks does DELETE+INSERT so the second call replaces chunks cleanly', async () => {
    mockTenantClient.query.mockResolvedValue({}); // default for writes
    mockTenantClient.query
      .mockResolvedValueOnce({ rows: [{ id: 'item-z', tenant_id: 't', extracted_text: 'a' }] })
      .mockResolvedValueOnce({}) // DELETE
      .mockResolvedValueOnce({}) // INSERT
      .mockResolvedValueOnce({}) // UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'item-z', tenant_id: 't', extracted_text: 'a' }] })
      .mockResolvedValueOnce({}) // DELETE again
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    mockEmbed
      .mockResolvedValueOnce({ embeddings: [vec(0.1)], promptTokens: 1, model: 'g', provider: 'google' })
      .mockResolvedValueOnce({ embeddings: [vec(0.2)], promptTokens: 1, model: 'g', provider: 'google' });

    await embedItem('t', 'item-z');
    await embedItem('t', 'item-z');
    // Each call: SELECT + DELETE + INSERT + UPDATE = 8 total tenant queries
    expect(mockTenantClient.query).toHaveBeenCalledTimes(8);
    // The 2nd DELETE confirms DELETE+INSERT pattern (idempotent replace)
    const deleteSql1 = mockTenantClient.query.mock.calls[1][0] as string;
    const deleteSql2 = mockTenantClient.query.mock.calls[5][0] as string;
    expect(deleteSql1).toMatch(/DELETE FROM knowledge_item_chunks/);
    expect(deleteSql2).toMatch(/DELETE FROM knowledge_item_chunks/);
  });

  it('throws on embedding provider failure (caller acks, backstop cron retries)', async () => {
    mockTenantClient.query.mockResolvedValueOnce({
      rows: [{ id: 'item-q', tenant_id: 't', extracted_text: 'x' }],
    });
    mockEmbed.mockRejectedValueOnce(new Error('provider 503'));
    await expect(embedItem('t', 'item-q')).rejects.toThrow(/provider 503/);
  });
});

describe('embedQuery', () => {
  it('forwards full attribution into context and tags as retrieval_query', async () => {
    mockEmbed.mockResolvedValueOnce({ embeddings: [vec(0.1)], promptTokens: 3, model: 'g', provider: 'google' });
    const v = await embedQuery('what is the policy?', {
      tenantId: 't1',
      agentId: 'a1',
      sessionId: 's1',
      threadId: 'th1',
      invocationId: 'iv1',
    });
    expect(v).toEqual(vec(0.1));
    const [call] = mockEmbed.mock.calls[0];
    expect(call.taskType).toBe('retrieval_query');
    expect(call.context).toEqual({
      tenantId: 't1',
      agentId: 'a1',
      sessionId: 's1',
      threadId: 'th1',
      invocationId: 'iv1',
      purpose: 'knowledge_embedding_query',
    });
  });

  it('returns null on provider failure (caller falls back to BM25)', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('no provider'));
    const v = await embedQuery('q', { tenantId: 't' });
    expect(v).toBeNull();
  });

  it('truncates the query to CHUNK_CHAR_BUDGET', async () => {
    mockEmbed.mockResolvedValueOnce({ embeddings: [vec(0)], promptTokens: 1, model: 'g', provider: 'google' });
    const longQuery = 'x'.repeat(5000);
    await embedQuery(longQuery, { tenantId: 't' });
    const [call] = mockEmbed.mock.calls[0];
    expect((call.input as string).length).toBe(4000);
  });
});
