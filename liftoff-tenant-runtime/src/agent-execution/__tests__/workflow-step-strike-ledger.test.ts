// A strike is a repeat of the SAME CALL, on the workflow-step path too.
//
// The step executor's identical-failure cap keyed a strike on the tool name
// plus the ERROR TEXT. Three guessed addresses that did not exist, each
// answered with the same generic "Failed to fetch URL.", read as one call
// rejected three times: the step was aborted with thirty pages already
// fetched, the retries re-ran the same fetches, and the run escalated for
// "connectivity". The chat branch had the right rule all along, in
// call-strike-ledger.ts: the key is the tool name plus its canonical
// arguments, and one model turn's rejections fold into ONE strike when the
// engine names its batches.
//
// Driven through the real invokeStepLLM: the fake engine hands back the
// handlers the step registers, and each case scripts the anomalies a turn
// raises and the batch boundaries it closes. The typed step errors (5a) are
// pinned here too, because the anomaly handler is what decides them.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    createApprovalRequest: jest.fn(),
    getOversightSettings: jest.fn().mockResolvedValue({ communication: 'review', sensitiveWork: {} }),
    checkHitlGate: jest.fn().mockResolvedValue({ shouldGate: false }),
  },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));
const poolMock = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), connect: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => poolMock), getPool: jest.fn(() => poolMock), pool: poolMock,
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: jest.fn().mockResolvedValue(undefined),
    getAgent: jest.fn().mockResolvedValue({ lifecycle: 'ACTIVE' }),
  })),
}));
jest.mock('../../infrastructure/cloud-tasks', () => ({ enqueueAgentExecution: jest.fn() }));
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: { updateCloudTaskName: jest.fn() },
}));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../streaming', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitHitlRejected: jest.fn() },
}));
jest.mock('../../agent-chat/agent-slack-client', () => ({
  postReviewDm: jest.fn(), listAgentAssignees: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../tool-gateway/agent-slack-tool-catalog', () => ({ SLACK_OUTBOUND_TOOL_NAMES: new Set() }));
jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn(), complete: jest.fn() } }));
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
  resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../agent-lifecycle/types', () => ({ trustLevelFor: jest.fn().mockReturnValue('trusted') }));
jest.mock('../run-state/service', () => ({ agentRunStateService: {} }));
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
jest.mock('../../infrastructure/pubsub', () => ({ publisher: {} }));
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

import type { AnomalyHandler, ToolBatchHandler, InvocationEvent } from '../adapter/types';

/** The fake engine. `identified` decides whether it offers a batch boundary,
 *  which is what switches the ledger between batch and per-event folding. */
type Script = (handlers: { anomaly: AnomalyHandler; batch: ToolBatchHandler | null }, signal: AbortSignal) => AsyncGenerator<InvocationEvent>;
let script: Script = async function* () { yield { type: 'completion', outcome: 'success' }; };
let identified = true;
jest.mock('../adapter', () => ({
  createAdapter: jest.fn().mockImplementation(() => {
    let anomaly: AnomalyHandler | null = null;
    let batch: ToolBatchHandler | null = null;
    const engine: Record<string, unknown> = {
      kind: 'stub',
      invoke: (_input: unknown, signal: AbortSignal) => script({ anomaly: anomaly!, batch }, signal),
      pause: jest.fn(), resume: jest.fn(),
      registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(),
      registerAnomalyHandler: (h: AnomalyHandler) => { anomaly = h; },
    };
    if (identified) engine.registerToolBatchHandler = (h: ToolBatchHandler) => { batch = h; };
    return engine;
  }),
}));

import { AgentExecutionService } from '../service';
import { StepInterruptedError, StepAbortedError, StepLimitReachedError, StepEngineError } from '../step-errors';
import type { ExecutionContext, ExecutionState, WorkflowStep } from '../types';

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

const STEP: WorkflowStep = { stepId: 's2', type: 'llm_reason', description: 'research', onSuccess: 's3' } as WorkflowStep;

const metrics: Array<[string, Record<string, string>]> = [];
function service(): AgentExecutionService {
  const svc = new AgentExecutionService();
  (svc as unknown as { buildPlatformMcpCatalog: jest.Mock }).buildPlatformMcpCatalog = jest.fn().mockResolvedValue({ tools: [], servers: [] });
  (svc as unknown as { emitHybridMetric: (name: string, _s: unknown, labels: Record<string, string>) => void }).emitHybridMetric =
    (name, _s, labels) => { metrics.push([name, labels]); };
  return svc;
}
type Invoke = (state: ExecutionState, step: WorkflowStep, ...rest: unknown[]) => Promise<{ output: unknown }>;
const invoke = (svc: AgentExecutionService) => (svc as unknown as { invokeStepLLM: Invoke }).invokeStepLLM.bind(svc);

const fetchFailure = (url: string, callId: string, error = 'Failed to fetch URL.') => ({
  kind: 'tool_call_error' as const,
  context: { toolName: 'web_fetch_advanced', callId, args: { url }, error },
  invocationId: 'inv-1',
});

beforeEach(() => {
  jest.clearAllMocks();
  metrics.length = 0;
  identified = true;
});

describe('the workflow-step identical-failure cap keys on the CALL', () => {
  it('three failures on three different urls, same error text, are three facts: no escalate', async () => {
    const decisions: Array<{ escalate?: boolean }> = [];
    script = async function* ({ anomaly, batch }) {
      for (const [i, url] of ['https://a/blog', 'https://a/blogs', 'https://a/pricing'].entries()) {
        decisions.push(await anomaly(fetchFailure(url, `c${i}`)));
        await batch!([`c${i}`]);
      }
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'completion', outcome: 'success' };
    };
    const out = await invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj');
    expect(out.output).toBe('done');
    expect(decisions.every((d) => !d.escalate)).toBe(true);
    expect(metrics.find(([n]) => n === 'hybrid_loop.identical_tool_failure_cap')).toBeUndefined();
  });

  it('three identical calls across three turns escalate on the third fold, as a typed interruption', async () => {
    // On an engine that names its batches the strike is read at the CLOSE,
    // so the handler itself answers {} and the boundary is what ends the
    // turn — by aborting the engine, which reports as the engines do.
    const decisions: Array<{ escalate?: boolean }> = [];
    const closes: boolean[] = [];
    script = async function* ({ anomaly, batch }, signal) {
      for (const i of [0, 1, 2]) {
        decisions.push(await anomaly(fetchFailure('https://a/blog', `c${i}`)));
        await batch!([`c${i}`]);
        closes.push(signal.aborted);
        if (signal.aborted) {
          yield { type: 'completion', outcome: 'error', reason: 'The operation was aborted' };
          return;
        }
      }
      yield { type: 'completion', outcome: 'success' };
    };
    await expect(invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj')).rejects.toBeInstanceOf(StepInterruptedError);
    expect(decisions.every((d) => !d.escalate)).toBe(true);
    expect(closes).toEqual([false, false, true]);
    expect(metrics).toContainEqual(['hybrid_loop.identical_tool_failure_cap', { tool_name: 'web_fetch_advanced', step_id: 's2' }]);
  });

  it('the interruption names the anomaly it escalated on', async () => {
    script = async function* ({ anomaly, batch }, signal) {
      for (const i of [0, 1, 2]) {
        await anomaly(fetchFailure('https://a/blog', `c${i}`, 'TOOL_ERROR {"code":"internal_error"}'));
        await batch!([`c${i}`]);
        if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
      }
    };
    let thrown: unknown;
    try { await invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj'); } catch (e) { thrown = e; }
    const err = thrown as StepInterruptedError;
    expect(err.cause).toBe('anomaly_escalated');
    expect(err.anomaly.context.toolName).toBe('web_fetch_advanced');
    expect(err.anomaly.context.error).toBe('TOOL_ERROR {"code":"internal_error"}');
  });

  it('three identical calls in ONE batch are one strike: no escalate', async () => {
    const decisions: Array<{ escalate?: boolean }> = [];
    script = async function* ({ anomaly, batch }) {
      for (const i of [0, 1, 2]) decisions.push(await anomaly(fetchFailure('https://a/blog', `c${i}`)));
      await batch!(['c0', 'c1', 'c2']);
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'completion', outcome: 'success' };
    };
    const out = await invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj');
    expect(out.output).toBe('done');
    expect(decisions.every((d) => !d.escalate)).toBe(true);
    expect(metrics.find(([n]) => n === 'hybrid_loop.identical_tool_failure_cap')).toBeUndefined();
  });

  it('reaching the cap at a batch boundary ends the turn through the same typed interruption', async () => {
    // Two batches of one and a third: every strike is read at the close.
    script = async function* ({ anomaly, batch }, signal) {
      await anomaly(fetchFailure('https://a/blog', 'c0')); await batch!(['c0']);
      await anomaly(fetchFailure('https://a/blog', 'c1')); await batch!(['c1']);
      await anomaly(fetchFailure('https://a/blog', 'c2'));
      await batch!(['c2']);
      // The boundary aborted the engine; it reports as the engines do.
      expect(signal.aborted).toBe(true);
      yield { type: 'completion', outcome: 'error', reason: 'aborted' };
    };
    await expect(invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj')).rejects.toBeInstanceOf(StepInterruptedError);
  });

  it('argument key order does not change the key', async () => {
    const closes: boolean[] = [];
    script = async function* ({ anomaly, batch }, signal) {
      const variants = [{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1, b: 2 }];
      for (const [i, args] of variants.entries()) {
        await anomaly({ kind: 'tool_call_error', context: { toolName: 'lookup', callId: `c${i}`, args, error: 'nope' }, invocationId: 'inv-1' });
        await batch!([`c${i}`]);
        closes.push(signal.aborted);
        if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
      }
      yield { type: 'completion', outcome: 'success' };
    };
    await expect(invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj')).rejects.toBeInstanceOf(StepInterruptedError);
    expect(closes).toEqual([false, false, true]);
  });

  it('a missing argument is a different key', async () => {
    const decisions: Array<{ escalate?: boolean }> = [];
    script = async function* ({ anomaly, batch }) {
      const variants = [{ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 }];
      for (const [i, args] of variants.entries()) {
        decisions.push(await anomaly({ kind: 'tool_call_error', context: { toolName: 'lookup', callId: `c${i}`, args, error: 'nope' }, invocationId: 'inv-1' }));
        await batch!([`c${i}`]);
      }
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'completion', outcome: 'success' };
    };
    const out = await invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj');
    expect(out.output).toBe('done');
    expect(decisions.every((d) => !d.escalate)).toBe(true);
  });

  it('never counts a code-execution tool', async () => {
    const decisions: Array<{ escalate?: boolean }> = [];
    script = async function* ({ anomaly, batch }) {
      for (const i of [0, 1, 2, 3]) {
        decisions.push(await anomaly({ kind: 'tool_call_error', context: { toolName: 'Bash', callId: `c${i}`, args: { command: 'node x.js' }, error: 'exit 1' }, invocationId: 'inv-1' }));
        await batch!([`c${i}`]);
      }
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'completion', outcome: 'success' };
    };
    const out = await invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj');
    expect(out.output).toBe('done');
    expect(decisions.every((d) => !d.escalate)).toBe(true);
  });

  it('folds per event on an engine that names no batches', async () => {
    identified = false;
    const decisions: Array<{ escalate?: boolean }> = [];
    script = async function* ({ anomaly, batch }) {
      expect(batch).toBeNull();
      for (const i of [0, 1, 2]) {
        decisions.push(await anomaly(fetchFailure('https://a/blog', `item_${i}`)));
        if (decisions[i].escalate) { yield { type: 'completion', outcome: 'error', reason: 'The operation was aborted' }; return; }
      }
    };
    await expect(invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj')).rejects.toBeInstanceOf(StepInterruptedError);
    expect(decisions.map((d) => !!d.escalate)).toEqual([false, false, true]);
  });
});

// The step-ending conditions, typed by CAUSE rather than by the engine's
// wording. The same "aborted" text means a different thing depending on who
// aborted, and only the executor's own closure knows.
describe('a step turn ends with a typed error', () => {
  it('limit_reached is a StepLimitReachedError', async () => {
    script = async function* () { yield { type: 'completion', outcome: 'limit_reached', reason: 'max turns' }; };
    await expect(invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj')).rejects.toBeInstanceOf(StepLimitReachedError);
  });

  it("an error while the RUN's abort signal is raised is a StepAbortedError", async () => {
    const abort = new AbortController();
    abort.abort();
    script = async function* () { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; };
    const state = makeState([STEP], { abortSignal: abort.signal } as Partial<ExecutionContext>);
    await expect(invoke(service())(state, STEP, undefined, undefined, 'obj')).rejects.toBeInstanceOf(StepAbortedError);
  });

  it('any other error is a StepEngineError carrying the reason', async () => {
    script = async function* () { yield { type: 'completion', outcome: 'error', reason: 'provider 500' }; };
    let thrown: unknown;
    try { await invoke(service())(makeState([STEP]), STEP, undefined, undefined, 'obj'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(StepEngineError);
    expect((thrown as StepEngineError).reason).toBe('provider 500');
  });

  it('the anomaly handler wins over the abort signal when both hold', async () => {
    const abort = new AbortController();
    script = async function* ({ anomaly, batch }, signal) {
      for (const i of [0, 1, 2]) {
        await anomaly(fetchFailure('https://a/blog', `c${i}`));
        await batch!([`c${i}`]);
        if (signal.aborted) { abort.abort(); yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
      }
    };
    const state = makeState([STEP], { abortSignal: abort.signal } as Partial<ExecutionContext>);
    await expect(invoke(service())(state, STEP, undefined, undefined, 'obj')).rejects.toBeInstanceOf(StepInterruptedError);
  });
});
