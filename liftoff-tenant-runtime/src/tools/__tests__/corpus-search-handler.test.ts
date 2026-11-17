// Tests for the corpus_search standard-tool handler.

const mockFetch = jest.fn();
const mockGetClient = jest.fn();

jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: (...args: unknown[]) => mockGetClient(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockRecordUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage: (...args: unknown[]) => mockRecordUsage(...args) },
}));

import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const baseCtx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: {},
  traceId: 'trace-1',
  integrations: [],
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetClient.mockReturnValue({ fetch: mockFetch });
});

describe('corpus_search', () => {
  it('rejects empty query', async () => {
    const result = await executeStandardTool('corpus_search', { query: '   ' }, baseCtx);
    expect(result).toEqual({
      success: false,
      error: 'corpus_search requires a non-empty "query"',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls platform with empty connectorIds when ctx.integrations is empty', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
    await executeStandardTool('corpus_search', { query: 'reset password' }, baseCtx);
    expect(mockFetch).toHaveBeenCalledWith(
      'platform',
      '/api/internal/knowledge/search',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
    const body = JSON.parse((mockFetch.mock.calls[0][2] as { body: string }).body);
    expect(body).toEqual({
      tenantId: 'tenant-1',
      connectorIds: [],
      includeManual: true,
      query: 'reset password',
      limit: 5,
      // Caller attribution propagated to platform-backend so query-time
      // embed cost lands on the calling agent. baseCtx has no thread/
      // invocation id; those are undefined and JSON.stringify drops them.
      agentId: 'agent-1',
      // Forwarded so platform-backend's searchByTenantAndConnectors can
      // positionally elevate pinned items above natural matches.
      pinnedKnowledgeIds: [],
    });
  });

  it('filters connectorIds when sources array supplied', async () => {
    // connector_instance ids are UUIDs; WS-B's TR-side filter drops any
    // non-UUID before sending to PB. Use real UUIDs so the filter passes
    // through (matches the data shape that hits prod).
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
    const zd1 = '00000000-0000-4000-8000-0000000000a1';
    const gd1 = '00000000-0000-4000-8000-0000000000a2';
    const zd2 = '00000000-0000-4000-8000-0000000000a3';
    const ctx: StandardToolContext = {
      ...baseCtx,
      integrations: [
        { id: zd1, type: 'zendesk' },
        { id: gd1, type: 'google_drive' },
        { id: zd2, type: 'zendesk' },
      ],
    };
    await executeStandardTool('corpus_search', { query: 'refund', sources: ['zendesk'] }, ctx);
    const body = JSON.parse((mockFetch.mock.calls[0][2] as { body: string }).body);
    expect(body.connectorIds).toEqual([zd1, zd2]);
  });

  it('surfaces HTTP errors', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500));
    const result = await executeStandardTool('corpus_search', { query: 'x' }, baseCtx);
    expect(result).toEqual({
      success: false,
      error: 'knowledge search returned HTTP 500',
    });
  });

  it('projects platform response onto the tool-facing shape (title, excerpt, url, source)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        results: [
          { id: '1', title: 'A', excerpt: 'a', sourceUrl: 'https://a', connectorId: 'c1', connectorType: 'zendesk', rank: 0.9 },
          { id: '2', title: 'B', excerpt: 'b', sourceUrl: 'https://b', connectorId: 'c1', connectorType: 'zendesk', rank: 0.8 },
          { id: '3', title: 'C', excerpt: 'c', sourceUrl: null, connectorId: null, connectorType: null, rank: 0.7 },
        ],
      }),
    );
    const result = await executeStandardTool('corpus_search', { query: 'x' }, baseCtx);
    expect(result).toEqual({
      success: true,
      result: {
        results: [
          { title: 'A', excerpt: 'a', url: 'https://a', source: 'zendesk', pinned: false },
          { title: 'B', excerpt: 'b', url: 'https://b', source: 'zendesk', pinned: false },
          { title: 'C', excerpt: 'c', url: null, source: null, pinned: false },
        ],
      },
    });
  });

  it('returns error when platform callback client is not configured', async () => {
    mockGetClient.mockReturnValue(null);
    const result = await executeStandardTool('corpus_search', { query: 'x' }, baseCtx);
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/platform callback client not configured/);
  });

  it('surfaces network failures (client.fetch rejects)', async () => {
    // Covers the outer try/catch in handleCorpusSearch — distinct from the
    // !resp.ok branch. Happens on transient DNS/TLS failures or when the
    // circuit breaker is open and the ServiceClient throws.
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await executeStandardTool('corpus_search', { query: 'x' }, baseCtx);
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/corpus_search failed: ECONNREFUSED/);
  });

  it('forwards ctx.pinnedKnowledgeIds in the request body', async () => {
    // pinnedKnowledgeIds are knowledge_items table UUIDs; WS-B's TR-side
    // defensive filter drops any non-UUID string (defense-in-depth against
    // malformed `[[knowledge:...]]` markers leaking through compiled
    // instructions). Use real UUIDs so the filter passes them through.
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
    const pin1 = '00000000-0000-4000-8000-000000000001';
    const pin2 = '00000000-0000-4000-8000-000000000002';
    const ctx: StandardToolContext = { ...baseCtx, pinnedKnowledgeIds: [pin1, pin2] };
    await executeStandardTool('corpus_search', { query: 'x' }, ctx);
    const body = JSON.parse((mockFetch.mock.calls[0][2] as { body: string }).body);
    expect(body.pinnedKnowledgeIds).toEqual([pin1, pin2]);
  });

  it('WS-B: drops non-UUID pinnedKnowledgeIds before sending to PB', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
    const validUuid = '00000000-0000-4000-8000-000000000003';
    const ctx: StandardToolContext = {
      ...baseCtx,
      pinnedKnowledgeIds: [validUuid, 'pin-malformed', 'another-bad-marker'],
    };
    await executeStandardTool('corpus_search', { query: 'x' }, ctx);
    const body = JSON.parse((mockFetch.mock.calls[0][2] as { body: string }).body);
    expect(body.pinnedKnowledgeIds).toEqual([validUuid]);
  });

  it('defaults pinnedKnowledgeIds to [] when ctx omits the field', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
    await executeStandardTool('corpus_search', { query: 'x' }, baseCtx);
    const body = JSON.parse((mockFetch.mock.calls[0][2] as { body: string }).body);
    expect(body.pinnedKnowledgeIds).toEqual([]);
  });

  it('marks pinned:true on results whose id is in ctx.pinnedKnowledgeIds', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      results: [
        { id: 'p1', title: 'Pinned', excerpt: 'e', sourceUrl: null, connectorId: 'c1', connectorType: 'z', rank: 0.9 },
        { id: 'n1', title: 'Natural', excerpt: 'e', sourceUrl: null, connectorId: 'c1', connectorType: 'z', rank: 0.8 },
      ],
    }));
    const ctx: StandardToolContext = { ...baseCtx, pinnedKnowledgeIds: ['p1'] };
    const result = await executeStandardTool('corpus_search', { query: 'x' }, ctx) as { success: true; result: { results: Array<{ title: string; pinned: boolean }> } };
    expect(result.result.results.map(r => ({ title: r.title, pinned: r.pinned }))).toEqual([
      { title: 'Pinned', pinned: true },
      { title: 'Natural', pinned: false },
    ]);
  });

  it('records pinnedHits and pinnedTotal in usage_ledger metadata', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      results: [
        { id: 'p1', title: 'A', excerpt: '', sourceUrl: null, connectorId: null, connectorType: null, rank: 1 },
        { id: 'n1', title: 'B', excerpt: '', sourceUrl: null, connectorId: null, connectorType: null, rank: 1 },
      ],
    }));
    const ctx: StandardToolContext = { ...baseCtx, pinnedKnowledgeIds: ['p1', 'p2'] };
    await executeStandardTool('corpus_search', { query: 'x' }, ctx);
    // Wait a tick for the fire-and-forget catch to attach.
    await new Promise(r => setImmediate(r));
    const meta = mockRecordUsage.mock.calls[0][0].metadata;
    expect(meta.pinnedHits).toBe(1);   // p1 matched, p2 didn't appear in results
    expect(meta.pinnedTotal).toBe(2);  // operator pinned 2 items
  });

  it('clamps the limit to [1, 20] and floors fractional values', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
    await executeStandardTool('corpus_search', { query: 'x', limit: 100 }, baseCtx);
    expect(JSON.parse((mockFetch.mock.calls[0][2] as { body: string }).body).limit).toBe(20);

    mockFetch.mockClear();
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
    await executeStandardTool('corpus_search', { query: 'x', limit: 0 }, baseCtx);
    expect(JSON.parse((mockFetch.mock.calls[0][2] as { body: string }).body).limit).toBe(1);

    mockFetch.mockClear();
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
    await executeStandardTool('corpus_search', { query: 'x', limit: 5.9 }, baseCtx);
    expect(JSON.parse((mockFetch.mock.calls[0][2] as { body: string }).body).limit).toBe(5);
  });
});

// One deadline over the platform call AND its body read. A pooled connection
// left dead by a network reset held the tool call (and the turn) with no bound,
// and a response whose body never finished had none either.
describe('corpus_search deadline', () => {
  afterEach(() => jest.useRealTimers());

  it.each([
    ['the request never answers', () => new Promise<never>(() => undefined)],
    ['the body never finishes', () => Promise.resolve({ ok: true, status: 200, json: () => new Promise<never>(() => undefined) })],
  ])('fails the tool call with a timeout after 30s when %s, and aborts the request', async (_label, respond) => {
    jest.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_k: string, _p: string, init: { signal?: AbortSignal }) => {
      seenSignal = init.signal;
      return respond();
    });

    const pending = executeStandardTool('corpus_search', { query: 'refund policy' }, baseCtx);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(seenSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({
      success: false,
      error: 'corpus_search failed: corpus_search knowledge search timed out after 30000ms',
    });
    expect(seenSignal?.aborted).toBe(true);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });
});
