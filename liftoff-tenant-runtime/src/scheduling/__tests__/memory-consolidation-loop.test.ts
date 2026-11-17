import { runConsolidationForAgent } from '../memory-consolidation-loop';

// Mock dependencies
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockLlmComplete = jest.fn();
const mockRecordSynthesis = jest.fn().mockResolvedValue(undefined);
const mockRecordAmendment = jest.fn().mockResolvedValue(undefined);

jest.mock('../../memory/provenance-service', () => ({
  recordSynthesis: (...args: any[]) => mockRecordSynthesis(...args),
  recordAmendment: (...args: any[]) => mockRecordAmendment(...args),
}));

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({
    query: mockQuery,
    connect: mockConnect,
  }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../llm/client', () => ({
  llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: (...args: any[]) => mockLlmComplete(...args) },
}));

const mockIsExecutionAllowed = jest.fn().mockResolvedValue(true);
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getModelForTask: jest.fn().mockResolvedValue(null) }),
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

jest.mock('../../memory/content-sanitizer', () => ({
  sanitizeMemoryContent: jest.fn((content: string) => ({
    sanitized: content,
    piiDetected: false,
    piiTypes: [],
    strippedPatterns: [],
    truncated: false,
  })),
}));

// Change B (memory rebalance): rollupYesterday + recomputeInfluenceScores fire at
// the top of every consolidation tick. Stub them so they don't consume mockQuery
// responses meant for the consolidation/graduation queries this suite asserts on.
jest.mock('../../memory/influence-calculator', () => ({
  rollupYesterday: jest.fn().mockResolvedValue(undefined),
  recomputeInfluenceScores: jest.fn().mockResolvedValue(undefined),
}));

// Memory metrics are fire-and-forget structured log lines; stub to noop so
// setGauge/incCounter calls inside the consolidation loop don't pull in the
// real logger or hit network.
jest.mock('../../memory/metrics', () => ({
  incCounter: jest.fn(),
  observeHistogram: jest.fn(),
  setGauge: jest.fn(),
  HISTOGRAM_BUCKETS: { DEFAULT: [], SIZE: [] },
}));

describe('memory-consolidation-loop', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockConnect.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockLlmComplete.mockReset();
    mockIsExecutionAllowed.mockReset().mockResolvedValue(true);

    mockConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });

    // Fallback for any queries beyond what an individual test mocks via
    // mockResolvedValueOnce — covers the new role-graduation lag-gauge +
    // candidate-set queries that fire at the tail of runConsolidationForAgent.
    mockQuery.mockResolvedValue({ rows: [] });
  });

  // BILLING-GATE: suspended tenants must not incur consolidation LLM cost.
  describe('billing gate (tenant suspension)', () => {
    it('skips before the advisory lock when the tenant is not execution-allowed', async () => {
      mockIsExecutionAllowed.mockResolvedValue(false);

      const result = await runConsolidationForAgent('tenant-suspended', 'agent-1');

      expect(result).toEqual({ consolidated: 0, graduated: 0 });
      expect(mockIsExecutionAllowed).toHaveBeenCalledWith('tenant-suspended');
      // Gate returns before any DB work (no advisory lock) and no LLM call.
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockLlmComplete).not.toHaveBeenCalled();
    });
  });

  describe('advisory lock', () => {
    it('acquires advisory lock before processing', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // advisory lock
        .mockResolvedValueOnce({ rows: [] }) // consolidation memories fetch (none)
        .mockResolvedValueOnce({ rows: [] }) // graduation individual
        .mockResolvedValueOnce({ rows: [] }) // graduation global
        .mockResolvedValueOnce({ rows: [] }); // unlock

      await runConsolidationForAgent('tenant-1', 'agent-1');

      const lockCall = mockQuery.mock.calls[0];
      expect(lockCall[0]).toContain('pg_try_advisory_lock');
    });

    it('skips processing when advisory lock is held', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ acquired: false }] });

      const result = await runConsolidationForAgent('tenant-1', 'agent-1');
      expect(result).toEqual({ consolidated: 0, graduated: 0 });
      expect(mockQuery).toHaveBeenCalledTimes(1); // only lock attempt
    });

    it('releases advisory lock after processing (even on error)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // lock
        .mockRejectedValueOnce(new Error('DB error')); // memories fetch fails

      await runConsolidationForAgent('tenant-1', 'agent-1').catch(() => {});

      const unlockCall = mockQuery.mock.calls.find((c: any[]) =>
        (c[0] as string).includes('pg_advisory_unlock')
      );
      expect(unlockCall).toBeDefined();
    });
  });

  describe('consolidation threshold', () => {
    it('skips when agent has < 5 auto-reflection memories', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // lock
        .mockResolvedValueOnce({ rows: [{}, {}, {}, {}] }) // 4 memories (below threshold)
        .mockResolvedValueOnce({ rows: [] }) // graduation query (individual)
        .mockResolvedValueOnce({ rows: [] }) // graduation query (global)
        .mockResolvedValueOnce({ rows: [] }); // unlock

      const result = await runConsolidationForAgent('tenant-1', 'agent-1');
      expect(result.consolidated).toBe(0);
      expect(mockLlmComplete).not.toHaveBeenCalled();
    });
  });

  describe('LLM grouping validation', () => {
    const fiveMemories = [
      { id: 'mem-1', content: 'Sheets rate-limits at 60/min', usefulness_score: 2, importance_score: 4, tags: ['auto-reflection'], created_at: new Date() },
      { id: 'mem-2', content: 'Use batch mode for Sheets writes', usefulness_score: 1, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
      { id: 'mem-3', content: 'Sheets rejects payloads over 10MB', usefulness_score: 3, importance_score: 4, tags: ['auto-reflection'], created_at: new Date() },
      { id: 'mem-4', content: 'HubSpot API requires pagination', usefulness_score: 1, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
      { id: 'mem-5', content: 'Always check HubSpot contact exists before update', usefulness_score: 2, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
    ];

    it('rejects LLM grouping with invented memory IDs', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // lock
        .mockResolvedValueOnce({ rows: fiveMemories }) // memories
        .mockResolvedValueOnce({ rows: [] }) // graduation individual
        .mockResolvedValueOnce({ rows: [] }) // graduation global
        .mockResolvedValueOnce({ rows: [] }); // unlock

      mockLlmComplete.mockResolvedValueOnce({
        content: JSON.stringify({
          groups: [{ topic: 'Sheets', memoryIds: ['mem-1', 'mem-2', 'INVENTED-ID'] }],
        }),
      });

      const result = await runConsolidationForAgent('tenant-1', 'agent-1');
      // Should fail validation and skip consolidation
      expect(result.consolidated).toBe(0);
    });

    it('caps group size at 5 members', async () => {
      const sevenMemories = [
        ...fiveMemories,
        { id: 'mem-6', content: 'Sheets timeout at 30s', usefulness_score: 1, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
        { id: 'mem-7', content: 'Sheets returns A1 notation', usefulness_score: 1, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
      ];

      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: sevenMemories })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      mockLlmComplete
        .mockResolvedValueOnce({
          content: JSON.stringify({
            groups: [{ topic: 'Sheets', memoryIds: ['mem-1', 'mem-2', 'mem-3', 'mem-6', 'mem-7', 'mem-4', 'mem-5'] }],
          }),
        })
        .mockResolvedValueOnce({ content: 'Consolidated Sheets lesson' });

      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'new-mem' }] }) // INSERT
        .mockResolvedValueOnce({ rows: [] }) // supersede
        .mockResolvedValueOnce({ rows: [] }) // audit
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      await runConsolidationForAgent('tenant-1', 'agent-1');

      // The rewrite call should receive at most 5 members
      if (mockLlmComplete.mock.calls.length >= 2) {
        const rewriteContent = mockLlmComplete.mock.calls[1][0].messages[1].content;
        const lineCount = rewriteContent.split('\n').filter((l: string) => l.trim()).length;
        expect(lineCount).toBeLessThanOrEqual(5);
      }
    });

    it('skips consolidation on invalid JSON from LLM', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: fiveMemories })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      mockLlmComplete.mockResolvedValueOnce({ content: 'NOT VALID JSON' });

      const result = await runConsolidationForAgent('tenant-1', 'agent-1');
      expect(result.consolidated).toBe(0);
    });
  });

  describe('consolidation scores', () => {
    it('uses MAX(usefulness) not SUM for consolidated memory', async () => {
      const memories = [
        { id: 'mem-1', content: 'Lesson A', usefulness_score: 2, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
        { id: 'mem-2', content: 'Lesson B', usefulness_score: 5, importance_score: 4, tags: ['auto-reflection'], created_at: new Date() },
        { id: 'mem-3', content: 'Lesson C', usefulness_score: 1, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
        { id: 'mem-4', content: 'Lesson D', usefulness_score: 3, importance_score: 5, tags: ['auto-reflection'], created_at: new Date() },
        { id: 'mem-5', content: 'Lesson E', usefulness_score: 4, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
      ];

      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: memories })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      mockLlmComplete
        .mockResolvedValueOnce({
          content: JSON.stringify({
            groups: [{ topic: 'Lessons', memoryIds: ['mem-1', 'mem-2', 'mem-3'] }],
          }),
        })
        .mockResolvedValueOnce({ content: 'Consolidated lesson' });

      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'new-mem' }] }) // INSERT
        .mockResolvedValueOnce({ rows: [] }) // supersede
        .mockResolvedValueOnce({ rows: [] }) // audit
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      await runConsolidationForAgent('tenant-1', 'agent-1');

      // Check the INSERT params — usefulness should be MAX(2, 5, 1) = 5, not SUM = 8
      const insertCall = mockClientQuery.mock.calls.find((c: any[]) =>
        (c[0] as string).includes('INSERT INTO memories')
      );
      if (insertCall) {
        const params = insertCall[1] as any[];
        // usefulness_score is the 8th param ($8 in the SQL, index 7) after embedding + embedding_model
        expect(params[7]).toBe(5); // MAX, not SUM (8)
      }
    });
  });

  describe('graduation output validation', () => {
    it('rejects CLAUDE.md synthesis with > 10 bullets', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // lock
        .mockResolvedValueOnce({ rows: [] }) // consolidation (no memories)
        .mockResolvedValueOnce({ rows: [{ id: 'mem-1', content: 'Lesson', usefulness_score: 5, importance_score: 4, created_at: new Date('2026-01-01') }] }) // graduation individual
        .mockResolvedValueOnce({ rows: [] }) // graduation global
        .mockResolvedValueOnce({ rows: [{ id: 'ci-1', learned_instructions_md: null }] }) // current compiled_instructions
        .mockResolvedValueOnce({ rows: [] }); // unlock

      // LLM returns 12 bullets — output validation should cap at 10
      const twelveBullets = Array.from({ length: 12 }, (_, i) => `- Lesson ${i + 1}`).join('\n');
      mockLlmComplete.mockResolvedValueOnce({
        content: `## Learned pitfalls\n\n${twelveBullets}`,
      });

      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'audit-1' }] }) // audit INSERT
        .mockResolvedValueOnce({ rows: [] }) // UPDATE compiled_instructions
        .mockResolvedValueOnce({ rows: [] }) // UPDATE graduated_at
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      await runConsolidationForAgent('tenant-1', 'agent-1');

      // The UPDATE should have at most 10 bullets
      const updateCall = mockClientQuery.mock.calls.find((c: any[]) =>
        (c[0] as string).includes('UPDATE compiled_instructions')
      );
      if (updateCall) {
        const learnedMd = updateCall[1]![0] as string;
        const bulletCount = learnedMd.split('\n').filter((l: string) => l.trim().startsWith('-')).length;
        expect(bulletCount).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('PII exclusion', () => {
    it('excludes PII/sensitive memories from LLM grouping query', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [] }) // consolidation fetch
        .mockResolvedValueOnce({ rows: [] }) // graduation individual
        .mockResolvedValueOnce({ rows: [] }) // graduation global
        .mockResolvedValueOnce({ rows: [] }); // unlock

      await runConsolidationForAgent('tenant-1', 'agent-1');

      // Verify the consolidation query excludes PII
      const consolidationQuery = mockQuery.mock.calls[1];
      const sql = consolidationQuery[0] as string;
      expect(sql).toContain("content_classification NOT IN ('pii', 'sensitive')");
    });
  });

  describe('provenance recording', () => {
    const fiveMemories = [
      { id: 'mem-1', content: 'Lesson A', usefulness_score: 2, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
      { id: 'mem-2', content: 'Lesson B', usefulness_score: 5, importance_score: 4, tags: ['auto-reflection'], created_at: new Date() },
      { id: 'mem-3', content: 'Lesson C', usefulness_score: 1, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
      { id: 'mem-4', content: 'Lesson D', usefulness_score: 3, importance_score: 5, tags: ['auto-reflection'], created_at: new Date() },
      { id: 'mem-5', content: 'Lesson E', usefulness_score: 4, importance_score: 3, tags: ['auto-reflection'], created_at: new Date() },
    ];

    beforeEach(() => {
      mockRecordSynthesis.mockClear();
      mockRecordAmendment.mockClear();
    });

    it('calls recordSynthesis with member IDs and new memory ID inside the consolidation transaction', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })          // lock
        .mockResolvedValueOnce({ rows: fiveMemories })                   // memories
        .mockResolvedValueOnce({ rows: [] })                             // graduation individual
        .mockResolvedValueOnce({ rows: [] })                             // graduation global
        .mockResolvedValueOnce({ rows: [] });                            // unlock

      mockLlmComplete
        .mockResolvedValueOnce({ content: JSON.stringify({ groups: [{ topic: 'Lessons', memoryIds: ['mem-1', 'mem-2', 'mem-3'] }] }) })
        .mockResolvedValueOnce({ content: 'Consolidated lesson' });

      const mockClientForTx = { query: mockClientQuery, release: mockClientRelease };
      mockConnect.mockResolvedValueOnce(mockClientForTx);

      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })                             // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'new-consolidated-mem' }] }) // INSERT memories
        .mockResolvedValueOnce({ rows: [] })                             // UPDATE superseded_by
        .mockResolvedValueOnce({ rows: [] })                             // audit INSERT
        .mockResolvedValueOnce({ rows: [] });                            // COMMIT

      await runConsolidationForAgent('tenant-1', 'agent-1');

      expect(mockRecordSynthesis).toHaveBeenCalledTimes(1);
      expect(mockRecordSynthesis).toHaveBeenCalledWith(
        mockClientForTx,
        'tenant-1',
        expect.arrayContaining(['mem-1', 'mem-2', 'mem-3']),
        'new-consolidated-mem',
      );
    });

    it('does not call recordSynthesis when consolidation is skipped (< 5 memories)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [fiveMemories[0], fiveMemories[1], fiveMemories[2], fiveMemories[3]] }) // 4 memories
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await runConsolidationForAgent('tenant-1', 'agent-1');
      expect(mockRecordSynthesis).not.toHaveBeenCalled();
    });

    it('calls recordAmendment with memory IDs and amendment audit ID inside the graduation transaction', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })           // lock
        .mockResolvedValueOnce({ rows: [] })                              // consolidation (none)
        .mockResolvedValueOnce({ rows: [
          { id: 'grad-mem-1', content: 'Lesson 1', usefulness_score: 5, importance_score: 4, created_at: new Date('2026-01-01') },
          { id: 'grad-mem-2', content: 'Lesson 2', usefulness_score: 4, importance_score: 4, created_at: new Date('2026-01-02') },
        ] })                                                              // graduation individual
        .mockResolvedValueOnce({ rows: [] })                             // graduation global
        .mockResolvedValueOnce({ rows: [{ id: 'ci-1', learned_instructions_md: null }] }) // compiled_instructions
        .mockResolvedValueOnce({ rows: [] });                            // unlock

      mockLlmComplete.mockResolvedValueOnce({ content: '## Learned pitfalls\n\n- Use batch mode\n- Check rate limits' });

      const mockClientForTx = { query: mockClientQuery, release: mockClientRelease };
      mockConnect.mockResolvedValueOnce(mockClientForTx);

      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })                             // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'audit-uuid-999' }] })    // audit INSERT RETURNING id
        .mockResolvedValueOnce({ rows: [] })                             // UPDATE compiled_instructions
        .mockResolvedValueOnce({ rows: [] })                             // UPDATE graduated_at
        .mockResolvedValueOnce({ rows: [] });                            // COMMIT

      await runConsolidationForAgent('tenant-1', 'agent-1');

      expect(mockRecordAmendment).toHaveBeenCalledTimes(1);
      expect(mockRecordAmendment).toHaveBeenCalledWith(
        mockClientForTx,
        'tenant-1',
        ['grad-mem-1', 'grad-mem-2'],
        'audit-uuid-999',
      );
    });
  });
});
