// The resumed half runs on the engine the paused half ran on.
//
// A provider names a family; a deployment flag picks the engine. Resolving
// the engine from the provider at resume time re-runs that choice under
// whatever the flags say NOW. So an invocation paused for approval under one
// engine, and resumed after the flag moved, was rebuilt on the new engine:
// structured resume loaded the saved session under the new engine's label,
// found the artifact foreign, and fell back to snapshot replay on the new
// engine — while the returned result was labelled with the OLD engine. Every
// row of that was consistent with itself and none of it was true.
//
// Asserted from the persisted row and the resume metrics, never from the
// returned result: the result's label is what lied last time. Enumerated over
// both resume strategies and both decisions, because the two strategies
// consumed the engine differently and a fix that reached one could miss the
// other.

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
const hashToolCallsMock = jest.fn().mockReturnValue('matching-hash');
const obligationConfigForMock = jest.fn().mockResolvedValue({ hitlLevel: 3, oversight: undefined, tools: [], standingPolicies: {} });
const getOversightSettingsMock = jest.fn();
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    getApprovalRequest: (...a: unknown[]) => getApprovalRequestMock(...a),
    getOversightSettings: (...a: unknown[]) => getOversightSettingsMock(...a),
    createApprovalRequest: jest.fn(),
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
jest.mock('../../tool-gateway/dispatcher', () => ({ getToolGatewayDispatcher: jest.fn().mockReturnValue({ execute: jest.fn(), executeBatch: jest.fn() }) }));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''),
  getTenantRuntimeUrl: jest.fn().mockReturnValue(''),
  tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })) }));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
const enqueueResumeForHitlMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../scheduling/hitl-resume-helpers', () => ({ enqueueResumeForHitl: (...a: unknown[]) => enqueueResumeForHitlMock(...a) }));
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
import { readFileSync } from 'fs';
import { join } from 'path';
import { AgentExecutionService, agentExecutionService } from '../service';
import { cloudTasksHandler } from '../../handlers/cloud-tasks-handler';
import { resolveExecutionEngine } from '../adapter/engine-resolver';
import { logger } from '../../infrastructure/logging';
import type { ExecutionContext } from '../types';
import type { ExecutionEngineId } from '../adapter/types';

const TENANT = 't1';
const AGENT = 'a1';
const INVOCATION = 'inv-1';
const SCHED = 'sched-1';

// The flag flip. The pause is stamped with what OpenAI resolved to under the
// escape hatch; the resume runs under the default. Both computed through the
// resolver rather than written out, so the case keeps meaning "the flag
// moved" if the defaults ever move again.
const PAUSED_ENGINE = resolveExecutionEngine('openai', { OPENAI_ENGINE: 'agents' } as NodeJS.ProcessEnv);
const CURRENT_ENGINE = resolveExecutionEngine('openai', {} as NodeJS.ProcessEnv);

function makeContext(): ExecutionContext {
  return {
    tenantId: TENANT, agentId: AGENT, workflowId: '', taskId: '',
    instructionVersion: 0,
    instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' } as unknown as ExecutionContext['instruction'],
    traceId: 'tr-1', agentType: 'agent',
    hitlLevel: 3, modelConfig: {} as ExecutionContext['modelConfig'], execConfig: {} as ExecutionContext['execConfig'], memoryScope: {} as ExecutionContext['memoryScope'],
    invocationId: INVOCATION,
  };
}

type Strategy = 'structured_session' | 'snapshot_replay';
type Decision = 'approved' | 'rejected';

function payloadFor(strategy: Strategy, engine: ExecutionEngineId | undefined) {
  return {
    kind: 'hybrid-pause',
    pauseReason: 'hitl_approval',
    ...(engine ? { executionEngine: engine } : {}),
    currentStepId: 'step-1',
    resumeAfterStepId: 'step-2',
    stepOutput: null,
    objective: 'Send the weekly status report',
    triggerKey: 'trig-1',
    inputData: {},
    perStepRecoveries: {},
    totalRecoveries: 0,
    recoveryHistory: [],
    hitlContext: {
      approvalId: 'appr-1',
      pendingToolCalls: [{ id: 'pc1', name: 'gmail__send_email', input: { to: 'x@y.com' } }],
      gateReason: 'communication_review',
      provider: 'openai',
      model: 'gpt-5-codex',
      // Both strategies re-enter a conversation; the structured one also needs
      // a saved session, armed per case below.
      conversationHistory: [{ role: 'user', content: 'send the email' }],
      ...(strategy === 'structured_session' ? {} : {}),
    },
  };
}

interface RowState {
  payload: Record<string, unknown>;
  /** What `invocations.execution_engine` holds on the row. */
  rowEngine: string | null;
  /** Whether the fenced claim succeeds. */
  claimable: boolean;
}

/** The pool, answering as a live database would for each statement the resume
 *  issues, and remembering the writes so the test can read the row back. */
function armPool(row: RowState) {
  const writes: { invocationEngine?: string; released?: { token: string; error: string | null; deferred?: boolean }; fired?: string; status: string } = { status: 'pending' };
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (typeof sql !== 'string') return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT workflow_resume_payload')) {
      return { rows: [{ workflow_resume_payload: row.payload, agent_id: AGENT, tenant_id: TENANT, fired_at: null }], rowCount: 1 };
    }
    if (sql.includes('SELECT execution_engine FROM invocations')) {
      return { rows: [{ execution_engine: row.rowEngine }], rowCount: 1 };
    }
    if (sql.includes("SET status = 'resume_inflight'")) {
      if (!row.claimable || writes.status !== 'pending') return { rows: [], rowCount: 0 };
      writes.status = 'resume_inflight';
      return { rows: [{ id: SCHED, lease_token: 'lease-1', status: 'resume_inflight' }], rowCount: 1 };
    }
    if (sql.includes("SET status = 'fired'")) {
      if (writes.status !== 'resume_inflight' || params?.[1] !== 'lease-1') return { rows: [], rowCount: 0 };
      writes.status = 'fired';
      writes.fired = params[1] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = 'pending'")) {
      writes.status = 'pending';
      writes.released = { token: params?.[1] as string, error: (params?.[2] as string | null) ?? null, deferred: params?.[3] === true };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE invocations SET execution_engine')) {
      writes.invocationEngine = params?.[1] as string;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return writes;
}

function armApproval(decision: Decision) {
  getApprovalRequestMock.mockResolvedValue({
    id: 'appr-1', tenantId: TENANT, agentId: AGENT, decision, status: decision, decidedBy: 'user-1',
    rejectionReason: decision === 'rejected' ? 'not now' : undefined,
  });
}

function stubReconstitution(svc: AgentExecutionService) {
  (svc as unknown as { getActiveInstruction: (...a: unknown[]) => Promise<unknown> }).getActiveInstruction =
    jest.fn().mockResolvedValue({
      version: 1,
      instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' },
      // The connector the fixture's pending call names is still bound: an
      // approved call on a connector the hire no longer has is a
      // configuration error, and that is its own case.
      integrations: [{ id: 'gmail', type: 'google_mail' }],
    });
  (svc as unknown as { loadRuntimeConfig: (...a: unknown[]) => Promise<unknown> }).loadRuntimeConfig =
    jest.fn().mockResolvedValue({
      workflowSteps: [], modelConfig: { provider: 'openai' }, execConfig: {}, memoryScope: {}, hitlLevel: 3,
    });
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

/** The adapter the resume built, and the one the hybrid loop was handed. */
function spyLoop(svc: AgentExecutionService) {
  const seen: { adapter?: unknown; count: number } = { count: 0 };
  jest.spyOn(
    svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
    'runAgentHybridLoop',
  ).mockImplementation(async (...a: unknown[]) => {
    seen.adapter = a[4];
    seen.count += 1;
    return { success: true, toolCallsExecuted: 1, reasoningSteps: 1 };
  });
  jest.spyOn(
    svc as unknown as { executeToolCalls: (state: unknown, calls: Array<{ id: string }>) => Promise<unknown[]> },
    'executeToolCalls',
  ).mockImplementation(async (_state, calls) => calls.map((c) => ({ id: c.id, success: true, result: {} })));
  return seen;
}

function metricLines(name: string): Array<Record<string, unknown>> {
  return (logger.info as jest.Mock).mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((o) => o && typeof o === 'object' && o.metric_name === name);
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

/** The whole resume, driven the way production drives it: through the Cloud
 *  Tasks handler, whose `recordResume` is where agent_resume_total and
 *  agent_resume_duration_ms get their engine label. */
async function resumeThroughHandler(kind: 'hitl-approved' | 'hitl-rejected') {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', cloudTasksHandler);
  return request(app).post('/api/tasks/resume-execution').send({
    tenantId: TENANT, agentId: AGENT, invocationId: INVOCATION,
    workflowResume: { kind, scheduledInvocationId: SCHED, invocationId: INVOCATION },
  });
}

const savedEngineEnv = process.env.OPENAI_ENGINE;
beforeEach(() => {
  jest.clearAllMocks();
  // The resume runs under the DEFAULT: the flag the pause was taken under is gone.
  delete process.env.OPENAI_ENGINE;
  getAgentMock.mockResolvedValue({ id: AGENT, lifecycle: 'ACTIVE', runtimeStatus: 'WAITING_FOR_HUMAN' });
  getOversightSettingsMock.mockResolvedValue({ communication: 'review', sensitiveWork: {} });
  constructAdapterForEngineMock.mockImplementation((engine: string) => ({
    engine,
    registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(), registerAnomalyHandler: jest.fn(),
    invoke: jest.fn(), pause: jest.fn(), resume: jest.fn(),
  }));
});
afterAll(() => {
  if (savedEngineEnv === undefined) delete process.env.OPENAI_ENGINE;
  else process.env.OPENAI_ENGINE = savedEngineEnv;
});

it('the fixture is a real flag flip', () => {
  expect(PAUSED_ENGINE).not.toBe(CURRENT_ENGINE);
});

describe.each<[Strategy, Decision]>([
  ['structured_session', 'approved'],
  ['structured_session', 'rejected'],
  ['snapshot_replay', 'approved'],
  ['snapshot_replay', 'rejected'],
])('pause under one flag, flip it, resume — %s × %s', (strategy, decision) => {
  it('constructs the SAVED engine, records it on the row and labels the resume metrics with it', async () => {
    armStrategy(strategy);
    armApproval(decision);
    const writes = armPool({ payload: payloadFor(strategy, PAUSED_ENGINE), rowEngine: CURRENT_ENGINE, claimable: true });
    stubReconstitution(agentExecutionService);
    const loop = spyLoop(agentExecutionService);

    const res = await resumeThroughHandler(decision === 'approved' ? 'hitl-approved' : 'hitl-rejected');
    expect(res.status).toBe(200);

    // The adapter: built by engine, from the pause, and the only one built.
    expect(constructAdapterForEngineMock).toHaveBeenCalledTimes(1);
    expect(constructAdapterForEngineMock).toHaveBeenCalledWith(PAUSED_ENGINE);
    expect(createAdapterMock).not.toHaveBeenCalled();
    // And the one the loop was handed, on whichever strategy ran.
    expect(loop.count).toBe(1);
    expect((loop.adapter as { engine: string }).engine).toBe(PAUSED_ENGINE);
    if (strategy === 'structured_session') {
      // The saved session is loaded under the SAME engine, or it reads as
      // foreign and the structured resume silently falls to snapshot replay.
      expect(mockLoadRunSession).toHaveBeenCalledWith('trig-1', AGENT, PAUSED_ENGINE, expect.anything());
    }

    // The persisted row, not the returned result: the row said the current
    // engine (creation-time resolution under the old flags), and now says
    // what ran.
    expect(writes.invocationEngine).toBe(PAUSED_ENGINE);
    expect(writes.status).toBe('fired');

    // The resume metrics, at the handler where they are emitted, carry the
    // engine that ran. invocation_failed_total is not consulted: a successful
    // resume never emits it.
    const attempts = metricLines('agent_resume_total');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ execution_engine: PAUSED_ENGINE, pause_kind: 'hitl_approval', outcome: 'succeeded' });
    const durations = metricLines('agent_resume_duration_ms');
    expect(durations).toHaveLength(1);
    expect(durations[0]).toMatchObject({ execution_engine: PAUSED_ENGINE, pause_kind: 'hitl_approval' });
  });
});

describe('an engine this deployment cannot construct', () => {
  it('releases the row to pending, records engine_unavailable, dispatches nothing and leaves the agent where the pause put it', async () => {
    armStrategy('snapshot_replay');
    armApproval('approved');
    const writes = armPool({ payload: payloadFor('snapshot_replay', PAUSED_ENGINE), rowEngine: PAUSED_ENGINE, claimable: true });
    stubReconstitution(agentExecutionService);
    const loop = spyLoop(agentExecutionService);
    constructAdapterForEngineMock.mockImplementation(() => { throw new Error('@openai/agents is not installed here'); });

    enqueueResumeForHitlMock.mockClear();
    const res = await resumeThroughHandler('hitl-approved');

    // Retryable: the row is back where the next delivery can claim it — never
    // silently on another engine — with the attempt handed back, and the
    // resume re-armed itself a minute out; the queue is answered as handled so
    // its own quick retries do not spend the budget against the same outage.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deferred: true, rearmed: expect.any(String) });
    expect(createAdapterMock).not.toHaveBeenCalled();
    expect(writes.status).toBe('pending');
    expect(writes.released).toEqual({ token: 'lease-1', error: expect.stringContaining('engine_unavailable'), deferred: true });
    expect(enqueueResumeForHitlMock).toHaveBeenCalledTimes(1);
    expect(enqueueResumeForHitlMock).toHaveBeenCalledWith(expect.objectContaining({
      scheduledRowId: SCHED, kind: 'hitl-approved', scheduleTime: expect.any(Date),
    }));
    const rearm = enqueueResumeForHitlMock.mock.calls[0][0] as { scheduleTime: Date };
    expect(rearm.scheduleTime.getTime() - Date.now()).toBeGreaterThan(30_000);
    expect(writes.fired).toBeUndefined();
    expect(writes.invocationEngine).toBeUndefined();
    // No dispatch of any kind.
    expect(loop.count).toBe(0);
    // The agent's status is untouched: RUNNING is entered only once an adapter exists.
    expect(updateRuntimeStatusMock).not.toHaveBeenCalled();
    // Classified where it happened, labelled with the engine that could not be built.
    const failures = metricLines('agent_pause_resume_failure_total');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      execution_engine: PAUSED_ENGINE, operation: 'resume', pause_kind: 'hitl_approval',
      stage: 'execution_reconstruction', failure_class: 'engine_unavailable',
    });
    // And retryable in fact: the next delivery claims and runs.
    constructAdapterForEngineMock.mockImplementation((engine: string) => ({
      engine, registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(), registerAnomalyHandler: jest.fn(),
      invoke: jest.fn(), pause: jest.fn(), resume: jest.fn(),
    }));
    const retry = await resumeThroughHandler('hitl-approved');
    expect(retry.status).toBe(200);
    expect(writes.status).toBe('fired');
    expect(loop.count).toBe(1);
  });
});

describe('where the engine comes from', () => {
  it('an envelope without an engine takes the invocation row\'s', async () => {
    armStrategy('snapshot_replay');
    armApproval('approved');
    const writes = armPool({ payload: payloadFor('snapshot_replay', undefined), rowEngine: 'google-genai', claimable: true });
    stubReconstitution(agentExecutionService);
    spyLoop(agentExecutionService);

    const res = await resumeThroughHandler('hitl-approved');
    expect(res.status).toBe(200);
    expect(constructAdapterForEngineMock).toHaveBeenCalledWith('google-genai');
    expect(createAdapterMock).not.toHaveBeenCalled();
    // Already what the row said; the write is a no-op by its own predicate,
    // and the metrics carry the row's engine.
    expect(writes.invocationEngine).toBe('google-genai');
    expect(metricLines('agent_resume_total')[0]).toMatchObject({ execution_engine: 'google-genai' });
  });

  it('an envelope stamped unknown-legacy is an envelope without an engine', async () => {
    armStrategy('snapshot_replay');
    armApproval('approved');
    armPool({ payload: payloadFor('snapshot_replay', 'unknown-legacy'), rowEngine: 'google-adk', claimable: true });
    stubReconstitution(agentExecutionService);
    spyLoop(agentExecutionService);

    await resumeThroughHandler('hitl-approved');
    expect(constructAdapterForEngineMock).toHaveBeenCalledWith('google-adk');
  });

  it('both absent → the provider path, with unknown-legacy retained on the provenance', async () => {
    armStrategy('snapshot_replay');
    armApproval('approved');
    const writes = armPool({ payload: payloadFor('snapshot_replay', undefined), rowEngine: null, claimable: true });
    stubReconstitution(agentExecutionService);
    spyLoop(agentExecutionService);

    const res = await resumeThroughHandler('hitl-approved');
    expect(res.status).toBe(200);
    // Resolved from the provider under the CURRENT flags — the one case where
    // that is the only path — and still built by engine id.
    expect(constructAdapterForEngineMock).toHaveBeenCalledWith(CURRENT_ENGINE);
    expect(createAdapterMock).not.toHaveBeenCalled();
    // Nothing recorded an engine for the paused half, so nothing asserts one now:
    // the row is not written and the metrics say what is known.
    expect(writes.invocationEngine).toBeUndefined();
    expect(metricLines('agent_resume_total')[0]).toMatchObject({ execution_engine: 'unknown-legacy' });
  });
});

describe('the claim', () => {
  it('a delivery that loses the claim does not dispatch and is not counted as an attempt', async () => {
    armStrategy('snapshot_replay');
    armApproval('approved');
    armPool({ payload: payloadFor('snapshot_replay', PAUSED_ENGINE), rowEngine: PAUSED_ENGINE, claimable: false });
    stubReconstitution(agentExecutionService);
    const loop = spyLoop(agentExecutionService);

    const res = await resumeThroughHandler('hitl-approved');
    expect(res.status).toBe(200);
    expect(res.body.resumeNoop).toBe(true);
    expect(constructAdapterForEngineMock).not.toHaveBeenCalled();
    expect(loop.count).toBe(0);
    expect(metricLines('agent_resume_total')).toHaveLength(0);
  });

  it('claims before it builds, and marks fired only after — under the same lease', async () => {
    armStrategy('snapshot_replay');
    armApproval('approved');
    const order: string[] = [];
    const writes = armPool({ payload: payloadFor('snapshot_replay', PAUSED_ENGINE), rowEngine: PAUSED_ENGINE, claimable: true });
    const inner = queryMock.getMockImplementation()!;
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes("SET status = 'resume_inflight'")) order.push('claim');
      if (typeof sql === 'string' && sql.includes("SET status = 'fired'")) order.push('fired');
      return inner(sql, params);
    });
    constructAdapterForEngineMock.mockImplementation((engine: string) => {
      order.push('construct');
      return { engine, registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(), registerAnomalyHandler: jest.fn(), invoke: jest.fn(), pause: jest.fn(), resume: jest.fn() };
    });
    updateRuntimeStatusMock.mockImplementation(async (_a: string, status: string) => { order.push(`status:${status}`); });
    stubReconstitution(agentExecutionService);
    spyLoop(agentExecutionService);

    await resumeThroughHandler('hitl-approved');
    // ...and the resumed half, once its loop returns, frees the agent again —
    // it used to leave it RUNNING for good.
    expect(order).toEqual(['claim', 'construct', 'fired', 'status:RUNNING', 'status:IDLE']);
    expect(writes.fired).toBe('lease-1');
  });
});

// Every pause-envelope writer stamps the engine, so a resume always has the
// first thing it reads. Checked at the source: the writers are the public
// `create*Pause` methods that persist a HybridResumeState, and each must stamp
// `executionEngine` through `pauseEngineIdFor` before its insert. A writer
// added without the stamp is a pause that can only take the provider path.
describe('every pause-envelope writer sets executionEngine', () => {
  const src = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
  const starts = [...src.matchAll(/^ {2}public async (create\w*Pause)\(/gm)];
  const bodies = starts.map((m, i) => {
    const from = m.index!;
    const to = i + 1 < starts.length ? starts[i + 1].index! : src.length;
    // A method ends at the next public/private method declaration.
    const next = src.slice(from + 1).search(/^ {2}(public|private|protected) /m);
    return { name: m[1], body: src.slice(from, next === -1 ? to : Math.min(to, from + 1 + next)) };
  });

  it('finds the writers', () => {
    expect(bodies.map((b) => b.name).sort()).toEqual([
      'createClarificationPause', 'createDelegationPause', 'createHitlPause', 'createWaitSetPause', 'createWakePause',
    ]);
  });

  it.each(bodies.map((b) => [b.name, b.body] as const))('%s stamps executionEngine before it persists', (_name, body) => {
    expect(body).toMatch(/executionEngine(\s*\?\?=\s*|:\s*pauseState\.executionEngine\s*\?\?\s*)pauseEngineIdFor\(ctx\)/);
  });

  it('the stamp honours a resumed run\'s pinned engine', () => {
    // A pause the resumed half takes records the engine it ran on, not what
    // the flags would resolve now — otherwise the next resume crosses.
    expect(src).toMatch(/function pauseEngineIdFor\(context: ExecutionContext\)[\s\S]*?if \(context\.resumeEngine\) return context\.resumeEngine;/);
  });
});
