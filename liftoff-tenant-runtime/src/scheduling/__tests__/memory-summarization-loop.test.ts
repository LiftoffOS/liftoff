// Change C: seed 5 L0 memories with same primary tag; assert L1 written.

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn();
  const clientQuery = jest.fn();
  const release = jest.fn();
  const connect = jest.fn(async () => ({ query: clientQuery, release }));
  return {
    pool: { query, connect },
    getPoolForService: jest.fn(() => ({ query, connect })),
    __query: query,
    __clientQuery: clientQuery,
  };
});

jest.mock('../../llm/client', () => ({
  llmClient: {
    modelSelectionFor: (pair: { model?: string; provider?: string } | null | undefined) =>
      (pair?.model
        ? { provider: pair.provider ?? 'anthropic', model: pair.model }
        : (pair?.provider ? { provider: pair.provider } : {})),
    complete: jest.fn().mockResolvedValue({ content: 'You should normalize timestamps before persisting.' }),
  },
}));
const mockIsExecutionAllowed = jest.fn().mockResolvedValue(true);
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({
    getModelForTask: jest.fn().mockResolvedValue({ model: 'claude-haiku-4-5', provider: 'anthropic' }),
  }),
  isExecutionAllowed: (tenantId: string) => mockIsExecutionAllowed(tenantId),
}));
jest.mock('../../memory/embedding', () => ({
  generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  generateEmbeddingDetailed: jest.fn().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3], model: 'text-embedding-004', provider: 'google', dim: 3,
  }),
  getDefaultProvider: () => 'google',
  getProviderModel: () => 'text-embedding-004',
}));
jest.mock('../../memory/provenance-service', () => ({
  recordSynthesis: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../memory/content-sanitizer', () => ({
  sanitizeMemoryContent: (s: string) => ({ sanitized: s }),
}));

describe('memory-summarization-loop daily', () => {
  beforeEach(() => {
    process.env.MEM_SUMMARIZATION_ENABLED = '1';
    mockIsExecutionAllowed.mockReset().mockResolvedValue(true);
  });
  afterAll(() => {
    delete process.env.MEM_SUMMARIZATION_ENABLED;
  });

  // BILLING-GATE: suspended tenants must not incur summarization LLM cost.
  it('skips entirely (no LLM, no DB) when the tenant is not execution-allowed', async () => {
    mockIsExecutionAllowed.mockResolvedValue(false);
    const db = require('../../infrastructure/database');
    const query = db.__query as jest.Mock;
    query.mockReset();
    const llm = require('../../llm/client').llmClient.complete as jest.Mock;
    llm.mockClear();

    const { runDailySummarization } = require('../memory-summarization-loop');
    const result = await runDailySummarization('tenant-suspended');

    expect(result).toEqual({ summaries: 0, superseded: 0 });
    expect(mockIsExecutionAllowed).toHaveBeenCalledWith('tenant-suspended');
    // No advisory lock acquired, no LLM call.
    expect(query).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });

  it('writes an L1 memory with summarizes array set to member IDs', async () => {
    const db = require('../../infrastructure/database');
    const query = db.__query as jest.Mock;
    const clientQuery = db.__clientQuery as jest.Mock;
    query.mockReset();
    clientQuery.mockReset();

    // advisory lock acquired
    query.mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 });
    // SELECT 5 L0 memories all tagged type:gotcha
    query.mockResolvedValueOnce({
      rows: Array.from({ length: 5 }, (_, i) => ({
        id: `mem-${i}`,
        content: `gotcha #${i}`,
        tags: ['type:gotcha'],
        usefulness_score: 5,
        importance_score: 3,
        influence_score: '0.6',
        source_trust: '0.5',
        created_at: new Date(),
        agent_id: null,
        layer: 'individual',
      })),
      rowCount: 5,
    });
    // supersede UPDATE
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // advisory_unlock
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // BEGIN -> INSERT memories -> recordSynthesis -> COMMIT
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    clientQuery.mockResolvedValueOnce({ rows: [{ id: 'summary-1' }], rowCount: 1 }); // INSERT
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const { runDailySummarization } = require('../memory-summarization-loop');
    const result = await runDailySummarization('tenant-1');

    expect(result.summaries).toBe(1);

    const insertCall = clientQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO memories') && c[0].includes('summary_level'),
    );
    expect(insertCall).toBeDefined();
    // The summarizes array (memberIds) is the 9th param
    const params = insertCall![1] as any[];
    const memberIds = params[params.length - 1];
    expect(memberIds).toHaveLength(5);
  });
});
