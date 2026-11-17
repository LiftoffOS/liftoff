// The `search` tool actually returns the indexed source — MCP call site.
//
// `indexed-context-source.test.ts` proves the helper behaves. This proves the
// WIRING, which is the half that has historically been missing: a source built,
// tested and never reached is indistinguishable from one that returns nothing,
// and both look like an empty index.
//
// Two properties, both from the plan:
//   1. the `indexed_context` source appears in the result, with its coverage
//   2. a search-service failure still returns the memory results

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((
    name: string,
    _desc: string,
    _schema: unknown,
    handler: (...args: unknown[]) => unknown,
  ) => ({ name, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[]; name?: string }) => ({
    type: 'sdk', name: opts.name || 'test', tools: opts.tools,
  })),
}));

jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn().mockReturnValue([]),
  listConnectorTypes: jest.fn().mockReturnValue([]),
}));

jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../tools/standard-tools', () => ({ STANDARD_TOOLS: [] }));

const mockExecuteStandardTool = jest.fn();
jest.mock('../../tools/standard-tool-handler', () => ({
  executeStandardTool: (...a: unknown[]) => mockExecuteStandardTool(...a),
}));

const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: jest.fn().mockReturnValue({}),
}));

jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));

const mockEmitAudit = jest.fn();
jest.mock('../../audit/standard-tool-emitter', () => ({
  emitStandardToolAudit: (...a: unknown[]) => mockEmitAudit(...a),
}));

// The shared retrieval vector: one hypothetical document per `search`.
const mockBuildRetrievalVector = jest.fn();
jest.mock('../../memory/retrieval-vector', () => ({
  buildRetrievalVector: (...a: unknown[]) => mockBuildRetrievalVector(...a),
}));

// The real source, with its dependency stubbed — so the wiring under test is
// genuine and only the database is fake.
const mockSearchConnectorContent = jest.fn();
const mockCoverage = jest.fn();
jest.mock('../../connector-content/search-service', () => ({
  searchConnectorContent: (...a: unknown[]) => mockSearchConnectorContent(...a),
  connectorContentCoverage: (...a: unknown[]) => mockCoverage(...a),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { createToolGatewayMcpServer } from '../mcp-server';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

interface SearchPayload {
  success: boolean;
  results: Array<{ source: string; items: unknown[]; coverage?: unknown; note?: string }>;
  message?: string;
}

async function callSearch(args: { query: string; connectors?: string[] }): Promise<SearchPayload> {
  const result = await createToolGatewayMcpServer({
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    instructionVersion: 1,
    traceId: 'trace-1',
    invocationId: '33333333-3333-3333-3333-333333333333',
    allowedConnectors: [],
    toolGateway: { execute: jest.fn() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const tools = (result.mcpServer as unknown as {
    tools: Array<{ name: string; handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
  }).tools;

  const search = tools.find((t) => t.name === 'search');
  if (!search) throw new Error('search tool was not registered');

  const res = await search.handler(args);
  const raw = res.content[0].text;
  // A non-empty result is wrapped by frameUntrusted; the JSON is the last
  // balanced object in the string either way.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return JSON.parse(raw.slice(start, end + 1)) as SearchPayload;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  process.env.PLATFORM_BACKEND_URL = 'http://platform-backend-test';
  process.env.PLATFORM_CALLBACK_TOKEN = 'test-token';

  // knowledge-count gate at catalog-build time.
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0 }) });
  const { __resetKnowledgeExposureCache } = jest.requireActual('../knowledge-exposure-cache');
  __resetKnowledgeExposureCache();
  const { _resetIndexedContextCountersForTesting } = jest.requireActual(
    '../../connector-content/indexed-context-source',
  );
  _resetIndexedContextCountersForTesting();

  mockBuildRetrievalVector.mockResolvedValue({ embedding: [0.1], embeddingJson: '[0.1]', unavailable: false });
  mockCoverage.mockResolvedValue({
    indexedItems: 7,
    oldestIndexedAt: '2026-07-01T00:00:00.000Z',
    newestIndexedAt: '2026-08-18T00:00:00.000Z',
  });
  mockSearchConnectorContent.mockResolvedValue([
    { id: 'cc-1', content: 'indexed thing', connectorType: 'slack', entityType: 'message', tags: [], score: 0.9 },
  ]);
  mockExecuteStandardTool.mockResolvedValue({
    success: true,
    result: { memories: [{ id: 'm-1', content: 'remembered thing' }] },
  });
});

describe('the indexed source reaches the model', () => {
  it('appears in the results with its coverage', async () => {
    const payload = await callSearch({ query: 'unpaid invoices' });

    const indexed = payload.results.find((r) => r.source === 'indexed_context');
    expect(indexed).toBeDefined();
    expect(indexed!.items).toHaveLength(1);
    expect(indexed!.coverage).toMatchObject({ indexedItems: 7 });
  });

  it('sits alongside memory rather than replacing it', async () => {
    const payload = await callSearch({ query: 'unpaid invoices' });
    expect(payload.results.map((r) => r.source)).toEqual(
      expect.arrayContaining(['indexed_context', 'memory']),
    );
  });

  it('is audited, so /activity shows the work that happened', async () => {
    await callSearch({ query: 'unpaid invoices' });
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'indexed_context_search', success: true }),
    );
  });

  it('buys ONE hypothetical document for the whole call, not one per source', async () => {
    await callSearch({ query: 'unpaid invoices' });
    expect(mockBuildRetrievalVector).toHaveBeenCalledTimes(1);
    // …and hands the vector to the indexed source rather than letting it build
    // a second one.
    expect(mockSearchConnectorContent).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingJson: '[0.1]' }),
    );
  });

  it('hands the same vector to memory_retrieve', async () => {
    await callSearch({ query: 'unpaid invoices' });
    expect(mockExecuteStandardTool).toHaveBeenCalledWith(
      'memory_retrieve',
      expect.anything(),
      expect.objectContaining({ precomputedQueryEmbedding: [0.1] }),
    );
  });
});

describe('a failure in one source does not take the others down', () => {
  it('still returns memory results when the search service throws', async () => {
    mockSearchConnectorContent.mockRejectedValue(new Error('connection terminated'));

    const payload = await callSearch({ query: 'unpaid invoices' });

    const memory = payload.results.find((r) => r.source === 'memory');
    expect(memory).toBeDefined();
    expect(memory!.items).toHaveLength(1);
  });

  it('reports the failed source as not having run, rather than as empty', async () => {
    mockSearchConnectorContent.mockRejectedValue(new Error('connection terminated'));
    await callSearch({ query: 'unpaid invoices' });
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'indexed_context_search',
        success: false,
        errorCode: 'indexed_context_unavailable',
      }),
    );
  });

  it('still returns indexed results when memory retrieval throws', async () => {
    mockExecuteStandardTool.mockRejectedValue(new Error('memory down'));

    const payload = await callSearch({ query: 'unpaid invoices' });

    const indexed = payload.results.find((r) => r.source === 'indexed_context');
    expect(indexed!.items).toHaveLength(1);
  });
});

describe('when the embedding provider is down', () => {
  beforeEach(() => {
    // The shared build reports unavailability rather than throwing, so the
    // sources go lexical instead of each re-attempting a dead provider.
    mockBuildRetrievalVector.mockResolvedValue({
      embedding: null, embeddingJson: null, unavailable: true,
    });
  });

  it('tells the indexed source to search lexically rather than retry', async () => {
    await callSearch({ query: 'unpaid invoices' });
    expect(mockSearchConnectorContent).toHaveBeenCalledWith(
      expect.objectContaining({ lexicalOnly: true }),
    );
    expect(mockSearchConnectorContent).toHaveBeenCalledWith(
      expect.not.objectContaining({ embeddingJson: expect.anything() }),
    );
  });

  it('tells memory to degrade to recency rather than retry', async () => {
    await callSearch({ query: 'unpaid invoices' });
    expect(mockExecuteStandardTool).toHaveBeenCalledWith(
      'memory_retrieve',
      expect.anything(),
      expect.objectContaining({ semanticRetrievalUnavailable: true }),
    );
  });

  it('still returns results from both sources', async () => {
    const payload = await callSearch({ query: 'unpaid invoices' });
    expect(payload.results.map((r) => r.source)).toEqual(
      expect.arrayContaining(['indexed_context', 'memory']),
    );
  });
});

describe('an empty index is qualified, never asserted as absence', () => {
  it('carries the coverage note so the model can say "not in what I have seen"', async () => {
    mockSearchConnectorContent.mockResolvedValue([]);
    mockExecuteStandardTool.mockResolvedValue({ success: true, result: { memories: [] } });

    const payload = await callSearch({ query: 'unpaid invoices' });

    const indexed = payload.results.find((r) => r.source === 'indexed_context');
    expect(indexed!.items).toEqual([]);
    expect(indexed!.note).toMatch(/absence here is not absence at the source/i);
    // The "no results" guidance is about ITEMS, and the note survives beside it.
    expect(payload.message).toMatch(/No results found/);
  });
});
