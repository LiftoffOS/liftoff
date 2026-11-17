// The web-only fallback catalog, as REGISTERED, on every supported engine.
//
// A capability step's second turn hands the gateway an allowlist, and the
// property that matters is that no engine can reach a tool that is not on
// it — not that a list somewhere looks short. Every engine reads the one
// McpToolCatalog the service assembles, by one of five paths:
//
//   claude-agent-sdk            → mounts the in-process McpServer INSTANCE
//                                 (buildAnthropicMcpServers), whose tools are
//                                 whatever the gateway registered on it;
//   openai-agents, openrouter-  → mcpToOpenAiFunctionTools(catalog) over
//   openai-wire, xai-openai-wire  catalog.tools;
//   google-genai                → functionDeclarations from catalog.tools;
//   google-adk                  → FunctionTool per catalog.tools entry;
//   openai-codex, opencode,     → exposeCatalogOverHttp(catalog): an MCP
//   google-gemini-cli             server answering tools/list from
//                                 catalog.tools.
//
// So this builds ONE narrowed catalog the way the service does for the
// fallback turn — through buildPlatformMcpCatalog, with a prebuilt catalog on
// the context so the fast path is shown to be bypassed — and reads it the
// way each engine reads it. The engine list is asserted complete against
// RESOLVABLE_EXECUTION_ENGINE_IDS, so a new engine fails here until its
// path is covered.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((name: string, _desc: string, _schema: unknown, handler: (..._args: unknown[]) => unknown) => ({ name, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: Array<{ name: string }>; name?: string }) => ({ type: 'sdk', name: opts.name || 'test', instance: { tools: opts.tools }, tools: opts.tools })),
  query: jest.fn(),
  AbortError: class AbortError extends Error {},
}));
const generateContentMock = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContentStream: async (...args: unknown[]) => {
        const resp = await generateContentMock(...args);
        return (async function* () { yield resp; })();
      },
    },
  })),
  FinishReason: { STOP: 'STOP', MAX_TOKENS: 'MAX_TOKENS', FINISH_REASON_UNSPECIFIED: 'FINISH_REASON_UNSPECIFIED', SAFETY: 'SAFETY', RECITATION: 'RECITATION' },
  FunctionCallingConfigMode: { ANY: 'ANY', AUTO: 'AUTO', NONE: 'NONE' },
}));
jest.mock('@openai/agents', () => ({ run: jest.fn(), Agent: class {}, tool: (d: unknown) => d, webSearchTool: jest.fn() }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The gateway's inputs: the standard tools a capability step can reach —
// both capability tools, the read-only web tools, a browser task, a write —
// all exposed, so the allowlist is the only thing that narrows.
jest.mock('../../tools/standard-tools', () => ({
  STANDARD_TOOLS: [
    { name: 'capability_search', description: 'd', input_schema: { type: 'object', properties: {} } },
    { name: 'run_capability', description: 'd', input_schema: { type: 'object', properties: {} } },
    { name: 'web_search', description: 'd', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'web_fetch_advanced', description: 'd', input_schema: { type: 'object', properties: { url: { type: 'string' } } } },
    { name: 'web_research', description: 'd', input_schema: { type: 'object', properties: { question: { type: 'string' } } } },
    { name: 'web_task', description: 'd', input_schema: { type: 'object', properties: {} } },
    { name: 'note_save', description: 'd', input_schema: { type: 'object', properties: {} } },
  ],
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../integrations/web-fetch/expose-tools', () => ({
  buildExposedStandardTools: jest.fn(async (tools: unknown[]) => tools),
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn().mockReturnValue([]),
  listConnectorTypes: jest.fn().mockReturnValue([]),
  resolveEntityType: jest.fn(),
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifestsForAgent: jest.fn().mockResolvedValue([]),
    getManifests: jest.fn().mockResolvedValue([]),
  },
}));
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockPool = { query: mockQuery, connect: jest.fn(async () => ({ query: mockQuery, release: jest.fn() })) };
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => mockPool), getPool: jest.fn(() => mockPool), pool: mockPool,
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: jest.fn().mockReturnValue({}),
  getPrefetchThreadClient: jest.fn().mockReturnValue({}),
}));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
// The service's own construction.
jest.mock('../../streaming', () => ({
  streamingService: { emitAgentStatus: jest.fn(), emitStepResult: jest.fn(), emitHitlRequired: jest.fn(), emitHitlRejected: jest.fn() },
}));
jest.mock('../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    checkGate: jest.fn(), checkHitlGate: jest.fn().mockResolvedValue({ shouldGate: false }),
    getOversightSettings: jest.fn().mockResolvedValue({ communication: 'auto', sensitiveWork: {} }),
  },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));
jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: () => ({}), complete: jest.fn(), chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/service', () => ({ CoordinatorService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: () => ({}) }));
jest.mock('../../tool-gateway/service', () => ({
  ToolGatewayService: jest.fn().mockImplementation(() => ({ setCredentialService: jest.fn(), routeToolCall: jest.fn(), execute: jest.fn() })),
}));
jest.mock('../../tool-gateway/dispatcher', () => ({ getToolGatewayDispatcher: () => ({ guardExternal: async () => null }) }));
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({ updateRuntimeStatus: jest.fn(), getAgent: jest.fn() })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getFeatureFlags: jest.fn().mockResolvedValue({}), getEntitlements: jest.fn().mockResolvedValue({}),
  }),
}));
jest.mock('../../memory', () => ({ memoryService: { retrieve: jest.fn(), save: jest.fn() }, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: { getMessages: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../infrastructure/cloud-tasks', () => ({ enqueueAgentExecution: jest.fn() }));
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: { updateCloudTaskName: jest.fn(), markFiredByInvocationId: jest.fn(), markErrored: jest.fn() },
  mapRow: (row: Record<string, unknown>) => ({ id: row.id }),
}));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''), getTenantRuntimeUrl: jest.fn().mockReturnValue(''), tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
jest.mock('../../platform-callback/client', () => ({ getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn() }));
jest.mock('../../infrastructure/pubsub', () => ({ publisher: {} }));

// Only the gateway's knowledge-count call is answered here; everything else —
// the HTTP MCP transport below — reaches the real fetch.
const realFetch = global.fetch;
const mockFetch = jest.fn((url: unknown, init?: unknown) =>
  String(url).startsWith('http://platform-backend-test')
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ count: 0 }), text: async () => '' })
    : realFetch(url as string, init as RequestInit));
global.fetch = mockFetch as unknown as typeof fetch;

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentExecutionService } from '../service';
import type { ExecutionState } from '../types';
import type { McpToolCatalog, InProcessMcpServerConfig } from '../adapter/catalog-types';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../adapter/types';
import { buildAnthropicMcpServers } from '../adapter/anthropic/mcp-servers';
import { mcpToOpenAiFunctionTools, type BridgeContext } from '../adapter/mcp-bridge';
import { exposeCatalogOverHttp } from '../adapter/tool-gateway-http-mcp';
import { GeminiAdapter } from '../adapter/gemini';
import { webFallbackToolAllowlist } from '../engine/capability-step-prompt';

const EXPECTED = ['record_step_output', 'web_fetch_advanced', 'web_research', 'web_search'];

function prebuilt(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'liftoff-tool-gateway', config: { tools: [{ name: 'run_capability' }] } } as unknown as InProcessMcpServerConfig],
    tools: [{ name: 'run_capability', description: 'd', inputSchema: { type: 'object' }, serverId: 'liftoff-tool-gateway' }],
  };
}

function makeState(): ExecutionState {
  return {
    context: {
      tenantId: '11111111-1111-1111-1111-111111111111', agentId: '22222222-2222-2222-2222-222222222222',
      workflowId: 'wf', taskId: 'task', instructionVersion: 1,
      instruction: { systemPrompt: 's', allowedConnectors: [] } as unknown as ExecutionState['context']['instruction'],
      traceId: 'trace-1', agentType: 'workflow', hitlLevel: 0,
      modelConfig: { provider: 'anthropic' } as ExecutionState['context']['modelConfig'],
      execConfig: {}, memoryScope: {}, invocationId: 'inv-every-engine', integrations: [],
      prebuiltCatalog: prebuilt(),
    } as unknown as ExecutionState['context'],
    reasoningSteps: 0, toolCallsExecuted: 0, startTime: new Date(), steps: [], conversationHistory: [],
    pendingToolCalls: [], completedToolCalls: [], toolFailureCounts: new Map(), injectedSkillIds: [],
  };
}

const bridgeContext = (): BridgeContext => ({ tenantId: 't', invocationId: 'inv', hitlGate: null, anomalyHandler: null } as unknown as BridgeContext);

/** The one narrowed catalog, built the way the fallback turn builds it. */
async function narrowedCatalog(): Promise<McpToolCatalog> {
  process.env.PLATFORM_BACKEND_URL = 'http://platform-backend-test';
  process.env.PLATFORM_CALLBACK_TOKEN = 'tok';
  const { __resetKnowledgeExposureCache } = jest.requireActual('../../tool-gateway/knowledge-exposure-cache');
  __resetKnowledgeExposureCache();
  const service = new AgentExecutionService();
  return (service as unknown as {
    buildPlatformMcpCatalog: (_s: ExecutionState, _o: { stepOutputField?: string; stepOutputKeys?: string[]; toolAllowlist?: ReadonlySet<string> }) => Promise<McpToolCatalog>;
  }).buildPlatformMcpCatalog(makeState(), { stepOutputField: 'posts', stepOutputKeys: ['posts'], toolAllowlist: webFallbackToolAllowlist('posts') });
}

const names = (list: Array<{ name: string }>): string[] => list.map((t) => t.name).sort();

describe('the fallback catalog as registered on every supported engine', () => {
  let catalog: McpToolCatalog;
  beforeAll(async () => {
    catalog = await narrowedCatalog();
  });

  it('bypasses the prebuilt catalog and carries only the allowlisted tools, on one in-process server', () => {
    expect(names(catalog.tools)).toEqual(EXPECTED);
    expect(catalog.servers.map((s) => s.kind)).toEqual(['in-process']);
    const instance = (catalog.servers[0] as InProcessMcpServerConfig).config as unknown as { tools: Array<{ name: string }> };
    expect(names(instance.tools)).toEqual(EXPECTED);
  });

  it('claude-agent-sdk: the mounted server instance registers exactly those tools, and no other server', () => {
    const servers = buildAnthropicMcpServers(catalog) as Record<string, { tools: Array<{ name: string }> }>;
    expect(Object.keys(servers)).toEqual(['liftoff-tool-gateway']);
    expect(names(servers['liftoff-tool-gateway'].tools)).toEqual(EXPECTED);
  });

  it('openai-agents, openrouter-openai-wire, xai-openai-wire: the function tools are exactly those', () => {
    expect(names(mcpToOpenAiFunctionTools(catalog, bridgeContext()))).toEqual(EXPECTED);
  });

  it('google-genai: the function declarations are exactly those', async () => {
    generateContentMock.mockResolvedValue({ text: 'done', functionCalls: [] });
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(catalog);
    adapter.registerHitlGate(async () => ({ allow: true }));
    const events = adapter.invoke({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], systemPrompt: 's', model: 'gemini-3-pro-preview',
      provider: 'google', tenantId: 't1', invocationId: 'inv-g', maxTurns: 2,
    }, new AbortController().signal);
    for await (const _ of events) { /* drain */ }
    const req = generateContentMock.mock.calls[0][0] as { config?: { tools?: Array<{ functionDeclarations?: Array<{ name: string }> }> } };
    const declared = (req.config?.tools ?? []).flatMap((t) => t.functionDeclarations ?? []);
    expect(names(declared)).toEqual(EXPECTED);
  });

  it('google-adk: builds one FunctionTool per catalog.tools entry, and nothing else', () => {
    // The ADK SDK is ESM and is not loaded here; the adapter's tool source is
    // pinned at the line that builds them.
    const src = readFileSync(join(__dirname, '..', 'adapter', 'gemini-adk', 'index.ts'), 'utf8');
    expect(src).toContain('const tools = this.catalog.tools.map((t) => new FunctionTool({');
    expect(src).not.toMatch(/STANDARD_TOOLS|createToolGatewayMcpServer/);
  });

  it('openai-codex, opencode, google-gemini-cli: the HTTP-exposed server lists exactly those', async () => {
    const proxy = await exposeCatalogOverHttp(catalog, bridgeContext());
    try {
      const client = new Client({ name: 'engine', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: { authorization: `Bearer ${proxy.bearerToken}` } },
      });
      await client.connect(transport);
      const listed = await client.listTools();
      await client.close();
      expect(names(listed.tools)).toEqual(EXPECTED);
    } finally {
      await proxy.close();
    }
  });

  it('covers every resolvable engine id, so a new engine fails here until its path is covered', () => {
    const covered: Record<string, string> = {
      'claude-agent-sdk': 'in-process server instance',
      'openai-agents': 'mcpToOpenAiFunctionTools',
      'openrouter-openai-wire': 'mcpToOpenAiFunctionTools',
      'xai-openai-wire': 'mcpToOpenAiFunctionTools',
      'google-genai': 'functionDeclarations',
      'google-adk': 'FunctionTool per catalog.tools entry',
      'openai-codex': 'exposeCatalogOverHttp',
      'opencode': 'exposeCatalogOverHttp',
      'google-gemini-cli': 'exposeCatalogOverHttp',
    };
    expect([...RESOLVABLE_EXECUTION_ENGINE_IDS].sort()).toEqual(Object.keys(covered).sort());
  });
});
