// The ONE consumption point, exercised through both resume strategies and
// the batch dispatch path.
//
// The governance_wal lesson: a control that is recorded on one of the paths a
// decision can take is a control with a list of exceptions nobody wrote down.
// So the same four properties are asserted on structured resume and on
// snapshot replay — the two ways an approved call is consumed — and the batch
// path is held to the grant it is handed:
//
//   (a) args mutated after approval        → re-asked, not dispatched
//   (b) a control tightened in between      → asked once about that control, then dispatched once
//   (c) duplicate delivery                  → one dispatch
//   (d) a policy read failing at consumption → deferred, grant intact

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Constructed BY ENGINE. `createAdapter` resolves from the environment and is
// the defect; a resume that reaches it has crossed engines.
const constructAdapterForEngineMock = jest.fn();
const createAdapterMock = jest.fn();
jest.mock('../adapter', () => ({
  createAdapter: (...a: unknown[]) => createAdapterMock(...a),
  constructAdapterForEngine: (...a: unknown[]) => constructAdapterForEngineMock(...a),
}));

const getApprovalRequestMock = jest.fn();
// A REAL hash, key-order independent, so a fingerprint mismatch is a real one.
const hashToolCallsMock = jest.fn((calls: Array<{ id: string; name: string; input: unknown }>) => {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return require('crypto').createHash('sha256').update(JSON.stringify(sort(calls.map((c) => ({ id: c.id, name: c.name, input: c.input }))))).digest('hex');
});
const obligationConfigForMock = jest.fn();
const enqueueResumeForHitlMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../scheduling/hitl-resume-helpers', () => ({ enqueueResumeForHitl: (...a: unknown[]) => enqueueResumeForHitlMock(...a) }));
const createApprovalRequestMock = jest.fn();
const getOversightSettingsMock = jest.fn();
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    getApprovalRequest: (...a: unknown[]) => getApprovalRequestMock(...a),
    getOversightSettings: (...a: unknown[]) => getOversightSettingsMock(...a),
    createApprovalRequest: (...a: unknown[]) => createApprovalRequestMock(...a),
    checkHitlGate: jest.fn().mockResolvedValue({ shouldGate: false }),
    hashToolCalls: (...a: unknown[]) => hashToolCallsMock(...a),
    // What the consumption point recomputes the grant against. Nothing asks
    // here by default, so a grant that covered nothing still covers the
    // current set; a case about a tightened control overrides it.
    obligationConfigFor: (...a: unknown[]) => obligationConfigForMock(...a),
  },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));

const queryMock = jest.fn();
const poolMock = {
  query: queryMock,
  connect: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
};
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
    getAgent: getAgentMock,
  })),
}));

jest.mock('../../audit', () => ({ insertAuditLog: jest.fn() }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../streaming', () => ({
  streamingService: {
    emitHitlRequired: jest.fn(), emitHitlRejected: jest.fn(), emitToolStart: jest.fn(), emitToolComplete: jest.fn(),
  },
}));
jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: jest.fn().mockReturnValue({
    execute: jest.fn(async () => ({ success: true, data: {} })),
    executeBatch: jest.fn(async (inputs: Array<{ id: string }>) => inputs.map((i) => ({ id: i.id, success: true, data: {} }))),
  }),
}));
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
jest.mock('../../invocations/service', () => ({ invocationsService: {} }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({ resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]) }));
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
  getPlatformCallbackClient: jest.fn(() => null),
  postSkillFeedback: jest.fn(),
  settleMcpChatRunViaCallback: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../tool-gateway/capability-approval-signal', () => ({
  recordCapabilityApproval: jest.fn(),
  capabilityApprovalKey: () => null,
  capabilityHandleNeedsApproval: () => false,
  consumeCapabilityApproval: jest.fn(),
}));
jest.mock('../../infrastructure/pubsub', () => ({ publisher: {} }));
jest.mock('../../interactive-chat/system-prompt', () => ({ getHitlDescription: jest.fn().mockReturnValue('') }));
jest.mock('../../connectors/connector-service-client', () => ({ getPrefetchThreadClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../infrastructure/safe-trace-context', () => ({ setTraceContext: jest.fn() }));
jest.mock('../../infrastructure/oidc', () => ({ verifyOidcToken: jest.fn().mockResolvedValue(true) }));

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

import express from 'express';
import request from 'supertest';
import { AgentExecutionService, agentExecutionService } from '../service';
import { cloudTasksHandler } from '../../handlers/cloud-tasks-handler';
import { finalCallsFor, reaskIdempotencyKey } from '../approval-consumption';
import { OBLIGATION_EVALUATOR_VERSION, type ObligationConfig } from '../../hitl-enforcement/approval-obligations';
import type { ExecutionContext, ExecutionState } from '../types';
import type { ModelTool, ToolCallRequest } from '../../hitl-enforcement/types';

const TENANT = 't1';
const AGENT = 'a1';
const INVOCATION = 'inv-1';
const SCHED = 'sched-1';

const TOOLS: ModelTool[] = [
  { name: 'gmail__send_email', description: '⚠️ DESTRUCTIVE Send', inputSchema: {}, effect: 'write', categories: ['customerCommunication'] } as ModelTool,
];
const PENDING: ToolCallRequest[] = [{ id: 'pc1', name: 'gmail__send_email', input: { to: 'x@y.com' } }];

type Strategy = 'structured_session' | 'snapshot_replay';

function payloadFor() {
  return {
    kind: 'hybrid-pause', pauseReason: 'hitl_approval', executionEngine: 'claude-agent-sdk',
    currentStepId: 'step-1', resumeAfterStepId: 'step-2', stepOutput: null,
    objective: 'Send the weekly status report', triggerKey: 'trig-1', inputData: {},
    perStepRecoveries: {}, totalRecoveries: 0, recoveryHistory: [],
    hitlContext: {
      approvalId: 'appr-1', pendingToolCalls: PENDING, gateReason: 'destructive_gate',
      provider: 'anthropic', model: 'claude-opus-4-8',
      conversationHistory: [{ role: 'user', content: 'send the email' }],
    },
  };
}

/** The pool as a live one would answer, remembering the row's status. */
function armPool(payload: Record<string, unknown>) {
  const row = { status: 'pending', fired: false, released: null as string | null };
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (typeof sql !== 'string') return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT workflow_resume_payload')) {
      return { rows: [{ workflow_resume_payload: payload, agent_id: AGENT, tenant_id: TENANT, fired_at: row.fired ? new Date() : null }], rowCount: 1 };
    }
    if (sql.includes("SET status = 'resume_inflight'")) {
      if (row.status !== 'pending') return { rows: [], rowCount: 0 };
      row.status = 'resume_inflight';
      return { rows: [{ id: SCHED, lease_token: 'lease-1' }], rowCount: 1 };
    }
    if (sql.includes("SET status = 'fired'")) {
      if (row.status !== 'resume_inflight') return { rows: [], rowCount: 0 };
      row.status = 'fired'; row.fired = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = 'pending'")) {
      row.status = 'pending'; row.released = (params?.[2] as string | null) ?? 'released';
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = 'errored'")) { row.status = 'errored'; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  });
  return row;
}

function approval(over: Record<string, unknown> = {}) {
  const { fingerprint } = finalCallsFor(PENDING, null);
  return {
    id: 'appr-1', tenantId: TENANT, agentId: AGENT, hitlLevel: 2, decision: 'approved', status: 'approved', decidedBy: 'user-1',
    pendingToolCalls: PENDING, toolCallsHash: hashToolCallsMock(PENDING), reason: 'destructive_gate',
    editedToolInputs: null, finalToolCallsHash: fingerprint,
    grantedObligations: ['destructive_gate'], obligationsEvaluatorVersion: OBLIGATION_EVALUATOR_VERSION,
    gateView: { tools: TOOLS },
    ...over,
  };
}

function baseConfig(over: Partial<ObligationConfig> = {}): ObligationConfig {
  return {
    hitlLevel: 2,
    oversight: { tenantId: TENANT, autonomy: 'balanced', escalation: 'sensitive', sensitiveWork: {}, communication: 'auto' },
    tools: TOOLS, standingPolicies: {}, ...over,
  };
}

function stubReconstitution(svc: AgentExecutionService) {
  (svc as unknown as { getActiveInstruction: (...a: unknown[]) => Promise<unknown> }).getActiveInstruction =
    jest.fn().mockResolvedValue({
      version: 1, instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' },
      integrations: [{ id: 'gmail', type: 'google_mail' }],
    });
  (svc as unknown as { loadRuntimeConfig: (...a: unknown[]) => Promise<unknown> }).loadRuntimeConfig =
    jest.fn().mockResolvedValue({ workflowSteps: [], modelConfig: { provider: 'anthropic' }, execConfig: {}, memoryScope: {}, hitlLevel: 2 });
  // The approved dispatch builds the continuation's catalog and routes each
  // approved call by its entry (approved-call-routing.ts); the fixture's call
  // is a gateway connector tool, so it takes the dispatcher path.
  (svc as unknown as { buildPlatformMcpCatalog: (...a: unknown[]) => Promise<unknown> }).buildPlatformMcpCatalog =
    jest.fn().mockResolvedValue({
      servers: [{ kind: 'in-process', id: 'liftoff-tool-gateway', config: {} }],
      tools: [{ name: 'gmail__send_email', inputSchema: {}, serverId: 'liftoff-tool-gateway', source: 'connector' }],
      deferredVendorTools: new Map(),
    });
}

/** Everything that DISPATCHES on either strategy, counted. */
function spyDispatch(svc: AgentExecutionService) {
  const seen = { loops: 0, executes: 0, armed: [] as unknown[], pauses: 0 };
  jest.spyOn(svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> }, 'runAgentHybridLoop')
    .mockImplementation(async (state: unknown) => {
      seen.loops += 1;
      const ctx = (state as ExecutionState).context;
      if (ctx.hitlResumeDecision) seen.armed.push(ctx.hitlResumeDecision.pending);
      return { success: true, toolCallsExecuted: 1, reasoningSteps: 1 };
    });
  jest.spyOn(svc as unknown as { executeToolCalls: (state: unknown, calls: Array<{ id: string }>) => Promise<unknown[]> }, 'executeToolCalls')
    .mockImplementation(async (_s, calls) => { seen.executes += 1; return calls.map((c) => ({ id: c.id, success: true, result: {} })); });
  jest.spyOn(svc as unknown as { createHitlPause: (...a: unknown[]) => Promise<unknown> }, 'createHitlPause')
    .mockImplementation(async () => { seen.pauses += 1; return { success: true, paused: true, pauseKind: 'hitl_approval', approvalId: 'appr-2', toolCallsExecuted: 0, reasoningSteps: 0 }; });
  return seen;
}

function armStrategy(strategy: Strategy) {
  if (strategy === 'structured_session') {
    mockIsAutonomousEnabled.mockReturnValue(true);
    mockLoadRunSession.mockResolvedValue({ sdkSessionId: 'sess-1', jsonlContent: '{}' });
  } else {
    mockIsAutonomousEnabled.mockReturnValue(false);
    mockLoadRunSession.mockResolvedValue(null);
  }
}

async function deliver() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', cloudTasksHandler);
  return request(app).post('/api/tasks/resume-execution').send({
    tenantId: TENANT, agentId: AGENT, invocationId: INVOCATION,
    workflowResume: { kind: 'hitl-approved', scheduledInvocationId: SCHED, invocationId: INVOCATION },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  getAgentMock.mockResolvedValue({ id: AGENT, lifecycle: 'ACTIVE', runtimeStatus: 'WAITING_FOR_HUMAN' });
  getOversightSettingsMock.mockResolvedValue({ communication: 'auto', sensitiveWork: {} });
  obligationConfigForMock.mockResolvedValue(baseConfig());
  createApprovalRequestMock.mockResolvedValue({ id: 'appr-2', expiresAt: new Date(Date.now() + 3600_000) });
  constructAdapterForEngineMock.mockImplementation((engine: string) => ({
    engine, registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(), registerAnomalyHandler: jest.fn(),
    invoke: jest.fn(), pause: jest.fn(), resume: jest.fn(),
  }));
});

describe.each<Strategy>(['structured_session', 'snapshot_replay'])('%s', (strategy) => {
  it('(a) args mutated after approval → re-asked, not dispatched', async () => {
    armStrategy(strategy);
    const row = armPool(payloadFor());
    // The edits on the row now produce calls the recorded fingerprint does not name.
    getApprovalRequestMock.mockResolvedValue(approval({ editedToolInputs: { pc1: { to: 'someone-else@y.com' } } }));
    stubReconstitution(agentExecutionService);
    const seen = spyDispatch(agentExecutionService);

    const res = await deliver();
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(true);
    // Asked again, idempotently, about the final calls.
    expect(createApprovalRequestMock).toHaveBeenCalledTimes(1);
    const ask = createApprovalRequestMock.mock.calls[0][0] as { idempotencyKey: string; pendingToolCalls: ToolCallRequest[]; reason: string };
    const { fingerprint } = finalCallsFor(PENDING, { pc1: { to: 'someone-else@y.com' } });
    expect(ask.idempotencyKey).toBe(reaskIdempotencyKey('appr-1', fingerprint));
    expect(ask.pendingToolCalls[0].input).toEqual({ to: 'someone-else@y.com' });
    expect(seen.pauses).toBe(1);
    // Nothing dispatched, under either strategy.
    expect(seen.loops).toBe(0);
    expect(seen.executes).toBe(0);
    // The old row is consumed by replacement: fired, never dispatched.
    expect(row.status).toBe('fired');
  });

  it('(b) a control tightened between approval and resume → asked once about that control, then dispatched once', async () => {
    armStrategy(strategy);
    const row = armPool(payloadFor());
    getApprovalRequestMock.mockResolvedValue(approval());
    // Sensitive-work review for the call's category was switched on in between.
    obligationConfigForMock.mockResolvedValue(baseConfig({
      oversight: { tenantId: TENANT, autonomy: 'balanced', escalation: 'sensitive', sensitiveWork: { customerCommunication: true }, communication: 'auto' },
    }));
    stubReconstitution(agentExecutionService);
    const seen = spyDispatch(agentExecutionService);

    const first = await deliver();
    expect(first.status).toBe(200);
    expect(createApprovalRequestMock).toHaveBeenCalledTimes(1);
    const ask = createApprovalRequestMock.mock.calls[0][0] as { reason: string; context: { uncoveredReasons: string[] } };
    // About that control only.
    expect(ask.reason).toBe('sensitive_work');
    expect(ask.context.uncoveredReasons).toEqual(['sensitive_work']);
    expect(seen.loops + seen.executes).toBe(0);
    expect(row.status).toBe('fired');

    // The person answers the new ask: a grant covering both reasons, on a
    // fresh pause row. Resumed under the same tightened settings.
    const row2 = armPool({ ...payloadFor(), hitlContext: { ...payloadFor().hitlContext, approvalId: 'appr-2' } });
    getApprovalRequestMock.mockResolvedValue(approval({ id: 'appr-2', grantedObligations: ['destructive_gate', 'sensitive_work'] }));
    createApprovalRequestMock.mockClear();
    const second = await deliver();
    expect(second.status).toBe(200);
    expect(createApprovalRequestMock).not.toHaveBeenCalled();
    // Dispatched exactly once, on whichever strategy ran.
    expect(seen.loops).toBe(1);
    if (strategy === 'snapshot_replay') expect(seen.executes).toBe(1);
    else expect(seen.armed).toHaveLength(1);
    expect(row2.status).toBe('fired');
  });

  it('(c) duplicate delivery → one dispatch', async () => {
    armStrategy(strategy);
    const row = armPool(payloadFor());
    getApprovalRequestMock.mockResolvedValue(approval());
    stubReconstitution(agentExecutionService);
    const seen = spyDispatch(agentExecutionService);

    const a = await deliver();
    const b = await deliver();
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.resumeNoop).toBe(true);
    expect(seen.loops).toBe(1);
    if (strategy === 'snapshot_replay') expect(seen.executes).toBe(1);
    expect(row.status).toBe('fired');
  });

  it('(d) a policy read failing at consumption → deferred, grant intact', async () => {
    armStrategy(strategy);
    const row = armPool(payloadFor());
    getApprovalRequestMock.mockResolvedValue(approval());
    obligationConfigForMock.mockRejectedValue(new Error('governance engine unreachable'));
    stubReconstitution(agentExecutionService);
    const seen = spyDispatch(agentExecutionService);

    enqueueResumeForHitlMock.mockClear();
    const res = await deliver();
    // Retryable, and nothing consumed: the row is back to pending, the grant
    // was not dispatched under and not replaced. The resume re-armed itself a
    // minute out and answered the queue as handled, so the queue's quick
    // retries do not spend the attempt budget against the same outage.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deferred: true, rearmed: expect.any(String) });
    expect(row.status).toBe('pending');
    expect(row.released).toContain('governance engine unreachable');
    expect(enqueueResumeForHitlMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hitl-approved', scheduleTime: expect.any(Date) }));
    expect(seen.loops + seen.executes + seen.pauses).toBe(0);
    expect(createApprovalRequestMock).not.toHaveBeenCalled();
    // The row was never fired, so the next delivery can claim it.
    expect(row.fired).toBe(false);
  });
});

// ── The batch dispatch path ────────────────────────────────────────────────
//
// `executeToolCalls` is where the snapshot path's approved calls actually run,
// and where a workflow's batched calls run. It skips the gate ONLY for a batch
// the grant covers; a batch the grant does not name is gated as new work.
describe('the batch dispatch path honours the grant it is handed', () => {
  function stateWith(grant: ExecutionContext['approvedGrant']): ExecutionState {
    const context: ExecutionContext = {
      tenantId: TENANT, agentId: AGENT, workflowId: '', taskId: '', instructionVersion: 0,
      instruction: { allowedConnectors: ['gmail'], systemPrompt: '', userInstructions: '' } as unknown as ExecutionContext['instruction'],
      traceId: 'tr', agentType: 'agent', hitlLevel: 2,
      modelConfig: {} as ExecutionContext['modelConfig'], execConfig: {} as ExecutionContext['execConfig'], memoryScope: {} as ExecutionContext['memoryScope'],
      oversight: { tenantId: TENANT, autonomy: 'balanced', escalation: 'sensitive', sensitiveWork: {}, communication: 'auto' } as ExecutionContext['oversight'],
      integrations: [{ id: 'gmail', type: 'google_mail' }] as unknown as ExecutionContext['integrations'],
      invocationId: INVOCATION,
      approvedGrant: grant,
    };
    return {
      context, reasoningSteps: 0, toolCallsExecuted: 0, startTime: new Date(), steps: [],
      conversationHistory: [], pendingToolCalls: [], completedToolCalls: [], toolFailureCounts: new Map(), injectedSkillIds: [],
    };
  }
  const batch = [{ id: 'pc1', connector: 'gmail', entityType: '', actionType: 'send_email', payload: { to: 'x@y.com' } }];

  beforeEach(() => {
    const { hitlEnforcementService } = jest.requireMock('../../hitl-enforcement') as { hitlEnforcementService: { checkHitlGate: jest.Mock } };
    hitlEnforcementService.checkHitlGate.mockClear();
    hitlEnforcementService.checkHitlGate.mockResolvedValue({ shouldGate: false });
  });

  it('a covering grant skips the gate for exactly its batch', async () => {
    const { hitlEnforcementService } = jest.requireMock('../../hitl-enforcement') as { hitlEnforcementService: { checkHitlGate: jest.Mock } };
    const { finalCalls, fingerprint } = finalCallsFor(PENDING, null);
    const svc = new AgentExecutionService();
    jest.spyOn(svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }, 'buildToolsSchema').mockResolvedValue([]);
    await (svc as unknown as { executeToolCalls: (s: ExecutionState, c: unknown[]) => Promise<unknown[]> })
      .executeToolCalls(stateWith({ approvalId: 'appr-1', finalCalls, fingerprint, routes: [] }), batch);
    expect(hitlEnforcementService.checkHitlGate).not.toHaveBeenCalled();
  });

  it('a grant that does not name the batch gates it as new work', async () => {
    const { hitlEnforcementService } = jest.requireMock('../../hitl-enforcement') as { hitlEnforcementService: { checkHitlGate: jest.Mock } };
    const other = finalCallsFor([{ id: 'pc9', name: 'gmail__send_email', input: { to: 'else@y.com' } }], null);
    const svc = new AgentExecutionService();
    jest.spyOn(svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }, 'buildToolsSchema').mockResolvedValue([]);
    await (svc as unknown as { executeToolCalls: (s: ExecutionState, c: unknown[]) => Promise<unknown[]> })
      .executeToolCalls(stateWith({ approvalId: 'appr-1', finalCalls: other.finalCalls, fingerprint: other.fingerprint, routes: [] }), batch);
    expect(hitlEnforcementService.checkHitlGate).toHaveBeenCalledTimes(1);
  });

  it('no grant gates every batch', async () => {
    const { hitlEnforcementService } = jest.requireMock('../../hitl-enforcement') as { hitlEnforcementService: { checkHitlGate: jest.Mock } };
    const svc = new AgentExecutionService();
    jest.spyOn(svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }, 'buildToolsSchema').mockResolvedValue([]);
    await (svc as unknown as { executeToolCalls: (s: ExecutionState, c: unknown[]) => Promise<unknown[]> })
      .executeToolCalls(stateWith(undefined), batch);
    expect(hitlEnforcementService.checkHitlGate).toHaveBeenCalledTimes(1);
  });
});
