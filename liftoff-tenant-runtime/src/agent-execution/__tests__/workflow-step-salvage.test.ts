// A read-only step interrupted after doing work finishes from what it has.
//
// The failure: a research step fetches thirty pages, a few guessed addresses
// do not exist, the identical-failure cap aborts the step, the retries start
// from nothing, and the later steps never run. Everything the step had
// gathered dies with the aborted engine call.
//
// The salvage is a step-level turn that produces the step's declared output
// from the material its tools already returned; the loop then advances
// through `onSuccess` and the team's own steps deliver where that team
// delivers. Read-only steps only, fail closed, once per step per run, and the
// shortfall travels as trusted metadata to the steps that read the output.
//
// Behavioural, through the loop (runAgentHybridLoop) with the real
// invokeStepLLM and a scripted engine: each case says what the step's turn
// did — which calls returned what, how the turn ended — and what the salvage
// turn records.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const createApprovalRequestMock = jest.fn().mockResolvedValue({ id: 'appr-1', expiresAt: new Date() });
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    createApprovalRequest: (...a: unknown[]) => createApprovalRequestMock(...a),
    getOversightSettings: jest.fn().mockResolvedValue({ communication: 'review', sensitiveWork: {} }),
    checkHitlGate: jest.fn().mockResolvedValue({ shouldGate: false }),
    approvalExistsForIdempotencyKey: jest.fn().mockResolvedValue(false),
    hashToolCalls: jest.fn().mockReturnValue('h'),
  },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));
const queryMock = jest.fn();
const poolMock = {
  query: (...a: unknown[]) => queryMock(...a),
  connect: jest.fn(async () => ({ query: (...a: unknown[]) => queryMock(...a), release: jest.fn() })),
};
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => poolMock), getPool: jest.fn(() => poolMock), pool: poolMock,
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: jest.fn().mockResolvedValue(undefined),
    getAgent: jest.fn().mockResolvedValue({ lifecycle: 'ACTIVE' }),
  })),
}));
jest.mock('../../infrastructure/cloud-tasks', () => ({ enqueueAgentExecution: jest.fn().mockResolvedValue({ taskName: 't' }) }));
const scheduledInsertMock = jest.fn().mockResolvedValue({ id: 'cont-1' });
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {
    updateCloudTaskName: jest.fn(),
    insert: (...a: unknown[]) => scheduledInsertMock(...a),
  },
}));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../streaming', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitHitlRejected: jest.fn(), emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
jest.mock('../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
jest.mock('../../agent-chat/agent-slack-client', () => ({
  postReviewDm: jest.fn(), listAgentAssignees: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../tool-gateway/agent-slack-tool-catalog', () => ({ SLACK_OUTBOUND_TOOL_NAMES: new Set() }));
const llmCompleteMock = jest.fn().mockRejectedValue(new Error('no advisor in this test'));
jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn(), complete: (...a: unknown[]) => llmCompleteMock(...a), modelSelectionFor: () => ({}) } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: jest.fn().mockReturnValue({ guardExternal: async () => null }),
}));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''),
  getTenantRuntimeUrl: jest.fn().mockReturnValue(''),
  tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
// Admits by default. The continuation gate asks admission now — a run
// continues while the workspace can pay for it — so a mock with no
// `checkAdmission` makes every parking test throw rather than park.
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getFeatureFlags: jest.fn().mockResolvedValue({}), getEntitlements: jest.fn().mockResolvedValue({}),
  }),
}));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: { getMessages: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]), getManifests: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../agent-lifecycle/types', () => ({ trustLevelFor: jest.fn().mockReturnValue('trusted') }));
jest.mock('../run-state/service', () => ({ agentRunStateService: { appendItem: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../untrusted-input', () => ({
  formatInputForPrompt: jest.fn(), formatUntrustedSystemPromptDirective: jest.fn().mockReturnValue(''),
}));
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: jest.fn().mockResolvedValue([]), buildSkillContextBlock: jest.fn().mockReturnValue(''),
}));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: {} }));
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn(),
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
jest.mock('../../tool-gateway/record-provenance', () => ({
  seedProvenanceFromEvent: jest.fn().mockResolvedValue(undefined),
  seedProvenanceFromContext: jest.fn().mockResolvedValue(undefined),
  seedProvenanceFromTrigger: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../byok/session', () => ({
  openByokSession: jest.fn().mockResolvedValue(null), closeByokSession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../adapter/funding', () => ({ adapterForFunding: (base: unknown) => base }));
jest.mock('../remember-external-tool-call', () => ({
  rememberExternalToolCall: jest.fn().mockResolvedValue(undefined), remembered: jest.fn(), derivedDeclarationFor: jest.fn(),
}));
const createEscalationMock = jest.fn().mockResolvedValue('esc-1');
jest.mock('../engine/escalation-helper', () => ({
  createEscalation: (...a: unknown[]) => createEscalationMock(...a),
  escalationKindById: jest.fn().mockResolvedValue(null),
  escalationThreadTitle: jest.fn(),
}));
jest.mock('../hitl-side-effects', () => ({ emitHitlApprovalSideEffects: jest.fn().mockResolvedValue(undefined) }));
const getRunMock = jest.fn();
jest.mock('../../trajectories/recorder', () => ({
  ...jest.requireActual('../../trajectories/recorder'),
  getRun: (...a: unknown[]) => getRunMock(...a),
}));

import type { AnomalyHandler, ToolBatchHandler, InvocationEvent, InvocationInput } from '../adapter/types';

// ── The scripted engine ────────────────────────────────────────────────────
//
// One script per turn, consumed in order. Each script gets the handlers the
// step registered and the turn's abort signal, and yields the engine's
// events; the batch boundary is what folds a strike, and the cap aborts the
// signal the way the real engines observe it.
type Observer = (o: { toolName: string; args: Record<string, unknown>; callId?: string; result: unknown; error?: string }) => Promise<boolean>;
type Handlers = { anomaly: AnomalyHandler; batch: ToolBatchHandler | null; observer: Observer | null };
type Script = (h: Handlers, signal: AbortSignal, input: InvocationInput) => AsyncGenerator<InvocationEvent>;
const turns: Script[] = [];
const prompts: string[] = [];
jest.mock('../adapter', () => ({
  createAdapter: jest.fn().mockImplementation(() => {
    let anomaly: AnomalyHandler | null = null;
    let batch: ToolBatchHandler | null = null;
    let observer: Observer | null = null;
    return {
      kind: 'stub',
      invoke: (input: InvocationInput, signal: AbortSignal) => {
        prompts.push(input.systemPrompt ?? '');
        const script = turns.shift();
        if (!script) throw new Error('unscripted turn');
        return script({ anomaly: anomaly!, batch, observer }, signal, input);
      },
      pause: jest.fn().mockResolvedValue({ adapterKind: 'stub', serialized: 'tok' }),
      resume: jest.fn(),
      registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(),
      registerAnomalyHandler: (h: AnomalyHandler) => { anomaly = h; },
      registerToolBatchHandler: (h: ToolBatchHandler) => { batch = h; },
      registerToolResultObserver: (o: Observer) => { observer = o; },
    };
  }),
}));

import { AgentExecutionService } from '../service';
import type { HybridResumeState } from '../service';
import { buildStepSalvageDigest, buildStepSalvagePrompt } from '../engine/step-salvage-prompt';
import type { ExecutionContext, ExecutionState, WorkflowStep, TaskExecutionResult } from '../types';

function makeState(steps: WorkflowStep[], over: Partial<ExecutionContext> = {}): ExecutionState {
  return {
    context: {
      tenantId: 't1', agentId: 'a1', workflowId: 'wf1', taskId: 'tk1', instructionVersion: 1,
      instruction: { systemPrompt: 's', allowedConnectors: [] } as ExecutionContext['instruction'],
      traceId: 'tr-1', agentType: 'workflow', hitlLevel: 0,
      modelConfig: { provider: 'anthropic' } as ExecutionContext['modelConfig'],
      execConfig: {} as ExecutionContext['execConfig'], memoryScope: {} as ExecutionContext['memoryScope'],
      threadId: 'thread-1', invocationId: 'inv-1', workflowSteps: steps, ...over,
    } as ExecutionContext,
    reasoningSteps: 0, toolCallsExecuted: 0, startTime: new Date(), steps: [], conversationHistory: [],
    pendingToolCalls: [], completedToolCalls: [], toolFailureCounts: new Map(), injectedSkillIds: [],
  } as ExecutionState;
}

/** The catalog every step registers: a stated read, a stated write, and the
 *  bookkeeping tool. `record_step_output` is registered only when the step
 *  declares an outputField, as the gateway does. */
const CATALOG_TOOLS = [
  { name: 'web_fetch_advanced', description: 'fetch', inputSchema: {}, effect: 'read' },
  { name: 'slack__send_message', description: 'send', inputSchema: {}, effect: 'write' },
  { name: 'record_step_output', description: 'record', inputSchema: {}, effect: 'read' },
];
const catalogCalls: Array<{
  stepOutputField?: string;
  toolAllowlist?: ReadonlySet<string>;
  /** The step's replay ledger, when the loop handed one down. Recorded because
   *  the wrapper that answers an already-completed call is installed at the
   *  gateway, so a ledger that never reaches this option reaches nothing — and
   *  the ANSWER is recorded too, not only the size: a ledger that arrived with
   *  keys that no longer match is present and never hits. */
  stepReplay?: { stepId: string; size: number; answersTheSend: unknown };
}> = [];
const metrics: Array<[string, Record<string, string>]> = [];

function service(): AgentExecutionService {
  const svc = new AgentExecutionService();
  (svc as unknown as { buildPlatformMcpCatalog: jest.Mock }).buildPlatformMcpCatalog = jest.fn(
    async (_s: unknown, opts?: {
      stepOutputField?: string;
      toolAllowlist?: ReadonlySet<string>;
      stepReplay?: import('../step-replay-ledger').StepReplayLedger;
    }) => {
      catalogCalls.push({
        stepOutputField: opts?.stepOutputField,
        toolAllowlist: opts?.toolAllowlist,
        ...(opts?.stepReplay ? { stepReplay: {
          stepId: opts.stepReplay.stepId,
          size: opts.stepReplay.size,
          answersTheSend: opts.stepReplay.lookupByToolName('slack__send_message', { channel: '#x', text: 'hi' })?.result,
        } } : {}),
      });
      const allowed = (n: string) => !opts?.toolAllowlist || opts.toolAllowlist.has(n);
      return {
        tools: CATALOG_TOOLS.filter((t) => (t.name !== 'record_step_output' || opts?.stepOutputField) && allowed(t.name)),
        servers: [],
      };
    },
  );
  (svc as unknown as { verifyWorkflowStepsHash: jest.Mock }).verifyWorkflowStepsHash = jest.fn().mockReturnValue({ ok: true });
  (svc as unknown as { buildToolsSchema: jest.Mock }).buildToolsSchema = jest.fn().mockResolvedValue([]);
  (svc as unknown as { emitHybridMetric: (name: string, _s: unknown, labels: Record<string, string>) => void }).emitHybridMetric =
    (name, _s, labels) => { metrics.push([name, labels]); };
  return svc;
}

type RunLoop = (state: ExecutionState, objective: string, inputData: unknown, resumeState: unknown, adapter: unknown) => Promise<TaskExecutionResult>;
const runLoop = (svc: AgentExecutionService, state: ExecutionState, resumeState?: HybridResumeState) =>
  (svc as unknown as { runAgentHybridLoop: RunLoop }).runAgentHybridLoop(state, 'audit the market', undefined, resumeState, {});

/** The payload a pause persisted, or null when nothing paused. */
function readPausePayloadOrNull(): HybridResumeState | null {
  const insert = queryMock.mock.calls.find((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_scheduled_invocations'));
  if (!insert) return null;
  return JSON.parse((insert[1] as unknown[])[8] as string) as HybridResumeState;
}

/** The payload a pause persisted, as the resume is rebuilt from it. Read off the
 *  scheduled-invocation INSERT because that is where it actually goes: asserting
 *  on an in-memory object would not show that it survives being stored. */
function readPausePayload(): HybridResumeState {
  const insert = queryMock.mock.calls.find((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_scheduled_invocations'));
  expect(insert).toBeDefined();
  return JSON.parse((insert![1] as unknown[])[8] as string) as HybridResumeState;
}

// ── Script pieces ──────────────────────────────────────────────────────────

const fetched = (id: string, url: string, content: string): InvocationEvent[] => [
  { type: 'tool_call_started', toolName: 'web_fetch_advanced', args: { url }, callId: id },
  { type: 'tool_call_finished', callId: id, result: { url, content } },
];
const failedFetch = (id: string, url: string): InvocationEvent[] => [
  { type: 'tool_call_started', toolName: 'web_fetch_advanced', args: { url }, callId: id },
  { type: 'tool_call_finished', callId: id, error: 'TOOL_ERROR {"error":"No content could be retrieved","code":"not_found","retryable":false}' },
];
const sent = (id: string, ok: boolean): InvocationEvent[] => [
  { type: 'tool_call_started', toolName: 'slack__send_message', args: { channel: '#x', text: 'hi' }, callId: id },
  ok
    ? { type: 'tool_call_finished', callId: id, result: { ok: true } }
    : { type: 'tool_call_finished', callId: id, error: 'TOOL_ERROR {"error":"channel_not_found","code":"not_found","retryable":false}' },
];

/** The step's turn: some calls, then the identical-failure cap aborts it. */
function interruptedTurn(events: InvocationEvent[]): Script {
  return async function* ({ anomaly, batch }, signal) {
    for (const e of events) yield e;
    for (const i of [0, 1, 2]) {
      await anomaly({ kind: 'tool_call_error', context: { toolName: 'web_fetch_advanced', callId: `bad-${i}`, args: { url: 'https://acme.example/pricing' }, error: 'Failed to fetch URL.' }, invocationId: 'inv-1' });
      await batch!([`bad-${i}`]);
      if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'The operation was aborted' }; return; }
    }
    throw new Error('the cap should have aborted the turn');
  };
}

/** The salvage turn: records the declared output from the material. */
function recordingTurn(field: string, value: unknown): Script {
  return async function* () {
    yield { type: 'tool_call_started', toolName: 'record_step_output', args: { [field]: value }, callId: 'rec-1' };
    yield { type: 'tool_call_finished', callId: 'rec-1', result: { recorded: true } };
    yield { type: 'completion', outcome: 'success' };
  };
}

const proseTurn = (text: string): Script => async function* () {
  yield { type: 'assistant_message', content: [{ type: 'text', text }] };
  yield { type: 'completion', outcome: 'success' };
};

const RESEARCH: WorkflowStep = { stepId: 's2', type: 'llm_reason', description: 'Research the competitor set and record findings.', outputField: 'findings', onSuccess: 's3' } as WorkflowStep;
const DIGEST: WorkflowStep = { stepId: 's3', type: 'llm_reason', description: 'Write the digest from the findings in s2.', onSuccess: '' } as WorkflowStep;

beforeEach(() => {
  jest.clearAllMocks();
  turns.length = 0;
  prompts.length = 0;
  catalogCalls.length = 0;
  metrics.length = 0;
  llmCompleteMock.mockRejectedValue(new Error('no advisor in this test'));
  queryMock.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('INSERT INTO agent_scheduled_invocations')) return { rows: [{ id: 'sched-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

describe('a read-only step interrupted after doing work is salvaged', () => {
  it('runs one salvage turn on record_step_output alone, carrying both results, and the graph goes on', async () => {
    turns.push(
      interruptedTurn([...fetched('c1', 'https://acme.example/', 'ACME HOME PAGE'), ...fetched('c2', 'https://acme.example/about', 'ACME ABOUT PAGE')]),
      recordingTurn('findings', { competitors: ['ACME'] }),
      proseTurn('Digest written.'),
    );
    const svc = service();
    const state = makeState([RESEARCH, DIGEST]);
    const out = await runLoop(svc, state);

    expect(out.success).toBe(true);
    expect(out.output).toBe('Digest written.');
    // Three turns: the step, its salvage, the next step. No recovery cycle.
    expect(prompts).toHaveLength(3);
    expect(createEscalationMock).not.toHaveBeenCalled();
    expect(llmCompleteMock).not.toHaveBeenCalled();

    // The salvage turn's catalog: record_step_output and nothing else.
    const salvageCatalog = catalogCalls[1];
    expect(salvageCatalog.stepOutputField).toBe('findings');
    expect([...salvageCatalog.toolAllowlist!]).toEqual(['record_step_output']);

    // Its prompt: the step's goal, the interruption, both results, no calls.
    const salvagePrompt = prompts[1];
    expect(salvagePrompt).toContain(RESEARCH.description);
    expect(salvagePrompt).toContain('This step was interrupted before it finished.');
    expect(salvagePrompt).toContain('ACME HOME PAGE');
    expect(salvagePrompt).toContain('ACME ABOUT PAGE');
    expect(salvagePrompt).toContain('call nothing and');
    // Byte-stable: the prompt is exactly what the builder produces for these calls.
    const digest = buildStepSalvageDigest(state.completedToolCalls.slice(0, 2));
    expect(salvagePrompt).toContain(buildStepSalvagePrompt(RESEARCH, digest));

    // The recorded value became the step's output, extracted by outputField.
    expect(state.salvagedSteps).toEqual(new Set(['s2']));
    expect(metrics).toContainEqual(['hybrid_loop.step_salvaged', { step_id: 's2', cause: 'anomaly_escalated' }]);
    // The next step's prompt carries the value AND the partial-material line.
    expect(prompts[2]).toContain('"competitors":["ACME"]');
    expect(prompts[2]).toContain('[s2: produced from partial material — these calls did not return: none recorded; treat anything that depended on them as unknown, not empty]');
    // And says so, for a live run to be checked without reading the prompt.
    const { logger } = jest.requireMock('../../infrastructure/logging') as { logger: { info: jest.Mock } };
    const partial = logger.info.mock.calls.find((c: unknown[]) => (c[0] as { event?: string })?.event === 'step_prompt_partial_material');
    expect(partial?.[0]).toMatchObject({ stepId: 's3', salvagedFrom: ['s2'], unavailable: [[]] });
  });

  it('names the calls that did not return, in the digest and in the next step\'s line', async () => {
    turns.push(
      interruptedTurn([...fetched('c1', 'https://acme.example/', 'HOME'), ...failedFetch('c2', 'https://acme.example/blog?token=abc')]),
      recordingTurn('findings', { competitors: ['ACME'] }),
      proseTurn('Done.'),
    );
    await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(prompts[1]).toContain('Calls that did not return:');
    expect(prompts[1]).toContain('web_fetch_advanced({"url":"https://acme.example/blog?token=%5BREDACTED%5D"}): failed');
    expect(prompts[2]).toContain('these calls did not return: web_fetch_advanced({"url":"https://acme.example/blog?token=%5BREDACTED%5D"})');
  });

  it('salvages an OutputShapeMismatchError too: the turn ended without recording', async () => {
    turns.push(
      async function* () {
        for (const e of fetched('c1', 'https://acme.example/', 'HOME')) yield e;
        yield { type: 'assistant_message', content: [{ type: 'text', text: 'I read the page.' }] };
        yield { type: 'completion', outcome: 'success' };
      },
      recordingTurn('findings', { competitors: [] }),
      proseTurn('Done.'),
    );
    const state = makeState([RESEARCH, DIGEST]);
    const out = await runLoop(service(), state);
    expect(out.success).toBe(true);
    expect(state.salvagedSteps).toEqual(new Set(['s2']));
    expect(metrics).toContainEqual(['hybrid_loop.step_salvaged', { step_id: 's2', cause: 'output_shape_mismatch' }]);
  });

  it('salvages an engine error the same way', async () => {
    turns.push(
      async function* () {
        for (const e of fetched('c1', 'https://acme.example/', 'HOME')) yield e;
        yield { type: 'completion', outcome: 'error', reason: 'provider 500' };
      },
      recordingTurn('findings', { competitors: [] }),
      proseTurn('Done.'),
    );
    const state = makeState([RESEARCH, DIGEST]);
    await runLoop(service(), state);
    expect(metrics).toContainEqual(['hybrid_loop.step_salvaged', { step_id: 's2', cause: 'engine_error' }]);
  });

  it('a step with no outputField salvages on prose, with no tools at all', async () => {
    const PROSE_STEP: WorkflowStep = { ...RESEARCH, outputField: undefined } as WorkflowStep;
    turns.push(
      interruptedTurn(fetched('c1', 'https://acme.example/', 'HOME')),
      proseTurn('From what I read: ACME sells widgets.'),
      proseTurn('Done.'),
    );
    const state = makeState([PROSE_STEP, DIGEST]);
    const out = await runLoop(service(), state);
    expect(out.success).toBe(true);
    expect([...catalogCalls[1].toolAllowlist!]).toEqual([]);
    expect(prompts[2]).toContain('From what I read: ACME sells widgets.');
  });
});

// The stream is not the only witness to a call. On the opencode engine a
// bridge abort strands the model's tool parts `running`, so no
// tool_call_finished ever arrives — not even for calls whose results the
// bridge had already returned, so a step whose fetches partly succeeded can
// end with a record holding nothing. The bridge's
// observer sees every result at dispatch; a call it answered that the stream
// never finished is recorded from there, before the loop decides anything.
describe('calls the bridge answered but the stream never finished', () => {
  it('are recorded from the dispatch, feed the salvage, and reach the persisted trail', async () => {
    turns.push(
      async function* ({ anomaly, batch, observer }, signal) {
        // Two results the bridge returned — the stream reports neither.
        await observer!({ toolName: 'web_fetch_advanced', args: { url: 'https://acme.example/' }, callId: 'd-1', result: { content: 'ACME HOME' } });
        await observer!({ toolName: 'web_fetch_advanced', args: { url: 'https://acme.example/about' }, callId: 'd-2', result: { content: 'ACME ABOUT' } });
        // One the stream did finish, with the bridge's id on the event.
        await observer!({ toolName: 'web_fetch_advanced', args: { url: 'https://acme.example/team' }, callId: 'd-3', result: { content: 'ACME TEAM' } });
        yield { type: 'tool_call_started', toolName: 'web_fetch_advanced', args: { url: 'https://acme.example/team' }, callId: 'part-3' };
        yield { type: 'tool_call_finished', callId: 'part-3', dispatchCallId: 'd-3', result: { content: 'ACME TEAM' }, recordedAtDispatch: true };
        for (const i of [0, 1, 2]) {
          await anomaly({ kind: 'tool_call_error', context: { toolName: 'web_fetch_advanced', callId: `bad-${i}`, args: { url: 'https://acme.example/pricing' }, error: 'Failed to fetch URL.' }, invocationId: 'inv-1' });
          await batch!([`bad-${i}`]);
          if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'run stopped after "web_fetch_advanced" failed and recovery declined another attempt' }; return; }
        }
      },
      recordingTurn('findings', { competitors: ['ACME'] }),
      proseTurn('Done.'),
    );
    const state = makeState([RESEARCH, DIGEST]);
    const out = await runLoop(service(), state);
    expect(out.success).toBe(true);
    expect(metrics).toContainEqual(['hybrid_loop.step_salvaged', { step_id: 's2', cause: 'anomaly_escalated' }]);
    // All three results reached the salvage prompt.
    expect(prompts[1]).toContain('ACME HOME');
    expect(prompts[1]).toContain('ACME ABOUT');
    expect(prompts[1]).toContain('ACME TEAM');
    expect(prompts[1]).toContain('Tool calls this step made: 3 (3 succeeded, 0 failed).');
    // The run's record — what the invocation row persists — holds each once.
    const fetches = state.completedToolCalls.filter((c) => c.name === 'web_fetch_advanced');
    expect(fetches.map((c) => c.id).sort()).toEqual(['d-1', 'd-2', 'part-3']);
  });
});

// The SAME upstream condition, on the step's declared output rather than on its
// material — and this one needs no salvage at all, because the runtime is
// already holding the answer.
//
// `record_step_output` is how a step declaring an outputField hands in its
// result. If the runtime reads that call from `tool_call_started` and nowhere
// else, then when opencode's stream goes quiet no such event arrives for it
// either: the bridge answers `record_step_output:ok`, the stream reports
// neither its start nor its finish, and the step dies on `outputField
// "reading" did not resolve in tool result` with the value sitting in
// arguments the observer had been handed — then failed recoveries and an
// escalation follow.
describe("a step's declared output when the stream never reported the call", () => {
  it('resolves from the dispatch, so the step returns it instead of failing its shape', async () => {
    turns.push(
      async function* ({ observer }) {
        // The bridge answered both. The stream reports neither.
        await observer!({ toolName: 'web_fetch_advanced', args: { url: 'https://acme.example/' }, callId: 'd-1', result: { content: 'ACME HOME' } });
        await observer!({ toolName: 'record_step_output', args: { findings: { competitors: ['ACME'] } }, callId: 'd-2', result: { recorded: true } });
        yield { type: 'completion', outcome: 'success' };
      },
      proseTurn('Digest written.'),
    );
    const state = makeState([RESEARCH, DIGEST]);
    const out = await runLoop(service(), state);

    expect(out.success).toBe(true);
    // Two turns, not four: no OutputShapeMismatchError, so no salvage and no
    // recovery. On main this step threw, salvaged, and escalated.
    expect(prompts).toHaveLength(2);
    expect(state.salvagedSteps ?? new Set()).toEqual(new Set());
    expect(metrics.map(([m]) => m)).not.toContain('hybrid_loop.anomaly_triggered');
    expect(createEscalationMock).not.toHaveBeenCalled();
    // And the value the step recorded is what the next step reads.
    expect(prompts[1]).toContain('"competitors":["ACME"]');
  });

  it('keeps last-wins: two reports through the observer, the SECOND is the output', async () => {
    // The existing contract. The stream handler assigns unconditionally on
    // every matching call, and the observer fires at dispatch in call order, so
    // taking the first match anywhere would invert it.
    turns.push(
      async function* ({ observer }) {
        await observer!({ toolName: 'record_step_output', args: { findings: { competitors: ['FIRST'] } }, callId: 'd-1', result: { recorded: true } });
        await observer!({ toolName: 'record_step_output', args: { findings: { competitors: ['SECOND'] } }, callId: 'd-2', result: { recorded: true } });
        yield { type: 'completion', outcome: 'success' };
      },
      proseTurn('Done.'),
    );
    await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"competitors":["SECOND"]');
    expect(prompts[1]).not.toContain('FIRST');
  });

  it('accepts the SDK-namespaced spelling of the tool, as the stream reader does', async () => {
    // Anthropic prefixes MCP tools; the bridge engines dispatch on the bare
    // name. One reader, both shapes, or the fix covers one engine.
    turns.push(
      async function* ({ observer }) {
        await observer!({
          toolName: 'mcp__liftoff-tool-gateway__record_step_output',
          args: { findings: { competitors: ['NAMESPACED'] } }, callId: 'd-1', result: { recorded: true },
        });
        yield { type: 'completion', outcome: 'success' };
      },
      proseTurn('Done.'),
    );
    const out = await runLoop(service(), makeState([RESEARCH, DIGEST]));
    // The step SUCCEEDED, which is the test. Asserting only on the value would
    // pass while the step still failed: the salvage digest that follows an
    // unresolved output quotes the call's own arguments back into its prompt,
    // and the turn count is the same either way because the salvage then
    // produces nothing extractable and the run escalates.
    expect(out.success).toBe(true);
    expect(metrics.map(([m]) => m)).not.toContain('hybrid_loop.anomaly_triggered');
    expect(createEscalationMock).not.toHaveBeenCalled();
    expect(prompts[1]).toContain('"competitors":["NAMESPACED"]');
  });

  it('leaves a step with no outputField exactly as it was', async () => {
    // Nothing is read off the observer for a step with no output contract, and
    // its prose is still its output.
    const PROSE_STEP: WorkflowStep = { ...RESEARCH, outputField: undefined } as WorkflowStep;
    turns.push(
      async function* ({ observer }) {
        await observer!({ toolName: 'web_fetch_advanced', args: { url: 'https://acme.example/' }, callId: 'd-1', result: { content: 'HOME' } });
        yield { type: 'assistant_message', content: [{ type: 'text', text: 'ACME sells widgets.' }] };
        yield { type: 'completion', outcome: 'success' };
      },
      proseTurn('Done.'),
    );
    await runLoop(service(), makeState([PROSE_STEP, DIGEST]));
    expect(prompts[1]).toContain('ACME sells widgets.');
  });

  it('the STREAM\'s order decides between two reports, whatever order the bridge finished them in', async () => {
    // Last-wins is an ordering rule and the two witnesses can order the same two
    // reports differently: the stream sees them as the MODEL emitted them, the
    // observer as the bridge FINISHED them, and a parallel batch can invert the
    // second. Two unconditional writers would leave the answer depending on which
    // result came back first.
    turns.push(
      async function* ({ observer }) {
        // The model emitted FIRST then SECOND: that is the stream's order.
        yield { type: 'tool_call_started', toolName: 'record_step_output', args: { findings: { competitors: ['FIRST'] } }, callId: 'c-1' };
        yield { type: 'tool_call_started', toolName: 'record_step_output', args: { findings: { competitors: ['SECOND'] } }, callId: 'c-2' };
        // The bridge finished them the other way round.
        await observer!({ toolName: 'record_step_output', args: { findings: { competitors: ['SECOND'] } }, callId: 'd-2', result: { recorded: true } });
        await observer!({ toolName: 'record_step_output', args: { findings: { competitors: ['FIRST'] } }, callId: 'd-1', result: { recorded: true } });
        yield { type: 'completion', outcome: 'success' };
      },
      proseTurn('Done.'),
    );
    await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"competitors":["SECOND"]');
    expect(prompts[1]).not.toContain('FIRST');
  });

  it('still supplies a report the stream never carried, beside one it did', async () => {
    // The compensation has to survive the rule above: a call the stream lost is
    // exactly what the observer is for, and only a report the stream ALREADY
    // carried is left alone.
    turns.push(
      async function* ({ observer }) {
        yield { type: 'tool_call_started', toolName: 'record_step_output', args: { findings: { competitors: ['FROM_STREAM'] } }, callId: 'c-1' };
        await observer!({ toolName: 'record_step_output', args: { findings: { competitors: ['FROM_STREAM'] } }, callId: 'd-1', result: { recorded: true } });
        // This one the stream never announced.
        await observer!({ toolName: 'record_step_output', args: { findings: { competitors: ['ONLY_DISPATCHED'] } }, callId: 'd-2', result: { recorded: true } });
        yield { type: 'completion', outcome: 'success' };
      },
      proseTurn('Done.'),
    );
    await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"competitors":["ONLY_DISPATCHED"]');
  });

  it('a report the stream DID carry still wins when it is the later one', async () => {
    // Both witnesses write the same binding, so the order the step saw the
    // calls in is the order that decides. The observer fires at dispatch, which
    // is after the stream's `tool_call_started` for the same call.
    turns.push(
      async function* ({ observer }) {
        await observer!({ toolName: 'record_step_output', args: { findings: { competitors: ['FROM_DISPATCH'] } }, callId: 'd-1', result: { recorded: true } });
        yield { type: 'tool_call_started', toolName: 'record_step_output', args: { findings: { competitors: ['FROM_STREAM'] } }, callId: 'c-2' };
        yield { type: 'tool_call_finished', callId: 'c-2', result: { recorded: true } };
        yield { type: 'completion', outcome: 'success' };
      },
      proseTurn('Done.'),
    );
    await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(prompts[1]).toContain('"competitors":["FROM_STREAM"]');
  });
});

describe('the salvage prompt is resolved once and never templated again', () => {
  it("resolves the step's own references, and leaves a placeholder inside fetched material alone", async () => {
    const TEMPLATED: WorkflowStep = { ...RESEARCH, description: 'Research {{input.topic}} and record findings.' } as WorkflowStep;
    turns.push(
      interruptedTurn(fetched('c1', 'https://acme.example/', 'PAGE SAYS {{input.topic}} AND {{input.secret}}')),
      recordingTurn('findings', { competitors: [] }),
      proseTurn('Done.'),
    );
    const svc = service();
    const state = makeState([TEMPLATED, DIGEST]);
    const out = await (svc as unknown as { runAgentHybridLoop: RunLoop })
      .runAgentHybridLoop(state, 'audit', { topic: 'ACME', secret: 'hunter2' }, undefined, {});
    expect(out.success).toBe(true);
    const salvagePrompt = prompts[1];
    // The step's goal, resolved as the first turn saw it.
    expect(salvagePrompt).toContain('Research ACME and record findings.');
    // The material, exactly as the tool returned it: no run data read into it.
    // (The prompt's own "Workflow input" line carries the input as it always
    // has; the material line is what must not have been substituted.)
    expect(salvagePrompt).toContain('PAGE SAYS {{input.topic}} AND {{input.secret}}');
    expect(salvagePrompt).not.toContain('PAGE SAYS ACME');
    expect(salvagePrompt).not.toContain('AND hunter2');
  });
});

describe('the boundary fails closed', () => {
  it('a read then a FAILED send is not salvaged: today\'s routing, onSuccess NOT taken', async () => {
    turns.push(interruptedTurn([...fetched('c1', 'https://acme.example/', 'HOME'), ...sent('c2', false)]));
    const out = await runLoop(service(), makeState([RESEARCH, DIGEST]));
    // The advisor is unreachable in this test, so recovery synthesizes an
    // escalate: that is today's routing, and it is what the salvage must
    // fall through to.
    expect(out.escalated).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(metrics.find(([n]) => n === 'hybrid_loop.step_salvaged')).toBeUndefined();
    // The operator record states the facts first, as they stood before this
    // cycle: the loop charged the cycle to the counters before it asked, and
    // the record takes it back off — a first recovery has zero earlier ones.
    expect(createEscalationMock).toHaveBeenCalledTimes(1);
    const [, reason, opts] = createEscalationMock.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(reason).toMatch(/^codex invoke failed|^The operation was aborted|^adapter error|^step s2/);
    expect(reason).toContain('(step s2; 0 earlier recoveries on this step, 0 in the run)\n\nAdvisor: recovery_llm_unavailable');
    expect(opts).toMatchObject({ kind: 'system_internal', fingerprint: 'recovery_decision:s2:tool_error', instructionVersion: 1 });
    expect(out.error).toBe(reason);
  });

  it('a read then a SUCCESSFUL send is not salvaged either: a write happened', async () => {
    turns.push(interruptedTurn([...fetched('c1', 'https://acme.example/', 'HOME'), ...sent('c2', true)]));
    const out = await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(out.escalated).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it('a call that does not resolve in the step catalog refuses the salvage', async () => {
    turns.push(interruptedTurn([
      ...fetched('c1', 'https://acme.example/', 'HOME'),
      { type: 'tool_call_started', toolName: 'mystery__lookup', args: {}, callId: 'c2' },
      { type: 'tool_call_finished', callId: 'c2', result: { found: true } },
    ]));
    const out = await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(out.escalated).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it("a run_capability call refuses the salvage: its stated read is not a statement about the call", async () => {
    // 'read' in the static effect map only because the true class is knowable
    // from the handle; a write capability runs through it after approval.
    CATALOG_TOOLS.push({ name: 'run_capability', description: 'run', inputSchema: {}, effect: 'read' });
    try {
      turns.push(interruptedTurn([
        ...fetched('c1', 'https://acme.example/', 'HOME'),
        { type: 'tool_call_started', toolName: 'run_capability', args: { handle: 'cap_1' }, callId: 'c2' },
        { type: 'tool_call_finished', callId: 'c2', result: { ok: true } },
      ]));
      const out = await runLoop(service(), makeState([RESEARCH, DIGEST]));
      expect(out.escalated).toBe(true);
      expect(prompts).toHaveLength(1);
    } finally {
      CATALOG_TOOLS.pop();
    }
  });

  it('zero successful results: nothing to salvage from', async () => {
    turns.push(interruptedTurn([...failedFetch('c1', 'https://acme.example/'), ...failedFetch('c2', 'https://acme.example/about')]));
    const out = await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(out.escalated).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it('a result of false or 0 IS a result; an empty string, null or undefined is not', async () => {
    const r = (id: string, result: unknown): InvocationEvent[] => [
      { type: 'tool_call_started', toolName: 'web_fetch_advanced', args: { url: `https://x/${id}` }, callId: id },
      { type: 'tool_call_finished', callId: id, result },
    ];
    turns.push(interruptedTurn([...r('c1', false), ...r('c2', 0)]), recordingTurn('findings', {}), proseTurn('Done.'));
    await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(metrics.find(([n]) => n === 'hybrid_loop.step_salvaged')).toBeDefined();

    metrics.length = 0; prompts.length = 0; turns.length = 0;
    turns.push(interruptedTurn([...r('c1', ''), ...r('c2', null), ...r('c3', undefined)]));
    const out = await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(out.escalated).toBe(true);
    expect(metrics.find(([n]) => n === 'hybrid_loop.step_salvaged')).toBeUndefined();
  });

  it('a limit stop is never salvaged', async () => {
    turns.push(async function* () {
      for (const e of fetched('c1', 'https://acme.example/', 'HOME')) yield e;
      yield { type: 'completion', outcome: 'limit_reached', reason: 'max turns' };
    });
    const out = await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(out.escalated).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it("a person's stop is never salvaged", async () => {
    const abort = new AbortController();
    turns.push(async function* () {
      for (const e of fetched('c1', 'https://acme.example/', 'HOME')) yield e;
      abort.abort();
      yield { type: 'completion', outcome: 'error', reason: 'aborted' };
    });
    const out = await runLoop(service(), makeState([RESEARCH, DIGEST], { abortSignal: abort.signal } as Partial<ExecutionContext>));
    expect(out.escalated).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it('a pause is never salvaged: it propagates as it always did', async () => {
    turns.push(async function* () {
      for (const e of fetched('c1', 'https://acme.example/', 'HOME')) yield e;
      yield { type: 'pause_requested', reason: 'ask_user', token: { adapterKind: 'stub', serialized: 'tok' } };
    });
    const out = await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(out.paused).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it('a LOOP step is never salvaged: the salvage has no item to be about', async () => {
    // A salvage resolves the step's prose with { input, output, steps } and no
    // `item`, then marks the result __proseResolved so nothing downstream can
    // fill it. "Write the battle card for {{item.name}}" salvages with an empty
    // competitor, over a digest of every iteration's calls mixed together: an
    // answer about nothing, marked as this item's output. Fail closed instead,
    // and let the step take today's routing.
    const PER_ITEM: WorkflowStep = {
      stepId: 's2', type: 'llm_reason', outputField: 'card', onSuccess: 's3',
      description: 'Write the battle card for {{item.name}}.',
      loop: { over: '{{input.competitors}}' },
    } as WorkflowStep;
    turns.push(
      // The iteration reads a page and answers in prose, so its declared output
      // does not resolve: OutputShapeMismatchError, which IS a salvage cause.
      async function* () {
        for (const e of fetched('c1', 'https://acme.example/', 'ACME HOME')) yield e;
        yield { type: 'assistant_message', content: [{ type: 'text', text: 'ACME positions on price.' }] };
        yield { type: 'completion', outcome: 'success' };
      },
      // Consumed only if the salvage runs, which it must not.
      recordingTurn('card', { competitor: '' }),
      proseTurn('Done.'),
    );
    const svc = service();
    const state = makeState([PER_ITEM, DIGEST]);
    const out = await (svc as unknown as { runAgentHybridLoop: RunLoop })
      .runAgentHybridLoop(state, 'audit', { competitors: [{ name: 'ACME' }] }, undefined, {});
    // One turn: the iteration. No salvage turn, no next step.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Write the battle card for ACME.');
    expect(metrics.find(([n]) => n === 'hybrid_loop.step_salvaged')).toBeUndefined();
    expect(state.salvagedSteps ?? new Set()).toEqual(new Set());
    // Today's routing: the advisor is unreachable here, so recovery synthesizes
    // an escalate, exactly as it does for every other refused salvage above.
    expect(out.escalated).toBe(true);
  });

  it('once per step per run: a salvaged step interrupted again is not salvaged again', async () => {
    // s2 salvaged; s3 reads it, is interrupted and salvaged; a second
    // interruption of s3 (via a recovery `continue` back to it) must not
    // salvage twice. Modelled directly: a step already in salvagedSteps is
    // routed as today.
    const state = makeState([RESEARCH, DIGEST]);
    turns.push(interruptedTurn(fetched('c1', 'https://acme.example/', 'HOME')));
    const resume: HybridResumeState = {
      kind: 'hybrid-pause', pauseReason: 'delay', currentStepId: 's2', resumeAfterStepId: 's2', stepOutput: undefined, inputData: undefined,
      perStepRecoveries: {}, totalRecoveries: 0, recoveryHistory: [], stepOutputs: {}, enteredSteps: [], unsatisfiedSteps: [],
      salvagedSteps: ['s2'], salvageNotes: { s2: { unavailable: [], interruptedBy: 'anomaly_escalated' } },
    };
    const out = await runLoop(service(), state, resume);
    expect(out.escalated).toBe(true);
    expect(prompts).toHaveLength(1);
  });
});

// The other half of the same catch: what the failed attempt already DID.
//
// Recovery's `continue` proposal is dispatched, and the advisor routinely
// proposes the call the step has just made: a step that creates a document and
// fails its declared output can see two more identical creates follow from the
// advisor's proposals. The loop's catch records the
// attempt's writes so `executeRecoveryCalls` can answer a repeat with the
// document that already exists (step-replay-ledger.ts).
//
// Asserted HERE because the catch is the one place that sees the attempt's own
// calls, and a record written on only some of its exits is a replay that holds
// sometimes.
describe('what a failed step attempt already wrote is recorded before recovery', () => {
  it('records the step\'s successful WRITE, keyed so a repeat of it is found', async () => {
    turns.push(interruptedTurn([...fetched('c1', 'https://acme.example/', 'HOME'), ...sent('c2', true)]));
    const state = makeState([RESEARCH, DIGEST]);
    await runLoop(service(), state);

    const ledger = state.stepReplay?.get('s2');
    expect(ledger).toBeDefined();
    // The send, and not the fetch beside it.
    expect(ledger!.size).toBe(1);
    expect(ledger!.lookup({ connector: 'slack', actionType: 'send_message', payload: { channel: '#x', text: 'hi' } }))
      .toEqual({ name: 'slack__send_message', result: { ok: true } });
  });

  it('records nothing for an attempt whose only calls were READS', async () => {
    // A read is dispatched again on purpose: fresh data is the most likely thing
    // to make the retry work.
    turns.push(
      interruptedTurn(fetched('c1', 'https://acme.example/', 'HOME')),
      recordingTurn('findings', { competitors: [] }),
      proseTurn('Done.'),
    );
    const state = makeState([RESEARCH, DIGEST]);
    await runLoop(service(), state);
    expect(state.stepReplay?.get('s2')?.size ?? 0).toBe(0);
  });

  it('records nothing for a FAILED write: it performed nothing', async () => {
    turns.push(interruptedTurn([...fetched('c1', 'https://acme.example/', 'HOME'), ...sent('c2', false)]));
    const state = makeState([RESEARCH, DIGEST]);
    await runLoop(service(), state);
    expect(state.stepReplay?.get('s2')?.size ?? 0).toBe(0);
  });

  it('records nothing at all for a step that never failed', async () => {
    // An entry exists only for a step that has already run, which is what makes
    // "an attempt that already happened" a fact about the data rather than a flag
    // a caller has to remember. The map itself is always present — the loop owns
    // it and hands it to the pause — so the property is that it is EMPTY.
    turns.push(recordingTurn('findings', { competitors: ['ACME'] }), proseTurn('Done.'));
    const state = makeState([RESEARCH, DIGEST]);
    const out = await runLoop(service(), state);
    expect(out.success).toBe(true);
    expect(state.stepReplay?.size ?? 0).toBe(0);
    // And a pause would carry nothing, rather than an empty shell.
    expect(readPausePayloadOrNull()?.stepReplay).toBeUndefined();
  });

  it('records the write from a call the bridge answered that the stream never finished', async () => {
    // The two witnesses again: on opencode the record's only source is the
    // dispatch observer, and a replay blind to it would be a replay that holds
    // on every engine but opencode.
    turns.push(async function* ({ anomaly, batch, observer }, signal) {
      await observer!({ toolName: 'slack__send_message', args: { channel: '#x', text: 'hi' }, callId: 'd-1', result: { ok: true } });
      for (const i of [0, 1, 2]) {
        await anomaly({ kind: 'tool_call_error', context: { toolName: 'web_fetch_advanced', callId: `bad-${i}`, args: { url: 'https://acme.example/pricing' }, error: 'Failed to fetch URL.' }, invocationId: 'inv-1' });
        await batch!([`bad-${i}`]);
        if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
      }
    });
    const state = makeState([RESEARCH, DIGEST]);
    await runLoop(service(), state);
    expect(state.stepReplay?.get('s2')?.size).toBe(1);
  });
});

// A PAUSE RE-DISPATCHES THE STEP IT PAUSED ON, so what that step already did has
// to reach the other side of the pause.
//
// Every HITL pause site in this loop writes `resumeAfterStepId: currentStepId`
// ("re-dispatch the gated step on approve") and the resumed loop enters from it.
// A step whose write landed and whose later call gated therefore runs again,
// whole, in another process — and an in-memory ledger is empty exactly there, on
// the long interrupted runs most likely to repeat themselves. Same reasoning
// `duplicate-outward-action.ts` records for reading a ledger rather than keeping
// an in-process map.
describe('what a step already did rides the pause, and reaches the resumed turn', () => {
  it('a pause payload carries the writes the paused step had completed', async () => {
    turns.push(async function* () {
      for (const e of fetched('c1', 'https://acme.example/', 'HOME')) yield e;
      for (const e of sent('c2', true)) yield e;
      yield { type: 'pause_requested', reason: 'ask_user', token: { adapterKind: 'stub', serialized: 'tok' } };
    });
    const state = makeState([RESEARCH, DIGEST]);
    const out = await runLoop(service(), state);
    expect(out.paused).toBe(true);

    // Read off the persisted payload, and it re-dispatches THIS step on resume.
    const payload = readPausePayload();
    expect(payload.resumeAfterStepId).toBe('s2');
    expect(payload.stepReplay?.s2).toHaveLength(1);
    expect(payload.stepReplay!.s2![0]!.name).toBe('slack__send_message');
    // The fetch beside it is a read and is not carried.
    expect(payload.stepReplay!.s2!.map((e) => e.name)).toEqual(['slack__send_message']);
  });

  it('a resumed run hands the re-dispatched step its own ledger', async () => {
    // The wiring joint: the wrapper that answers an already-completed call is
    // installed when the gateway builds the step's tool list, so a ledger that
    // does not reach `buildPlatformMcpCatalog` reaches nothing.
    const resume: HybridResumeState = {
      kind: 'hybrid-pause',
      // `delay` re-enters the step directly. An `ask_user` resume reaches the
      // same step through a recovery prologue, and the prologue is not what this
      // is about; that the PAUSE carries the ledger is asserted above.
      pauseReason: 'delay',
      currentStepId: 's2',
      resumeAfterStepId: 's2',
      stepOutput: undefined,
      inputData: undefined,
      stepReplay: {
        s2: [{ key: 'slack|send_message|{"channel":"#x","text":"hi"}', name: 'slack__send_message', result: { ok: true } }],
      },
    } as HybridResumeState;

    turns.push(recordingTurn('findings', { competitors: ['ACME'] }), proseTurn('Done.'));
    const state = makeState([RESEARCH, DIGEST]);
    await runLoop(service(), state, resume);

    // s2 ran with its ledger, and the ledger ANSWERS the call it carried: the key
    // survived JSON, which is the half a size check cannot see.
    expect(catalogCalls[0]).toMatchObject({
      stepReplay: { stepId: 's2', size: 1, answersTheSend: { ok: true } },
    });
    // s3 has none and ran without one.
    expect(catalogCalls[1]?.stepReplay).toBeUndefined();
  });

  it('refuses a LOOPED step its ledger, because nothing can say which item a call was', async () => {
    // Two iterations of one loop can make the identical call, and the entries for a
    // model-issued call come from the loop's catch, which sees the step's calls as
    // one list and no item. Answering iteration two with iteration one's document
    // would be worse than dispatching again. Same refusal the salvage boundary
    // makes, for the same reason.
    const LOOPED: WorkflowStep = {
      ...RESEARCH, description: 'Research {{item.name}}.', loop: { over: '{{input.competitors}}' },
    } as WorkflowStep;
    const resume: HybridResumeState = {
      kind: 'hybrid-pause',
      pauseReason: 'delay',
      currentStepId: 's2',
      resumeAfterStepId: 's2',
      stepOutput: undefined,
      inputData: { competitors: [{ name: 'ACME' }] },
      stepReplay: {
        s2: [{ key: 'slack|send_message|{"channel":"#x","text":"hi"}', name: 'slack__send_message', result: { ok: true } }],
      },
    } as HybridResumeState;

    turns.push(recordingTurn('findings', { competitors: ['ACME'] }), proseTurn('Done.'));
    const svc = service();
    const state = makeState([LOOPED, DIGEST]);
    await (svc as unknown as { runAgentHybridLoop: RunLoop })
      .runAgentHybridLoop(state, 'audit', { competitors: [{ name: 'ACME' }] }, resume, {});

    // The ledger reached the run — it is on the state — and deliberately not the
    // looped step's catalog.
    expect(state.stepReplay?.get('s2')?.size).toBe(1);
    expect(catalogCalls[0]?.stepReplay).toBeUndefined();
  });

  it('a resumed run with nothing recorded hands the step no ledger at all', async () => {
    const resume: HybridResumeState = {
      kind: 'hybrid-pause',
      // `delay` re-enters the step directly. An `ask_user` resume reaches the
      // same step through a recovery prologue, and the prologue is not what this
      // is about; that the PAUSE carries the ledger is asserted above.
      pauseReason: 'delay',
      currentStepId: 's2',
      resumeAfterStepId: 's2',
      stepOutput: undefined,
      inputData: undefined,
    } as HybridResumeState;
    turns.push(recordingTurn('findings', { competitors: ['ACME'] }), proseTurn('Done.'));
    await runLoop(service(), makeState([RESEARCH, DIGEST]), resume);
    expect(catalogCalls[0]?.stepReplay).toBeUndefined();
  });
});

describe('a salvage turn that does not land falls through to today\'s routing', () => {
  it('yields nothing extractable: onFailure is taken when authored', async () => {
    const WITH_FAILURE: WorkflowStep = { ...RESEARCH, onFailure: 's-err' } as WorkflowStep;
    const ERR: WorkflowStep = { stepId: 's-err', type: 'llm_reason', description: 'say it failed', onSuccess: '' } as WorkflowStep;
    turns.push(
      interruptedTurn(fetched('c1', 'https://acme.example/', 'HOME')),
      proseTurn('I could not record anything.'),
      proseTurn('It failed.'),
    );
    const state = makeState([WITH_FAILURE, DIGEST, ERR]);
    await runLoop(service(), state);
    // The failure branch ran (and, as today, the step joins the unsatisfied
    // set so the graph end reports it); the salvage left no trace.
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('say it failed');
    expect(state.salvagedSteps?.size ?? 0).toBe(0);
    expect(metrics.find(([n]) => n === 'hybrid_loop.step_salvaged')).toBeUndefined();
    expect(metrics).toContainEqual(['hybrid_loop.anomaly_triggered', { anomaly_kind: 'step_failed_to_on_failure' }]);
  });

  it('throws: same', async () => {
    turns.push(
      interruptedTurn(fetched('c1', 'https://acme.example/', 'HOME')),
      async function* () { yield { type: 'completion', outcome: 'error', reason: 'salvage provider down' }; },
    );
    const out = await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(out.escalated).toBe(true);
    expect(prompts).toHaveLength(2);
  });
});

describe('the fact travels across pauses and onto the result', () => {
  const ASK: WorkflowStep = { stepId: 's3', type: 'ask_user', description: 'ask', question: 'Which region?', onSuccess: 's4' } as WorkflowStep;
  const FINISH: WorkflowStep = { stepId: 's4', type: 'llm_reason', description: 'finish', onSuccess: '' } as WorkflowStep;

  const pausePayload = readPausePayload;

  it('an ask_user pause after a salvaged step carries the step and its note; the resumed half finishes with it on the result', async () => {
    turns.push(interruptedTurn(fetched('c1', 'https://acme.example/', 'HOME')), recordingTurn('findings', { competitors: ['ACME'] }));
    const svc = service();
    const paused = await runLoop(svc, makeState([RESEARCH, ASK, FINISH]));
    expect(paused.paused).toBe(true);
    // The pause result itself names the step: every exit of the loop does.
    expect(paused.salvagedSteps).toEqual(['s2']);
    const payload = pausePayload();
    expect(payload.salvagedSteps).toEqual(['s2']);
    expect(payload.salvageNotes).toEqual({ s2: { unavailable: [], interruptedBy: 'anomaly_escalated' } });

    // The resumed half: s4 runs, its prompt still carries the line, and the
    // result names the step it never salvaged itself — hydrated from the pause.
    turns.push(proseTurn('Finished.'));
    const state = makeState([RESEARCH, ASK, FINISH]);
    const resumed = await runLoop(svc, state, { ...payload, pauseReason: 'delay', currentStepId: 's4', resumeAfterStepId: 's4' });
    expect(resumed.success).toBe(true);
    expect(resumed.salvagedSteps).toEqual(['s2']);
    expect(prompts[prompts.length - 1]).toContain('[s2: produced from partial material');
    // The finalizer applies the same helper and changes nothing.
    await (svc as unknown as { finalizeResumedInvocation: (a: unknown) => Promise<void> }).finalizeResumedInvocation({
      state, invocationId: undefined, result: resumed, resumeKind: 'delay', resumeRowId: 'row-1',
    });
    expect(resumed.salvagedSteps).toEqual(['s2']);
  });

  it('a fan-out parent reading its children back off the registry sees the fact too', async () => {
    const svc = service();
    queryMock.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT child_invocation_id, status')) {
        return { rows: [{ child_invocation_id: 'c-1', status: 'completed' }, { child_invocation_id: 'c-2', status: 'completed' }] };
      }
      if (typeof sql === 'string' && sql.includes('salvaged_steps')) {
        return { rows: [
          { child_invocation_id: 'c-1', agent_id: 'a-1', task_index: 0, status: 'completed', duration_ms: 10, result_summary: 'one', result_usage: null, anomalies: null, salvaged_steps: ['s2'] },
          { child_invocation_id: 'c-2', agent_id: 'a-2', task_index: 1, status: 'completed', duration_ms: 10, result_summary: 'two', result_usage: null, anomalies: null, salvaged_steps: null },
        ] };
      }
      return { rows: [], rowCount: 0 };
    });
    const results = await (svc as unknown as { reawaitInFlightDelegations: (ifd: unknown) => Promise<Array<{ taskIndex: number; salvagedSteps?: string[] }>> })
      .reawaitInFlightDelegations({ parentToolCallId: 'p', idempotencyKey: 'k', childInvocationIds: ['c-1', 'c-2'], taskSummaries: [], deadlineAt: new Date(Date.now() + 1000).toISOString() });
    expect(results[0]).toMatchObject({ taskIndex: 0, salvagedSteps: ['s2'] });
    expect(results[1].salvagedSteps).toBeUndefined();
  });

  it('a HITL pause raised inside a later step carries it too', async () => {
    turns.push(
      interruptedTurn(fetched('c1', 'https://acme.example/', 'HOME')),
      recordingTurn('findings', { competitors: ['ACME'] }),
      async function* () {
        yield {
          type: 'pause_requested', reason: 'hitl_gate', token: { adapterKind: 'stub', serialized: 'tok' },
          gateContext: { gateReason: 'communication_review', pendingToolCalls: [{ id: 'p1', name: 'slack__send_message', input: { text: 'x' } }] },
        };
      },
    );
    const paused = await runLoop(service(), makeState([RESEARCH, DIGEST]));
    expect(paused.paused).toBe(true);
    const payload = pausePayload();
    expect(payload.pauseReason).toBe('hitl_approval');
    expect(payload.salvagedSteps).toEqual(['s2']);
  });

  it('a wall-clock continuation carries it too', async () => {
    // The wall clock is checked at the loop head: the first step starts
    // inside a one-millisecond window and spends it, so the second finds
    // the window gone and the run parks with the whole loop state.
    const slowRecording: Script = async function* () {
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'tool_call_started', toolName: 'record_step_output', args: { findings: { competitors: ['ACME'] } }, callId: 'rec-1' };
      yield { type: 'tool_call_finished', callId: 'rec-1', result: { recorded: true } };
      yield { type: 'completion', outcome: 'success' };
    };
    turns.push(interruptedTurn(fetched('c1', 'https://acme.example/', 'HOME')), slowRecording);
    const state = makeState([RESEARCH, DIGEST], { execConfig: { timeoutMs: 1 } as ExecutionContext['execConfig'] });
    const parked = await runLoop(service(), state);
    expect(parked.paused).toBe(true);
    expect(parked.pauseKind).toBe('continuation');
    const row = scheduledInsertMock.mock.calls[0][0] as { workflowResume: HybridResumeState };
    expect(row.workflowResume.salvagedSteps).toEqual(['s2']);
    expect(row.workflowResume.salvageNotes?.s2).toEqual({ unavailable: [], interruptedBy: 'anomaly_escalated' });
  });

  it('a delegated child that salvaged reports it on the collected result', async () => {
    const svc = service();
    (svc as unknown as { agentLifecycle: { getAgent: jest.Mock } }).agentLifecycle.getAgent
      .mockResolvedValue({ id: 'child', tenantId: 't1', lifecycle: 'ACTIVE' });
    (svc as unknown as { admissionService: { checkAdmission: jest.Mock } }).admissionService = {
      checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
    };
    (svc as unknown as { getActiveInstruction: jest.Mock }).getActiveInstruction = jest.fn().mockResolvedValue({ id: 'ins', version: 1 });
    jest.spyOn(svc, 'executeTask').mockResolvedValue({
      success: true, output: 'child answer', toolCallsExecuted: 2, reasoningSteps: 2,
      usage: { inputTokens: 1, outputTokens: 1 }, salvagedSteps: ['s2'],
    } as TaskExecutionResult);
    const collected = await svc.delegateToAgent({
      tenantId: 't1', agentId: 'child', objective: 'do it', collect: true, preGated: true,
      parentInvocationId: 'inv-parent', triggeredByUserId: null, impersonatedBy: null,
    } as Parameters<AgentExecutionService['delegateToAgent']>[0]);
    expect(collected).toMatchObject({ output: 'child answer', salvagedSteps: ['s2'] });
  });
});

describe('the fair-share digest', () => {
  it('shows early, middle and late results of thirty, in order', () => {
    const calls = Array.from({ length: 30 }, (_, i) => ({
      name: 'web_fetch_advanced', input: { url: `https://x/${i}` }, success: true,
      result: `MARKER-${i} ${'x'.repeat(3_000)}`,
    }));
    const digest = buildStepSalvageDigest(calls);
    expect(digest.text).toContain('MARKER-0 ');
    expect(digest.text).toContain('MARKER-15 ');
    expect(digest.text).toContain('MARKER-29 ');
    expect(digest.text.indexOf('MARKER-0 ')).toBeLessThan(digest.text.indexOf('MARKER-15 '));
    expect(digest.text.indexOf('MARKER-15 ')).toBeLessThan(digest.text.indexOf('MARKER-29 '));
    expect(digest.text.length).toBeLessThanOrEqual(16_000);
    expect(digest.text).toMatch(/…\[truncated, \d+ of 3009 chars\]/);
    expect(digest.text.startsWith('Tool calls this step made: 30 (30 succeeded, 0 failed).')).toBe(true);
  });

  it('returns a small call\'s surplus to the pool in one second pass', () => {
    const small = { name: 'a', input: {}, success: true, result: 'tiny' };
    const big = { name: 'b', input: {}, success: true, result: 'y'.repeat(5_000) };
    const digest = buildStepSalvageDigest([small, big, big, big, big, big, big, big, big, big]);
    // Ten calls under 16,000: an equal share is ~1,590; the tiny call gives
    // its surplus back and the nine cut calls each get more than the share.
    const kept = [...digest.text.matchAll(/…\[truncated, (\d+) of 5000 chars\]/g)].map((m) => Number(m[1]));
    expect(kept).toHaveLength(9);
    for (const k of kept) expect(k).toBeGreaterThan(1_590 - 60);
    expect(digest.text.length).toBeLessThanOrEqual(16_000);
  });

  it('caps any one call at 2,000 whatever its share', () => {
    const digest = buildStepSalvageDigest([{ name: 'a', input: {}, success: true, result: 'z'.repeat(10_000) }]);
    const line = digest.text.split('\n')[1];
    expect(line.length).toBeLessThanOrEqual('a({}): '.length + 2_000);
    expect(line).toMatch(/…\[truncated, \d+ of 10000 chars\]$/);
  });

  it('counts false and 0 as results and is byte-stable', () => {
    const calls = [
      { name: 'a', input: { url: 'https://x/?token=s' }, success: true, result: false },
      { name: 'b', input: {}, success: true, result: 0 },
      { name: 'c', input: {}, success: false, error: 'boom', errorCode: 'not_found' },
    ];
    const one = buildStepSalvageDigest(calls);
    expect(one.text).toBe(buildStepSalvageDigest(calls).text);
    expect(one.text).toContain('a({"url":"https://x/?token=%5BREDACTED%5D"}): false');
    expect(one.text).toContain('b({}): 0');
    expect(one.text).toContain('c({}): not_found');
    expect(one.successes).toBe(2);
    expect(one.failures).toBe(1);
    expect(one.unavailable).toEqual([{ name: 'c', args: '{}' }]);
  });
});

// Persisted and remembered tool calls name the right call.
//
// Codex numbers calls `item_0, item_1, …` PER TURN, so across the steps of
// one invocation several different calls share an id. A persistence overlay
// that prefers the trajectory recorder's `tool_use` by id lets the last write
// win, so a row's first entry can be `web_fetch_advanced` carrying
// `run_routine_now`'s result. The record saw its own start; when it did, that
// is the call.
describe('two different calls that both use item_0 across steps', () => {
  const { rememberExternalToolCall } = jest.requireMock('../remember-external-tool-call') as { rememberExternalToolCall: jest.Mock };

  it('are recorded, remembered and persisted under their own names, inputs and results', async () => {
    const A: WorkflowStep = { stepId: 'sA', type: 'llm_reason', description: 'first', onSuccess: 'sB' } as WorkflowStep;
    const B: WorkflowStep = { stepId: 'sB', type: 'llm_reason', description: 'second', onSuccess: '' } as WorkflowStep;
    turns.push(
      async function* () {
        yield { type: 'tool_call_started', toolName: 'run_routine_now', args: { routine: 'audit' }, callId: 'item_0' };
        yield { type: 'tool_call_finished', callId: 'item_0', result: { started: true } };
        yield { type: 'assistant_message', content: [{ type: 'text', text: 'started' }] };
        yield { type: 'completion', outcome: 'success' };
      },
      async function* () {
        yield { type: 'tool_call_started', toolName: 'web_fetch_advanced', args: { url: 'https://acme.example/' }, callId: 'item_0' };
        yield { type: 'tool_call_finished', callId: 'item_0', result: { content: 'HOME' } };
        yield { type: 'assistant_message', content: [{ type: 'text', text: 'fetched' }] };
        yield { type: 'completion', outcome: 'success' };
      },
    );
    const svc = service();
    const state = makeState([A, B]);
    await runLoop(svc, state);

    // The run's own record: each finish paired with its own start.
    expect(state.completedToolCalls).toEqual([
      expect.objectContaining({ id: 'item_0', name: 'run_routine_now', input: { routine: 'audit' }, result: { started: true } }),
      expect.objectContaining({ id: 'item_0', name: 'web_fetch_advanced', input: { url: 'https://acme.example/' }, result: { content: 'HOME' } }),
    ]);
    // The ledger saw the same two calls.
    const remembered = rememberExternalToolCall.mock.calls.map((c: unknown[]) => c[0] as { toolName: string; args: unknown; result: unknown });
    expect(remembered).toEqual([
      expect.objectContaining({ toolName: 'run_routine_now', args: { routine: 'audit' }, result: { started: true } }),
      expect.objectContaining({ toolName: 'web_fetch_advanced', args: { url: 'https://acme.example/' }, result: { content: 'HOME' } }),
    ]);
    // The persisted rows prefer the record even when the recorder holds a
    // later tool_use under the same id.
    getRunMock.mockReturnValue({
      messages: [
        { content: [{ type: 'tool_use', id: 'item_0', name: 'run_routine_now', input: { routine: 'audit' } }] },
        { content: [{ type: 'tool_use', id: 'item_0', name: 'web_fetch_advanced', input: { url: 'https://acme.example/' } }] },
      ],
    });
    const persisted = (svc as unknown as { toolCallsForPersistence: (id: string, c: unknown[]) => Array<{ name: string; input: unknown; output: unknown }> })
      .toolCallsForPersistence('inv-1', state.completedToolCalls);
    expect(persisted).toEqual([
      { id: 'item_0', name: 'run_routine_now', input: { routine: 'audit' }, output: { started: true }, error: undefined },
      { id: 'item_0', name: 'web_fetch_advanced', input: { url: 'https://acme.example/' }, output: { content: 'HOME' }, error: undefined },
    ]);
  });

  it('still reads the recorder for a record with no name, and keeps {} as a real input', () => {
    const svc = service();
    getRunMock.mockReturnValue({
      messages: [{ content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }],
    });
    const persisted = (svc as unknown as { toolCallsForPersistence: (id: string, c: unknown[]) => Array<{ name: string; input: unknown }> })
      .toolCallsForPersistence('inv-1', [
        { id: 'toolu_1', success: true, result: 'ok' },
        { id: 'toolu_1', success: true, result: 'ok', name: 'unknown' },
        { id: 'toolu_1', success: true, result: 'ok', name: 'record_step_output', input: {} },
      ]);
    expect(persisted[0]).toMatchObject({ name: 'Bash', input: { command: 'ls' } });
    expect(persisted[1]).toMatchObject({ name: 'Bash', input: { command: 'ls' } });
    expect(persisted[2]).toMatchObject({ name: 'record_step_output', input: {} });
  });
});
