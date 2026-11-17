// Acceptance tests for the billing-correctness fixes that lacked a harness:
//   1.5 delegateToAgent bills the child as a first-class invocation (behind
//       BILL_DELEGATED_CHILDREN) linked to the parent via parent_invocation_id.
//   2.2 delegateToAgent bubbles child anomalies back to the parent (escalate:true).
//   1.3 invokeStepLLM publishes a per-step usage-ledger granularity row (credits:0).
//
// Mocks mirror conv-hitl-pause.test.ts: the heavy module-load deps are stubbed so
// AgentExecutionService can be constructed; the adapter + invocations + pubsub +
// usage-ledger seams are scriptable so we can assert the billing side effects.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const createInvocationMock = jest.fn();
const completeInvocationMock = jest.fn();
// getInvocation is how a delegated child inherits the parent run's human
// Returns null here: these tests are about billing and anomalies, and
// an unattributed child exercises the same paths.
const getInvocationMock = jest.fn().mockResolvedValue(null);
jest.mock('../../invocations', () => ({
  invocationsService: {
    createInvocation: (...a: unknown[]) => createInvocationMock(...a),
    completeInvocation: (...a: unknown[]) => completeInvocationMock(...a),
    getInvocation: (...a: unknown[]) => getInvocationMock(...a),
    markBillingQueued: jest.fn().mockResolvedValue(undefined),
  },
}));

const publishMock = jest.fn().mockResolvedValue('msg-id');
jest.mock('../../infrastructure/pubsub', () => ({ publisher: { publish: (...a: unknown[]) => publishMock(...a) } }));

const recordUsageMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../usage-ledger/service', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({ recordUsage: recordUsageMock })),
}));

jest.mock('../../llm/pricing', () => ({
  calculateCost: jest.fn().mockReturnValue({ costUsd: 0.5, inputPricePerMillion: 1, outputPricePerMillion: 2, cachedInputPricePerMillion: 0 }),
  googleSearchGroundingCostUsd: jest.fn().mockReturnValue(0),
  openAiWebSearchCostUsd: jest.fn().mockReturnValue(0),
  xaiWebSearchCostUsd: jest.fn().mockReturnValue(0),
  anthropicWebSearchCostUsd: jest.fn().mockReturnValue(0),
}));

// adapter seam — invoke + register* captured so tests can script events and
// trigger the registered anomaly handler.
let capturedAnomalyHandler: ((a: unknown) => Promise<{ escalate: boolean }>) | null = null;
const adapterInvokeMock = jest.fn();
jest.mock('../adapter', () => ({
  createAdapter: jest.fn().mockReturnValue({
    invoke: (...a: unknown[]) => adapterInvokeMock(...a),
    pause: jest.fn().mockResolvedValue({ adapterKind: 'anthropic', serialized: 'tok' }),
    resume: jest.fn(),
    registerToolCatalog: jest.fn(),
    registerHitlGate: jest.fn(),
    registerAnomalyHandler: jest.fn((h: (a: unknown) => Promise<{ escalate: boolean }>) => { capturedAnomalyHandler = h; }),
  }),
}));

// Heavy constructor / module-load deps — no-op (mirrors conv-hitl-pause).
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: { getOversightSettings: jest.fn().mockResolvedValue({}), checkHitlGate: jest.fn().mockResolvedValue({ shouldGate: false }), createApprovalRequest: jest.fn() },
  HitlGateError: class HitlGateError extends Error {}, ModelTool: {},
}));
// Routed on SQL text: the governed gate reads the parent invocation's depth
// and the delegation_active running count, and a bare empty default would trip
// parent_not_found (a missing parent row is now an error, not depth 0).
const poolMock = {
  query: jest.fn().mockImplementation(async (sql: string) => {
    if (/FROM invocations/i.test(sql)) return { rows: [{ delegation_depth: 0 }], rowCount: 1 };
    if (/count\(\*\) AS n FROM delegation_active/i.test(sql)) return { rows: [{ n: '0' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
};
jest.mock('../../infrastructure/database', () => ({ getPoolForService: jest.fn(() => poolMock), getPool: jest.fn(() => poolMock), pool: poolMock }));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: jest.fn().mockResolvedValue(undefined),
    // tenantId is load-bearing: delegateToAgent scopes the target to the calling
    // tenant itself, because getAgent is keyed by id alone.
    getAgent: jest.fn().mockResolvedValue({ id: 'child-a', tenantId: 't1', lifecycle: 'ACTIVE' }),
    pause: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../../infrastructure/cloud-tasks', () => ({ enqueueAgentExecution: jest.fn().mockResolvedValue({ taskName: 't' }) }));
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({ agentScheduledInvocationsRepo: { updateCloudTaskName: jest.fn() } }));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn() }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]), evaluateCitationWarning: jest.fn().mockReturnValue({}) }));
jest.mock('../../streaming', () => ({ streamingService: { emitHitlRequired: jest.fn(), emitHitlRejected: jest.fn(), emitToolStart: jest.fn(), emitToolComplete: jest.fn(), emitToolError: jest.fn(), emitTextDelta: jest.fn() } }));
jest.mock('../../agent-chat/agent-slack-client', () => ({ postReviewDm: jest.fn(), listAgentAssignees: jest.fn().mockResolvedValue([]) }));
jest.mock('../../tool-gateway/agent-slack-tool-catalog', () => ({ SLACK_OUTBOUND_TOOL_NAMES: new Set() }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({
  // The gate asks the dispatcher to judge every vendor-hosted tool before the
  // SDK runs it. Null is "proceed", which is what these cases are about.
  getToolGatewayDispatcher: jest.fn().mockReturnValue({ guardExternal: async () => null }),
}));
jest.mock('../../infrastructure/runtime-env', () => ({ getPlatformBackendUrl: jest.fn().mockReturnValue(''), getTenantRuntimeUrl: jest.fn().mockReturnValue(''), tenantRuntimeUrlState: jest.fn().mockReturnValue({}) }));
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })) }));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({ getEntitlementsClient: jest.fn().mockReturnValue({ getFeatureFlags: jest.fn().mockResolvedValue({}), getEntitlements: jest.fn().mockResolvedValue({}), getModelForTask: jest.fn().mockResolvedValue(undefined) }) }));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
jest.mock('../../connectors/manifest-repository', () => ({ connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../connectors/tool-schema-cache', () => ({ resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]) }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../agent-lifecycle/types', () => ({ trustLevelFor: jest.fn().mockReturnValue('trusted') }));
jest.mock('../run-state/service', () => ({ agentRunStateService: { load: jest.fn().mockResolvedValue(null), save: jest.fn() } }));
jest.mock('../untrusted-input', () => ({ formatInputForPrompt: jest.fn().mockReturnValue(''), formatUntrustedSystemPromptDirective: jest.fn().mockReturnValue('') }));
jest.mock('../../skills/retrieval', () => ({ retrieveContextSkills: jest.fn().mockResolvedValue([]), buildSkillContextBlock: jest.fn().mockReturnValue('') }));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: { onTaskCompleted: jest.fn() } }));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn() }));
jest.mock('../../interactive-chat/system-prompt', () => ({ getHitlDescription: jest.fn().mockReturnValue('') }));
jest.mock('../../connectors/connector-service-client', () => ({ getPrefetchThreadClient: jest.fn().mockReturnValue({}), getConnectorServiceClient: jest.fn().mockReturnValue({ listTenantConnectors: jest.fn().mockResolvedValue({ connectors: [] }), listManifests: jest.fn().mockResolvedValue({ manifests: [] }) }) }));

import { AgentExecutionService } from '../service';
import type { ExecutionState, ExecutionContext, WorkflowStep } from '../types';

function stubLoaders(svc: AgentExecutionService) {
  const s = svc as unknown as Record<string, unknown>;
  s.getActiveInstruction = jest.fn().mockResolvedValue({ version: 1, integrations: [], instruction: { allowedActionTypes: ['*'] }, systemPrompt: 'sp', userInstructions: '' });
  s.loadRuntimeConfig = jest.fn().mockResolvedValue({ agentType: 'agent', modelConfig: { provider: 'anthropic', modelId: 'claude-x' }, execConfig: {}, memoryScope: {} });
  s.buildPlatformMcpCatalog = jest.fn().mockResolvedValue({ servers: [], tools: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedAnomalyHandler = null;
  createInvocationMock.mockResolvedValue({ id: 'child-inv-1', startedAt: new Date('2026-01-01T00:00:00Z'), threadId: null, triggeredBy: 'agent', triggerRef: null });
  completeInvocationMock.mockResolvedValue({ costUsd: 0.5 });
  delete process.env.BILL_DELEGATED_CHILDREN;
});

describe('1.5 — delegateToAgent bills the child invocation', () => {
  function scriptSuccess() {
    adapterInvokeMock.mockImplementation(async function* () {
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 10, webSearchRequests: 0 } };
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'the answer' }] };
      yield { type: 'completion', outcome: 'success' };
    });
  }

  it('runs the child as a real invocation linked to the parent', async () => {
    // Billing is no longer done HERE. A delegated child runs through executeTask,
    // which creates its invocation, prices it against the child's own resolved
    // model and publishes the completion event — the same way it does for a run
    // a person or a schedule started.
    //
    // What this asserts is the lineage that makes that billing land on a CHILD
    // row rather than a root one: parent_invocation_id is what
    // resolveAccountability reads to classify the run as delegation and inherit
    // the human, and what the depth cap resolves the parent's depth through.
    const svc = new AgentExecutionService();
    stubLoaders(svc);
    const execSpy = jest.spyOn(svc as unknown as { executeTask: unknown } as never, 'executeTask' as never)
      .mockResolvedValue({
        success: true,
        output: 'the answer',
        usage: { inputTokens: 100, outputTokens: 50 },
        toolCallsExecuted: 1,
        reasoningSteps: 1,
      } as never);

    const result = await svc.delegateToAgent({ collect: true, agentId: 'child-a', tenantId: 't1', objective: 'do x', parentInvocationId: 'parent-inv-1' });

    expect(result.output).toBe('the answer');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });

    expect(execSpy).toHaveBeenCalledTimes(1);
    expect((execSpy.mock.calls[0] as unknown[])[0]).toMatchObject({
      tenantId: 't1',
      agentId: 'child-a',
      triggeredBy: 'agent',
      triggeredByLabel: 'delegate_to_agent:parent-inv-1',
      parentInvocationId: 'parent-inv-1',
    });

    // No second, parallel billing implementation left behind in delegation.
    expect(createInvocationMock).not.toHaveBeenCalled();
    expect(completeInvocationMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('2.2 — delegateToAgent bubbles child anomalies to the parent', () => {
  it('returns the anomalies the child run reported', async () => {
    // The parent is waiting on a single return value, so trouble the child hit
    // has to travel on it: a child that recovered from three connector errors is
    // materially different from one that sailed through, and the answer text
    // alone does not say so.
    const svc = new AgentExecutionService();
    stubLoaders(svc);
    jest.spyOn(svc as unknown as { executeTask: unknown } as never, 'executeTask' as never)
      .mockResolvedValue({
        success: true,
        output: 'the answer',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCallsExecuted: 1,
        reasoningSteps: 1,
        anomalies: [{ kind: 'tool_call_error', context: { toolName: 'gmail__send_email', error: 'boom' } }],
      } as never);

    const result = await svc.delegateToAgent({ collect: true, agentId: 'child-a', tenantId: 't1', objective: 'do x', parentInvocationId: 'p' });

    expect(result.anomalies).toEqual([{ kind: 'tool_call_error', context: { toolName: 'gmail__send_email', error: 'boom' } }]);
  });
});

describe('1.3 — invokeStepLLM publishes a per-step usage granularity row', () => {
  function makeState(): ExecutionState {
    return {
      context: {
        tenantId: 't1', agentId: 'a1', workflowId: 'wf1', taskId: 'tk1', instructionVersion: 1,
        instruction: { systemPrompt: 's', allowedConnectors: [] } as ExecutionContext['instruction'],
        traceId: 'tr-1', agentType: 'agent', hitlLevel: 3,
        modelConfig: { provider: 'anthropic', modelId: 'claude-x' } as ExecutionContext['modelConfig'],
        execConfig: {} as ExecutionContext['execConfig'], memoryScope: {} as ExecutionContext['memoryScope'],
        threadId: 'thread-1', invocationId: 'inv-1',
      } as ExecutionContext,
      reasoningSteps: 0, toolCallsExecuted: 0, startTime: new Date(), steps: [],
      conversationHistory: [], pendingToolCalls: [], completedToolCalls: [], toolFailureCounts: new Map(), injectedSkillIds: [],
    } as ExecutionState;
  }

  it('records eventType llm_step with credits:0 tagged with the step id', async () => {
    adapterInvokeMock.mockImplementation(async function* () {
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 } };
      yield { type: 'completion', outcome: 'success' };
    });
    const svc = new AgentExecutionService();
    (svc as unknown as Record<string, unknown>).buildPlatformMcpCatalog = jest.fn().mockResolvedValue({ servers: [], tools: [] });

    const step: WorkflowStep = { stepId: 'step-7', description: 'reason', type: 'llm_reason' } as WorkflowStep;
    await (svc as unknown as {
      invokeStepLLM: (s: ExecutionState, step: WorkflowStep, out: unknown, input: unknown) => Promise<{ output: unknown }>;
    }).invokeStepLLM(makeState(), step, 'prior', undefined);

    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'llm_step',
      credits: 0,
      metadata: expect.objectContaining({ stepId: 'step-7', inputTokens: 10, outputTokens: 5 }),
    }));
  });
});
