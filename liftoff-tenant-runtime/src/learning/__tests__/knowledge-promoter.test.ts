// Knowledge Promoter Tests

const mockQuery = jest.fn();
const mockClientQuery = jest.fn().mockResolvedValue({ rows: [] });
const mockClient = { query: mockClientQuery, release: jest.fn() };

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));

jest.mock('../../memory/service', () => ({
  memoryService: {
    saveMemory: jest.fn().mockResolvedValue({ memoryId: 'promoted-mem-1', deduplicated: false }),
    retrieveMemories: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../../memory/provenance-service', () => ({
  recordSynthesis: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { promoteSharedKnowledge } from '../knowledge-promoter';
const { memoryService } = require('../../memory/service');
const { recordSynthesis } = require('../../memory/provenance-service');

beforeEach(() => {
  jest.clearAllMocks();
  // jest.clearAllMocks() does NOT clear unconsumed mockResolvedValueOnce queues —
  // those linger across tests and would feed the wrong rows into the next test
  // when a prior test set up more onces than the code ended up consuming
  // (e.g. the budget-exhausted cross-agent test sets 4 onces but consumes 3).
  // Reset the per-test query mocks and re-establish the empty-rows default that
  // the high-usage SELECT (added in Phase 1A) relies on for legacy tests.
  mockQuery.mockReset();
  mockClientQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockClientQuery.mockResolvedValue({ rows: [] });
  // Re-establish service-level mock defaults wiped by clearAllMocks side-effects.
  (memoryService.saveMemory as jest.Mock).mockResolvedValue({ memoryId: 'promoted-mem-1', deduplicated: false });
  (memoryService.retrieveMemories as jest.Mock).mockResolvedValue([]);
  (recordSynthesis as jest.Mock).mockResolvedValue(undefined);
});

describe('promoteSharedKnowledge', () => {
  it('promotes memory shared by 3+ agents to global', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm1', content: 'Always CC compliance', scope_key: 'sk1',
        agent_id: 'a1', tags: ['auto-extracted'], embedding: [0.1, 0.2],
      }],
    });
    // HNSW query returns id + agent_id (updated mock)
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: 'corr-m2', agent_id: 'a2' },
      { id: 'corr-m3', agent_id: 'a3' },
      { id: 'corr-m4', agent_id: 'a4' },
    ] });

    const result = await promoteSharedKnowledge('tenant-1');

    expect(result).toBe(1);
    expect(memoryService.saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'global',
        scopeKey: 'promoted-sk1',
        tags: expect.arrayContaining(['auto-promoted']),
        tx: mockClient,
      })
    );
  });

  it('calls recordSynthesis with primary + all corroborating memory IDs', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm1', content: 'Always CC compliance', scope_key: 'sk1',
        agent_id: 'a1', tags: [], embedding: [0.1, 0.2],
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: 'corr-m2', agent_id: 'a2' },
      { id: 'corr-m3', agent_id: 'a3' },
    ] });

    await promoteSharedKnowledge('tenant-1');

    expect(recordSynthesis).toHaveBeenCalledTimes(1);
    expect(recordSynthesis).toHaveBeenCalledWith(
      mockClient,
      'tenant-1',
      ['m1', 'corr-m2', 'corr-m3'],
      'promoted-mem-1',
    );
  });

  it('wraps saveMemory and recordSynthesis in a transaction (BEGIN/COMMIT)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'm1', content: 'Lesson', scope_key: 'sk1', agent_id: 'a1', tags: [], embedding: [0.1] }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'corr-m2', agent_id: 'a2' }, { id: 'corr-m3', agent_id: 'a3' }] });

    await promoteSharedKnowledge('tenant-1');

    const clientCalls = mockClientQuery.mock.calls.map((c: any[]) => c[0] as string);
    expect(clientCalls[0]).toBe('BEGIN');
    expect(clientCalls[clientCalls.length - 1]).toBe('COMMIT');
  });

  it('rolls back transaction if recordSynthesis throws (non-fatal — resolves to 0)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'm1', content: 'Lesson', scope_key: 'sk1', agent_id: 'a1', tags: [], embedding: [0.1] }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'corr-m2', agent_id: 'a2' }, { id: 'corr-m3', agent_id: 'a3' }] });

    recordSynthesis.mockRejectedValueOnce(new Error('provenance DB error'));

    // Promotion failures are non-fatal — the outer catch swallows the error
    // and the function resolves with the count of successfully promoted memories (0 here).
    const result = await promoteSharedKnowledge('tenant-1');
    expect(result).toBe(0);

    const clientCalls = mockClientQuery.mock.calls.map((c: any[]) => c[0] as string);
    expect(clientCalls).toContain('ROLLBACK');
    expect(clientCalls).not.toContain('COMMIT');
  });

  it('does NOT promote when fewer than 3 agents share', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm1', content: 'Only 2 agents', scope_key: 'sk1',
        agent_id: 'a1', tags: [], embedding: [0.1],
      }],
    });
    // Only 1 other agent
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'corr-m2', agent_id: 'a2' }] });

    const result = await promoteSharedKnowledge('tenant-1');
    expect(result).toBe(0);
    expect(memoryService.saveMemory).not.toHaveBeenCalled();
    expect(recordSynthesis).not.toHaveBeenCalled();
  });

  it('skips already-promoted memories', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm1', content: 'Already global', scope_key: 'sk1',
        agent_id: 'a1', tags: [], embedding: [0.1],
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'corr-m2', agent_id: 'a2' }, { id: 'corr-m3', agent_id: 'a3' }] });
    (memoryService.retrieveMemories as jest.Mock).mockResolvedValueOnce([{ id: 'existing' }]);

    const result = await promoteSharedKnowledge('tenant-1');
    expect(result).toBe(0);
    expect(recordSynthesis).not.toHaveBeenCalled();
  });

  it('does not promote PII-classified memories (P5)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await promoteSharedKnowledge('tenant-1');
    expect(result).toBe(0);
    expect(memoryService.saveMemory).not.toHaveBeenCalled();
    expect(recordSynthesis).not.toHaveBeenCalled();
  });

  describe('daily rate limit (5/tenant/day)', () => {
    it('stops promoting when daily cap is reached', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '5' }] });

      const result = await promoteSharedKnowledge('tenant-1');
      expect(result).toBe(0);
      expect(memoryService.saveMemory).not.toHaveBeenCalled();
      expect(recordSynthesis).not.toHaveBeenCalled();
    });

    it('allows promotions when under daily cap', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '3' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'm1', content: 'Shared lesson', scope_key: 'sk1',
          agent_id: 'a1', tags: [], embedding: [0.1],
        }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'corr-m2', agent_id: 'a2' }, { id: 'corr-m3', agent_id: 'a3' }] });

      const result = await promoteSharedKnowledge('tenant-1');
      expect(result).toBe(1);
      expect(recordSynthesis).toHaveBeenCalledTimes(1);
    });

    it('stops after reaching remaining budget within a run', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '4' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'm1', content: 'Lesson 1', scope_key: 'sk1', agent_id: 'a1', tags: [], embedding: [0.1] },
          { id: 'm2', content: 'Lesson 2', scope_key: 'sk2', agent_id: 'a1', tags: [], embedding: [0.2] },
        ],
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'corr-m2', agent_id: 'a2' }, { id: 'corr-m3', agent_id: 'a3' }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'corr-m4', agent_id: 'a2' }, { id: 'corr-m5', agent_id: 'a3' }] });

      const result = await promoteSharedKnowledge('tenant-1');
      expect(result).toBe(1);
      expect(recordSynthesis).toHaveBeenCalledTimes(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1A: high-usage single-agent promotion path
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1A: high-usage single-agent promotion', () => {
  beforeEach(() => jest.clearAllMocks());

  it('promotes a memory when usage_count >= 10 even without cross-agent corroboration', async () => {
    // 1) recent-promotions count
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    // 2) individual memories (cross-agent path) — empty so we don't enter that loop
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 3) high-usage SELECT — one row with usage_count 12
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'high-usage-mem-1',
        content: 'Customer X always wants weekly reports on Mondays',
        scope_key: 'preference-customer-x',
        agent_id: 'agent-1',
        tags: ['auto-extracted', 'type:preference'],
        usage_count: 12,
      }],
    });

    (memoryService.retrieveMemories as jest.Mock).mockResolvedValueOnce([]); // no existing global

    const result = await promoteSharedKnowledge('tenant-hu');
    expect(result).toBe(1);
    expect(memoryService.saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      layer: 'global',
      scopeKey: 'promoted-usage-preference-customer-x',
      tags: expect.arrayContaining(['auto-promoted', 'high-usage']),
      source: expect.objectContaining({
        nodeType: 'memory',
        metadata: expect.objectContaining({
          promotionReason: 'high-usage-single-agent',
          usageCount: 12,
        }),
      }),
    }));
    expect(recordSynthesis).toHaveBeenCalledWith(expect.anything(), 'tenant-hu', ['high-usage-mem-1'], expect.any(String));
  });

  it('high-usage path respects the 5/day rate limit shared with cross-agent path', async () => {
    // Already 5 promotions today → daily cap reached, even high-usage path skipped
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '5' }] });
    const result = await promoteSharedKnowledge('tenant-hu');
    expect(result).toBe(0);
    expect(memoryService.saveMemory).not.toHaveBeenCalled();
  });

  it('skips high-usage path when remaining budget is consumed by cross-agent path', async () => {
    // recent=4 → remaining=1
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '4' }] });
    // cross-agent finds 1 promotable row
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'cross-mem-1', content: 'Cross fact', scope_key: 'cf1',
        agent_id: 'a1', tags: [], embedding: [0.1],
      }],
    });
    // its 3 corroborators
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'c2', agent_id: 'a2' }, { id: 'c3', agent_id: 'a3' }, { id: 'c4', agent_id: 'a4' }],
    });

    const result = await promoteSharedKnowledge('tenant-hu');
    expect(result).toBe(1);
    // High-usage SELECT must NOT have been issued (remainingBudgetAfterCrossAgent = 0)
    const hadHighUsageSelect = mockQuery.mock.calls.some(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('usage_count >= $2'),
    );
    expect(hadHighUsageSelect).toBe(false);
  });

  it('high-usage path SQL excludes PII/sensitive memories and graduated-already rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] }); // recent
    mockQuery.mockResolvedValueOnce({ rows: [] });             // cross-agent empty
    mockQuery.mockResolvedValueOnce({ rows: [] });             // high-usage empty

    await promoteSharedKnowledge('tenant-hu');

    const highUsageCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('usage_count >= $2'),
    );
    expect(highUsageCall).toBeDefined();
    const sql = highUsageCall![0] as string;
    expect(sql).toMatch(/content_classification NOT IN \('pii', 'sensitive'\)/);
    expect(sql).toMatch(/graduated_at IS NULL/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1A: graduated_at set after promotion (both paths)
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1A: graduated_at set after promotion', () => {
  beforeEach(() => jest.clearAllMocks());

  it('cross-agent path sets graduated_at on the source memory', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'src-1', content: 'fact', scope_key: 'sk', agent_id: 'a1', tags: [], embedding: [0.1] }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'c2', agent_id: 'a2' }, { id: 'c3', agent_id: 'a3' }, { id: 'c4', agent_id: 'a4' }],
    });

    await promoteSharedKnowledge('tenant-graduated');

    // The graduated_at UPDATE runs against the connected client, not the pool
    const graduatedUpdate = mockClientQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('SET graduated_at = NOW()'),
    );
    expect(graduatedUpdate).toBeDefined();
    expect(graduatedUpdate![1]).toEqual(['src-1', 'tenant-graduated']);
  });
});
