// Tests for the Phase 3 hybrid CTE that joins knowledge_item_chunks and
// surfaces the matched chunk text as the result excerpt.

const mockTenantClient = { query: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) =>
    fn(mockTenantClient),
  ),
  withAdminScope: jest.fn(async (_meta: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn(mockTenantClient),
  ),
}));

import { searchByTenantAndConnectors, findByIds } from '../repository';

const ORIG_ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  // Force the Phase 3 chunks read path for the chunk-specific assertions
  // below. The per-item read path is exercised by the "BM25 fallback" test
  // via a separate env override.
  process.env = { ...ORIG_ENV, KNOWLEDGE_CHUNK_READ: 'true' };
});
afterAll(() => { process.env = ORIG_ENV; });

describe('searchByTenantAndConnectors hybrid branch', () => {
  it('joins knowledge_item_chunks and returns best_chunk as excerpt', async () => {
    mockTenantClient.query.mockResolvedValueOnce({
      rows: [
        { id: 'item-1', title: 'SOP', source_url: null, connector_id: null, connector_type: null, excerpt: 'matched paragraph', rank: 0.9 },
      ],
    });

    const out = await searchByTenantAndConnectors(
      'tenant-1', [], true, 'leave policy', 5, [0.1, 0.2, 0.3],
    );

    expect(out).toHaveLength(1);
    expect(out[0].excerpt).toBe('matched paragraph');

    const sql = mockTenantClient.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/FROM knowledge_item_chunks c/);
    expect(sql).toMatch(/MAX\(chunk_text\) AS best_chunk/);
    expect(sql).toMatch(/COALESCE\(\s*f\.best_chunk,/);
    expect(sql).toMatch(/c\.embedding <=> \$6::vector/);
  });

  it('falls back to ts_headline when only BM25 matches (no chunk match)', async () => {
    mockTenantClient.query.mockResolvedValueOnce({
      rows: [
        { id: 'item-1', title: 'doc', source_url: null, connector_id: null, connector_type: null, excerpt: 'headline-from-tsv', rank: 0.5 },
      ],
    });
    const out = await searchByTenantAndConnectors(
      'tenant-1', [], true, 'query', 5, [0.1, 0.2, 0.3],
    );
    expect(out[0].excerpt).toBe('headline-from-tsv');
  });

  it('uses BM25-only path when no queryEmbedding supplied', async () => {
    mockTenantClient.query.mockResolvedValueOnce({ rows: [] });
    await searchByTenantAndConnectors('tenant-1', [], true, 'q', 5);
    const sql = mockTenantClient.query.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/knowledge_item_chunks/);
    expect(sql).toMatch(/ts_rank_cd/);
  });

  it('falls back to per-item embedding when KNOWLEDGE_CHUNK_READ is off (default)', async () => {
    process.env.KNOWLEDGE_CHUNK_READ = 'false';
    mockTenantClient.query.mockResolvedValueOnce({ rows: [] });
    await searchByTenantAndConnectors('tenant-1', [], true, 'q', 5, [0.1]);
    const sql = mockTenantClient.query.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/knowledge_item_chunks/);
    // Defaults to v1 column when V2_READ also off
    expect(sql).toMatch(/embedding <=> \$6::vector/);
  });

  it('reads embedding_v2 column when KNOWLEDGE_EMBEDDING_V2_READ=true and CHUNK_READ off', async () => {
    process.env.KNOWLEDGE_CHUNK_READ = 'false';
    process.env.KNOWLEDGE_EMBEDDING_V2_READ = 'true';
    mockTenantClient.query.mockResolvedValueOnce({ rows: [] });
    await searchByTenantAndConnectors('tenant-1', [], true, 'q', 5, [0.1]);
    const sql = mockTenantClient.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/embedding_v2 <=> \$6::vector/);
  });
});

describe('findByIds', () => {
  it('returns connectorId field populated from connector_id column', async () => {
    mockTenantClient.query.mockResolvedValueOnce({
      rows: [
        { id: 'k1', title: 'Article 1', source_url: 'https://x', connector_id: 'conn-1' },
        { id: 'k2', title: 'Article 2', source_url: null, connector_id: null },
      ],
    });
    const out = await findByIds('tenant-1', ['k1', 'k2']);
    expect(out).toEqual([
      { id: 'k1', title: 'Article 1', sourceUrl: 'https://x', connectorId: 'conn-1' },
      { id: 'k2', title: 'Article 2', sourceUrl: null, connectorId: null },
    ]);
    const sql = mockTenantClient.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/SELECT id, title, source_url, connector_id FROM knowledge_items/);
  });

  it('returns empty array when no ids', async () => {
    const out = await findByIds('tenant-1', []);
    expect(out).toEqual([]);
    expect(mockTenantClient.query).not.toHaveBeenCalled();
  });
});

describe('searchByTenantAndConnectors with pinnedIds', () => {
  it('passes pinnedIds as $6 to BM25-only query and uses is_pinned DESC ordering', async () => {
    mockTenantClient.query.mockResolvedValueOnce({ rows: [] });
    await searchByTenantAndConnectors('tenant-1', ['c1'], true, 'q', 5, undefined, ['pin-1']);
    const sql = mockTenantClient.query.mock.calls[0][0] as string;
    const params = mockTenantClient.query.mock.calls[0][1] as unknown[];
    expect(sql).toMatch(/is_pinned DESC, rank DESC/);
    expect(sql).toMatch(/id = ANY\(\$6::uuid\[\]\)/);
    expect(params[5]).toEqual(['pin-1']);
  });

  it('passes pinnedIds as $7 to hybrid query and uses is_pinned DESC ordering', async () => {
    process.env.KNOWLEDGE_CHUNK_READ = 'true';
    mockTenantClient.query.mockResolvedValueOnce({ rows: [] });
    await searchByTenantAndConnectors('tenant-1', ['c1'], true, 'q', 5, [0.1, 0.2], ['pin-1']);
    const sql = mockTenantClient.query.mock.calls[0][0] as string;
    const params = mockTenantClient.query.mock.calls[0][1] as unknown[];
    expect(sql).toMatch(/f\.is_pinned DESC, f\.score DESC/);
    expect(sql).toMatch(/pinned_bm25_overflow/);
    expect(sql).toMatch(/pinned_vec_overflow/);
    expect(params[6]).toEqual(['pin-1']);
    expect(params).toHaveLength(7); // no reserved null slot
  });

  it('defaults pinnedIds to empty array when omitted', async () => {
    mockTenantClient.query.mockResolvedValueOnce({ rows: [] });
    await searchByTenantAndConnectors('tenant-1', ['c1'], true, 'q', 5);
    const params = mockTenantClient.query.mock.calls[0][1] as unknown[];
    expect(params[5]).toEqual([]);
  });
});
