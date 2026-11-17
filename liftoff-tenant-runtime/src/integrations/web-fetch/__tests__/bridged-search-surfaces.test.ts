// The bridged basic search has two surfaces, and one rule per surface.
//
// The MODEL's list withholds `web_search` where the run's engine attaches the
// vendor's own hosted search, so a model never sees two things called web
// search. The RUN's list — what validates and dispatches a deterministic
// `tool_call` step, what the governance gate classifies from, and what the
// recovery advisor is shown — offers it wherever a backend exists, because a
// step never calls the model and the vendor's search is attached only to the
// model's calls. One gate answers both; `surface` says which question is being
// asked.
//
// The second half of this file is the contract with the control plane: every
// name the distiller is told it may author as a `tool_call` step must resolve
// in the run catalog on every engine.

const mockGetAllVendorFlags = jest.fn();
const mockGetTenantConnectedWebVendors = jest.fn();
const mockIsVendorExcludedForTenant = jest.fn();
jest.mock('../global-flags', () => ({
  getAllVendorFlags: (...a: unknown[]) => mockGetAllVendorFlags(...a),
  isVendorExcludedForTenant: (...a: unknown[]) => mockIsVendorExcludedForTenant(...a),
}));
// The platform pane gate also asks whether the platform HOLDS the vendor's
// key; without this the gate fails closed and the pane tools vanish from the
// catalog for a reason unrelated to what this suite is about.
jest.mock('../web-tool-secrets', () => ({
  getTenantConnectedWebVendors: (...a: unknown[]) => mockGetTenantConnectedWebVendors(...a),
  getWebToolSecret: () => Promise.resolve('platform-key'),
}));

// ── Service harness for the third surface (mirrors catalog-schema-parity) ──
//
// The recovery advisor is reached through AgentExecutionService, so the
// service's construction-time dependencies are stubbed the way the parity
// suite stubs them. STANDARD_TOOLS is deliberately NOT mocked: the contract
// below is about the real definitions.
const mockComplete = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((name: string, description: string, inputSchema: unknown, handler: (..._args: unknown[]) => unknown) =>
    ({ name, description, inputSchema, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[]; name?: string }) =>
    ({ type: 'sdk', name: opts.name || 'test', tools: opts.tools })),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../streaming', () => ({
  streamingService: { emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
jest.mock('../../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
jest.mock('../../../hitl-enforcement', () => ({
  hitlEnforcementService: { checkGate: jest.fn() },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));
jest.mock('../../../llm/client', () => ({
  llmClient: {
    modelSelectionFor: (p: { model?: string; provider?: string } | undefined) =>
      (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})),
    complete: (...a: unknown[]) => mockComplete(...a),
    chat: jest.fn(),
  },
}));
jest.mock('../../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../../coordinator/service', () => ({ CoordinatorService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: () => ({}) }));
jest.mock('../../../tool-gateway/service', () => ({
  ToolGatewayService: jest.fn().mockImplementation(() => ({ setCredentialService: jest.fn(), routeToolCall: jest.fn() })),
}));
jest.mock('../../../tool-gateway/dispatcher', () => ({ getToolGatewayDispatcher: () => ({ execute: jest.fn() }) }));
jest.mock('../../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })),
}));
jest.mock('../../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({ updateRuntimeStatus: jest.fn() })),
}));
jest.mock('../../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../../entitlements-client/service', () => ({ getEntitlementsClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../../memory', () => ({ memoryService: { retrieve: jest.fn(), save: jest.fn() } }));
jest.mock('../../../invocations', () => ({ invocationsService: { getMessages: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../agent-execution/tool-interceptor', () => ({ interceptToolCalls: jest.fn((calls) => calls) }));
jest.mock('../../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifests: jest.fn().mockResolvedValue([]),
    getManifestsForAgent: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([]),
  listConnectorTypes: jest.fn().mockReturnValue([]),
}));
jest.mock('../../../browser-sessions/repository', () => ({ getActiveForThread: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../agent-chat/agent-slack-client', () => ({ listAgentSlackInstalls: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../agent-chat/agent-teams-client', () => ({ listAgentTeamsConversations: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../tool-gateway/knowledge-exposure-cache', () => ({ tenantHasBoundKnowledge: jest.fn().mockResolvedValue(false) }));
jest.mock('../../../infrastructure/cloud-tasks', () => ({ enqueueAgentExecution: jest.fn() }));
const mockPool = {
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: jest.fn() }),
};
jest.mock('../../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => mockPool),
  getPool: jest.fn(() => mockPool),
}));
jest.mock('../../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {},
  mapRow: (row: Record<string, unknown>) => row,
}));
jest.mock('../../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
// The prompt's content is not under test here, and building it screens
// untrusted text through a per-tenant gate this harness has no database for.
jest.mock('../../../agent-execution/engine/recovery-prompts', () => ({
  buildRecoveryPrompt: jest.fn().mockReturnValue('recovery prompt'),
}));
process.env.PLATFORM_BACKEND_URL = 'https://platform-backend.local';
process.env.PLATFORM_CALLBACK_TOKEN = 'test-token';
(globalThis as { fetch?: typeof fetch }).fetch = jest.fn().mockResolvedValue({
  ok: true, status: 200, json: async () => ({ agents: [] }),
}) as unknown as typeof fetch;

import { buildExposedStandardTools } from '../expose-tools';
import { AgentExecutionService } from '../../../agent-execution/service';
import type { ExecutionContext, ExecutionState } from '../../../agent-execution/types';
import { STANDARD_TOOLS } from '../../../tools/standard-tools';
import { engineHasNativeWebSearch } from '../../../agent-execution/adapter/native-web-search';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../../../agent-execution/adapter/types';
import type { ExecutionEngineId } from '../../../agent-execution/adapter/types';
import { validateWorkflowGraph } from '../../../agent-execution/validate-workflow-graph';
import type { WorkflowStep } from '../../../agent-execution/types';

const SEARCH = [{ name: 'web_search' }];

// Every platform flag on: the backend exists, so only the surface rule decides.
const platformOn = {
  webclaw: false, firecrawl: false, perplexity: true, anchor: false,
  browserbase: false, tavily: false, exa: false, openai: true, google: true,
  // The platform browser: what backs `run_browser_task` for a workspace that
  // connected no browser vendor of its own.
  browser_use: true, xai: true, steel: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTenantConnectedWebVendors.mockResolvedValue(new Set());
  mockIsVendorExcludedForTenant.mockResolvedValue(false);
  mockGetAllVendorFlags.mockResolvedValue({ ...platformOn });
});

function names(arr: Array<{ name: string }>) { return arr.map((t) => t.name).sort(); }

describe('the bridged web_search, by surface', () => {
  it('the run surface offers it on an engine that searches natively', async () => {
    const out = await buildExposedStandardTools(SEARCH, 'tenant-1', {
      surface: 'run', nativeWebSearch: true, provider: 'anthropic',
    });
    expect(names(out)).toEqual(['web_search']);
  });

  it('the model surface withholds it on an engine that searches natively', async () => {
    const out = await buildExposedStandardTools(SEARCH, 'tenant-1', {
      surface: 'model', nativeWebSearch: true, provider: 'anthropic',
    });
    expect(names(out)).toEqual([]);
  });

  it('the model surface offers it on an engine that does not', async () => {
    const out = await buildExposedStandardTools(SEARCH, 'tenant-1', {
      surface: 'model', nativeWebSearch: false, provider: 'xai',
    });
    expect(names(out)).toEqual(['web_search']);
  });

  it('neither surface offers it with no backend', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...platformOn, perplexity: false, xai: false });
    for (const surface of ['run', 'model'] as const) {
      for (const nativeWebSearch of [true, false]) {
        const out = await buildExposedStandardTools(SEARCH, 'tenant-1', {
          surface, nativeWebSearch, provider: 'anthropic',
        });
        expect({ surface, nativeWebSearch, names: names(out) })
          .toEqual({ surface, nativeWebSearch, names: [] });
      }
    }
  });

  it('an unstated surface behaves as the model surface', async () => {
    expect(names(await buildExposedStandardTools(SEARCH, 'tenant-1', { nativeWebSearch: true }))).toEqual([]);
    expect(names(await buildExposedStandardTools(SEARCH, 'tenant-1', { nativeWebSearch: false }))).toEqual(['web_search']);
  });
});

// The distill contract. These six names are what platform-backend's
// `src/internal-agents/platform-web-tools.ts` (PLATFORM_WEB_TOOLS) advertises
// to the distiller and the Chief AI Officer as authorable `tool_call` steps,
// with no connector or vendor binding required. A name on that list that the
// run catalog cannot resolve on some engine is a step the platform invited and
// then degraded — which is what happened to `web_search` on every engine that
// searches natively. The list is copied here rather than imported because the
// two repositories do not share it; the comment on the other end names this
// file.
const PLATFORM_WEB_TOOL_NAMES = [
  'web_search',
  'web_research',
  'web_fetch_advanced',
  'web_deep_research',
  'web_people_search',
  'web_finance_search',
  // The team's own browser, on a run with no thread: a scheduled run may open
  // one for its lifetime under the team's profile.
  'run_browser_task',
] as const;

/** A well-formed input for each advertised tool, so the only question the
 *  validator can raise about the step is whether its name resolves. */
const STEP_INPUT: Record<(typeof PLATFORM_WEB_TOOL_NAMES)[number], Record<string, unknown>> = {
  web_search: { query: 'q' },
  web_research: { question: 'q' },
  web_fetch_advanced: { url: 'https://example.com' },
  web_deep_research: { question: 'q' },
  web_people_search: { query: 'q' },
  web_finance_search: { query: 'q' },
  run_browser_task: { prompt: 'open https://example.com and read the heading' },
};

/** A model each engine can be asked about. The Responses-API check on the
 *  Agents SDK bridge is the only engine whose answer depends on the model. */
function modelFor(engine: ExecutionEngineId): string {
  return engine === 'openai-agents' ? 'gpt-5.5' : 'any-model';
}

describe('every tool the distiller may author resolves in the run catalog on every engine', () => {
  // Exhaustive over the resolvable engines, the same way engineHasNativeWebSearch
  // is exhaustive over the union: a new engine is covered on arrival.
  it.each(RESOLVABLE_EXECUTION_ENGINE_IDS.map((e) => [e] as const))('%s', async (engine) => {
    const nativeWebSearch = engineHasNativeWebSearch(engine, modelFor(engine));
    const runCatalog = await buildExposedStandardTools(STANDARD_TOOLS, 'tenant-1', {
      surface: 'run',
      nativeWebSearch,
      provider: engine === 'xai-openai-wire' ? 'xai' : 'anthropic',
      // A scheduled run: no thread, no person, the team's own browser.
      autonomousRun: true,
    });
    const availableToolNames = new Set(runCatalog.map((t) => t.name));
    for (const name of PLATFORM_WEB_TOOL_NAMES) expect(availableToolNames).toContain(name);

    const steps: WorkflowStep[] = PLATFORM_WEB_TOOL_NAMES.map((toolName, i) => ({
      stepId: `s${i + 1}`,
      type: 'tool_call' as const,
      toolName,
      toolInput: STEP_INPUT[toolName],
      description: `call ${toolName}`,
      onSuccess: i + 1 < PLATFORM_WEB_TOOL_NAMES.length ? `s${i + 2}` : undefined,
    }));
    const errors = validateWorkflowGraph(steps, availableToolNames);
    expect(errors.filter((e) => e.code === 'UNRESOLVABLE_TOOL')).toEqual([]);
  });

  it('is not vacuous: the model surface on a native-search engine would have failed the web_search step', async () => {
    const modelCatalog = await buildExposedStandardTools(STANDARD_TOOLS, 'tenant-1', {
      surface: 'model', nativeWebSearch: true, provider: 'anthropic',
    });
    const errors = validateWorkflowGraph(
      [{ stepId: 's1', type: 'tool_call', toolName: 'web_search', toolInput: { query: 'q' }, description: 'search' }],
      new Set(modelCatalog.map((t) => t.name)),
    );
    expect(errors.map((e) => e.code)).toContain('UNRESOLVABLE_TOOL');
  });
});

// The third run-side surface. The recovery advisor is a model call, but it is
// made through the ordinary LLM client on the platform default provider, which
// attaches no hosted search, and what it is shown is the RUN's executable
// catalog so that it can propose a corrected `continue` call. `web_search`
// belongs in that list on every engine, including the ones whose own model
// turns search natively.
describe('the recovery advisor sees the run catalog', () => {
  function context(): ExecutionContext {
    return {
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      workflowId: 'wf-1',
      taskId: 'task-1',
      instructionVersion: 1,
      instruction: {
        systemPrompt: 'test',
        allowedConnectors: [],
        allowedActionTypes: ['*'],
        allowedTools: ['*'],
        writeScopes: [],
        userInstructions: '',
      } as unknown as ExecutionContext['instruction'],
      traceId: 'trace-1',
      agentType: 'agent',
      hitlLevel: 0,
      modelConfig: {} as ExecutionContext['modelConfig'],
      execConfig: {},
      memoryScope: {},
      integrations: [],
      sandboxCapabilities: [],
      threadId: 'thread-1',
      invocationId: 'inv-1',
      // An engine that searches natively: Claude on the Agent SDK.
      resolvedProvider: 'anthropic',
      workflowSteps: [{ stepId: 's1', type: 'tool_call', toolName: 'web_search', description: 'search' }],
    } as unknown as ExecutionContext;
  }

  it('hands llmClient.complete a tool list that contains web_search on a native-search engine', async () => {
    mockComplete.mockResolvedValue({ content: '', toolCalls: [], usage: {} });
    const service = new AgentExecutionService();
    const state: ExecutionState = {
      context: context(),
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
    const step = state.context.workflowSteps![0];
    await (service as unknown as {
      invokeRecoveryLLM: (..._a: unknown[]) => Promise<unknown>;
    }).invokeRecoveryLLM(state, step, undefined, { kind: 'tool_error', step, error: 'boom' }, [], 0, 0);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const request = mockComplete.mock.calls[0][0] as { tools: Array<{ name: string }> };
    const toolNames = request.tools.map((t) => t.name);
    expect(toolNames).toContain('web_search');
    // The decision tool rides beside the catalog, as before.
    expect(toolNames).toContain('recovery_decision');
  });
});
