// The ask check at the recovery dispatch (ask-check.ts, wired in service.ts):
// it runs only after `recovery_decision` returned `ask_user` or a
// customer-facing `escalate`, never on `continue`, `complete`, `fail`, and
// never on a system_internal escalation or a blocker. A self-answered
// `ask_user` is not parked: the dispatch asks for the re-ask with the hint,
// the record is written as `self_answered` with no pause row, and nothing is
// written to `messages`.

const askMock = jest.fn();
jest.mock('../../typesafe/client', () => ({ ask: (...a: unknown[]) => askMock(...a) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const createEscalationMock = jest.fn().mockResolvedValue('esc-1');
jest.mock('../engine/escalation-helper', () => ({
  createEscalation: (...a: unknown[]) => createEscalationMock(...a),
  escalationKindById: jest.fn().mockResolvedValue(null),
  escalationThreadTitle: jest.fn(),
}));
jest.mock('../../streaming', () => ({
  streamingService: { emitAgentStatus: jest.fn(), emitStepResult: jest.fn(), emitHitlRequired: jest.fn(), emitHitlRejected: jest.fn() },
}));
jest.mock('../../agent-chat/agent-slack-client', () => ({ postReviewDm: jest.fn(), listAgentAssignees: jest.fn().mockResolvedValue([]) }));
jest.mock('../../tool-gateway/agent-slack-tool-catalog', () => ({ SLACK_OUTBOUND_TOOL_NAMES: new Set() }));
jest.mock('../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: { checkGate: jest.fn(), createApprovalRequest: jest.fn() },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));
jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: () => ({}), complete: jest.fn(), chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/service', () => ({ CoordinatorService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: () => ({}) }));
jest.mock('../../tool-gateway/service', () => ({
  ToolGatewayService: jest.fn().mockImplementation(() => ({ setCredentialService: jest.fn(), routeToolCall: jest.fn() })),
}));
jest.mock('../../tool-gateway/dispatcher', () => ({ getToolGatewayDispatcher: () => ({}) }));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })),
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({ updateRuntimeStatus: jest.fn(), getAgent: jest.fn() })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({ getEntitlementsClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../memory', () => ({ memoryService: { retrieve: jest.fn(), save: jest.fn() }, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: { getMessages: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../tool-interceptor', () => ({ interceptToolCalls: jest.fn((calls) => calls) }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifests: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({ resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]) }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../infrastructure/cloud-tasks', () => ({ enqueueAgentExecution: jest.fn().mockResolvedValue({ taskName: 'mock-task' }) }));
const mockPool = {
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() })),
};
jest.mock('../../infrastructure/database', () => ({ getPoolForService: jest.fn(() => mockPool), getPool: jest.fn(() => mockPool), pool: mockPool }));
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: { updateCloudTaskName: jest.fn(), markFiredByInvocationId: jest.fn().mockResolvedValue(1), markErrored: jest.fn() },
  mapRow: (row: Record<string, unknown>) => ({ id: row.id }),
}));

import type { ReasoningResult, ExecutionState, WorkflowStep, AnomalyContext } from '../types';
import { AgentExecutionService } from '../service';

import { _resetContinuationsForTesting, SELF_ANSWER_HINTS } from '../engine/ask-check';

function makeState(steps: WorkflowStep[]): ExecutionState {
  return {
    context: {
      tenantId: 'tenant-1', agentId: 'agent-1', workflowId: 'wf-1', taskId: 'task-1',
      instructionVersion: 7,
      instruction: { systemPrompt: 'You are the Sales Ops assistant.', userInstructions: 'Write the weekly summary to the Sales sheet.' } as unknown as ExecutionState['context']['instruction'],
      traceId: 'trace-1', agentType: 'agent', hitlLevel: 0,
      modelConfig: {} as ExecutionState['context']['modelConfig'],
      execConfig: {}, memoryScope: {},
      workflowSteps: steps, threadId: 'thread-1', invocationId: 'inv-1',
      oversight: { tenantId: 'tenant-1', autonomy: 'balanced', escalation: 'important', sensitiveWork: {}, communication: 'auto' },
    },
    reasoningSteps: 0, toolCallsExecuted: 3, startTime: new Date(), steps: [], conversationHistory: [],
    pendingToolCalls: [], completedToolCalls: [{ id: 'c1', success: true, name: 'sheets__list', result: { sheets: ['Sales Q3'] } }],
    toolFailureCounts: new Map(), injectedSkillIds: [],
  };
}
const step: WorkflowStep = { stepId: 's2', type: 'tool_call', toolName: 'sheets__append_row', description: 'Append the summary to the sheet', onSuccess: 's3' } as WorkflowStep;
const loop = () => ({
  stepOutputs: { s1: { sheet: 'Sales Q3' } }, enteredSteps: new Set<string>(), unsatisfiedSteps: new Set<string>(),
  salvagedSteps: new Set<string>(), salvageNotes: {},
  perStepRecoveries: { s2: 1 }, totalRecoveries: 1, recoveryHistory: [],
});
type Dispatch = (
  state: ExecutionState, steps: WorkflowStep[], decision: ReasoningResult, currentStepId: string,
  stepOutput: unknown, inputData: unknown, counters: ReturnType<typeof loop>, proposal?: unknown,
  facts?: { stepId: string; anomalyKind: AnomalyContext['kind']; detail: string; recoveriesBefore: number; totalBefore: number },
) => Promise<{ terminal: boolean; result?: unknown; retryRecovery?: boolean; selfAnswerHint?: string }>;
const dispatch = (svc: AgentExecutionService) =>
  (svc as unknown as { dispatchRecoveryDecision: Dispatch }).dispatchRecoveryDecision.bind(svc);
const facts = { stepId: 's2', anomalyKind: 'tool_error' as const, detail: 'sheet not named', recoveriesBefore: 1, totalBefore: 1 };

function selfAnswerReply(p = 0.92, source = 'inputs') {
  return {
    answers: {
      answerable_from_context: { choice: 'yes', confidence: 0.9, probabilities: { yes: p, no: 1 - p, unclear: 0 } },
      person_can_act: { choice: 'unclear', confidence: 0.5, probabilities: { yes: 0.3, no: 0.3, unclear: 0.4 } },
      answer_source: { choice: source, confidence: 0.9, probabilities: { [source]: 0.9 } },
    },
    model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'k', attempts: 1, latencyMs: 1,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetContinuationsForTesting();
  delete process.env.TR_ASK_CHECK_ENABLED;
  askMock.mockResolvedValue(null);
  mockPool.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

describe('when the check runs', () => {
  it('never on continue, complete or fail', async () => {
    const svc = new AgentExecutionService();
    (svc as unknown as { executeToolCalls: jest.Mock }).executeToolCalls = jest.fn().mockResolvedValue([{ id: 'x', success: true, result: {} }]);
    for (const decision of [
      { thinking: '', decision: 'continue', toolCalls: [], output: 'retry' },
      { thinking: '', decision: 'complete', toolCalls: [], output: 'done' },
      { thinking: '', decision: 'fail', toolCalls: [], failureReason: 'no' },
    ] as ReasoningResult[]) {
      await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, { sheet: 'Sales Q3' }, loop(), undefined, facts);
    }
    expect(askMock).not.toHaveBeenCalled();
  });

  it('never on a system_internal escalate (whoCanUnblock = platform)', async () => {
    const svc = new AgentExecutionService();
    const decision: ReasoningResult = { thinking: '', decision: 'escalate', toolCalls: [], escalationReason: 'provider down', whoCanUnblock: 'platform' };
    await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, undefined, loop(), undefined, facts);
    expect(askMock).not.toHaveBeenCalled();
    expect(createEscalationMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({ kind: 'system_internal' }));
  });

  it('never on a blocker the customer can clear (it parks as a blocker, unchecked)', async () => {
    const svc = new AgentExecutionService();
    const paused = { success: true, paused: true };
    (svc as unknown as { createClarificationPause: jest.Mock }).createClarificationPause = jest.fn().mockResolvedValue(paused);
    const decision: ReasoningResult = { thinking: '', decision: 'escalate', toolCalls: [], escalationReason: 'share the sheet', whoCanUnblock: 'customer' };
    const out = await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, undefined, loop(), undefined, facts);
    expect(askMock).not.toHaveBeenCalled();
    expect(out.result).toBe(paused);
  });

  it('runs after ask_user, with the step contract and what the run holds', async () => {
    const svc = new AgentExecutionService();
    (svc as unknown as { createClarificationPause: jest.Mock }).createClarificationPause = jest.fn().mockResolvedValue({ success: true, paused: true });
    const decision: ReasoningResult = { thinking: '', decision: 'ask_user', toolCalls: [], userQuestion: 'Which sheet should I write to?' };
    await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, { sheet: 'Sales Q3' }, loop(), undefined, facts);
    expect(askMock).toHaveBeenCalledTimes(1);
    const [set, state, opts] = askMock.mock.calls[0] as [{ id: string }, Record<string, unknown>, Record<string, unknown>];
    expect(set.id).toBe('ask_check');
    expect(state.ask).toEqual({ kind: 'question', text: 'Which sheet should I write to?' });
    expect(state.contract).toMatchObject({ kind: 'step', stepId: 's2', toolName: 'sheets__append_row', description: 'Append the summary to the sheet' });
    expect(state.known).toMatchObject({ inputs: JSON.stringify({ sheet: 'Sales Q3' }) });
    expect((state.known as { recentToolResults: string }).recentToolResults).toContain('sheets__list');
    expect((state.known as { stepOutputs: string }).stepOutputs).toContain('Sales Q3');
    expect(state.setting).toBe('important');
    expect(opts).toEqual({ deadlineMs: 30_000, tenantId: 'tenant-1', runtimeAgentId: 'agent-1', invocationId: 'inv-1' });
  });
});

describe('a self-answered ask_user', () => {
  it('is not parked: the dispatch asks for the re-ask with the hint, writes the self_answered record, and touches no messages', async () => {
    askMock.mockResolvedValue(selfAnswerReply(0.92, 'inputs'));
    const svc = new AgentExecutionService();
    const pause = jest.fn();
    (svc as unknown as { createClarificationPause: jest.Mock }).createClarificationPause = pause;
    const decision: ReasoningResult = { thinking: '', decision: 'ask_user', toolCalls: [], userQuestion: 'Which sheet should I write to?' };
    const out = await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, { sheet: 'Sales Q3' }, loop(), undefined, facts);
    expect(out).toMatchObject({ terminal: false, retryRecovery: true, selfAnswerHint: SELF_ANSWER_HINTS.inputs });
    expect(pause).not.toHaveBeenCalled();
    const inserts = mockPool.query.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_scheduled_invocations'));
    expect(inserts).toHaveLength(1);
    const [sql, params] = inserts[0] as [string, unknown[]];
    expect(sql).toContain("'fired'");
    expect(sql).toContain("'self_answered'");
    expect(sql).toContain("'recovery_llm', 'question'");
    expect(params.slice(0, 3)).toEqual(['tenant-1', 'agent-1', 'thread-1']);
    expect(JSON.parse(params[7] as string)).toMatchObject({ pauseContext: { originalQuestion: 'Which sheet should I write to?' }, selfAnswered: { source: 'inputs', probability: 0.92 } });
    expect(mockPool.query.mock.calls.some((c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO messages'))).toBe(false);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('a second ask on the same fingerprint parks as today', async () => {
    askMock.mockResolvedValue(selfAnswerReply(0.92, 'inputs'));
    const svc = new AgentExecutionService();
    const paused = { success: true, paused: true };
    const pause = jest.fn().mockResolvedValue(paused);
    (svc as unknown as { createClarificationPause: jest.Mock }).createClarificationPause = pause;
    const decision: ReasoningResult = { thinking: '', decision: 'ask_user', toolCalls: [], userQuestion: 'Which sheet should I write to?' };
    const first = await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, { sheet: 'Sales Q3' }, loop(), undefined, facts);
    expect(first.retryRecovery).toBe(true);
    const second = await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, { sheet: 'Sales Q3' }, loop(), undefined, facts);
    expect(second.result).toBe(paused);
    expect(askMock).toHaveBeenCalledTimes(1);
  });

  it('a yes with source = none parks', async () => {
    askMock.mockResolvedValue(selfAnswerReply(0.95, 'none'));
    const svc = new AgentExecutionService();
    const paused = { success: true, paused: true };
    (svc as unknown as { createClarificationPause: jest.Mock }).createClarificationPause = jest.fn().mockResolvedValue(paused);
    const decision: ReasoningResult = { thinking: '', decision: 'ask_user', toolCalls: [], userQuestion: 'Which sheet should I write to?' };
    const out = await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, undefined, loop(), undefined, facts);
    expect(out.result).toBe(paused);
  });

  it('the kill parks every ask as today', async () => {
    process.env.TR_ASK_CHECK_ENABLED = '0';
    askMock.mockResolvedValue(selfAnswerReply(0.99, 'inputs'));
    const svc = new AgentExecutionService();
    const paused = { success: true, paused: true };
    (svc as unknown as { createClarificationPause: jest.Mock }).createClarificationPause = jest.fn().mockResolvedValue(paused);
    const decision: ReasoningResult = { thinking: '', decision: 'ask_user', toolCalls: [], userQuestion: 'Which sheet?' };
    const out = await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, undefined, loop(), undefined, facts);
    expect(out.result).toBe(paused);
    expect(askMock).not.toHaveBeenCalled();
  });
});

describe('the advisor prompt carries the hint in its state section', () => {
  it('renders selfAnswerHint under "State at the moment of failure" and nowhere else', async () => {
    const { buildRecoveryPrompt } = await import('../engine/recovery-prompts');
    const prompt = buildRecoveryPrompt(
      { kind: 'tool_error', step, error: 'sheet not named' },
      [step], 'prior', 's2', [], 1, 1, undefined, undefined,
      { selfAnswerHint: SELF_ANSWER_HINTS.inputs },
    );
    const section = prompt.slice(prompt.indexOf('# State at the moment of failure'), prompt.indexOf('# Decide'));
    expect(section).toContain(`- ${SELF_ANSWER_HINTS.inputs}`);
    expect(prompt.split(SELF_ANSWER_HINTS.inputs)).toHaveLength(2);
    const without = buildRecoveryPrompt({ kind: 'tool_error', step, error: 'sheet not named' }, [step], 'prior', 's2', [], 1, 1);
    expect(without).not.toContain(SELF_ANSWER_HINTS.inputs);
  });
});

describe('a customer-facing escalation nobody in the workspace can act on', () => {
  type Surface = (state: ExecutionState, args: Record<string, unknown>) => Promise<{ kind: string; context?: Record<string, unknown> }>;
  const surface = (svc: AgentExecutionService) =>
    (svc as unknown as { escalationSurfaceAfterAskCheck: Surface }).escalationSurfaceAfterAskCheck.bind(svc);
  const notActionable = (p: number) => ({
    answers: {
      answerable_from_context: { choice: 'unclear', confidence: 0.5, probabilities: { yes: 0.3, no: 0.3, unclear: 0.4 } },
      person_can_act: { choice: 'no', confidence: 0.9, probabilities: { yes: 1 - p, no: p, unclear: 0 } },
      answer_source: { choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } },
    },
    model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'k', attempts: 1, latencyMs: 1,
  });
  const args = {
    kind: 'escalation', text: 'The provider returned 529 three times.', requestedAction: 'Retry later', whoCanUnblock: 'customer',
    fingerprint: 'report_task_outcome:inv-1', known: { inputs: {}, recentToolResults: [], stepOutputs: null },
  };

  it('posts as system_internal with the probability in context.ask_check', async () => {
    askMock.mockResolvedValue(notActionable(0.9));
    expect(await surface(new AgentExecutionService())(makeState([step]), args)).toEqual({
      kind: 'system_internal', context: { ask_check: { person_can_act: 0.9 } },
    });
    const [, state] = askMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(state.ask).toEqual({ kind: 'escalation', text: 'The provider returned 529 three times.', requestedAction: 'Retry later', whoCanUnblock: 'customer' });
    expect(state.contract).toMatchObject({ kind: 'instructions' });
  });

  it('every other answer, a sub-threshold no, null, and a system_internal kind leave it as decided', async () => {
    const svc = new AgentExecutionService();
    askMock.mockResolvedValue(notActionable(0.7));
    expect(await surface(svc)(makeState([step]), args)).toEqual({ kind: 'escalation' });
    askMock.mockResolvedValue(null);
    expect(await surface(svc)(makeState([step]), args)).toEqual({ kind: 'escalation' });
    askMock.mockClear();
    expect(await surface(svc)(makeState([step]), { ...args, kind: 'system_internal' })).toEqual({ kind: 'system_internal' });
    expect(askMock).not.toHaveBeenCalled();
  });
});
