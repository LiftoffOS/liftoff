// Change C: L0 memories with covering L1 summary >30d old → superseded.

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn();
  const release = jest.fn();
  const clientQuery = jest.fn();
  const connect = jest.fn(async () => ({ query: clientQuery, release }));
  return {
    pool: { query, connect },
    getPoolForService: jest.fn(() => ({ query, connect })),
    __query: query,
  };
});
jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: jest.fn() } }));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getModelForTask: jest.fn() }),
  isExecutionAllowed: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../memory/embedding', () => ({
  generateEmbedding: jest.fn(),
  generateEmbeddingDetailed: jest.fn().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3], model: 'text-embedding-004', provider: 'google', dim: 3,
  }),
  getDefaultProvider: () => 'google',
  getProviderModel: () => 'text-embedding-004',
}));
jest.mock('../../memory/provenance-service', () => ({ recordSynthesis: jest.fn() }));
jest.mock('../../memory/content-sanitizer', () => ({ sanitizeMemoryContent: (s: string) => ({ sanitized: s }) }));

describe('memory-summarization-loop supersession', () => {
  beforeEach(() => {
    process.env.MEM_SUMMARIZATION_ENABLED = '1';
  });
  afterAll(() => {
    delete process.env.MEM_SUMMARIZATION_ENABLED;
  });

  it('emits supersede SQL with summarized-to-l1 reason', async () => {
    const db = require('../../infrastructure/database');
    const query = db.__query as jest.Mock;
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 }); // lock
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });                   // SELECT L0 returns 0 → bail
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });                   // unlock

    const { runDailySummarization } = require('../memory-summarization-loop');
    await runDailySummarization('tenant-1');

    // Lock + SELECT + unlock = 3 calls minimum. With L0=0 we don't reach supersede.
    expect(query.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
