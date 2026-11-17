// Phase 1A — semantic dedup increments usage_count instead of skipping
//
// Mocks the database + embedding + encryption layers so saveMemory's dedup
// branch can be exercised end-to-end against the real service logic. Runs
// under the default jest config (does NOT have the .integration.test.ts
// suffix that the default config excludes).

const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockClientQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('../../infrastructure/database', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: jest.fn().mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: jest.fn(),
    }),
  },
  getPool: jest.fn().mockReturnValue({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: jest.fn().mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: jest.fn(),
    }),
  }),
  getPoolForService: jest.fn().mockReturnValue({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: jest.fn().mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: jest.fn(),
    }),
  }),
}));

jest.mock('../../infrastructure/logging', () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { log: stub, logger: stub };
});

const mockGenerateEmbedding = jest.fn().mockResolvedValue([0.1, 0.2, 0.3]);
const mockGenerateEmbeddingDetailed = jest.fn().mockResolvedValue({
  embedding: [0.1, 0.2, 0.3], model: 'text-embedding-004', provider: 'google', dim: 3,
});
jest.mock('../embedding', () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  generateEmbeddingDetailed: (...args: unknown[]) => mockGenerateEmbeddingDetailed(...args),
  getDefaultProvider: () => 'google',
  getProviderModel: () => 'text-embedding-004',
}));

jest.mock('../encryption', () => ({
  encryptContent: jest.fn(async (content: string) => `encrypted:${content}`),
  decryptContent: jest.fn(async (content: string) => content.replace('encrypted:', '')),
  hashContent: jest.fn((content: string) => {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content).digest('hex');
  }),
}));

import { MemoryService } from '../service';

const memoryService = new MemoryService();

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolQuery.mockReset();
  mockClientQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Phase 1A: semantic dedup increments usage_count', () => {
  const BASE_OPTIONS = {
    tenantId: 'tenant-dedup',
    layer: 'individual' as const,
    scopeKey: 'error-pattern-rate-limit-foo',
    content: 'Always retry rate limit errors with exponential backoff',
    agentId: 'agent-dedup',
    tags: ['auto-extracted', 'error-pattern'],
    semanticDedup: true,
  };

  it('increments usage_count when a similar memory exists (cosine > 0.9)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'existing-mem-1', similarity: '0.95' }] })
      .mockResolvedValueOnce({ rows: [{ usage_count: 7 }] });

    const result = await memoryService.saveMemory(BASE_OPTIONS);

    expect(result.memoryId).toBe('existing-mem-1');
    expect(result.deduplicated).toBe(true);
    expect(result.usageCount).toBe(7);

    const updateCall = mockPoolQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('SET usage_count = usage_count + 1'),
    );
    expect(updateCall).toBeDefined();
  });

  it('refreshes expires_at to MAX(current, new) when expires_at provided', async () => {
    const newExpiry = new Date('2030-01-01T00:00:00Z');
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'existing-mem-2', similarity: '0.95' }] })
      .mockResolvedValueOnce({ rows: [{ usage_count: 2 }] });

    await memoryService.saveMemory({ ...BASE_OPTIONS, expiresAt: newExpiry });

    const updateCall = mockPoolQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('GREATEST(expires_at, $2::timestamptz)'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]![1]).toEqual(newExpiry);
  });

  it('leaves expires_at unchanged when caller omits it', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'existing-mem-3', similarity: '0.95' }] })
      .mockResolvedValueOnce({ rows: [{ usage_count: 3 }] });

    await memoryService.saveMemory(BASE_OPTIONS);

    const updateCall = mockPoolQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('SET usage_count = usage_count + 1'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]![1]).toBeNull();
  });

  it('scope-key prefix narrows dedup search (caller-supplied hint)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'new-mem', is_insert: true }] });

    await memoryService.saveMemory({
      ...BASE_OPTIONS,
      dedupScopeHint: { scopeKeyPrefix: 'escalation-', requireTags: ['escalation'] },
    });

    const selectCall = mockPoolQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('scope_key LIKE $4'),
    );
    expect(selectCall).toBeDefined();
    expect(selectCall![1]![3]).toBe('escalation-%');
    expect(selectCall![1]![4]).toEqual(['escalation']);
  });

  it('falls through to INSERT when no match found', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'fresh-mem-1', is_insert: true }] });

    const result = await memoryService.saveMemory(BASE_OPTIONS);

    expect(result.memoryId).toBe('fresh-mem-1');
    expect(result.deduplicated).toBe(false);

    const insertCall = mockPoolQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO memories'),
    );
    expect(insertCall).toBeDefined();
    // INSERT now explicitly sets usage_count = 1 (not relying on column default)
    expect((insertCall![0] as string)).toMatch(/usage_count/);
  });
});

