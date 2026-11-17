// runAdapterHitlGate Finding B case 1 — communication-mode wrap fallback.
//
// Reproduces the silent HITL bypass: configuration where checkHitlGate
// does NOT fire (e.g. escalation='exceptions') but the catalog filter's
// wrap_with_hitl WOULD fire at execute time. Pre-fix, the catalog wrap's
// HitlGateError throw is swallowed by the in-process McpServer
// (@modelcontextprotocol/sdk/server/mcp.js:138-145) and surfaced to the
// LLM as a tool error — no approval, silent bypass.
//
// Post-fix, runAdapterHitlGate calls `maybeConvertToDraft` after
// checkHitlGate clears the call. If it throws HitlGateError, that's the
// "catalog wrap would fire" signal — surface as a hitlPause so the
// adapter emits pause_requested(hitl_gate) BEFORE the handler runs.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const checkHitlGateMock = jest.fn().mockResolvedValue({ shouldGate: false });
jest.mock('../../hitl-enforcement', () => {
  const actualTypes = jest.requireActual('../../hitl-enforcement/types');
  return {
    hitlEnforcementService: {
      checkHitlGate: (...a: unknown[]) => checkHitlGateMock(...a),
      getOversightSettings: jest.fn(),
      createApprovalRequest: jest.fn(),
    },
    HitlGateError: actualTypes.HitlGateError,
    ModelTool: {},
  };
});

jest.mock('../adapter', () => ({
  createAdapter: jest.fn().mockReturnValue({
    invoke: jest.fn(), pause: jest.fn(), resume: jest.fn(),
    registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(), registerAnomalyHandler: jest.fn(),
  }),
}));

const checkAdmissionMock = jest.fn().mockResolvedValue({ allowed: true });
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: checkAdmissionMock })),
}));

jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({
  // The gate asks the dispatcher to judge every vendor-hosted tool before the
  // SDK runs it. Null is "proceed", which is what these cases are about.
  getToolGatewayDispatcher: jest.fn().mockReturnValue({ guardExternal: async () => null }),
}));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''),
  getTenantRuntimeUrl: jest.fn().mockReturnValue(''),
  tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
jest.mock('../../agent-lifecycle/service', () => ({ AgentLifecycleService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
  getPool: jest.fn(),
  pool: { query: jest.fn() },
}));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getFeatureFlags: jest.fn().mockResolvedValue({}), getEntitlements: jest.fn().mockResolvedValue({}),
  }),
}));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: {} }));
jest.mock('../../streaming', () => ({ streamingService: { emitHitlRequired: jest.fn() } }));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../agent-lifecycle/types', () => ({ trustLevelFor: jest.fn().mockReturnValue('trusted') }));
jest.mock('../run-state/service', () => ({ agentRunStateService: {} }));
jest.mock('../untrusted-input', () => ({
  formatInputForPrompt: jest.fn(), formatUntrustedSystemPromptDirective: jest.fn().mockReturnValue(''),
}));
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: jest.fn().mockResolvedValue([]), buildSkillContextBlock: jest.fn().mockReturnValue(''),
}));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: {} }));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn() }));
jest.mock('../../infrastructure/pubsub', () => ({ publisher: {} }));
jest.mock('../../interactive-chat/system-prompt', () => ({ getHitlDescription: jest.fn().mockReturnValue('') }));
jest.mock('../../connectors/connector-service-client', () => ({
  getPrefetchThreadClient: jest.fn().mockReturnValue({}),
  getConnectorServiceClient: jest.fn().mockReturnValue({
    listTenantConnectors: jest.fn().mockResolvedValue({ connectors: [] }),
    listManifests: jest.fn().mockResolvedValue({ manifests: [] }),
  }),
}));

import { AgentExecutionService } from '../service';
import type { ExecutionState, ExecutionContext } from '../types';
import type { McpToolCatalog } from '../adapter';

function makeState(overrides?: Partial<ExecutionContext>): ExecutionState {
  return {
    context: {
      tenantId: 't1', agentId: 'a1', workflowId: 'wf1', taskId: 'tk1',
      instructionVersion: 1,
      instruction: { systemPrompt: 's', allowedConnectors: [] } as ExecutionContext['instruction'],
      traceId: 'tr-1', agentType: 'agent',
      hitlLevel: 3,
      modelConfig: { provider: 'anthropic' } as ExecutionContext['modelConfig'],
      execConfig: {} as ExecutionContext['execConfig'],
      memoryScope: {} as ExecutionContext['memoryScope'],
      threadId: 'thread-1', invocationId: 'inv-1',
      oversight: {
        tenantId: 't1', autonomy: 'controlled', escalation: 'exceptions',
        sensitiveWork: {
          customerCommunication: false, financialActions: false, dataChanges: false,
          externalPublishing: false, hiringDecisions: false,
        },
        communication: 'draft',
      },
      ...overrides,
    } as ExecutionContext,
    reasoningSteps: 0, toolCallsExecuted: 0,
    startTime: new Date(), steps: [],
    conversationHistory: [], pendingToolCalls: [], completedToolCalls: [],
    toolFailureCounts: new Map(), injectedSkillIds: [],
  } as ExecutionState;
}

const slackOutboundCatalog: McpToolCatalog = {
  servers: [],
  tools: [{
    name: 'agent_slack__slack_send_message',
    description: 'Send a Slack message',
    inputSchema: {},
    serverId: 'agent_slack',
    // Slack outbound has NO draftVariant (Slack Web API has no draft endpoint),
    // so the catalog filter would mark this wrap_with_hitl and the handler
    // would throw HitlGateError at execute time — which McpServer swallows.
    categories: ['outbound', 'customerCommunication'],
    draftVariant: undefined,
  }],
};

beforeEach(() => {
  jest.clearAllMocks();
  checkAdmissionMock.mockResolvedValue({ allowed: true });
  checkHitlGateMock.mockResolvedValue({ shouldGate: false });
});

/** A LEAF run's catalog: filterToolsForRole has already stripped the
 *  orchestration tools from `tools`, and the role rides on the catalog. */
const leafCatalog: McpToolCatalog = {
  servers: [],
  tools: [{
    name: 'web_research',
    description: 'Research',
    inputSchema: {},
    serverId: 'liftoff-tool-gateway',
    categories: ['read'],
  }],
  delegationRole: 'leaf',
} as unknown as McpToolCatalog;

describe('runAdapterHitlGate — a leaf run may not start more work', () => {
  it('DENIES an orchestration tool with a message the model can act on, instead of failing the run', async () => {
    // The failure this pins: filterToolsForRole strips these tools from the
    // catalog list, but claude-agent-sdk never reads that list -- it is handed
    // the in-process McpServer instance -- so the model still sees the tool and
    // calls it. Resolution then misses a list the tool was deliberately removed
    // from, throws UnresolvedToolError, and kills the whole invocation -- a
    // customer's turn dying moments after the tool was "withheld".
    //
    // A deny is what makes the rule usable: the model reads the reason as a tool
    // error and does the work itself, which is the entire point of the rule.
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as {
      runAdapterHitlGate(
        state: ExecutionState, catalog: McpToolCatalog,
        toolName: string, args: unknown, label: string,
      ): Promise<{ allow: boolean; reason?: string }>;
    }).runAdapterHitlGate(
      makeState(), leafCatalog,
      'mcp__liftoff-tool-gateway__delegate_to_agent', { teammate: 'X', objective: 'y' }, 'conv',
    );

    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/child task does the work rather than handing it on/i);
  });

  it('denies a per-teammate hand-off tool for a leaf too', async () => {
    // internal__<alias>__execute is delegation wearing a different name. A leaf
    // stripped of the generic tool but left holding one bespoke tool per
    // teammate is not a boundary at all.
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as {
      runAdapterHitlGate(
        state: ExecutionState, catalog: McpToolCatalog,
        toolName: string, args: unknown, label: string,
      ): Promise<{ allow: boolean; reason?: string }>;
    }).runAdapterHitlGate(
      makeState(), leafCatalog,
      'mcp__liftoff-tool-gateway__internal__code_reviewer__execute', { objective: 'y' }, 'conv',
    );

    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/child task does the work/i);
  });

  it('leaves an ORCHESTRATOR run free to delegate', async () => {
    // An orchestrator's catalog KEEPS the orchestration tools -- filterToolsForRole
    // strips them only for a leaf -- so the fixture carries it, as a real one would.
    const orchestratorCatalog = {
      ...leafCatalog,
      tools: [
        ...leafCatalog.tools,
        {
          name: 'delegate_to_agent',
          description: 'Hand a task to a teammate',
          inputSchema: {},
          serverId: 'liftoff-tool-gateway',
          categories: [],
        },
      ],
      delegationRole: 'orchestrator',
    } as unknown as McpToolCatalog;
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as {
      runAdapterHitlGate(
        state: ExecutionState, catalog: McpToolCatalog,
        toolName: string, args: unknown, label: string,
      ): Promise<{ allow: boolean; reason?: string }>;
    }).runAdapterHitlGate(
      makeState(), orchestratorCatalog,
      'mcp__liftoff-tool-gateway__delegate_to_agent', { teammate: 'X', objective: 'y' }, 'conv',
    );

    // `?? ''` because an allowed call carries no reason at all, which is the point.
    expect(result.reason ?? '').not.toMatch(/child task does the work/i);
  });

  it('does not deny an ordinary tool for a leaf', async () => {
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as {
      runAdapterHitlGate(
        state: ExecutionState, catalog: McpToolCatalog,
        toolName: string, args: unknown, label: string,
      ): Promise<{ allow: boolean; reason?: string }>;
    }).runAdapterHitlGate(
      makeState(), leafCatalog, 'mcp__liftoff-tool-gateway__web_research', { q: 'x' }, 'conv',
    );

    // `?? ''` because an allowed call carries no reason at all, which is the point.
    expect(result.reason ?? '').not.toMatch(/child task does the work/i);
  });
});

describe('runAdapterHitlGate — communication-mode wrap fallback (Finding B case 1)', () => {
  it('signals hitlPause for an outbound wrap_with_hitl tool when checkHitlGate would not have fired', async () => {
    // Configuration that reproduces the silent bypass:
    //   communication='draft' (catalog filter wraps outbound with HitlGateError)
    //   escalation='exceptions' (checkHitlGate's sensitive_work section doesn't fire)
    //   hitlLevel=3 (no level-1/2 destructive gate)
    //   sensitiveWork all false (no name-based merge gate, no sensitive_work)
    //
    // Pre-fix: checkHitlGate returns shouldGate:false → adapter allows
    //         → handler throws HitlGateError → McpServer swallows → tool error → LLM continues.
    // Post-fix: maybeConvertToDraft throws → hitlPause signal → adapter emits pause_requested.
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as {
      runAdapterHitlGate(
        state: ExecutionState, catalog: McpToolCatalog,
        toolName: string, args: unknown, label: string,
      ): Promise<{ allow: boolean; hitlPause?: { gateReason: string } }>;
    }).runAdapterHitlGate(makeState(), slackOutboundCatalog, 'agent_slack__slack_send_message',
      { channel: 'C1', text: 'hi' }, 'conv');

    expect(result.allow).toBe(false);
    expect(result.hitlPause).toBeDefined();
    expect(result.hitlPause!.gateReason).toBe('communication_review');
    // checkHitlGate was consulted FIRST and returned no-gate. Confirms the
    // fallback path (not the existing checkHitlGate signal).
    expect(checkHitlGateMock).toHaveBeenCalled();
  });

  it('still admits non-outbound tools (no over-trigger)', async () => {
    const readOnlyCatalog: McpToolCatalog = {
      servers: [],
      tools: [{
        name: 'gmail__list_messages',
        description: 'Read messages',
        inputSchema: {},
        serverId: 'gmail',
        categories: ['read'],  // not outbound
      }],
    };

    const svc = new AgentExecutionService();
    const result = await (svc as unknown as {
      runAdapterHitlGate(
        state: ExecutionState, catalog: McpToolCatalog,
        toolName: string, args: unknown, label: string,
      ): Promise<{ allow: boolean }>;
    }).runAdapterHitlGate(makeState(), readOnlyCatalog, 'gmail__list_messages', {}, 'conv');

    expect(result.allow).toBe(true);
  });

  it('still admits outbound tools when communication="auto" (no wrap)', async () => {
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as {
      runAdapterHitlGate(
        state: ExecutionState, catalog: McpToolCatalog,
        toolName: string, args: unknown, label: string,
      ): Promise<{ allow: boolean }>;
    }).runAdapterHitlGate(
      makeState({
        oversight: {
          tenantId: 't1', autonomy: 'balanced', escalation: 'exceptions',
          sensitiveWork: {
            customerCommunication: false, financialActions: false, dataChanges: false,
            externalPublishing: false, hiringDecisions: false,
          },
          communication: 'auto',
        },
      }),
      slackOutboundCatalog, 'agent_slack__slack_send_message',
      { channel: 'C1', text: 'hi' }, 'conv',
    );

    expect(result.allow).toBe(true);
  });

  it('does not over-trigger when the tool is not in the catalog (e.g. vendor-MCP tool unknown to us)', async () => {
    // The catalog.tools.find returns undefined → skip the fallback check.
    // This is intentional: vendor-MCP tools aren't in modelTools and can't be
    // run through maybeConvertToDraft (no categories to evaluate). The merge-to-main
    // path in checkHitlGate (#2) catches GitHub MCP merge tools by name instead.
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as {
      runAdapterHitlGate(
        state: ExecutionState, catalog: McpToolCatalog,
        toolName: string, args: unknown, label: string,
      ): Promise<{ allow: boolean }>;
    }).runAdapterHitlGate(makeState(), slackOutboundCatalog,
      'unknown__vendor_mcp_tool', {}, 'conv');

    expect(result.allow).toBe(true);
  });
});

describe('runAdapterHitlGate — the invocation itself is not a tool', () => {
  // The wire engines register this gate as an agent-level input guardrail as
  // well, and call it once at the door with a synthetic name and the whole
  // input as its arguments. Every check past admission is about a TOOL — its
  // effect, its category, its provenance — and the external-content gate fails
  // CLOSED on a missing effect. So on a wire engine every untrusted-inbound run
  // would pause for approval before it had done anything, while the same agent
  // on Anthropic — which has no agent-level guardrail — proceeds to per-tool
  // gating. An agent moved from Anthropic to a wire engine could then not do
  // its work at all.
  it('answers admission only for the agent-level guardrail, and never per-tool oversight', async () => {
    checkHitlGateMock.mockClear();
    const { AGENT_INVOCATION_GATE_NAME } = jest.requireActual('../adapter/types');
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as {
      runAdapterHitlGate(
        state: ExecutionState, catalog: McpToolCatalog,
        toolName: string, args: unknown, label: string,
      ): Promise<{ allow: boolean }>;
    }).runAdapterHitlGate(makeState(), slackOutboundCatalog,
      AGENT_INVOCATION_GATE_NAME, { some: 'input' }, 'conv');

    expect(result.allow).toBe(true);
    // The per-tool chain was NOT consulted for a name that is not a tool. If it
    // were, an untrusted-inbound run would be gated at the door regardless of
    // what it went on to do.
    expect(checkHitlGateMock).not.toHaveBeenCalled();
  });

  it('still refuses the invocation when admission does', async () => {
    // Admission is the one question the door CAN answer, and it must keep
    // answering it: a suspended tenant's run stops here, before anything runs.
    checkAdmissionMock.mockResolvedValueOnce({ allowed: false, reason: 'suspended' });
    const { AGENT_INVOCATION_GATE_NAME } = jest.requireActual('../adapter/types');
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as {
      runAdapterHitlGate(
        state: ExecutionState, catalog: McpToolCatalog,
        toolName: string, args: unknown, label: string,
      ): Promise<{ allow: boolean; reason?: string }>;
    }).runAdapterHitlGate(makeState(), slackOutboundCatalog,
      AGENT_INVOCATION_GATE_NAME, {}, 'conv');
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('suspended');
  });
});
