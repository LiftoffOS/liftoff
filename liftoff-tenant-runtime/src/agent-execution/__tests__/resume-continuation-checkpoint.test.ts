// The approved continuation runs the objective again — the two fixes.
//
// Fix 1: the resumed half opens on a continuation turn that names the call
// and its outcome, never on the objective re-issued as a fresh task. Asserted
// on the messages handed to `adapter.invoke()`, which is the only place the
// property is a fact rather than an intention.
//
// Fix 2: the canonical transcript is checkpointed WITH the pause — its own
// row, keyed by the pause row it belongs to, written and awaited before that
// row — and a resume completes the pending call in the record BEFORE the
// repair, repairs, converts for the engine it runs on, and hands the adapter a
// transcript with exactly one tool result per tool use and the continuation
// turn last. Any miss replays the payload snapshot and says so.
//
// Deterministic, no live calls. The conversational loop is driven for real
// with a scripted adapter; the pool and the tenant-scoped client are fakes
// that record what was written and serve it back, the way the database would
// (a jsonb column returns parsed content).

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const createApprovalRequestMock = jest.fn();
const getOversightSettingsMock = jest.fn();
const checkHitlGateMock = jest.fn();
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    createApprovalRequest: (...a: unknown[]) => createApprovalRequestMock(...a),
    getOversightSettings: (...a: unknown[]) => getOversightSettingsMock(...a),
    checkHitlGate: (...a: unknown[]) => checkHitlGateMock(...a),
    hashToolCalls: jest.fn().mockReturnValue('h'),
    approvalExistsForIdempotencyKey: jest.fn().mockResolvedValue(false),
  },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));

// ── The database fakes ───────────────────────────────────────────────────────
//
// `poolMock.query` is the unscoped pool every pause row goes through;
// `tenantClientQueryMock` is the client `withTenantScope` hands its callback,
// which is where the checkpoint table is read and written. Both record every
// call in ORDER on one shared log, so the test can assert the checkpoint
// insert happened before the pause row insert.
const callLog: Array<{ via: 'pool' | 'tenant'; sql: string; params: unknown[] }> = [];
const queryMock = jest.fn();
const tenantClientQueryMock = jest.fn();
const withTenantScopeMock = jest.fn();
const poolMock = { query: queryMock, connect: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => poolMock),
  getPool: jest.fn(() => poolMock),
  pool: poolMock,
  withTenantScope: (...a: unknown[]) => withTenantScopeMock(...a),
}));

const updateRuntimeStatusMock = jest.fn().mockResolvedValue(undefined);
const getAgentMock = jest.fn();
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: updateRuntimeStatusMock,
    getAgent: (...a: unknown[]) => getAgentMock(...a),
  })),
}));

const enqueueAgentExecutionMock = jest.fn();
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: (...a: unknown[]) => enqueueAgentExecutionMock(...a),
}));

const claimWakeForResumeMock = jest.fn();
const persistWakeResultMock = jest.fn();
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {
    claimWakeForResume: (...a: unknown[]) => claimWakeForResumeMock(...a),
    heartbeatWakeLease: jest.fn().mockResolvedValue(undefined),
    releaseWakeLease: jest.fn().mockResolvedValue(undefined),
    markWakeErrored: jest.fn().mockResolvedValue(undefined),
    bumpResumeRate: jest.fn().mockResolvedValue(0),
    persistWakeResult: (...a: unknown[]) => persistWakeResultMock(...a),
    settleWake: jest.fn().mockResolvedValue(undefined),
    updateCloudTaskName: jest.fn().mockResolvedValue(undefined),
    rearmPoll: jest.fn().mockResolvedValue(undefined),
    fireWaitSetMember: jest.fn().mockResolvedValue(true),
    cancelWaitSetMembers: jest.fn().mockResolvedValue([]),
    countUnfiredWaitSetMembers: jest.fn().mockResolvedValue(0),
    insert: jest.fn().mockResolvedValue({ id: 'row-1' }),
  },
}));
jest.mock('../../scheduling/wake-wait-set-repo', () => ({
  wakeWaitSetRepo: {
    claimForResume: jest.fn(),
    heartbeat: jest.fn().mockResolvedValue(undefined),
    releaseLease: jest.fn().mockResolvedValue(undefined),
    markErrored: jest.fn().mockResolvedValue(undefined),
    persistResult: jest.fn().mockResolvedValue(true),
    settle: jest.fn().mockResolvedValue(undefined),
    getById: jest.fn(),
    insert: jest.fn().mockResolvedValue('ws-1'),
  },
}));

const insertAuditLogMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../audit', () => ({ insertAuditLog: (...a: unknown[]) => insertAuditLogMock(...a) }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../streaming', () => ({
  streamingService: {
    emitHitlRequired: jest.fn(),
    emitHitlRejected: jest.fn(),
    emitToolStart: jest.fn(),
    emitToolComplete: jest.fn(),
    emitToolError: jest.fn(),
    emitTextDelta: jest.fn(),
  },
}));
jest.mock('../../agent-chat/agent-slack-client', () => ({
  postReviewDm: jest.fn(),
  listAgentAssignees: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../tool-gateway/agent-slack-tool-catalog', () => ({
  SLACK_OUTBOUND_TOOL_NAMES: new Set(),
  AGENT_SLACK_TOOL_NAMES: [],
}));
jest.mock('../../action-ledger/record-external-tool-call', () => ({
  recordExternalToolCall: jest.fn().mockResolvedValue(undefined),
  triggerTargetOf: () => null,
}));
jest.mock('../hitl-side-effects', () => ({
  emitHitlApprovalSideEffects: jest.fn().mockResolvedValue(undefined),
}));
// The coordinator's child-task store the delegation fan-in reads its results
// from: one completed child.
jest.mock('../../coordinator/repository', () => ({
  ChildTaskRepository: jest.fn().mockImplementation(() => ({
    findByParentTaskId: jest.fn().mockResolvedValue([{ id: 'child-1', status: 'completed', result: { finding: 'Acme leads' }, error: null }]),
  })),
}));

// The adapter, stubbed: each case scripts what `invoke` yields, and the
// recorder the loop registers is kept so a case can feed it what a real
// engine would have recorded before it paused.
const adapterInvokeMock = jest.fn();
const adapterPauseMock = jest.fn().mockResolvedValue({ adapterKind: 'anthropic', serialized: 'tok' });
let registeredRecorder: { recordRaw: (e: Record<string, unknown>) => void } | null = null;
function stubAdapter() {
  return {
    invoke: adapterInvokeMock,
    pause: adapterPauseMock,
    resume: jest.fn(),
    registerToolCatalog: jest.fn(),
    registerHitlGate: jest.fn(),
    registerAnomalyHandler: jest.fn(),
    registerTrajectoryRecorder: (r: { recordRaw: (e: Record<string, unknown>) => void }) => { registeredRecorder = r; },
  };
}
jest.mock('../adapter', () => ({
  createAdapter: jest.fn(() => stubAdapter()),
  constructAdapterForEngine: jest.fn(() => stubAdapter()),
}));
jest.mock('../adapter/mcp-bridge', () => ({
  ...jest.requireActual('../adapter/mcp-bridge'),
  dispatchFunctionCall: jest.fn(),
}));
jest.mock('../adapter/mcp-client-pool', () => ({
  getMcpClientPool: () => ({ acquire: jest.fn(), releaseAll: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('../remember-external-tool-call', () => ({
  ...jest.requireActual('../remember-external-tool-call'),
  rememberExternalToolCall: jest.fn().mockResolvedValue('recorded'),
}));
jest.mock('../../tool-gateway/capability-approval-signal', () => ({
  recordCapabilityApproval: jest.fn(),
  capabilityApprovalKey: () => null,
  capabilityHandleNeedsApproval: () => false,
  consumeCapabilityApproval: jest.fn(),
}));

jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({
  ...jest.requireActual('../../llm/pricing'),
  calculateCost: jest.fn().mockReturnValue(null),
}));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: jest.fn().mockReturnValue({
    guardExternal: async () => null,
    observeExternal: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn(),
    executeBatch: jest.fn(),
  }),
}));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''),
  getTenantRuntimeUrl: jest.fn().mockReturnValue(''),
  tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
const checkAdmissionMock = jest.fn();
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: (...a: unknown[]) => checkAdmissionMock(...a) })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({ recordUsage: jest.fn().mockResolvedValue(undefined) })) }));
jest.mock('../../execution-environments/agent-lock', () => ({
  tryAcquireAgentLock: jest.fn().mockResolvedValue({ id: 'lk' }),
  releaseAgentLock: jest.fn().mockResolvedValue(undefined),
}));
const seedProvenanceFromContextMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../tool-gateway/record-provenance', () => ({
  ...jest.requireActual('../../tool-gateway/record-provenance'),
  seedProvenanceFromTrigger: jest.fn().mockResolvedValue(0),
  seedProvenanceFromEvent: jest.fn().mockResolvedValue(undefined),
  seedProvenanceFromContext: (...a: unknown[]) => seedProvenanceFromContextMock(...a),
}));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getFeatureFlags: jest.fn().mockResolvedValue({}),
    getEntitlements: jest.fn().mockResolvedValue({}),
    getModelForTask: jest.fn().mockResolvedValue(null),
  }),
}));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
const createInvocationMock = jest.fn();
jest.mock('../../invocations', () => ({
  invocationsService: {
    listInvocations: jest.fn().mockResolvedValue({ invocations: [] }),
    createInvocation: (...a: unknown[]) => createInvocationMock(...a),
    completeInvocation: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../agent-lifecycle/types', () => ({ trustLevelFor: jest.fn().mockReturnValue('trusted') }));
jest.mock('../run-state/service', () => ({
  agentRunStateService: { appendItem: jest.fn().mockResolvedValue(undefined), create: jest.fn().mockResolvedValue(undefined), load: jest.fn().mockResolvedValue(null), save: jest.fn() },
}));
jest.mock('../untrusted-input', () => ({
  formatInputForPrompt: jest.fn(),
  formatUntrustedSystemPromptDirective: jest.fn().mockReturnValue(''),
}));
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: jest.fn().mockResolvedValue([]),
  buildSkillContextBlock: jest.fn().mockReturnValue(''),
  skillDisclosureMode: jest.fn().mockReturnValue('inline'),
}));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: {} }));
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: jest.fn(() => null),
  postSkillFeedback: jest.fn(),
  getWakeThreadRevision: jest.fn().mockResolvedValue(null),
  getWakeThreadInfo: jest.fn().mockResolvedValue(null),
  settleMcpChatRunViaCallback: jest.fn(),
}));
jest.mock('../../interactive-chat/chat-turn-handler', () => ({
  loadChatSessionJsonl: jest.fn().mockResolvedValue(null),
  buildSessionStateDir: () => '/tmp/sess/dir',
  ensureSessionStateDir: jest.fn().mockResolvedValue(undefined),
  restoreSessionJsonlToDisk: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../interactive-chat/locks', () => ({
  tryAcquireLock: jest.fn().mockResolvedValue({ id: 'lock' }),
  releaseLock: jest.fn().mockResolvedValue(undefined),
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
jest.mock('../autonomous-session', () => ({
  isAutonomousResumeEnabled: () => false,
  loadRunSession: jest.fn().mockResolvedValue(null),
  restoreRunSessionToDisk: jest.fn().mockResolvedValue(undefined),
  autonomousSessionDir: (tk: string) => `/tmp/sess/${tk}`,
  ensureRunSessionDir: jest.fn().mockResolvedValue(undefined),
  saveRunSession: jest.fn().mockResolvedValue(true),
  readRunSessionJsonl: jest.fn().mockResolvedValue(null),
  prepareAutonomousSession: jest.fn(),
}));

import { AgentExecutionService } from '../service';
import type { HybridResumeState } from '../service';
import type { ExecutionState, ExecutionContext, ExecuteTaskInput, ToolCallResult } from '../types';
import type { PlatformMessage, PlatformContent } from '../adapter/types';
import type { CanonicalMessage } from '../../trajectories/types';
import { scrubLogger } from '../../observability/scrub-logger';
import { sha256, canonicalSerialize } from '../session-artifact-envelope';
import { releaseBuffer } from '../../trajectories/recorder';
import { firstTurnPrompt } from '../adapter/conversation-preamble';
import {
  loadPauseCheckpoint,
  completePendingCalls,
  findPendingCallInRecord,
  checkpointToAdapterInput,
  writePauseCheckpoint,
} from '../pause-checkpoint';
import { approvedContinuationTurn, rejectedContinuationTurn } from '../resume-continuation-turn';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OBJECTIVE = 'Research the three main competitors and email Dana a summary.';
const WRAPPED_OBJECTIVE = `Please complete the following task: ${OBJECTIVE}`;
const SEND_INPUT = { to: 'dana@example.com', subject: 'Competitor summary', body: 'Acme, Globex and Initech.' };

/** The record a real engine would have accumulated before the gate fired: the
 *  user turn (the loop records it), the assistant's research call and its
 *  result, and the gated send — proposed and answered by nothing. */
function recordThroughGatedCall(sendCallId = 'toolu_send'): CanonicalMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: WRAPPED_OBJECTIVE }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Searching for the competitors first.' },
        { type: 'tool_use', id: 'toolu_search', name: 'web_search', input: { query: 'main competitors' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_search', content: 'Acme, Globex and Initech.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Found them. Sending the summary to Dana.' },
        { type: 'tool_use', id: sendCallId, name: 'gmail__send_email', input: SEND_INPUT },
      ],
    },
  ];
}

/** The pause payload a conversational HITL pause writes, with the flattened
 *  snapshot the resume replayed until now and the checkpoint reference. */
function hitlPayload(overrides: Partial<HybridResumeState> = {}, hitlOverrides: Partial<NonNullable<HybridResumeState['hitlContext']>> = {}): HybridResumeState {
  return {
    kind: 'hybrid-pause',
    pauseReason: 'hitl_approval',
    executionEngine: 'claude-agent-sdk',
    currentStepId: 'conversational',
    resumeAfterStepId: 'conversational',
    stepOutput: 'Found them. Sending the summary to Dana.',
    objective: OBJECTIVE,
    triggerKey: 'trig-1',
    inputData: undefined,
    perStepRecoveries: {},
    totalRecoveries: 0,
    recoveryHistory: [],
    hitlContext: {
      approvalId: 'appr-1',
      // The gate mints its own id for a pending call and never sees the
      // engine's — the record holds the call under `toolu_send`.
      pendingToolCalls: [{ id: 'pending-abc', name: 'gmail__send_email', input: SEND_INPUT }],
      gateReason: 'communication_review',
      conversationHistory: [
        { role: 'user', content: WRAPPED_OBJECTIVE },
        { role: 'assistant', content: 'Searching for the competitors first.' },
        { role: 'assistant', content: 'Found them. Sending the summary to Dana.' },
      ],
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      ...hitlOverrides,
    },
    ...overrides,
  };
}

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    tenantId: 't1', agentId: 'a1', workflowId: 'wf1', taskId: 'tk1',
    instructionVersion: 1,
    instruction: { systemPrompt: 's', allowedConnectors: [] } as unknown as ExecutionContext['instruction'],
    traceId: 'tr-1',
    agentType: 'agent',
    hitlLevel: 3,
    modelConfig: { provider: 'anthropic', modelId: 'claude-sonnet-5' } as ExecutionContext['modelConfig'],
    resolvedProvider: 'anthropic',
    resolvedModelId: 'claude-sonnet-5',
    resumeEngine: 'claude-agent-sdk',
    execConfig: {} as ExecutionContext['execConfig'],
    memoryScope: {} as ExecutionContext['memoryScope'],
    invocationId: 'inv-1',
    triggerKey: 'trig-1',
    oversight: { communication: 'review' } as ExecutionContext['oversight'],
    ...overrides,
  } as ExecutionContext;
}

function makeState(overrides: Partial<ExecutionContext> = {}): ExecutionState {
  return {
    context: makeContext(overrides),
    reasoningSteps: 0,
    toolCallsExecuted: 0,
    startTime: new Date(),
    steps: [],
    conversationHistory: [],
    pendingToolCalls: [],
    completedToolCalls: [],
    toolFailureCounts: new Map(),
    injectedSkillIds: [],
  } as ExecutionState;
}

function stubLoopDeps(svc: AgentExecutionService) {
  (svc as unknown as { buildPlatformMcpCatalog: (...a: unknown[]) => Promise<unknown> }).buildPlatformMcpCatalog =
    jest.fn().mockResolvedValue({ servers: [], tools: [] });
  (svc as unknown as { buildToolsSchema: (...a: unknown[]) => Promise<unknown[]> }).buildToolsSchema =
    jest.fn().mockResolvedValue([]);
  (svc as unknown as { buildSystemPrompt: (...a: unknown[]) => Promise<string> }).buildSystemPrompt =
    jest.fn().mockResolvedValue('SYSTEM');
  (svc as unknown as { checkAbortSignal: (...a: unknown[]) => Promise<boolean> }).checkAbortSignal =
    jest.fn().mockResolvedValue(false);
  (svc as unknown as { checkUserInterruptSignal: (...a: unknown[]) => Promise<unknown> }).checkUserInterruptSignal =
    jest.fn().mockResolvedValue(null);
}

/** The engine answers the continuation with one line and ends. */
function scriptCompletion(text = 'Done. Dana has the summary.') {
  adapterInvokeMock.mockImplementation(async function* () {
    yield { type: 'assistant_message', content: [{ type: 'text', text }] };
    yield { type: 'completion', outcome: 'success' };
  });
}

/** A consumed grant for the fixture's one pending call, routed to the
 *  dispatcher; `executeToolCalls` is patched to answer it. */
function grantFor(input: Record<string, unknown> = SEND_INPUT) {
  const call = { id: 'pending-abc', name: 'gmail__send_email', input };
  return {
    approvalId: 'appr-1',
    finalCalls: [call],
    fingerprint: 'fp',
    routes: [{
      call,
      ownership: 'connector' as const,
      dispatchPath: 'execute_tool_calls' as const,
      resolvedName: 'gmail__send_email',
      request: { id: 'pending-abc', connector: 'gmail', entityType: 'email', actionType: 'send_email', payload: input },
    }],
    holds: {},
  };
}

function approval(decision: 'approved' | 'rejected', rejectionReason?: string) {
  return { id: 'appr-1', tenantId: 't1', agentId: 'a1', decision, status: 'decided', decidedBy: 'user-1', rejectionReason };
}

/** What the adapter was handed, flattened for assertions. */
type Handed = { messages: PlatformMessage[] };
function handed(): Handed {
  expect(adapterInvokeMock).toHaveBeenCalledTimes(1);
  return adapterInvokeMock.mock.calls[0][0] as Handed;
}
function textOf(m: PlatformMessage): string {
  return m.content.filter((c): c is Extract<PlatformContent, { type: 'text' }> => c.type === 'text').map((c) => c.text).join('');
}
function blocks(messages: PlatformMessage[]): PlatformContent[] {
  return messages.flatMap((m) => m.content);
}
function lastUser(messages: PlatformMessage[]): PlatformMessage {
  const users = messages.filter((m) => m.role === 'user');
  return users[users.length - 1];
}

/** The checkpoint rows the fake tenant client holds, keyed by pause id. The
 *  fake serves what was inserted back on SELECT, with canonical_content
 *  parsed — a jsonb column returns objects, never the string that was sent. */
const checkpointRows = new Map<string, Record<string, unknown>>();
let checkpointInsertFails = false;
let checkpointInsertRowCount = 1;

function installTenantClient() {
  withTenantScopeMock.mockImplementation(async (tenantId: string, fn: (client: { query: typeof tenantClientQueryMock }) => Promise<unknown>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        callLog.push({ via: 'tenant', sql, params });
        tenantClientQueryMock(tenantId, sql, params);
        if (sql.includes('INSERT INTO pause_checkpoints')) {
          if (checkpointInsertFails) throw new Error('connection reset');
          const [tenant, pauseId, invocationId, agentId, engine, provider, model, content, schemaVersion, sha, messageCount] = params as [string, string, string | null, string, string, string, string, string, string, string, number];
          checkpointRows.set(pauseId, {
            tenant_id: tenant, pause_id: pauseId, invocation_id: invocationId, agent_id: agentId, execution_engine: engine,
            provider, model, canonical_content: JSON.parse(content), canonical_schema_version: schemaVersion,
            canonical_sha256: sha, message_count: messageCount,
          });
          return { rows: [], rowCount: checkpointInsertRowCount };
        }
        if (sql.includes('DELETE FROM pause_checkpoints')) {
          const [, pauseId] = params as [string, string];
          checkpointRows.delete(pauseId);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('FROM pause_checkpoints')) {
          const [tenant, pauseId] = params as [string, string];
          const row = checkpointRows.get(pauseId);
          return { rows: row && row.tenant_id === tenant ? [row] : [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  });
}

/** Put a checkpoint row in place directly, the way a pause would have. */
function seedCheckpoint(pauseId: string, messages: CanonicalMessage[], extra: Partial<{ tenant_id: string; agent_id: string; invocation_id: string | null; execution_engine: string }> = {}) {
  const sha = sha256(canonicalSerialize(messages));
  checkpointRows.set(pauseId, {
    tenant_id: 't1', pause_id: pauseId, invocation_id: 'inv-1', agent_id: 'a1', execution_engine: 'claude-agent-sdk',
    provider: 'anthropic', model: 'claude-sonnet-5', canonical_content: JSON.parse(JSON.stringify(messages)),
    canonical_schema_version: '1.1', canonical_sha256: sha, message_count: messages.length,
    ...extra,
  });
  return { id: pauseId, sha256: sha, messageCount: messages.length };
}

function decisionLine(info: jest.SpyInstance): Record<string, unknown> | undefined {
  return info.mock.calls.map((c) => c[0] as Record<string, unknown>).find((f) => f.event === 'resume_decision');
}

beforeEach(() => {
  jest.clearAllMocks();
  callLog.length = 0;
  checkpointRows.clear();
  checkpointInsertFails = false;
  checkpointInsertRowCount = 1;
  registeredRecorder = null;
  releaseBuffer('inv-1');
  releaseBuffer('inv-2');
  installTenantClient();
  getAgentMock.mockResolvedValue({ id: 'a1', lifecycle: 'ACTIVE' });
  checkAdmissionMock.mockResolvedValue({ allowed: true });
  getOversightSettingsMock.mockResolvedValue({ communication: 'review', sensitiveWork: {} });
  checkHitlGateMock.mockResolvedValue({ shouldGate: false });
  createApprovalRequestMock.mockResolvedValue({ id: 'appr-1', expiresAt: new Date() });
  enqueueAgentExecutionMock.mockResolvedValue({ taskName: 't' });
  persistWakeResultMock.mockResolvedValue(true);
  // The unscoped pool: every pause row insert answers with the id it was
  // given, the way RETURNING id does; everything else answers empty.
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    callLog.push({ via: 'pool', sql, params });
    if (typeof sql === 'string' && sql.includes('INSERT INTO agent_scheduled_invocations')) {
      return { rows: [{ id: params[params.length - 1] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});

// ── Drivers ──────────────────────────────────────────────────────────────────

async function resumeApproved(
  svc: AgentExecutionService,
  payload: HybridResumeState,
  transcript: unknown,
  result: ToolCallResult = { id: 'pending-abc', success: true, result: { messageId: 'm-1' } },
  input: Record<string, unknown> = SEND_INPUT,
) {
  stubLoopDeps(svc);
  (svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<ToolCallResult[]> }).executeToolCalls =
    jest.fn().mockResolvedValue([result]);
  const state = makeState();
  // The caller's decision line, handed in and written once by the dispatcher
  // with the transcript it actually replayed.
  const logDecision = jest.fn();
  const res = await (svc as unknown as {
    dispatchApprovedAndContinue: (...a: unknown[]) => Promise<{ success: boolean; output?: string }>;
  }).dispatchApprovedAndContinue(state, payload, approval('approved'), stubAdapter(), grantFor(input), transcript, logDecision);
  return { state, res, logDecision };
}

async function resumeRejected(svc: AgentExecutionService, payload: HybridResumeState, transcript: unknown, reason = 'Do not email Dana directly.') {
  stubLoopDeps(svc);
  const state = makeState();
  const logDecision = jest.fn();
  const res = await (svc as unknown as {
    dispatchRejectedAndContinue: (...a: unknown[]) => Promise<{ success: boolean; output?: string }>;
  }).dispatchRejectedAndContinue(state, payload, approval('rejected', reason), stubAdapter(), transcript, logDecision);
  return { state, res, logDecision };
}

/** The transcript decision the resume would have made, built the way
 *  resumeFromHitlApproval builds it, off the fake checkpoint store. */
async function decide(svc: AgentExecutionService, payload: HybridResumeState, pauseId = 'sched-1', pausedInvocationId: string | null = 'inv-1', engine = 'claude-agent-sdk') {
  return (svc as unknown as {
    decideHitlResumeTranscript: (a: unknown) => Promise<{ source: string; reason?: string; calls?: Map<string, { id: string; name: string }> }>;
  }).decideHitlResumeTranscript({
    state: makeState({ resumeEngine: engine as ExecutionContext['resumeEngine'] }),
    payload,
    scheduledInvocationId: pauseId,
    pausedInvocationId,
    resumeEngine: engine,
  });
}

async function runConversational(svc: AgentExecutionService, state: ExecutionState, objective: string, resumeState?: HybridResumeState) {
  return (svc as unknown as {
    runConversationalTurnsViaAdapter: (
      state: ExecutionState, objective: string, inputData: Record<string, unknown> | undefined, adapter: unknown, resumeState?: unknown,
    ) => Promise<{ success: boolean; paused?: boolean; output?: string }>;
  }).runConversationalTurnsViaAdapter(state, objective, undefined, stubAdapter(), resumeState);
}

// ═════════════════════════════════════════════════════════════════════════════
// Fix 1 — the continuation turn
// ═════════════════════════════════════════════════════════════════════════════
describe('Fix 1: the resumed half opens on the continuation turn, not the objective', () => {
  it('approved: the messages handed to adapter.invoke() end with a turn naming the call and its outcome', async () => {
    const svc = new AgentExecutionService();
    scriptCompletion();
    const { state } = await resumeApproved(svc, hitlPayload(), { source: 'snapshot', reason: 'pause carries no checkpoint' });

    const { messages } = handed();
    const last = lastUser(messages);
    expect(textOf(last)).toBe(approvedContinuationTurn(
      [{ id: 'pending-abc', name: 'gmail__send_email' }],
      [{ id: 'pending-abc', success: true, result: { messageId: 'm-1' } }],
    ));
    expect(textOf(last)).toContain('gmail__send_email: completed');
    expect(textOf(last)).toContain('Do not send or perform this action again');
    expect(textOf(last)).not.toContain('Please complete the following task');
    // The objective's task framing appears exactly once: the turn that opened
    // the paused run, restored at the head. Never re-issued.
    expect(messages.filter((m) => textOf(m).includes('Please complete the following task'))).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(textOf(messages[0])).toBe(WRAPPED_OBJECTIVE);
    // Set the way the plan says: the turn, never the suppression.
    expect(state.context.resumeUserTurn).toBe(textOf(last));
    expect(state.context.skipInitialPromptPush).toBeUndefined();
  });

  it('approved: a failed dispatch is named as failed, so the model does not build on an outcome that never happened', async () => {
    const svc = new AgentExecutionService();
    scriptCompletion();
    await resumeApproved(svc, hitlPayload(), { source: 'snapshot', reason: 'x' }, { id: 'pending-abc', success: false, error: 'gmail: quota exceeded' });
    expect(textOf(lastUser(handed().messages))).toContain('gmail__send_email: failed (gmail: quota exceeded)');
  });

  it('rejected: the turn names the rejection and its reason, and asks for completion without the call', async () => {
    const svc = new AgentExecutionService();
    scriptCompletion('Understood. I will summarise here instead.');
    const { state } = await resumeRejected(svc, hitlPayload(), { source: 'snapshot', reason: 'x' });

    const { messages } = handed();
    const last = lastUser(messages);
    expect(textOf(last)).toBe(rejectedContinuationTurn([{ id: 'pending-abc', name: 'gmail__send_email' }], 'Do not email Dana directly.'));
    expect(textOf(last)).toContain('rejected it, giving this reason: Do not email Dana directly.');
    expect(textOf(last)).toContain('gmail__send_email: not carried out');
    expect(messages.filter((m) => textOf(m).includes('Please complete the following task'))).toHaveLength(1);
    expect(state.context.skipInitialPromptPush).toBeUndefined();
  });

  it('the wording covers one call and several, and a reason that was not given', () => {
    expect(approvedContinuationTurn([{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }], [{ id: 'a', success: true }, { id: 'b', success: false, error: 'nope' }]))
      .toMatch(/actions you proposed and approved them[\s\S]*- x: completed\n- y: failed \(nope\)/);
    expect(approvedContinuationTurn([{ id: 'a', name: 'x' }], [])).toContain('- x: no result was recorded');
    expect(rejectedContinuationTurn([{ id: 'a', name: 'x' }], undefined)).toMatch(/rejected it\. It was not carried out/);
    expect(rejectedContinuationTurn([{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }], '  ')).toMatch(/rejected them\. They were not carried out/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 2 — the checkpoint, written with the pause
// ═════════════════════════════════════════════════════════════════════════════
describe('Fix 2: the checkpoint is written and awaited before the pause row exists', () => {
  /** The engine records what a real one would before the gate fires: its
   *  research turn, the search result, and the gated send. */
  function scriptGatedPause() {
    adapterInvokeMock.mockImplementation(async function* () {
      const record = recordThroughGatedCall();
      for (const m of record.slice(1)) {
        registeredRecorder!.recordRaw({ invocationId: 'inv-1', provider: 'anthropic', model: 'claude-sonnet-5', rawKind: 'anthropic_sdk_message', raw: m });
      }
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'Searching for the competitors first.' }] };
      yield { type: 'assistant_message', content: [{ type: 'text', text: 'Found them. Sending the summary to Dana.' }] };
      yield {
        type: 'pause_requested', reason: 'hitl_gate', token: { adapterKind: 'anthropic', serialized: 'tok' },
        gateContext: { gateReason: 'communication_review', pendingToolCalls: [{ id: 'pending-abc', name: 'gmail__send_email', input: SEND_INPUT }] },
      };
    });
  }

  function pauseInsert() {
    const insert = callLog.find((c) => c.via === 'pool' && c.sql.includes('INSERT INTO agent_scheduled_invocations'));
    expect(insert).toBeDefined();
    return insert!;
  }

  it('the checkpoint insert lands before the pause row, and the row names it by id, sha and size', async () => {
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    scriptGatedPause();

    const result = await runConversational(svc, makeState(), OBJECTIVE);
    expect(result.paused).toBe(true);

    const checkpointAt = callLog.findIndex((c) => c.via === 'tenant' && c.sql.includes('INSERT INTO pause_checkpoints'));
    const pauseAt = callLog.findIndex((c) => c.via === 'pool' && c.sql.includes('INSERT INTO agent_scheduled_invocations'));
    expect(checkpointAt).toBeGreaterThanOrEqual(0);
    expect(pauseAt).toBeGreaterThan(checkpointAt);
    // Under the tenant's scope, never the bare pool.
    expect(withTenantScopeMock).toHaveBeenCalledWith('t1', expect.any(Function), 'scheduled-execution');

    const insert = pauseInsert();
    const rowId = insert.params[insert.params.length - 1] as string;
    const payload = JSON.parse(insert.params[8] as string) as HybridResumeState;
    expect(payload.checkpoint).toEqual({ id: rowId, sha256: expect.any(String), messageCount: 4 });
    const stored = checkpointRows.get(rowId)!;
    expect(stored).toMatchObject({ tenant_id: 't1', agent_id: 'a1', invocation_id: 'inv-1', execution_engine: 'claude-agent-sdk', provider: 'anthropic', model: 'claude-sonnet-5', canonical_schema_version: '1.1', message_count: 4 });
    expect(stored.canonical_sha256).toBe((payload.checkpoint as { sha256: string }).sha256);
    // The record is complete from its first user turn and ends on the gated
    // call, answered by nothing.
    const messages = stored.canonical_content as CanonicalMessage[];
    expect(messages[0].role).toBe('user');
    expect((messages[0].content[0] as { text: string }).text).toContain(`Please complete the following task:\n\n${OBJECTIVE}`);
    const tail = messages[messages.length - 1];
    expect(tail.content.some((b) => b.type === 'tool_use' && b.id === 'toolu_send')).toBe(true);
    expect(messages.some((m) => m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_send'))).toBe(false);
  });

  it('a failed insert stamps checkpoint.failed with the reason, and the pause row still lands', async () => {
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    scriptGatedPause();
    checkpointInsertFails = true;

    const result = await runConversational(svc, makeState(), OBJECTIVE);
    expect(result.paused).toBe(true);
    const payload = JSON.parse(pauseInsert().params[8] as string) as HybridResumeState;
    expect(payload.checkpoint).toEqual({ failed: 'insert failed: connection reset' });
  });

  it('an insert that wrote no row is a failure, not a checkpoint', async () => {
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    scriptGatedPause();
    checkpointInsertRowCount = 0;

    await runConversational(svc, makeState(), OBJECTIVE);
    const payload = JSON.parse(pauseInsert().params[8] as string) as HybridResumeState;
    expect(payload.checkpoint).toEqual({ failed: 'insert wrote 0 rows' });
  });

  it('with no recorder registered the checkpoint says so', async () => {
    const ref = await writePauseCheckpoint({
      tenantId: 't1', agentId: 'a1', pauseId: 'p-1', invocationId: 'inv-1',
      source: { recorderInvocationId: 'inv-1', recorderRegistered: false, engine: 'claude-agent-sdk', provider: 'anthropic', model: 'm' },
    });
    expect(ref).toEqual({ failed: 'no recorder' });
    expect(withTenantScopeMock).not.toHaveBeenCalled();
  });

  it('the self_wake, delegation and ask_user pauses in the loop carry a checkpoint too', async () => {
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    const MARKER = JSON.stringify({ __wakePending: { spec: { kind: 'timer', firesAt: '2026-09-17T10:00:00.000Z' }, originTrust: 'trusted', wakeChainDepth: 0 } });
    adapterInvokeMock.mockImplementation(async function* () {
      registeredRecorder!.recordRaw({ invocationId: 'inv-1', provider: 'anthropic', model: 'm', rawKind: 'anthropic_sdk_message', raw: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-wake', name: 'sleep_until', input: { at: '2026-09-17T10:00:00Z' } }] } });
      yield { type: 'tool_call_started', toolName: 'sleep_until', args: { at: '2026-09-17T10:00:00Z' }, callId: 'call-wake' };
      yield { type: 'tool_call_finished', callId: 'call-wake', result: { content: [{ type: 'text', text: MARKER }] } };
      yield { type: 'pause_requested', reason: 'self_wake', token: { adapterKind: 'anthropic', serialized: 'tok' }, wakeContext: { spec: { kind: 'timer', firesAt: '2026-09-17T10:00:00.000Z' }, originTrust: 'trusted', wakeChainDepth: 0 } };
    });
    const wake = await runConversational(svc, makeState(), OBJECTIVE);
    expect(wake.paused).toBe(true);
    const wakePayload = JSON.parse(pauseInsert().params[8] as string) as HybridResumeState;
    expect(wakePayload.pauseReason).toBe('self_wake');
    expect(wakePayload.checkpoint).toEqual({ id: expect.any(String), sha256: expect.any(String), messageCount: 2 });
    const wakeRowId = pauseInsert().params[pauseInsert().params.length - 1];
    expect((wakePayload.checkpoint as { id: string }).id).toBe(wakeRowId);

    // ask_user through the loop's pause_requested default branch.
    callLog.length = 0;
    poolMock.connect.mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [{ id: 'clar-1' }], rowCount: 1 }), release: jest.fn() });
    adapterInvokeMock.mockImplementation(async function* () {
      yield { type: 'pause_requested', reason: 'ask_user', token: { adapterKind: 'anthropic', serialized: 'tok' } };
    });
    const ask = await runConversational(svc, makeState(), OBJECTIVE);
    expect(ask.paused).toBe(true);
    const checkpointWrites = callLog.filter((c) => c.via === 'tenant' && c.sql.includes('INSERT INTO pause_checkpoints'));
    expect(checkpointWrites).toHaveLength(1);
  });

  it('a workflow-step pause writes no checkpoint: createHitlPause with no source stamps nothing', async () => {
    const svc = new AgentExecutionService();
    const state = makeState({ workflowSteps: [{ stepId: 's1', description: 'd', type: 'tool_call', toolName: 'gmail__send_email' }] } as Partial<ExecutionContext>);
    const res = await svc.createHitlPause(state, 's1', hitlPayload({ currentStepId: 's1', resumeAfterStepId: 's1' }));
    expect(res.paused).toBe(true);
    const payload = JSON.parse(pauseInsert().params[8] as string) as HybridResumeState;
    expect(payload.checkpoint).toBeUndefined();
    expect(callLog.filter((c) => c.via === 'tenant')).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 2 — identity and fallback
// ═════════════════════════════════════════════════════════════════════════════
describe('Fix 2: the resume verifies the checkpoint is this pause\'s, and replays the snapshot on any miss', () => {
  const record = recordThroughGatedCall();

  it('loads and verifies a checkpoint that matches on every axis', async () => {
    const ref = seedCheckpoint('sched-1', record);
    const loaded = await loadPauseCheckpoint({ tenantId: 't1', agentId: 'a1', pauseId: 'sched-1', pausedInvocationId: 'inv-1', ref });
    expect(loaded).toMatchObject({ ok: true, checkpoint: { sha256: ref.sha256, messageCount: 4, sourceEngine: 'claude-agent-sdk' } });
  });

  it.each([
    ['a pause with no checkpoint', () => undefined, 'inv-1', 'pause carries no checkpoint'],
    ['a checkpoint that failed at the pause', () => ({ failed: 'insert failed: x' }), 'inv-1', 'checkpoint failed at the pause: insert failed: x'],
    ['an id that names another pause', () => ({ ...seedCheckpoint('sched-1', record), id: 'sched-9' }), 'inv-1', 'checkpoint id is not the pause being resumed'],
    ['a sha the payload does not carry', () => ({ ...seedCheckpoint('sched-1', record), sha256: 'deadbeef' }), 'inv-1', 'checkpoint sha256 differs from the one the pause carries'],
    ['an invocation that is not the paused one', () => seedCheckpoint('sched-1', record), 'inv-other', 'checkpoint invocation is not the paused invocation'],
    ['a row that is missing', () => ({ id: 'sched-1', sha256: 'x', messageCount: 1 }), 'inv-1', 'checkpoint row missing or expired'],
    ['a row for another agent', () => seedCheckpoint('sched-1', record, { agent_id: 'a2' }), 'inv-1', 'checkpoint belongs to another agent'],
  ])('%s → the snapshot path, with the reason', async (_label, ref, pausedInvocationId, reason) => {
    const loaded = await loadPauseCheckpoint({ tenantId: 't1', agentId: 'a1', pauseId: 'sched-1', pausedInvocationId, ref: ref() });
    expect(loaded).toEqual({ ok: false, reason });
  });

  it('a row whose content no longer matches its sha is declined as corrupt', async () => {
    const ref = seedCheckpoint('sched-1', record);
    const row = checkpointRows.get('sched-1')!;
    row.canonical_content = [{ role: 'user', content: [{ type: 'text', text: 'tampered' }] }];
    const loaded = await loadPauseCheckpoint({ tenantId: 't1', agentId: 'a1', pauseId: 'sched-1', pausedInvocationId: 'inv-1', ref });
    expect(loaded).toEqual({ ok: false, reason: 'checkpoint content does not match its sha256' });
  });

  it('the HITL resume takes the snapshot path on a mismatch and says why on its decision', async () => {
    const svc = new AgentExecutionService();
    const ref = seedCheckpoint('sched-1', record);
    const mismatch = await decide(svc, hitlPayload({ checkpoint: { ...ref, sha256: 'stale' } }));
    expect(mismatch).toEqual({ source: 'snapshot', reason: 'checkpoint sha256 differs from the one the pause carries' });
    const missingCall = await decide(svc, hitlPayload({ checkpoint: ref }, { pendingToolCalls: [{ id: 'pending-abc', name: 'slack__post', input: { text: 'hi' } }] }));
    expect(missingCall).toEqual({ source: 'snapshot', reason: 'pending call slack__post is not in the record' });
    const good = await decide(svc, hitlPayload({ checkpoint: ref }));
    expect(good).toMatchObject({ source: 'checkpoint' });
    // The pending call is found by what the model sent — the gate's own id
    // names nothing in the record — under the record's id.
    expect(good.calls?.get('pending-abc')).toEqual({ id: 'toolu_send', name: 'gmail__send_email' });
  });

  it('a workflow-step pause takes the snapshot path and says so', async () => {
    const svc = new AgentExecutionService();
    const ref = seedCheckpoint('sched-1', record);
    const decision = await decide(svc, hitlPayload({ checkpoint: ref, currentStepId: 's1', resumeAfterStepId: 's1' }));
    expect(decision).toEqual({ source: 'snapshot', reason: 'workflow step' });
  });

  it('an engine with no inverse mapper takes the snapshot path', async () => {
    const svc = new AgentExecutionService();
    const ref = seedCheckpoint('sched-1', record);
    const decision = await decide(svc, hitlPayload({ checkpoint: ref }), 'sched-1', 'inv-1', 'unknown-legacy');
    expect(decision).toEqual({ source: 'snapshot', reason: 'no inverse mapper for unknown-legacy' });
  });

  it('the snapshot path replays the payload transcript exactly as before, with the reason on the decision line', async () => {
    const svc = new AgentExecutionService();
    scriptCompletion();
    const info = jest.spyOn(scrubLogger, 'info');
    const { state, logDecision } = await resumeApproved(svc, hitlPayload(), { source: 'snapshot', reason: 'pause carries no checkpoint' });
    expect(state.context.resumeTranscript).toBeUndefined();
    const { messages } = handed();
    expect(textOf(messages[0])).toBe(WRAPPED_OBJECTIVE);
    // The approved exchange, from the snapshot, with its identity kept.
    expect(blocks(messages).filter((c) => c.type === 'tool_use' && c.callId === 'pending-abc')).toHaveLength(1);
    expect(blocks(messages).filter((c) => c.type === 'tool_result' && c.callId === 'pending-abc')).toHaveLength(1);
    // The decision line is written once, through the caller's closure, with
    // the snapshot and its reason; the approved dispatch is recorded.
    expect(logDecision).toHaveBeenCalledTimes(1);
    expect(logDecision).toHaveBeenCalledWith({ source: 'snapshot', reason: 'pause carries no checkpoint' });
    expect(info.mock.calls.some((c) => (c[0] as { event?: string }).event === 'approved_dispatch')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 2 — the pending call is completed BEFORE the repair
// ═════════════════════════════════════════════════════════════════════════════
describe('Fix 2: the pending call is completed in the record before repair, and the adapter gets one result per call', () => {
  function pairing(messages: PlatformMessage[]) {
    const uses = blocks(messages).filter((c): c is Extract<PlatformContent, { type: 'tool_use' }> => c.type === 'tool_use');
    const results = blocks(messages).filter((c): c is Extract<PlatformContent, { type: 'tool_result' }> => c.type === 'tool_result');
    return { uses, results };
  }

  it('approved, same engine: the approved result answers the record\'s call, once, and the continuation turn is last', async () => {
    const svc = new AgentExecutionService();
    scriptCompletion();
    const ref = seedCheckpoint('sched-1', recordThroughGatedCall());
    const transcript = await decide(svc, hitlPayload({ checkpoint: ref }));
    const { state, logDecision } = await resumeApproved(svc, hitlPayload({ checkpoint: ref }), transcript);

    expect(state.context.resumeTranscript).toBeDefined();
    expect(logDecision).toHaveBeenCalledTimes(1);
    expect(logDecision.mock.calls[0][0]).toMatchObject({ source: 'checkpoint' });
    const { messages } = handed();
    const { uses, results } = pairing(messages);
    expect(uses.map((u) => u.callId)).toEqual(['toolu_search', 'toolu_send']);
    expect(results.map((r) => r.callId)).toEqual(['toolu_search', 'toolu_send']);
    // The approved result, not "No result provided".
    const sendResult = results.find((r) => r.callId === 'toolu_send')!;
    expect(sendResult.result).toBe(JSON.stringify({ messageId: 'm-1' }));
    expect(sendResult.error).toBeUndefined();
    expect(JSON.stringify(messages)).not.toContain('No result provided');
    // Order: the user turn, the earlier exchanges, the completed pending
    // call, then the continuation turn — nothing from the snapshot beside it.
    expect(messages[0].role).toBe('user');
    expect(textOf(messages[0])).toBe(WRAPPED_OBJECTIVE);
    expect(textOf(lastUser(messages))).toContain('gmail__send_email: completed');
    expect(messages[messages.length - 1]).toBe(lastUser(messages));
    expect(messages.filter((m) => textOf(m).includes('Please complete the following task'))).toHaveLength(1);
    // The run's own history starts empty: the transcript IS the history.
    expect(state.conversationHistory.filter((m) => m.role === 'assistant' && m.content === 'Searching for the competitors first.')).toHaveLength(0);
  });

  it('approved with edits: the record shows the call that ran, not the model\'s draft', async () => {
    const svc = new AgentExecutionService();
    scriptCompletion();
    const ref = seedCheckpoint('sched-1', recordThroughGatedCall());
    const transcript = await decide(svc, hitlPayload({ checkpoint: ref }));
    const edited = { ...SEND_INPUT, body: 'Acme, Globex and Initech. (reviewed)' };
    await resumeApproved(svc, hitlPayload({ checkpoint: ref }), transcript, { id: 'pending-abc', success: true, result: 'ok' }, edited);
    const send = pairing(handed().messages).uses.find((u) => u.callId === 'toolu_send')!;
    expect(send.args).toEqual(edited);
  });

  it('rejected, same engine: the rejection answers the record\'s call as an error, once', async () => {
    const svc = new AgentExecutionService();
    scriptCompletion('Understood.');
    const ref = seedCheckpoint('sched-1', recordThroughGatedCall());
    const transcript = await decide(svc, hitlPayload({ checkpoint: ref }));
    await resumeRejected(svc, hitlPayload({ checkpoint: ref }), transcript);

    const { messages } = handed();
    const { uses, results } = pairing(messages);
    expect(uses.map((u) => u.callId)).toEqual(['toolu_search', 'toolu_send']);
    expect(results.map((r) => r.callId)).toEqual(['toolu_search', 'toolu_send']);
    const sendResult = results.find((r) => r.callId === 'toolu_send')!;
    expect(String(sendResult.result)).toContain('Rejected by human reviewer: Do not email Dana directly.');
    expect(sendResult.error).toBeDefined();
    expect(textOf(lastUser(messages))).toContain('not carried out');
  });

  it('cross engine: the ids are renumbered together, on the call and on the result the resume appended', async () => {
    // Recorded by the OpenAI Agents SDK: an id Anthropic rejects outright.
    const longId = 'fc_' + 'a'.repeat(70) + '|part';
    const record = recordThroughGatedCall(longId);
    seedCheckpoint('sched-1', record, { execution_engine: 'openai-agents' });
    const found = findPendingCallInRecord(record, { id: 'pending-abc', name: 'gmail__send_email', input: SEND_INPUT })!;
    expect(found.id).toBe(longId);
    const completed = completePendingCalls(record, [{ recordCallId: found.id, name: found.name, content: 'sent', isError: false }], 'replace');
    const converted = checkpointToAdapterInput(completed, { sourceEngine: 'openai-agents', targetEngine: 'claude-agent-sdk' });
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const { uses, results } = pairing(converted.messages);
    const send = uses.find((u) => u.toolName === 'gmail__send_email')!;
    expect(send.callId).toMatch(/^call_\d+$/);
    expect(results.filter((r) => r.callId === send.callId)).toHaveLength(1);
    expect(results.find((r) => r.callId === send.callId)!.result).toBe('sent');
    expect(uses.some((u) => u.callId === longId)).toBe(false);
  });

  it('a call the record already answers is never answered twice: kept as it is, or rewritten in place', () => {
    const record = recordThroughGatedCall();
    const refusal = JSON.stringify({ error: 'paused_for_human_approval', reason: 'sensitive_work' });
    const answered = [...record, { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'toolu_send', content: refusal, is_error: true }] }];
    const kept = completePendingCalls(answered, [{ recordCallId: 'toolu_send', name: 'gmail__send_email', content: 'again', isError: false }], 'keep');
    expect(kept).toHaveLength(answered.length);
    expect(kept[kept.length - 1].content[0]).toMatchObject({ type: 'tool_result', content: refusal, is_error: true });
    expect(checkpointToAdapterInput(kept, { sourceEngine: 'claude-agent-sdk', targetEngine: 'claude-agent-sdk' }).ok).toBe(true);

    // The proxy's refusal is what the CLI engines record for a gated call:
    // the approval replaces it with what the call did, at the same place.
    const replaced = completePendingCalls(answered, [{ recordCallId: 'toolu_send', name: 'gmail__send_email', content: 'sent', isError: false }], 'replace');
    expect(replaced).toHaveLength(answered.length);
    expect(replaced[replaced.length - 1].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_send', name: 'gmail__send_email', content: 'sent' });
    expect(JSON.stringify(replaced)).not.toContain('paused_for_human_approval');
    expect(answered[answered.length - 1].content[0]).toMatchObject({ content: refusal });
    const converted = checkpointToAdapterInput(replaced, { sourceEngine: 'claude-agent-sdk', targetEngine: 'claude-agent-sdk' });
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const { results } = pairing(converted.messages);
    expect(results.filter((r) => r.callId === 'toolu_send')).toHaveLength(1);
    expect(results.find((r) => r.callId === 'toolu_send')!.result).toBe('sent');
  });

  it('the pairing assertion refuses a transcript with two results for one call', () => {
    const record = recordThroughGatedCall();
    const doubled = [
      ...record,
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'toolu_send', content: 'one' }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'toolu_send', content: 'two' }] },
    ];
    const converted = checkpointToAdapterInput(doubled, { sourceEngine: 'claude-agent-sdk', targetEngine: 'claude-agent-sdk' });
    expect(converted).toEqual({ ok: false, reason: 'tool pairing violated: tool_use toolu_send has 2 results' });
  });

  it('the pending call is found by id when the pause stamped the engine\'s, and by the call itself when it did not', () => {
    const record = recordThroughGatedCall();
    expect(findPendingCallInRecord(record, { id: 'toolu_send', name: 'whatever', input: {} })?.id).toBe('toolu_send');
    expect(findPendingCallInRecord(record, { id: 'pending-x', name: 'gmail__send_email', input: SEND_INPUT })?.id).toBe('toolu_send');
    // The SDK-prefixed spelling names the same call.
    expect(findPendingCallInRecord(record, { id: 'pending-x', name: 'mcp__liftoff-tool-gateway__gmail__send_email', input: SEND_INPUT })?.id).toBe('toolu_send');
    // Different arguments are a different call.
    expect(findPendingCallInRecord(record, { id: 'pending-x', name: 'gmail__send_email', input: { to: 'someone@else' } })).toBeUndefined();
    // An unanswered match is preferred over an answered one — the call the
    // gate stopped on, not an earlier identical call that ran — and an
    // answered match is taken only when there is no unanswered one (the wake
    // call an engine reported before the pause).
    const twice = [
      ...record,
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'toolu_send', content: 'sent once' }] },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'toolu_send_again', name: 'gmail__send_email', input: SEND_INPUT }] },
    ];
    expect(findPendingCallInRecord(twice, { id: 'pending-x', name: 'gmail__send_email', input: SEND_INPUT })?.id).toBe('toolu_send_again');
    expect(findPendingCallInRecord(record, { id: 'pending-x', name: 'web_search', input: { query: 'main competitors' } })?.id).toBe('toolu_search');
  });

  it('a tool result is bounded at conversion to the cap the model-facing result gets', () => {
    const prev = process.env.TOOL_RESULT_MAX_CHARS;
    process.env.TOOL_RESULT_MAX_CHARS = '200';
    try {
      const record = recordThroughGatedCall();
      const completed = completePendingCalls(record, [{ recordCallId: 'toolu_send', name: 'gmail__send_email', content: 'x'.repeat(5000), isError: false }], 'replace');
      const converted = checkpointToAdapterInput(completed, { sourceEngine: 'claude-agent-sdk', targetEngine: 'claude-agent-sdk' });
      expect(converted.ok).toBe(true);
      if (!converted.ok) return;
      const result = pairing(converted.messages).results.find((r) => r.callId === 'toolu_send')!;
      expect(String(result.result).length).toBeLessThan(400);
      expect(String(result.result)).toContain('truncated');
    } finally {
      if (prev === undefined) delete process.env.TOOL_RESULT_MAX_CHARS; else process.env.TOOL_RESULT_MAX_CHARS = prev;
    }
  });

  it('the resumed run seeds its recorder with the completed record, so its next pause checkpoints the whole conversation', async () => {
    const svc = new AgentExecutionService();
    const ref = seedCheckpoint('sched-1', recordThroughGatedCall());
    const transcript = await decide(svc, hitlPayload({ checkpoint: ref }));
    // The continuation pauses AGAIN on a second send.
    adapterInvokeMock.mockImplementation(async function* () {
      registeredRecorder!.recordRaw({ invocationId: 'inv-1', provider: 'anthropic', model: 'm', rawKind: 'anthropic_sdk_message', raw: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_send2', name: 'gmail__send_email', input: { to: 'sam@example.com' } }] } });
      yield {
        type: 'pause_requested', reason: 'hitl_gate', token: { adapterKind: 'anthropic', serialized: 'tok' },
        gateContext: { gateReason: 'communication_review', pendingToolCalls: [{ id: 'pending-2', name: 'gmail__send_email', input: { to: 'sam@example.com' } }] },
      };
    });
    await resumeApproved(svc, hitlPayload({ checkpoint: ref }), transcript);
    const insert = callLog.find((c) => c.via === 'pool' && c.sql.includes('INSERT INTO agent_scheduled_invocations'))!;
    const payload = JSON.parse(insert.params[8] as string) as HybridResumeState;
    const stored = checkpointRows.get((payload.checkpoint as { id: string }).id)!;
    const messages = stored.canonical_content as CanonicalMessage[];
    // The objective, the first send and its approved result, the continuation
    // turn, and the second send: the whole conversation, in order.
    expect(textOf({ role: 'user', content: [{ type: 'text', text: (messages[0].content[0] as { text: string }).text }] })).toBe(WRAPPED_OBJECTIVE);
    const ids = messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
    expect(ids).toEqual(['toolu_search', 'toolu_send', 'toolu_send2']);
    expect(messages.some((m) => m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_send'))).toBe(true);
    expect(messages.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.includes('gmail__send_email: completed')))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 2 — the wake reader
// ═════════════════════════════════════════════════════════════════════════════
describe('Fix 2: a wake continuation resumes from the checkpoint, completed with the wake marker', () => {
  const WAKE_SPEC = { kind: 'timer' as const, firesAt: '2026-09-17T10:00:00.000Z', note: 'wait for the window' };
  const WAKE_CTX = { spec: WAKE_SPEC, originTrust: 'trusted' as const, wakeChainDepth: 1, scheduledInvocationId: 'sched-1' };
  const MARKER = JSON.stringify({ __wakePending: { spec: WAKE_SPEC, originTrust: 'trusted', wakeChainDepth: 0 } });
  const wakeRecord: CanonicalMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Please complete the following task: Watch the deploy window. The secret word is pelican.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Noted: pelican.' }, { type: 'tool_use', id: 'call-wake', name: 'sleep_until', input: { at: '2026-09-17T10:00:00Z' } }] },
  ];
  function wakePayload(overrides: Partial<HybridResumeState> = {}): HybridResumeState {
    return {
      kind: 'hybrid-pause', pauseReason: 'self_wake', executionEngine: 'google-gemini-cli',
      currentStepId: 'conversational', resumeAfterStepId: 'conversational',
      stepOutput: 'Noted: pelican.', objective: 'Watch the deploy window. The secret word is pelican.',
      triggerKey: 'evt:original-run', inputData: {}, provider: 'google', model: 'gemini-3.5-flash',
      conversationHistory: [
        { role: 'user', content: 'Please complete the following task: Watch the deploy window. The secret word is pelican.' },
        { role: 'assistant', content: 'Noted: pelican.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-wake', name: 'sleep_until', input: { at: '2026-09-17T10:00:00Z' } }] },
        { role: 'tool', toolCallId: 'call-wake', toolName: 'sleep_until', content: MARKER },
      ],
      perStepRecoveries: {}, totalRecoveries: 0, recoveryHistory: [], stepOutputs: {}, enteredSteps: [], unsatisfiedSteps: [],
      wakeContext: WAKE_CTX,
      ...overrides,
    };
  }
  async function wake(svc: AgentExecutionService, payload: HybridResumeState) {
    (svc as unknown as { settleWakeDelivery: (...a: unknown[]) => Promise<void> }).settleWakeDelivery = jest.fn().mockResolvedValue(undefined);
    claimWakeForResumeMock.mockResolvedValue({
      id: 'sched-1', lease_token: 'lease-1', workflow_resume_payload: payload, wake_chain_depth: 1,
      created_at: new Date(), resume_attempts: 1, thread_id: null, wait_set_id: null, scheduled_by_invocation_id: 'inv-1',
    });
    const exec = jest.spyOn(svc, 'executeTask').mockResolvedValue({ success: true, output: 'pelican', toolCallsExecuted: 0, reasoningSteps: 1 });
    const info = jest.spyOn(scrubLogger, 'info');
    await svc.resumeFromWake(makeContext({ resumeEngine: undefined }), 'sched-1', 'wake-timer', {});
    return { input: exec.mock.calls[0]?.[0] as ExecuteTaskInput | undefined, decision: decisionLine(info) };
  }

  it('the checkpoint, completed with the marker, is what the continuation restores — once, with the wake turn last', async () => {
    const svc = new AgentExecutionService();
    const ref = seedCheckpoint('sched-1', wakeRecord, { execution_engine: 'google-gemini-cli' });
    const { input, decision } = await wake(svc, wakePayload({ checkpoint: ref }));
    expect(input?.resumeConversationHistory).toBeUndefined();
    expect(input?.resumeTranscript).toBeDefined();
    const messages = input!.resumeTranscript!.messages;
    const uses = blocks(messages).filter((c) => c.type === 'tool_use');
    const results = blocks(messages).filter((c): c is Extract<PlatformContent, { type: 'tool_result' }> => c.type === 'tool_result');
    expect(uses).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].callId).toBe('call-wake');
    expect(String(results[0].result)).toContain('__wakePending');
    expect(input?.resumeUserTurn).toMatch(/\[self-wake\]/);
    expect(decision).toMatchObject({ resume_kind: 'self_wake', transcript_source: 'checkpoint', checkpoint_sha256: ref.sha256, checkpoint_message_count: 2 });
    // Rendered for the Gemini CLI as the first-turn prompt: the call and its
    // marker are in the preamble as text.
    const prompt = firstTurnPrompt([...messages, { role: 'user', content: [{ type: 'text', text: input!.resumeUserTurn! }] }]);
    expect(prompt).toContain('[called sleep_until(');
    expect(prompt).toContain('[tool result: ');
    expect(prompt).toContain('__wakePending');
    expect(prompt.endsWith(input!.resumeUserTurn!)).toBe(true);
  });

  it('the snapshot path stays exactly as it was, and the decision says why', async () => {
    const svc = new AgentExecutionService();
    const payload = wakePayload();
    const { input, decision } = await wake(svc, payload);
    expect(input?.resumeTranscript).toBeUndefined();
    expect(input?.resumeConversationHistory).toEqual(payload.conversationHistory);
    expect(decision).toMatchObject({ transcript_source: 'snapshot', transcript_reason: 'pause carries no checkpoint', checkpoint_sha256: null });
  });

  it('a workflow-step wake takes the snapshot path and says so', async () => {
    const svc = new AgentExecutionService();
    const ref = seedCheckpoint('sched-1', wakeRecord, { execution_engine: 'google-gemini-cli' });
    const { input, decision } = await wake(svc, wakePayload({ checkpoint: ref, currentStepId: 's3', resumeAfterStepId: 's3' }));
    expect(input?.resumeTranscript).toBeUndefined();
    expect(input?.resumeState).toMatchObject({ currentStepId: 's3' });
    expect(decision).toMatchObject({ transcript_source: 'snapshot', transcript_reason: 'workflow step' });
  });

  it('a checkpoint that failed at the pause is reported and the snapshot replays', async () => {
    const svc = new AgentExecutionService();
    const { input, decision } = await wake(svc, wakePayload({ checkpoint: { failed: 'no recorder' } }));
    expect(input?.resumeTranscript).toBeUndefined();
    expect(decision).toMatchObject({ transcript_source: 'snapshot', transcript_reason: 'checkpoint failed at the pause: no recorder' });
  });

  it('the continuation hands the adapter the checkpoint ahead of the wake turn, and loads no thread history beside it', async () => {
    // The task lifecycle for real, into the conversational loop, with the
    // transcript on the input.
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    const s = svc as unknown as Record<string, unknown>;
    s.verifyCanonicalAgentStatus = jest.fn().mockResolvedValue('active');
    s.getActiveInstruction = jest.fn().mockResolvedValue({
      version: 1, instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' }, integrations: [],
    });
    s.loadRuntimeConfig = jest.fn().mockResolvedValue({
      workflowSteps: [], modelConfig: { provider: 'anthropic', tier: 'medium' }, execConfig: {}, memoryScope: {}, hitlLevel: 3,
    });
    s.retrieveContextMemories = jest.fn().mockResolvedValue([]);
    s.loadExternalAgentsForInternalAgent = jest.fn().mockResolvedValue([]);
    s.modelIdForPricing = jest.fn().mockResolvedValue(null);
    s.toolCallsForPersistence = jest.fn().mockReturnValue([]);
    s.recordCodeSessionUnpriced = jest.fn();
    s.emitCollabSessionSafe = jest.fn().mockResolvedValue(undefined);
    s.assessNotePromotion = jest.fn().mockResolvedValue(undefined);
    s.captureChatCanonical = jest.fn().mockReturnValue(null);
    s.writeTrajectoryIfEnabled = jest.fn().mockResolvedValue(undefined);
    s.decideVerifyOnStop = jest.fn().mockResolvedValue(null);
    s.postAuditLogToControlPlane = jest.fn().mockResolvedValue(undefined);
    s.drainStrandedUserMessages = jest.fn().mockResolvedValue(undefined);
    const loadThreadHistory = jest.fn().mockResolvedValue([{ role: 'user', content: 'a thread turn the checkpoint already holds' }]);
    s.loadThreadHistory = loadThreadHistory;
    createInvocationMock.mockImplementation(async (i: { id: string; triggerRef?: string }) => ({
      id: i.id, executionEngine: 'google-gemini-cli', startedAt: new Date(), threadId: null, triggeredBy: 'agent', triggerRef: i.triggerRef ?? null,
    }));
    const ref = seedCheckpoint('sched-1', wakeRecord, { execution_engine: 'google-gemini-cli' });
    const completed = completePendingCalls(wakeRecord, [{ recordCallId: 'call-wake', name: 'sleep_until', content: MARKER, isError: false }], 'keep');
    const converted = checkpointToAdapterInput(completed, { sourceEngine: 'google-gemini-cli', targetEngine: 'google-gemini-cli' });
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    scriptCompletion('The word was pelican.');
    const result = await (svc as unknown as { executeTaskInner: (i: ExecuteTaskInput) => Promise<{ success: boolean; error?: string }> }).executeTaskInner({
      tenantId: 't1', agentId: 'a1', workflowId: 'wf1', taskId: 'tk1', threadId: 'thread-1',
      objective: 'Watch the deploy window. The secret word is pelican.',
      triggeredBy: 'agent', triggerKey: 'wake:sched-1',
      resumeUserTurn: '[self-wake] timer elapsed; continue.',
      resumeTranscript: { canonical: completed, messages: converted.messages, sha256: ref.sha256, messageCount: 2 },
      resumeState: { ...wakePayload(), currentStepId: 'conversational' },
      modelConfigOverride: { provider: 'google', modelId: 'gemini-3.5-flash' } as unknown as ExecuteTaskInput['modelConfigOverride'],
    } as unknown as ExecuteTaskInput);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(loadThreadHistory).not.toHaveBeenCalled();
    const { messages } = handed();
    expect(messages.slice(0, converted.messages.length)).toEqual(converted.messages);
    expect(textOf(messages[messages.length - 1])).toBe('[self-wake] timer elapsed; continue.');
    expect(blocks(messages).filter((c) => c.type === 'tool_result')).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 2 — per engine, and the fallback conversion
// ═════════════════════════════════════════════════════════════════════════════
describe('Fix 2: what each engine is handed', () => {
  const record = recordThroughGatedCall();
  const completed = completePendingCalls(record, [{ recordCallId: 'toolu_send', name: 'gmail__send_email', content: JSON.stringify({ messageId: 'm-1' }), isError: false }], 'replace');
  const continuation: PlatformMessage = { role: 'user', content: [{ type: 'text', text: 'continue' }] };

  it.each([
    'claude-agent-sdk', 'google-genai', 'google-adk', 'openai-agents', 'openai-codex', 'opencode', 'google-gemini-cli', 'openrouter-openai-wire', 'xai-openai-wire',
  ] as const)('%s: the user turn, the earlier exchanges, the completed pending call, in order, one result per call', (engine) => {
    const converted = checkpointToAdapterInput(completed, { sourceEngine: 'claude-agent-sdk', targetEngine: engine });
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const messages = [...converted.messages, continuation];
    expect(messages[0].role).toBe('user');
    expect(textOf(messages[0])).toBe(WRAPPED_OBJECTIVE);
    const kinds = messages.flatMap((m) => m.content.map((c) => `${m.role}:${c.type}${c.type === 'tool_use' || c.type === 'tool_result' ? ':' + c.callId : ''}`));
    expect(kinds).toEqual([
      'user:text',
      'assistant:text', 'assistant:tool_use:toolu_search',
      'user:tool_result:toolu_search',
      'assistant:text', 'assistant:tool_use:toolu_send',
      'user:tool_result:toolu_send',
      'user:text',
    ]);
  });

  // ENGINE_SUBSET_OK: the three engines whose history is a text preamble.
  it.each(['openai-codex', 'opencode', 'google-gemini-cli'] as const)('%s renders the blocks in the first-turn prompt', (engine) => {
    const converted = checkpointToAdapterInput(completed, { sourceEngine: 'claude-agent-sdk', targetEngine: engine });
    if (!converted.ok) throw new Error(converted.reason);
    const prompt = firstTurnPrompt([...converted.messages, continuation]);
    expect(prompt).toContain('[called web_search({"query":"main competitors"})]');
    expect(prompt).toContain('[called gmail__send_email(');
    expect(prompt).toContain('[tool result: {"messageId":"m-1"}]');
    expect(prompt.endsWith('continue')).toBe(true);
  });

  it('the Gemini engines get the result in the shape their functionResponse needs: named, paired by id', () => {
    // ENGINE_SUBSET_OK: the two engines that take a functionResponse.
    for (const engine of ['google-genai', 'google-adk'] as const) {
      const converted = checkpointToAdapterInput(completed, { sourceEngine: 'claude-agent-sdk', targetEngine: engine });
      if (!converted.ok) throw new Error(converted.reason);
      const send = blocks(converted.messages).find((c) => c.type === 'tool_result' && c.callId === 'toolu_send') as Extract<PlatformContent, { type: 'tool_result' }>;
      expect(send.result).toEqual({ name: 'gmail__send_email', response: JSON.stringify({ messageId: 'm-1' }) });
    }
  });

  it('the OpenAI-wire engines get the call with its arguments as the string the SDK replays', () => {
    // ENGINE_SUBSET_OK: the three endpoints on the OpenAI wire.
    for (const engine of ['openai-agents', 'openrouter-openai-wire', 'xai-openai-wire'] as const) {
      const converted = checkpointToAdapterInput(completed, { sourceEngine: 'claude-agent-sdk', targetEngine: engine });
      if (!converted.ok) throw new Error(converted.reason);
      const send = blocks(converted.messages).find((c) => c.type === 'tool_use' && c.callId === 'toolu_send') as Extract<PlatformContent, { type: 'tool_use' }>;
      expect(send.args).toBe(JSON.stringify(SEND_INPUT));
    }
  });

  it('the fallback conversion carries a tool exchange with its identity: toolCalls → tool_use, a tool turn → tool_result', async () => {
    const svc = new AgentExecutionService();
    stubLoopDeps(svc);
    scriptCompletion();
    const state = makeState({ resumeUserTurn: 'continue' });
    state.conversationHistory = [
      { role: 'user', content: WRAPPED_OBJECTIVE },
      { role: 'assistant', content: 'Sending.', toolCalls: [{ id: 'pending-abc', name: 'gmail__send_email', input: SEND_INPUT }] },
      { role: 'tool', toolCallId: 'pending-abc', toolName: 'gmail__send_email', content: JSON.stringify({ messageId: 'm-1' }) },
      { role: 'assistant', content: '', toolCalls: [{ id: 'pending-2', name: 'slack__post', input: { text: 'hi' } }] },
      { role: 'tool', toolCallId: 'pending-2', toolName: 'slack__post', content: JSON.stringify({ error: 'channel not found' }) },
    ];
    await runConversational(svc, state, OBJECTIVE);
    const { messages } = handed();
    const [, sendTurn, sendResult, postTurn, postResult] = messages;
    expect(sendTurn).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Sending.' }, { type: 'tool_use', toolName: 'gmail__send_email', callId: 'pending-abc', args: SEND_INPUT }] });
    expect(sendResult).toEqual({ role: 'user', content: [{ type: 'tool_result', callId: 'pending-abc', result: JSON.stringify({ messageId: 'm-1' }) }] });
    // A turn that is only its calls carries no empty text beside them.
    expect(postTurn).toEqual({ role: 'assistant', content: [{ type: 'tool_use', toolName: 'slack__post', callId: 'pending-2', args: { text: 'hi' } }] });
    // A failed result reads as the error it is.
    expect(postResult).toEqual({ role: 'user', content: [{ type: 'tool_result', callId: 'pending-2', result: JSON.stringify({ error: 'channel not found' }), error: 'channel not found' }] });
    // No prose copy of the exchange anywhere.
    expect(messages.filter((m) => textOf(m).includes('messageId'))).toHaveLength(0);
    // The plain user turn is unchanged, and the continuation is last.
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: WRAPPED_OBJECTIVE }] });
    expect(textOf(messages[messages.length - 1])).toBe('continue');
  });

  it('the fallback conversion bounds a tool result to the cap', async () => {
    const prev = process.env.TOOL_RESULT_MAX_CHARS;
    process.env.TOOL_RESULT_MAX_CHARS = '200';
    try {
      const svc = new AgentExecutionService();
      stubLoopDeps(svc);
      scriptCompletion();
      const state = makeState({ resumeUserTurn: 'continue' });
      state.conversationHistory = [
        { role: 'user', content: WRAPPED_OBJECTIVE },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'web_search', input: {} }] },
        { role: 'tool', toolCallId: 'c1', toolName: 'web_search', content: 'y'.repeat(5000) },
      ];
      await runConversational(svc, state, OBJECTIVE);
      const result = blocks(handed().messages).find((c) => c.type === 'tool_result') as Extract<PlatformContent, { type: 'tool_result' }>;
      expect(String(result.result).length).toBeLessThan(400);
    } finally {
      if (prev === undefined) delete process.env.TOOL_RESULT_MAX_CHARS; else process.env.TOOL_RESULT_MAX_CHARS = prev;
    }
  });

  it('provenance is seeded from the resumed transcript, so what the paused half read is what the resumed half may name', async () => {
    const svc = new AgentExecutionService();
    scriptCompletion();
    const ref = seedCheckpoint('sched-1', recordThroughGatedCall());
    const transcript = await decide(svc, hitlPayload({ checkpoint: ref }));
    await resumeApproved(svc, hitlPayload({ checkpoint: ref }), transcript);
    const seeded = seedProvenanceFromContextMock.mock.calls.map((c) => c[0] as { texts?: string[] }).flatMap((a) => a.texts ?? []);
    expect(seeded.some((t) => t.includes('Acme, Globex and Initech.'))).toBe(true);
  });
});

// A recorder buffer left behind by a case must not leak into the next.
afterEach(() => {
  releaseBuffer('inv-1');
  releaseBuffer('inv-2');
});

// ═════════════════════════════════════════════════════════════════════════════
// The gaps a first review found, closed
// ═════════════════════════════════════════════════════════════════════════════
describe('a chained pause on the checkpoint path snapshots the whole conversation', () => {
  it('the second pause\'s payload transcript begins at the objective, not at the continuation', async () => {
    const svc = new AgentExecutionService();
    const ref = seedCheckpoint('sched-1', recordThroughGatedCall());
    const transcript = await decide(svc, hitlPayload({ checkpoint: ref }));
    adapterInvokeMock.mockImplementation(async function* () {
      registeredRecorder!.recordRaw({ invocationId: 'inv-1', provider: 'anthropic', model: 'm', rawKind: 'anthropic_sdk_message', raw: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_send2', name: 'gmail__send_email', input: { to: 'sam@example.com' } }] } });
      yield {
        type: 'pause_requested', reason: 'hitl_gate', token: { adapterKind: 'anthropic', serialized: 'tok' },
        gateContext: { gateReason: 'communication_review', pendingToolCalls: [{ id: 'toolu_send2', name: 'gmail__send_email', input: { to: 'sam@example.com' } }] },
      };
    });
    await resumeApproved(svc, hitlPayload({ checkpoint: ref }), transcript);
    const insert = callLog.find((c) => c.via === 'pool' && c.sql.includes('INSERT INTO agent_scheduled_invocations'))!;
    const payload = JSON.parse(insert.params[8] as string) as HybridResumeState;
    const history = payload.hitlContext?.conversationHistory ?? [];
    // The objective, the research exchange, the first send and its approved
    // result, then the continuation turn: the checkpoint rendered as persisted
    // turns ahead of the run's own.
    expect(history[0]).toMatchObject({ role: 'user' });
    expect(String(history[0].content)).toBe(WRAPPED_OBJECTIVE);
    expect(history.some((m) => m.role === 'tool' && m.toolCallId === 'toolu_send')).toBe(true);
    expect(history.some((m) => m.role === 'assistant' && (m.toolCalls ?? []).some((c) => c.id === 'toolu_search'))).toBe(true);
    expect(history.some((m) => m.role === 'user' && String(m.content).includes('gmail__send_email: completed'))).toBe(true);
    // The second pause also stamps the engine's id on its pending call, and
    // its checkpoint holds the second call under that id.
    expect(payload.hitlContext?.pendingToolCalls[0].id).toBe('toolu_send2');
  });
});

describe('a pause the approved dispatch raises carries a checkpoint of its own', () => {
  const WAKE_SPEC = { kind: 'timer' as const, firesAt: '2026-09-17T10:00:00.000Z', note: 'wait' };
  const MARKER = JSON.stringify({ __wakePending: { spec: WAKE_SPEC, originTrust: 'trusted', wakeChainDepth: 0 } });
  const wakeGrant = () => {
    const call = { id: 'pending-abc', name: 'sleep_until', input: { at: '2026-09-17T10:00:00Z' } };
    return {
      approvalId: 'appr-1', finalCalls: [call], fingerprint: 'fp', holds: {},
      routes: [{ call, ownership: 'standard' as const, dispatchPath: 'execute_tool_calls' as const, resolvedName: 'sleep_until',
        request: { id: 'pending-abc', connector: '', entityType: 'standard', actionType: 'sleep_until', payload: call.input } }],
    };
  };
  const wakeRecord = (): CanonicalMessage[] => [
    { role: 'user', content: [{ type: 'text', text: WRAPPED_OBJECTIVE }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Waiting for the window.' }, { type: 'tool_use', id: 'toolu_wake', name: 'sleep_until', input: { at: '2026-09-17T10:00:00Z' } }] },
  ];
  const wakePayload = (checkpoint?: PauseCheckpointRefLike) => hitlPayload(
    { ...(checkpoint ? { checkpoint } : {}) },
    { pendingToolCalls: [{ id: 'pending-abc', name: 'sleep_until', input: { at: '2026-09-17T10:00:00Z' } }] },
  );
  type PauseCheckpointRefLike = { id: string; sha256: string; messageCount: number } | { failed: string };

  async function approveWake(svc: AgentExecutionService, payload: HybridResumeState, transcript: unknown) {
    stubLoopDeps(svc);
    (svc as unknown as { executeToolCalls: (...a: unknown[]) => Promise<ToolCallResult[]> }).executeToolCalls =
      jest.fn().mockResolvedValue([{ id: 'pending-abc', success: true, result: { content: [{ type: 'text', text: MARKER }] } }]);
    const logDecision = jest.fn();
    const state = makeState();
    const res = await (svc as unknown as {
      dispatchApprovedAndContinue: (...a: unknown[]) => Promise<{ success: boolean; paused?: boolean; pauseKind?: string }>;
    }).dispatchApprovedAndContinue(state, payload, approval('approved'), stubAdapter(), wakeGrant(), transcript, logDecision);
    const insert = callLog.find((c) => c.via === 'pool' && c.sql.includes('INSERT INTO agent_scheduled_invocations'))!;
    return { res, logDecision, pausePayload: JSON.parse(insert.params[8] as string) as HybridResumeState, rowId: insert.params[insert.params.length - 1] as string };
  }

  it('an approved wake, from the checkpoint: the wake pause checkpoints the completed record', async () => {
    const svc = new AgentExecutionService();
    const ref = seedCheckpoint('sched-1', wakeRecord());
    const transcript = await decide(svc, wakePayload(ref));
    expect(transcript).toMatchObject({ source: 'checkpoint' });
    const { res, logDecision, pausePayload, rowId } = await approveWake(svc, wakePayload(ref), transcript);
    expect(res.paused).toBe(true);
    expect(res.pauseKind).toBe('self_wake');
    expect(logDecision).toHaveBeenCalledWith(expect.objectContaining({ source: 'checkpoint' }));
    expect(pausePayload.checkpoint).toEqual({ id: rowId, sha256: expect.any(String), messageCount: 3 });
    const stored = checkpointRows.get(rowId)!;
    const messages = stored.canonical_content as CanonicalMessage[];
    // The record through the wake call, answered by its marker.
    const results = messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as Array<{ tool_use_id: string; content: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe('toolu_wake');
    expect(results[0].content).toContain('__wakePending');
  });

  it('an approved wake, from the snapshot: the wake pause says why it carries no checkpoint', async () => {
    const svc = new AgentExecutionService();
    const { res, pausePayload } = await approveWake(svc, wakePayload(), { source: 'snapshot', reason: 'pause carries no checkpoint' });
    expect(res.paused).toBe(true);
    expect(pausePayload.checkpoint).toEqual({ failed: 'resumed from the payload snapshot; no canonical record' });
    expect(checkpointRows.size).toBe(0);
  });
});

describe('a HITL pause whose row insert fails leaves no orphan checkpoint', () => {
  it('drops the checkpoint it wrote and fails the pause as before', async () => {
    const svc = new AgentExecutionService();
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      callLog.push({ via: 'pool', sql, params });
      if (typeof sql === 'string' && sql.includes('INSERT INTO agent_scheduled_invocations')) throw new Error('disk full');
      return { rows: [], rowCount: 0 };
    });
    const { recordCanonicalMessage } = jest.requireActual('../../trajectories/recorder') as typeof import('../../trajectories/recorder');
    recordCanonicalMessage('inv-1', 'anthropic', 'm', { role: 'user', content: [{ type: 'text', text: 'hello' }] });
    await expect(svc.createHitlPause(makeState(), 'conversational', hitlPayload(), {
      recorderInvocationId: 'inv-1', recorderRegistered: true, engine: 'claude-agent-sdk', provider: 'anthropic', model: 'm',
    })).rejects.toThrow('disk full');
    expect(callLog.some((c) => c.via === 'tenant' && c.sql.includes('INSERT INTO pause_checkpoints'))).toBe(true);
    expect(callLog.some((c) => c.via === 'tenant' && c.sql.includes('DELETE FROM pause_checkpoints'))).toBe(true);
    expect(checkpointRows.size).toBe(0);
  });
});

describe('the checkpoint cannot be verified against an invocation nothing names', () => {
  it('a NULL on either side is a miss, not a match', async () => {
    const record = recordThroughGatedCall();
    const ref = seedCheckpoint('sched-1', record, { invocation_id: null });
    expect(await loadPauseCheckpoint({ tenantId: 't1', agentId: 'a1', pauseId: 'sched-1', pausedInvocationId: null, ref }))
      .toEqual({ ok: false, reason: 'checkpoint invocation cannot be verified' });
    const named = seedCheckpoint('sched-2', record);
    expect(await loadPauseCheckpoint({ tenantId: 't1', agentId: 'a1', pauseId: 'sched-2', pausedInvocationId: null, ref: named }))
      .toEqual({ ok: false, reason: 'checkpoint invocation cannot be verified' });
  });
});

describe('the decision line says what was actually replayed', () => {
  it('a record the conversion refuses after dispatch is logged as the snapshot, with the refusal', async () => {
    const svc = new AgentExecutionService();
    scriptCompletion();
    // The gated call appears twice under one id: the pairing assertion refuses it.
    const record = recordThroughGatedCall();
    const doubled: CanonicalMessage[] = [...record, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_send', name: 'gmail__send_email', input: SEND_INPUT }] }];
    const ref = seedCheckpoint('sched-1', doubled);
    const transcript = await decide(svc, hitlPayload({ checkpoint: ref }));
    expect(transcript).toMatchObject({ source: 'checkpoint' });
    const { state, logDecision } = await resumeApproved(svc, hitlPayload({ checkpoint: ref }), transcript);
    expect(state.context.resumeTranscript).toBeUndefined();
    expect(logDecision).toHaveBeenCalledTimes(1);
    expect(logDecision).toHaveBeenCalledWith({ source: 'snapshot', reason: 'tool pairing violated: tool_use toolu_send appears 2 times' });
    // The snapshot replayed: the approved exchange from the payload.
    expect(blocks(handed().messages).filter((c) => c.type === 'tool_result' && c.callId === 'pending-abc')).toHaveLength(1);
  });
});

describe('provenance is seeded from the history the run continues', () => {
  it('reads the history\'s text, which is a string', async () => {
    const svc = new AgentExecutionService();
    scriptCompletion();
    const { state } = await resumeApproved(svc, hitlPayload(), { source: 'snapshot', reason: 'pause carries no checkpoint' });
    expect(state.context.resumeTranscript).toBeUndefined();
    const seeded = seedProvenanceFromContextMock.mock.calls.map((c) => c[0] as { texts?: string[] }).flatMap((a) => a.texts ?? []);
    expect(seeded).toContain('Searching for the competitors first.');
    expect(seeded.some((t) => t.includes('messageId'))).toBe(true);
  });
});

describe('a delegation fan-in resumes from the checkpoint, completed with the children\'s results', () => {
  const spawnRecord = (): CanonicalMessage[] => [
    { role: 'user', content: [{ type: 'text', text: WRAPPED_OBJECTIVE }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Handing the research out.' }, { type: 'tool_use', id: 'toolu_spawn', name: 'spawn_task_graph', input: { tasks: [{ objective: 'research Acme' }] } }] },
  ];
  function delegationPayload(checkpoint?: { id: string; sha256: string; messageCount: number }): HybridResumeState {
    return {
      kind: 'hybrid-pause', pauseReason: 'delegation', executionEngine: 'claude-agent-sdk',
      currentStepId: 'conversational', resumeAfterStepId: 'conversational',
      stepOutput: 'Handing the research out.', objective: OBJECTIVE, triggerKey: 'trig-1', inputData: undefined,
      perStepRecoveries: {}, totalRecoveries: 0, recoveryHistory: [],
      ...(checkpoint ? { checkpoint } : {}),
      delegationContext: {
        parentTaskId: 'parent-1', parentToolCallId: 'toolu_spawn', childTaskIds: ['child-1'], deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        conversationHistory: [{ role: 'user', content: WRAPPED_OBJECTIVE }, { role: 'assistant', content: 'Handing the research out.' }],
      },
    };
  }
  function stubDelegationDeps(svc: AgentExecutionService) {
    stubLoopDeps(svc);
    const s = svc as unknown as Record<string, unknown>;
    s.getActiveInstruction = jest.fn().mockResolvedValue({ version: 1, instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' }, integrations: [] });
    s.loadRuntimeConfig = jest.fn().mockResolvedValue({ workflowSteps: [], modelConfig: { provider: 'anthropic' }, execConfig: {}, memoryScope: {}, hitlLevel: 3 });
    s.buildBindingsByTypeFor = jest.fn().mockResolvedValue({});
    s.settleResumedCollabSession = jest.fn().mockResolvedValue(undefined);
  }
  async function resumeDelegation(svc: AgentExecutionService, payload: HybridResumeState) {
    stubDelegationDeps(svc);
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      callLog.push({ via: 'pool', sql, params });
      if (sql.includes('SELECT workflow_resume_payload, status, scheduled_by_invocation_id')) {
        return { rows: [{ workflow_resume_payload: payload, status: 'pending', scheduled_by_invocation_id: 'inv-1' }], rowCount: 1 };
      }
      if (sql.includes("SET status='fired'")) return { rows: [{ id: 'sched-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const info = jest.spyOn(scrubLogger, 'info');
    scriptCompletion('Acme is the main competitor.');
    const res = await svc.resumeFromDelegation(makeContext(), 'sched-1', 'parent-1');
    return { res, decision: decisionLine(info) };
  }

  it('from the checkpoint: the spawn call is answered once with the children\'s results, and the continuation names them', async () => {
    const svc = new AgentExecutionService();
    const ref = seedCheckpoint('sched-1', spawnRecord());
    const { res, decision } = await resumeDelegation(svc, delegationPayload(ref));
    expect(res.success).toBe(true);
    expect(decision).toMatchObject({ resume_kind: 'delegation', transcript_source: 'checkpoint', checkpoint_sha256: ref.sha256 });
    const { messages } = handed();
    const uses = blocks(messages).filter((c): c is Extract<PlatformContent, { type: 'tool_use' }> => c.type === 'tool_use');
    const results = blocks(messages).filter((c): c is Extract<PlatformContent, { type: 'tool_result' }> => c.type === 'tool_result');
    expect(uses.map((u) => u.callId)).toEqual(['toolu_spawn']);
    expect(results.map((r) => r.callId)).toEqual(['toolu_spawn']);
    expect(String(results[0].result)).toContain('child-1');
    expect(textOf(lastUser(messages))).toContain('- child-1: completed');
    expect(messages.filter((m) => textOf(m).includes('Please complete the following task'))).toHaveLength(1);
  });

  it('from the snapshot: the persisted transcript and the spawn pair, with the reason on the decision', async () => {
    const svc = new AgentExecutionService();
    const { res, decision } = await resumeDelegation(svc, delegationPayload());
    expect(res.success).toBe(true);
    expect(decision).toMatchObject({ resume_kind: 'delegation', transcript_source: 'snapshot', transcript_reason: 'pause carries no checkpoint' });
    const { messages } = handed();
    expect(blocks(messages).filter((c) => c.type === 'tool_use' && c.callId === 'toolu_spawn')).toHaveLength(1);
    expect(blocks(messages).filter((c) => c.type === 'tool_result' && c.callId === 'toolu_spawn')).toHaveLength(1);
    expect(textOf(lastUser(messages))).toContain('The task you delegated has finished');
  });
});

describe('a clarification that deduplicates onto an earlier open ask drops the checkpoint it wrote', () => {
  it('the checkpoint keyed to the row that never landed is deleted', async () => {
    const svc = new AgentExecutionService();
    // The dedup query finds an earlier open ask, already notified.
    poolMock.connect.mockResolvedValue({
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes("clarification_source = 'recovery_llm'")) {
          return { rows: [{ id: 'clar-old', thread_id: 'thread-1', notified_at: new Date(), clarification_origin: 'question', original_question: 'earlier?' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    });
    const { recordCanonicalMessage } = jest.requireActual('../../trajectories/recorder') as typeof import('../../trajectories/recorder');
    recordCanonicalMessage('inv-1', 'anthropic', 'm', { role: 'user', content: [{ type: 'text', text: 'hello' }] });
    const res = await svc.createClarificationPause(makeState(), 'which one?', 'conversational', hitlPayload({ pauseReason: 'ask_user' }), 'question', {
      recorderInvocationId: 'inv-1', recorderRegistered: true, engine: 'claude-agent-sdk', provider: 'anthropic', model: 'm',
    });
    expect(res.paused).toBe(true);
    expect(callLog.some((c) => c.via === 'tenant' && c.sql.includes('INSERT INTO pause_checkpoints'))).toBe(true);
    expect(callLog.some((c) => c.via === 'tenant' && c.sql.includes('DELETE FROM pause_checkpoints'))).toBe(true);
    expect(checkpointRows.size).toBe(0);
  });
});
