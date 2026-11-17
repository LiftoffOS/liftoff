// resumeFromHitlApproval — the highest-risk path in the HITL fix.
//
// resume primitive's three decision branches (approved / rejected /
// still-pending), idempotency under duplicate Cloud Task delivery, and
// the tool-shape remap + the consumed-grant flow on the approved path.
//
// Doesn't go all the way through runAgentHybridLoop (that needs a full
// fixture of workflow steps + adapter); it pins the decision-branching
// logic + dispatch path up to the runAgentHybridLoop boundary.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// dispatchApprovedAndContinue calls createAdapter, which transitively
// imports the @anthropic-ai/claude-agent-sdk ESM bundle that jest can't
// parse in CJS test mode. Stub the whole adapter module — the test pins
// behaviour up to runAgentHybridLoop (which we also stub), so the actual
// adapter never runs.
const constructAdapterForEngineMock = jest.fn().mockImplementation(() => ({
  registerToolCatalog: jest.fn(),
  registerHitlGate: jest.fn(),
  registerAnomalyHandler: jest.fn(),
  invoke: jest.fn(),
  pause: jest.fn(),
  resume: jest.fn(),
}));
jest.mock('../adapter', () => ({
  createAdapter: jest.fn().mockReturnValue({
    registerToolCatalog: jest.fn(),
    registerHitlGate: jest.fn(),
    registerAnomalyHandler: jest.fn(),
    invoke: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
  }),
  // The resume builds its adapter by ENGINE, never by provider: the engine the
  // paused half ran on is read off the pause, and this is what constructs it.
  constructAdapterForEngine: (...a: unknown[]) => constructAdapterForEngineMock(...a),
}));

const getApprovalRequestMock = jest.fn();
/** Matches whatever the approval says by default, so existing cases exercise the
 *  dispatch they were written for; a case that wants the mismatch overrides it. */
const hashToolCallsMock = jest.fn().mockReturnValue('matching-hash');
const obligationConfigForMock = jest.fn().mockResolvedValue({ hitlLevel: 3, oversight: undefined, tools: [], standingPolicies: {} });
const getOversightSettingsMock = jest.fn();
const createApprovalRequestMock = jest.fn();
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    getApprovalRequest: (...a: unknown[]) => getApprovalRequestMock(...a),
    getOversightSettings: (...a: unknown[]) => getOversightSettingsMock(...a),
    createApprovalRequest: (...a: unknown[]) => createApprovalRequestMock(...a),
    checkHitlGate: jest.fn().mockResolvedValue({ shouldGate: false }),
    // The dispatch-time fingerprint. A module mock lists what it provides, so a
    // method missing here is not a stub but an absent function — and the resume
    // would fail on the mock rather than on itself.
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
// The tenant-scoped client the pause checkpoint table is read through. Empty
// unless a case seeds a row, so every existing case takes the snapshot path
// it was written for.
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
// `guardExternal` is the provenance judge consumption applies to every
// approved vendor-hosted call; a null hold lets the call through, and the
// provenance cases below override it.
const guardExternalMock = jest.fn().mockResolvedValue(null);
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: jest.fn().mockReturnValue({
    execute: jest.fn(),
    executeBatch: jest.fn(),
    guardExternal: (...a: unknown[]) => guardExternalMock(...a),
  }),
}));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''),
  getTenantRuntimeUrl: jest.fn().mockReturnValue(''),
  tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
// Admission is asked again on every resume, before either strategy runs. The
// person judged the call; the tenant's and agent's standing is judged now.
const checkAdmissionMock = jest.fn();
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: (...a: unknown[]) => checkAdmissionMock(...a) })) }));

// The engines' dispatcher, which the resume hands every approved call the
// dispatcher cannot execute: gateway-native, vendor MCP, deferred vendor and
// teammate tools. The real module is kept for everything else it exports
// (`extractWakePending` reads the wake marker off a dispatched result).
const dispatchFunctionCallMock = jest.fn();
jest.mock('../adapter/mcp-bridge', () => ({
  ...jest.requireActual('../adapter/mcp-bridge'),
  dispatchFunctionCall: (...a: unknown[]) => dispatchFunctionCallMock(...a),
}));
const releaseAllMock = jest.fn().mockResolvedValue(undefined);
// The pooled MCP client the real bridge dispatches on, for the case that
// drives the real bridge: `callTool` records the name sent on the wire.
const callToolMock = jest.fn();
jest.mock('../adapter/mcp-client-pool', () => ({
  getMcpClientPool: () => ({
    acquire: jest.fn().mockResolvedValue({ callTool: (...a: unknown[]) => callToolMock(...a) }),
    releaseAll: (...a: unknown[]) => releaseAllMock(...a),
  }),
}));
// The observation seam the bridge context carries. Spied so the approved call
// can be shown to reach it the way every adapter dispatch does.
const rememberExternalToolCallMock = jest.fn().mockResolvedValue('recorded');
jest.mock('../remember-external-tool-call', () => ({
  ...jest.requireActual('../remember-external-tool-call'),
  rememberExternalToolCall: (...a: unknown[]) => rememberExternalToolCallMock(...a),
}));
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
const settleMcpChatRunMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn(),
  // closeMcpChatRunForResume settles the durable MCP run with the resume reply;
  // spy it so the blank-reply floor can be asserted.
  settleMcpChatRunViaCallback: (...a: unknown[]) => settleMcpChatRunMock(...a),
}));

// The write-class capability approval side-channel. run_capability's backend
// executor refuses an unapproved write, so the snapshot-replay dispatch must
// arm an approval before it runs the operator-approved call; spy recordCapabilityApproval.
const recordCapabilityApprovalMock = jest.fn();
jest.mock('../../tool-gateway/capability-approval-signal', () => ({
  recordCapabilityApproval: (...a: unknown[]) => recordCapabilityApprovalMock(...a),
  capabilityApprovalKey: (inv: string | undefined, input: Record<string, unknown> | undefined) =>
    inv ? `${inv}|${JSON.stringify(input ?? {})}` : null,
  capabilityHandleNeedsApproval: (id: unknown) => typeof id === 'string' && id.startsWith('cap_w.'),
  consumeCapabilityApproval: jest.fn(),
}));
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
import type { ExecutionContext } from '../types';
import type { McpToolCatalog } from '../adapter/catalog-types';
import type { CanonicalMessage } from '../../trajectories/types';
import { scrubLogger } from '../../observability/scrub-logger';
import { sha256, canonicalSerialize } from '../session-artifact-envelope';

const GATEWAY = 'liftoff-tool-gateway';

/** The continuation's catalog, as the resume now builds it BEFORE dispatch
 *  and resolves every approved call against. One tool per ownership the
 *  routing distinguishes: a bound connector's (`gmail__…`), the standard tools,
 *  gateway-native tools (`sleep_until`, `spawn_task_graph`, a pseudo-connector
 *  Slack tool), a teammate's, a vendor server's, and one a collapsed vendor
 *  server keeps deferred. */
function fixtureCatalog(): McpToolCatalog {
  return {
    servers: [
      { kind: 'in-process', id: GATEWAY, config: {} as never },
      { kind: 'remote', id: 'github-dd4c4689', url: 'https://example.invalid/mcp', transport: 'streamable-http' },
      { kind: 'remote', id: 'notion-1a2b3c4d', url: 'https://example.invalid/notion', transport: 'streamable-http' },
    ],
    tools: [
      { name: 'gmail__send_email', inputSchema: {}, serverId: GATEWAY, source: 'connector' },
      { name: 'slack__post_message', inputSchema: {}, serverId: GATEWAY, source: 'connector' },
      { name: 'pager__notify', inputSchema: {}, serverId: GATEWAY, source: 'connector' },
      { name: 'run_capability', inputSchema: {}, serverId: GATEWAY, source: 'platform' },
      { name: 'memory_save', inputSchema: {}, serverId: GATEWAY, source: 'platform' },
      { name: 'slack_send_message', inputSchema: {}, serverId: GATEWAY },
      { name: 'sleep_until', inputSchema: {}, serverId: GATEWAY, source: 'platform', effect: 'spawn' },
      { name: 'spawn_task_graph', inputSchema: {}, serverId: GATEWAY, source: 'platform', effect: 'spawn' },
      { name: 'internal__code_reviewer__execute', inputSchema: {}, serverId: GATEWAY, source: 'internal_agent' },
      { name: 'github-dd4c4689__pull_request_read', inputSchema: {}, serverId: 'github-dd4c4689', remoteToolName: 'pull_request_read' },
    ],
    deferredVendorTools: new Map([[
      'notion-1a2b3c4d',
      [{ name: 'notion-1a2b3c4d__search_pages', remoteToolName: 'search_pages', inputSchema: {}, serverId: 'notion-1a2b3c4d' }],
    ]]),
    delegationRole: 'orchestrator',
  };
}

/** A successful MCP result carrying a JSON text block, as the bridge returns one. */
function mcpText(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function makeContext(): ExecutionContext {
  return {
    tenantId: 't1', agentId: 'a1', workflowId: '', taskId: '',
    instructionVersion: 0,
    instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' } as unknown as ExecutionContext['instruction'],
    traceId: 'tr-1', agentType: 'agent',
    hitlLevel: 3, modelConfig: {} as ExecutionContext['modelConfig'], execConfig: {} as ExecutionContext['execConfig'], memoryScope: {} as ExecutionContext['memoryScope'],
    invocationId: 'inv-1',
  };
}

const baseScheduledRow = {
  workflow_resume_payload: {
    kind: 'hybrid-pause',
    pauseReason: 'hitl_approval',
    currentStepId: 'step-1',
    resumeAfterStepId: 'step-2',
    stepOutput: null,
    objective: 'Send the weekly status report',
    triggerKey: 'trig-1',
    inputData: { foo: 'bar' },
    perStepRecoveries: {},
    totalRecoveries: 0,
    recoveryHistory: [],
    hitlContext: {
      approvalId: 'appr-1',
      pendingToolCalls: [{ id: 'pc1', name: 'gmail__send_email', input: { to: 'x@y.com' } }],
      gateReason: 'communication_review',
    },
  },
  agent_id: 'a1',
  tenant_id: 't1',
  fired_at: null,
};

/** The fenced lease the resume takes before it builds anything, and the
 *  fenced flip to fired once it has. Both answered as a live row would answer
 *  them; a case about a lost claim overrides this. */
function leaseAnswers(sql: string): { rows: unknown[]; rowCount: number } | null {
  if (sql.includes("SET status = 'resume_inflight'")) {
    return { rows: [{ id: 'sched-1', lease_token: 'lease-1', status: 'resume_inflight', scheduled_by_invocation_id: 'inv-1' }], rowCount: 1 };
  }
  if (sql.includes("SET status = 'fired'")) return { rows: [], rowCount: 1 };
  return null;
}

function mockSchedulingRow(row: Partial<typeof baseScheduledRow> | null) {
  queryMock.mockReset();
  if (row === null) {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    return;
  }
  // Sequence of pool.query calls inside resumeFromHitlApproval:
  // 1. SELECT workflow_resume_payload, agent_id, tenant_id, fired_at
  // 2. SELECT execution_engine FROM invocations (only when the envelope carries none)
  // 3. UPDATE ... SET status = 'resume_inflight' (the fenced claim)
  // 4. UPDATE ... SET status = 'fired' (fenced, after the adapter exists)
  // any subsequent calls inside runAgentHybridLoop — return empty rows
  queryMock.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('SELECT workflow_resume_payload')) {
      return { rows: [{ ...baseScheduledRow, ...row }], rowCount: 1 };
    }
    if (typeof sql === 'string') {
      const lease = leaseAnswers(sql);
      if (lease) return lease;
    }
    return { rows: [], rowCount: 0 };
  });
}

function mockApproval(decision: 'approved' | 'rejected' | null, status = 'pending') {
  getApprovalRequestMock.mockResolvedValue({
    id: 'appr-1',
    tenantId: 't1',
    agentId: 'a1',
    decision,
    status,
    decidedBy: 'user-1',
    rejectionReason: decision === 'rejected' ? 'too risky' : undefined,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  tenantClientQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  guardExternalMock.mockResolvedValue(null);
  getAgentMock.mockResolvedValue({ id: 'a1', lifecycle: 'ACTIVE', runtimeStatus: 'WAITING_FOR_HUMAN' });
  getOversightSettingsMock.mockResolvedValue({ communication: 'review', sensitiveWork: {} });
  checkAdmissionMock.mockResolvedValue({ allowed: true });
  releaseAllMock.mockResolvedValue(undefined);
  rememberExternalToolCallMock.mockResolvedValue('recorded');
  // A bridge dispatch answers with an empty successful result unless a case
  // says otherwise.
  dispatchFunctionCallMock.mockResolvedValue(mcpText({ ok: true }));
  // Structured resume defaults OFF (clearAllMocks keeps mockReturnValue, so reset
  // explicitly) → snapshot path for every test except the structured one.
  mockIsAutonomousEnabled.mockReturnValue(false);
  mockLoadRunSession.mockResolvedValue(null);
});

// `resumeFromHitlApproval` calls `this.getActiveInstruction` +
// `this.loadRuntimeConfig` on the service instance — both private methods
// hitting the DB — and the approved dispatch builds the continuation's catalog
// through `this.buildPlatformMcpCatalog`, which stands up a tool gateway. Stub
// them by patching the instance before each test (jest.spyOn is unavailable
// on private methods).
function stubReconstitution(svc: AgentExecutionService, catalog: McpToolCatalog = fixtureCatalog()) {
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
      workflowSteps: [],
      modelConfig: { provider: 'anthropic' },
      execConfig: {},
      memoryScope: {},
      hitlLevel: 3,
    });
  (svc as unknown as { buildPlatformMcpCatalog: (...a: unknown[]) => Promise<unknown> }).buildPlatformMcpCatalog =
    jest.fn().mockResolvedValue(catalog);
}

describe('resumeFromHitlApproval — idempotency + decision branching', () => {
  it('row not found → returns success:false with the right error', async () => {
    const svc = new AgentExecutionService();
    mockSchedulingRow(null);
    const res = await svc.resumeFromHitlApproval(makeContext(), 'missing');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/);
    expect(updateRuntimeStatusMock).not.toHaveBeenCalled();
  });

  it('row already fired (duplicate Cloud Task delivery) → no-op success', async () => {
    const svc = new AgentExecutionService();
    queryMock.mockResolvedValue({ rows: [{ ...baseScheduledRow, fired_at: new Date() }], rowCount: 1 });
    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(res.success).toBe(true);
    expect(getApprovalRequestMock).not.toHaveBeenCalled();
    expect(updateRuntimeStatusMock).not.toHaveBeenCalled();
  });

  it('payload not a hitl_approval pause → returns error', async () => {
    const svc = new AgentExecutionService();
    queryMock.mockResolvedValue({ rows: [{
      ...baseScheduledRow,
      workflow_resume_payload: { kind: 'hybrid-pause', pauseReason: 'ask_user' },
    }], rowCount: 1 });
    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not a hitl_approval pause/);
  });

  it('hitlContext missing approvalId → returns error (malformed pause)', async () => {
    const svc = new AgentExecutionService();
    queryMock.mockResolvedValue({ rows: [{
      ...baseScheduledRow,
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        hitlContext: { pendingToolCalls: [], gateReason: 'x' },
      },
    }], rowCount: 1 });
    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/hitlContext missing approvalId/);
  });

  it('approval not found → returns error', async () => {
    const svc = new AgentExecutionService();
    mockSchedulingRow({});
    getApprovalRequestMock.mockResolvedValue(null);
    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Approval .* not found/);
  });

  it('approval still pending → no-op success (row left pending)', async () => {
    const svc = new AgentExecutionService();
    mockSchedulingRow({});
    mockApproval(null, 'pending');
    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(res.success).toBe(true);
    expect(res.paused).toBe(true);
    // Row not marked fired; agent lifecycle not flipped (operator still
    // has the row in /review and can decide later).
    expect(updateRuntimeStatusMock).not.toHaveBeenCalled();
  });

  it('approval rejected → audits per pending tool call + returns failure (no dispatch)', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    mockApproval('rejected', 'rejected');
    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/rejected/);
    // One audit log per pending tool call.
    expect(insertAuditLogMock).toHaveBeenCalledWith(null, 't1', expect.objectContaining({
      action: 'gmail__send_email', outcome: 'error',
      triggeredBy: expect.stringMatching(/^human:/),
    }));
    // Lifecycle moved off WAITING_FOR_HUMAN.
    expect(updateRuntimeStatusMock).toHaveBeenCalledWith('a1', 'RUNNING');
  });

  it('approval rejected WITH conversation snapshot → injects rejection tool_result + re-enters loop (continue-and-adapt)', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    queryMock.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT workflow_resume_payload')) {
        return { rows: [{
          ...baseScheduledRow,
          workflow_resume_payload: {
            ...baseScheduledRow.workflow_resume_payload,
            hitlContext: {
              ...baseScheduledRow.workflow_resume_payload.hitlContext,
              conversationHistory: [{ role: 'user', content: 'send the email' }],
              provider: 'anthropic',
            },
          },
        }], rowCount: 1 };
      }
      const lease = typeof sql === 'string' ? leaseAnswers(sql) : null;
      if (lease) return lease;
      return { rows: [], rowCount: 0 };
    });
    mockApproval('rejected', 'rejected');

    let capturedState: { conversationHistory?: Array<Record<string, unknown>> } | undefined;
    let capturedTrace: string | undefined;
    const runLoopSpy = jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockImplementation(async (state, trace) => {
      capturedState = state as typeof capturedState;
      capturedTrace = trace as string;
      return { success: true, toolCallsExecuted: 0, reasoningSteps: 1 };
    });

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    // Re-entered the loop (continue-and-adapt), not the terminal finalize.
    expect(runLoopSpy).toHaveBeenCalled();
    // The REAL objective is propagated (persisted in the pause), not the
    // 'hitl-rejected-resume' trace label — so the resumed system prompt /
    // skill-retrieval / initial turn aren't corrupted with the label.
    expect(capturedTrace).toBe('Send the weekly status report');
    expect(res.success).toBe(true);

    // Conversation carries the gated tool_use + a rejection tool_result error
    // so the model sees *why* on re-entry.
    const history = capturedState?.conversationHistory ?? [];
    const toolResult = history.find(m => m.role === 'tool' && m.toolCallId === 'pc1');
    expect(toolResult).toBeDefined();
    expect(String(toolResult?.content)).toMatch(/Rejected by human reviewer: too risky/);

    // Rejection still audited + surfaced to the watching thread.
    expect(insertAuditLogMock).toHaveBeenCalledWith(null, 't1', expect.objectContaining({
      action: 'gmail__send_email', outcome: 'error',
    }));
  });

  it('structured resume — flag ON + saved session: resumes the session (no pre-dispatch), gate carries the decision', async () => {
    mockIsAutonomousEnabled.mockReturnValue(true);
    mockLoadRunSession.mockResolvedValue({ sdkSessionId: 'sess-1', jsonlContent: '{}' });
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    queryMock.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT workflow_resume_payload')) {
        return { rows: [{
          ...baseScheduledRow,
          workflow_resume_payload: {
            ...baseScheduledRow.workflow_resume_payload,
            hitlContext: {
              ...baseScheduledRow.workflow_resume_payload.hitlContext,
              conversationHistory: [{ role: 'user', content: 'send the email' }],
              provider: 'anthropic',
            },
          },
        }], rowCount: 1 };
      }
      const lease = typeof sql === 'string' ? leaseAnswers(sql) : null;
      if (lease) return lease;
      return { rows: [], rowCount: 0 };
    });
    mockApproval('approved', 'approved');

    let capturedState: { context?: { hitlResumeDecision?: { decision: string; pending: unknown[] }; skipInitialPromptPush?: boolean } } | undefined;
    let capturedTrace: string | undefined;
    const runLoopSpy = jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockImplementation(async (state, trace) => {
      capturedState = state as typeof capturedState;
      capturedTrace = trace as string;
      return { success: true, toolCallsExecuted: 1, reasoningSteps: 1 };
    });
    // Structured path must NOT pre-dispatch — the SDK re-attempts the gated call
    // on resume and the gate resolves it.
    const execSpy = jest.spyOn(
      svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockResolvedValue([]);

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(res.success).toBe(true);
    expect(runLoopSpy).toHaveBeenCalled();
    expect(capturedTrace).toBe('Send the weekly status report');
    // Structured-resume signals set on the reconstituted context.
    expect(capturedState?.context?.skipInitialPromptPush).toBe(true);
    expect(capturedState?.context?.hitlResumeDecision?.decision).toBe('approved');
    expect(capturedState?.context?.hitlResumeDecision?.pending).toHaveLength(1);
    // No snapshot pre-dispatch.
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('workflow adapter-step resume — no conversationHistory but workflowStepSession + a saved session → structured resume (restore + decision, no snapshot dispatch)', async () => {
    // A workflow llm_reason/capability step snapshots NO conversationHistory, so
    // it used to fall to snapshot-replay and have its raw approved result
    // substituted as the step output. Marked workflowStepSession, it now rides the
    // structured path: the session is restored (resumeSessionId + sessionStateDir
    // set) and the gated step's turn is continued by the model re-attempting the
    // call — never a snapshot pre-dispatch.
    mockIsAutonomousEnabled.mockReturnValue(true);
    mockLoadRunSession.mockResolvedValue({ sdkSessionId: 'sess-wf', jsonlContent: '{}' });
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    queryMock.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT workflow_resume_payload')) {
        return { rows: [{
          ...baseScheduledRow,
          workflow_resume_payload: {
            ...baseScheduledRow.workflow_resume_payload,
            // Real accumulated state: s0 ran before the gate; the rest of the
            // graph reads it by $.steps.s0.
            stepOutputs: { s0: { v: 1 } },
            enteredSteps: ['s0'],
            unsatisfiedSteps: ['s3'],
            hitlContext: {
              ...baseScheduledRow.workflow_resume_payload.hitlContext,
              // NO conversationHistory — the pause was a workflow step.
              workflowStepSession: true,
              provider: 'anthropic',
            },
          },
        }], rowCount: 1 };
      }
      const lease = typeof sql === 'string' ? leaseAnswers(sql) : null;
      if (lease) return lease;
      return { rows: [], rowCount: 0 };
    });
    mockApproval('approved', 'approved');

    let capturedState: { context?: { hitlResumeDecision?: { decision: string }; resumeSessionId?: string; sessionStateDir?: string; skipInitialPromptPush?: boolean } } | undefined;
    let capturedResumeState: Record<string, unknown> | undefined;
    const runLoopSpy = jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockImplementation(async (...a: unknown[]) => {
      capturedState = a[0] as typeof capturedState;
      capturedResumeState = a[3] as Record<string, unknown>; // (state, objective, inputData, resumeState, adapter)
      return { success: true, toolCallsExecuted: 1, reasoningSteps: 1 };
    });
    const execSpy = jest.spyOn(
      svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockResolvedValue([]);

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(res.success).toBe(true);
    expect(runLoopSpy).toHaveBeenCalled();
    // Structured signals set for the workflow step.
    expect(capturedState?.context?.hitlResumeDecision?.decision).toBe('approved');
    expect(capturedState?.context?.skipInitialPromptPush).toBe(true);
    // Part C: the session was restored for the gated step (invokeStepLLM consumes these).
    expect(capturedState?.context?.resumeSessionId).toBe('sess-wf');
    expect(capturedState?.context?.sessionStateDir).toBe('/tmp/sess/trig-1');
    // The FULL accumulated loop state survives — otherwise the resumed graph's
    // back-reference guard reports s0 missing and hard-fails.
    expect(capturedResumeState?.stepOutputs).toEqual({ s0: { v: 1 } });
    expect(capturedResumeState?.enteredSteps).toEqual(['s0']);
    expect(capturedResumeState?.unsatisfiedSteps).toEqual(['s3']);
    // Structured path — NO snapshot pre-dispatch.
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('a workflow tool_call pause (no session marker) still takes snapshot replay, not structured resume', async () => {
    // The unification is scoped to ADAPTER steps. A plain tool_call workflow pause
    // has neither conversationHistory nor workflowStepSession, so it must still
    // dispatch through the snapshot path (dispatchApprovedAndContinue).
    mockIsAutonomousEnabled.mockReturnValue(true);
    mockLoadRunSession.mockResolvedValue({ sdkSessionId: 'sess-x', jsonlContent: '{}' });
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({}); // baseScheduledRow: no conversationHistory, no workflowStepSession
    mockApproval('approved', 'approved');
    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockResolvedValue({ success: true, toolCallsExecuted: 1, reasoningSteps: 1 });
    const execSpy = jest.spyOn(
      svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockResolvedValue([{ id: 'pc1', success: true, result: {} }]);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    // Snapshot path dispatched the approved call (structured resume would not).
    expect(execSpy).toHaveBeenCalled();
  });

  it('agent not ACTIVE → resume aborts before any state mutation', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    mockApproval('approved', 'approved');
    getAgentMock.mockResolvedValue({ id: 'a1', lifecycle: 'PAUSED' });
    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not ACTIVE/);
    expect(updateRuntimeStatusMock).not.toHaveBeenCalled();
  });

  it('approval approved → marks row fired BEFORE dispatch (idempotency invariant)', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    mockApproval('approved', 'approved');

    // Stub the runAgentHybridLoop continuation so we can observe whether
    // resumeFromHitlApproval reached it and the mark-fired UPDATE ran
    // first.
    const runAgentHybridLoopSpy = jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockResolvedValue({ success: true, toolCallsExecuted: 1, reasoningSteps: 1 });

    // Stub executeToolCalls so we don't go through the full dispatch
    // chain; just verify the consumed grant was on the context during the
    // call, and that it named exactly the calls being dispatched.
    let grantDuringDispatch: { approvalId: string; finalCalls: Array<{ id: string }> } | undefined;
    const executeToolCallsSpy = jest.spyOn(
      svc as unknown as { executeToolCalls: (state: { context: { approvedGrant?: { approvalId: string; finalCalls: Array<{ id: string }> } } }, calls: unknown) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockImplementation(async (state) => {
      grantDuringDispatch = state.context.approvedGrant;
      return [{ id: 'pc1', success: true, result: { messageId: 'm1' } }];
    });

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    // Mark-fired UPDATE must have run.
    const updateCalls = queryMock.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes("SET status = 'fired'"),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateRuntimeStatusMock).toHaveBeenCalledWith('a1', 'RUNNING');

    // The grant must have been on the context during dispatch so the
    // operator-approved tool calls don't re-gate — and it covers exactly them.
    expect(executeToolCallsSpy).toHaveBeenCalled();
    expect(grantDuringDispatch?.approvalId).toBe('appr-1');
    expect(grantDuringDispatch?.finalCalls.map((c) => c.id)).toEqual(['pc1']);

    // And the runAgentHybridLoop continuation was invoked.
    expect(runAgentHybridLoopSpy).toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it('approved branch — pendingToolCalls remap to agent-execution shape ({connector, actionType, payload})', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    mockApproval('approved', 'approved');

    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockResolvedValue({ success: true, toolCallsExecuted: 1, reasoningSteps: 1 });

    let dispatchedCalls: Array<Record<string, unknown>> = [];
    jest.spyOn(
      svc as unknown as { executeToolCalls: (state: unknown, calls: Array<Record<string, unknown>>) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockImplementation(async (_s, calls) => {
      dispatchedCalls = calls;
      return calls.map((c) => ({ id: c.id, success: true, result: {} }));
    });

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(dispatchedCalls).toHaveLength(1);
    // hitl-enforcement shape {id,name,input} → agent-execution shape
    // {id,connector,actionType,payload}. Name "gmail__send_email"
    // splits at the first "__".
    expect(dispatchedCalls[0]).toMatchObject({
      id: 'pc1',
      connector: 'gmail',
      actionType: 'send_email',
      payload: { to: 'x@y.com' },
    });
  });

  // A STANDARD tool (run_capability) carries no connector prefix. The old remap
  // split every name on '__', so run_capability became connector='run_capability'
  // and executeToolCalls — which routes a standard tool only when connector is
  // empty — dispatched it as a call to a connector that does not exist. The
  // operator-approved capability then silently never ran, the model re-called it,
  // and the resume re-paused. It must remap to the standard-tool shape instead.
  function mockRunCapabilityPending(capabilityId: string) {
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        hitlContext: {
          approvalId: 'appr-1',
          pendingToolCalls: [{ id: 'pc1', name: 'run_capability', input: { capabilityId, args: { to: '+14150000000', body: 'hi' } } }],
          gateReason: 'capability_requires_approval',
        },
      },
    });
  }

  function stubDispatch(svc: AgentExecutionService) {
    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockResolvedValue({ success: true, toolCallsExecuted: 1, reasoningSteps: 1 });
    const captured: { calls: Array<Record<string, unknown>> } = { calls: [] };
    jest.spyOn(
      svc as unknown as { executeToolCalls: (state: unknown, calls: Array<Record<string, unknown>>) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockImplementation(async (_s, calls) => {
      captured.calls = calls;
      return calls.map((c) => ({ id: c.id, success: true, result: {} }));
    });
    return captured;
  }

  it('approved branch — a write-class run_capability remaps to STANDARD shape (no connector) and arms the approval', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockRunCapabilityPending('cap_w.abc123');
    mockApproval('approved', 'approved');
    const captured = stubDispatch(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(captured.calls).toHaveLength(1);
    // Standard-tool shape: empty connector, whole name as actionType — so
    // executeToolCalls' `!connector` branch routes it to executeStandardTool.
    expect(captured.calls[0]).toMatchObject({
      id: 'pc1',
      connector: '',
      actionType: 'run_capability',
      payload: { capabilityId: 'cap_w.abc123', args: { to: '+14150000000', body: 'hi' } },
    });
    // The write-class approval was armed before dispatch, keyed to the exact
    // dispatched input, so handleRunCapability consumes it and sends approved=true.
    expect(recordCapabilityApprovalMock).toHaveBeenCalledWith(
      `inv-1|${JSON.stringify({ capabilityId: 'cap_w.abc123', args: { to: '+14150000000', body: 'hi' } })}`,
    );
  });

  it('approved branch — a read-class run_capability remaps to STANDARD shape but does NOT arm an approval', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockRunCapabilityPending('cap_r.readonly');
    mockApproval('approved', 'approved');
    const captured = stubDispatch(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(captured.calls[0]).toMatchObject({ connector: '', actionType: 'run_capability' });
    // A read never pauses, so arming one would authorise a write it never earned.
    expect(recordCapabilityApprovalMock).not.toHaveBeenCalled();
  });

  // The persisted name is whatever the engine called. On claude-agent-sdk that
  // is the SDK-wrapped form, and the model may carry the capability's arguments
  // as a JSON string under `arguments` rather than the schema's `args` object.
  // The remap must route on the wrapper-stripped name and pass the input through
  // unchanged, so the approval it arms is keyed to the exact object the handler
  // reads its arguments from.
  function mockPending(name: string, input: Record<string, unknown>) {
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        hitlContext: {
          approvalId: 'appr-1',
          pendingToolCalls: [{ id: 'pc1', name, input }],
          gateReason: 'capability_requires_approval',
        },
      },
    });
  }

  it('approved branch — an SDK-wrapped run_capability with stringified `arguments` remaps to STANDARD shape and arms on the exact input', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    const input = {
      arguments: JSON.stringify({ to: 'x@y.com', subject: 'Result', body: 'five fields' }),
      capabilityId: 'cap_w.abc123',
    };
    mockPending('mcp__liftoff-tool-gateway__run_capability', input);
    mockApproval('approved', 'approved');
    const captured = stubDispatch(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(captured.calls).toHaveLength(1);
    // Routed as the standard tool it is: the wrapper is not a connector.
    expect(captured.calls[0]).toMatchObject({ id: 'pc1', connector: '', actionType: 'run_capability', payload: input });
    expect(captured.calls[0].connector).not.toBe('mcp');
    // Armed on the raw input, which is what the handler will key its lookup on.
    expect(recordCapabilityApprovalMock).toHaveBeenCalledWith(`inv-1|${JSON.stringify(input)}`);
  });

  it('approved branch — an SDK-wrapped connector tool keeps its alias for the connector split', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockPending('mcp__liftoff-tool-gateway__gmail__send_email', { to: 'x@y.com' });
    mockApproval('approved', 'approved');
    const captured = stubDispatch(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(captured.calls[0]).toMatchObject({ connector: 'gmail', actionType: 'send_email', payload: { to: 'x@y.com' } });
  });

  it('approved branch — an SDK-wrapped pseudo-connector tool keeps its segment for the dispatcher', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockPending('mcp__liftoff-tool-gateway__agent_slack__slack_send_message', { channel: 'C1', text: 'hi' });
    mockApproval('approved', 'approved');
    const captured = stubDispatch(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    // The dispatcher routes on the pseudo-connector; collapsing it to the bare
    // name would leave nothing to route on.
    expect(captured.calls[0]).toMatchObject({ connector: 'agent_slack', actionType: 'slack_send_message' });
  });
});

// ── The run's ids survive a resume rebuilt from a bare task body ────────────
//
// The Cloud Tasks task body carries tenantId, agentId and invocationId; the
// workflow and task ids ride along only when the pause stamped them, and a
// caller can hand the rebuild a blank for either. Both feed uuid columns
// downstream — the approval row a re-gate writes — where a blank is rejected
// and only a real id or NULL is valid. So the rebuild takes each id from the
// first place that holds one and treats a blank as absent.
describe('the run ids survive a resume rebuilt from a bare task body', () => {
  const WF = '8d48512f-c961-4cee-87f2-a71e2664e8af';
  const TASK = 'd347ba93-7e22-4cbe-8e6c-0f3ad65852a9';

  function captureRebuiltContext(svc: AgentExecutionService) {
    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockResolvedValue({ success: true, toolCallsExecuted: 1, reasoningSteps: 1 });
    const seen: { context?: ExecutionContext } = {};
    jest.spyOn(
      svc as unknown as { executeToolCalls: (state: { context: ExecutionContext }, calls: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockImplementation(async (state, calls) => {
      seen.context = state.context;
      return (calls as Array<{ id: string }>).map((c) => ({ id: c.id, success: true, result: {} }));
    });
    return seen;
  }

  function mockApprovalWithIds(ids: { workflowId?: string | null; taskId?: string | null }) {
    getApprovalRequestMock.mockResolvedValue({
      id: 'appr-1', tenantId: 't1', agentId: 'a1',
      decision: 'approved', status: 'approved', decidedBy: 'user-1',
      ...ids,
    });
  }

  it('recovers workflowId/taskId from the approval row when the caller and the payload carry blanks', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({}); // pause payload predates the stamp: no ids on it
    mockApprovalWithIds({ workflowId: WF, taskId: TASK });
    const seen = captureRebuiltContext(svc);

    // makeContext() is the task-handler shape: blank ids, not absent ones.
    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(seen.context?.workflowId).toBe(WF);
    expect(seen.context?.taskId).toBe(TASK);
  });

  it('prefers the ids the pause stamped on its payload', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({
      workflow_resume_payload: { ...baseScheduledRow.workflow_resume_payload, workflowId: WF, taskId: TASK },
    });
    mockApprovalWithIds({ workflowId: '33333333-3333-4333-8333-333333333333', taskId: '44444444-4444-4444-8444-444444444444' });
    const seen = captureRebuiltContext(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(seen.context?.workflowId).toBe(WF);
    expect(seen.context?.taskId).toBe(TASK);
  });

  it('lets a caller that holds real ids win over both', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    mockApprovalWithIds({ workflowId: '33333333-3333-4333-8333-333333333333', taskId: '44444444-4444-4444-8444-444444444444' });
    const seen = captureRebuiltContext(svc);

    await svc.resumeFromHitlApproval({ ...makeContext(), workflowId: WF, taskId: TASK }, 'sched-1');

    expect(seen.context?.workflowId).toBe(WF);
    expect(seen.context?.taskId).toBe(TASK);
  });

  it('leaves an id absent — never a blank — when nothing holds it', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    mockApprovalWithIds({ workflowId: null, taskId: '' });
    const seen = captureRebuiltContext(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    // undefined is what the write side turns into NULL; '' would be rejected.
    expect(seen.context?.workflowId).toBeUndefined();
    expect(seen.context?.taskId).toBeUndefined();
  });

  // An own-account capability on the resumed half is resolved through the
  // account that originated the run. The task body never carries it; the pause
  // row does. Without it the executor cannot find the tenant's connection and
  // refuses — so a person approves a send that never happens.
  it('restores the originating account from the pause payload when the caller has none', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({
      workflow_resume_payload: { ...baseScheduledRow.workflow_resume_payload, messageSenderAccountId: 'acct-7' },
    });
    mockApprovalWithIds({ workflowId: WF, taskId: TASK });
    const seen = captureRebuiltContext(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(seen.context?.messageSenderAccountId).toBe('acct-7');
  });

  it('lets a caller that holds the account win, and leaves it absent when nothing holds it', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({
      workflow_resume_payload: { ...baseScheduledRow.workflow_resume_payload, messageSenderAccountId: 'acct-row' },
    });
    mockApprovalWithIds({ workflowId: WF, taskId: TASK });
    const seen = captureRebuiltContext(svc);
    await svc.resumeFromHitlApproval({ ...makeContext(), messageSenderAccountId: 'acct-live' } as ExecutionContext, 'sched-1');
    expect(seen.context?.messageSenderAccountId).toBe('acct-live');

    const svc2 = new AgentExecutionService();
    stubReconstitution(svc2);
    mockSchedulingRow({});
    mockApprovalWithIds({ workflowId: WF, taskId: TASK });
    const seen2 = captureRebuiltContext(svc2);
    await svc2.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(seen2.context?.messageSenderAccountId).toBeUndefined();
  });

  it('a non-uuid label anywhere in the chain reads as absent, and a real id further down still wins', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({
      workflow_resume_payload: { ...baseScheduledRow.workflow_resume_payload, workflowId: 'not-a-uuid', taskId: 'resume-hitl-x' },
    });
    mockApprovalWithIds({ workflowId: WF, taskId: TASK });
    const seen = captureRebuiltContext(svc);

    await svc.resumeFromHitlApproval({ ...makeContext(), workflowId: 'wf-label' }, 'sched-1');

    expect(seen.context?.workflowId).toBe(WF);
    expect(seen.context?.taskId).toBe(TASK);
  });
});

// ── What woke the run has to survive the pause ────────────────────────────
//
// The rebuild above has always set `trigger: context.trigger`, with a long
// comment explaining that a context rebuilt without the trigger turns every
// acknowledgement into an approval request. That half was right and reached
// nothing: the ONLY production caller is the Cloud Tasks handler's
// `minimalContext`, assembled from a task body carrying tenantId, agentId and
// invocationId. It has never had a trigger to pass — `makeContext()` above is
// that exact shape — so the rebuild read `undefined` on every resume.
//
// It cannot be recovered at resume time: the task body is written by the
// approval router, which knows the approval and not the connector event. The
// pause is the last moment both facts are in hand.
describe('an approved wake tool sleeps instead of continuing', () => {
  it('turns the dispatched wake marker into a wake pause and does not re-enter the loop', async () => {
    // The gate held a sleep_until; the operator approved it. Dispatching it
    // answers with the wake marker. Replayed as a tool result the model would
    // call sleep_until again and the gate would pause again — forever.
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        hitlContext: {
          ...baseScheduledRow.workflow_resume_payload.hitlContext,
          pendingToolCalls: [{ id: 'pc1', name: 'sleep_until', input: { at: '2026-09-15T18:14:38Z', note: 'resume check' } }],
        },
      },
    });
    getApprovalRequestMock.mockResolvedValue({
      id: 'appr-1', tenantId: 't1', agentId: 'a1', decision: 'approved', status: 'approved', decidedBy: 'user-1',
    });
    const marker = { __wakePending: { spec: { kind: 'timer', firesAt: '2026-09-15T18:14:38.000Z', note: 'resume check', label: null }, originTrust: 'trusted', wakeChainDepth: 0 } };
    // A wake tool is gateway-native: neither a standard tool nor a connector's,
    // so it is dispatched through the bridge by its resolved entry, not to a
    // connector named after it.
    const exec = jest.spyOn(
      svc as unknown as { executeToolCalls: (state: unknown, calls: unknown) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockResolvedValue([]);
    dispatchFunctionCallMock.mockResolvedValue(mcpText(marker));
    const loop = jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockResolvedValue({ success: true, toolCallsExecuted: 0, reasoningSteps: 0 });
    const wake = jest.spyOn(
      svc as unknown as { createWakePause: (state: unknown, ctx: unknown, pause: unknown) => Promise<unknown> },
      'createWakePause',
    ).mockResolvedValue({ success: true, paused: true, toolCallsExecuted: 1, reasoningSteps: 0 });

    const result = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(exec).not.toHaveBeenCalled();
    expect(dispatchFunctionCallMock).toHaveBeenCalledTimes(1);
    expect(dispatchFunctionCallMock.mock.calls[0][1]).toBe('sleep_until');
    expect(wake).toHaveBeenCalledTimes(1);
    expect((wake.mock.calls[0][1] as { spec: { kind: string } }).spec.kind).toBe('timer');
    const wakePause = wake.mock.calls[0][2] as {
      pauseReason: string; provider?: string; objective?: string; triggerKey?: string;
      conversationHistory?: Array<{ role: string; toolCallId?: string; content: string }>;
    };
    expect(wakePause.pauseReason).toBe('self_wake');
    // What the wake continuation restores rides on the pause: the objective
    // and owning key, and the transcript through the approved wake call and
    // its marker.
    expect(wakePause.objective).toBe('Send the weekly status report');
    expect(wakePause.triggerKey).toBe('trig-1');
    const tail = wakePause.conversationHistory?.slice(-2) ?? [];
    expect(tail[0]).toMatchObject({ role: 'assistant' });
    expect(tail[1]).toMatchObject({ role: 'tool', toolCallId: 'pc1' });
    expect(tail[1]?.content).toContain('__wakePending');
    expect(loop).not.toHaveBeenCalled();
    expect((result as { paused?: boolean }).paused).toBe(true);
  });
});

// ── Approved-tool dispatch is resolved against the catalog, then routed ─────
//
// Ownership used to be inferred from the name: a standard tool, else whatever
// preceded the first `__` was the connector. A teammate tool, a vendor MCP
// tool, a deferred vendor tool and every gateway-native tool were dispatched
// to a connector named after the tool and failed — a loop a person could
// approve into again and again. The continuation's catalog is now built
// BEFORE the dispatch, each approved call is resolved against it, and the
// resolved entry decides the path. A name the catalog does not hold fails
// closed rather than being guessed at.
describe('approved-tool dispatch resolves against the catalog, then routes', () => {
  function pending(name: string, input: Record<string, unknown> = { a: 1 }, id = 'pc1') {
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        hitlContext: {
          approvalId: 'appr-1',
          pendingToolCalls: [{ id, name, input }],
          gateReason: 'sensitive_work',
          conversationHistory: [{ role: 'user', content: 'do the thing' }],
          provider: 'anthropic',
        },
      },
    });
  }

  function stubContinuation(svc: AgentExecutionService) {
    const seen: { history?: Array<Record<string, unknown>>; completed?: Array<Record<string, unknown>>; executed?: number } = {};
    const loop = jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockImplementation(async (state: unknown) => {
      const s = state as { conversationHistory: Array<Record<string, unknown>>; completedToolCalls: Array<Record<string, unknown>>; toolCallsExecuted: number };
      seen.history = s.conversationHistory;
      seen.completed = s.completedToolCalls;
      seen.executed = s.toolCallsExecuted;
      return { success: true, output: 'done', toolCallsExecuted: 1, reasoningSteps: 1 };
    });
    const exec = jest.spyOn(
      svc as unknown as { executeToolCalls: (state: unknown, calls: Array<Record<string, unknown>>) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockImplementation(async (_s, calls) => calls.map((c) => ({ id: c.id, success: true, result: { via: 'dispatcher' } })));
    return { loop, exec, seen };
  }

  it('a standard tool runs through the dispatcher, which hands it to executeStandardTool', async () => {
    // The real executeToolCalls this time, so the assertion is on the handler
    // the standard-tool path ends at rather than on the request shape alone.
    const { executeStandardTool } = jest.requireMock('../../tools/standard-tool-handler') as { executeStandardTool: jest.Mock };
    executeStandardTool.mockResolvedValue({ success: true, result: { saved: true } });
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    jest.spyOn(svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }, 'buildToolsSchema').mockResolvedValue([]);
    pending('memory_save', { content: 'remember this' });
    mockApproval('approved', 'approved');
    const loop = jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockResolvedValue({ success: true, toolCallsExecuted: 1, reasoningSteps: 1 });

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(executeStandardTool).toHaveBeenCalledTimes(1);
    expect(executeStandardTool.mock.calls[0][0]).toBe('memory_save');
    expect(executeStandardTool.mock.calls[0][1]).toEqual({ content: 'remember this' });
    expect(dispatchFunctionCallMock).not.toHaveBeenCalled();
    expect(loop).toHaveBeenCalled();
  });

  it('a connector alias splits on its first `__` for the dispatcher, as today', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('gmail__send_email', { to: 'x@y.com' });
    mockApproval('approved', 'approved');
    const { exec } = stubContinuation(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1][0]).toMatchObject({ id: 'pc1', connector: 'gmail', actionType: 'send_email', payload: { to: 'x@y.com' } });
    expect(dispatchFunctionCallMock).not.toHaveBeenCalled();
  });

  it('a per-agent Slack tool called by its bare catalog name goes to the dispatcher by family, not through the gateway handler', async () => {
    // The engines that read the catalog call `slack_send_message`, not
    // `agent_slack__slack_send_message`. The gateway's own handler for it
    // re-applies the oversight decision at execute time, so an approved send
    // routed through the bridge would be asked for approval again on its way
    // out. The dispatcher routes it by family and honours the approval.
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('slack_send_message', { channel: 'C1', text: 'hi' });
    mockApproval('approved', 'approved');
    const { exec } = stubContinuation(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(dispatchFunctionCallMock).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1][0]).toMatchObject({
      id: 'pc1', connector: 'agent_slack', entityType: 'agent_slack', actionType: 'slack_send_message', payload: { channel: 'C1', text: 'hi' },
    });
  });

  it('a sandbox primitive is gateway-native and goes through the bridge', async () => {
    const svc = new AgentExecutionService();
    const catalog = fixtureCatalog();
    catalog.tools.push({ name: 'shell_exec', inputSchema: {}, serverId: GATEWAY, source: 'sandbox' });
    stubReconstitution(svc, catalog);
    pending('shell_exec', { command: 'ls' });
    mockApproval('approved', 'approved');
    const { exec } = stubContinuation(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(exec).not.toHaveBeenCalled();
    expect(dispatchFunctionCallMock).toHaveBeenCalledTimes(1);
    expect(dispatchFunctionCallMock.mock.calls[0][1]).toBe('shell_exec');
  });

  it('a teammate tool goes through the bridge by its resolved entry, never to a connector called `internal`', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('internal__code_reviewer__execute', { task: 'review #42' });
    mockApproval('approved', 'approved');
    const { exec, seen } = stubContinuation(svc);
    dispatchFunctionCallMock.mockResolvedValue(mcpText({ accepted: true }));

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(exec).not.toHaveBeenCalled();
    expect(dispatchFunctionCallMock).toHaveBeenCalledTimes(1);
    const [catalog, name, args, ctx, call] = dispatchFunctionCallMock.mock.calls[0] as [McpToolCatalog, string, unknown, Record<string, unknown>, { callId: string }];
    expect(name).toBe('internal__code_reviewer__execute');
    expect(args).toEqual({ task: 'review #42' });
    expect(call).toEqual({ callId: 'pc1' });
    expect(catalog.tools.some((t) => t.name === 'internal__code_reviewer__execute')).toBe(true);
    // The resume-specific bridge context: the person judged the call, so the
    // bridge's own gate is stood down; the run's identity and observer ride.
    expect(ctx.hitlGate).toBeNull();
    expect(ctx.tenantId).toBe('t1');
    expect(typeof ctx.invocationId).toBe('string');
    expect(typeof ctx.abort).toBe('function');
    expect(typeof ctx.toolResultObserver).toBe('function');
    // Released under the same key, in finally.
    expect(releaseAllMock).toHaveBeenCalledWith(ctx.invocationId);
    // Bookkeeping as executeToolCalls keeps it for its own calls.
    expect(seen.completed?.some((c) => c.id === 'pc1' && c.success === true)).toBe(true);
    expect(seen.executed).toBe(1);
  });

  it('the bridge context carries the run observer, and the observed call is what was dispatched', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('internal__code_reviewer__execute', { task: 'review #42' });
    mockApproval('approved', 'approved');
    stubContinuation(svc);
    // Drive the observer the way the bridge does, to show it reaches the
    // seam every adapter dispatch reaches.
    dispatchFunctionCallMock.mockImplementation(async (_c: unknown, name: string, args: unknown, ctx: { toolResultObserver: (o: unknown) => Promise<boolean> }, call: { callId: string }) => {
      const result = mcpText({ accepted: true });
      await ctx.toolResultObserver({ toolName: name, args, callId: call.callId, result });
      return result;
    });

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(rememberExternalToolCallMock).toHaveBeenCalledTimes(1);
    expect(rememberExternalToolCallMock.mock.calls[0][0]).toMatchObject({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv-1', callId: 'pc1',
      toolName: 'internal__code_reviewer__execute', args: { task: 'review #42' },
    });
  });

  it('a vendor MCP tool goes through the bridge', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('mcp__github-dd4c4689__pull_request_read', { owner: 'acme', repo: 'webapp', pullNumber: 42 });
    mockApproval('approved', 'approved');
    const { exec } = stubContinuation(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(exec).not.toHaveBeenCalled();
    expect(dispatchFunctionCallMock).toHaveBeenCalledTimes(1);
    expect(dispatchFunctionCallMock.mock.calls[0][1]).toBe('github-dd4c4689__pull_request_read');
    expect(dispatchFunctionCallMock.mock.calls[0][4]).toEqual({ callId: 'pc1' });
  });

  // The matrix row "provenance requires a read first": judged at consumption
  // on the FINAL call with the same judge the structured resume applies in
  // canUseTool. The snapshot path needs it there, because an approved
  // vendor-hosted write leaves through the bridge with no gate — the one
  // seam that used to let a write out against a record the run never read.
  it('an approved vendor-hosted write held for provenance is answered with the hold and never sent', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('mcp__github-dd4c4689__pull_request_read', { owner: 'acme', repo: 'webapp', pullNumber: 42 });
    mockApproval('approved', 'approved');
    const { loop, exec, seen } = stubContinuation(svc);
    guardExternalMock.mockResolvedValue('Read pull request 42 before acting on it.');

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    // Judged in SDK form on the call's arguments, the way the gate judges a live call.
    expect(guardExternalMock).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'mcp__github-dd4c4689__pull_request_read',
      input: { owner: 'acme', repo: 'webapp', pullNumber: 42 },
    }));
    // Nothing dispatched anywhere; the hold is the call's result.
    expect(exec).not.toHaveBeenCalled();
    expect(dispatchFunctionCallMock).not.toHaveBeenCalled();
    // The hold is the answer; the result also names the call it answers, so
    // the row persists it by name rather than as `unknown`.
    expect(seen.completed).toEqual([expect.objectContaining({ id: 'pc1', success: false, error: 'Read pull request 42 before acting on it.', name: 'mcp__github-dd4c4689__pull_request_read' })]);
    const toolTurn = seen.history?.find((m) => m.role === 'tool' && m.toolCallId === 'pc1');
    expect(String(toolTurn?.content)).toMatch(/Read pull request 42 before acting on it/);
    // The run continues so the model can read and re-propose; no new approval
    // is written and nothing is deferred.
    expect(loop).toHaveBeenCalledTimes(1);
    expect(createApprovalRequestMock).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(queryMock.mock.calls.some((c) => /SET status = 'fired'/.test(String(c[0])))).toBe(true);
  });

  it('a deferred vendor tool is inlined into the catalog it is dispatched against, and dispatched by its remote name', async () => {
    // The REAL bridge for this case, on a fake pooled client, so the assertion
    // is on the name that goes over the wire — the vendor server dispatches on
    // the bare tool name, and the inlined entry is what tells the bridge that.
    const { dispatchFunctionCall } = jest.requireActual('../adapter/mcp-bridge') as { dispatchFunctionCall: (...a: unknown[]) => Promise<unknown> };
    dispatchFunctionCallMock.mockImplementation(dispatchFunctionCall);
    callToolMock.mockResolvedValue(mcpText({ pages: [] }));
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('notion-1a2b3c4d__search_pages', { query: 'roadmap' });
    mockApproval('approved', 'approved');
    const { exec, seen } = stubContinuation(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(exec).not.toHaveBeenCalled();
    expect(dispatchFunctionCallMock).toHaveBeenCalledTimes(1);
    const [catalog, name] = dispatchFunctionCallMock.mock.calls[0] as [McpToolCatalog, string];
    expect(name).toBe('notion-1a2b3c4d__search_pages');
    // The fixture keeps the tool OFF `tools`; the dispatch catalog carries it
    // inlined, so the bridge finds it.
    expect(fixtureCatalog().tools.some((t) => t.name === name)).toBe(false);
    expect(catalog.tools.find((t) => t.name === name)).toMatchObject({ serverId: 'notion-1a2b3c4d', remoteToolName: 'search_pages' });
    // And on the wire, the vendor's bare name with the approved arguments.
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(callToolMock.mock.calls[0][0]).toEqual({ name: 'search_pages', arguments: { query: 'roadmap' } });
    // The observation seam saw it under the call's id, before the result was used.
    expect(rememberExternalToolCallMock).toHaveBeenCalledWith(expect.objectContaining({ callId: 'pc1', toolName: 'notion-1a2b3c4d__search_pages' }));
    expect(seen.completed?.find((c) => c.id === 'pc1')).toMatchObject({ success: true });
  });

  // A name the catalog does not hold is judged at CONSUMPTION, before the row
  // is marked fired: an approved call on a connector or tool the hire no
  // longer has cannot be approved into existence, so the resume ends with a
  // configuration error — nothing dispatches, the row is errored with the
  // reason, the agent is marked failed. The per-call refusal inside the
  // dispatch stays as the last line of defence, but consumption answers first.
  it('an approved call the catalog does not hold is a configuration error: nothing dispatches and the run is over', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('nothing__like_this', { x: 1 });
    mockApproval('approved', 'approved');
    const { loop, exec } = stubContinuation(svc);

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(exec).not.toHaveBeenCalled();
    expect(dispatchFunctionCallMock).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/configuration_error: nothing__like_this names a connector or tool this hire no longer has/);
    // The row is errored under the lease, never fired, and the agent is failed.
    const errored = queryMock.mock.calls.find((c) => /SET status = 'errored'/.test(String(c[0])));
    expect(errored).toBeDefined();
    expect(String(errored![1][2])).toMatch(/configuration_error/);
    expect(queryMock.mock.calls.some((c) => /SET status = 'fired'/.test(String(c[0])))).toBe(false);
    expect(updateRuntimeStatusMock).toHaveBeenCalledWith('a1', 'FAILED');
  });

  it('approved argument edits are what is dispatched, on both paths', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        hitlContext: {
          approvalId: 'appr-1',
          pendingToolCalls: [
            { id: 'pc1', name: 'gmail__send_email', input: { to: 'draft@y.com', body: 'draft' } },
            { id: 'pc2', name: 'internal__code_reviewer__execute', input: { task: 'draft task' } },
          ],
          gateReason: 'sensitive_work',
          conversationHistory: [{ role: 'user', content: 'do the thing' }],
          provider: 'anthropic',
        },
      },
    });
    getApprovalRequestMock.mockResolvedValue({
      id: 'appr-1', tenantId: 't1', agentId: 'a1', decision: 'approved', status: 'approved', decidedBy: 'user-1',
      editedToolInputs: {
        pc1: { to: 'edited@y.com', body: 'edited' },
        pc2: { task: 'edited task' },
      },
    });
    const { exec, seen } = stubContinuation(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(exec.mock.calls[0][1][0]).toMatchObject({ id: 'pc1', payload: { to: 'edited@y.com', body: 'edited' } });
    expect(dispatchFunctionCallMock.mock.calls[0][2]).toEqual({ task: 'edited task' });
    // And the transcript records the edited calls as what was sent.
    const assistantTurn = seen.history?.find((m) => m.role === 'assistant' && Array.isArray(m.toolCalls));
    expect(assistantTurn?.toolCalls).toEqual([
      { id: 'pc1', name: 'gmail__send_email', input: { to: 'edited@y.com', body: 'edited' } },
      { id: 'pc2', name: 'internal__code_reviewer__execute', input: { task: 'edited task' } },
    ]);
  });

  it('results keep the approved calls\' order across the two paths', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        hitlContext: {
          approvalId: 'appr-1',
          pendingToolCalls: [
            { id: 'pc1', name: 'internal__code_reviewer__execute', input: { task: 't' } },
            { id: 'pc2', name: 'gmail__send_email', input: { to: 'x@y.com' } },
            { id: 'pc3', name: 'sleep_until', input: { at: '2026-09-20T00:00:00Z' } },
          ],
          gateReason: 'sensitive_work',
          conversationHistory: [{ role: 'user', content: 'do the thing' }],
          provider: 'anthropic',
        },
      },
    });
    mockApproval('approved', 'approved');
    const { seen } = stubContinuation(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    const toolTurns = (seen.history ?? []).filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    expect(toolTurns).toEqual(['pc1', 'pc2', 'pc3']);
  });

  it('admission denied → neither strategy runs, no dispatch, the resume ends with the reason', async () => {
    // Ahead of BOTH strategies: the structured attempt is made first when a
    // session is saved, so the check sits before it as well as before the
    // snapshot dispatch.
    mockIsAutonomousEnabled.mockReturnValue(true);
    mockLoadRunSession.mockResolvedValue({ sdkSessionId: 'sess-1', jsonlContent: '{}' });
    checkAdmissionMock.mockResolvedValue({ allowed: false, reason: 'billing_suspended' });
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('gmail__send_email', { to: 'x@y.com' });
    mockApproval('approved', 'approved');
    const { loop, exec } = stubContinuation(svc);

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(checkAdmissionMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', agentId: 'a1', checkType: 'task' }));
    expect(res.success).toBe(false);
    expect(res.error).toBe('Admission denied: billing_suspended');
    expect(res.failureClass).toBe('admission_denied');
    expect(mockLoadRunSession).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(dispatchFunctionCallMock).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
    // Nothing to redo: the row is not marked fired and the agent is not moved.
    const fired = queryMock.mock.calls.filter((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes("SET status = 'fired'"));
    expect(fired).toHaveLength(0);
    expect(updateRuntimeStatusMock).not.toHaveBeenCalled();
  });

  it('a bridge that throws becomes a failed result, and the continuation proceeds', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('internal__code_reviewer__execute', { task: 't' });
    mockApproval('approved', 'approved');
    const { loop, seen } = stubContinuation(svc);
    dispatchFunctionCallMock.mockRejectedValue(new Error('server unreachable'));

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(loop).toHaveBeenCalled();
    expect(res.success).toBe(true);
    const toolTurn = seen.history?.find((m) => m.role === 'tool' && m.toolCallId === 'pc1');
    expect(String(toolTurn?.content)).toMatch(/server unreachable/);
    expect(seen.completed?.find((c) => c.id === 'pc1')).toMatchObject({ success: false, error: 'server unreachable' });
    // Released even on the throw.
    expect(releaseAllMock).toHaveBeenCalledTimes(1);
  });

  it('an MCP isError result becomes a failed result, and the continuation proceeds', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('sleep_until', { at: 'not-a-date' });
    mockApproval('approved', 'approved');
    const { loop, seen } = stubContinuation(svc);
    dispatchFunctionCallMock.mockResolvedValue({ ...mcpText({ success: false, error: 'at is not ISO-8601' }), isError: true });

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(loop).toHaveBeenCalled();
    expect(seen.completed?.find((c) => c.id === 'pc1')).toMatchObject({ success: false });
    expect(String(seen.completed?.find((c) => c.id === 'pc1')?.error)).toMatch(/ISO-8601/);
  });

  it('a delegation marker parks the run: createDelegationPause with the approved call as the parent', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    pending('spawn_task_graph', { tasks: [{ agent_id: 'child', objective: 'x' }] }, 'pc-spawn');
    mockApproval('approved', 'approved');
    const { loop } = stubContinuation(svc);
    const marker = { __delegationPending: { parentTaskId: 'parent-1', childTaskIds: ['c1', 'c2'], deadlineAt: '2026-09-17T00:00:00.000Z' } };
    // The bridge stashes the marker on its context with no call id — only its
    // caller knows which call produced it.
    dispatchFunctionCallMock.mockImplementation(async (_c: unknown, _n: string, _a: unknown, ctx: Record<string, unknown>) => {
      ctx.pendingDelegationPause = { ...marker.__delegationPending, parentToolCallId: '' };
      return mcpText(marker);
    });
    const park = jest.spyOn(
      svc as unknown as { createDelegationPause: (state: unknown, pause: unknown) => Promise<unknown> },
      'createDelegationPause',
    ).mockResolvedValue({ success: true, paused: true, toolCallsExecuted: 1, reasoningSteps: 0 });

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(park).toHaveBeenCalledTimes(1);
    const pause = park.mock.calls[0][1] as {
      pauseReason: string; objective?: string; triggerKey?: string; provider?: string;
      delegationContext: { parentTaskId: string; parentToolCallId: string; childTaskIds: string[]; conversationHistory: unknown[] };
    };
    expect(pause.pauseReason).toBe('delegation');
    expect(pause.delegationContext).toMatchObject({ parentTaskId: 'parent-1', parentToolCallId: 'pc-spawn', childTaskIds: ['c1', 'c2'] });
    // The fan-in resume appends the spawn exchange itself, so the snapshot
    // stops before it.
    expect(pause.delegationContext.conversationHistory).toEqual([{ role: 'user', content: 'do the thing' }]);
    expect(pause.objective).toBe('Send the weekly status report');
    expect(pause.triggerKey).toBe('trig-1');
    expect(pause.provider).toBe('anthropic');
    // Resumed from the payload snapshot: there is no canonical record for the
    // new pause to checkpoint, and it says so rather than saying nothing.
    expect((pause as { checkpoint?: unknown }).checkpoint).toEqual({ failed: 'resumed from the payload snapshot; no canonical record' });
    expect(loop).not.toHaveBeenCalled();
    expect((res as { paused?: boolean }).paused).toBe(true);
  });

  it('the continuation reuses the catalog the dispatch was resolved against', async () => {
    const svc = new AgentExecutionService();
    const catalog = fixtureCatalog();
    stubReconstitution(svc, catalog);
    pending('gmail__send_email', { to: 'x@y.com' });
    mockApproval('approved', 'approved');
    let prebuilt: unknown;
    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockImplementation(async (state: unknown) => {
      prebuilt = (state as { context: { prebuiltCatalog?: unknown } }).context.prebuiltCatalog;
      return { success: true, toolCallsExecuted: 1, reasoningSteps: 1 };
    });
    jest.spyOn(
      svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockResolvedValue([{ id: 'pc1', success: true, result: {} }]);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(prebuilt).toBe(catalog);
  });
});

describe('the resumed half runs on what the paused half ran on', () => {
  function captureRebuiltContext(svc: AgentExecutionService) {
    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockResolvedValue({ success: true, toolCallsExecuted: 1, reasoningSteps: 1 });
    const seen: { context?: ExecutionContext } = {};
    jest.spyOn(
      svc as unknown as { executeToolCalls: (state: { context: ExecutionContext }, calls: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockImplementation(async (state, calls) => {
      seen.context = state.context;
      return (calls as Array<{ id: string }>).map((c) => ({ id: c.id, success: true, result: {} }));
    });
    return seen;
  }

  it('resolves the provider and model the pause stamped, not the hire\'s current config', async () => {
    // The hire is configured for anthropic (stubReconstitution); the run paused
    // on google. The adapter is built from the pause's provider, and the model
    // has to follow it — or the Gemini CLI asks Vertex for an Anthropic model.
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        executionEngine: 'google-gemini-cli',
        hitlContext: { ...baseScheduledRow.workflow_resume_payload.hitlContext, provider: 'google', model: 'gemini-3.5-flash' },
      },
    });
    getApprovalRequestMock.mockResolvedValue({
      id: 'appr-1', tenantId: 't1', agentId: 'a1', decision: 'approved', status: 'approved', decidedBy: 'user-1',
    });
    const seen = captureRebuiltContext(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(seen.context?.resolvedProvider).toBe('google');
    expect(seen.context?.resolvedModelId).toBe('gemini-3.5-flash');
  });

  it('leaves the provider to the hire\'s config when the pause predates the stamp', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    getApprovalRequestMock.mockResolvedValue({
      id: 'appr-1', tenantId: 't1', agentId: 'a1', decision: 'approved', status: 'approved', decidedBy: 'user-1',
    });
    const seen = captureRebuiltContext(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(seen.context?.resolvedProvider).toBeUndefined();
    expect(seen.context?.resolvedModelId).toBeUndefined();
  });
});

describe('the trigger survives the pause', () => {
  /** The rebuilt context handed to the continuation. */
  async function rebuiltContextFor(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow(row);
    mockApproval('approved', 'approved');

    let seen: Record<string, unknown> = {};
    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockImplementation(async (state: unknown) => {
      seen = (state as { context: Record<string, unknown> }).context;
      return { success: true, toolCallsExecuted: 0, reasoningSteps: 0 };
    });
    jest.spyOn(
      svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockResolvedValue([{ id: 'pc1', success: true, result: {} }]);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    return seen;
  }

  const EVENT_PAUSE = {
    ...baseScheduledRow.workflow_resume_payload,
    trigger: { kind: 'connector_event', source: 'github' },
    trustLevel: 'untrusted_inbound',
    inputData: { eventData: { repository: 'acme/webapp', number: 42 } },
  };

  it('rebuilds the trigger from the pause payload when the caller has none', async () => {
    // The production shape. Without the fallback this is `undefined`, and both
    // consumers fail silently: `buildTriggerTarget` returns nothing so the
    // in-place carve-out is unreachable, and the trigger-bound rewrite has no
    // host so `trigger__<op>` dispatches as a connector named `trigger`.
    const ctx = await rebuiltContextFor({ workflow_resume_payload: EVENT_PAUSE });

    expect(ctx.trigger).toEqual({ kind: 'connector_event', source: 'github' });
    expect(ctx.trustLevel).toBe('untrusted_inbound');
    expect(ctx.inputData).toEqual({ eventData: { repository: 'acme/webapp', number: 42 } });
  });

  it('leaves the trigger absent when the pause carried none', async () => {
    // Pauses persisted before the field exists must resume exactly as they do
    // today rather than inheriting some other run's trigger.
    const ctx = await rebuiltContextFor({ workflow_resume_payload: baseScheduledRow.workflow_resume_payload });

    expect(ctx.trigger).toBeUndefined();
    expect(ctx.trustLevel).toBeUndefined();
  });

  it('lets a caller that DOES hold the live trigger win', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({ workflow_resume_payload: EVENT_PAUSE });
    mockApproval('approved', 'approved');

    let seen: Record<string, unknown> = {};
    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockImplementation(async (state: unknown) => {
      seen = (state as { context: Record<string, unknown> }).context;
      return { success: true, toolCallsExecuted: 0, reasoningSteps: 0 };
    });
    jest.spyOn(
      svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockResolvedValue([{ id: 'pc1', success: true, result: {} }]);

    const live = { ...makeContext(), trigger: { kind: 'connector_event', source: 'gitlab' } } as ExecutionContext;
    await svc.resumeFromHitlApproval(live, 'sched-1');

    expect(seen.trigger).toEqual({ kind: 'connector_event', source: 'gitlab' });
  });
});

describe('createHitlPause stamps what woke the run', () => {
  it('persists trigger, trustLevel and inputData on the pause payload', async () => {
    // The sending half. Nothing downstream can recover these, so a pause that
    // does not carry them makes the fallback above permanently inert.
    const svc = new AgentExecutionService();
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ id: 'sched-9' }], rowCount: 1 });

    const state = {
      context: {
        ...makeContext(),
        trigger: { kind: 'connector_event', source: 'github' },
        trustLevel: 'untrusted_inbound',
        inputData: { eventData: { repository: 'acme/webapp', number: 42 } },
        modelConfig: { provider: 'anthropic' },
      },
      toolCallsExecuted: 0, reasoningSteps: 0,
    } as unknown as Parameters<AgentExecutionService['createHitlPause']>[0];

    await svc.createHitlPause(state, 'step-1', {
      kind: 'hybrid-pause',
      pauseReason: 'hitl_approval',
      currentStepId: 'step-1',
      resumeAfterStepId: 'step-1',
      stepOutput: null,
      inputData: undefined,
      perStepRecoveries: {},
      totalRecoveries: 0,
      recoveryHistory: [],
      hitlContext: { approvalId: 'appr-9', pendingToolCalls: [], gateReason: 'sensitive_work' },
    });

    const insert = queryMock.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_scheduled_invocations'),
    );
    expect(insert).toBeDefined();
    const persisted = JSON.parse((insert![1] as unknown[])[8] as string);
    expect(persisted.trigger).toEqual({ kind: 'connector_event', source: 'github' });
    expect(persisted.trustLevel).toBe('untrusted_inbound');
    expect(persisted.inputData).toEqual({ eventData: { repository: 'acme/webapp', number: 42 } });
  });

  // The run's ids ride the same stamp, so a resume rebuilt from a bare task
  // body can write real ids to the uuid columns that reference them.
  async function persistedPauseFor(
    context: Partial<ExecutionContext>,
    pauseOverrides: { workflowId?: string; taskId?: string } = {},
  ) {
    const svc = new AgentExecutionService();
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ id: 'sched-9' }], rowCount: 1 });
    const state = {
      context: { ...makeContext(), modelConfig: { provider: 'anthropic' }, ...context },
      toolCallsExecuted: 0, reasoningSteps: 0,
    } as unknown as Parameters<AgentExecutionService['createHitlPause']>[0];
    await svc.createHitlPause(state, 'step-1', {
      kind: 'hybrid-pause', pauseReason: 'hitl_approval',
      currentStepId: 'step-1', resumeAfterStepId: 'step-1', stepOutput: null, inputData: undefined,
      perStepRecoveries: {}, totalRecoveries: 0, recoveryHistory: [],
      hitlContext: { approvalId: 'appr-9', pendingToolCalls: [], gateReason: 'sensitive_work' },
      ...pauseOverrides,
    });
    const insert = queryMock.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_scheduled_invocations'),
    );
    return JSON.parse((insert![1] as unknown[])[8] as string) as { workflowId?: string; taskId?: string };
  }

  it('persists the run workflowId and taskId on the pause payload', async () => {
    const persisted = await persistedPauseFor({
      workflowId: '8d48512f-c961-4cee-87f2-a71e2664e8af',
      taskId: 'd347ba93-7e22-4cbe-8e6c-0f3ad65852a9',
    });
    expect(persisted.workflowId).toBe('8d48512f-c961-4cee-87f2-a71e2664e8af');
    expect(persisted.taskId).toBe('d347ba93-7e22-4cbe-8e6c-0f3ad65852a9');
  });

  it('never persists a blank as if it were an id', async () => {
    // makeContext() carries blank ids; a stamped blank would resurface at
    // resume as a value and be written to a uuid column.
    const persisted = await persistedPauseFor({ workflowId: '', taskId: '' });
    expect(persisted.workflowId).toBeUndefined();
    expect(persisted.taskId).toBeUndefined();
  });

  it('a blank already on the pause payload does not shadow the live context id', async () => {
    // A payload assembled from an earlier task body can arrive carrying a
    // blank. Merging with `??=` would keep it; the stamp must take the real id.
    const persisted = await persistedPauseFor(
      { workflowId: '8d48512f-c961-4cee-87f2-a71e2664e8af', taskId: 'd347ba93-7e22-4cbe-8e6c-0f3ad65852a9' },
      { workflowId: '', taskId: '' },
    );
    expect(persisted.workflowId).toBe('8d48512f-c961-4cee-87f2-a71e2664e8af');
    expect(persisted.taskId).toBe('d347ba93-7e22-4cbe-8e6c-0f3ad65852a9');
  });

  it('a real id already on the pause payload is kept over the context', async () => {
    const persisted = await persistedPauseFor(
      { workflowId: '11111111-1111-4111-8111-111111111111', taskId: '22222222-2222-4222-8222-222222222222' },
      { workflowId: '8d48512f-c961-4cee-87f2-a71e2664e8af', taskId: 'd347ba93-7e22-4cbe-8e6c-0f3ad65852a9' },
    );
    expect(persisted.workflowId).toBe('8d48512f-c961-4cee-87f2-a71e2664e8af');
    expect(persisted.taskId).toBe('d347ba93-7e22-4cbe-8e6c-0f3ad65852a9');
  });

  it('persists the originating account on the pause payload, and never a blank', async () => {
    const withAccount = await persistedPauseFor({ messageSenderAccountId: 'acct-7' } as Partial<ExecutionContext>) as { messageSenderAccountId?: string };
    expect(withAccount.messageSenderAccountId).toBe('acct-7');
    const blank = await persistedPauseFor({ messageSenderAccountId: '' } as Partial<ExecutionContext>) as { messageSenderAccountId?: string };
    expect(blank.messageSenderAccountId).toBeUndefined();
  });

  it('a non-uuid label is not an id: it is neither persisted nor allowed to shadow one', async () => {
    // A trace-style label is a string, but the column would reject it exactly
    // as it rejects a blank.
    const persisted = await persistedPauseFor(
      { workflowId: 'resume-hitl-abc', taskId: '8d48512f-c961-4cee-87f2-a71e2664e8af' },
      { workflowId: 'not-a-uuid' },
    );
    expect(persisted.workflowId).toBeUndefined();
    expect(persisted.taskId).toBe('8d48512f-c961-4cee-87f2-a71e2664e8af');
  });
});


// An approval must be FOR the calls being dispatched.
//
// The tamper hash is checked when a person approves, against the approval's own
// copy of the pending calls. What runs is a DIFFERENT persisted record — the
// pause's `hitlContext.pendingToolCalls` on the scheduled invocation — and
// nothing compared the two. The window matters: this dispatch runs with the
// HITL gate deliberately bypassed, so it is the one moment nothing else would
// object to the wrong call going out.
describe('the dispatch-time fingerprint', () => {
  it('refuses when the approval is not for the calls this pause holds', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    hashToolCallsMock.mockReturnValue('hash-of-what-the-pause-holds');
    getApprovalRequestMock.mockResolvedValue({
      id: 'appr-1',
      status: 'approved',
      decision: 'approved',
      toolCallsHash: 'hash-of-something-else',
      pendingToolCalls: [],
      editedToolInputs: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/does not match the tool calls/);
  });
});

// ── Blank-reply floor ─────────────────────────────────────────────────────
//
// A resumed run can settle with no assistant text — the model emitted only
// tool calls, or the continuation produced nothing. PB posts the settle reply
// only when it is non-empty, so an empty string settled the durable chat run
// with a NULL message and the user saw a blank bubble (the live item-9 E2E hit
// exactly this). closeMcpChatRunForResume substitutes an honest,
// terminal-state-derived line so the settled reply is never empty.
describe('blank-reply floor on resume settlement', () => {
  function stubResumeWithOutput(svc: AgentExecutionService, output: unknown) {
    jest.spyOn(
      svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockResolvedValue([{ id: 'pc1', success: true, result: {} }]);
    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockResolvedValue({ success: true, output, toolCallsExecuted: 1, reasoningSteps: 1 });
  }

  it('empty resume output → settles the chat run with an honest non-empty reply', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    mockApproval('approved', 'approved');
    stubResumeWithOutput(svc, '');

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(settleMcpChatRunMock).toHaveBeenCalled();
    const arg = settleMcpChatRunMock.mock.calls[0][0] as { outcome: string; replyText: string };
    expect(arg.outcome).toBe('completed');
    expect(arg.replyText.trim().length).toBeGreaterThan(0);
    // Honest floor: describes the run's outcome ("processed") and NEVER claims a
    // specific action was carried out — this settles rejected resumes too, and no
    // dispatch evidence reaches here, so asserting execution would be fabrication.
    expect(arg.replyText.toLowerCase()).toContain('processed');
    expect(arg.replyText.toLowerCase()).not.toContain('carried out');
  });

  it('stopped resume → floor says stopped, never "carried out"', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    mockApproval('approved', 'approved');
    // A user-stopped run: empty output + a stopped terminal state.
    jest.spyOn(
      svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockResolvedValue([{ id: 'pc1', success: true, result: {} }]);
    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockResolvedValue({ success: false, stopped: true, terminalState: 'stopped', output: '', toolCallsExecuted: 1, reasoningSteps: 1 });

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    const arg = settleMcpChatRunMock.mock.calls[0][0] as { replyText: string };
    expect(arg.replyText.toLowerCase()).toContain('stopped');
    expect(arg.replyText.toLowerCase()).not.toContain('carried out');
  });

  it('whitespace-only resume output → floor still fires', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    mockApproval('approved', 'approved');
    stubResumeWithOutput(svc, '   \n  ');

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    const arg = settleMcpChatRunMock.mock.calls[0][0] as { replyText: string };
    expect(arg.replyText.trim().length).toBeGreaterThan(0);
  });

  it('non-empty resume output → settles with that exact reply (floor does not fire)', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    mockSchedulingRow({});
    mockApproval('approved', 'approved');
    stubResumeWithOutput(svc, 'The message has been sent.');

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    const arg = settleMcpChatRunMock.mock.calls[0][0] as { replyText: string };
    expect(arg.replyText).toBe('The message has been sent.');
  });
});

// ── The gated step completes on resume; it does not re-run ────────────────
//
// A workflow HITL pause resumes through the snapshot-replay path
// (dispatchApprovedAndContinue): tryStructuredHitlResume bails because a
// workflow-step pause snapshots no conversation. That path used to (a) rebuild a
// resumeState carrying only the recovery counters — dropping the stepOutputs
// registry the rest of the graph reads, so a multistep resume hit the
// back-reference guard and hard-failed — and (b) pin the cursor to the GATED
// step, which re-ran it and re-issued the just-approved outbound call. The fix
// restores the full saved state and completes the gated step from the approved
// results, then advances.
describe('workflow HITL resume completes the gated step and advances (no re-run)', () => {
  it('rebuilt resumeState carries the FULL saved loop state, not just recovery counters', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    // A pause with real accumulated state: s0 ran before the gate.
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        currentStepId: 'step-1',
        resumeAfterStepId: 'step-1',
        stepOutputs: { s0: { v: 1 } },
        enteredSteps: ['s0'],
        unsatisfiedSteps: [],
      },
    });
    mockApproval('approved', 'approved');

    let captured: Record<string, unknown> | undefined;
    jest.spyOn(
      svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> },
      'runAgentHybridLoop',
    ).mockImplementation(async (...a: unknown[]) => {
      captured = a[3] as Record<string, unknown>;  // (state, objective, inputData, resumeState, adapter)
      return { success: true, output: 'ok', toolCallsExecuted: 1, reasoningSteps: 1 };
    });
    jest.spyOn(
      svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockResolvedValue([{ id: 'pc1', success: true, result: { messageId: 'm1' } }]);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(captured).toBeDefined();
    // The registry the remaining graph reads survived the pause — dropping it is
    // what turned a multistep resume into the back-reference hard-fail.
    expect(captured!.stepOutputs).toEqual({ s0: { v: 1 } });
    expect(captured!.enteredSteps).toEqual(['s0']);
    expect(captured!.unsatisfiedSteps).toEqual([]);
    // And the approved tool results are threaded across for the gated-step prologue.
    expect(captured!.stepOutput).toMatchObject({ __approvedToolResults__: expect.any(Array) });
  });

  it('an approval inside a multistep workflow: the gated call runs ONCE and the run advances to the next step', async () => {
    const svc = new AgentExecutionService();
    // Two-step graph: step-1 is the gated step (its approved call is
    // gmail__send_email); step-2 runs after it. If the resume re-ran step-1 it
    // would dispatch gmail a SECOND time.
    const workflow: unknown[] = [
      { stepId: 'step-1', type: 'tool_call', description: 'send', toolName: 'gmail__send_email',
        toolInput: { to: 'x@y.com' }, outputField: 'messageId', onSuccess: 'step-2' },
      { stepId: 'step-2', type: 'tool_call', description: 'post', toolName: 'slack__post_message',
        toolInput: { text: 'done' }, onSuccess: '' },
    ];
    (svc as unknown as { getActiveInstruction: (...a: unknown[]) => Promise<unknown> }).getActiveInstruction =
      jest.fn().mockResolvedValue({ version: 1, instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' }, integrations: [{ id: 'gmail', type: 'google_mail' }, { id: 'slack', type: 'slack' }] });
    (svc as unknown as { loadRuntimeConfig: (...a: unknown[]) => Promise<unknown> }).loadRuntimeConfig =
      jest.fn().mockResolvedValue({ workflowSteps: workflow, modelConfig: { provider: 'anthropic' }, execConfig: {}, memoryScope: {}, hitlLevel: 3 });
    (svc as unknown as { buildPlatformMcpCatalog: (...a: unknown[]) => Promise<unknown> }).buildPlatformMcpCatalog =
      jest.fn().mockResolvedValue(fixtureCatalog());

    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        currentStepId: 'step-1',
        resumeAfterStepId: 'step-1',
        stepOutputs: {},
        enteredSteps: [],
        unsatisfiedSteps: [],
        hitlContext: {
          approvalId: 'appr-1',
          pendingToolCalls: [{ id: 'pc1', name: 'gmail__send_email', input: { to: 'x@y.com' } }],
          gateReason: 'communication_review',
        },
      },
    });
    mockApproval('approved', 'approved');

    // Run the REAL runAgentHybridLoop; stub only the leaves. buildToolsSchema is
    // stubbed to keep the catalog out of it; executeToolCalls records every call.
    jest.spyOn(svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }, 'buildToolsSchema')
      .mockResolvedValue([]);
    jest.spyOn(svc as unknown as { checkAbortSignal: (...a: unknown[]) => Promise<boolean> }, 'checkAbortSignal')
      .mockResolvedValue(false);
    jest.spyOn(svc as unknown as { checkUserInterruptSignal: (...a: unknown[]) => Promise<unknown> }, 'checkUserInterruptSignal')
      .mockResolvedValue(null);

    const dispatched: Array<{ connector: string; actionType: string }> = [];
    jest.spyOn(
      svc as unknown as { executeToolCalls: (s: unknown, calls: Array<Record<string, unknown>>) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockImplementation(async (_s, calls) => {
      for (const c of calls) dispatched.push({ connector: c.connector as string, actionType: c.actionType as string });
      return calls.map((c) => ({ id: c.id, success: true, result: { messageId: 'm1' } }));
    });

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    // The gated call (gmail) dispatched exactly ONCE — by dispatchApprovedAndContinue,
    // NOT again by a re-run of step-1.
    const gmailCalls = dispatched.filter((d) => d.connector === 'gmail');
    expect(gmailCalls).toHaveLength(1);
    // And the run advanced past the gated step: step-2's tool ran.
    const slackCalls = dispatched.filter((d) => d.connector === 'slack');
    expect(slackCalls).toHaveLength(1);
  });
});

// ── A FAILED approved call must not advance down onSuccess ─────────────────
//
// Approval authorises an ATTEMPT, not a result. The resume prologue used to file
// the failed result's payload as the step output and advance to onSuccess, so a
// failed send stepped straight into the next announcement. A dispatch failure must
// enter failure handling: the declared onFailure branch, or a closed run with the
// cause — never onSuccess.
describe('workflow HITL resume routes a failed approved call to failure, not onSuccess', () => {
  function setupWorkflow(svc: AgentExecutionService, workflow: unknown[]) {
    (svc as unknown as { getActiveInstruction: (...a: unknown[]) => Promise<unknown> }).getActiveInstruction =
      jest.fn().mockResolvedValue({ version: 1, instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' }, integrations: [{ id: 'gmail', type: 'google_mail' }, { id: 'slack', type: 'slack' }] });
    (svc as unknown as { loadRuntimeConfig: (...a: unknown[]) => Promise<unknown> }).loadRuntimeConfig =
      jest.fn().mockResolvedValue({ workflowSteps: workflow, modelConfig: { provider: 'anthropic' }, execConfig: {}, memoryScope: {}, hitlLevel: 3 });
    (svc as unknown as { buildPlatformMcpCatalog: (...a: unknown[]) => Promise<unknown> }).buildPlatformMcpCatalog =
      jest.fn().mockResolvedValue(fixtureCatalog());
    jest.spyOn(svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }, 'buildToolsSchema').mockResolvedValue([]);
    jest.spyOn(svc as unknown as { checkAbortSignal: (...a: unknown[]) => Promise<boolean> }, 'checkAbortSignal').mockResolvedValue(false);
    jest.spyOn(svc as unknown as { checkUserInterruptSignal: (...a: unknown[]) => Promise<unknown> }, 'checkUserInterruptSignal').mockResolvedValue(null);
  }

  // gmail (the gated call) FAILS on dispatch; everything else succeeds.
  function dispatchWhereGmailFails(svc: AgentExecutionService) {
    const dispatched: Array<{ connector: string; actionType: string }> = [];
    jest.spyOn(
      svc as unknown as { executeToolCalls: (s: unknown, calls: Array<Record<string, unknown>>) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockImplementation(async (_s, calls) => {
      for (const c of calls) dispatched.push({ connector: c.connector as string, actionType: c.actionType as string });
      return calls.map((c) => c.connector === 'gmail'
        ? { id: c.id, success: false, error: 'SMTP 550 mailbox unavailable' }
        : { id: c.id, success: true, result: { ok: true } });
    });
    return dispatched;
  }

  const GATED_PENDING = {
    approvalId: 'appr-1',
    pendingToolCalls: [{ id: 'pc1', name: 'gmail__send_email', input: { to: 'x@y.com' } }],
    gateReason: 'communication_review',
  };

  it('routes to the declared onFailure branch and does NOT run the onSuccess step', async () => {
    const svc = new AgentExecutionService();
    setupWorkflow(svc, [
      { stepId: 'step-1', type: 'tool_call', description: 'send', toolName: 'gmail__send_email',
        toolInput: { to: 'x@y.com' }, onSuccess: 'step-2', onFailure: 'step-err' },
      { stepId: 'step-2', type: 'tool_call', description: 'announce', toolName: 'slack__post_message',
        toolInput: { text: 'sent' }, onSuccess: '' },
      { stepId: 'step-err', type: 'tool_call', description: 'page on-call', toolName: 'pager__notify',
        toolInput: { msg: 'send failed' }, onSuccess: '' },
    ]);
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        currentStepId: 'step-1', resumeAfterStepId: 'step-1',
        stepOutputs: {}, enteredSteps: [], unsatisfiedSteps: [],
        hitlContext: GATED_PENDING,
      },
    });
    mockApproval('approved', 'approved');
    const dispatched = dispatchWhereGmailFails(svc);

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    // gmail attempted once (by dispatchApprovedAndContinue) and it failed.
    expect(dispatched.filter((d) => d.connector === 'gmail')).toHaveLength(1);
    // The onSuccess step (slack) must NOT have run — a failed send does not announce.
    expect(dispatched.filter((d) => d.connector === 'slack')).toHaveLength(0);
    // The onFailure branch ran instead.
    expect(dispatched.filter((d) => d.connector === 'pager')).toHaveLength(1);
  });

  it('fails the run closed when the failed step has no onFailure (no advance, no re-dispatch)', async () => {
    const svc = new AgentExecutionService();
    setupWorkflow(svc, [
      { stepId: 'step-1', type: 'tool_call', description: 'send', toolName: 'gmail__send_email',
        toolInput: { to: 'x@y.com' }, onSuccess: 'step-2' },
      { stepId: 'step-2', type: 'tool_call', description: 'announce', toolName: 'slack__post_message',
        toolInput: { text: 'sent' }, onSuccess: '' },
    ]);
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        currentStepId: 'step-1', resumeAfterStepId: 'step-1',
        stepOutputs: {}, enteredSteps: [], unsatisfiedSteps: [],
        hitlContext: GATED_PENDING,
      },
    });
    mockApproval('approved', 'approved');
    const dispatched = dispatchWhereGmailFails(svc);

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/mailbox unavailable/);
    // gmail attempted once; the onSuccess step never ran.
    expect(dispatched.filter((d) => d.connector === 'gmail')).toHaveLength(1);
    expect(dispatched.filter((d) => d.connector === 'slack')).toHaveLength(0);
  });

  it('an ADAPTER step that falls to snapshot replay fails closed — never substitutes the raw approved result', async () => {
    // An llm_reason/capability step's output is the continuation of its model
    // turn. When structured session resume cannot engage (no persisted session),
    // the snapshot path cannot reconstruct that output, so it must fail the step
    // closed rather than file the approved call's raw result as the step output
    // (which would also fail a declared outputField). Even though the approved
    // call SUCCEEDS, the onSuccess step must not run.
    const svc = new AgentExecutionService();
    setupWorkflow(svc, [
      { stepId: 'step-1', type: 'llm_reason', description: 'draft + send', onSuccess: 'step-2', onFailure: 'step-err' },
      { stepId: 'step-2', type: 'tool_call', description: 'announce', toolName: 'slack__post_message',
        toolInput: { text: 'sent' }, onSuccess: '' },
      { stepId: 'step-err', type: 'tool_call', description: 'page on-call', toolName: 'pager__notify',
        toolInput: { msg: 'step could not resume' }, onSuccess: '' },
    ]);
    // No workflowStepSession, autonomous resume off → structured resume bails → snapshot path.
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        currentStepId: 'step-1', resumeAfterStepId: 'step-1',
        stepOutputs: {}, enteredSteps: [], unsatisfiedSteps: [],
        hitlContext: GATED_PENDING,
      },
    });
    mockApproval('approved', 'approved');
    // Every dispatch SUCCEEDS — the point is the adapter step still fails closed.
    const dispatched: Array<{ connector: string }> = [];
    jest.spyOn(
      svc as unknown as { executeToolCalls: (s: unknown, calls: Array<Record<string, unknown>>) => Promise<unknown[]> },
      'executeToolCalls',
    ).mockImplementation(async (_s, calls) => {
      for (const c of calls) dispatched.push({ connector: c.connector as string });
      return calls.map((c) => ({ id: c.id, success: true, result: { ok: true } }));
    });

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');

    // The approved send dispatched once; the onSuccess announcement never ran.
    expect(dispatched.filter((d) => d.connector === 'gmail')).toHaveLength(1);
    expect(dispatched.filter((d) => d.connector === 'slack')).toHaveLength(0);
    // The onFailure branch ran instead — the step failed closed, not substituted.
    expect(dispatched.filter((d) => d.connector === 'pager')).toHaveLength(1);
  });
});

// ── The pause checkpoint on the snapshot path ─────────────────────────────────
//
// The snapshot path decides its transcript BEFORE its decision line: the
// pause's own checkpoint (pause_checkpoints, keyed by the resumed row) when it
// loads, verifies and holds the gated call, else the payload snapshot with the
// reason. What the loop is handed is asserted in
// resume-continuation-checkpoint.test.ts; this proves the resume's wiring.
describe('resumeFromHitlApproval — the transcript decision on the snapshot path', () => {
  const PENDING = { id: 'pc1', name: 'gmail__send_email', input: { to: 'x@y.com' } };
  /** The record the paused engine accumulated: the user turn, the gated call. */
  const RECORD: CanonicalMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'send the email' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Sending.' }, { type: 'tool_use', id: 'toolu_1', name: 'gmail__send_email', input: { to: 'x@y.com' } }] },
  ];
  const SHA = sha256(canonicalSerialize(RECORD));

  function seedCheckpointRow(overrides: Record<string, unknown> = {}) {
    tenantClientQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM pause_checkpoints') && params[1] === 'sched-1') {
        return {
          rows: [{
            agent_id: 'a1', invocation_id: 'inv-1', execution_engine: 'claude-agent-sdk', provider: 'anthropic', model: 'm',
            canonical_content: JSON.parse(JSON.stringify(RECORD)), canonical_schema_version: '1.1', canonical_sha256: SHA, message_count: 2,
            ...overrides,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  function conversationalRow(checkpoint: unknown) {
    mockSchedulingRow({
      workflow_resume_payload: {
        ...baseScheduledRow.workflow_resume_payload,
        executionEngine: 'claude-agent-sdk',
        currentStepId: 'conversational', resumeAfterStepId: 'conversational',
        checkpoint,
        hitlContext: {
          ...baseScheduledRow.workflow_resume_payload.hitlContext,
          pendingToolCalls: [PENDING],
          conversationHistory: [{ role: 'user', content: 'send the email' }],
          provider: 'anthropic',
        },
      },
    });
  }

  function spyLoop(svc: AgentExecutionService) {
    let captured: ExecutionContext | undefined;
    jest.spyOn(svc as unknown as { runAgentHybridLoop: (...a: unknown[]) => Promise<unknown> }, 'runAgentHybridLoop')
      .mockImplementation(async (state) => {
        captured = (state as { context: ExecutionContext }).context;
        return { success: true, toolCallsExecuted: 0, reasoningSteps: 1 };
      });
    return () => captured;
  }

  function decisionLine(info: jest.SpyInstance) {
    return info.mock.calls.map((c) => c[0] as Record<string, unknown>).find((f) => f.event === 'resume_decision');
  }

  it('reads the checkpoint the pause wrote, verifies it against the lease, and says so on the decision line', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    seedCheckpointRow();
    conversationalRow({ id: 'sched-1', sha256: SHA, messageCount: 2 });
    mockApproval('approved', 'approved');
    jest.spyOn(svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> }, 'executeToolCalls')
      .mockResolvedValue([{ id: 'pc1', success: true, result: { messageId: 'm-1' } }]);
    const context = spyLoop(svc);
    const info = jest.spyOn(scrubLogger, 'info');

    const res = await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(res.success).toBe(true);

    // Loaded under the tenant, by the resumed row.
    expect(tenantClientQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM pause_checkpoints'), ['t1', 'sched-1']);
    expect(decisionLine(info)).toMatchObject({
      resume_kind: 'hitl_approval', strategy: 'snapshot_replay',
      transcript_source: 'checkpoint', transcript_reason: null, checkpoint_sha256: SHA, checkpoint_message_count: 2,
    });
    // The loop is entered with the completed record: the gated call answered
    // once, under the record's own id, with the approved result.
    const transcript = context()?.resumeTranscript;
    expect(transcript).toBeDefined();
    const blocks = transcript!.messages.flatMap((m) => m.content);
    expect(blocks.filter((b) => b.type === 'tool_use' && b.callId === 'toolu_1')).toHaveLength(1);
    const result = blocks.find((b) => b.type === 'tool_result' && b.callId === 'toolu_1') as { result: unknown } | undefined;
    expect(result?.result).toBe(JSON.stringify({ messageId: 'm-1' }));
    expect(context()?.resumeUserTurn).toContain('gmail__send_email: completed');
  });

  it('a sha the pause does not carry → the snapshot, with the reason on the decision line', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    seedCheckpointRow();
    conversationalRow({ id: 'sched-1', sha256: 'stale', messageCount: 2 });
    mockApproval('approved', 'approved');
    jest.spyOn(svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> }, 'executeToolCalls')
      .mockResolvedValue([{ id: 'pc1', success: true, result: {} }]);
    const context = spyLoop(svc);
    const info = jest.spyOn(scrubLogger, 'info');

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(decisionLine(info)).toMatchObject({
      transcript_source: 'snapshot', transcript_reason: 'checkpoint sha256 differs from the one the pause carries', checkpoint_sha256: null,
    });
    expect(context()?.resumeTranscript).toBeUndefined();
  });

  it('a checkpoint for another invocation than the one the lease names → the snapshot', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    seedCheckpointRow({ invocation_id: 'inv-other' });
    conversationalRow({ id: 'sched-1', sha256: SHA, messageCount: 2 });
    mockApproval('rejected', 'rejected');
    spyLoop(svc);
    const info = jest.spyOn(scrubLogger, 'info');

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(decisionLine(info)).toMatchObject({
      strategy: 'snapshot_replay_rejected',
      transcript_source: 'snapshot', transcript_reason: 'checkpoint invocation is not the paused invocation',
    });
  });

  it('a workflow-step pause takes the snapshot path and says so', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    seedCheckpointRow();
    // baseScheduledRow pauses at step-1: a workflow step, whatever it carries.
    mockSchedulingRow({ workflow_resume_payload: { ...baseScheduledRow.workflow_resume_payload, checkpoint: { id: 'sched-1', sha256: SHA, messageCount: 2 } } });
    mockApproval('approved', 'approved');
    jest.spyOn(svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<unknown[]> }, 'executeToolCalls')
      .mockResolvedValue([{ id: 'pc1', success: true, result: {} }]);
    spyLoop(svc);
    const info = jest.spyOn(scrubLogger, 'info');

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(decisionLine(info)).toMatchObject({ transcript_source: 'snapshot', transcript_reason: 'workflow step' });
    expect(tenantClientQueryMock).not.toHaveBeenCalled();
  });

  it('a pause written before the checkpoint existed takes the snapshot path and says so', async () => {
    const svc = new AgentExecutionService();
    stubReconstitution(svc);
    conversationalRow(undefined);
    mockApproval('rejected', 'rejected');
    spyLoop(svc);
    const info = jest.spyOn(scrubLogger, 'info');

    await svc.resumeFromHitlApproval(makeContext(), 'sched-1');
    expect(decisionLine(info)).toMatchObject({ transcript_source: 'snapshot', transcript_reason: 'pause carries no checkpoint' });
  });
});
