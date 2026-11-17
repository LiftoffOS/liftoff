// MCP searchConnectorContent — unit tests
// Covers: auth, rate limiting, correct params forwarded to TR, agentId threading,
// result formatting.

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockSearchConnectorContent = jest.fn();
const mockSaveMemory = jest.fn().mockResolvedValue({ id: 'mem-1' });
const mockEnqueueAgentTask = jest.fn().mockResolvedValue(undefined);
const mockEnqueueAgentMessage = jest.fn().mockResolvedValue(undefined);

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    searchConnectorContent: (...args: unknown[]) => mockSearchConnectorContent(...args),
    saveMemory: (...args: unknown[]) => mockSaveMemory(...args),
    enqueueAgentTask: (...args: unknown[]) => mockEnqueueAgentTask(...args),
    enqueueAgentMessage: (...args: unknown[]) => mockEnqueueAgentMessage(...args),
  },
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
}));

jest.mock('../../internal-agent-oversight/service', () => ({
  oversightService: {
    getOrCreateOversightSettings: jest.fn().mockResolvedValue({
      tenantId: '11111111-1111-1111-1111-111111111111',
      currentVersion: 1,
      autonomy: 'balanced',
      escalation: 'important',
      sensitiveWork: {},
      communication: 'review',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  },
}));

import type { McpAuthContext } from '../types';

// ── Fixtures ───────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const KEY_ID = '33333333-3333-3333-3333-333333333333';
const AGENT_ID = '44444444-4444-4444-4444-444444444444';

function makeCtx(overrides: Partial<McpAuthContext> = {}): McpAuthContext {
  return { tenantId: TENANT_ID, accountId: ACCOUNT_ID, keyId: KEY_ID, keyType: 'claude_code', ...overrides };
}

const SAMPLE_RESULTS = [
  { id: 'r1', content: 'Slack message about billing', connector_type: 'slack', entity_type: 'message', tags: ['billing'] },
  { id: 'r2', content: 'Confluence page on Q4 plan', connector_type: 'confluence', entity_type: 'page', tags: ['q4'] },
];

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchConnectorContent.mockResolvedValue({ results: SAMPLE_RESULTS, coverage: { indexedItems: 3, oldestIndexedAt: '2026-07-01T00:00:00Z', newestIndexedAt: '2026-08-01T00:00:00Z' } });
});

// ── searchConnectorContent ─────────────────────────────────────────────────

describe('searchConnectorContent', () => {
  it('calls TR searchConnectorContent with correct params', async () => {
    jest.resetModules();
    const { searchConnectorContent } = await import('../service');
    const result = await searchConnectorContent({ query: 'billing Q4' }, makeCtx()) as { results: typeof SAMPLE_RESULTS };
    expect(mockSearchConnectorContent).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ query: 'billing Q4', limit: 10 }),
    );
    expect(result.results).toEqual(SAMPLE_RESULTS);
  });

  it('forwards connectorType filter to TR', async () => {
    jest.resetModules();
    const { searchConnectorContent } = await import('../service');
    await searchConnectorContent({ query: 'budget', connectorType: 'slack' }, makeCtx());
    expect(mockSearchConnectorContent).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ connectorType: 'slack' }),
    );
  });

  it('forwards limit to TR', async () => {
    jest.resetModules();
    const { searchConnectorContent } = await import('../service');
    await searchConnectorContent({ query: 'docs', limit: 25 }, makeCtx());
    expect(mockSearchConnectorContent).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ limit: 25 }),
    );
  });

  it('threads agentId through to TR when provided', async () => {
    jest.resetModules();
    const { searchConnectorContent } = await import('../service');
    await searchConnectorContent({ query: 'notes', agentId: AGENT_ID }, makeCtx());
    expect(mockSearchConnectorContent).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ agentId: AGENT_ID }),
    );
  });

  it('does NOT send agentId to TR when omitted (not null, not empty string)', async () => {
    jest.resetModules();
    const { searchConnectorContent } = await import('../service');
    await searchConnectorContent({ query: 'notes' }, makeCtx());
    const callArgs = mockSearchConnectorContent.mock.calls[0][1] as Record<string, unknown>;
    // agentId should be undefined (not present), never null or ''
    expect(callArgs.agentId).toBeUndefined();
  });

  it('returns formatted result object with results array', async () => {
    jest.resetModules();
    const { searchConnectorContent } = await import('../service');
    const result = await searchConnectorContent({ query: 'quarterly' }, makeCtx()) as { results: unknown[] };
    expect(result).toHaveProperty('results');
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results).toHaveLength(2);
  });

  it('returns empty results on TR failure (client returns empty set)', async () => {
    jest.resetModules();
    mockSearchConnectorContent.mockResolvedValue({ results: [], coverage: null });
    const { searchConnectorContent } = await import('../service');
    const result = await searchConnectorContent({ query: 'nothing' }, makeCtx()) as { results: unknown[] };
    expect(result.results).toHaveLength(0);
  });
});

// ── searchConnectorContent rate limiting ───────────────────────────────────

describe('searchConnectorContent rate limiting', () => {
  it('rejects after 30 requests per minute', async () => {
    jest.resetModules();
    const { searchConnectorContent: freshSearch } = await import('../service');
    const ctx = makeCtx();

    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < 32; i++) {
      const result = await freshSearch({ query: 'test' }, ctx) as { results?: unknown[]; success?: boolean; error?: string };
      if ('results' in result) successCount++;
      else failCount++;
    }

    expect(successCount).toBeLessThanOrEqual(30);
    expect(failCount).toBeGreaterThanOrEqual(2);
  });

  it('returns rate limit error object on exceeded limit', async () => {
    jest.resetModules();
    const { searchConnectorContent: freshSearch } = await import('../service');
    const ctx = makeCtx();

    // Exhaust the 30-req limit
    for (let i = 0; i < 30; i++) {
      await freshSearch({ query: 'test' }, ctx);
    }
    const result = await freshSearch({ query: 'test' }, ctx) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit exceeded');
  });
});
