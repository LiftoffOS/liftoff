// B5 — the SERVICE-LEVEL context posture, applyContextPressure.
//
// The pure halves (the assessment, the compactor) have their own suites. This
// one exists because ORDER is the whole design here and order is exactly what a
// pure test cannot see: measure, then compact, then re-measure, then decide
// whether to nudge or let the caller end the run. Reading the block was the only
// way to check that until it became a method.
//
// Two of the assertions below are about the CANONICAL RECORD rather than about
// context. The nudge and the compaction summary are user-role messages appended
// to the conversation immediately before the record captures "this run's user
// turn" as the last user message it is about to send. That capture named the
// nudge as the objective on every nudged run for as long as the nudge has
// existed, and compaction would have added a second way to do it.

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
import type { ExecutionState, ExecutionContext } from '../types';
import type { PlatformMessage } from '../adapter/types';
import {
  COMPACTION_SUMMARY_HEADER,
  CONTEXT_PRESSURE_NUDGE,
  isMidRunPlatformTurn,
  windowCharsForProvider,
} from '../context-pressure';
import { logger } from '../../infrastructure/logging';

jest.mock('../engine/compress-for-prompt', () => ({
  compressForPrompt: jest.fn(),
  semanticCompressionEnabled: jest.fn(() => true),
}));
const { compressForPrompt, semanticCompressionEnabled } = require('../engine/compress-for-prompt') as {
  compressForPrompt: jest.Mock;
  semanticCompressionEnabled: jest.Mock;
};

// ── Fixtures ────────────────────────────────────────────────────────────

const WINDOW = windowCharsForProvider('openai');

function makeState(history: Array<{ role: string; content: string }>): ExecutionState {
  const context = {
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    invocationId: 'inv-1',
    workflowId: 'wf-1',
    taskId: 'task-1',
    instructionVersion: 1,
    instruction: {} as ExecutionContext['instruction'],
    traceId: 'trace-1',
    agentType: 'agent',
    modelConfig: { provider: 'openai' },
    execConfig: {},
    memoryScope: {},
  } as unknown as ExecutionContext;
  return {
    context,
    reasoningSteps: 0,
    toolCallsExecuted: 0,
    startTime: new Date(),
    steps: [],
    conversationHistory: history,
    pendingToolCalls: [],
    completedToolCalls: [],
    toolFailureCounts: new Map(),
    injectedSkillIds: [],
  } as unknown as ExecutionState;
}

interface Posture {
  rebuilt: PlatformMessage[];
  level: 'ok' | 'pressure' | 'exceeded';
  compacted: boolean;
  nudged: boolean;
}

function apply(
  service: AgentExecutionService,
  state: ExecutionState,
  opts: { rebuilt?: PlatformMessage[]; canAct?: boolean } = {},
): Promise<Posture> {
  return (service as unknown as {
    applyContextPressure: (a: {
      state: ExecutionState; rebuilt: PlatformMessage[]; canAct: boolean;
    }) => Promise<Posture>;
  }).applyContextPressure({
    state,
    rebuilt: opts.rebuilt ?? [],
    canAct: opts.canAct ?? true,
  });
}

/** A conversation of `chars` total, in messages small enough that retention has
 *  something to choose between. */
function historyOf(chars: number): Array<{ role: string; content: string }> {
  const per = 2_000;
  const n = Math.ceil(chars / per);
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i} ${'x'.repeat(per - 12)}`,
  }));
}

/** The last user message of what would be SENT — the exact expression the
 *  canonical record uses to decide what this run was asked to do. */
function capturedUserTurn(rebuilt: PlatformMessage[], state: ExecutionState): string | undefined {
  const messages: PlatformMessage[] = [
    ...rebuilt,
    ...state.conversationHistory.map((m) => ({
      role: (m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user') as PlatformMessage['role'],
      content: [{ type: 'text' as const, text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    })),
  ];
  const textOf = (m: PlatformMessage): string => (m.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text).join('\n').trim();
  const found = [...messages].reverse().find((m) => m.role === 'user' && !isMidRunPlatformTurn(textOf(m)));
  return found ? textOf(found) : undefined;
}

// ── Suite ───────────────────────────────────────────────────────────────

describe('applyContextPressure (service-level)', () => {
  let service: AgentExecutionService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HISTORY_COMPACTION_ENABLED = '1';
    semanticCompressionEnabled.mockReturnValue(true);
    compressForPrompt.mockResolvedValue('Earlier turns established the plan and ran the build.');
    service = new AgentExecutionService();
  });

  afterEach(() => {
    delete process.env.HISTORY_COMPACTION_ENABLED;
    delete process.env.HISTORY_COMPACT_RETAIN;
  });

  it('does nothing to an ordinary conversation', async () => {
    const state = makeState([{ role: 'user', content: 'do the thing' }]);
    const posture = await apply(service, state);
    expect(posture).toMatchObject({ level: 'ok', compacted: false, nudged: false });
    expect(state.conversationHistory).toHaveLength(1);
    expect(compressForPrompt).not.toHaveBeenCalled();
  });

  it('measures on an SDK-managed engine but never acts on it', async () => {
    const state = makeState(historyOf(Math.ceil(WINDOW * 0.8)));
    const posture = await apply(service, state, { canAct: false });
    expect(posture).toMatchObject({ compacted: false, nudged: false });
    // Measurement is not gated: the reading is still logged, marked as one we
    // could not have acted on.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'context_pressure', managesOwnContext: true }),
      expect.any(String),
    );
    expect(compressForPrompt).not.toHaveBeenCalled();
  });

  it('compacts under pressure, re-measures, and nudges', async () => {
    const state = makeState(historyOf(Math.ceil(WINDOW * 0.8)));
    const before = state.conversationHistory.length;
    const posture = await apply(service, state);
    expect(posture.compacted).toBe(true);
    expect(posture.nudged).toBe(true);
    expect(state.conversationHistory.length).toBeLessThan(before);
    // The re-measurement is what the caller acts on, so it has to be the one
    // reported: levelAfter is measured, not assumed.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'history_compacted', levelBefore: 'pressure', levelAfter: 'ok' }),
      expect.any(String),
    );
    expect(state.conversationHistory[state.conversationHistory.length - 1].content)
      .toBe(CONTEXT_PRESSURE_NUDGE);
  });

  it('rescues a run that would otherwise have been ended', async () => {
    // Past the hard ratio: without compaction this is the escalation path.
    const state = makeState(historyOf(Math.ceil(WINDOW * 0.98)));
    const posture = await apply(service, state);
    expect(posture.compacted).toBe(true);
    expect(posture.level).not.toBe('exceeded');
    expect(posture.nudged).toBe(true);
  });

  it('still reports exceeded when compaction cannot help, and does not nudge a run about to end', async () => {
    // The summarizer is unavailable, so compaction declines and the conversation
    // is exactly as large as it was.
    semanticCompressionEnabled.mockReturnValue(false);
    const state = makeState(historyOf(Math.ceil(WINDOW * 0.98)));
    const posture = await apply(service, state);
    expect(posture.compacted).toBe(false);
    expect(posture.level).toBe('exceeded');
    // The caller ends the run here; a nudge appended to a conversation nobody
    // will send is noise in the transcript the person reads.
    expect(posture.nudged).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'history_compaction_declined',
        reason: 'semantic_compression_disabled',
      }),
      expect.any(String),
    );
  });

  // ── The canonical record (ADR-006 §3b) ────────────────────────────────

  it('leaves the run objective, not the nudge, as the canonical user turn', async () => {
    const state = makeState([
      { role: 'user', content: 'Reconcile the July invoices' },
      ...historyOf(Math.ceil(WINDOW * 0.8)).map((m) => ({ ...m, role: 'assistant' })),
    ]);
    const posture = await apply(service, state);
    expect(posture.nudged).toBe(true);
    expect(capturedUserTurn(posture.rebuilt, state)).toBe('Reconcile the July invoices');
  });

  it('captures nothing rather than capturing the summary when the run had no user turn', async () => {
    // Every turn is an assistant turn, so there is no objective to anchor and no
    // real user message anywhere. The only user-role messages left after
    // compaction are the platform's own: the summary and the nudge. Recording
    // either would put the platform's housekeeping in the record as the thing the
    // run was asked to do.
    const state = makeState(
      historyOf(Math.ceil(WINDOW * 0.8)).map((m) => ({ ...m, role: 'assistant' })),
    );
    const posture = await apply(service, state);
    expect(posture.compacted).toBe(true);
    expect(capturedUserTurn(posture.rebuilt, state)).toBeUndefined();
  });

  it('keeps the summary ahead of the retained turns when the rebuilt half survives', async () => {
    process.env.HISTORY_COMPACT_RETAIN = '4';
    const rebuilt: PlatformMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: 'user',
      content: [{ type: 'text', text: `prior ${i} ${'z'.repeat(9_000)}` }],
    }));
    const state = makeState([{ role: 'user', content: 'continue' }]);
    const posture = await apply(service, state, { rebuilt });
    expect(posture.compacted).toBe(true);
    expect(posture.rebuilt[0].content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(COMPACTION_SUMMARY_HEADER.slice(0, 40)),
    });
  });
});
