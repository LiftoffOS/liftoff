// Change 4 — glossary alias decode. decodeAliases does an exact-match
// (case-insensitive substring) lookup over `type:alias` memories so bare
// tokens the semantic search would miss ("PSR") get expanded before retrieval.

const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockClientQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('../../infrastructure/database', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: jest.fn().mockResolvedValue({ query: (...a: unknown[]) => mockClientQuery(...a), release: jest.fn() }),
  },
  getPool: jest.fn().mockReturnValue({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
  getPoolForService: jest.fn().mockReturnValue({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));

jest.mock('../../infrastructure/logging', () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { log: stub, logger: stub };
});

jest.mock('../embedding', () => ({
  generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  generateEmbeddingDetailed: jest.fn().mockResolvedValue({ embedding: [0.1], model: 'm', provider: 'google', dim: 1 }),
  getDefaultProvider: () => 'google',
  getProviderModel: () => 'text-embedding-004',
}));

jest.mock('../encryption', () => ({
  encryptContent: jest.fn(async (c: string) => c),
  decryptContent: jest.fn(async (c: string) => c),
}));

jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: jest.fn() } }));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({ getModelForTask: jest.fn().mockResolvedValue(null) }),
}));

import { MemoryService } from '../service';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('MemoryService.decodeAliases (Change 4)', () => {
  const svc = new MemoryService();

  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('returns only the aliases whose text appears in the query (case-insensitive)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { content: 'PSR\tPipeline Status Report' },
        { content: 'Phoenix\tthe database migration project' },
        { content: 'Todd\tTodd Martinez' },
      ],
      rowCount: 3,
    });

    const decoded = await svc.decodeAliases(TENANT, 'can you send todd the psr today');

    expect(decoded).toEqual(
      expect.arrayContaining([
        { alias: 'PSR', canonical: 'Pipeline Status Report' },
        { alias: 'Todd', canonical: 'Todd Martinez' },
      ]),
    );
    // "Phoenix" is not in the query → excluded.
    expect(decoded.find(d => d.alias === 'Phoenix')).toBeUndefined();
  });

  it('filters malformed rows (missing tab / empty canonical)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { content: 'PSR\tPipeline Status Report' },
        { content: 'no-tab-here' },
        { content: 'X\t' },
      ],
      rowCount: 3,
    });

    const decoded = await svc.decodeAliases(TENANT, 'PSR and X and no-tab-here');
    expect(decoded).toEqual([{ alias: 'PSR', canonical: 'Pipeline Status Report' }]);
  });

  it('scopes the query to active type:alias memories in the given layers, and role rows to the given role', async () => {
    await svc.decodeAliases(TENANT, 'anything', ['global', 'role'], ['Sales Engineer']);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("tags && ARRAY['type:alias']::text[]");
    expect(sql).toContain('superseded_by IS NULL');
    expect(sql).toContain('layer = ANY($2)');
    // A role glossary belongs to that role; with no role key, no role rows.
    expect(sql).toContain("(layer <> 'role' OR scope_key = ANY($3))");
    expect(params).toEqual([TENANT, ['global', 'role'], ['Sales Engineer']]);
  });

  it('reads no role glossary when the caller has no role to read', async () => {
    await svc.decodeAliases(TENANT, 'anything');
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params).toEqual([TENANT, ['global', 'role'], []]);
  });

  it('returns [] when there are no alias memories', async () => {
    const decoded = await svc.decodeAliases(TENANT, 'PSR');
    expect(decoded).toEqual([]);
  });
});
