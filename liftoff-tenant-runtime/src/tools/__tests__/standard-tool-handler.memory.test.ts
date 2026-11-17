// Tests for memory_save tag behavior and usage tracking in standard-tool-handler.ts

const mockSaveMemory = jest.fn().mockResolvedValue({ memoryId: 'memory-id-1', deduplicated: false });
const mockRetrieveMemories = jest.fn().mockResolvedValue([]);
const mockResolveRoleScopeKey = jest.fn().mockResolvedValue('competitive-intelligence-analyst');
jest.mock('../../memory/service', () => ({
  memoryService: {
    saveMemory: (...args: unknown[]) => mockSaveMemory(...args),
    retrieveMemories: (...args: unknown[]) => mockRetrieveMemories(...args),
    resolveRoleScopeKey: (...args: unknown[]) => mockResolveRoleScopeKey(...args),
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockRecordUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage: (...args: unknown[]) => mockRecordUsage(...args) },
}));

// memory_save / research_save_finding now run a DLP credential scan before
// writing. Stub the DLP path so unit tests that don't supply credentials in
// their fixtures aren't blocked by a real (or absent) DLP client.
import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: {
    writableLayers: ['individual', 'role', 'global'],
    readableLayers: ['individual', 'role', 'global'],
    scopeKeys: ['sk-1'],
  },
  traceId: 'trace-1',
};

beforeEach(() => jest.clearAllMocks());

describe('memory_save tags', () => {
  it('always includes agent-initiated tag', async () => {
    const result = await executeStandardTool(
      'memory_save',
      { content: 'BTC price is $100k', layer: 'individual' },
      ctx,
    );

    expect(result?.success).toBe(true);
    expect(mockSaveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['agent-initiated'],
      }),
    );
  });

  it('merges agent-provided tags with base tag', async () => {
    await executeStandardTool(
      'memory_save',
      { content: 'Sheets rate limit', layer: 'individual', tags: ['connector:google-sheets', 'error:rate-limit'] },
      ctx,
    );

    const savedTags = mockSaveMemory.mock.calls[0][0].tags;
    expect(savedTags).toEqual(['agent-initiated', 'connector:google-sheets', 'error:rate-limit']);
  });

  it('filters out invalid tags (non-string, empty, too long)', async () => {
    await executeStandardTool(
      'memory_save',
      { content: 'Test', layer: 'individual', tags: ['valid', '', 123, 'a'.repeat(101), null, 'also-valid'] as any },
      ctx,
    );

    const savedTags = mockSaveMemory.mock.calls[0][0].tags;
    expect(savedTags).toEqual(['agent-initiated', 'valid', 'also-valid']);
  });

  it('handles tags as non-array gracefully', async () => {
    await executeStandardTool(
      'memory_save',
      { content: 'Test', layer: 'individual', tags: 'not-an-array' as any },
      ctx,
    );

    const savedTags = mockSaveMemory.mock.calls[0][0].tags;
    expect(savedTags).toEqual(['agent-initiated']);
  });
});

describe('memory_save usage tracking', () => {
  it('records usage for non-deduped saves', async () => {
    mockSaveMemory.mockResolvedValueOnce({ memoryId: 'mem-1', deduplicated: false });

    await executeStandardTool(
      'memory_save',
      { content: 'Important lesson', layer: 'individual' },
      ctx,
    );

    // Wait for fire-and-forget promise
    await new Promise(r => setTimeout(r, 10));

    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        eventType: 'memory_save',
        credits: 1,
        workflowId: null,
      }),
    );
  });

  it('skips usage tracking for deduped saves (BE-006)', async () => {
    mockSaveMemory.mockResolvedValueOnce({ memoryId: 'existing-mem', deduplicated: true });

    await executeStandardTool(
      'memory_save',
      { content: 'Duplicate content', layer: 'individual' },
      ctx,
    );

    await new Promise(r => setTimeout(r, 10));

    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('does not block on usage tracking failure', async () => {
    mockSaveMemory.mockResolvedValueOnce({ memoryId: 'mem-2', deduplicated: false });
    mockRecordUsage.mockRejectedValueOnce(new Error('Stripe down'));

    const result = await executeStandardTool(
      'memory_save',
      { content: 'Test', layer: 'individual' },
      ctx,
    );

    expect(result?.success).toBe(true);
  });
});

describe('memory_retrieve usage tracking', () => {
  it('records usage after successful retrieve', async () => {
    mockRetrieveMemories.mockResolvedValueOnce([
      { id: 'mem-1', content: 'test', layer: 'individual', scopeKey: 'sk', similarity: 0.8, tags: [], createdAt: new Date() },
    ]);

    await executeStandardTool(
      'memory_retrieve',
      { query: 'Google Sheets rate limits' },
      ctx,
    );

    await new Promise(r => setTimeout(r, 10));

    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        eventType: 'memory_retrieve',
        credits: 1,
      }),
    );
  });
});

describe('memory_save — conversation layer', () => {
  const ctxWithThread: StandardToolContext = {
    ...ctx,
    memoryScope: { writableLayers: ['individual', 'conversation'], readableLayers: ['individual', 'conversation'], scopeKeys: ['sk-1'] },
    threadId: 'thread-abc',
  };

  it('uses threadId as scopeKey when layer is conversation', async () => {
    await executeStandardTool(
      'memory_save',
      { content: 'Customer is on legacy billing plan', layer: 'conversation' },
      ctxWithThread,
    );

    expect(mockSaveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'conversation',
        scopeKey: 'thread-abc',
        threadId: 'thread-abc',
      }),
    );
  });

  it('ignores agent-provided scope_key for conversation layer', async () => {
    await executeStandardTool(
      'memory_save',
      { content: 'Customer is frustrated', layer: 'conversation', scope_key: 'agent-override' },
      ctxWithThread,
    );

    const call = mockSaveMemory.mock.calls[0][0];
    expect(call.scopeKey).toBe('thread-abc');
    expect(call.scopeKey).not.toBe('agent-override');
  });

  it('falls back to individual layer when conversation requested but no threadId in context', async () => {
    const ctxNoThread: StandardToolContext = {
      ...ctx,
      memoryScope: { writableLayers: ['individual', 'conversation'], readableLayers: ['individual', 'conversation'] },
      threadId: undefined,
    };

    const result = await executeStandardTool(
      'memory_save',
      { content: 'Test fact', layer: 'conversation' },
      ctxNoThread,
    );

    expect(result?.success).toBe(true);
    expect(mockSaveMemory).toHaveBeenCalledWith(
      expect.objectContaining({ layer: 'individual' }),
    );
  });

  it('rejects conversation layer write when not in writableLayers', async () => {
    const ctxNoConv: StandardToolContext = {
      ...ctx,
      memoryScope: { writableLayers: ['individual'], readableLayers: ['individual'] },
      threadId: 'thread-xyz',
    };

    const result = await executeStandardTool(
      'memory_save',
      { content: 'Test fact', layer: 'conversation' },
      ctxNoConv,
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/write access/);
  });

  it('conversation is a valid layer (not rejected as unknown)', async () => {
    const result = await executeStandardTool(
      'memory_save',
      { content: 'Test', layer: 'conversation' },
      ctxWithThread,
    );

    expect(result?.success).toBe(true);
    expect(result?.error).toBeUndefined();
  });
});

// The role layer is per (tenant, role): the key IS the role, because that is
// what every reader filters on and what graduation groups by. A row keyed by
// the agent id is one no sibling of the role ever reads back.
describe('memory_save on the role layer', () => {
  const roleCtx: StandardToolContext = {
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    memoryScope: { writableLayers: ['individual', 'role'], readableLayers: ['global', 'role', 'individual'] },
    traceId: 'trace-1',
  };

  it('keys the row by the agent\'s role when no scope_key is given', async () => {
    mockResolveRoleScopeKey.mockResolvedValueOnce('competitive-intelligence-analyst');
    const result = await executeStandardTool('memory_save', { content: 'Zoopla lists fees weekly', layer: 'role' }, roleCtx);
    expect(result.success).toBe(true);
    expect(mockResolveRoleScopeKey).toHaveBeenCalledWith('tenant-1', 'agent-1');
    expect(mockSaveMemory.mock.calls[0][0].scopeKey).toBe('competitive-intelligence-analyst');
    expect(mockSaveMemory.mock.calls[0][0].scopeKey).not.toBe('agent-1');
  });

  it('a caller scope_key becomes a group tag and does not change the role scope', async () => {
    // A model may save its snapshot with scope_key "competitor-snapshot", and
    // a row keyed that way
    // answers to no role — not even its own — and graduation would group it
    // as a role named competitor-snapshot.
    mockResolveRoleScopeKey.mockResolvedValueOnce('competitive-intelligence-analyst');
    const result = await executeStandardTool('memory_save', { content: 'x', layer: 'role', scope_key: 'competitor-snapshot' }, roleCtx);
    expect(result.success).toBe(true);
    expect(mockSaveMemory.mock.calls[0][0].scopeKey).toBe('competitive-intelligence-analyst');
    expect(mockSaveMemory.mock.calls[0][0].tags).toContain('group:competitor-snapshot');
  });

  it('the scope declared on the team wins over the resolved role', async () => {
    const result = await executeStandardTool('memory_save', { content: 'x', layer: 'role' }, { ...roleCtx, memoryScope: { ...roleCtx.memoryScope, scopeKeys: ['Sales Engineer'] } });
    expect(result.success).toBe(true);
    expect(mockSaveMemory.mock.calls[0][0].scopeKey).toBe('Sales Engineer');
    expect(mockResolveRoleScopeKey).not.toHaveBeenCalled();
  });

  it('refuses rather than keying by the agent id when the team has no role', async () => {
    mockResolveRoleScopeKey.mockResolvedValueOnce(null);
    const result = await executeStandardTool('memory_save', { content: 'x', layer: 'role' }, roleCtx);
    expect(result.success).toBe(false);
    expect(String((result as { error?: string }).error)).toMatch(/role/);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('individual-layer saves are untouched by the role rule', async () => {
    const result = await executeStandardTool('memory_save', { content: 'x', layer: 'individual' }, roleCtx);
    expect(result.success).toBe(true);
    expect(mockSaveMemory.mock.calls[0][0].scopeKey).toBe('agent-1');
    expect(mockResolveRoleScopeKey).not.toHaveBeenCalled();
  });
});
