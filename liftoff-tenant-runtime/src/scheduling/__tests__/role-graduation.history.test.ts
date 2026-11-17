// Change A A.8: role-graduation writes both learned_role_instructions and _history.

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
    complete: jest.fn().mockResolvedValue({ content: '## Learned pitfalls\n- Always check connector permissions before retry.' }),
  },
}));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({
    getModelForTask: jest.fn().mockResolvedValue({ model: 'claude-haiku-4-5', provider: 'anthropic' }),
  }),
  isExecutionAllowed: jest.fn().mockResolvedValue(true),
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
  recordAmendment: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../memory/content-sanitizer', () => ({
  sanitizeMemoryContent: (s: string) => ({ sanitized: s }),
}));

describe('role-graduation history', () => {
  it('writes BOTH learned_role_instructions AND _history within a transaction', async () => {
    const db = require('../../infrastructure/database');
    const query = db.__query as jest.Mock;
    const clientQuery = db.__clientQuery as jest.Mock;
    query.mockReset();
    clientQuery.mockReset();

    // 1. Advisory lock acquired
    query.mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 });
    // 2. Rollup + recompute path (will fail gracefully via mocks since influence-calculator is invoked); guard
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    // BEGIN
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT audit
    clientQuery.mockResolvedValueOnce({ rows: [{ id: 'audit-1' }], rowCount: 1 });
    // INSERT learned_role_instructions
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // INSERT learned_role_instructions_history
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // UPDATE memories graduated_at
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // COMMIT
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // Spy on roleResult mock — we need to inject memories into the SELECT
    // that runRoleGraduationStep performs. Since our mock returns empty by
    // default, we hand-shape the call sequence:
    //   - graduation lag SELECT (single row)
    //   - role memories SELECT (returns 1 row)
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 });  // pg_try_advisory_lock
    // rollupYesterday
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // recompute guard
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // runConsolidationStep — no auto-reflection memories
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // runGraduationStep — individualResult
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // runGraduationStep — globalResult
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // runRoleGraduationStep — graduation_lag_seconds SELECT
    query.mockResolvedValueOnce({ rows: [{ max_age: 7 * 86400 }], rowCount: 1 });
    // runRoleGraduationStep — role memories SELECT
    query.mockResolvedValueOnce({
      rows: [
        { id: 'mem-1', content: 'Always call connector_refresh before fetch.', usefulness_score: 7, importance_score: 4, created_at: new Date(), scope_key: 'sales_agent', source_trust: '0.6' },
      ],
      rowCount: 1,
    });
    // pg_advisory_unlock
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { runConsolidationForAgent } = require('../memory-consolidation-loop');
    await runConsolidationForAgent('tenant-1', 'agent-1');

    const lriInsert = clientQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO learned_role_instructions') && !c[0].includes('_history'),
    );
    const historyInsert = clientQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO learned_role_instructions_history'),
    );
    expect(lriInsert).toBeDefined();
    expect(historyInsert).toBeDefined();
  });
});
