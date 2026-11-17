// Workflow llm_reason step — outer catch on AdapterPauseRequestedError(hitl_gate).
//
// llm_reason workflow step's adapter throws AdapterPauseRequestedError
// with pauseReason='hitl_gate' and gateContext (the registered hitlGate
// signalled an oversight pause), the workflow's outer hybrid loop catch
// creates the approval row, fires side effects, and persists a
// hitl_approval pause with full hitlContext.
//
// The conv-hitl-pause sibling test covers the empty-workflow conversational
// path; this one covers the workflow-step llm_reason path.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const createApprovalRequestMock = jest.fn();
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    createApprovalRequest: (...a: unknown[]) => createApprovalRequestMock(...a),
    getOversightSettings: jest.fn().mockResolvedValue({ communication: 'review', sensitiveWork: {} }),
    checkHitlGate: jest.fn().mockResolvedValue({ shouldGate: false }),
  },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));

const queryMock = jest.fn().mockImplementation(async (sql: string) => {
  // The user-interrupt check happens at every step boundary — it queries
  // agent_invocation_signals. Returning rows there sends the loop into
  // recovery instead of executing the step; force empty.
  if (typeof sql === 'string' && sql.includes('agent_invocation_signals')) {
    return { rows: [], rowCount: 0 };
  }
  // INSERT INTO agent_scheduled_invocations ... RETURNING id
  if (typeof sql === 'string' && sql.includes('INSERT INTO agent_scheduled_invocations')) {
    return { rows: [{ id: 'sched-1' }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});
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

jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: jest.fn().mockResolvedValue({ taskName: 't' }),
}));
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: { updateCloudTaskName: jest.fn() },
}));

jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../streaming', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitHitlRejected: jest.fn() },
}));
jest.mock('../../agent-chat/agent-slack-client', () => ({
  postReviewDm: jest.fn(),
  listAgentAssignees: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../tool-gateway/agent-slack-tool-catalog', () => ({
  SLACK_OUTBOUND_TOOL_NAMES: new Set(),
}));

jest.mock('../adapter', () => ({
  createAdapter: jest.fn().mockReturnValue({
    invoke: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    registerToolCatalog: jest.fn(),
    registerHitlGate: jest.fn(),
    registerAnomalyHandler: jest.fn(),
  }),
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
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getFeatureFlags: jest.fn().mockResolvedValue({}), getEntitlements: jest.fn().mockResolvedValue({}),
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
import { AdapterPauseRequestedError } from '../types';
import type { ExecutionContext, ExecutionState, WorkflowStep } from '../types';

const gateContext = {
  gateReason: 'communication_review',
  pendingToolCalls: [{ id: 'p1', name: 'gmail__send_email', input: { to: 'x@y.com' } }],
  matchedCategory: 'externalPublishing',
};

const resumeToken = { adapterKind: 'anthropic', serialized: 'tok' };

const llmStep: WorkflowStep = {
  stepId: 'step-1',
  type: 'llm_reason',
  prompt: 'do the thing',
} as WorkflowStep;

function makeState(): ExecutionState {
  return {
    context: {
      tenantId: 't1', agentId: 'a1', workflowId: 'wf1', taskId: 'tk1',
      instructionVersion: 1,
      instruction: { systemPrompt: 's', allowedConnectors: [] } as ExecutionContext['instruction'],
      traceId: 'tr-1',
      agentType: 'workflow',
      hitlLevel: 3,
      modelConfig: { provider: 'anthropic' } as ExecutionContext['modelConfig'],
      execConfig: {} as ExecutionContext['execConfig'],
      memoryScope: {} as ExecutionContext['memoryScope'],
      threadId: 'thread-1',
      invocationId: 'inv-1',
      workflowSteps: [llmStep],
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

beforeEach(() => {
  jest.clearAllMocks();
  createApprovalRequestMock.mockResolvedValue({ id: 'appr-1', expiresAt: new Date() });
  // Restore the SQL-aware default; jest.clearAllMocks wipes mockImplementation.
  queryMock.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('agent_invocation_signals')) {
      return { rows: [], rowCount: 0 };
    }
    if (typeof sql === 'string' && sql.includes('INSERT INTO agent_scheduled_invocations')) {
      return { rows: [{ id: 'sched-1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});

describe('workflow outer catch — AdapterPauseRequestedError(hitl_gate)', () => {
  it('creates an approval and writes a hitl_approval pause with hitlContext', async () => {
    const svc = new AgentExecutionService();

    // Stub invokeStepLLM to throw AdapterPauseRequestedError(hitl_gate, gateContext, resumeToken)
    // — same payload §6's pause_requested → throw conversion produces.
    jest.spyOn(
      svc as unknown as { invokeStepLLM: (...a: unknown[]) => Promise<unknown> },
      'invokeStepLLM',
    ).mockImplementation(async () => {
      throw new AdapterPauseRequestedError(
        'Human approval needed before this step can continue.',
        'hitl_gate', gateContext, resumeToken,
      );
    });

    // Stub the prologues / catalog / verify hash so we land at invokeStepLLM
    // quickly. workflowSteps has a single llm_reason step.
    (svc as unknown as { verifyWorkflowStepsHash: (...a: unknown[]) => unknown }).verifyWorkflowStepsHash =
      jest.fn().mockReturnValue({ ok: true });
    (svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }).buildToolsSchema =
      jest.fn().mockResolvedValue([]);

    const state = makeState();
    // runAgentHybridLoop is the workflow loop entry. Adapter param is unused
    // in the workflow path (llm_reason calls invokeStepLLM which calls
    // createAdapter internally — mocked above).
    const stubAdapter = {
      invoke: jest.fn(), pause: jest.fn(), resume: jest.fn(),
      registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(), registerAnomalyHandler: jest.fn(),
    };
    const result = await (svc as unknown as {
      runAgentHybridLoop: (
        state: ExecutionState, objective: string, inputData: unknown, resumeState: unknown, adapter: unknown,
      ) => Promise<{ success: boolean; paused?: boolean }>;
    }).runAgentHybridLoop(state, 'test', undefined, undefined, stubAdapter);

    expect(createApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(createApprovalRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', agentId: 'a1',
      pendingToolCalls: gateContext.pendingToolCalls,
      reason: 'communication_review',
    }));

    const inserts = queryMock.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_scheduled_invocations'),
    );
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse((inserts[0][1] as unknown[])[8] as string) as {
      pauseReason: string;
      hitlContext?: { approvalId: string; adapterResumeToken?: unknown; conversationHistory?: unknown };
    };
    expect(payload.pauseReason).toBe('hitl_approval');
    expect(payload.hitlContext?.approvalId).toBe('appr-1');
    expect(payload.hitlContext?.adapterResumeToken).toEqual(resumeToken);
    // llm_reason step is single-shot — no conversationHistory snapshot persisted.
    expect(payload.hitlContext?.conversationHistory).toBeUndefined();

    expect(updateRuntimeStatusMock).toHaveBeenCalledWith('a1', 'WAITING_FOR_HUMAN');
    expect(result.paused).toBe(true);
  });
});
