// A workflow `capability` step falls through to the web tools by mechanism.
//
// The first micro-turn's tools note their TYPED outcomes into a window the
// step opened (tool-gateway/capability-outcome-signal.ts). When none of them
// was useful — every run_capability failed or answered nothing, no web tool
// returned content — the step runs exactly one more turn, on a catalog
// registered from the web-only allowlist, and applies its output contract to
// whichever turn's output stands. A useful first turn ends there; a pause in
// the first turn propagates and no second turn starts.
//
// Same harness as hybrid-loop-integration.test.ts: a real service, the loop
// entered at runAgentHybridLoop, invokeStepLLM stubbed so a test can say what
// each turn's tools noted and what the turn produced.

const loggerCalls = { info: [] as unknown[], warn: [] as unknown[], error: [] as unknown[] };
jest.mock('../../infrastructure/logging', () => ({
  logger: {
    info: jest.fn((...args: unknown[]) => loggerCalls.info.push(args)),
    warn: jest.fn((...args: unknown[]) => loggerCalls.warn.push(args)),
    error: jest.fn((...args: unknown[]) => loggerCalls.error.push(args)),
    debug: jest.fn(),
  },
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
  hitlEnforcementService: { checkGate: jest.fn(), createApprovalRequest: jest.fn().mockResolvedValue({ id: 'appr-1', expiresAt: new Date() }) },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));
const llmCompleteMock = jest.fn();
jest.mock('../../llm/client', () => ({
  llmClient: { modelSelectionFor: () => ({}), complete: llmCompleteMock, chat: jest.fn() },
}));
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
const updateRuntimeStatusMock = jest.fn();
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({ updateRuntimeStatus: updateRuntimeStatusMock, getAgent: jest.fn() })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({ getEntitlementsClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../memory', () => ({ memoryService: { retrieve: jest.fn(), save: jest.fn() }, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: { getMessages: jest.fn().mockResolvedValue([]) } }));
const insertAuditLogMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../audit', () => ({ insertAuditLog: insertAuditLogMock }));
jest.mock('../../audit/service', () => ({ insertAuditLog: insertAuditLogMock }));
jest.mock('../tool-interceptor', () => ({ interceptToolCalls: jest.fn((calls) => calls) }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifests: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({ resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]) }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../infrastructure/cloud-tasks', () => ({ enqueueAgentExecution: jest.fn().mockResolvedValue({ taskName: 'mock-task' }) }));
const mockPool = {
  query: jest.fn(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('INSERT INTO agent_scheduled_invocations')) return { rows: [{ id: 'sched-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() })),
};
jest.mock('../../infrastructure/database', () => ({ getPoolForService: jest.fn(() => mockPool), getPool: jest.fn(() => mockPool), pool: mockPool }));
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: { updateCloudTaskName: jest.fn(), markFiredByInvocationId: jest.fn().mockResolvedValue(1), markErrored: jest.fn() },
  mapRow: (row: Record<string, unknown>) => ({ id: row.id }),
}));

import { AgentExecutionService } from '../service';
import { AdapterPauseRequestedError } from '../types';
import type { ExecutionState, WorkflowStep, WorkflowCapabilityNeed } from '../types';
import { _resetCapabilityWindows, noteToolOutcome } from '../../tool-gateway/capability-outcome-signal';
import { buildCapabilityStepPrompt, buildCapabilityWebFallbackPrompt, CAPABILITY_WEB_FALLBACK_TOOLS } from '../engine/capability-step-prompt';

const NEED: WorkflowCapabilityNeed = {
  operation: 'search posts', entity: 'posts', mode: 'public_data', targetSystem: 'tiktok', requiredOutputFields: ['url', 'text'],
};

function capabilityStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    stepId: 'cap-1',
    description: 'Find the latest posts about the product',
    type: 'capability',
    capabilityNeed: NEED,
    toolInput: { keyword: 'shopify', limit: 5 },
    outputField: 'posts',
    ...overrides,
  } as WorkflowStep;
}

function makeState(steps: WorkflowStep[]): ExecutionState {
  return {
    context: {
      tenantId: 'tenant-1', agentId: 'agent-1', workflowId: 'wf-1', taskId: 'task-1',
      instructionVersion: 1,
      instruction: { systemPrompt: 'test', tools: [], guardrails: [] } as unknown as ExecutionState['context']['instruction'],
      traceId: 'trace-1', agentType: 'agent', hitlLevel: 0,
      modelConfig: {} as ExecutionState['context']['modelConfig'],
      execConfig: {}, memoryScope: {},
      workflowSteps: steps, threadId: 'thread-1', invocationId: 'inv-cap',
    },
    reasoningSteps: 0, toolCallsExecuted: 0, startTime: new Date(), steps: [], conversationHistory: [],
    pendingToolCalls: [], completedToolCalls: [], toolFailureCounts: new Map(), injectedSkillIds: [],
  };
}

type InvokeArgs = [ExecutionState, WorkflowStep, unknown, unknown, string, unknown, unknown, unknown, unknown, unknown, { toolAllowlist?: ReadonlySet<string> } | undefined];

/** A turn as the test scripts it: what its tools noted, and what it produced. */
interface Turn {
  notes?: Array<[tool: string, useful: boolean]>;
  output?: unknown;
  throws?: Error;
}

function run(steps: WorkflowStep[], turns: Turn[]) {
  const service = new AgentExecutionService();
  (service as unknown as { verifyWorkflowStepsHash: jest.Mock }).verifyWorkflowStepsHash = jest.fn().mockReturnValue({ ok: true });
  (service as unknown as { buildToolsSchema: jest.Mock }).buildToolsSchema = jest.fn().mockResolvedValue([]);
  const invokeSpy = jest.spyOn(service as unknown as { invokeStepLLM: (..._a: InvokeArgs) => Promise<{ output: unknown }> }, 'invokeStepLLM');
  let turnIndex = 0;
  invokeSpy.mockImplementation(async (state) => {
    const turn = turns[turnIndex++] ?? { output: 'unscripted turn' };
    for (const [tool, useful] of turn.notes ?? []) noteToolOutcome(state.context.invocationId, tool, useful);
    if (turn.throws) throw turn.throws;
    return { output: turn.output };
  });
  const state = makeState(steps);
  const stubAdapter = { invoke: jest.fn(), pause: jest.fn(), resume: jest.fn(), registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(), registerAnomalyHandler: jest.fn() };
  const result = (service as unknown as {
    runAgentHybridLoop: (_s: ExecutionState, _o: string, _d: unknown, _r: unknown, _a: unknown) => Promise<{ success: boolean; output?: unknown; paused?: boolean; escalated?: boolean }>;
  }).runAgentHybridLoop(state, 'test', undefined, undefined, stubAdapter);
  return { result, invokeSpy, state };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetCapabilityWindows();
  loggerCalls.info.length = 0;
});

describe('a capability step whose first turn produced nothing useful', () => {
  it('runs one web-only second turn, whose recorded output is the step output', async () => {
    const step = capabilityStep();
    const { result, invokeSpy } = run([step], [
      { notes: [['run_capability', false]], output: 'The capability library returned nothing usable.' },
      { notes: [['web_search', true]], output: { posts: [{ url: 'https://x', text: 'hello' }] } },
    ]);
    const out = await result;
    expect(invokeSpy).toHaveBeenCalledTimes(2);

    const first = invokeSpy.mock.calls[0] as unknown as InvokeArgs;
    expect(first[1].description).toBe(buildCapabilityStepPrompt(NEED, { keyword: 'shopify', limit: 5 }, step.description));
    expect(first[10]).toBeUndefined();

    const second = invokeSpy.mock.calls[1] as unknown as InvokeArgs;
    expect(second[1].type).toBe('llm_reason');
    expect(second[1].description).toBe(buildCapabilityWebFallbackPrompt(
      NEED, { keyword: 'shopify', limit: 5 }, step.description, 'The capability library returned nothing usable.',
    ));
    // The second turn's catalog is registered from the allowlist: the web
    // tools plus record_step_output (the step declares an outputField), and
    // neither capability tool.
    const allow = second[10]?.toolAllowlist;
    expect(allow).toBeDefined();
    for (const name of CAPABILITY_WEB_FALLBACK_TOOLS) expect(allow!.has(name)).toBe(true);
    expect(allow!.has('record_step_output')).toBe(true);
    expect(allow!.has('capability_search')).toBe(false);
    expect(allow!.has('run_capability')).toBe(false);
    // A fresh turn, not a re-entry of the first.
    expect(second[9]).toBeUndefined();

    // The outputField contract applied to the SECOND turn's output, once.
    expect(out.success).toBe(true);
    expect(out.output).toEqual([{ url: 'https://x', text: 'hello' }]);

    const fallbackLog = loggerCalls.info.find((c) => (c as unknown[])[0] && ((c as unknown[])[0] as { event?: string }).event === 'capability_step_web_fallback');
    expect(fallbackLog).toBeDefined();
    expect((fallbackLog as unknown[])[0]).toMatchObject({ stepId: 'cap-1', capabilityRuns: 1, capabilitySuccesses: 0, webSuccesses: 0 });
  });

  it('a capability that ran and returned an empty result also falls through', async () => {
    const { result, invokeSpy } = run([capabilityStep()], [
      { notes: [['run_capability', false], ['run_capability', false]], output: { posts: [] } },
      { notes: [['web_research', true]], output: { posts: [{ url: 'u', text: 't' }] } },
    ]);
    const out = await result;
    expect(invokeSpy).toHaveBeenCalledTimes(2);
    expect(out.output).toEqual([{ url: 'u', text: 't' }]);
  });

  it('omits record_step_output from the allowlist when the step declares no outputField', async () => {
    const { result, invokeSpy } = run([capabilityStep({ outputField: undefined })], [
      { notes: [['run_capability', false]], output: 'nothing' },
      { notes: [['web_search', true]], output: 'found it' },
    ]);
    const out = await result;
    const second = invokeSpy.mock.calls[1] as unknown as InvokeArgs;
    expect(second[10]?.toolAllowlist?.has('record_step_output')).toBe(false);
    expect(out.output).toBe('found it');
  });

  it('runs no third turn: a second turn that also found nothing is the ordinary step failure', async () => {
    const { result, invokeSpy } = run([capabilityStep()], [
      { notes: [['run_capability', false]], output: 'nothing' },
      { notes: [['web_search', false]], output: 'still nothing' },
    ]);
    const out = await result;
    expect(invokeSpy).toHaveBeenCalledTimes(2);
    // The prose output fails the outputField contract → recovery owns what
    // happens next; the step's own result never stands as the output.
    expect(out.output).not.toBe('still nothing');
    expect(out.success && !out.escalated).toBe(false);
  });
});

// A first turn that DIED — a tool error the adapter escalated, a provider
// error — with nothing useful behind it has produced no useful result, which
// is the plan's condition for the second turn; one that died after the
// capability had answered is the ordinary step failure.
describe('a capability step whose first turn threw', () => {
  it('runs the web-only second turn when the failed turn had nothing useful, and logs the failure', async () => {
    const { result, invokeSpy } = run([capabilityStep()], [
      { notes: [['run_capability', false]], throws: new Error('adapter error in step cap-1: identical tool failure cap') },
      { notes: [['web_search', true]], output: { posts: [{ url: 'u', text: 't' }] } },
    ]);
    const out = await result;
    expect(invokeSpy).toHaveBeenCalledTimes(2);
    expect(out.output).toEqual([{ url: 'u', text: 't' }]);
    const second = invokeSpy.mock.calls[1] as unknown as InvokeArgs;
    expect(second[1].description).toBe(buildCapabilityWebFallbackPrompt(NEED, { keyword: 'shopify', limit: 5 }, capabilityStep().description, undefined));
    const fallbackLog = loggerCalls.info.find((c) => ((c as unknown[])[0] as { event?: string })?.event === 'capability_step_web_fallback');
    expect((fallbackLog as unknown[])[0]).toMatchObject({ firstTurnFailed: 'adapter error in step cap-1: identical tool failure cap' });
  });

  it('propagates the failure when the turn had already got a useful result — no second turn', async () => {
    const { result, invokeSpy } = run([capabilityStep()], [
      { notes: [['run_capability', true]], throws: new Error('adapter error after the answer') },
    ]);
    const out = await result;
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(out.success && !out.escalated).toBe(false);
    expect(loggerCalls.info.some((c) => ((c as unknown[])[0] as { event?: string })?.event === 'capability_step_web_fallback')).toBe(false);
  });
});

describe('a capability step whose first turn was useful', () => {
  it('runs no second turn when run_capability answered', async () => {
    const { result, invokeSpy } = run([capabilityStep()], [
      { notes: [['run_capability', true]], output: { posts: [{ url: 'a', text: 'b' }] } },
    ]);
    const out = await result;
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(out.output).toEqual([{ url: 'a', text: 'b' }]);
  });

  it('runs no second turn when the model met the need with a web tool directly', async () => {
    const { result, invokeSpy } = run([capabilityStep()], [
      { notes: [['run_capability', false], ['web_search', true]], output: { posts: [{ url: 'a', text: 'b' }] } },
    ]);
    const out = await result;
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(out.output).toEqual([{ url: 'a', text: 'b' }]);
    expect(loggerCalls.info.some((c) => ((c as unknown[])[0] as { event?: string })?.event === 'capability_step_web_fallback')).toBe(false);
  });
});

describe('a run with no invocation id', () => {
  it('cannot be observed by the window and keeps its single turn', async () => {
    const service = new AgentExecutionService();
    (service as unknown as { verifyWorkflowStepsHash: jest.Mock }).verifyWorkflowStepsHash = jest.fn().mockReturnValue({ ok: true });
    (service as unknown as { buildToolsSchema: jest.Mock }).buildToolsSchema = jest.fn().mockResolvedValue([]);
    const invokeSpy = jest.spyOn(service as unknown as { invokeStepLLM: (..._a: InvokeArgs) => Promise<{ output: unknown }> }, 'invokeStepLLM')
      .mockResolvedValue({ output: { posts: [{ url: 'a', text: 'b' }] } });
    const state = makeState([capabilityStep()]);
    state.context.invocationId = undefined;
    const stubAdapter = { invoke: jest.fn(), pause: jest.fn(), resume: jest.fn(), registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(), registerAnomalyHandler: jest.fn() };
    const out = await (service as unknown as {
      runAgentHybridLoop: (_s: ExecutionState, _o: string, _d: unknown, _r: unknown, _a: unknown) => Promise<{ success: boolean; output?: unknown }>;
    }).runAgentHybridLoop(state, 'test', undefined, undefined, stubAdapter);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(out.output).toEqual([{ url: 'a', text: 'b' }]);
  });
});

describe('a pause inside the first turn', () => {
  it('propagates as a pause — the window is closed and no second turn starts', async () => {
    const { result, invokeSpy } = run([capabilityStep()], [
      { notes: [['run_capability', false]], throws: new AdapterPauseRequestedError('Human approval needed before this step can continue.', 'hitl_gate', { gateReason: 'communication_review', pendingToolCalls: [], matchedCategory: 'x' } as never, { adapterKind: 'anthropic', serialized: 'tok' } as never) },
    ]);
    const out = await result;
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(out.paused).toBe(true);
    // The window was closed in `finally`: a later note lands nowhere.
    noteToolOutcome('inv-cap', 'run_capability', true);
    const { closeCapabilityWindow } = jest.requireActual<typeof import('../../tool-gateway/capability-outcome-signal')>('../../tool-gateway/capability-outcome-signal');
    expect(closeCapabilityWindow('inv-cap', 'step:cap-1')).toMatchObject({ capabilityRuns: 0 });
  });
});
