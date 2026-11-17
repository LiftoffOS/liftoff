// finalizeResumedInvocation — the resumed half of a paused run finishes the
// invocation it continues.
//
// The three pauses that involve a person continue through runAgentHybridLoop,
// not executeTask. If executeTask's finalize is the only place a run's
// evidence is written, a resumed run leaves the invocation row still `gated`
// with the paused half's tokens, no cost event for the continuation's model
// turns, the hire left RUNNING, and the terminal audit row and trajectory
// index the paused half's. This pins each piece.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../adapter', () => ({ createAdapter: jest.fn() }));
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: { getOversightSettings: jest.fn(), checkHitlGate: jest.fn() },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));
const poolMock = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => poolMock),
  getPool: jest.fn(() => poolMock),
  pool: poolMock,
  withTenantScope: (_t: string, fn: (c: { query: jest.Mock }) => Promise<unknown>) => fn({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
}));
const updateRuntimeStatusMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({ updateRuntimeStatus: updateRuntimeStatusMock, getAgent: jest.fn() })),
}));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn() }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../streaming', () => ({ streamingService: {} }));
jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({
  // Priced at $2/M in, $3/M out: the continuation's 31,000 + 25 tokens cost
  // something, and the cost event carries it.
  calculateCost: jest.fn((_m: string, _p: string, i: number, o: number) => ({
    costUsd: (i * 2 + o * 3) / 1_000_000, inputPricePerMillion: 2, outputPricePerMillion: 3,
  })),
  googleSearchGroundingCostUsd: 0,
  openAiWebSearchCostUsd: 0,
}));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({ getToolGatewayDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''),
  getTenantRuntimeUrl: jest.fn().mockReturnValue(''),
  tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
const recordUsageMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({ recordUsage: recordUsageMock })) }));
jest.mock('../../entitlements-client/service', () => ({ getEntitlementsClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
const getInvocationMock = jest.fn();
const completeInvocationMock = jest.fn().mockResolvedValue({});
const markBillingQueuedMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../invocations', () => ({
  invocationsService: {
    getInvocation: (...a: unknown[]) => getInvocationMock(...a),
    completeInvocation: (...a: unknown[]) => completeInvocationMock(...a),
    markBillingQueued: (...a: unknown[]) => markBillingQueuedMock(...a),
  },
}));
jest.mock('../../connectors/manifest-repository', () => ({ connectorManifestRepository: {} }));
jest.mock('../../connectors/tool-schema-cache', () => ({ resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]) }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../agent-lifecycle/types', () => ({ trustLevelFor: jest.fn().mockReturnValue('trusted') }));
const runStateLoadMock = jest.fn();
const runStateSaveMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../run-state/service', () => ({
  agentRunStateService: { load: (...a: unknown[]) => runStateLoadMock(...a), save: (...a: unknown[]) => runStateSaveMock(...a) },
}));
jest.mock('../untrusted-input', () => ({ formatInputForPrompt: jest.fn(), formatUntrustedSystemPromptDirective: jest.fn().mockReturnValue('') }));
jest.mock('../../skills/retrieval', () => ({ retrieveContextSkills: jest.fn(), buildSkillContextBlock: jest.fn() }));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: {} }));
jest.mock('../../platform-callback/client', () => ({ getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn() }));
const publishMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../infrastructure/pubsub', () => ({ publisher: { publish: (...a: unknown[]) => publishMock(...a) } }));
jest.mock('../../interactive-chat/system-prompt', () => ({ getHitlDescription: jest.fn().mockReturnValue('') }));
jest.mock('../../connectors/connector-service-client', () => ({ getPrefetchThreadClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: jest.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
  resolveRuntimeAgentId: jest.fn(),
}));
jest.mock('../../tenant-runtime-config/service', () => ({
  getTenantRuntimeConfig: jest.fn().mockResolvedValue({ trajectorySinkEnabled: false }),
}));

import { AgentExecutionService } from '../service';
import type { ExecutionContext, ExecutionState, TaskExecutionResult } from '../types';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const AGENT = '6e68d4d5-09f7-482f-b7a5-8f824c846147';
const INVOCATION = 'f399e6ff-f11b-4b94-ad8e-9c23ca936a7e';
const HUMAN = 'b9594e6f-3855-4d12-8b49-d5004ee4a0f6';
const THREAD = '2a8b0db5-7ad6-45c3-9f11-a770e07aec82';
const PAUSE_ROW = '5e250fbf-00cf-4c9a-bf57-143566d80699';

function priorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOCATION,
    tenantId: TENANT,
    agentId: AGENT,
    threadId: THREAD,
    triggeredBy: 'human',
    triggeredByUserId: HUMAN,
    impersonatedBy: null,
    triggeredByLabel: null,
    triggerRef: 'task-1',
    parentInvocationId: null,
    modelId: 'z-ai/glm-5.2',
    provider: 'glm',
    inputTokens: 26119,
    outputTokens: 34,
    cachedTokens: 0,
    inputPricePerMillion: 2,
    outputPricePerMillion: 3,
    cachedInputPricePerMillion: null,
    groundingQueries: 0,
    groundingCostUsd: 0,
    toolCalls: [
      { id: 'call-search', name: 'web_search', input: { query: 'competitors' }, output: 'three names' },
      // Under the engine's own id: on the CLI engines that is the CLI's, and
      // the pause stamps the proxy's on the same call.
      { id: 'call-send-engine', name: 'google-mail-0105297e__send_email', input: { to: 'a@b.c' }, error: 'paused_for_human_approval' },
    ],
    outcome: 'gated',
    errorMessage: null,
    startedAt: new Date('2026-09-16T23:58:06Z'),
    completedAt: new Date('2026-09-16T23:58:22Z'),
    ...overrides,
  };
}

function makeState(): ExecutionState {
  const context = {
    tenantId: TENANT,
    agentId: AGENT,
    workflowId: 'wf-1',
    taskId: 'task-1',
    invocationId: INVOCATION,
    threadId: THREAD,
    traceId: `resume-hitl-${INVOCATION}`,
    instructionVersion: 1,
    instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' },
    agentType: 'agent',
    hitlLevel: 3,
    modelConfig: { provider: 'glm', modelId: 'z-ai/glm-5.2' },
    resolvedProvider: 'glm',
    resolvedModelId: 'z-ai/glm-5.2',
    execConfig: {},
    memoryScope: {},
    messageSenderAccountId: HUMAN,
    trustLevel: 'trusted',
  } as unknown as ExecutionContext;
  return {
    context,
    reasoningSteps: 2,
    toolCallsExecuted: 2,
    startTime: new Date('2026-09-17T00:00:43.000Z'),
    steps: [
      { id: 's1', output: { inputTokens: 30000, outputTokens: 20, cachedTokens: 0 } },
      { id: 's2', output: { inputTokens: 1000, outputTokens: 5, cachedTokens: 0 } },
    ] as unknown as ExecutionState['steps'],
    conversationHistory: [],
    pendingToolCalls: [],
    completedToolCalls: [
      { id: 'call-send', name: 'google-mail-0105297e__send_email', input: { to: 'a@b.c' }, success: true, result: 'sent' },
      { id: 'call-report', name: 'report_task_outcome', input: { outcome: 'done' }, success: true, result: 'ok' },
    ] as unknown as ExecutionState['completedToolCalls'],
    toolFailureCounts: new Map(),
    injectedSkillIds: [],
    trajectoryContext: { systemPrompt: 'sys', objective: 'the objective', toolDefs: [] },
  } as unknown as ExecutionState;
}

const succeeded: TaskExecutionResult = {
  success: true, output: 'BigCommerce, WooCommerce, Wix', toolCallsExecuted: 2, reasoningSteps: 2,
};

function makeService() {
  const svc = new AgentExecutionService();
  const s = svc as unknown as Record<string, jest.Mock | unknown>;
  s.modelIdForPricing = jest.fn().mockResolvedValue('z-ai/glm-5.2');
  s.writeTrajectoryIfEnabled = jest.fn().mockResolvedValue(undefined);
  s.postAuditLogToControlPlane = jest.fn().mockResolvedValue(undefined);
  s.emitCollabSessionSafe = jest.fn().mockResolvedValue(undefined);
  s.recordCodeSessionUnpriced = jest.fn();
  return svc;
}

async function finalize(svc: AgentExecutionService, args: Record<string, unknown>) {
  await (svc as unknown as { finalizeResumedInvocation: (a: unknown) => Promise<void> }).finalizeResumedInvocation(args);
  // publishInvocationCompleted resolves the internal agent id first; let it land.
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  jest.clearAllMocks();
  getInvocationMock.mockResolvedValue(priorRow());
  runStateLoadMock.mockResolvedValue({ invocationId: INVOCATION, status: 'interrupted' });
});

describe('finalizeResumedInvocation', () => {
  it('completes the invocation it continues: the continuation\'s tokens added to the paused half\'s, the answered call replacing the gated one, outcome off the terminal state', async () => {
    const svc = makeService();
    await finalize(svc, { state: makeState(), invocationId: INVOCATION, result: succeeded, resumeKind: 'hitl_approval', resumeRowId: PAUSE_ROW });

    expect(getInvocationMock).toHaveBeenCalledWith(INVOCATION, TENANT);
    expect(completeInvocationMock).toHaveBeenCalledTimes(1);
    const [id, input] = completeInvocationMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe(INVOCATION);
    expect(input.inputTokens).toBe(26119 + 31000);
    expect(input.outputTokens).toBe(34 + 25);
    expect(input.outcome).toBe('success');
    expect(input.errorMessage).toBeUndefined();
    const calls = input.toolCalls as Array<{ id: string; name: string; output?: unknown; error?: string }>;
    expect(calls.map((c) => c.id)).toEqual(['call-search', 'call-send', 'call-report']);
    // The send is held ONCE, as the continuation's answer, not beside the
    // pause's refusal under the engine's id.
    expect(calls.filter((c) => c.name === 'google-mail-0105297e__send_email')).toHaveLength(1);
    expect(calls[1]).toMatchObject({ name: 'google-mail-0105297e__send_email', output: 'sent' });
    expect(calls[1].error).toBeUndefined();
    expect(input.objective).toBe('the objective');
  });

  it('publishes the continuation\'s own spend as its own cost event, keyed by the continuation\'s start', async () => {
    const svc = makeService();
    await finalize(svc, { state: makeState(), invocationId: INVOCATION, result: succeeded, resumeKind: 'hitl_approval', resumeRowId: PAUSE_ROW });

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [topic, payload] = publishMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(topic).toMatch(/invocation-completed/);
    expect(payload).toMatchObject({
      tenantId: TENANT,
      // Its own id on the wire: the control plane bills one completion per
      // id, and the paused half was billed under the row's.
      invocationId: `${INVOCATION}:resume:${PAUSE_ROW}`,
      agentId: AGENT,
      occurredAt: '2026-09-17T00:00:43.000Z',
      provider: 'glm',
      model: 'z-ai/glm-5.2',
      inputTokens: 31000,
      outputTokens: 25,
      threadId: THREAD,
      triggeredBy: 'human',
      triggerRef: 'task-1',
    });
    expect(payload.costUsd as number).toBeGreaterThan(0);
    // The row itself is what is marked queued.
    expect(markBillingQueuedMock).toHaveBeenCalledWith(INVOCATION, 'published');
  });

  it('frees the agent, settles the interrupted run state, writes the trajectory, the usage row and the terminal audit row with the reply', async () => {
    const svc = makeService();
    const state = makeState();
    await finalize(svc, { state, invocationId: INVOCATION, result: succeeded, resumeKind: 'hitl_approval', resumeRowId: PAUSE_ROW });

    expect(updateRuntimeStatusMock).toHaveBeenCalledWith(AGENT, 'IDLE');
    expect(runStateSaveMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete' }));
    const s = svc as unknown as Record<string, jest.Mock>;
    expect(s.emitCollabSessionSafe).toHaveBeenCalledWith(state, INVOCATION, 'success');
    expect(s.writeTrajectoryIfEnabled).toHaveBeenCalledWith(state, INVOCATION, 'success', undefined);
    // The collab record reads the recorder buffer the trajectory write releases.
    expect(s.emitCollabSessionSafe.mock.invocationCallOrder[0]).toBeLessThan(s.writeTrajectoryIfEnabled.mock.invocationCallOrder[0]);
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, agentId: AGENT, eventType: 'task_execution', credits: 4,
      metadata: expect.objectContaining({ resumeKind: 'hitl_approval' }),
    }));
    expect(s.postAuditLogToControlPlane).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      agentId: AGENT,
      threadId: THREAD,
      invocationId: INVOCATION,
      action: 'agent_execution',
      outcome: 'success',
      outputSummary: 'BigCommerce, WooCommerce, Wix',
      errorCode: undefined,
      // The paused half's rows carry the human; the continuation's agrees.
      triggeredBy: `human:${HUMAN}`,
      userId: HUMAN,
      toolCallsExecuted: 2,
      reasoningSteps: 2,
    }));
  });

  it('a continuation that paused again leaves the row gated, the agent waiting, and the run state interrupted', async () => {
    const svc = makeService();
    const paused: TaskExecutionResult = { success: true, paused: true, output: '', toolCallsExecuted: 1, reasoningSteps: 1 } as TaskExecutionResult;
    await finalize(svc, { state: makeState(), invocationId: INVOCATION, result: paused, resumeKind: 'delegation', resumeRowId: PAUSE_ROW });

    expect(updateRuntimeStatusMock).toHaveBeenCalledWith(AGENT, 'WAITING_FOR_HUMAN');
    expect((completeInvocationMock.mock.calls[0] as [string, Record<string, unknown>])[1].outcome).toBe('gated');
    expect(runStateSaveMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'interrupted' }));
    const s = svc as unknown as Record<string, jest.Mock>;
    expect(s.postAuditLogToControlPlane).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'gated' }));
    // Its spend so far is still recorded.
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('a continuation that parked again at its wall clock leaves the row parked and the agent waiting on the clock, not a person', async () => {
    const svc = makeService();
    const parked: TaskExecutionResult = { success: true, paused: true, pauseKind: 'continuation', output: '', toolCallsExecuted: 1, reasoningSteps: 1 } as TaskExecutionResult;
    await finalize(svc, { state: makeState(), invocationId: INVOCATION, result: parked, resumeKind: 'continuation', resumeRowId: PAUSE_ROW });

    expect(updateRuntimeStatusMock).toHaveBeenCalledWith(AGENT, 'WAITING_FOR_EVENT');
    expect((completeInvocationMock.mock.calls[0] as [string, Record<string, unknown>])[1].outcome).toBe('parked');
    expect(runStateSaveMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'interrupted' }));
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('a continuation that finished frees the agent and records the outcome under the continuation row', async () => {
    const svc = makeService();
    await finalize(svc, { state: makeState(), invocationId: INVOCATION, result: succeeded, resumeKind: 'continuation', resumeRowId: PAUSE_ROW });

    expect(updateRuntimeStatusMock).toHaveBeenCalledWith(AGENT, 'IDLE');
    expect((completeInvocationMock.mock.calls[0] as [string, Record<string, unknown>])[1].outcome).toBe('success');
    expect(publishMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ invocationId: `${INVOCATION}:resume:${PAUSE_ROW}` }));
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ resumeKind: 'continuation' }) }));
  });

  it('a failed continuation records the error and the class, and the agent is free again', async () => {
    const svc = makeService();
    const failed: TaskExecutionResult = { success: false, error: 'engine died', failureClass: 'engine_error', toolCallsExecuted: 0, reasoningSteps: 1 } as TaskExecutionResult;
    await finalize(svc, { state: makeState(), invocationId: INVOCATION, result: failed, resumeKind: 'ask_user', resumeRowId: PAUSE_ROW });

    expect(updateRuntimeStatusMock).toHaveBeenCalledWith(AGENT, 'IDLE');
    const input = (completeInvocationMock.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(input.outcome).toBe('error');
    expect(input.errorMessage).toBe('engine died');
    expect(input.failureClass).toBe('engine_error');
    const s = svc as unknown as Record<string, jest.Mock>;
    expect(s.postAuditLogToControlPlane).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', errorCode: 'engine died' }));
  });

  it('a run state already terminal is left alone', async () => {
    runStateLoadMock.mockResolvedValue({ invocationId: INVOCATION, status: 'complete' });
    const svc = makeService();
    await finalize(svc, { state: makeState(), invocationId: INVOCATION, result: succeeded, resumeKind: 'hitl_approval', resumeRowId: PAUSE_ROW });
    expect(runStateSaveMock).not.toHaveBeenCalled();
  });

  it('with no invocation row to continue, still frees the agent and writes the audit row and trajectory, and completes nothing', async () => {
    getInvocationMock.mockResolvedValue(null);
    const svc = makeService();
    await finalize(svc, { state: makeState(), invocationId: INVOCATION, result: succeeded, resumeKind: 'hitl_approval', resumeRowId: PAUSE_ROW });

    expect(completeInvocationMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    expect(updateRuntimeStatusMock).toHaveBeenCalledWith(AGENT, 'IDLE');
    const s = svc as unknown as Record<string, jest.Mock>;
    expect(s.writeTrajectoryIfEnabled).toHaveBeenCalledWith(expect.anything(), INVOCATION, 'success', undefined);
    expect(s.postAuditLogToControlPlane).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent_execution', triggeredBy: 'system:agent_execution' }));
  });

  it('a completion that throws is logged and the rest of the evidence is still written', async () => {
    completeInvocationMock.mockRejectedValueOnce(new Error('db away'));
    const svc = makeService();
    await expect(finalize(svc, { state: makeState(), invocationId: INVOCATION, result: succeeded, resumeKind: 'hitl_approval', resumeRowId: PAUSE_ROW })).resolves.toBeUndefined();
    const s = svc as unknown as Record<string, jest.Mock>;
    expect(s.writeTrajectoryIfEnabled).toHaveBeenCalled();
    expect(s.postAuditLogToControlPlane).toHaveBeenCalled();
    expect(recordUsageMock).toHaveBeenCalled();
  });

  it('without an invocation id there is nothing to finish', async () => {
    const svc = makeService();
    await finalize(svc, { state: makeState(), invocationId: undefined, result: succeeded, resumeKind: 'hitl_approval', resumeRowId: PAUSE_ROW });
    expect(getInvocationMock).not.toHaveBeenCalled();
    expect(updateRuntimeStatusMock).not.toHaveBeenCalled();
    const s = svc as unknown as Record<string, jest.Mock>;
    expect(s.postAuditLogToControlPlane).not.toHaveBeenCalled();
  });

  it('a delegated child carries its parent onto the trajectory', async () => {
    getInvocationMock.mockResolvedValue(priorRow({ parentInvocationId: 'parent-1', triggeredBy: 'agent', triggeredByUserId: null }));
    const svc = makeService();
    await finalize(svc, { state: makeState(), invocationId: INVOCATION, result: succeeded, resumeKind: 'hitl_approval', resumeRowId: PAUSE_ROW });
    const s = svc as unknown as Record<string, jest.Mock>;
    expect(s.writeTrajectoryIfEnabled).toHaveBeenCalledWith(expect.anything(), INVOCATION, 'success', 'parent-1');
    expect(s.postAuditLogToControlPlane).toHaveBeenCalledWith(expect.objectContaining({ triggeredBy: `agent:${AGENT}` }));
  });
});
