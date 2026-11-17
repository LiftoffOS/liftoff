// resumeFromClarificationAnswer — the agent id space, and the order of the
// destructive writes.
//
// The two defects compound. The Cloud Task body carries the Platform Backend's
// internal_agents.id and every lookup here is keyed by the runtime's agents.id;
// without a translation between them `getAgent` matches zero rows and the
// resume returns `agent_unavailable`. That alone is recoverable, unless the two
// writes that consume the ask and file the answer run BEFORE the check: then
// the ask is burned, the answer is stored where no reply will ever be built
// from it, and the person is told nothing.
//
// Doesn't go all the way through runAgentHybridLoop (that needs a full fixture
// of workflow steps + adapter); it pins the translation and the write ordering
// up to that boundary.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// dispatchApprovedAndContinue calls createAdapter, which transitively
// imports the @anthropic-ai/claude-agent-sdk ESM bundle that jest can't
// parse in CJS test mode. Stub the whole adapter module — the test pins
// behaviour up to runAgentHybridLoop (which we also stub), so the actual
// adapter never runs.
jest.mock('../adapter', () => ({
  createAdapter: jest.fn().mockReturnValue({
    registerToolCatalog: jest.fn(),
    registerHitlGate: jest.fn(),
    registerAnomalyHandler: jest.fn(),
    invoke: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
  }),
}));

const getApprovalRequestMock = jest.fn();
const getOversightSettingsMock = jest.fn();
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    getApprovalRequest: (...a: unknown[]) => getApprovalRequestMock(...a),
    getOversightSettings: (...a: unknown[]) => getOversightSettingsMock(...a),
    createApprovalRequest: jest.fn(),
    checkHitlGate: jest.fn().mockResolvedValue({ shouldGate: false }),
  },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));

const queryMock = jest.fn();
const poolMock = {
  query: queryMock,
  connect: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
};
// The tenant-scoped client the pause checkpoint table is read through; empty
// unless a case seeds a row.
const tenantClientQueryMock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => poolMock),
  getPool: jest.fn(() => poolMock),
  pool: poolMock,
  withTenantScope: (_tenantId: string, fn: (c: { query: typeof tenantClientQueryMock }) => Promise<unknown>) => fn({ query: tenantClientQueryMock }),
}));

const updateRuntimeStatusMock = jest.fn().mockResolvedValue(undefined);
const getAgentMock = jest.fn();
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: updateRuntimeStatusMock,
    getAgent: getAgentMock,
  })),
}));

const insertAuditLogMock = jest.fn();
jest.mock('../../audit', () => ({ insertAuditLog: insertAuditLogMock }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));

jest.mock('../../streaming', () => ({
  streamingService: {
    emitHitlRequired: jest.fn(),
    emitHitlRejected: jest.fn(),
    emitToolStart: jest.fn(),
    emitToolComplete: jest.fn(),
  },
}));

// Other constructor deps — all no-op
jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({ getToolGatewayDispatcher: jest.fn().mockReturnValue({ execute: jest.fn(), executeBatch: jest.fn() }) }));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''),
  getTenantRuntimeUrl: jest.fn().mockReturnValue(''),
  tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })) }));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({ getEntitlementsClient: jest.fn().mockReturnValue({}) }));
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
jest.mock('../../connectors/connector-service-client', () => ({ getPrefetchThreadClient: jest.fn().mockReturnValue({}) }));

// Structured HITL resume (§4.10 Part C). Default: disabled → tryStructuredHitlResume
// returns null and the snapshot-replay path runs (so all existing tests are
// unchanged). The structured test below flips mockIsAutonomousEnabled on + makes
// loadRunSession return a saved session.
const mockIsAutonomousEnabled = jest.fn(() => false);
const mockLoadRunSession = jest.fn();
jest.mock('../autonomous-session', () => ({
  isAutonomousResumeEnabled: () => mockIsAutonomousEnabled(),
  loadRunSession: (...a: unknown[]) => mockLoadRunSession(...a),
  restoreRunSessionToDisk: jest.fn().mockResolvedValue(undefined),
  autonomousSessionDir: (tk: string) => `/tmp/sess/${tk}`,
  saveRunSession: jest.fn().mockResolvedValue(undefined),
  readRunSessionJsonl: jest.fn().mockResolvedValue(null),
}));

import { AgentExecutionService } from '../service';
import type { ExecutionContext, ExecutionState } from '../types';
import type { CanonicalMessage } from '../../trajectories/types';
import { scrubLogger } from '../../observability/scrub-logger';
import { sha256, canonicalSerialize } from '../session-artifact-envelope';


// The two id spaces. PB addresses the agent as INTERNAL_AGENT_ID; every
// runtime-keyed table uses RUNTIME_AGENT_ID. They are deliberately unequal.
const INTERNAL_AGENT_ID = '5e4acb47-c63b-4f3f-a90d-aedcedbda8eb';
const RUNTIME_AGENT_ID = 'abbb7a1c-f66f-46d8-b65a-e2e52ea77568';

/** The context the Cloud Task handler builds: PB's id, untranslated. */
function makeTaskContext(): ExecutionContext {
  return {
    tenantId: 't1', agentId: INTERNAL_AGENT_ID, workflowId: '', taskId: '',
    instructionVersion: 0,
    instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' } as unknown as ExecutionContext['instruction'],
    traceId: 'tr-1', agentType: 'agent',
    hitlLevel: 3,
    modelConfig: {} as ExecutionContext['modelConfig'],
    execConfig: {} as ExecutionContext['execConfig'],
    memoryScope: {} as ExecutionContext['memoryScope'],
    invocationId: 'inv-1',
  };
}

const CLARIFICATION_ROW = {
  workflow_resume_payload: {
    kind: 'hybrid-pause',
    pauseReason: 'ask_user',
    objective: 'summarise the repos',
    inputData: {},
    executionEngine: 'openai-agents',
    pauseContext: { threadId: 'thread-1' },
  },
  // Written by the pause, in the runtime's own id space.
  agent_id: RUNTIME_AGENT_ID,
};

interface RouterOpts {
  /** Rows returned for `SELECT ... FROM agents WHERE id = $1` keyed by id. */
  agentsById?: Record<string, unknown[]>;
  instructionRows?: unknown[];
  scheduledRow?: Record<string, unknown> | null;
}

/** Route each query by its SQL so the assertions can read the calls back. */
function routeQueries(opts: RouterOpts = {}) {
  const {
    agentsById = { [RUNTIME_AGENT_ID]: [{ workflow_steps: [{ id: 'step-1' }], agent_type: 'agent' }] },
    instructionRows = [{ version: 3, instruction: null, capabilityTier: 'execution_enabled', integrations: [] }],
    scheduledRow = CLARIFICATION_ROW,
  } = opts;

  queryMock.mockReset();
  queryMock.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM agent_scheduled_invocations')) {
      return Promise.resolve({ rows: scheduledRow ? [scheduledRow] : [], rowCount: scheduledRow ? 1 : 0 });
    }
    if (sql.includes('UPDATE agent_scheduled_invocations')) return Promise.resolve({ rows: [], rowCount: 1 });
    if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [], rowCount: 1 });
    if (sql.includes('compiled_instructions')) return Promise.resolve({ rows: instructionRows });
    if (sql.includes('FROM agents WHERE id')) {
      return Promise.resolve({ rows: agentsById[params?.[0] as string] ?? [] });
    }
    if (sql.includes('internal_agent_runtime_mapping')) {
      // `by_internal` says WHICH column matched. The resolver reads it to tell
      // a translation from an id that is already a runtime one: the latter is
      // not a mapping miss and must not be warned about, because several
      // callers legitimately hold a runtime id and the warning fired on every
      // web-tool call of every run. Here the row matched by internal id, which
      // is the translation this test is about.
      return Promise.resolve({ rows: [{ agent_id: RUNTIME_AGENT_ID, by_internal: true }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

const sqlOf = (c: unknown[]) => String(c[0]);
const consumedTheAsk = () =>
  queryMock.mock.calls.some(c => sqlOf(c).includes("SET status = 'fired'"));
const filedTheAnswer = () =>
  queryMock.mock.calls.some(c => sqlOf(c).includes('INSERT INTO messages'));

describe('resumeFromClarificationAnswer — agent id space', () => {
  let service: AgentExecutionService;
  let hybridLoop: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentExecutionService();
    getAgentMock.mockReset();
    // Pinned at the runAgentHybridLoop boundary, like resume-hitl-approval:
    // past here is the conversational turn itself, which needs a full adapter
    // and a distilled prompt fixture and proves nothing about this path.
    hybridLoop = jest
      .spyOn(service as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> }, 'runAgentHybridLoop')
      .mockResolvedValue({ success: true, toolCallsExecuted: 0, reasoningSteps: 0 });
  });

  // The defect itself. The row carries the runtime id; the context carries PB's.
  it('looks the agent up by the runtime id from the row, not the id the task carried', async () => {
    routeQueries();
    getAgentMock.mockResolvedValue({ id: RUNTIME_AGENT_ID, lifecycle: 'ACTIVE' });

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    expect(getAgentMock).toHaveBeenCalledWith(RUNTIME_AGENT_ID);
    expect(getAgentMock).not.toHaveBeenCalledWith(INTERNAL_AGENT_ID);
  });

  it('loads the instruction and runtime config under the runtime id too', async () => {
    routeQueries();
    getAgentMock.mockResolvedValue({ id: RUNTIME_AGENT_ID, lifecycle: 'ACTIVE' });

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    const instructionCall = queryMock.mock.calls.find(c => sqlOf(c).includes('compiled_instructions'));
    const configCall = queryMock.mock.calls.find(c => sqlOf(c).includes('FROM agents WHERE id'));
    expect(instructionCall?.[1]).toEqual(['t1', RUNTIME_AGENT_ID]);
    expect(configCall?.[1]).toEqual([RUNTIME_AGENT_ID, 't1']);
  });

  // A row written before the pause recorded the runtime id still has to resolve.
  it('falls back to the mapping table when the row carries no agent id', async () => {
    routeQueries({ scheduledRow: { ...CLARIFICATION_ROW, agent_id: null } });
    getAgentMock.mockResolvedValue({ id: RUNTIME_AGENT_ID, lifecycle: 'ACTIVE' });

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    expect(getAgentMock).toHaveBeenCalledWith(RUNTIME_AGENT_ID);
  });
});

describe('resumeFromClarificationAnswer — the ask is not spent on a resume that cannot run', () => {
  let service: AgentExecutionService;
  let hybridLoop: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentExecutionService();
    getAgentMock.mockReset();
    // Pinned at the runAgentHybridLoop boundary, like resume-hitl-approval:
    // past here is the conversational turn itself, which needs a full adapter
    // and a distilled prompt fixture and proves nothing about this path.
    hybridLoop = jest
      .spyOn(service as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> }, 'runAgentHybridLoop')
      .mockResolvedValue({ success: true, toolCallsExecuted: 0, reasoningSteps: 0 });
  });

  it('leaves the ask and the answer alone when the agent is not resolvable', async () => {
    routeQueries();
    getAgentMock.mockResolvedValue(null);

    const result = await service.resumeFromClarificationAnswer(
      makeTaskContext(), 'sched-1', 'the platform repos',
    );

    expect(result.success).toBe(false);
    expect(consumedTheAsk()).toBe(false);
    expect(filedTheAnswer()).toBe(false);
  });

  it('leaves them alone when the agent is no longer ACTIVE', async () => {
    routeQueries();
    getAgentMock.mockResolvedValue({ id: RUNTIME_AGENT_ID, lifecycle: 'ARCHIVED' });

    const result = await service.resumeFromClarificationAnswer(
      makeTaskContext(), 'sched-1', 'the platform repos',
    );

    expect(result.success).toBe(false);
    expect(consumedTheAsk()).toBe(false);
    expect(filedTheAnswer()).toBe(false);
  });

  it('leaves them alone when the agent has no active instruction', async () => {
    routeQueries({ instructionRows: [] });
    getAgentMock.mockResolvedValue({ id: RUNTIME_AGENT_ID, lifecycle: 'ACTIVE' });

    const result = await service.resumeFromClarificationAnswer(
      makeTaskContext(), 'sched-1', 'the platform repos',
    );

    expect(result.success).toBe(false);
    expect(consumedTheAsk()).toBe(false);
    expect(filedTheAnswer()).toBe(false);
  });

  // A conversational agent has no workflow backbone, and an ask_user
  // clarification only ever arises on the conversational branch. Resuming one
  // must not require steps it was never going to have.
  it('consumes the ask and files the answer once every precondition holds', async () => {
    routeQueries({ agentsById: { [RUNTIME_AGENT_ID]: [{ workflow_steps: null, agent_type: 'agent' }] } });
    getAgentMock.mockResolvedValue({ id: RUNTIME_AGENT_ID, lifecycle: 'ACTIVE' });

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    expect(consumedTheAsk()).toBe(true);
    const insert = queryMock.mock.calls.find(c => sqlOf(c).includes('INSERT INTO messages'));
    expect(insert?.[1]).toEqual(['t1', 'thread-1', 'the platform repos']);
  });

  // The whole point of the resume: the loop gets the runtime-space context and
  // the person's answer, so the next turn actually answers what they said.
  it('hands the loop a runtime-space context carrying the answer', async () => {
    routeQueries({ agentsById: { [RUNTIME_AGENT_ID]: [{ workflow_steps: null, agent_type: 'agent' }] } });
    getAgentMock.mockResolvedValue({ id: RUNTIME_AGENT_ID, lifecycle: 'ACTIVE' });

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    expect(hybridLoop).toHaveBeenCalledTimes(1);
    const state = hybridLoop.mock.calls[0][0] as {
      context: { agentId: string; threadId?: string; userAnswerForResume?: string };
    };
    expect(state.context.agentId).toBe(RUNTIME_AGENT_ID);
    expect(state.context.threadId).toBe('thread-1');
    expect(state.context.userAnswerForResume).toBe('the platform repos');
  });

  // A resumed turn that pauses again calls createClarificationPause, which
  // moves the agent to WAITING_FOR_HUMAN. From IDLE that transition is invalid
  // and throws, taking down a turn whose answer has already been consumed. The
  // two sibling resume paths both take this leg; this one did not.
  it('moves the agent off IDLE before running, under the runtime id', async () => {
    routeQueries({ agentsById: { [RUNTIME_AGENT_ID]: [{ workflow_steps: null, agent_type: 'agent' }] } });
    getAgentMock.mockResolvedValue({ id: RUNTIME_AGENT_ID, lifecycle: 'ACTIVE' });

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    expect(updateRuntimeStatusMock).toHaveBeenCalledWith(RUNTIME_AGENT_ID, 'RUNNING');
  });
});

// ── The run's ids survive a clarification resume ────────────────────────────
//
// The task body that fires a clarification resume carries no workflow/task id,
// so `makeTaskContext()` — the task-handler shape — hands the rebuild blanks.
// The pause stamped the real ids on its row; the rebuild reads them from there
// and treats a blank as absent, so nothing downstream sees an empty string.
describe('resumeFromClarificationAnswer — the run ids come from the pause row', () => {
  const WF = '8d48512f-c961-4cee-87f2-a71e2664e8af';
  const TASK = 'd347ba93-7e22-4cbe-8e6c-0f3ad65852a9';
  let service: AgentExecutionService;
  let seen: { context?: ExecutionContext };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentExecutionService();
    getAgentMock.mockReset();
    getAgentMock.mockResolvedValue({ id: RUNTIME_AGENT_ID, lifecycle: 'ACTIVE' });
    seen = {};
    jest
      .spyOn(service as unknown as { runAgentHybridLoop: (state: { context: ExecutionContext }, ...a: unknown[]) => Promise<unknown> }, 'runAgentHybridLoop')
      .mockImplementation(async (state) => { seen.context = state.context; return { success: true, toolCallsExecuted: 0, reasoningSteps: 0 }; });
  });

  it('recovers workflowId/taskId from the stamped row when the task body carried blanks', async () => {
    routeQueries({
      scheduledRow: { ...CLARIFICATION_ROW, workflow_resume_payload: { ...CLARIFICATION_ROW.workflow_resume_payload, workflowId: WF, taskId: TASK } },
    });

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    expect(seen.context?.workflowId).toBe(WF);
    expect(seen.context?.taskId).toBe(TASK);
  });

  it('leaves the ids absent — never a blank — when the row predates the stamp', async () => {
    routeQueries();

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    expect(seen.context?.workflowId).toBeUndefined();
    expect(seen.context?.taskId).toBeUndefined();
  });

  it('restores the originating account from the stamped row', async () => {
    routeQueries({
      scheduledRow: { ...CLARIFICATION_ROW, workflow_resume_payload: { ...CLARIFICATION_ROW.workflow_resume_payload, messageSenderAccountId: 'acct-7' } },
    });

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    expect(seen.context?.messageSenderAccountId).toBe('acct-7');
  });
});

// ── A conversational ask resumes the conversation it interrupted ────────────
//
// The loop consumed `userAnswerForResume` for a paused WORKFLOW step only. A
// conversational ask re-entered with an empty history and the objective as
// its opening turn: the model never saw the answer it had waited for. Now the
// pause persists the transcript and the resume opens on the answer — from the
// pause's checkpoint when it loads and verifies, else from that transcript.
describe('resumeFromClarificationAnswer — a conversational ask continues the conversation', () => {
  const QUESTION = 'Which repos: the platform ones or the marketing site?';
  const RECORD: CanonicalMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Please complete the following task: summarise the repos' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'I need to know which repos you mean.' }] },
  ];
  const SHA = sha256(canonicalSerialize(RECORD));
  const conversationalRow = (checkpoint?: unknown) => ({
    workflow_resume_payload: {
      ...CLARIFICATION_ROW.workflow_resume_payload,
      currentStepId: 'conversational', resumeAfterStepId: 'conversational',
      provider: 'anthropic', model: 'claude-sonnet-5',
      conversationHistory: [
        { role: 'user', content: 'Please complete the following task: summarise the repos' },
        { role: 'assistant', content: 'I need to know which repos you mean.' },
      ],
      pauseContext: { threadId: 'thread-1', originalQuestion: QUESTION },
      ...(checkpoint ? { checkpoint } : {}),
    },
    agent_id: RUNTIME_AGENT_ID,
    scheduled_by_invocation_id: 'inv-1',
  });
  function seedCheckpointRow() {
    tenantClientQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM pause_checkpoints') && params[1] === 'sched-1') {
        return {
          rows: [{
            agent_id: RUNTIME_AGENT_ID, invocation_id: 'inv-1', execution_engine: 'claude-agent-sdk', provider: 'anthropic', model: 'claude-sonnet-5',
            canonical_content: JSON.parse(JSON.stringify(RECORD)), canonical_schema_version: '1.1', canonical_sha256: SHA, message_count: 2,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
  }
  const decisionLine = (info: jest.SpyInstance) =>
    info.mock.calls.map((c) => c[0] as Record<string, unknown>).find((f) => f.event === 'resume_decision');

  let service: AgentExecutionService;
  let hybridLoop: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    tenantClientQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    service = new AgentExecutionService();
    getAgentMock.mockReset();
    getAgentMock.mockResolvedValue({ id: RUNTIME_AGENT_ID, lifecycle: 'ACTIVE' });
    hybridLoop = jest
      .spyOn(service as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> }, 'runAgentHybridLoop')
      .mockResolvedValue({ success: true, toolCallsExecuted: 0, reasoningSteps: 0 });
  });

  it('from the checkpoint: the loop gets the converted record and opens on the answer, and the decision says so', async () => {
    routeQueries({ agentsById: { [RUNTIME_AGENT_ID]: [{ workflow_steps: null, agent_type: 'agent' }] }, scheduledRow: conversationalRow({ id: 'sched-1', sha256: SHA, messageCount: 2 }) });
    seedCheckpointRow();
    const info = jest.spyOn(scrubLogger, 'info');

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    const state = hybridLoop.mock.calls[0][0] as ExecutionState;
    expect(state.context.resumeTranscript).toBeDefined();
    expect(state.context.resumeTranscript!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(state.conversationHistory).toEqual([]);
    expect(state.context.resumeUserTurn).toContain(`Question: ${QUESTION}`);
    expect(state.context.resumeUserTurn).toContain('Answer: the platform repos');
    expect(state.context.skipInitialPromptPush).toBeUndefined();
    expect(decisionLine(info)).toMatchObject({ resume_kind: 'ask_user', transcript_source: 'checkpoint', checkpoint_sha256: SHA, checkpoint_message_count: 2 });
  });

  it('from the snapshot: the persisted transcript is restored and the loop opens on the answer, with the reason', async () => {
    routeQueries({ agentsById: { [RUNTIME_AGENT_ID]: [{ workflow_steps: null, agent_type: 'agent' }] }, scheduledRow: conversationalRow() });
    const info = jest.spyOn(scrubLogger, 'info');

    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');

    const state = hybridLoop.mock.calls[0][0] as ExecutionState;
    expect(state.context.resumeTranscript).toBeUndefined();
    expect(state.conversationHistory.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(state.context.resumeUserTurn).toContain('Answer: the platform repos');
    expect(decisionLine(info)).toMatchObject({ resume_kind: 'ask_user', transcript_source: 'snapshot', transcript_reason: 'pause carries no checkpoint' });
  });

  it('a workflow-step ask keeps its own path: the prologue consumes the answer, no continuation turn is set', async () => {
    routeQueries();
    const info = jest.spyOn(scrubLogger, 'info');
    await service.resumeFromClarificationAnswer(makeTaskContext(), 'sched-1', 'the platform repos');
    const state = hybridLoop.mock.calls[0][0] as ExecutionState & { context: { userAnswerForResume?: string } };
    expect(state.context.userAnswerForResume).toBe('the platform repos');
    expect(state.context.resumeUserTurn).toBeUndefined();
    expect(decisionLine(info)).toBeUndefined();
  });
});
