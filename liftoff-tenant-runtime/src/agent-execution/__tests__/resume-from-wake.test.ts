// The wake continues the PAUSED run.
//
// `runWakeContinuation` always entered through executeTask, and that was the
// right door; the defect was that it entered as a fresh task with the wake
// message as the objective — nothing of the paused run restored. Run b43c9c6b
// paused on google-gemini-cli; its wake ran on openai-codex, re-entered the
// hire's workflow graph at step 1 with no input, and knew nothing said before
// the wait.
//
// Deterministic, no live calls. Three seams are driven directly:
//   - resumeFromWake / resumeWaitSet → executeTask, spied, to read the
//     continuation's inputs;
//   - the conversational loop, to show what the pause persists and what the
//     continuation puts in front of the model;
//   - the workflow loop, to show the cursor behaviour per step type.

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
    hashToolCalls: jest.fn().mockReturnValue('h'),
  },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));

const queryMock = jest.fn();
const poolMock = { query: queryMock, connect: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => poolMock),
  getPool: jest.fn(() => poolMock),
  pool: poolMock,
}));

const updateRuntimeStatusMock = jest.fn().mockResolvedValue(undefined);
const getAgentMock = jest.fn();
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: updateRuntimeStatusMock,
    getAgent: (...a: unknown[]) => getAgentMock(...a),
  })),
}));

const enqueueAgentExecutionMock = jest.fn();
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: (...a: unknown[]) => enqueueAgentExecutionMock(...a),
}));

const claimWakeForResumeMock = jest.fn();
const releaseWakeLeaseMock = jest.fn();
const persistWakeResultMock = jest.fn();
const settleWakeMock = jest.fn();
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {
    claimWakeForResume: (...a: unknown[]) => claimWakeForResumeMock(...a),
    heartbeatWakeLease: jest.fn().mockResolvedValue(undefined),
    releaseWakeLease: (...a: unknown[]) => releaseWakeLeaseMock(...a),
    markWakeErrored: jest.fn().mockResolvedValue(undefined),
    bumpResumeRate: jest.fn().mockResolvedValue(0),
    persistWakeResult: (...a: unknown[]) => persistWakeResultMock(...a),
    settleWake: (...a: unknown[]) => settleWakeMock(...a),
    updateCloudTaskName: jest.fn().mockResolvedValue(undefined),
    rearmPoll: jest.fn().mockResolvedValue(undefined),
    fireWaitSetMember: jest.fn().mockResolvedValue(true),
    cancelWaitSetMembers: jest.fn().mockResolvedValue([]),
    countUnfiredWaitSetMembers: jest.fn().mockResolvedValue(0),
    insert: jest.fn().mockResolvedValue({ id: 'row-1' }),
  },
}));
const claimWaitSetMock = jest.fn();
jest.mock('../../scheduling/wake-wait-set-repo', () => ({
  wakeWaitSetRepo: {
    claimForResume: (...a: unknown[]) => claimWaitSetMock(...a),
    heartbeat: jest.fn().mockResolvedValue(undefined),
    releaseLease: jest.fn().mockResolvedValue(undefined),
    markErrored: jest.fn().mockResolvedValue(undefined),
    persistResult: jest.fn().mockResolvedValue(true),
    settle: jest.fn().mockResolvedValue(undefined),
    getById: jest.fn(),
  },
}));

jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../streaming', () => ({
  streamingService: {
    emitHitlRequired: jest.fn(),
    emitHitlRejected: jest.fn(),
    emitToolStart: jest.fn(),
    emitToolComplete: jest.fn(),
    emitToolError: jest.fn(),
    emitTextDelta: jest.fn(),
  },
}));
jest.mock('../../agent-chat/agent-slack-client', () => ({
  postReviewDm: jest.fn(),
  listAgentAssignees: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../tool-gateway/agent-slack-tool-catalog', () => ({
  SLACK_OUTBOUND_TOOL_NAMES: new Set(),
  AGENT_SLACK_TOOL_NAMES: [],
}));
jest.mock('../../action-ledger/record-external-tool-call', () => ({
  recordExternalToolCall: jest.fn().mockResolvedValue(undefined),
  triggerTargetOf: () => null,
}));

// The adapter, stubbed: each case scripts what `invoke` yields.
const adapterInvokeMock = jest.fn();
const adapterPauseMock = jest.fn().mockResolvedValue({ adapterKind: 'anthropic', serialized: 'tok' });
function stubAdapter() {
  return {
    invoke: adapterInvokeMock,
    pause: adapterPauseMock,
    resume: jest.fn(),
    registerToolCatalog: jest.fn(),
    registerHitlGate: jest.fn(),
    registerAnomalyHandler: jest.fn(),
  };
}
jest.mock('../adapter', () => ({
  createAdapter: jest.fn(() => stubAdapter()),
}));

jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({
  ...jest.requireActual('../../llm/pricing'),
  calculateCost: jest.fn().mockReturnValue(null),
}));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: jest.fn().mockReturnValue({
    guardExternal: async () => null,
    observeExternal: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn(),
    executeBatch: jest.fn(),
  }),
}));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''),
  getTenantRuntimeUrl: jest.fn().mockReturnValue(''),
  tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
const checkAdmissionMock = jest.fn();
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: (...a: unknown[]) => checkAdmissionMock(...a) })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({ recordUsage: jest.fn().mockResolvedValue(undefined) })) }));
// What the task lifecycle touches between admission and the loop, and after
// it, when executeTaskInner is driven for real below.
jest.mock('../../execution-environments/agent-lock', () => ({
  tryAcquireAgentLock: jest.fn().mockResolvedValue({ id: 'lk' }),
  releaseAgentLock: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../tool-gateway/record-provenance', () => ({
  ...jest.requireActual('../../tool-gateway/record-provenance'),
  seedProvenanceFromTrigger: jest.fn().mockResolvedValue(0),
  seedProvenanceFromEvent: jest.fn().mockResolvedValue(undefined),
  seedProvenanceFromContext: jest.fn().mockResolvedValue(undefined),
}));
const createInvocationMock = jest.fn();
const completeInvocationMock = jest.fn();
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getFeatureFlags: jest.fn().mockResolvedValue({}),
    getEntitlements: jest.fn().mockResolvedValue({}),
    getModelForTask: jest.fn().mockResolvedValue(null),
  }),
}));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({
  invocationsService: {
    listInvocations: jest.fn().mockResolvedValue({ invocations: [] }),
    createInvocation: (...a: unknown[]) => createInvocationMock(...a),
    completeInvocation: (...a: unknown[]) => completeInvocationMock(...a),
  },
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../agent-lifecycle/types', () => ({ trustLevelFor: jest.fn().mockReturnValue('trusted') }));
jest.mock('../run-state/service', () => ({
  agentRunStateService: { appendItem: jest.fn().mockResolvedValue(undefined), create: jest.fn().mockResolvedValue(undefined), load: jest.fn().mockResolvedValue(null), save: jest.fn() },
}));
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
const getWakeThreadRevisionMock = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: jest.fn(() => null),
  postSkillFeedback: jest.fn(),
  getWakeThreadRevision: (...a: unknown[]) => getWakeThreadRevisionMock(...a),
  getWakeThreadInfo: jest.fn().mockResolvedValue(null),
  settleMcpChatRunViaCallback: jest.fn(),
}));
const loadChatSessionJsonlMock = jest.fn();
jest.mock('../../interactive-chat/chat-turn-handler', () => ({
  loadChatSessionJsonl: (...a: unknown[]) => loadChatSessionJsonlMock(...a),
  buildSessionStateDir: () => '/tmp/sess/dir',
  ensureSessionStateDir: jest.fn().mockResolvedValue(undefined),
  restoreSessionJsonlToDisk: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../interactive-chat/locks', () => ({
  tryAcquireLock: jest.fn().mockResolvedValue({ id: 'lock' }),
  releaseLock: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../infrastructure/pubsub', () => ({ publisher: { publish: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../interactive-chat/system-prompt', () => ({ getHitlDescription: jest.fn().mockReturnValue('') }));
jest.mock('../../connectors/connector-service-client', () => ({
  getPrefetchThreadClient: jest.fn().mockReturnValue({}),
  getConnectorServiceClient: jest.fn().mockReturnValue({
    listTenantConnectors: jest.fn().mockResolvedValue({ connectors: [] }),
    listManifests: jest.fn().mockResolvedValue({ manifests: [] }),
  }),
}));
jest.mock('../autonomous-session', () => ({
  isAutonomousResumeEnabled: () => false,
  loadRunSession: jest.fn().mockResolvedValue(null),
  restoreRunSessionToDisk: jest.fn().mockResolvedValue(undefined),
  autonomousSessionDir: (tk: string) => `/tmp/sess/${tk}`,
  ensureRunSessionDir: jest.fn().mockResolvedValue(undefined),
  saveRunSession: jest.fn().mockResolvedValue(true),
  readRunSessionJsonl: jest.fn().mockResolvedValue(null),
  prepareAutonomousSession: jest.fn(),
}));

import { AgentExecutionService } from '../service';
import type { HybridResumeState } from '../service';
import type { ExecutionState, ExecutionContext, ExecuteTaskInput, ConversationMessage, WorkflowStep } from '../types';
import { scrubLogger } from '../../observability/scrub-logger';

const WAKE_CTX = {
  spec: { kind: 'timer' as const, firesAt: '2026-09-16T10:00:00.000Z', note: 'wait for the window' },
  originTrust: 'trusted' as const,
  wakeChainDepth: 1,
  scheduledInvocationId: 'sched-1',
};
const MARKER = JSON.stringify({ __wakePending: { spec: WAKE_CTX.spec, originTrust: 'trusted', wakeChainDepth: 0 } });

/** A persisted transcript ending in the wake call and its marker: the pair the
 *  pause appends explicitly, because the tool exchange is not in the history. */
const PAUSED_HISTORY: NonNullable<HybridResumeState['conversationHistory']> = [
  { role: 'user', content: 'Please complete the following task: Watch the deploy window. The secret word is pelican.' },
  { role: 'assistant', content: 'Noted: pelican. I will wait for the window.' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-wake', name: 'sleep_until', input: { at: '2026-09-16T10:00:00Z', note: 'wait for the window' } }] },
  { role: 'tool', toolCallId: 'call-wake', toolName: 'sleep_until', content: MARKER },
];

function pausedPayload(overrides: Partial<HybridResumeState> = {}): HybridResumeState {
  return {
    kind: 'hybrid-pause',
    pauseReason: 'self_wake',
    executionEngine: 'google-gemini-cli',
    currentStepId: 'conversational',
    resumeAfterStepId: 'conversational',
    stepOutput: 'Noted: pelican. I will wait for the window.',
    objective: 'Watch the deploy window. The secret word is pelican.',
    triggerKey: 'evt:original-run',
    inputData: { eventData: { number: 81 } },
    provider: 'google',
    model: 'gemini-3.5-flash',
    conversationHistory: PAUSED_HISTORY,
    perStepRecoveries: {},
    totalRecoveries: 0,
    recoveryHistory: [],
    stepOutputs: {},
    enteredSteps: [],
    unsatisfiedSteps: [],
    wakeContext: WAKE_CTX,
    ...overrides,
  };
}

function claimedRow(payload: HybridResumeState, extra: Record<string, unknown> = {}) {
  return {
    id: 'sched-1',
    lease_token: 'lease-1',
    workflow_resume_payload: payload,
    wake_chain_depth: 1,
    created_at: new Date('2026-09-16T09:58:00Z'),
    resume_attempts: 1,
    thread_id: null,
    wait_set_id: null,
    ...extra,
  };
}

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    tenantId: 't1', agentId: 'a1', workflowId: '', taskId: '',
    instructionVersion: 0,
    instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' } as unknown as ExecutionContext['instruction'],
    traceId: 'tr-1', agentType: 'agent',
    hitlLevel: 3, modelConfig: {} as ExecutionContext['modelConfig'], execConfig: {} as ExecutionContext['execConfig'], memoryScope: {} as ExecutionContext['memoryScope'],
    invocationId: 'inv-1',
    ...overrides,
  };
}

function spyExecuteTask(svc: AgentExecutionService) {
  return jest.spyOn(svc, 'executeTask').mockResolvedValue({ success: true, output: 'pelican', toolCallsExecuted: 0, reasoningSteps: 1 });
}

function stubSettlement(svc: AgentExecutionService) {
  (svc as unknown as { settleWakeDelivery: (...a: unknown[]) => Promise<void> }).settleWakeDelivery = jest.fn().mockResolvedValue(undefined);
  (svc as unknown as { deliverWakeToChat: (...a: unknown[]) => Promise<void> }).deliverWakeToChat = jest.fn().mockResolvedValue(undefined);
}

beforeEach(() => {
  jest.clearAllMocks();
  getAgentMock.mockResolvedValue({ id: 'a1', lifecycle: 'ACTIVE' });
  checkAdmissionMock.mockResolvedValue({ allowed: true });
  getOversightSettingsMock.mockResolvedValue({ communication: 'review', sensitiveWork: {} });
  checkHitlGateMock.mockResolvedValue({ shouldGate: false });
  createApprovalRequestMock.mockResolvedValue({ id: 'appr-1', expiresAt: new Date() });
  queryMock.mockResolvedValue({ rows: [{ id: 'sched-2' }], rowCount: 1 });
  enqueueAgentExecutionMock.mockResolvedValue({ taskName: 't' });
  persistWakeResultMock.mockResolvedValue(true);
  releaseWakeLeaseMock.mockResolvedValue(undefined);
  getWakeThreadRevisionMock.mockResolvedValue(null);
  loadChatSessionJsonlMock.mockResolvedValue(null);
  adapterPauseMock.mockResolvedValue({ adapterKind: 'anthropic', serialized: 'tok' });
});

// ── resumeFromWake → executeTask: what the continuation is entered with ──────
describe('resumeFromWake enters executeTask as a continuation of the paused run', () => {
  async function wake(payload: HybridResumeState, ctx: Partial<ExecutionContext> = {}, rowExtra: Record<string, unknown> = {}) {
    const svc = new AgentExecutionService();
    stubSettlement(svc);
    claimWakeForResumeMock.mockResolvedValue(claimedRow(payload, rowExtra));
    const exec = spyExecuteTask(svc);
    const res = await svc.resumeFromWake(makeContext(ctx), 'sched-1', 'wake-timer', {});
    return { svc, exec, res, input: exec.mock.calls[0]?.[0] as ExecuteTaskInput | undefined };
  }

  it('the original objective survives the wake, and the wake message is the continuation turn', async () => {
    const { exec, input } = await wake(pausedPayload());
    expect(exec).toHaveBeenCalledTimes(1);
    expect(input?.objective).toBe('Watch the deploy window. The secret word is pelican.');
    expect(input?.resumeUserTurn).toMatch(/\[self-wake\] timer elapsed/);
    expect(input?.resumeUserTurn).not.toBe(input?.objective);
  });

  it('the conversation history is restored once, ending with the wake call and its marker', async () => {
    const { input } = await wake(pausedPayload());
    expect(input?.resumeConversationHistory).toEqual(PAUSED_HISTORY);
    const wakeTurns = (input?.resumeConversationHistory ?? []).filter((m) => m.role === 'tool' && m.toolCallId === 'call-wake');
    expect(wakeTurns).toHaveLength(1);
  });

  it('the pause\'s provider and model are what the task is told to resolve', async () => {
    const { input } = await wake(pausedPayload());
    expect(input?.modelConfigOverride).toEqual({ provider: 'google', modelId: 'gemini-3.5-flash' });
  });

  it('the saved cursor and outputs enter the loop; the continuation keeps its own trigger key and carries the previous one', async () => {
    const { input } = await wake(pausedPayload({
      currentStepId: 's3', resumeAfterStepId: 's3', stepOutputs: { s1: { a: 1 }, s2: { b: 2 } }, enteredSteps: ['s1', 's2'], unsatisfiedSteps: [],
    }));
    expect(input?.resumeState).toMatchObject({
      pauseReason: 'self_wake', currentStepId: 's3', resumeAfterStepId: 's3',
      stepOutputs: { s1: { a: 1 }, s2: { b: 2 } }, enteredSteps: ['s1', 's2'],
    });
    expect(input?.triggerKey).toBe('wake:sched-1');
    expect(input?.previousTriggerKey).toBe('evt:original-run');
  });

  it('the paused run\'s inputData is restored, with the wake lineage carried inside it', async () => {
    const { input } = await wake(pausedPayload({ inputData: { eventData: { number: 81 } } }));
    expect(input?.inputData).toEqual({ eventData: { number: 81 }, _wakeChainDepth: 1 });
  });

  it('an untrusted-origin wake carries its trust inside the restored inputData too', async () => {
    const { input } = await wake(pausedPayload({ wakeContext: { ...WAKE_CTX, originTrust: 'untrusted_inbound' } }));
    expect(input?.inputData).toMatchObject({ eventData: { number: 81 }, _wakeChainDepth: 1, _originTrust: 'untrusted_inbound' });
    expect(input?.trustLevel).toBe('untrusted_inbound');
  });

  it('an older payload takes the fresh-task path and logs legacy_fallback', async () => {
    const info = jest.spyOn(scrubLogger, 'info');
    const { input } = await wake(pausedPayload({ provider: undefined, model: undefined, conversationHistory: undefined }));
    // Today's path, exactly: the wake message is the objective, nothing restored.
    expect(input?.objective).toMatch(/\[self-wake\] timer elapsed/);
    expect(input?.resumeUserTurn).toBeUndefined();
    expect(input?.resumeConversationHistory).toBeUndefined();
    expect(input?.resumeState).toBeUndefined();
    expect(input?.modelConfigOverride).toBeUndefined();
    expect(input?.inputData).toEqual({ _wakeChainDepth: 1 });
    const decision = info.mock.calls.map((c) => c[0] as Record<string, unknown>).find((f) => f.event === 'resume_decision');
    expect(decision).toMatchObject({ resume_kind: 'self_wake', resume_mode: 'legacy_fallback', scheduled_invocation_id: 'sched-1', previous_trigger_key: 'evt:original-run', trigger_key: 'wake:sched-1' });
  });

  it('a workflow pause restores its cursor even without a transcript; a conversational pause without one is a fresh task', async () => {
    // A workflow pause is its cursor and outputs; the loop decides per step
    // type what a step with no captured turn does. A conversational pause IS
    // its transcript, and without one there is nothing to continue.
    const workflow = await wake(pausedPayload({ currentStepId: 's3', resumeAfterStepId: 's3', conversationHistory: undefined }));
    expect(workflow.input?.resumeState).toMatchObject({ currentStepId: 's3', resumeAfterStepId: 's3' });
    expect(workflow.input?.objective).toBe('Watch the deploy window. The secret word is pelican.');
    expect(workflow.input?.resumeConversationHistory).toBeUndefined();

    const conversational = await wake(pausedPayload({ conversationHistory: undefined }));
    expect(conversational.input?.resumeState).toBeUndefined();
    expect(conversational.input?.objective).toMatch(/\[self-wake\] timer elapsed/);
  });

  it('logs the canonical decision with what it restored', async () => {
    const info = jest.spyOn(scrubLogger, 'info');
    await wake(pausedPayload({ currentStepId: 's3', resumeAfterStepId: 's3', stepOutputs: { s1: 1, s2: 2 } }));
    const decision = info.mock.calls.map((c) => c[0] as Record<string, unknown>).find((f) => f.event === 'resume_decision');
    expect(decision).toMatchObject({
      resume_mode: 'canonical', execution_engine: 'google-gemini-cli', provider: 'google', model: 'gemini-3.5-flash',
      saved_resume_after_step_id: 's3', restored_resume_after_step_id: 's3', saved_step_count: 2, restored_step_count: 2,
    });
  });

  it('the chat-session revision protection still refuses a stale thread', async () => {
    // The pause recorded revision 4; the thread has since moved to 6. A
    // native session must NOT be restored — the canonical replay is what the
    // continuation gets — and the check reads the CURRENT revision exactly as
    // it did before.
    getWakeThreadRevisionMock.mockResolvedValue(6);
    loadChatSessionJsonlMock.mockResolvedValue({ sdkSessionId: 'sess-native', jsonl: '{}' });
    const { input } = await wake(
      pausedPayload({ wakeContext: { ...WAKE_CTX, threadRevision: 4 } }),
      { threadId: 'thread-1' },
      { thread_id: 'thread-1' },
    );
    expect(getWakeThreadRevisionMock).toHaveBeenCalledWith('t1', 'thread-1');
    expect(loadChatSessionJsonlMock).not.toHaveBeenCalled();
    expect(input?.resumeSessionId).toBeUndefined();
    expect(input?.sessionStateDir).toBeUndefined();
    // The canonical restoration is unaffected by the refusal.
    expect(input?.resumeConversationHistory).toEqual(PAUSED_HISTORY);
  });

  it('an unchanged thread revision still restores the native session beside the canonical replay', async () => {
    getWakeThreadRevisionMock.mockResolvedValue(4);
    loadChatSessionJsonlMock.mockResolvedValue({ sdkSessionId: 'sess-native', jsonl: '{}' });
    const { input } = await wake(
      pausedPayload({ wakeContext: { ...WAKE_CTX, threadRevision: 4 } }),
      { threadId: 'thread-1' },
      { thread_id: 'thread-1' },
    );
    expect(input?.resumeSessionId).toBe('sess-native');
    expect(input?.sessionStateDir).toBe('/tmp/sess/dir');
  });
});

// ── executeTask: the continuation inputs become the run ─────────────────────
describe('executeTask resolves the pause\'s provider and model and enters the loop with the restored run', () => {
  function stubLifecycle(svc: AgentExecutionService) {
    const s = svc as unknown as Record<string, unknown>;
    s.verifyCanonicalAgentStatus = jest.fn().mockResolvedValue('active');
    s.getActiveInstruction = jest.fn().mockResolvedValue({
      version: 1, instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' }, integrations: [],
    });
    // The hire is configured for anthropic NOW; the run paused on google.
    s.loadRuntimeConfig = jest.fn().mockResolvedValue({
      workflowSteps: [], modelConfig: { provider: 'anthropic', tier: 'medium' }, execConfig: {}, memoryScope: {}, hitlLevel: 3,
    });
    s.retrieveContextMemories = jest.fn().mockResolvedValue([]);
    s.loadExternalAgentsForInternalAgent = jest.fn().mockResolvedValue([]);
    s.modelIdForPricing = jest.fn().mockResolvedValue(null);
    s.toolCallsForPersistence = jest.fn().mockReturnValue([]);
    s.recordCodeSessionUnpriced = jest.fn();
    s.emitCollabSessionSafe = jest.fn().mockResolvedValue(undefined);
    s.assessNotePromotion = jest.fn().mockResolvedValue(undefined);
    s.captureChatCanonical = jest.fn().mockReturnValue(null);
    s.writeTrajectoryIfEnabled = jest.fn().mockResolvedValue(undefined);
    s.decideVerifyOnStop = jest.fn().mockResolvedValue(null);
    s.postAuditLogToControlPlane = jest.fn().mockResolvedValue(undefined);
    s.drainStrandedUserMessages = jest.fn().mockResolvedValue(undefined);
    createInvocationMock.mockImplementation(async (i: { id: string; triggerRef?: string }) => ({
      id: i.id, executionEngine: 'google-gemini-cli', startedAt: new Date(), threadId: null, triggeredBy: 'agent', triggerRef: i.triggerRef ?? null,
    }));
    completeInvocationMock.mockResolvedValue(undefined);
    const loadThreadHistory = jest.fn().mockResolvedValue([{ role: 'user', content: 'a thread turn the task would otherwise load' }]);
    s.loadThreadHistory = loadThreadHistory;
    return { loadThreadHistory };
  }

  it('the context resolves to the pause\'s provider and model; the transcript is restored once; the loop gets the cursor', async () => {
    const svc = new AgentExecutionService();
    const { loadThreadHistory } = stubLifecycle(svc);
    let seen: { state?: ExecutionState; objective?: string; resumeState?: HybridResumeState } = {};
    jest.spyOn(svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> }, 'runAgentHybridLoop')
      .mockImplementation(async (...a: unknown[]) => {
        seen = { state: a[0] as ExecutionState, objective: a[1] as string, resumeState: a[3] as HybridResumeState };
        return { success: true, output: 'pelican', toolCallsExecuted: 0, reasoningSteps: 1 };
      });
    const paused = pausedPayload();

    const res = await (svc as unknown as { executeTaskInner: (i: ExecuteTaskInput) => Promise<{ success: boolean }> }).executeTaskInner({
      tenantId: 't1', agentId: 'a1', workflowId: 'wf-1', taskId: 'tk-1',
      objective: paused.objective!,
      threadId: 'thread-1',
      triggeredBy: 'agent',
      triggerKey: 'wake:sched-1',
      resumeUserTurn: '[self-wake] timer elapsed; continue.',
      resumeConversationHistory: paused.conversationHistory as ConversationMessage[],
      resumeState: paused,
      modelConfigOverride: { provider: 'google', modelId: 'gemini-3.5-flash' } as unknown as ExecuteTaskInput['modelConfigOverride'],
      previousTriggerKey: 'evt:original-run',
      inputData: { eventData: { number: 81 }, _wakeChainDepth: 1 },
    });

    expect(res.success).toBe(true);
    // Resolved from the override, not from the hire's current config.
    expect(seen.state?.context.resolvedProvider).toBe('google');
    expect(seen.state?.context.resolvedModelId).toBe('gemini-3.5-flash');
    expect(createInvocationMock).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google', modelId: 'gemini-3.5-flash' }));
    // Restored once: the paused transcript, and the thread history NOT loaded on top of it.
    expect(seen.state?.conversationHistory).toEqual(PAUSED_HISTORY);
    expect(loadThreadHistory).not.toHaveBeenCalled();
    // The loop is entered with the original objective and the saved cursor.
    expect(seen.objective).toBe('Watch the deploy window. The secret word is pelican.');
    expect(seen.resumeState).toMatchObject({ pauseReason: 'self_wake', currentStepId: 'conversational' });
    // The continuation turn and the previous key ride on the context.
    expect(seen.state?.context.resumeUserTurn).toBe('[self-wake] timer elapsed; continue.');
    // The previous key is read by the audit row that starts the continuation:
    // the two invocations of one run are joined on the record an operator reads.
    const { insertAuditLog } = jest.requireMock('../../audit') as { insertAuditLog: jest.Mock };
    const started = insertAuditLog.mock.calls.map((c) => c[2] as { action: string; inputArgs: Record<string, unknown> }).find((r) => r.action === 'agent_invocation_started');
    expect(started?.inputArgs.continues_run).toBe('evt:original-run');
    // Stored, not redacted: the audit sanitizer blanks any field whose NAME
    // carries `key`, which is why the field is not named after one.
    const { sanitizeArgs } = jest.requireActual('../../audit/service') as { sanitizeArgs: (v: unknown) => unknown };
    expect((sanitizeArgs(started?.inputArgs) as Record<string, unknown>).continues_run).toBe('evt:original-run');
    expect(seen.state?.context.triggerKey).toBe('wake:sched-1');
  });

  it('an ordinary run still loads its thread history and enters the loop fresh', async () => {
    const svc = new AgentExecutionService();
    const { loadThreadHistory } = stubLifecycle(svc);
    let seen: { state?: ExecutionState; resumeState?: unknown } = {};
    jest.spyOn(svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> }, 'runAgentHybridLoop')
      .mockImplementation(async (...a: unknown[]) => {
        seen = { state: a[0] as ExecutionState, resumeState: a[3] };
        return { success: true, output: 'ok', toolCallsExecuted: 0, reasoningSteps: 1 };
      });

    await (svc as unknown as { executeTaskInner: (i: ExecuteTaskInput) => Promise<unknown> }).executeTaskInner({
      tenantId: 't1', agentId: 'a1', workflowId: 'wf-1', taskId: 'tk-1', objective: 'hello', threadId: 'thread-1', triggeredBy: 'human',
    });

    expect(loadThreadHistory).toHaveBeenCalledWith('t1', 'thread-1');
    expect(seen.state?.conversationHistory).toEqual([{ role: 'user', content: 'a thread turn the task would otherwise load' }]);
    expect(seen.resumeState).toBeUndefined();
    expect(seen.state?.context.resolvedProvider).toBe('anthropic');
    expect(seen.state?.context.resumeUserTurn).toBeUndefined();
  });
});

// ── The wait-set path continues the paused run the same way ─────────────────
describe('resumeWaitSet enters executeTask as the same continuation', () => {
  it('a fired member signals the set and hands off to resumeWaitSet; it does not run the model', async () => {
    // handleWaitSetMemberFired is reached through resumeFromWake when the
    // claimed row belongs to a wait-set. It fires the member, decides the set,
    // and enqueues the resume that resumeWaitSet runs — the continuation below.
    const svc = new AgentExecutionService();
    stubSettlement(svc);
    const { wakeWaitSetRepo } = jest.requireMock('../../scheduling/wake-wait-set-repo') as { wakeWaitSetRepo: { getById: jest.Mock } };
    wakeWaitSetRepo.getById.mockResolvedValue({ id: 'ws-1', status: 'pending', mode: 'any' });
    claimWakeForResumeMock.mockResolvedValue(claimedRow(pausedPayload(), { wait_set_id: 'ws-1' }));
    const exec = spyExecuteTask(svc);

    const res = await svc.resumeFromWake(makeContext({ workflowId: 'wf-1', taskId: 'tk-1' }), 'sched-1', 'wake-timer', {});

    expect(res.resumeNoop).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(enqueueAgentExecutionMock).toHaveBeenCalledTimes(1);
    const [, , opts] = enqueueAgentExecutionMock.mock.calls[0] as [string, string, { receiverPath: string; receiverBody: { workflowResume: Record<string, unknown> } }];
    expect(opts.receiverPath).toBe('/api/tasks/resume-execution');
    expect(opts.receiverBody.workflowResume).toEqual({ waitSetId: 'ws-1', kind: 'wake-waitset', firedKind: 'wake-timer', wakePayload: {} });
  });

  it('restores the paused run under the wait-set\'s own key, carrying the previous key', async () => {
    const svc = new AgentExecutionService();
    stubSettlement(svc);
    const payload = pausedPayload({ wakeContext: { ...WAKE_CTX, spec: { kind: 'waitset', mode: 'any', conditions: [WAKE_CTX.spec], note: 'either' } } });
    claimWaitSetMock.mockResolvedValue({
      id: 'ws-1', lease_token: 'lease-ws', workflow_resume_payload: payload, mode: 'any',
      wake_chain_depth: 1, created_at: new Date(), resume_attempts: 1, thread_id: null, origin_trust: 'trusted', thread_revision: null,
    });
    const exec = spyExecuteTask(svc);

    await svc.resumeWaitSet(makeContext(), 'ws-1', { firedKind: 'wake-event', payload: { event: { id: 'e1' } } });

    expect(exec).toHaveBeenCalledTimes(1);
    const input = exec.mock.calls[0][0] as ExecuteTaskInput;
    expect(input.objective).toBe('Watch the deploy window. The secret word is pelican.');
    expect(input.resumeUserTurn).toMatch(/one of your wait conditions fired/);
    expect(input.resumeConversationHistory).toEqual(PAUSED_HISTORY);
    expect(input.modelConfigOverride).toEqual({ provider: 'google', modelId: 'gemini-3.5-flash' });
    expect(input.triggerKey).toBe('waitset:ws-1');
    expect(input.previousTriggerKey).toBe('evt:original-run');
    expect(input.inputData).toMatchObject({ eventData: { number: 81 }, _wakeChainDepth: 1 });
  });
});

// ── The conversational loop: what the pause persists, what the wake resumes ─
function loopState(overrides: Partial<ExecutionContext> = {}): ExecutionState {
  return {
    context: {
      tenantId: 't1', agentId: 'a1', workflowId: 'wf1', taskId: 'tk1',
      instructionVersion: 1,
      instruction: { systemPrompt: 's', allowedConnectors: [] } as unknown as ExecutionContext['instruction'],
      traceId: 'tr-1',
      agentType: 'agent',
      hitlLevel: 3,
      modelConfig: { provider: 'google', modelId: 'gemini-3.5-flash' } as ExecutionContext['modelConfig'],
      resolvedProvider: 'google',
      resolvedModelId: 'gemini-3.5-flash',
      execConfig: {} as ExecutionContext['execConfig'],
      memoryScope: {} as ExecutionContext['memoryScope'],
      invocationId: 'inv-1',
      triggerKey: 'evt:original-run',
      oversight: { communication: 'review' } as ExecutionContext['oversight'],
      ...overrides,
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

function stubLoopDeps(svc: AgentExecutionService) {
  (svc as unknown as { buildPlatformMcpCatalog: (...a: unknown[]) => Promise<unknown> }).buildPlatformMcpCatalog =
    jest.fn().mockResolvedValue({ servers: [], tools: [] });
  (svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }).buildToolsSchema =
    jest.fn().mockResolvedValue([]);
  (svc as unknown as { buildSystemPrompt: (...a: unknown[]) => Promise<string> }).buildSystemPrompt =
    jest.fn().mockResolvedValue('SYSTEM');
  (svc as unknown as { checkAbortSignal: (...a: unknown[]) => Promise<boolean> }).checkAbortSignal =
    jest.fn().mockResolvedValue(false);
  (svc as unknown as { checkUserInterruptSignal: (...a: unknown[]) => Promise<unknown> }).checkUserInterruptSignal =
    jest.fn().mockResolvedValue(null);
}

async function runConversational(svc: AgentExecutionService, state: ExecutionState, objective: string, resumeState?: HybridResumeState) {
  return (svc as unknown as {
    runConversationalTurnsViaAdapter: (
      state: ExecutionState, objective: string, inputData: Record<string, unknown> | undefined, adapter: unknown, resumeState?: unknown,
    ) => Promise<{ success: boolean; paused?: boolean; output?: string }>;
  }).runConversationalTurnsViaAdapter(state, objective, undefined, stubAdapter(), resumeState);
}

function persistedWakePayload(): HybridResumeState {
  const insert = queryMock.mock.calls.find((c: unknown[]) =>
    typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_scheduled_invocations'));
  expect(insert).toBeDefined();
  return JSON.parse((insert![1] as unknown[])[8] as string) as HybridResumeState;
}

describe('the conversational self_wake pause persists what the wake restores', () => {
  it('provider, model, objective, key, and the transcript ending in the wake call and its marker', async () => {
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    adapterInvokeMock.mockImplementation(async function* () {
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'Noted: pelican. I will wait for the window.' }] };
      yield { type: 'tool_call_started', toolName: 'sleep_until', args: { at: '2026-09-16T10:00:00Z', note: 'wait for the window' }, callId: 'call-wake' };
      yield { type: 'tool_call_finished', callId: 'call-wake', result: { content: [{ type: 'text', text: MARKER }] } };
      yield { type: 'pause_requested', reason: 'self_wake', token: { adapterKind: 'anthropic', serialized: 'tok' }, wakeContext: { ...WAKE_CTX, scheduledInvocationId: undefined } };
    });

    const result = await runConversational(svc, loopState(), 'Watch the deploy window. The secret word is pelican.');

    expect(result.paused).toBe(true);
    const persisted = persistedWakePayload();
    expect(persisted.pauseReason).toBe('self_wake');
    expect(persisted.currentStepId).toBe('conversational');
    expect(persisted.objective).toBe('Watch the deploy window. The secret word is pelican.');
    expect(persisted.triggerKey).toBe('evt:original-run');
    expect(persisted.provider).toBe('google');
    expect(persisted.model).toBe('gemini-3.5-flash');
    const history = persisted.conversationHistory ?? [];
    // The opening turn and the assistant's text, then the wake exchange, once.
    expect(history[0]).toMatchObject({ role: 'user' });
    expect(String(history[0].content)).toContain('pelican');
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'Noted: pelican. I will wait for the window.' });
    expect(history.slice(-2)).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-wake', name: 'sleep_until', input: { at: '2026-09-16T10:00:00Z', note: 'wait for the window' } }] },
      { role: 'tool', toolCallId: 'call-wake', toolName: 'sleep_until', content: JSON.stringify({ content: [{ type: 'text', text: MARKER }] }) },
    ]);
    expect(history.filter((m) => m.role === 'tool' && m.toolCallId === 'call-wake')).toHaveLength(1);
  });

  it('finds the wake call among the in-flight calls when the engine paused before reporting its result', async () => {
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    adapterInvokeMock.mockImplementation(async function* () {
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'Waiting.' }] };
      yield { type: 'tool_call_started', toolName: 'sleep_until', args: { at: '2026-09-16T10:00:00Z', note: 'wait' }, callId: 'call-wake' };
      yield { type: 'pause_requested', reason: 'self_wake', token: { adapterKind: 'openai', serialized: 'tok' }, wakeContext: { ...WAKE_CTX, scheduledInvocationId: undefined } };
    });

    await runConversational(svc, loopState(), 'Wait.');

    const history = persistedWakePayload().conversationHistory ?? [];
    expect(history.slice(-2)).toMatchObject([
      { role: 'assistant', toolCalls: [{ id: 'call-wake', name: 'sleep_until' }] },
      { role: 'tool', toolCallId: 'call-wake', toolName: 'sleep_until' },
    ]);
    expect(String(history[history.length - 1].content)).toContain('__wakePending');
  });

  it('a pause raised by the continuation is stored under the continuation\'s own key', async () => {
    // The continued run (key wake:sched-1) sleeps again. Its pause must be
    // saved under wake:sched-1, so a chained second wake finds the continued
    // state in its own row rather than in the original run's.
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    adapterInvokeMock.mockImplementation(async function* () {
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'Still waiting.' }] };
      yield { type: 'tool_call_started', toolName: 'sleep_until', args: { at: '2026-09-16T11:00:00Z', note: 'again' }, callId: 'call-wake-2' };
      yield { type: 'tool_call_finished', callId: 'call-wake-2', result: { content: [{ type: 'text', text: MARKER }] } };
      yield { type: 'pause_requested', reason: 'self_wake', token: { adapterKind: 'anthropic', serialized: 'tok' }, wakeContext: { ...WAKE_CTX, scheduledInvocationId: undefined } };
    });
    const state = loopState({ triggerKey: 'wake:sched-1', resumeUserTurn: '[self-wake] timer elapsed; continue.' });
    state.conversationHistory = PAUSED_HISTORY.map((m) => ({ ...m }));

    await runConversational(svc, state, 'Watch the deploy window. The secret word is pelican.', pausedPayload());

    const persisted = persistedWakePayload();
    expect(persisted.triggerKey).toBe('wake:sched-1');
    // The continued transcript: the restored history, the wake message, the new
    // exchange — the first wake pair exactly once, the second exactly once.
    const history = persisted.conversationHistory ?? [];
    expect(history.filter((m) => m.role === 'tool' && m.toolCallId === 'call-wake')).toHaveLength(1);
    expect(history.filter((m) => m.role === 'tool' && m.toolCallId === 'call-wake-2')).toHaveLength(1);
    expect(history.some((m) => m.role === 'user' && m.content === '[self-wake] timer elapsed; continue.')).toBe(true);

    // A chained second wake finds the continued state in that row: it reads
    // under the continuation's key and restores the continued transcript.
    const chained = new AgentExecutionService();
    stubSettlement(chained);
    claimWakeForResumeMock.mockResolvedValue(claimedRow(
      { ...persisted, wakeContext: { ...persisted.wakeContext!, scheduledInvocationId: 'sched-2' } },
      { id: 'sched-2', wake_chain_depth: 2 },
    ));
    const exec = spyExecuteTask(chained);
    await chained.resumeFromWake(makeContext(), 'sched-2', 'wake-timer', {});
    const input = exec.mock.calls[0][0] as ExecuteTaskInput;
    expect(input.previousTriggerKey).toBe('wake:sched-1');
    expect(input.triggerKey).toBe('wake:sched-2');
    expect(input.objective).toBe('Watch the deploy window. The secret word is pelican.');
    expect(input.resumeConversationHistory).toEqual(history);
    expect(input.inputData).toMatchObject({ _wakeChainDepth: 2 });
  });
});

describe('the conversational continuation puts the restored transcript and the wake turn in front of the model', () => {
  it('the wake message is the last user turn, after the restored history, and the objective prompt is not pushed again', async () => {
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    adapterInvokeMock.mockImplementation(async function* () {
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'The word was pelican.' }] };
      yield { type: 'completion', outcome: 'success' };
    });
    const wakeMessage = '[self-wake] timer elapsed; continue.';
    const state = loopState({ triggerKey: 'wake:sched-1', resumeUserTurn: wakeMessage });
    state.conversationHistory = PAUSED_HISTORY.map((m) => ({ ...m }));

    const result = await runConversational(svc, state, 'Watch the deploy window. The secret word is pelican.', pausedPayload());

    expect(result.success).toBe(true);
    expect(result.output).toBe('The word was pelican.');
    expect(adapterInvokeMock).toHaveBeenCalledTimes(1);
    const input = adapterInvokeMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: Array<{ type: string; text?: string; callId?: string; toolName?: string; result?: unknown }> }>;
      provider: string; model: string;
    };
    const texts = input.messages.map((m) => `${m.role}:${m.content.map((c) => c.text ?? '').join('')}`);
    // Restored history first (the objective at its head), the wake turn last.
    expect(texts[0]).toContain('The secret word is pelican');
    expect(texts[texts.length - 1]).toBe(`user:${wakeMessage}`);
    // The wake exchange is in front of the model exactly once, and it keeps
    // its identity: the call as a tool_use block, the marker as the
    // tool_result for that call — not as prose.
    const blocks = input.messages.flatMap((m) => m.content);
    const wakeUses = blocks.filter((c) => c.type === 'tool_use' && c.callId === 'call-wake');
    const wakeResults = blocks.filter((c) => c.type === 'tool_result' && c.callId === 'call-wake');
    expect(wakeUses).toHaveLength(1);
    expect(wakeUses[0]).toMatchObject({ toolName: 'sleep_until' });
    expect(wakeResults).toHaveLength(1);
    expect(String(wakeResults[0].result)).toContain('__wakePending');
    expect(texts.filter((t) => t.includes('__wakePending'))).toHaveLength(0);
    // The task framing is not re-applied: exactly one turn carries it.
    expect(texts.filter((t) => t.includes('Please complete the following task'))).toHaveLength(1);
    // The model is the pause's.
    expect(input.provider).toBe('google');
    expect(input.model).toBe('gemini-3.5-flash');
    // The wake message was pushed once onto the run's own history.
    expect(state.conversationHistory.filter((m) => m.role === 'user' && m.content === wakeMessage)).toHaveLength(1);
  });
});

// ── The workflow loop: cursor behaviour per step type ────────────────────────
describe('the workflow loop resumes a wake per step type', () => {
  function workflowService(steps: WorkflowStep[]) {
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    const state = loopState({ workflowSteps: steps, agentType: 'workflow', resumeUserTurn: '[self-wake] timer elapsed; continue.' });
    return { svc, state };
  }

  async function runLoop(svc: AgentExecutionService, state: ExecutionState, resumeState: HybridResumeState) {
    return (svc as unknown as {
      runAgentHybridLoop: (state: ExecutionState, objective: string, inputData: unknown, resumeState: unknown, adapter: unknown) => Promise<{ success: boolean; error?: string }>;
    }).runAgentHybridLoop(state, 'Watch the deploy window.', resumeState.inputData, resumeState, stubAdapter());
  }

  const TOOL_STEPS: WorkflowStep[] = [
    { stepId: 's1', type: 'tool_call', description: 'wait', toolName: 'sleep_until', toolInput: { at: '2026-09-16T10:00:00Z' }, onSuccess: 's2' },
    { stepId: 's2', type: 'tool_call', description: 'post', toolName: 'slack__post_message', toolInput: { text: 'window open' }, onSuccess: '' },
  ] as WorkflowStep[];

  it('a tool_call step that scheduled the wait advances with its result recorded and is not dispatched again', async () => {
    const { svc, state } = workflowService(TOOL_STEPS);
    const dispatched: string[] = [];
    jest.spyOn(
      svc as unknown as { executeToolCalls: (s: unknown, calls: Array<{ connector: string; actionType: string; id: string }>) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockImplementation(async (_s, calls) => {
      for (const c of calls) dispatched.push(`${c.connector}__${c.actionType}`);
      return calls.map((c) => ({ id: c.id, success: true, result: { ok: true } }));
    });
    const capturedOutputs: Record<string, unknown> = {};
    // The registry as the next step sees it: s1's recorded output.
    jest.spyOn(svc as unknown as { executeToolStep: (...a: unknown[]) => Promise<unknown> }, 'executeToolStep')
      .mockImplementation(async (...a: unknown[]) => {
        Object.assign(capturedOutputs, a[6] as Record<string, unknown>);
        dispatched.push((a[1] as WorkflowStep).toolName ?? '');
        return { success: true, output: { posted: true } };
      });

    const res = await runLoop(svc, state, pausedPayload({
      currentStepId: 's1', resumeAfterStepId: 's1', stepOutput: { eventData: { number: 81 } },
      conversationHistory: PAUSED_HISTORY,
    }));

    expect(res.success).toBe(true);
    // The wait step ran once — before the pause — and is not dispatched now.
    expect(dispatched).toEqual(['slack__post_message']);
    // Its result is on the registry when s2 runs.
    expect(capturedOutputs.s1).toEqual({ __wakePending: { spec: WAKE_CTX.spec, originTrust: 'trusted', wakeChainDepth: 0 } });
  });

  const ADAPTER_STEPS: WorkflowStep[] = [
    { stepId: 's1', type: 'llm_reason', description: 'wait then report', onSuccess: 's2', onFailure: 's-err' },
    { stepId: 's2', type: 'tool_call', description: 'post', toolName: 'slack__post_message', toolInput: { text: 'done' }, onSuccess: '' },
    { stepId: 's-err', type: 'tool_call', description: 'page', toolName: 'pager__notify', toolInput: { msg: 'could not resume' }, onSuccess: '' },
  ] as WorkflowStep[];

  it('an adapter step paused inside its turn is re-entered with its transcript and the wake message', async () => {
    const { svc, state } = workflowService(ADAPTER_STEPS);
    const invoke = jest.spyOn(svc as unknown as { invokeStepLLM: (...a: unknown[]) => Promise<unknown> }, 'invokeStepLLM')
      .mockResolvedValue({ output: 'The word was pelican.' });
    const ran: string[] = [];
    jest.spyOn(svc as unknown as { executeToolStep: (...a: unknown[]) => Promise<unknown> }, 'executeToolStep')
      .mockImplementation(async (...a: unknown[]) => { ran.push((a[1] as WorkflowStep).stepId); return { success: true, output: {} }; });

    const res = await runLoop(svc, state, pausedPayload({ currentStepId: 's1', resumeAfterStepId: 's1', conversationHistory: PAUSED_HISTORY }));

    expect(res.success).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    const resume = invoke.mock.calls[0][9] as { transcript: ConversationMessage[]; continuationTurn: string };
    expect(resume.continuationTurn).toBe('[self-wake] timer elapsed; continue.');
    expect(resume.transcript).toEqual(PAUSED_HISTORY);
    // Its output produced, the graph advanced along onSuccess.
    expect(ran).toEqual(['s2']);
  });

  it('an older payload with no transcript takes the failure path and logs legacy_fallback', async () => {
    const { svc, state } = workflowService(ADAPTER_STEPS);
    const invoke = jest.spyOn(svc as unknown as { invokeStepLLM: (...a: unknown[]) => Promise<unknown> }, 'invokeStepLLM')
      .mockResolvedValue({ output: 'should not run' });
    const ran: string[] = [];
    jest.spyOn(svc as unknown as { executeToolStep: (...a: unknown[]) => Promise<unknown> }, 'executeToolStep')
      .mockImplementation(async (...a: unknown[]) => { ran.push((a[1] as WorkflowStep).stepId); return { success: true, output: {} }; });
    const { logger } = jest.requireMock('../../infrastructure/logging') as { logger: { warn: jest.Mock } };

    const res = await runLoop(svc, state, pausedPayload({ currentStepId: 's1', resumeAfterStepId: 's1', conversationHistory: undefined, provider: undefined }));

    expect(res.success).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    // The step's model turn cannot be resumed; onFailure ran, onSuccess did not.
    expect(ran).toEqual(['s-err']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 's1', resume_mode: 'legacy_fallback' }),
      expect.stringMatching(/no transcript/),
    );
  });

  it('a resumed workflow resolves {{input.<field>}} from the paused input', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', type: 'tool_call', description: 'wait', toolName: 'sleep_until', toolInput: {}, onSuccess: 's2' },
      { stepId: 's2', type: 'tool_call', description: 'read', toolName: 'github__pull_request_read', toolInput: { number: '{{input.eventData.number}}' }, onSuccess: '' },
    ] as WorkflowStep[];
    const { svc, state } = workflowService(steps);
    const seenInput: unknown[] = [];
    jest.spyOn(svc as unknown as { executeToolStep: (...a: unknown[]) => Promise<unknown> }, 'executeToolStep')
      .mockImplementation(async (...a: unknown[]) => { seenInput.push(a[3]); return { success: true, output: {} }; });

    // As runWakeContinuation hands it over: the paused input with the lineage inside.
    const inputData = { eventData: { number: 81 }, _wakeChainDepth: 1 };
    await (svc as unknown as {
      runAgentHybridLoop: (state: ExecutionState, objective: string, inputData: unknown, resumeState: unknown, adapter: unknown) => Promise<unknown>;
    }).runAgentHybridLoop(state, 'Watch.', inputData, pausedPayload({ currentStepId: 's1', resumeAfterStepId: 's1', inputData }), stubAdapter());

    expect(seenInput).toEqual([inputData]);
  });
});

// ── A nested wake still gets depth+1 off the restored inputData ──────────────
describe('createWakePause reads the lineage from the restored inputData', () => {
  it('a wake raised by the continuation is one deeper than the wake that resumed it', async () => {
    const svc = new AgentExecutionService();
    const state = loopState();
    await svc.createWakePause(state, { spec: WAKE_CTX.spec, originTrust: 'trusted', wakeChainDepth: 0 }, {
      kind: 'hybrid-pause', pauseReason: 'self_wake', currentStepId: 'conversational', resumeAfterStepId: 'conversational',
      stepOutput: null, inputData: { eventData: { number: 81 }, _wakeChainDepth: 1 },
      perStepRecoveries: {}, totalRecoveries: 0, recoveryHistory: [],
    });
    const persisted = persistedWakePayload();
    expect(persisted.wakeContext?.wakeChainDepth).toBe(2);
    expect(persisted.inputData).toEqual({ eventData: { number: 81 }, _wakeChainDepth: 1 });
  });
});
