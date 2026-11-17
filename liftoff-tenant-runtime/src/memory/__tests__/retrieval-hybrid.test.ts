// Memory Hybrid Retrieval Tests
//
// Tests for the BM25+HNSW+RRF path added in the hybrid retrieval feature.
// Sections:
//   1. scoreMemory pure-function tests (no DB)
//   2. SQL-level integration tests via mocked pool (PII filtering, WHERE identity)
//   3. Conversation layer routing
//   4. RRF merge correctness

// ── Mocks (must be declared before imports) ────────────────────────────────

jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../../memory/embedding', () => ({
  generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  generateEmbeddingDetailed: jest.fn().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3], model: 'text-embedding-004', provider: 'google', dim: 3,
  }),
  getDefaultProvider: () => 'google',
  getProviderModel: () => 'text-embedding-004',
}));

jest.mock('../../memory/hyde', () => ({
  generateHypotheticalDocument: jest.fn().mockImplementation(async (q: string) => q),
}));

jest.mock('../../memory/encryption', () => ({
  encryptContent: jest.fn().mockImplementation((s: string) => s),
  decryptContent: jest.fn().mockImplementation((s: string) => s),
  hashContent: jest.fn().mockReturnValue('hash-abc'),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Imports ────────────────────────────────────────────────────────────────

import { scoreMemory, MemoryService } from '../service';
import { pool } from '../../infrastructure/database';
import { generateHypotheticalDocument } from '../../memory/hyde';

const mockQuery = pool.query as jest.Mock;
const mockHyDE = generateHypotheticalDocument as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<{
  similarity: number;
  usefulnessScore: number;
  importanceScore: number;
  createdAt: Date;
  tags: string[];
}> = {}) {
  const now = Date.now();
  return {
    similarity: 0.8,
    usefulnessScore: 5,
    importanceScore: 3,
    createdAt: new Date(now - 24 * 60 * 60 * 1000),
    tags: [],
    ...overrides,
  };
}

// ── 1. scoreMemory pure-function tests ────────────────────────────────────

describe('scoreMemory', () => {
  const now = Date.now();

  describe('BM25 keyword-exact match (similarity = 0)', () => {
    it('BM25-sourced memory (similarity=0) still gets a positive score via recency/type/tags', () => {
      const m = makeMemory({ similarity: 0, tags: ['type:gotcha'] });
      const score = scoreMemory(m, now, []);
      expect(score).toBeGreaterThan(0);
    });

    it('BM25 memory with matching context tag outscores vector memory with no tag match', () => {
      const bm25Memory = makeMemory({ similarity: 0, tags: ['connector:slack'] });
      const vectorMemory = makeMemory({ similarity: 0.6, tags: [] });
      const contextTags = ['connector:slack'];

      const bm25Score = scoreMemory(bm25Memory, now, contextTags);
      const vectorScore = scoreMemory(vectorMemory, now, contextTags);

      expect(bm25Score).toBeGreaterThan(vectorScore);
    });
  });
});

// ── 2. SQL WHERE clause — PII filtering ───────────────────────────────────

describe('SQL WHERE clause — PII filtering', () => {
  const service = new MemoryService();

  beforeEach(() => {
    mockQuery.mockReset();
    mockHyDE.mockImplementation(async (q: string) => q);
  });

  it('both vector and BM25 queries exclude pii/sensitive content_classification', async () => {
    const capturedSQLs: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      capturedSQLs.push(sql);
      return { rows: [], rowCount: 0 };
    });

    await service.retrieveMemories({
      tenantId: 'tenant-pii-test',
      query: 'search term',
      topK: 5,
    });

    const searchQueries = capturedSQLs.filter(s =>
      s.includes('FROM memories') && (s.includes('embedding') || s.includes('tsquery')),
    );

    expect(searchQueries.length).toBeGreaterThan(0);
    for (const sql of searchQueries) {
      expect(sql).toContain("content_classification NOT IN ('pii', 'sensitive')");
    }
  });

  it('BM25 query has content_tsv filter; vector query has embedding IS NOT NULL filter — not swapped', async () => {
    const capturedSQLs: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      capturedSQLs.push(sql);
      return { rows: [], rowCount: 0 };
    });

    await service.retrieveMemories({
      tenantId: 'tenant-filter-test',
      query: 'find something',
      topK: 5,
    });

    const vectorSQL = capturedSQLs.find(s => s.includes('embedding IS NOT NULL'));
    const bm25SQL = capturedSQLs.find(s => s.includes('to_tsquery'));

    expect(vectorSQL).toBeDefined();
    expect(bm25SQL).toBeDefined();

    // Guards are not swapped
    expect(vectorSQL).not.toContain('to_tsquery');
    expect(bm25SQL).not.toContain('embedding IS NOT NULL');

    // Both filter pii/sensitive
    expect(vectorSQL).toContain("content_classification NOT IN ('pii', 'sensitive')");
    expect(bm25SQL).toContain("content_classification NOT IN ('pii', 'sensitive')");

    // Both filter superseded_by
    expect(vectorSQL).toContain('superseded_by IS NULL');
    expect(bm25SQL).toContain('superseded_by IS NULL');

    // Both filter expiry
    expect(vectorSQL).toContain('expires_at');
    expect(bm25SQL).toContain('expires_at');
  });
});

// ── 3. Conversation layer routing ─────────────────────────────────────────

describe('Conversation layer routing', () => {
  const service = new MemoryService();

  beforeEach(() => {
    mockQuery.mockReset();
    mockHyDE.mockImplementation(async (q: string) => q);
  });

  it('makes a direct layer=conversation query when threadId is provided', async () => {
    const capturedSQLs: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      capturedSQLs.push(sql);
      return { rows: [], rowCount: 0 };
    });

    await service.retrieveMemories({
      tenantId: 'tenant-conv-test',
      query: 'what did we discuss',
      threadId: 'thread-abc',
      topK: 5,
    });

    const conversationQuery = capturedSQLs.find(s =>
      s.includes("layer = 'conversation'") || s.includes("layer='conversation'"),
    );
    expect(conversationQuery).toBeDefined();
  });

  it('conversation layer is excluded from the vector/BM25 hybrid search', async () => {
    const capturedSQLs: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      capturedSQLs.push(sql);
      return { rows: [], rowCount: 0 };
    });

    await service.retrieveMemories({
      tenantId: 'tenant-conv-test',
      query: 'what did we discuss',
      threadId: 'thread-abc',
      topK: 5,
    });

    // The vector/BM25 hybrid queries must not retrieve conversation-layer rows
    const hybridQueries = capturedSQLs.filter(s =>
      s.includes('FROM memories') &&
      (s.includes('embedding IS NOT NULL') || s.includes('to_tsquery')),
    );

    for (const sql of hybridQueries) {
      // Should not include 'conversation' as an allowed layer value
      expect(sql).not.toMatch(/layer\s*=\s*'conversation'/);
    }
  });
});

// ── 4. HyDE: vector uses hypothetical doc, BM25 uses raw query ───────────

describe('HyDE split — vector gets hypothetical doc, BM25 gets raw query', () => {
  const service = new MemoryService();

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('BM25 SQL param is toTsQuery(rawQuery), not the hypothetical document', async () => {
    mockHyDE.mockResolvedValue('A detailed hypothetical answer about Slack pricing tiers.');

    const capturedBM25Params: unknown[][] = [];
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('to_tsquery')) capturedBM25Params.push(params);
      return { rows: [], rowCount: 0 };
    });

    await service.retrieveMemories({
      tenantId: 'tenant-hyde-test',
      query: 'Slack pricing',
      topK: 5,
    });

    expect(capturedBM25Params.length).toBeGreaterThan(0);
    // WS-8.5: BM25 $1 param is the raw query passed through to
    // websearch_to_tsquery (safe for arbitrary free-text input). The earlier
    // manual `& `-join was removed because it produced "syntax error in
    // tsquery" on any reserved char.
    const bm25QueryParam = capturedBM25Params[0][0] as string;
    expect(bm25QueryParam).toBe('Slack pricing');
    expect(bm25QueryParam).not.toContain('hypothetical');
    expect(bm25QueryParam).not.toContain('detailed');
  });

  it('generateEmbedding receives the hypothetical document, not the raw query', async () => {
    const { generateEmbedding } = jest.requireMock('../../memory/embedding') as { generateEmbedding: jest.Mock };
    generateEmbedding.mockClear();
    mockHyDE.mockResolvedValue('A hypothetical document about widget inventory.');

    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await service.retrieveMemories({
      tenantId: 'tenant-hyde-embed-test',
      query: 'widget inventory',
      topK: 5,
    });

    expect(generateEmbedding).toHaveBeenCalledWith(
      'A hypothetical document about widget inventory.',
      expect.any(Object),
    );
    expect(generateEmbedding).not.toHaveBeenCalledWith('widget inventory', expect.any(Object));
  });

  it('does NOT include agentId key in embedding options when agentId is omitted', async () => {
    const { generateEmbedding } = jest.requireMock('../../memory/embedding') as { generateEmbedding: jest.Mock };
    generateEmbedding.mockClear();
    mockHyDE.mockImplementation(async (q: string) => q);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await service.retrieveMemories({
      tenantId: 'tenant-no-agent',
      query: 'test query',
      topK: 5,
    });

    const embeddingOptions = generateEmbedding.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(embeddingOptions)).not.toContain('agentId');
  });

  it('includes agentId key in embedding options when agentId is provided', async () => {
    const { generateEmbedding } = jest.requireMock('../../memory/embedding') as { generateEmbedding: jest.Mock };
    generateEmbedding.mockClear();
    mockHyDE.mockImplementation(async (q: string) => q);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const agentId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await service.retrieveMemories({
      tenantId: 'tenant-with-agent',
      query: 'test query',
      agentId,
      topK: 5,
    });

    const embeddingOptions = generateEmbedding.mock.calls[0][1] as Record<string, unknown>;
    expect(embeddingOptions.agentId).toBe(agentId);
  });
});

// ── 5. RRF degrades gracefully when BM25 returns empty ───────────────────

describe('RRF degrades gracefully when BM25 returns empty', () => {
  const service = new MemoryService();

  beforeEach(() => {
    mockQuery.mockReset();
    mockHyDE.mockImplementation(async (q: string) => q);
  });

  it('returns vector-only results when BM25 yields no rows', async () => {
    // BM25 returns 0 rows; vector returns 2 rows
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('embedding IS NOT NULL')) {
        return {
          rows: [
            { id: 'v1', content: 'vector result one', layer: 'global', scope_key: null,
              tags: [], content_classification: 'general', created_at: new Date(),
              usefulness_score: 5, importance_score: 3, similarity: 0.8 },
            { id: 'v2', content: 'vector result two', layer: 'global', scope_key: null,
              tags: [], content_classification: 'general', created_at: new Date(),
              usefulness_score: 4, importance_score: 2, similarity: 0.6 },
          ],
          rowCount: 2,
        };
      }
      // BM25 and all other queries return empty
      return { rows: [], rowCount: 0 };
    });

    const results = await service.retrieveMemories({
      tenantId: 'tenant-rrf-test',
      query: 'unique vector phrase',
      topK: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    const ids = results.map(r => r.id);
    expect(ids).toContain('v1');
    expect(ids).toContain('v2');
  });
});
