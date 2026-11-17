// The near-duplicate guard on memory_save stops a MODEL that keeps re-saving
// the same escalation context inside a run. A declared graph step is not that:
// it runs once per run and cannot loop, and a scheduled graph's per-run note
// is near-identical to the previous run's by construction while being this
// run's record. Refusing it failed the step, and a failed step escalated the
// run — on every run after the first.

const mockSaveMemory = jest.fn();
const mockFindRecentSimilarMemories = jest.fn();
jest.mock('../../memory/service', () => ({
  memoryService: {
    saveMemory: (...args: unknown[]) => mockSaveMemory(...args),
    // The handler reads the dedup hits and the admission check's neighbours
    // from one query; the mock answers the hits and no neighbours.
    findRecentSimilarMemoriesWithNeighbours: async (...args: unknown[]) => ({ similar: await mockFindRecentSimilarMemories(...args), neighbours: [] }),
    retrieveMemories: jest.fn().mockResolvedValue([]),
    resolveRoleScopeKey: jest.fn().mockResolvedValue('role-1'),
  },
}));
const logged: Array<Record<string, unknown>> = [];
jest.mock('../../infrastructure/logging', () => ({
  logger: {
    info: (p: Record<string, unknown>) => { logged.push(p); },
    warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));
jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage: jest.fn().mockResolvedValue(undefined) },
}));
// The admission check is not this test's subject: today's save.
jest.mock('../../memory/memory-admit', () => ({ admitMemory: jest.fn().mockResolvedValue(null) }));

import { executeStandardTool, type StandardToolContext } from '../standard-tool-handler';

const base: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: { writableLayers: ['individual'], readableLayers: ['individual'], scopeKeys: ['sk-1'] },
  traceId: 'trace-1',
};

const weeklyNote = {
  content: 'Shopify competitive brief sent. Positioning status: sourced. Competitors status: sourced. News status: sourced.',
  layer: 'individual',
  tags: ['shopify-brief', 'weekly'],
};

beforeEach(() => {
  jest.clearAllMocks();
  logged.length = 0;
  mockSaveMemory.mockResolvedValue({ memoryId: 'mem-new', deduplicated: false });
});

describe('memory_save near-duplicate guard', () => {
  it('refuses a call the model chose when it is near-identical to a recent save', async () => {
    mockFindRecentSimilarMemories.mockResolvedValue([{ id: 'mem-last-week', cosine: 0.97, createdAt: new Date() }]);
    const res = await executeStandardTool('memory_save', weeklyNote, base);
    expect(res?.success).toBe(false);
    expect(res?.error).toMatch(/near-identical/);
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(logged.some((l) => l.event === 'memory_save_near_dedup_rejected')).toBe(true);
  });

  it('does not apply to a declared graph step: the lookback is not consulted and the save proceeds', async () => {
    mockFindRecentSimilarMemories.mockResolvedValue([{ id: 'mem-last-week', cosine: 0.97, createdAt: new Date() }]);
    const res = await executeStandardTool('memory_save', weeklyNote, { ...base, declaredStepId: 's8' });
    expect(res?.success).toBe(true);
    expect(mockFindRecentSimilarMemories).not.toHaveBeenCalled();
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    expect(logged.some((l) => l.event === 'memory_save_near_dedup_not_applied' && l.declared_step_id === 's8')).toBe(true);
  });

  it('still saves a call the model chose when nothing recent is similar', async () => {
    mockFindRecentSimilarMemories.mockResolvedValue([]);
    const res = await executeStandardTool('memory_save', weeklyNote, base);
    expect(res?.success).toBe(true);
    expect(mockFindRecentSimilarMemories).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
  });
});
