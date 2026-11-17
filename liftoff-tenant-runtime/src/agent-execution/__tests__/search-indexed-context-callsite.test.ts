// The `search` builtin actually returns the indexed source — native-loop call site.
//
// `search` is implemented TWICE: once as an MCP tool for the vendor engines and
// once as a builtin for the native loop. A source wired into one and not the
// other is invisible — the engines carrying most traffic would answer from the
// index while the rest silently would not, and both would look correct.
//
// The MCP half is covered by tool-gateway/__tests__/search-indexed-context-
// callsite.test.ts. This is the other half.
//
// Mock harness mirrors catalog-schema-parity.test.ts, which is the established
// way to stand this service up in a unit test.


jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) =>
    ({ name, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[]; name?: string }) =>
    ({ type: 'sdk', name: opts.name || 'test', tools: opts.tools })),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../streaming', () => ({
  streamingService: { emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
jest.mock('../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));

jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: { checkGate: jest.fn() },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));

jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: jest.fn(), chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));

jest.mock('../../coordinator/service', () => ({
  CoordinatorService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../coordinator/dispatcher', () => ({
  getCoordinatorDispatcher: () => ({}),
}));
jest.mock('../../tool-gateway/service', () => ({
  ToolGatewayService: jest.fn().mockImplementation(() => ({
    setCredentialService: jest.fn(),
    routeToolCall: jest.fn(),
  })),
}));
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: () => ({ execute: jest.fn() }),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: jest.fn(),
  })),
}));
jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../usage-ledger/service', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({}),
}));
jest.mock('../../memory', () => ({
  memoryService: { retrieve: jest.fn(), save: jest.fn() },
}));
jest.mock('../../invocations', () => ({
  invocationsService: { getMessages: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));

jest.mock('../tool-interceptor', () => ({ interceptToolCalls: jest.fn((calls) => calls) }));

// Connector manifest registry — single fake connector. id matches the
// integration id below so buildToolsSchema's bound-integration filter
// (multi-account safety guard) accepts it.
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifests: jest.fn().mockResolvedValue([
      { id: 'conn-1', connectorType: 'google-mail', alias: 'my_gmail', displayName: 'My Gmail', enabled: true },
    ]),
    getManifestsForAgent: jest.fn().mockResolvedValue([
      { id: 'conn-1', connectorType: 'google-mail', alias: 'my_gmail', displayName: 'My Gmail', enabled: true },
    ]),
  },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([
    { name: 'send_email', description: 'Send email', inputSchema: { type: 'object', properties: {} }, categories: ['write'], entityType: 'message' },
    { name: 'read_email', description: 'Read email', inputSchema: { type: 'object', properties: {} }, categories: ['read'], entityType: 'message' },
  ]),
  listConnectorTypes: jest.fn().mockReturnValue(['google-mail']),
}));

// Standard tools — small fixed set including a web tool to exercise
// the vendor-filter alignment.
jest.mock('../../tools/standard-tools', () => ({
  STANDARD_TOOLS: [
    { name: 'memory_save', description: 'Save memory', input_schema: { type: 'object', properties: {} } },
    { name: 'memory_retrieve', description: 'Retrieve memory', input_schema: { type: 'object', properties: {} } },
    { name: 'web_research', description: 'Web research', input_schema: { type: 'object', properties: {} } },
  ],
}));

// Pin web-vendor flags: only perplexity ON. web_research depends on
// any-research-backend (perplexity included), so it should survive.
jest.mock('../../integrations/web-fetch/global-flags', () => ({
  getAllVendorFlags: jest.fn().mockResolvedValue({ perplexity: true, openai: false, google: false }),
}));
jest.mock('../../integrations/web-fetch/web-tool-secrets', () => ({
  getTenantConnectedWebVendors: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('../../browser-sessions/repository', () => ({
  getActiveForThread: jest.fn().mockResolvedValue(null),
}));

// Per-agent Slack: one install with a real bot token.
jest.mock('../../agent-chat/agent-slack-client', () => ({
  listAgentSlackInstalls: jest.fn().mockResolvedValue([
    { slackTeamId: 'T1', botToken: 'xoxb-stub', botUserId: 'U1' },
  ]),
}));

// Per-agent Teams: one bound conversation so teams_* tools surface on both
// sides (catalog via mcp-server, schema via buildToolsSchema).
jest.mock('../../agent-chat/agent-teams-client', () => ({
  listAgentTeamsConversations: jest.fn().mockResolvedValue([
    { conversationId: 'C1', scope: 'channel' },
  ]),
}));

// Knowledge-bound check (gates corpus_search) — neither side exposes
// it in this test, so a 0 here keeps both paths aligned.
jest.mock('../../tool-gateway/knowledge-exposure-cache', () => ({
  tenantHasBoundKnowledge: jest.fn().mockResolvedValue(false),
}));

// Cloud Tasks / DB stubs (not exercised by buildToolsSchema or the
// catalog directly, but loaded by the service constructor).
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: jest.fn(),
}));
const mockPool = {
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  }),
};
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => mockPool),
  getPool: jest.fn(() => mockPool),
}));

jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {},
  mapRow: (row: Record<string, unknown>) => row,
}));

// runtime-env.requireEnv throws for missing PLATFORM_BACKEND_URL /
// PLATFORM_CALLBACK_TOKEN — buildToolsSchema reaches it via
// loadExternalAgentsForInternalAgent. Set sentinel values so the
// service construction + tool schema build complete; the find_teammates
// MCP tool path is bucketed as "other" by the parity classifier so it
// doesn't pollute the shared-family comparison.
process.env.PLATFORM_BACKEND_URL = 'https://platform-backend.local';
process.env.PLATFORM_CALLBACK_TOKEN = 'test-token';

// loadExternalAgentsForInternalAgent calls global fetch — stub it
// at the global level so the network call doesn't fire.
(globalThis as { fetch?: typeof fetch }).fetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ agents: [] }),
}) as unknown as typeof fetch;


// ── Additional stubs for the sources `search` composes ──────────────────

const mockExecuteStandardTool = jest.fn();
jest.mock('../../tools/standard-tool-handler', () => ({
  executeStandardTool: (...a: unknown[]) => mockExecuteStandardTool(...a),
}));

const mockEmitAudit = jest.fn();
jest.mock('../../audit/standard-tool-emitter', () => ({
  emitStandardToolAudit: (...a: unknown[]) => mockEmitAudit(...a),
}));

const mockBuildRetrievalVector = jest.fn();
jest.mock('../../memory/retrieval-vector', () => ({
  buildRetrievalVector: (...a: unknown[]) => mockBuildRetrievalVector(...a),
}));

// The REAL indexed source, with only its database dependency stubbed, so what
// is under test is the wiring rather than a mock of it.
const mockSearchConnectorContent = jest.fn();
const mockCoverage = jest.fn();
jest.mock('../../connector-content/search-service', () => ({
  searchConnectorContent: (...a: unknown[]) => mockSearchConnectorContent(...a),
  connectorContentCoverage: (...a: unknown[]) => mockCoverage(...a),
}));

import { AgentExecutionService } from '../service';
import type { ExecutionState, ExecutionContext } from '../types';

interface SearchResultShape {
  results: Array<{ source: string; items: unknown[]; coverage?: unknown; note?: string }>;
  message?: string;
}

function makeState(): ExecutionState {
  return {
    context: {
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      workflowId: 'wf-1',
      taskId: 'task-1',
      instructionVersion: 1,
      instruction: { systemPrompt: '', allowedConnectors: [], allowedActionTypes: ['*'] } as unknown as ExecutionContext['instruction'],
      traceId: 'trace-1',
      agentType: 'agent',
      hitlLevel: 0,
      modelConfig: {} as ExecutionContext['modelConfig'],
      execConfig: {},
      memoryScope: {},
      integrations: [{ id: 'conn-1', type: 'slack' }],
      threadId: 'thread-1',
      invocationId: 'inv-1',
    } as ExecutionContext,
    reasoningSteps: 0,
    toolCallsExecuted: 0,
    startTime: new Date(),
    steps: [],
    conversationHistory: [],
    pendingToolCalls: [],
    completedToolCalls: [],
    toolFailureCounts: new Map(),
    injectedSkillIds: [],
  };
}

async function callSearch(payload: Record<string, unknown>): Promise<SearchResultShape> {
  const service = new AgentExecutionService();
  const res = await (service as unknown as {
    executeSearchBuiltin: (s: ExecutionState, p: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown }>;
  }).executeSearchBuiltin(makeState(), payload);
  return res.result as SearchResultShape;
}

beforeEach(() => {
  jest.clearAllMocks();
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
    const out = await callSearch({ query: 'unpaid invoices' });
    const indexed = out.results.find((r) => r.source === 'indexed_context');
    expect(indexed).toBeDefined();
    expect(indexed!.items).toHaveLength(1);
    expect(indexed!.coverage).toMatchObject({ indexedItems: 7 });
  });

  it('sits alongside memory rather than replacing it', async () => {
    const out = await callSearch({ query: 'q' });
    expect(out.results.map((r) => r.source)).toEqual(
      expect.arrayContaining(['indexed_context', 'memory']),
    );
  });

  it('is audited, so /activity shows the work that happened', async () => {
    await callSearch({ query: 'q' });
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'indexed_context_search', success: true }),
    );
  });

  it('buys ONE hypothetical document for the whole call, not one per source', async () => {
    await callSearch({ query: 'q' });
    expect(mockBuildRetrievalVector).toHaveBeenCalledTimes(1);
    expect(mockSearchConnectorContent).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingJson: '[0.1]' }),
    );
  });

  it('hands the same vector to memory_retrieve', async () => {
    await callSearch({ query: 'q' });
    expect(mockExecuteStandardTool).toHaveBeenCalledWith(
      'memory_retrieve',
      expect.anything(),
      expect.objectContaining({ precomputedQueryEmbedding: [0.1] }),
    );
  });

  it('attributes the retrieval spend to the run that caused it', async () => {
    await callSearch({ query: 'q' });
    expect(mockBuildRetrievalVector).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: 'inv-1' }),
    );
  });

  it('counts the indexed hits toward the outer outcome', async () => {
    // Without this the umbrella row says `search_no_results` on /activity while
    // returning results to the model.
    mockExecuteStandardTool.mockResolvedValue({ success: false, error: 'memory down' });
    await callSearch({ query: 'q' });
    expect(mockEmitAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'search', success: true }),
    );
  });
});

describe('a failure in one source does not take the others down', () => {
  it('still returns memory results when the search service throws', async () => {
    mockSearchConnectorContent.mockRejectedValue(new Error('connection terminated'));
    const out = await callSearch({ query: 'q' });
    const memory = out.results.find((r) => r.source === 'memory');
    expect(memory).toBeDefined();
    expect(memory!.items).toHaveLength(1);
  });

  it('reports the failed source as not having run, rather than as empty', async () => {
    mockSearchConnectorContent.mockRejectedValue(new Error('connection terminated'));
    await callSearch({ query: 'q' });
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
    const out = await callSearch({ query: 'q' });
    expect(out.results.find((r) => r.source === 'indexed_context')!.items).toHaveLength(1);
  });

});

describe('when the embedding provider is down', () => {
  beforeEach(() => {
    mockBuildRetrievalVector.mockResolvedValue({
      embedding: null, embeddingJson: null, unavailable: true,
    });
  });

  it('tells the indexed source to search lexically rather than retry', async () => {
    // One outage must not become one failed provider call per source, per
    // search, for as long as it lasts.
    await callSearch({ query: 'q' });
    expect(mockSearchConnectorContent).toHaveBeenCalledWith(
      expect.objectContaining({ lexicalOnly: true }),
    );
  });

  it('tells memory to degrade to recency rather than retry', async () => {
    await callSearch({ query: 'q' });
    expect(mockExecuteStandardTool).toHaveBeenCalledWith(
      'memory_retrieve',
      expect.anything(),
      expect.objectContaining({ semanticRetrievalUnavailable: true }),
    );
  });

  it('still returns results from both sources', async () => {
    const out = await callSearch({ query: 'q' });
    expect(out.results.map((r) => r.source)).toEqual(
      expect.arrayContaining(['indexed_context', 'memory']),
    );
  });
});

describe('an empty index is qualified, never asserted as absence', () => {
  it('carries the coverage note beside the no-results guidance', async () => {
    mockSearchConnectorContent.mockResolvedValue([]);
    mockExecuteStandardTool.mockResolvedValue({ success: true, result: { memories: [] } });

    const out = await callSearch({ query: 'q' });

    const indexed = out.results.find((r) => r.source === 'indexed_context');
    expect(indexed!.items).toEqual([]);
    expect(indexed!.note).toMatch(/absence here is not absence at the source/i);
    expect(out.message).toMatch(/No results found/);
  });
});
