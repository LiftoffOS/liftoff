/**
 * Integration tests for the hybrid execution engine.
 *
 * Strategy: real AgentExecutionService instance with the full constructor wiring,
 * with `getPoolForService` returning a query-recording mock pool so we can assert
 * the exact SQL + parameter shape every code path emits. Mocks `llmClient.complete`
 * so we control recovery / llm_reason / semantic-validation responses, and mocks
 * `enqueueAgentExecution` so we can observe what Cloud Task would have fired.
 *
 * Each test exercises one end-to-end flow through `runAgentHybridLoop` and
 * verifies the resulting (DB writes, Cloud Task enqueues, recovery decisions,
 * metric emissions, audit writes, agent-status transitions).
 */

import type { PoolClient } from 'pg';

// ── Module mocks ─────────────────────────────────────────────────────────

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
  streamingService: { emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
jest.mock('../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));

class MockHitlGateError extends Error {
  reason: string;
  pendingToolCalls: unknown[];
  matchedCategory?: string;
  constructor(toolCalls: unknown[], reason: string, matchedCategory?: string) {
    super('HITL gate: human approval required');
    this.name = 'HitlGateError';
    this.reason = reason;
    this.pendingToolCalls = toolCalls;
    this.matchedCategory = matchedCategory;
  }
}
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: { checkGate: jest.fn() },
  HitlGateError: MockHitlGateError,
  ModelTool: {},
}));

// llmClient.complete mock — controllable per-test
const llmCompleteMock = jest.fn();
jest.mock('../../llm/client', () => ({
  llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: llmCompleteMock, chat: jest.fn() },
}));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));

jest.mock('../../coordinator/service', () => ({
  CoordinatorService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../coordinator/dispatcher', () => ({
  getCoordinatorDispatcher: () => ({}),
}));
jest.mock('../../tool-gateway/service', () => ({
  ToolGatewayService: jest.fn().mockImplementation(() => ({
    setCredentialService: jest.fn(),
    routeToolCall: jest.fn(),
  })),
}));
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: () => ({}),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));

const updateRuntimeStatusMock = jest.fn();
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: updateRuntimeStatusMock,
    getAgent: jest.fn(),
  })),
}));

jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../usage-ledger/service', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({}),
}));
jest.mock('../../memory', () => ({
  memoryService: { retrieve: jest.fn(), save: jest.fn() },
  RetrievedMemory: {},
}));
jest.mock('../../invocations', () => ({
  invocationsService: { getMessages: jest.fn().mockResolvedValue([]) },
}));

const insertAuditLogMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../audit', () => ({ insertAuditLog: insertAuditLogMock }));
jest.mock('../../audit/service', () => ({ insertAuditLog: insertAuditLogMock }));

jest.mock('../tool-interceptor', () => ({
  interceptToolCalls: jest.fn(calls => calls),
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifests: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({
  executeStandardTool: jest.fn(),
}));

// Cloud Tasks: capture what would have been enqueued
const enqueueAgentExecutionMock = jest.fn().mockResolvedValue({ taskName: 'mock-task' });
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: enqueueAgentExecutionMock,
}));

// Query-recording pool with transaction support. Every BEGIN/COMMIT/ROLLBACK +
// every parameterised query is recorded so tests can assert the full DB script.
type QueryRecord = { sql: string; params?: unknown[] };
const dbCalls: QueryRecord[] = [];

interface QueryResponder {
  (sql: string, params?: unknown[]): { rows: unknown[]; rowCount?: number };
}
let responder: QueryResponder = () => ({ rows: [], rowCount: 0 });

function makeMockClient(): PoolClient {
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      dbCalls.push({ sql, params });
      return responder(sql, params);
    }),
    release: jest.fn(),
  };
  return client as unknown as PoolClient;
}

const mockPool = {
  query: jest.fn(async (sql: string, params?: unknown[]) => {
    dbCalls.push({ sql, params });
    return responder(sql, params);
  }),
  connect: jest.fn(async () => makeMockClient()),
};

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => mockPool),
  getPool: jest.fn(() => mockPool),
}));

// agentScheduledInvocationsRepo mock for updateCloudTaskName + markFiredByInvocationId
const updateCloudTaskNameMock = jest.fn().mockResolvedValue(undefined);
const markFiredByInvocationIdMock = jest.fn().mockResolvedValue(1);
const markErroredMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {
    updateCloudTaskName: updateCloudTaskNameMock,
    markFiredByInvocationId: markFiredByInvocationIdMock,
    markErrored: markErroredMock,
  },
  // The mapRow export is consumed by createClarificationPause when it constructs
  // the row from the local transaction's RETURNING — provide a stub.
  mapRow: (row: Record<string, unknown>) => ({ id: row.id }),
}));

// ── Imports under test ──────────────────────────────────────────────────

import { AgentExecutionService } from '../service';
import { OutputShapeMismatchError, AnomalousValueError } from '../types';
import type { ExecutionState, WorkflowStep } from '../types';
import { noteToolOutcome } from '../../tool-gateway/capability-outcome-signal';

// ── Test fixtures ────────────────────────────────────────────────────────

function makeState(overrides: Partial<{
  workflowSteps: WorkflowStep[];
  workflowStepsHash: string;
  hitlLevel: number;
  threadId: string;
  invocationId: string;
  execConfig: { maxToolCalls?: number; timeoutMs?: number };
  modelConfig: { modelId?: string; tier?: string; provider?: string };
}>): ExecutionState {
  return {
    context: {
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      workflowId: 'wf-1',
      taskId: 'task-1',
      instructionVersion: 1,
      instruction: { systemPrompt: 'test', tools: [], guardrails: [] } as unknown as ExecutionState['context']['instruction'],
      traceId: 'trace-1',
      agentType: 'agent',
      hitlLevel: overrides.hitlLevel ?? 0,
      modelConfig: (overrides.modelConfig ?? {}) as ExecutionState['context']['modelConfig'],
      execConfig: overrides.execConfig ?? {},
      memoryScope: {},
      workflowSteps: overrides.workflowSteps,
      workflowStepsHash: overrides.workflowStepsHash,
      threadId: overrides.threadId ?? 'thread-1',
      invocationId: overrides.invocationId ?? 'inv-1',
    },
    reasoningSteps: 0,
    toolCallsExecuted: 0,
    startTime: new Date(),
    steps: [],
    conversationHistory: [],
    pendingToolCalls: [],
    completedToolCalls: [],
    toolFailureCounts: new Map(),
    injectedSkillIds: [],
  };
}

function findCall(predicate: (sql: string) => boolean): QueryRecord | undefined {
  return dbCalls.find(c => predicate(c.sql));
}
function findAllCalls(predicate: (sql: string) => boolean): QueryRecord[] {
  return dbCalls.filter(c => predicate(c.sql));
}

// ── Suite ────────────────────────────────────────────────────────────────

describe('Hybrid execution engine — integration', () => {
  let service: AgentExecutionService;
  let executeToolCallsMock: jest.Mock;
  let createEscalationMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    dbCalls.length = 0;
    loggerCalls.info.length = 0;
    loggerCalls.warn.length = 0;
    loggerCalls.error.length = 0;
    responder = () => ({ rows: [], rowCount: 0 });

    service = new AgentExecutionService();
    executeToolCallsMock = jest.fn();
    createEscalationMock = jest.fn().mockResolvedValue('escalation-uuid');
    (service as unknown as { executeToolCalls: jest.Mock }).executeToolCalls =
      executeToolCallsMock;
    (service as unknown as { buildToolsSchema: jest.Mock }).buildToolsSchema =
      jest.fn().mockResolvedValue([]);
  });

  // ── T1: cursor walk happy path ─────────────────────────────────────────

  it('T1: empty workflowSteps routes to the adapter-driven conversational path', async () => {
    // No workflowSteps → runConversationalTurnsViaAdapter should be called.
    const state = makeState({});
    const conversationalTurnsMock = jest.fn().mockResolvedValue({
      success: true,
      toolCallsExecuted: 0,
      reasoningSteps: 1,
    });
    (service as unknown as { runConversationalTurnsViaAdapter: jest.Mock }).runConversationalTurnsViaAdapter =
      conversationalTurnsMock;
    const stubAdapter = {
      kind: 'anthropic',
      invoke: jest.fn(),
      registerToolCatalog: jest.fn(),
      registerHitlGate: jest.fn(),
      registerAnomalyHandler: jest.fn(),
    };

    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d: unknown, r: unknown, a: unknown) => Promise<unknown>;
    }).runAgentHybridLoop(state, 'test-objective', undefined, undefined, stubAdapter);

    expect(conversationalTurnsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, toolCallsExecuted: 0, reasoningSteps: 1 });
  });

  it('T2: tool_call cursor walk advances through 2 steps and extracts outputField', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Step 1', type: 'tool_call', toolName: 'slack__send_message',
        toolInput: { msg: 'hello' }, outputField: 'id', onSuccess: 's2' },
      { stepId: 's2', description: 'Step 2', type: 'tool_call', toolName: 'slack__send_message',
        toolInput: { msg: 'world' } },
    ];
    executeToolCallsMock
      .mockResolvedValueOnce([{ id: '1', success: true, result: { id: 'msg-1', ts: 1 } }])
      .mockResolvedValueOnce([{ id: '2', success: true, result: { ok: true } }]);

    const state = makeState({ workflowSteps: steps });
    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{
        success: boolean; output?: unknown; toolCallsExecuted: number;
      }>;
    }).runAgentHybridLoop(state, 'test-objective');

    expect(result.success).toBe(true);
    expect(executeToolCallsMock).toHaveBeenCalledTimes(2);
    // The cursor walk emits hybrid_loop.step_executed metric per step
    const metricLogs = loggerCalls.info.filter(c => {
      const payload = c[0] as { metric?: string };
      return payload?.metric === 'hybrid_loop.step_executed';
    });
    expect(metricLogs.length).toBeGreaterThanOrEqual(2);
  });

  // ── T3: recovery LLM invoked on tool failure ───────────────────────────

  it('T3: tool failure invokes recovery LLM with purpose=agent_recovery', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Step 1', type: 'tool_call', toolName: 'flaky__op' },
    ];
    // Step 1 fails
    executeToolCallsMock.mockResolvedValueOnce([
      { id: '1', success: false, error: 'connector timeout' },
    ]);
    // Recovery LLM returns decision=fail (terminate with a known reason)
    llmCompleteMock.mockResolvedValueOnce({
      content: 'I cannot recover from this',
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    // parseRecoveryDecision is private; stub to return controlled decision
    (service as unknown as { parseRecoveryDecision: jest.Mock }).parseRecoveryDecision =
      jest.fn().mockReturnValue({
        thinking: 'tried and failed',
        decision: 'fail',
        toolCalls: [],
        failureReason: 'connector timeout — unrecoverable',
      });

    const state = makeState({ workflowSteps: steps });
    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{
        success: boolean; error?: string; escalated?: boolean;
      }>;
    }).runAgentHybridLoop(state, 'test-objective');

    expect(llmCompleteMock).toHaveBeenCalledTimes(1);
    // Recovery LLM call must have purpose='agent_recovery'
    const recoveryCallArgs = llmCompleteMock.mock.calls[0];
    const usageContext = recoveryCallArgs[2] as { purpose: string };
    expect(usageContext.purpose).toBe('agent_recovery');

    expect(result.success).toBe(false);
    expect(result.error).toBe('connector timeout — unrecoverable');
  });

  // ── T3b/T3c: §7.3 workflow permanent-error fast-escalate (class-aware) ──

  it('T3b: permanent auth_expired escalates WITHOUT a recovery-LLM turn', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Step 1', type: 'tool_call', toolName: 'salesforce__read_record' },
    ];
    executeToolCallsMock.mockResolvedValueOnce([
      { id: '1', success: false, error: 'token expired', errorCode: 'auth_expired', retryable: false, recovery: 'reconnect the connector' },
    ]);
    const escalationHelper = await import('../engine/escalation-helper');
    const createEscalationSpy = jest
      .spyOn(escalationHelper, 'createEscalation')
      .mockResolvedValue('escalation-uuid');

    const state = makeState({ workflowSteps: steps });
    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{
        success: boolean; escalated?: boolean; error?: string; escalationId?: string;
      }>;
    }).runAgentHybridLoop(state, 'test-objective');

    // Escalated with the classified recovery text as the reason...
    expect(result.escalated).toBe(true);
    expect(result.escalationId).toBe('escalation-uuid');
    expect(result.error).toContain('auth_expired');
    // ...and the recovery LLM was NEVER invoked (the whole point of the fast-escalate).
    expect(llmCompleteMock).not.toHaveBeenCalled();
    expect(createEscalationSpy).toHaveBeenCalledTimes(1);
    createEscalationSpy.mockRestore();
  });

  it('T3c: permanent invalid_arguments STILL invokes recovery (class-aware — LLM can re-arg)', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Step 1', type: 'tool_call', toolName: 'salesforce__create_record' },
    ];
    executeToolCallsMock.mockResolvedValueOnce([
      { id: '1', success: false, error: 'bad field', errorCode: 'invalid_arguments', retryable: false, recovery: 'fix the arguments' },
    ]);
    llmCompleteMock.mockResolvedValueOnce({ content: 'x', toolCalls: [], usage: {} });
    (service as unknown as { parseRecoveryDecision: jest.Mock }).parseRecoveryDecision =
      jest.fn().mockReturnValue({ thinking: '', decision: 'fail', toolCalls: [], failureReason: 'bad field' });

    const state = makeState({ workflowSteps: steps });
    await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<unknown>;
    }).runAgentHybridLoop(state, 'test-objective');

    // invalid_arguments is NOT in the fast-escalate set → recovery LLM fires.
    expect(llmCompleteMock).toHaveBeenCalledTimes(1);
  });

  // ── T4: recovery cap exhaustion → system_internal escalation ───────────

  it('T4: total recovery cap (>20) trips kind=system_internal escalation', async () => {
    // Long workflow where every step fails and the recovery LLM always says
    // 'continue' (advance forward). The per-step cap stays at 1 each, but the
    // total cap (totalRecoveries > 20) trips on the 21st failure.
    //
    // We resume with totalRecoveries=20 so a single failure tips it over —
    // both shorter for the test and exercises the resume-state hydration.
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Always fails', type: 'tool_call', toolName: 'bad__op' },
    ];
    executeToolCallsMock.mockResolvedValueOnce([
      { id: '1', success: false, error: 'persistent failure' },
    ]);

    // Inject createEscalation mock at the module boundary
    const escalationHelper = await import('../engine/escalation-helper');
    const createEscSpy = jest
      .spyOn(escalationHelper, 'createEscalation')
      .mockResolvedValue('escalation-uuid');

    // Pre-stuffed resume state to put us right at the cap boundary.
    const resumeState = {
      kind: 'hybrid-pause' as const,
      pauseReason: 'delay' as const, // delay preserves counters (vs ask_user resets them)
      currentStepId: 's1',
      resumeAfterStepId: 's1',
      stepOutput: undefined,
      inputData: undefined,
      perStepRecoveries: {},
      totalRecoveries: 20,
      recoveryHistory: [],
    };

    const state = makeState({ workflowSteps: steps });
    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d: unknown, r: unknown) => Promise<{
        success: boolean; escalated?: boolean; error?: string; escalationId?: string;
      }>;
    }).runAgentHybridLoop(state, 'test-objective', undefined, resumeState);

    expect(result.escalated).toBe(true);
    expect(result.error).toBe('recovery_cap_exhausted');
    expect(result.escalationId).toBe('escalation-uuid');

    // createEscalation invoked with kind='system_internal' (operator inbox only)
    expect(createEscSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.stringContaining('Recovery cap exhausted'),
      // Keyed on the step and the graph version, so a second exhaustion on
      // the same step of the same graph merges and a repaired graph starts
      // fresh (escalation-helper.ts).
      { kind: 'system_internal', fingerprint: 'recovery_cap:s1', instructionVersion: 1 },
    );

    // recovery_cap_exhausted metric emitted with scope=per_invocation
    const capMetric = loggerCalls.info.find(c => {
      const p = c[0] as { metric?: string; scope?: string };
      return p?.metric === 'hybrid_loop.recovery_cap_exhausted';
    });
    expect(capMetric).toBeDefined();
    expect((capMetric![0] as { scope: string }).scope).toBe('per_invocation');

    createEscSpy.mockRestore();
  });

  // ── T5: ask_user step persists clarification pause atomically ──────────

  it('T5: ask_user step inserts message + scheduled invocation transactionally + enqueues Cloud Task', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Ask user', type: 'ask_user', question: 'Which sheet?' },
    ];
    // Mock the transaction inserts: thread upsert returns the existing thread,
    // message insert + scheduled-row insert succeed.
    responder = (sql: string) => {
      if (sql.includes('INSERT INTO threads')) {
        return { rows: [{ id: 'new-thread-uuid' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO messages')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO agent_scheduled_invocations')) {
        return { rows: [{ id: 'scheduled-row-uuid' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    // No threadId on the state — forces a new-thread insert (D18).
    // (`makeState({threadId: undefined})` falls through to the default via `??`,
    // so override the field directly after construction.)
    const state = makeState({ workflowSteps: steps });
    state.context.threadId = undefined;

    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{
        success: boolean; paused?: boolean; pausedAtStepId?: string;
      }>;
    }).runAgentHybridLoop(state, 'test-objective');

    expect(result.paused).toBe(true);
    expect(result.pausedAtStepId).toBe('s1');

    // Transaction discipline: BEGIN before any INSERT, COMMIT after the last.
    const beginIdx = dbCalls.findIndex(c => c.sql.trim() === 'BEGIN');
    const commitIdx = dbCalls.findIndex(c => c.sql.trim() === 'COMMIT');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);

    // Thread created with execution_path='interactive', initiated_by_type='agent'
    const threadInsert = findCall(s => s.includes('INSERT INTO threads'));
    expect(threadInsert).toBeDefined();
    expect(threadInsert!.sql).toContain("'agent'");
    expect(threadInsert!.sql).toContain("'interactive'");

    // Message insert with role='assistant'
    const messageInsert = findCall(s => s.includes('INSERT INTO messages'));
    expect(messageInsert).toBeDefined();
    expect(messageInsert!.sql).toContain("'assistant'");
    const messageParams = messageInsert!.params as unknown[];
    expect(messageParams).toContain('Which sheet?');

    // Scheduled invocation row with context_ref='clarification:...', objective='clarification-expiry'
    const scheduledInsert = findCall(s => s.includes('INSERT INTO agent_scheduled_invocations'));
    expect(scheduledInsert).toBeDefined();
    const scheduledParams = scheduledInsert!.params as unknown[];
    expect(scheduledParams.some(p => typeof p === 'string' && p.startsWith('clarification:'))).toBe(true);
    expect(scheduledParams).toContain('clarification-expiry');

    // Cloud Task enqueued with kind='clarification-expiry' for 24h later
    expect(enqueueAgentExecutionMock).toHaveBeenCalledTimes(1);
    const enqueueCall = enqueueAgentExecutionMock.mock.calls[0][2] as {
      receiverPath: string; receiverBody: { workflowResume: { kind: string } };
      scheduleTime: Date;
    };
    expect(enqueueCall.receiverPath).toBe('/api/tasks/resume-execution');
    expect(enqueueCall.receiverBody.workflowResume.kind).toBe('clarification-expiry');
    const millisOut = enqueueCall.scheduleTime.getTime() - Date.now();
    expect(millisOut).toBeGreaterThan(23 * 3600 * 1000);
    expect(millisOut).toBeLessThan(25 * 3600 * 1000);

    // Agent lifecycle marked WAITING_FOR_HUMAN
    expect(updateRuntimeStatusMock).toHaveBeenCalledWith('agent-1', 'WAITING_FOR_HUMAN');

    // Audit row written
    const auditCall = insertAuditLogMock.mock.calls.find(c => {
      const entry = c[2] as { action: string };
      return entry.action === 'hybrid_clarification_posted';
    });
    expect(auditCall).toBeDefined();
  });

  // ── T6: ask_user resume prologue invokes recovery LLM with user_answered_clarification ──

  it('T6: resume from ask_user pause invokes recovery LLM with kind=user_answered_clarification', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Ask user', type: 'ask_user', question: 'Which sheet?', onSuccess: 's2' },
      { stepId: 's2', description: 'Append', type: 'tool_call', toolName: 'sheets__append',
        toolInput: { sheet: 'Sheet1' } },
    ];
    // The recovery LLM (during ask_user resume) returns decision=complete.
    llmCompleteMock.mockResolvedValueOnce({
      content: '', toolCalls: [], usage: {},
    });
    (service as unknown as { parseRecoveryDecision: jest.Mock }).parseRecoveryDecision =
      jest.fn().mockReturnValue({
        thinking: 'user said Sheet1',
        decision: 'complete',
        toolCalls: [],
        output: { acknowledged: true },
      });

    const resumeState = {
      kind: 'hybrid-pause' as const,
      pauseReason: 'ask_user' as const,
      currentStepId: 's1',
      resumeAfterStepId: 's1',
      stepOutput: undefined,
      inputData: { foo: 'bar' },
      perStepRecoveries: { s1: 0 },
      totalRecoveries: 0,
      recoveryHistory: [],
      pauseContext: { originalQuestion: 'Which sheet?', threadId: 'thread-1' },
    };
    const state = makeState({ workflowSteps: steps });
    (state.context as unknown as Record<string, unknown>).userAnswerForResume = 'Sheet1';

    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d: unknown, r: unknown) => Promise<{
        success: boolean; output?: unknown;
      }>;
    }).runAgentHybridLoop(state, 'clarification-resume', { foo: 'bar' }, resumeState);

    expect(llmCompleteMock).toHaveBeenCalledTimes(1);
    const recoveryCallArgs = llmCompleteMock.mock.calls[0];
    const usageContext = recoveryCallArgs[2] as { purpose: string };
    expect(usageContext.purpose).toBe('agent_recovery');

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ acknowledged: true });
  });

  // ── T7: HitlGateError → createHitlPause ───────────────────────────────

  it('T7: HitlGateError raised during executeToolStep persists hitl pause + WAITING_FOR_HUMAN', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Sensitive op', type: 'tool_call', toolName: 'admin__delete' },
    ];
    // executeToolCalls throws HitlGateError (which now propagates from executeToolStep)
    executeToolCallsMock.mockRejectedValueOnce(
      new MockHitlGateError([], 'level_1_gate', 'admin'),
    );

    responder = (sql: string) => {
      if (sql.includes('INSERT INTO agent_scheduled_invocations')) {
        return { rows: [{ id: 'hitl-row-uuid' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const state = makeState({ workflowSteps: steps });
    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{
        success: boolean; paused?: boolean; pausedAtStepId?: string;
      }>;
    }).runAgentHybridLoop(state, 'test-objective');

    expect(result.paused).toBe(true);
    expect(result.pausedAtStepId).toBe('s1');

    // Scheduled row with context_ref='hitl:...', objective='hitl-expiry'
    const scheduledInsert = findCall(s => s.includes('INSERT INTO agent_scheduled_invocations'));
    expect(scheduledInsert).toBeDefined();
    const params = scheduledInsert!.params as unknown[];
    expect(params.some(p => typeof p === 'string' && p.startsWith('hitl:'))).toBe(true);
    expect(params).toContain('hitl-expiry');

    expect(updateRuntimeStatusMock).toHaveBeenCalledWith('agent-1', 'WAITING_FOR_HUMAN');
  });

  // ── T8: mid-execution interrupt → user_message_during_run anomaly ─────

  it('T8: pending signal at step boundary becomes user_message_during_run anomaly', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Step 1', type: 'tool_call', toolName: 'op__a',
        toolInput: {}, onSuccess: 's2' },
      { stepId: 's2', description: 'Step 2', type: 'tool_call', toolName: 'op__b',
        toolInput: {} },
    ];
    executeToolCallsMock.mockResolvedValueOnce([
      { id: '1', success: true, result: { done: 1 } },
    ]);

    // Two boundary checks — first returns no signal (start), second returns a signal (between steps)
    let signalCount = 0;
    responder = (sql: string) => {
      if (sql.includes('FROM agent_invocation_signals') && sql.includes('SELECT')) {
        signalCount++;
        if (signalCount === 2) {
          return { rows: [{ id: 'signal-uuid', payload: { text: 'wait, stop' } }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE agent_invocation_signals')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    // Recovery LLM responds with decision=fail (terminate after interrupt)
    llmCompleteMock.mockResolvedValueOnce({ content: '', toolCalls: [], usage: {} });
    (service as unknown as { parseRecoveryDecision: jest.Mock }).parseRecoveryDecision =
      jest.fn().mockReturnValue({
        thinking: 'user said stop',
        decision: 'fail',
        toolCalls: [],
        failureReason: 'User interrupted with stop',
      });

    const state = makeState({ workflowSteps: steps });
    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{
        success: boolean; error?: string;
      }>;
    }).runAgentHybridLoop(state, 'test-objective');

    expect(result.success).toBe(false);
    expect(result.error).toBe('User interrupted with stop');

    // Recovery LLM was called with purpose=agent_recovery (interrupt routed via the recovery path)
    expect(llmCompleteMock).toHaveBeenCalledTimes(1);
    expect(llmCompleteMock.mock.calls[0][2]).toMatchObject({ purpose: 'agent_recovery' });

    // The signal was marked consumed
    const consumeCall = findCall(s => s.includes('UPDATE agent_invocation_signals'));
    expect(consumeCall).toBeDefined();

    // anomaly_triggered metric was emitted with anomaly_kind=user_message_during_run
    const anomalyMetric = loggerCalls.info.find(c => {
      const p = c[0] as { metric?: string; anomaly_kind?: string };
      return p?.metric === 'hybrid_loop.anomaly_triggered' && p?.anomaly_kind === 'user_message_during_run';
    });
    expect(anomalyMetric).toBeDefined();
  });

  // ── T8b: pending ABORT signal at step boundary → stopped, no recovery ─

  it('T8b: pending abort signal stops the run without a recovery-LLM turn', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Step 1', type: 'tool_call', toolName: 'op__a',
        toolInput: {}, onSuccess: 's2' },
      { stepId: 's2', description: 'Step 2', type: 'tool_call', toolName: 'op__b',
        toolInput: {} },
    ];
    executeToolCallsMock.mockResolvedValue([
      { id: '1', success: true, result: { done: 1 } },
    ]);

    responder = (sql: string) => {
      // The abort claim is an UPDATE whose subquery filters signal_kind='abort'.
      if (sql.includes("signal_kind = 'abort'")) {
        return { rows: [{ id: 'abort-signal-uuid' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const state = makeState({ workflowSteps: steps });
    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{
        success: boolean; stopped?: boolean; terminalState?: string; output?: unknown;
      }>;
    }).runAgentHybridLoop(state, 'test-objective');

    expect(result.success).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.terminalState).toBe('stopped');
    // No invented reply: a turn stopped before it said anything has no output,
    // and `stopped` is what says so. The marker string used to end up in the
    // person's transcript as something the agent had said.
    expect(result.output).toBe('');
    // Abort bypasses the recovery LLM entirely — the user asked for an end,
    // not a redirect.
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });

  // ── T9: workflow_steps_hash mismatch fails the run with no recovery ───

  it('T9: workflow_steps_hash mismatch returns success:false with no LLM call (D20)', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Step 1', type: 'tool_call', toolName: 'op__a' },
    ];
    // Stub computeWorkflowStepsHash to return a known value, then provide a
    // mismatching workflowStepsHash on the context.
    (service as unknown as { computeWorkflowStepsHash: jest.Mock }).computeWorkflowStepsHash =
      jest.fn().mockReturnValue('actual-hash');
    const state = makeState({
      workflowSteps: steps,
      workflowStepsHash: 'expected-but-different-hash',
    });

    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{
        success: boolean; error?: string;
      }>;
    }).runAgentHybridLoop(state, 'test-objective');

    expect(result.success).toBe(false);
    expect(result.error).toContain('tampered');
    expect(llmCompleteMock).not.toHaveBeenCalled();
    expect(executeToolCallsMock).not.toHaveBeenCalled();
  });

  // ── T10: error mapping covers OutputShapeMismatchError + AnomalousValueError ──

  it('T10: AnomalousValueError + OutputShapeMismatchError instances are catch-friendly', () => {
    const step: WorkflowStep = { stepId: 's1', description: 'd', type: 'tool_call', toolName: 't' };
    const shapeErr = new OutputShapeMismatchError(step, { wrong: 'shape' });
    const valueErr = new AnomalousValueError(step, 'bad', 'looks-bogus');

    expect(shapeErr).toBeInstanceOf(Error);
    expect(shapeErr.name).toBe('OutputShapeMismatchError');
    expect(shapeErr.step).toBe(step);
    expect(shapeErr.received).toEqual({ wrong: 'shape' });

    expect(valueErr).toBeInstanceOf(Error);
    expect(valueErr.name).toBe('AnomalousValueError');
    expect(valueErr.value).toBe('bad');
    expect(valueErr.reason).toBe('looks-bogus');
  });

  // ── T11: a capability step runs as a structured invokeStepLLM micro-turn ──
  //
  // The branch resolves the call args, synthesizes an llm_reason step whose
  // description directs capability_search → run_capability (so the adapter's
  // canUseTool gate — item 9 — sees the write-class pause), and extracts
  // outputField from what invokeStepLLM returns. Mocking invokeStepLLM pins the
  // branch's own logic: routing, the synthesized prompt, and outputField.
  it('T11: capability step invokes invokeStepLLM with a synthesized capability prompt and extracts outputField', async () => {
    const steps: WorkflowStep[] = [
      {
        stepId: 's1',
        description: 'Text the customer their update',
        type: 'capability',
        capabilityNeed: { operation: 'send text message', entity: 'message', mode: 'own_account' },
        toolInput: { to: '+14155551234', body: 'shipped' },
        outputField: 'status',
      },
    ];
    // The turn's run_capability answered: noted into the step's outcome
    // window the way the handler notes it, so the step ends on this one turn
    // (a turn with nothing useful gets a web-only second turn — see
    // capability-step-web-fallback.test.ts).
    const invokeStepLLMMock = jest.fn().mockImplementation(async (state: ExecutionState) => {
      noteToolOutcome(state.context.invocationId, 'run_capability', true);
      return { output: { messageId: 'm1', status: 'sent' } };
    });
    (service as unknown as { invokeStepLLM: jest.Mock }).invokeStepLLM = invokeStepLLMMock;

    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{ success: boolean; output?: unknown }>;
    }).runAgentHybridLoop(makeState({ workflowSteps: steps }), 'test-objective');

    expect(result.success).toBe(true);
    expect(invokeStepLLMMock).toHaveBeenCalledTimes(1);
    const passedStep = invokeStepLLMMock.mock.calls[0][1] as WorkflowStep;
    // Routed as a structured llm_reason micro-turn built from the need + args.
    expect(passedStep.type).toBe('llm_reason');
    expect(passedStep.description).toContain('capability_search');
    expect(passedStep.description).toContain('run_capability');
    expect(passedStep.description).toContain('"send text message"');
    expect(passedStep.description).toContain('"+14155551234"');
    // outputField extracted from invokeStepLLM's return.
    expect(result.output).toBe('sent');
  });

  // ── T11c: a reasoning step is told which step is its predecessor ──────
  //
  // The earlier-outputs section of a reasoning step's prompt excludes the
  // predecessor by id, never by value: an exclusion by value mistook any
  // earlier step whose value happened to equal the predecessor's for the
  // predecessor itself. So the loop hands invokeStepLLM the id of the step
  // whose output `stepOutput` holds — captured at the loop head, before the
  // cursor advances to the current step — and the run's one view memo, the
  // same Map on every call in this loop invocation.
  it('T11c: a reasoning step receives its predecessor\'s id and the run\'s shared view memo', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Step 1', type: 'tool_call', toolName: 'slack__send_message',
        toolInput: { msg: 'hello' }, onSuccess: 's2' },
      { stepId: 's2', description: 'Judge s1', type: 'llm_reason', onSuccess: 's3' },
      { stepId: 's3', description: 'Judge s1 and s2', type: 'llm_reason' },
    ];
    // s1 and s2 produce the SAME value on purpose.
    executeToolCallsMock.mockResolvedValueOnce([{ id: '1', success: true, result: 'same' }]);
    // The registry is one mutable object for the whole loop, so what each call
    // SAW is copied at call time rather than read back afterwards.
    const registrySeen: Array<Record<string, unknown>> = [];
    const invokeStepLLMMock = jest.fn().mockImplementation(async (...a: unknown[]) => {
      registrySeen.push({ ...(a[6] as Record<string, unknown>) });
      return { output: 'same' };
    });
    (service as unknown as { invokeStepLLM: jest.Mock }).invokeStepLLM = invokeStepLLMMock;

    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{ success: boolean }>;
    }).runAgentHybridLoop(makeState({ workflowSteps: steps }), 'test-objective');

    expect(result.success).toBe(true);
    expect(invokeStepLLMMock).toHaveBeenCalledTimes(2);
    const [, s2Step, s2Prior, , , , , s2PriorId, s2Memo] = invokeStepLLMMock.mock.calls[0] as unknown[];
    const [, s3Step, s3Prior, , , , , s3PriorId, s3Memo] = invokeStepLLMMock.mock.calls[1] as unknown[];
    expect((s2Step as WorkflowStep).stepId).toBe('s2');
    expect(s2PriorId).toBe('s1');
    expect(s2Prior).toBe('same');
    expect((s3Step as WorkflowStep).stepId).toBe('s3');
    expect(s3PriorId).toBe('s2');
    expect(s3Prior).toBe('same');
    // Both equal-valued outputs are in the registry s3 is handed, under their own ids.
    expect(registrySeen[0]).toEqual({ s1: 'same' });
    expect(registrySeen[1]).toEqual({ s1: 'same', s2: 'same' });
    // One memo for the loop invocation, shared by every reasoning step in it.
    expect(s2Memo).toBeInstanceOf(Map);
    expect(s3Memo).toBe(s2Memo);
  });

  // ── T11d: an unsatisfied predecessor does not own the value ──────────
  //
  // s2 fails and recovery advances past it without producing its output, so
  // `stepOutput` still holds s1's value. The id handed to the reasoning step
  // must be s1 — the step the value came from — not s2, the step the cursor
  // last left. With s2 named, the section would carry s1's value a second time
  // beside the predecessor rendering, and s2 (which registered nothing) would
  // be the id excluded.
  it('T11d: a reasoning step after an unsatisfied step is told the value\'s real owner', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'Step 1', type: 'tool_call', toolName: 'slack__send_message',
        toolInput: { msg: 'hello' }, onSuccess: 's2' },
      { stepId: 's2', description: 'Step 2', type: 'tool_call', toolName: 'flaky__op',
        toolInput: { msg: 'x' }, onSuccess: 's3' },
      { stepId: 's3', description: 'Judge s1', type: 'llm_reason' },
    ];
    executeToolCallsMock
      .mockResolvedValueOnce([{ id: '1', success: true, result: 'first' }])
      .mockResolvedValueOnce([{ id: '2', success: false, error: 'connector timeout' }]);
    // Recovery: continue past s2 with no corrective call and no output.
    llmCompleteMock.mockResolvedValueOnce({ content: 'skip it', toolCalls: [], usage: {} });
    (service as unknown as { parseRecoveryDecision: jest.Mock }).parseRecoveryDecision =
      jest.fn().mockReturnValue({ thinking: 'skip', decision: 'continue', toolCalls: [], nextStepId: 's3' });
    const registrySeen: Array<Record<string, unknown>> = [];
    const invokeStepLLMMock = jest.fn().mockImplementation(async (...a: unknown[]) => {
      registrySeen.push({ ...(a[6] as Record<string, unknown>) });
      return { output: 'judged' };
    });
    (service as unknown as { invokeStepLLM: jest.Mock }).invokeStepLLM = invokeStepLLMMock;

    await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{ success: boolean }>;
    }).runAgentHybridLoop(makeState({ workflowSteps: steps }), 'test-objective');

    expect(invokeStepLLMMock).toHaveBeenCalledTimes(1);
    const [, s3Step, s3Prior, , , , , s3PriorId] = invokeStepLLMMock.mock.calls[0] as unknown[];
    expect((s3Step as WorkflowStep).stepId).toBe('s3');
    expect(s3Prior).toBe('first');
    expect(s3PriorId).toBe('s1');
    // s2 registered nothing; s1's value is in the registry under s1 alone.
    expect(registrySeen[0]).toEqual({ s1: 'first' });
  });

  it('T11b: a capability step missing capabilityNeed fails the step (recovery), does not silently no-op', async () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', description: 'broken', type: 'capability' },
    ];
    const invokeStepLLMMock = jest.fn();
    (service as unknown as { invokeStepLLM: jest.Mock }).invokeStepLLM = invokeStepLLMMock;
    // The thrown "missing capabilityNeed" routes to the recovery LLM; drive it to
    // a clean terminal fail (T3's pattern) so the run ends deterministically.
    llmCompleteMock.mockResolvedValueOnce({ content: 'cannot recover', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
    (service as unknown as { parseRecoveryDecision: jest.Mock }).parseRecoveryDecision =
      jest.fn().mockReturnValue({ thinking: 't', decision: 'fail', toolCalls: [], failureReason: 'capability step missing capabilityNeed' });

    const result = await (service as unknown as {
      runAgentHybridLoop: (s: ExecutionState, o: string, d?: unknown) => Promise<{ success: boolean }>;
    }).runAgentHybridLoop(makeState({ workflowSteps: steps }), 'test-objective');

    // The branch threw before dispatch — invokeStepLLM never ran, and the run did
    // not silently complete as a no-op.
    expect(invokeStepLLMMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});
