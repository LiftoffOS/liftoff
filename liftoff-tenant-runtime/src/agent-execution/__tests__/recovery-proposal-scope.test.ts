// What a recovery proposal may call: instrument, observe, enforce as a unit,
// narrow.
//
// Recovery exists to get one approved step past a failure. A `continue`
// proposal that calls a tool the graph never names and that writes somewhere
// is a new action nobody approved, taken by a model with the whole catalog in
// front of it; a read is the lookup a repair plausibly needs. So the rule is
// "a tool the graph names, or a read-only tool", on the FULL aliased catalog
// name — two accounts of one connector share every bare action and must not be
// conflated.
//
// Four stages, four sets of tests:
//   1a  every `continue` is classified, logged, and its calls are on the audit
//       row — including the ones enforcement later rejects and the ones that
//       resolve to nothing — while dispatch is unchanged;
//   1c  under TR_RECOVERY_SCOPE_ENFORCE=1 a mixed proposal executes NOTHING,
//       the advisor is re-asked with a recovery_proposal_rejected anomaly, and
//       a second rejected proposal on the step escalates;
//   1d  under the same flag the advisor is shown only the allowed set.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../streaming', () => ({
  streamingService: { emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
class MockHitlGateError extends Error {
  reason: string;
  constructor(_toolCalls: unknown[], reason: string) { super(reason); this.name = 'HitlGateError'; this.reason = reason; }
}
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: { checkGate: jest.fn() },
  HitlGateError: MockHitlGateError,
  ModelTool: {},
}));
jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn(), complete: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/service', () => ({ CoordinatorService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../tool-gateway/service', () => ({
  ToolGatewayService: jest.fn().mockImplementation(() => ({ setCredentialService: jest.fn(), routeToolCall: jest.fn() })),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })),
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: jest.fn().mockResolvedValue(undefined),
    getAgent: jest.fn(),
  })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../infrastructure/database', () => {
  const pool = {
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() })),
  };
  return { getPoolForService: jest.fn(() => pool), getPool: jest.fn(() => pool) };
});
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getFeatureFlags: jest.fn().mockResolvedValue({}),
    getEntitlements: jest.fn().mockResolvedValue({}),
  }),
}));
jest.mock('../../memory', () => ({ memoryService: { retrieve: jest.fn(), save: jest.fn() }, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: { getMessages: jest.fn().mockResolvedValue([]) } }));
const mockInsertAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../../audit', () => ({ insertAuditLog: (...a: unknown[]) => mockInsertAuditLog(...a) }));
jest.mock('../../audit/service', () => ({ insertAuditLog: (...a: unknown[]) => mockInsertAuditLog(...a) }));
jest.mock('../tool-interceptor', () => ({ interceptToolCalls: jest.fn((calls) => calls) }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifests: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({ resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]) }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
const mockCreateEscalation = jest.fn().mockResolvedValue('esc-1');
jest.mock('../engine/escalation-helper', () => ({
  createEscalation: (...a: unknown[]) => mockCreateEscalation(...a),
  escalationThreadTitle: jest.fn(() => null),
}));

import {
  AgentExecutionService,
  classifyRecoveryProposal,
  allowedRecoveryTools,
  isRecoveryScopeEnforced,
} from '../service';
import { logger } from '../../infrastructure/logging';
import { llmClient } from '../../llm/client';
import type { ExecutionState, WorkflowStep, TaskExecutionResult, ToolCallRequest, AnomalyContext } from '../types';

const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock };
const mockComplete = llmClient.complete as jest.Mock;

/** A catalog in the shape buildToolsSchema returns: name, effect, categories. */
const CATALOG = [
  { name: 'gmail-aaa__send', description: 'send from account aaa', effect: 'write', categories: ['outbound'] },
  { name: 'gmail-bbb__send', description: 'send from account bbb', effect: 'write', categories: ['outbound'] },
  { name: 'gmail-aaa__list_messages', description: 'list', effect: 'read', categories: ['read'] },
  { name: 'crm__lookup', description: 'lookup', categories: ['read'] },
  { name: 'crm__delete_record', description: 'delete', effect: 'write', categories: ['destructive'] },
];

const GRAPH: WorkflowStep[] = [
  { stepId: 's1', description: 'send', type: 'tool_call', toolName: 'gmail-aaa__send', toolInput: { to: 'x' }, onSuccess: 's2', onFailure: 's2' },
  { stepId: 's2', description: 'done', type: 'llm_reason' },
];

const call = (connector: string, actionType: string): ToolCallRequest =>
  ({ id: `c-${connector}-${actionType}`, connector, entityType: '', actionType, payload: {} });

// ── Classification, against ToolCallRequest inputs ─────────────────────────
describe('classifyRecoveryProposal', () => {
  it('a call to a tool the graph names → in_graph', () => {
    const scope = classifyRecoveryProposal([call('gmail-aaa', 'send')], GRAPH, CATALOG);
    expect(scope.calls).toEqual([{ name: 'gmail-aaa__send', resolved: true, in_graph: true, read_only: false }]);
    expect(scope.outOfScope).toBe(false);
    expect(scope.rejected).toEqual([]);
  });

  it('the same action on another account of the connector is NOT in the graph', () => {
    // Bare action names would conflate the two; full aliased names do not.
    const scope = classifyRecoveryProposal([call('gmail-bbb', 'send')], GRAPH, CATALOG);
    expect(scope.calls).toEqual([{ name: 'gmail-bbb__send', resolved: true, in_graph: false, read_only: false }]);
    expect(scope.outOfScope).toBe(true);
    expect(scope.rejected).toEqual(['gmail-bbb__send']);
  });

  it('a read-only tool outside the graph → read_only, in scope', () => {
    const scope = classifyRecoveryProposal([call('gmail-aaa', 'list_messages'), call('crm', 'lookup')], GRAPH, CATALOG);
    expect(scope.calls.map((c) => [c.name, c.in_graph, c.read_only])).toEqual([
      ['gmail-aaa__list_messages', false, true],
      ['crm__lookup', false, true],
    ]);
    expect(scope.outOfScope).toBe(false);
  });

  it('a write outside the graph → out of scope', () => {
    const scope = classifyRecoveryProposal([call('crm', 'delete_record')], GRAPH, CATALOG);
    expect(scope.calls[0]).toEqual({ name: 'crm__delete_record', resolved: true, in_graph: false, read_only: false });
    expect(scope.rejected).toEqual(['crm__delete_record']);
  });

  it('a call that resolves to nothing → unresolved, reported by its formatted name, out of scope', () => {
    const scope = classifyRecoveryProposal([call('gmail-zzz', 'send')], GRAPH, CATALOG);
    expect(scope.calls[0]).toEqual({ name: 'gmail-zzz__send', resolved: false, in_graph: false, read_only: false });
    expect(scope.unresolved).toBe(true);
    expect(scope.outOfScope).toBe(true);
    expect(scope.rejected).toEqual(['gmail-zzz__send']);
  });

  it('a connector-less call keeps the bare action name', () => {
    const scope = classifyRecoveryProposal([call('', 'crm__lookup')], GRAPH, CATALOG);
    expect(scope.calls[0]).toMatchObject({ name: 'crm__lookup', resolved: true, read_only: true });
  });

  it('graph names are resolved through the catalog too', () => {
    // A step authored in the SDK's mcp__ form resolves to the catalog name.
    const graph: WorkflowStep[] = [{ stepId: 's1', description: 'd', toolName: 'mcp__liftoff-tool-gateway__gmail-aaa__send' }];
    const scope = classifyRecoveryProposal([call('gmail-aaa', 'send')], graph, CATALOG);
    expect(scope.calls[0].in_graph).toBe(true);
  });

  it('a mixed proposal is out of scope as a whole, naming only the offending calls', () => {
    const scope = classifyRecoveryProposal(
      [call('gmail-aaa', 'send'), call('crm', 'lookup'), call('gmail-bbb', 'send'), call('nope', 'x')],
      GRAPH, CATALOG,
    );
    expect(scope.outOfScope).toBe(true);
    expect(scope.rejected).toEqual(['gmail-bbb__send', 'nope__x']);
  });
});

describe('allowedRecoveryTools', () => {
  it('is the graph\'s tools plus every read-only tool', () => {
    expect(allowedRecoveryTools(GRAPH, CATALOG).map((t) => t.name)).toEqual([
      'gmail-aaa__send', 'gmail-aaa__list_messages', 'crm__lookup',
    ]);
  });
});

describe('the flag', () => {
  it('is off unless TR_RECOVERY_SCOPE_ENFORCE=1', () => {
    delete process.env.TR_RECOVERY_SCOPE_ENFORCE;
    expect(isRecoveryScopeEnforced()).toBe(false);
    process.env.TR_RECOVERY_SCOPE_ENFORCE = '1';
    expect(isRecoveryScopeEnforced()).toBe(true);
    process.env.TR_RECOVERY_SCOPE_ENFORCE = 'true';
    expect(isRecoveryScopeEnforced()).toBe(false);
    delete process.env.TR_RECOVERY_SCOPE_ENFORCE;
  });
});

// ── Inside the loop ────────────────────────────────────────────────────────
function makeState(workflowSteps: WorkflowStep[]): ExecutionState {
  return {
    context: {
      tenantId: 'tenant-1', agentId: 'agent-1', workflowId: 'wf-1', taskId: 'task-1',
      instructionVersion: 4,
      instruction: { systemPrompt: 'test', tools: [], guardrails: [] } as never,
      traceId: 'trace-1', agentType: 'workflow', hitlLevel: 0, modelConfig: {}, execConfig: {}, memoryScope: {},
      workflowSteps, threadId: 'thread-1', invocationId: 'inv-1',
    } as never,
    reasoningSteps: 0, toolCallsExecuted: 0, startTime: new Date(), steps: [],
    conversationHistory: [], pendingToolCalls: [], completedToolCalls: [], toolFailureCounts: new Map(),
  } as ExecutionState;
}

const stubAdapter = { kind: 'anthropic', invoke: jest.fn(), registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(), registerAnomalyHandler: jest.fn() };

type Svc = {
  runAgentHybridLoop: (..._a: unknown[]) => Promise<TaskExecutionResult>;
  invokeRecoveryLLM: (..._a: unknown[]) => Promise<unknown>;
};

function continueWith(toolCalls: ToolCallRequest[]) {
  return { thinking: 't', decision: 'continue' as const, toolCalls };
}

function auditProposedTools(): string[][] {
  return mockInsertAuditLog.mock.calls
    .map((c) => c[2] as { action?: string; outputSummary?: string })
    .filter((a) => a.action === 'hybrid_recovery')
    .map((a) => (JSON.parse(a.outputSummary ?? '{}') as { proposedTools?: string[] }).proposedTools ?? []);
}

function scopeMetrics(): Array<Record<string, unknown>> {
  return mockLogger.info.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((o) => o?.metric === 'hybrid_loop.recovery_proposal_scope');
}

describe('in the hybrid loop', () => {
  let service: AgentExecutionService;
  let mockExecuteToolCalls: jest.Mock;
  let mockAdvise: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TR_RECOVERY_SCOPE_ENFORCE;
    service = new AgentExecutionService();
    mockExecuteToolCalls = jest.fn();
    mockAdvise = jest.fn();
    (service as unknown as Record<string, unknown>).executeToolCalls = mockExecuteToolCalls;
    (service as unknown as Record<string, unknown>).invokeRecoveryLLMOrSynthesize = mockAdvise;
    (service as unknown as Record<string, unknown>).buildToolsSchema = jest.fn().mockResolvedValue(CATALOG);
    (service as unknown as Record<string, unknown>).validateWorkflowGraph = jest.fn().mockResolvedValue({ ok: true });
  });

  const run = (steps: WorkflowStep[]) =>
    (service as unknown as Svc).runAgentHybridLoop(makeState(steps), 'test', undefined, undefined, stubAdapter);

  // s1 fails on its own call; recovery proposes; the proposal is executed
  // (or not) and the loop advances to s2 or re-asks.
  const STEPS: WorkflowStep[] = [
    { stepId: 's1', description: 'send', type: 'tool_call', toolName: 'gmail-aaa__send', toolInput: { to: 'x' }, onSuccess: 's2' },
    { stepId: 's2', description: 'report', type: 'tool_call', toolName: 'gmail-aaa__list_messages', toolInput: {} },
  ];

  describe('B.3.1a — instrument, behaviour unchanged', () => {
    it('the audit row lists every proposed call, rejected and unresolved included, and the metric labels are strings', async () => {
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'vendor down' }])  // s1
        .mockResolvedValueOnce([                                                       // the proposal, executed as today
          { id: 'a', success: true, result: { ok: 1 } },
          { id: 'b', success: true, result: { ok: 2 } },
          { id: 'c', success: true, result: { ok: 3 } },
        ])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { done: true } }]); // s2
      mockAdvise.mockResolvedValueOnce(continueWith([
        call('gmail-aaa', 'send'),      // in graph
        call('crm', 'delete_record'),   // write outside the graph: would be rejected
        call('gmail-zzz', 'send'),      // resolves to nothing
      ]));

      const result = await run(STEPS);

      expect(result.success).toBe(true);
      // Dispatch unchanged: the proposal ran in full.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(3);
      expect(mockExecuteToolCalls.mock.calls[1][1]).toHaveLength(3);
      // The audit names all three, by resolved (or formatted) name.
      expect(auditProposedTools()).toEqual([['gmail-aaa__send', 'crm__delete_record', 'gmail-zzz__send']]);
      // Scalar metric, string labels.
      expect(scopeMetrics()).toEqual([
        expect.objectContaining({ step_id: 's1', out_of_scope: 'true', unresolved: 'true' }),
      ]);
      for (const m of scopeMetrics()) {
        for (const [k, v] of Object.entries(m)) if (k !== 'metric') expect(typeof v).toBe('string');
      }
      // The per-call detail is a structured log line, not a metric.
      const line = mockLogger.info.mock.calls.map((c) => c[0]).find((o) => o?.event === 'hybrid_recovery_proposal_scope');
      expect(line).toMatchObject({
        stepId: 's1',
        calls: [
          { name: 'gmail-aaa__send', resolved: true, in_graph: true, read_only: false },
          { name: 'crm__delete_record', resolved: true, in_graph: false, read_only: false },
          { name: 'gmail-zzz__send', resolved: false, in_graph: false, read_only: false },
        ],
      });
    });

    it('an in-scope proposal is classified as such', async () => {
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'vendor down' }])
        .mockResolvedValueOnce([{ id: 'a', success: true, result: { ok: 1 } }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { done: true } }]);
      mockAdvise.mockResolvedValueOnce(continueWith([call('crm', 'lookup')]));

      await run(STEPS);

      expect(scopeMetrics()).toEqual([expect.objectContaining({ out_of_scope: 'false', unresolved: 'false' })]);
      expect(auditProposedTools()).toEqual([['crm__lookup']]);
    });

    it('a decision other than continue carries no proposedTools and emits no scope metric', async () => {
      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: false, error: 'vendor down' }]);
      mockAdvise.mockResolvedValueOnce({ thinking: 't', decision: 'fail', toolCalls: [], failureReason: 'cannot' });

      const result = await run(STEPS);

      expect(result.success).toBe(false);
      expect(scopeMetrics()).toEqual([]);
      const audits = mockInsertAuditLog.mock.calls.map((c) => c[2] as { action?: string; outputSummary?: string })
        .filter((a) => a.action === 'hybrid_recovery');
      expect(audits).toHaveLength(1);
      expect(JSON.parse(audits[0].outputSummary!)).not.toHaveProperty('proposedTools');
    });
  });

  describe('B.3.1c — enforce, as a unit', () => {
    beforeEach(() => { process.env.TR_RECOVERY_SCOPE_ENFORCE = '1'; });
    afterEach(() => { delete process.env.TR_RECOVERY_SCOPE_ENFORCE; });

    it('a mixed proposal executes nothing and the advisor is re-asked with a recovery_proposal_rejected anomaly', async () => {
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'vendor down' }])   // s1
        .mockResolvedValueOnce([{ id: 'a', success: true, result: { ok: 1 } }])        // the second, in-scope proposal
        .mockResolvedValueOnce([{ id: '2', success: true, result: { done: true } }]);  // s2
      mockAdvise
        .mockResolvedValueOnce(continueWith([call('gmail-aaa', 'send'), call('crm', 'delete_record')]))
        .mockResolvedValueOnce(continueWith([call('gmail-aaa', 'send')]));

      const result = await run(STEPS);

      expect(result.success).toBe(true);
      expect(mockAdvise).toHaveBeenCalledTimes(2);
      // The re-ask's anomaly names the rejected tool and nothing in scope.
      const anomaly = mockAdvise.mock.calls[1][3] as AnomalyContext;
      expect(anomaly).toMatchObject({ kind: 'recovery_proposal_rejected', rejected: ['crm__delete_record'] });
      // Nothing of the first proposal ran: the in-scope call was not executed in part.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(3);
      expect(mockExecuteToolCalls.mock.calls[1][1]).toHaveLength(1);
      expect(mockExecuteToolCalls.mock.calls[1][1][0]).toMatchObject({ connector: 'gmail-aaa', actionType: 'send' });
      // Both proposals are on the audit, the rejected one included.
      expect(auditProposedTools()).toEqual([['gmail-aaa__send', 'crm__delete_record'], ['gmail-aaa__send']]);
      // The re-ask was charged as a retry.
      expect(mockLogger.info.mock.calls.map((c) => c[0]).some((o) => o?.metric === 'hybrid_loop.recovery_retried')).toBe(true);
      expect(mockCreateEscalation).not.toHaveBeenCalled();
    });

    it('builds the catalog once per cycle iteration, shared by the advisor and the classification', async () => {
      const builds = (service as unknown as { buildToolsSchema: jest.Mock }).buildToolsSchema;
      // Baseline: what the loop builds on its own with no recovery at all.
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: true, result: { ok: 1 } }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { done: true } }]);
      await run(STEPS);
      const baseline = builds.mock.calls.length;
      builds.mockClear();
      mockExecuteToolCalls.mockReset();

      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'vendor down' }])
        .mockResolvedValueOnce([{ id: 'a', success: true, result: { ok: 1 } }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { done: true } }]);
      mockAdvise
        .mockResolvedValueOnce(continueWith([call('crm', 'delete_record')]))
        .mockResolvedValueOnce(continueWith([call('gmail-aaa', 'send')]));

      await run(STEPS);

      // Two advisor rounds add exactly two builds: one each, not one for the
      // advisor and another for the classification.
      expect(mockAdvise).toHaveBeenCalledTimes(2);
      expect(builds).toHaveBeenCalledTimes(baseline + 2);
      // ...and the advisor was handed the catalog the classification used.
      expect(mockAdvise.mock.calls[0][8]).toBe(CATALOG);
      expect(mockAdvise.mock.calls[1][8]).toBe(CATALOG);
    });

    it('a second rejected proposal on the same step escalates recovery_out_of_scope:<stepId>', async () => {
      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: false, error: 'vendor down' }]);
      mockAdvise
        .mockResolvedValueOnce(continueWith([call('crm', 'delete_record')]))
        .mockResolvedValueOnce(continueWith([call('gmail-bbb', 'send')]));

      const result = await run(STEPS);

      expect(result.escalated).toBe(true);
      expect(result.terminalState).toBe('escalated');
      expect(result.error).toContain('gmail-bbb__send');
      expect(mockAdvise).toHaveBeenCalledTimes(2);
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);
      expect(mockCreateEscalation).toHaveBeenCalledTimes(1);
      expect(mockCreateEscalation.mock.calls[0][2]).toEqual({
        kind: 'system_internal',
        fingerprint: 'recovery_out_of_scope:s1',
        instructionVersion: 4,
      });
      // The cost side of the rule is a counter, so the observation needs no
      // reading of events unless this is non-zero.
      expect(mockLogger.info.mock.calls.map((c) => c[0]).filter((o) => o?.metric === 'hybrid_loop.recovery_out_of_scope'))
        .toEqual([expect.objectContaining({ step_id: 's1' })]);
    });

    it('an unresolved call is rejected too, by its formatted name', async () => {
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'vendor down' }])
        .mockResolvedValueOnce([{ id: 'a', success: true, result: { ok: 1 } }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { done: true } }]);
      mockAdvise
        .mockResolvedValueOnce(continueWith([call('gmail-zzz', 'send')]))
        .mockResolvedValueOnce(continueWith([call('gmail-aaa', 'send')]));

      await run(STEPS);

      const anomaly = mockAdvise.mock.calls[1][3] as AnomalyContext;
      expect(anomaly).toMatchObject({ kind: 'recovery_proposal_rejected', rejected: ['gmail-zzz__send'] });
      expect(auditProposedTools()[0]).toEqual(['gmail-zzz__send']);
    });

    it('with the flag off the same mixed proposal dispatches unchanged', async () => {
      delete process.env.TR_RECOVERY_SCOPE_ENFORCE;
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'vendor down' }])
        .mockResolvedValueOnce([{ id: 'a', success: true, result: { ok: 1 } }, { id: 'b', success: true, result: { ok: 2 } }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { done: true } }]);
      mockAdvise.mockResolvedValueOnce(continueWith([call('gmail-aaa', 'send'), call('crm', 'delete_record')]));

      const result = await run(STEPS);

      expect(result.success).toBe(true);
      expect(mockAdvise).toHaveBeenCalledTimes(1);
      expect(mockExecuteToolCalls.mock.calls[1][1]).toHaveLength(2);
      expect(mockCreateEscalation).not.toHaveBeenCalled();
    });
  });

  describe('B.3.1d — narrow the prompt', () => {
    const invoke = () => {
      const state = makeState(GRAPH);
      const step = GRAPH[0];
      return (service as unknown as Svc).invokeRecoveryLLM(state, step, undefined, { kind: 'tool_error', step, error: 'boom' }, [], 0, 0);
    };

    it('under the flag the advisor\'s tools are the allowed set plus the recovery tool', async () => {
      process.env.TR_RECOVERY_SCOPE_ENFORCE = '1';
      mockComplete.mockResolvedValue({ content: '', toolCalls: [], usage: {} });
      await invoke();
      const request = mockComplete.mock.calls[0][0] as { tools: Array<{ name: string }> };
      expect(request.tools.map((t) => t.name)).toEqual([
        ...allowedRecoveryTools(GRAPH, CATALOG).map((t) => t.name),
        'recovery_decision',
      ]);
      expect(request.tools.map((t) => t.name)).not.toContain('gmail-bbb__send');
      expect(request.tools.map((t) => t.name)).not.toContain('crm__delete_record');
      delete process.env.TR_RECOVERY_SCOPE_ENFORCE;
    });

    it('with the flag off the full catalog is sent, as before', async () => {
      mockComplete.mockResolvedValue({ content: '', toolCalls: [], usage: {} });
      await invoke();
      const request = mockComplete.mock.calls[0][0] as { tools: Array<{ name: string }> };
      expect(request.tools.map((t) => t.name)).toEqual([...CATALOG.map((t) => t.name), 'recovery_decision']);
    });

    it('uses a catalog the caller already built rather than building another', async () => {
      mockComplete.mockResolvedValue({ content: '', toolCalls: [], usage: {} });
      const handed = [{ name: 'only__this', description: 'd', effect: 'read', categories: ['read'] }];
      const state = makeState(GRAPH);
      const step = GRAPH[0];
      await (service as unknown as Svc).invokeRecoveryLLM(
        state, step, undefined, { kind: 'tool_error', step, error: 'boom' }, [], 0, 0, undefined, handed,
      );
      const builds = (service as unknown as { buildToolsSchema: jest.Mock }).buildToolsSchema;
      expect(builds).not.toHaveBeenCalled();
      const request = mockComplete.mock.calls[0][0] as { tools: Array<{ name: string }> };
      expect(request.tools.map((t) => t.name)).toEqual(['only__this', 'recovery_decision']);
    });
  });
});
