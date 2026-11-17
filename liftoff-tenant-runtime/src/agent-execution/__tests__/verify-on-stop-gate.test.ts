// B1 — the SERVICE-LEVEL gate, decideVerifyOnStop.
//
// The pure halves of verify-on-stop (observation, assessment, message) have
// their own suite. This one exists because the gate itself shipped with a
// capability check that no production path could ever satisfy, and nothing
// noticed: the pure functions were green while the feature was dead. Every
// test here drives the real private method on the real service, with a real
// observation, and asserts the DECISION — the thing production actually runs.

// ── Mock harness (mirrors catalog-schema-parity.test.ts, the proven set for
//    instantiating AgentExecutionService without live infrastructure) ───────

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) =>
    ({ name, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[]; name?: string }) =>
    ({ type: 'sdk', name: opts.name || 'test', tools: opts.tools })),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../streaming', () => ({
  streamingService: { emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
jest.mock('../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));

jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: { checkGate: jest.fn() },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));

jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: jest.fn(), chat: jest.fn() } }));
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
  getToolGatewayDispatcher: () => ({ execute: jest.fn() }),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    updateRuntimeStatus: jest.fn(),
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
}));
jest.mock('../../invocations', () => ({
  invocationsService: { getMessages: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));

jest.mock('../tool-interceptor', () => ({ interceptToolCalls: jest.fn((calls) => calls) }));

jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifests: jest.fn().mockResolvedValue([]),
    getManifestsForAgent: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([]),
  listConnectorTypes: jest.fn().mockReturnValue([]),
}));

jest.mock('../../tools/standard-tools', () => ({ STANDARD_TOOLS: [] }));
jest.mock('../../integrations/web-fetch/global-flags', () => ({
  getAllVendorFlags: jest.fn().mockResolvedValue({ perplexity: false, openai: false, google: false }),
}));
jest.mock('../../integrations/web-fetch/web-tool-secrets', () => ({
  getTenantConnectedWebVendors: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('../../browser-sessions/repository', () => ({
  getActiveForThread: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../agent-chat/agent-slack-client', () => ({
  listAgentSlackInstalls: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../agent-chat/agent-teams-client', () => ({
  listAgentTeamsConversations: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../tool-gateway/knowledge-exposure-cache', () => ({
  tenantHasBoundKnowledge: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: jest.fn(),
}));
const mockPool = {
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  }),
};
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => mockPool),
  getPool: jest.fn(() => mockPool),
}));
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {},
  mapRow: (row: Record<string, unknown>) => row,
}));
jest.mock('../../tools/standard-tool-handler', () => ({
  executeStandardTool: jest.fn(),
}));

process.env.PLATFORM_BACKEND_URL = 'https://platform-backend.local';
process.env.PLATFORM_CALLBACK_TOKEN = 'test-token';

(globalThis as { fetch?: typeof fetch }).fetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ agents: [] }),
}) as unknown as typeof fetch;

// ── Imports under test ──────────────────────────────────────────────────

import { AgentExecutionService } from '../service';
import type { ExecutionState, ExecutionContext, TerminalState } from '../types';
import { assessRun, observeToolCall, recordWorkspaceFingerprint } from '../verify-on-stop';
import type { VerifyAssessment } from '../verify-on-stop';
import { logger } from '../../infrastructure/logging';

// ── Fixtures ────────────────────────────────────────────────────────────

let n = 0;
function freshRun(): string {
  return `gate-inv-${++n}`;
}

interface DecideArgs {
  input: Record<string, unknown>;
  state: ExecutionState;
  invocationId: string;
  terminalState: TerminalState;
}

function makeState(overrides: Partial<ExecutionContext> = {}): ExecutionState {
  const context = {
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    workflowId: 'wf-1',
    taskId: 'task-1',
    instructionVersion: 1,
    instruction: {} as ExecutionContext['instruction'],
    traceId: 'trace-1',
    agentType: 'agent',
    modelConfig: {},
    execConfig: {},
    memoryScope: {},
    ...overrides,
  } as unknown as ExecutionContext;
  return {
    context,
    reasoningSteps: 0,
    toolCallsExecuted: 0,
    startTime: new Date(),
    steps: [],
    conversationHistory: [],
    pendingToolCalls: [],
    completedToolCalls: [],
    toolFailureCounts: new Map(),
    injectedSkillIds: [],
  } as unknown as ExecutionState;
}

function decide(
  service: AgentExecutionService,
  args: Partial<DecideArgs> & { invocationId: string },
): Promise<VerifyAssessment | null> {
  const full: DecideArgs = {
    input: { tenantId: 'tenant-1', agentId: 'agent-1', taskId: 'task-1', workflowId: 'wf-1' },
    state: makeState(),
    terminalState: 'success',
    ...args,
  };
  return (service as unknown as {
    decideVerifyOnStop: (a: DecideArgs) => Promise<VerifyAssessment | null>;
  }).decideVerifyOnStop(full);
}

/** An unverified code change — the shape the gate exists to catch. */
function observeUnverifiedChange(invocationId: string): void {
  observeToolCall(invocationId, 'write_file', { path: 'src/app.ts' }, {});
}

// ── Suite ───────────────────────────────────────────────────────────────

describe('decideVerifyOnStop (service-level)', () => {
  let service: AgentExecutionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentExecutionService();
  });

  afterEach(() => {
    delete process.env.VERIFY_ON_STOP_MODE;
  });

  it('nudges in enforce mode: autonomous success, code changed, nothing verified', async () => {
    process.env.VERIFY_ON_STOP_MODE = 'enforce';
    const id = freshRun();
    observeUnverifiedChange(id);
    const decision = await decide(service, { invocationId: id });
    expect(decision).not.toBeNull();
    expect(decision!.changedPaths).toEqual(['src/app.ts']);
  });

  it('does not nudge in shadow mode, but logs the would-nudge', async () => {
    process.env.VERIFY_ON_STOP_MODE = 'shadow';
    const id = freshRun();
    observeUnverifiedChange(id);
    const decision = await decide(service, { invocationId: id });
    expect(decision).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'verify_on_stop', mode: 'shadow', invocationId: id }),
      expect.any(String),
    );
  });

  it('records an eligible run that declined because the change was verified', async () => {
    process.env.VERIFY_ON_STOP_MODE = 'shadow';
    const id = freshRun();
    observeToolCall(id, 'write_file', { path: 'src/app.ts' }, {});
    observeToolCall(id, 'bash', { command: 'npm test' }, { exitCode: 0 });
    const decision = await decide(service, { invocationId: id });
    expect(decision).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'verify_on_stop_eligible',
        declineReason: 'verified',
        invocationId: id,
      }),
      expect.any(String),
    );
  });

  // A run whose workspace was never fingerprinted has not been ASSESSED — its
  // file work may simply have gone through a path the allow-list does not
  // watch. Recording that as `no_code_change` claims the run did nothing.
  it('records an unfingerprinted run as unobserved, not as no_code_change', async () => {
    process.env.VERIFY_ON_STOP_MODE = 'shadow';
    const id = freshRun();
    observeToolCall(id, 'bash', { command: 'ls src/' }, { exitCode: 0 });
    await decide(service, { invocationId: id });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'verify_on_stop_eligible',
        declineReason: 'unobserved',
        workspaceObserved: false,
        invocationId: id,
      }),
      expect.any(String),
    );
  });

  it('records a fingerprinted, unmoved workspace as no_code_change', async () => {
    process.env.VERIFY_ON_STOP_MODE = 'shadow';
    const id = freshRun();
    observeToolCall(id, 'bash', { command: 'ls src/' }, { exitCode: 0 });
    // Same fingerprint twice: the workspace was read, and it did not move.
    recordWorkspaceFingerprint(id, 'tree-abc');
    recordWorkspaceFingerprint(id, 'tree-abc');
    await decide(service, { invocationId: id });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'verify_on_stop_eligible',
        declineReason: 'no_code_change',
        workspaceObserved: true,
        workspaceMoved: false,
        invocationId: id,
      }),
      expect.any(String),
    );
  });

  // The measurement fix, stated as a test: a run that wrote files through a
  // path the allow-list cannot see is now visible as one.
  it('nudges a run whose workspace moved even with no named changed paths', async () => {
    process.env.VERIFY_ON_STOP_MODE = 'shadow';
    const id = freshRun();
    // `curl -o out.json` — no tool-name match, no shell redirect to scrape.
    observeToolCall(id, 'bash', { command: 'curl -o out.json https://example.com' }, { exitCode: 0 });
    recordWorkspaceFingerprint(id, 'tree-before');
    recordWorkspaceFingerprint(id, 'tree-after');
    await decide(service, { invocationId: id });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'verify_on_stop_eligible',
        wouldNudge: true,
        workspaceMoved: true,
        changedPathCount: 0,
        invocationId: id,
      }),
      expect.any(String),
    );
  });

  it('declines silently when the mode is off', async () => {
    const id = freshRun();
    observeUnverifiedChange(id);
    const decision = await decide(service, { invocationId: id });
    expect(decision).toBeNull();
    // Event-specific: the service may log unrelated lines elsewhere.
    const warned = (logger.warn as jest.Mock).mock.calls.some(
      (c) => (c[0] as { event?: string })?.event === 'verify_on_stop');
    const informed = (logger.info as jest.Mock).mock.calls.some(
      (c) => (c[0] as { event?: string })?.event === 'verify_on_stop_decision');
    expect(warned).toBe(false);
    expect(informed).toBe(false);
  });

  it('never gates the continuation itself (the loop breaker)', async () => {
    process.env.VERIFY_ON_STOP_MODE = 'enforce';
    const id = freshRun();
    observeUnverifiedChange(id);
    const decision = await decide(service, {
      invocationId: id,
      input: { tenantId: 'tenant-1', agentId: 'agent-1', taskId: 't', workflowId: 'w', verifyContinuation: true },
    });
    expect(decision).toBeNull();
  });

  it('excludes chat turns (systemPromptOverride)', async () => {
    process.env.VERIFY_ON_STOP_MODE = 'enforce';
    const id = freshRun();
    observeUnverifiedChange(id);
    const decision = await decide(service, {
      invocationId: id,
      state: makeState({ systemPromptOverride: 'you are a chat agent' }),
    });
    expect(decision).toBeNull();
  });

  it('excludes runs that did not end in success', async () => {
    process.env.VERIFY_ON_STOP_MODE = 'enforce';
    for (const terminalState of ['escalated', 'gated', 'task_failed', 'engine_error', 'stopped'] as TerminalState[]) {
      const id = freshRun();
      observeUnverifiedChange(id);
      const decision = await decide(service, { invocationId: id, terminalState });
      expect(decision).toBeNull();
    }
  });

  it('does NOT require sandbox capabilities on the context', async () => {
    // The original gate required context.sandboxCapabilities ⊇ {shell|file} —
    // a field no production path populated, so the gate declined every run
    // for the life of the feature. Observation is the capability proof now:
    // this test pins that a context with NO capability field still nudges.
    process.env.VERIFY_ON_STOP_MODE = 'enforce';
    const id = freshRun();
    observeUnverifiedChange(id);
    const state = makeState();
    expect(state.context.sandboxCapabilities).toBeUndefined();
    const decision = await decide(service, { invocationId: id, state });
    expect(decision).not.toBeNull();
  });

  it('clears the observation whichever way it decides', async () => {
    process.env.VERIFY_ON_STOP_MODE = 'enforce';
    const nudged = freshRun();
    observeUnverifiedChange(nudged);
    await decide(service, { invocationId: nudged });
    expect(assessRun(nudged).changedPaths).toEqual([]);

    process.env.VERIFY_ON_STOP_MODE = 'shadow';
    const declined = freshRun();
    observeUnverifiedChange(declined);
    await decide(service, { invocationId: declined });
    expect(assessRun(declined).changedPaths).toEqual([]);
  });
});
