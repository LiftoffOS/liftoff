// Conversational outer loop — pause_requested(hitl_gate) creates approval
// and persists hitl_approval pause.
//
// adapter (Anthropic canUseTool stash + post-loop emit, or OpenAI
// mcp-bridge stash + abort) yields pause_requested with reason='hitl_gate'
// and gateContext, the conversational outer loop branches on the gate
// path — calls createApprovalRequest, fires side effects, and writes the
// hitl_approval pause via createHitlPause (NOT createClarificationPause).
//
// This is the LOAD-BEARING fix for Finding 1 (autonomous conversational
// agents previously never raised approvals at all).

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const createApprovalRequestMock = jest.fn();
const getOversightSettingsMock = jest.fn();
const checkHitlGateMock = jest.fn();
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    createApprovalRequest: (...a: unknown[]) => createApprovalRequestMock(...a),
    getOversightSettings: (...a: unknown[]) => getOversightSettingsMock(...a),
    checkHitlGate: (...a: unknown[]) => checkHitlGateMock(...a),
  },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));

const queryMock = jest.fn().mockResolvedValue({ rows: [{ id: 'sched-1' }], rowCount: 1 });
const poolMock = { query: queryMock, connect: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => poolMock),
  getPool: jest.fn(() => poolMock),
  pool: poolMock,
}));

const updateRuntimeStatusMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: updateRuntimeStatusMock,
    getAgent: jest.fn().mockResolvedValue({ lifecycle: 'ACTIVE' }),
  })),
}));

const enqueueAgentExecutionMock = jest.fn().mockResolvedValue({ taskName: 't' });
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: (...a: unknown[]) => enqueueAgentExecutionMock(...a),
}));
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: { updateCloudTaskName: jest.fn() },
}));

jest.mock('../../audit', () => ({ insertAuditLog: jest.fn() }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../streaming', () => ({
  streamingService: {
    emitHitlRequired: jest.fn(),
    emitHitlRejected: jest.fn(),
    emitToolStart: jest.fn(),
    emitToolComplete: jest.fn(),
    emitToolError: jest.fn(),
  },
}));
jest.mock('../../agent-chat/agent-slack-client', () => ({
  postReviewDm: jest.fn(),
  listAgentAssignees: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../tool-gateway/agent-slack-tool-catalog', () => ({
  SLACK_OUTBOUND_TOOL_NAMES: new Set(),
}));

// adapter module — return a stubbed adapter whose invoke yields one
// pause_requested(hitl_gate, gateContext) and then completes.
const adapterInvokeMock = jest.fn();
const adapterRegisterToolCatalogMock = jest.fn();
const adapterRegisterHitlGateMock = jest.fn();
const adapterRegisterAnomalyHandlerMock = jest.fn();
const adapterPauseMock = jest.fn().mockResolvedValue({ adapterKind: 'anthropic', serialized: 'tok' });
jest.mock('../adapter', () => ({
  createAdapter: jest.fn().mockReturnValue({
    invoke: adapterInvokeMock,
    pause: adapterPauseMock,
    resume: jest.fn(),
    registerToolCatalog: adapterRegisterToolCatalogMock,
    registerHitlGate: adapterRegisterHitlGateMock,
    registerAnomalyHandler: adapterRegisterAnomalyHandlerMock,
  }),
}));

// Other constructor deps — no-op
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
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getFeatureFlags: jest.fn().mockResolvedValue({}),
    getEntitlements: jest.fn().mockResolvedValue({}),
  }),
}));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: {} }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../agent-lifecycle/types', () => ({ trustLevelFor: jest.fn().mockReturnValue('trusted') }));
jest.mock('../run-state/service', () => ({ agentRunStateService: {} }));
jest.mock('../untrusted-input', () => ({
  formatInputForPrompt: jest.fn(),
  formatUntrustedSystemPromptDirective: jest.fn().mockReturnValue(''),
}));
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: jest.fn().mockResolvedValue([]),
  buildSkillContextBlock: jest.fn().mockReturnValue(''),
  skillDisclosureMode: jest.fn().mockReturnValue('inline'),
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

function makeState(): ExecutionState {
  return {
    context: {
      tenantId: 't1', agentId: 'a1', workflowId: 'wf1', taskId: 'tk1',
      instructionVersion: 1,
      instruction: { systemPrompt: 's', allowedConnectors: [] } as ExecutionContext['instruction'],
      traceId: 'tr-1',
      agentType: 'agent',
      hitlLevel: 3,
      modelConfig: { provider: 'anthropic' } as ExecutionContext['modelConfig'],
      execConfig: {} as ExecutionContext['execConfig'],
      memoryScope: {} as ExecutionContext['memoryScope'],
      threadId: 'thread-1',
      invocationId: 'inv-1',
      oversight: { communication: 'review' } as ExecutionContext['oversight'],
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
  } as ExecutionState;
}

const gateContext = {
  gateReason: 'communication_review',
  pendingToolCalls: [{ id: 'p1', name: 'gmail__send_email', input: { to: 'x@y.com' } }],
  matchedCategory: 'externalPublishing',
};

beforeEach(() => {
  jest.clearAllMocks();
  createApprovalRequestMock.mockResolvedValue({ id: 'appr-1', expiresAt: new Date() });
  getOversightSettingsMock.mockResolvedValue({ communication: 'review', sensitiveWork: {} });
  checkHitlGateMock.mockResolvedValue({ shouldGate: false });
  queryMock.mockResolvedValue({ rows: [{ id: 'sched-1' }], rowCount: 1 });
  // Adapter yields one pause_requested(hitl_gate, gateContext) then ends.
  adapterInvokeMock.mockImplementation(async function* () {
    yield {
      type: 'pause_requested',
      reason: 'hitl_gate',
      token: { adapterKind: 'anthropic', serialized: 'tok' },
      gateContext,
    };
  });
});

describe('runConversationalTurnsViaAdapter — pause_requested(hitl_gate) branch', () => {
  it('creates an approval row + writes a hitl_approval pause (NOT a clarification pause)', async () => {
    const svc = new AgentExecutionService();
    // buildPlatformMcpCatalog hits a lot of dependencies; stub it.
    (svc as unknown as { buildPlatformMcpCatalog: (...a: unknown[]) => Promise<unknown> }).buildPlatformMcpCatalog =
      jest.fn().mockResolvedValue({ servers: [], tools: [] });
    (svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }).buildToolsSchema =
      jest.fn().mockResolvedValue([]);

    const state = makeState();
    // The conversational loop receives the adapter as a parameter.
    const stubAdapter = {
      invoke: adapterInvokeMock,
      pause: adapterPauseMock,
      resume: jest.fn(),
      registerToolCatalog: adapterRegisterToolCatalogMock,
      registerHitlGate: adapterRegisterHitlGateMock,
      registerAnomalyHandler: adapterRegisterAnomalyHandlerMock,
    };
    const result = await (svc as unknown as {
      runConversationalTurnsViaAdapter: (
        state: ExecutionState,
        objective: string,
        inputData: Record<string, unknown> | undefined,
        adapter: unknown,
        resumeState?: unknown,
      ) => Promise<{ success: boolean; paused?: boolean }>;
    }).runConversationalTurnsViaAdapter(state, 'test', undefined, stubAdapter, undefined);

    // Approval row must have been created with the gateContext's
    // pendingToolCalls + gateReason.
    expect(createApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(createApprovalRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1',
      agentId: 'a1',
      pendingToolCalls: gateContext.pendingToolCalls,
      reason: 'communication_review',
    }));

    // The persisted pause row must be a hitl_approval pause carrying
    // hitlContext (approvalId stamped + pendingToolCalls + adapterResumeToken).
    const inserts = queryMock.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_scheduled_invocations'),
    );
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    const insertValues = inserts[0][1] as unknown[];
    const persistedPayload = JSON.parse(insertValues[8] as string) as {
      pauseReason: string;
      hitlContext?: { approvalId: string; pendingToolCalls: unknown[]; adapterResumeToken?: unknown };
    };
    expect(persistedPayload.pauseReason).toBe('hitl_approval');
    expect(persistedPayload.hitlContext?.approvalId).toBe('appr-1');
    expect(persistedPayload.hitlContext?.pendingToolCalls).toEqual(gateContext.pendingToolCalls);
    expect(persistedPayload.hitlContext?.adapterResumeToken).toBeDefined();

    // Agent lifecycle moved to WAITING_FOR_HUMAN.
    expect(updateRuntimeStatusMock).toHaveBeenCalledWith('a1', 'WAITING_FOR_HUMAN');

    // Returned paused result.
    expect(result.paused).toBe(true);
  });
});
