// A turn that fills the guarded share of its window CLOSES — with the reply
// still to be written — instead of running on until the provider rejects it.
//
// Three things used to happen to a runtime turn that filled its window, and
// none of them was this: the run errored, the session was retired, or the chat
// JSONL was cleared — and every one of those suppresses the closing prose. A
// team agent that filled its window said NOTHING to the person waiting on it.
//
// What is asserted here is the terminal shape, because that is what carries the
// reply: `limit_reached` is the state the chat handler reads as "a bound closed
// this turn", which is what produces the closing reply and, when that reply
// says the work is unfinished, the continuation. An error state would suppress
// the prose; a success state would claim the objective was met.
//
// The SHARE itself is not asserted here — @liftoffos/turn-bounds owns the case
// table and tests it. This asserts the WIRING and the resulting action.

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
jest.mock('../../llm/pricing', () => ({
  calculateCost: jest.fn().mockReturnValue(0),
  // The window lookup normalises the model id before reading the registry
  // overlay, so a stub that omits it makes every run an adapter error.
  normalizeModelId: (m: string) => m,
}));
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
jest.mock('../../usage-ledger/service', () => ({
  // The usage event this suite drives is the one the ledger records, so the
  // stub has to answer that call rather than merely exist.
  UsageLedgerService: jest.fn().mockImplementation(() => ({
    recordUsage: jest.fn().mockResolvedValue(undefined),
  })),
}));
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
// The autonomous-resume half of the loop: off by default here (every other
// case in this file is an ordinary turn), switched on by the one case about it.
jest.mock('../autonomous-session', () => ({
  isAutonomousResumeEnabled: jest.fn().mockReturnValue(false),
  prepareAutonomousSession: jest.fn().mockResolvedValue({ sessionStateDir: '/tmp/x' }),
  readRunSessionJsonl: jest.fn().mockResolvedValue(null),
  saveRunSession: jest.fn().mockResolvedValue(undefined),
  retireRunSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../run-state/service', () => ({
  // The loop appends a run-state item per assistant message and per usage
  // event. Any method this suite reaches is bookkeeping, and bookkeeping must
  // never decide the outcome of the run it describes.
  agentRunStateService: new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }),
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


import { setModelContextWindows } from '../../llm/context-window';

/** A usage event as an adapter emits it, then a healthy completion. A guarded
 *  turn never reaches the completion: the abort ends the stream first. */
function streamWith(contextTokens: number) {
  return async function* (_input: unknown, signal: AbortSignal) {
    yield { type: 'assistant_message', content: [{ type: 'text', text: 'Half an answer.' }] };
    yield { type: 'usage', usage: { inputTokens: contextTokens, outputTokens: 10, cachedTokens: 0, contextTokens } };
    // A real adapter stops when its signal is aborted. Honouring it here is
    // what makes this a test of the guard rather than of the stub.
    if (signal.aborted) return;
    yield { type: 'completion', outcome: 'success', reason: 'success' };
  };
}

function runLoop(svc: AgentExecutionService, state: ExecutionState, adapter: unknown) {
  return (svc as unknown as {
    runConversationalTurnsViaAdapter: (
      state: ExecutionState,
      objective: string,
      inputData: Record<string, unknown> | undefined,
      adapter: unknown,
      resumeState?: unknown,
    ) => Promise<{ success: boolean; terminalState?: string; failureClass?: string; output?: string; error?: string }>;
  }).runConversationalTurnsViaAdapter(state, 'test', undefined, adapter, undefined);
}

function stubService(): AgentExecutionService {
  const svc = new AgentExecutionService();
  (svc as unknown as { buildPlatformMcpCatalog: (...a: unknown[]) => Promise<unknown> }).buildPlatformMcpCatalog =
    jest.fn().mockResolvedValue({ servers: [], tools: [] });
  (svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }).buildToolsSchema =
    jest.fn().mockResolvedValue([]);
  return svc;
}

function stubAdapter(contextTokens: number) {
  return {
    invoke: jest.fn().mockImplementation(streamWith(contextTokens)),
    pause: jest.fn(),
    resume: jest.fn(),
    registerToolCatalog: jest.fn(),
    registerHitlGate: jest.fn(),
    registerAnomalyHandler: jest.fn(),
  };
}

// The model this run is served by, and the window the registry records for it.
const MODEL = 'claude-opus-5';
const WINDOW = 200_000;

/** An interactive chat turn: the one shape that has a closing reply to write
 *  and a continuation to queue, which is what `streamSink` marks. */
function stateOnModel(): ExecutionState {
  const state = makeState();
  // `resolveAdapterModel` reads `modelId` (or the resolved id stamped on the
  // context), not `model`: the window has to describe the model that actually
  // runs, so the test has to name it the way the run does.
  (state.context.modelConfig as { provider: string; modelId?: string }).modelId = MODEL;
  (state.context as { streamSink?: () => void }).streamSink = () => undefined;
  return state;
}

/** The same run with nobody watching: an autonomous invocation, which has no
 *  reply to write and no continuation to queue. */
function autonomousState(): ExecutionState {
  const state = stateOnModel();
  delete (state.context as { streamSink?: () => void }).streamSink;
  return state;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Nobody pressed stop in any of these: the mid-run abort check reads a row
  // and there is none.
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  setModelContextWindows(new Map([[`anthropic:${MODEL}`, WINDOW]]));
});
afterEach(() => setModelContextWindows(null));

describe('a turn that crosses the guarded share of its window', () => {
  it('ends as limit_reached — the state that carries a closing reply — not as an error', async () => {
    // 150,000 of a recorded 200,000 is past seven tenths, and well short of the
    // 0.99 at which the provider has already truncated and there is no room
    // left to write anything.
    const result = await runLoop(stubService(), stateOnModel(), stubAdapter(150_000));

    expect(result.terminalState).toBe('limit_reached');
    expect(result.failureClass).toBe('limit_reached');
    expect(result.success).toBe(false);
  });

  it('keeps what the turn had already said, so the reply is written from it', async () => {
    const result = await runLoop(stubService(), stateOnModel(), stubAdapter(150_000));
    expect(result.output).toBe('Half an answer.');
  });

  it('does not say the model ran out of room, so no session is retired on its prose', async () => {
    // resume-safety retires an autonomous session on a completion that says the
    // model ran out of room. This turn did not: it stopped SHORT of the ceiling
    // precisely so the session stays usable, and the wording has to carry that.
    const { contextExhaustedCompletion } = await import('../resume-safety');
    const result = await runLoop(stubService(), stateOnModel(), stubAdapter(150_000));
    expect(contextExhaustedCompletion(result.error)).toBe(false);
    expect(contextExhaustedCompletion(result.output)).toBe(false);
  });

  it('ends the engine turn rather than letting it run on', async () => {
    const adapter = stubAdapter(150_000);
    await runLoop(stubService(), stateOnModel(), adapter);
    // The signal the loop handed the adapter was aborted.
    const signal = adapter.invoke.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(true);
  });
});

describe('a turn that has room', () => {
  it('runs to its own completion', async () => {
    const result = await runLoop(stubService(), stateOnModel(), stubAdapter(20_000));
    expect(result.terminalState).not.toBe('limit_reached');
    expect(result.success).toBe(true);
  });

  it('is measured against the model\'s OWN window, not a conservative default', async () => {
    // The defect the registry migration fixes, from this side. 100,000 tokens
    // is past seven tenths of the 128,000 fallback and comfortably inside a
    // recorded 200,000; a run on a model nobody had sized closed here.
    setModelContextWindows(new Map([[`anthropic:${MODEL}`, 1_000_000]]));
    const result = await runLoop(stubService(), stateOnModel(), stubAdapter(500_000));
    expect(result.terminalState).not.toBe('limit_reached');
  });
});

describe('an autonomous run, which has no reply to write', () => {
  it('is NOT closed at the guarded share: it runs on', async () => {
    // A graceful close produces a closing reply and a continuation, and an
    // autonomous run has neither. Cutting it at 0.7 would simply discard the
    // thirty per cent of window it could still have worked in.
    const result = await runLoop(stubService(), autonomousState(), stubAdapter(150_000));
    expect(result.terminalState).not.toBe('limit_reached');
    expect(result.success).toBe(true);
  });

  it('a RESUMABLE one is left alone for a second reason: closing it would livelock', async () => {
    // It checkpoints its transcript and the next delivery of the same trigger
    // restores it. What breaks that cycle is retirement, and retirement fires
    // from `peakContextRatio` at 0.99 — a peak of 0.7 never reaches it. So a
    // close here would mean every later delivery restoring the same saturated
    // conversation, tripping the guard on its first call, and ending having
    // done nothing, forever.
    const { isAutonomousResumeEnabled, prepareAutonomousSession } = jest.requireMock('../autonomous-session');
    (isAutonomousResumeEnabled as jest.Mock).mockReturnValue(true);
    (prepareAutonomousSession as jest.Mock).mockResolvedValue({ sessionStateDir: '/tmp/x', resumeSessionId: 'sess-1' });

    const state = autonomousState();
    (state.context as { triggerKey?: string }).triggerKey = 'trigger-1';
    const result = await runLoop(stubService(), state, stubAdapter(150_000));

    expect(result.terminalState).not.toBe('limit_reached');
  });
});

describe('a model the registry has not sized', () => {
  it('is still guarded, at the shared conservative window', async () => {
    // It used to be guarded at nothing: the runtime refused to act on anything
    // but a registry figure, so an unsized model ran until the provider
    // rejected it. A graceful close may run on the fallback — closing one round
    // early costs a round, and the work continues as a continuation.
    setModelContextWindows(new Map());
    const result = await runLoop(stubService(), stateOnModel(), stubAdapter(100_000));
    expect(result.terminalState).toBe('limit_reached');
  });
});
