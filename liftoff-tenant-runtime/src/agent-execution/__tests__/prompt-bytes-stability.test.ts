// Prompt bytes are stable where caching needs them to be.
//
// Prompt caching pays only when a byte-identical PREFIX repeats, so
// `prompt-tiers.ts` orders the system prompt stable → session → volatile. Its
// own comment predicts the decay: an order held by the sequence of `+=` lines
// rots the first time somebody appends a block in the obvious place, and the
// only symptom is a cache-hit rate that quietly falls. `prompt-tiers.test.ts`
// pins the ordering and the prefix split of the CLASS; nothing compared two
// real assemblies of a real agent's prompt, which is the property that
// actually costs money when it is lost.
//
// So this assembles a fixed agent's prompt twice and reads the tiers back:
// the stable and session tiers are byte-identical across the two, and every
// input documented as NOT prompt bytes — the objective, the recalled memories,
// the prior run, the retrieved skills, the browser session, the content trust
// level, the engine flags, the open task ledger, the data landscape and the
// prior work — can move without moving a byte of the stable render.

const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => ({ query: mockPoolQuery })),
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  withTenantScope: jest.fn(async (_t: string, fn: (c: { query: jest.Mock }) => unknown) => fn({ query: mockPoolQuery })),
  pool: { query: (...a: unknown[]) => mockPoolQuery(...a) },
}));
jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger, logAudit: jest.fn() };
});
jest.mock('../../infrastructure/pubsub', () => ({ publisher: { publish: jest.fn().mockResolvedValue('msg-id') } }));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    getAgent: jest.fn(), pause: jest.fn(), updateRuntimeStatus: jest.fn(),
  })),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({ getEntitlementsClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({ getToolGatewayDispatcher: jest.fn().mockReturnValue({ execute: jest.fn() }) }));
jest.mock('../adapter', () => ({ createAdapter: jest.fn(), constructAdapterForEngine: jest.fn() }));
jest.mock('../../memory', () => ({ memoryService: { retrieve: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../memory/embedding', () => ({ generateEmbedding: jest.fn().mockResolvedValue([]) }));
jest.mock('../../invocations', () => ({ invocationsService: {} }));
jest.mock('../../streaming', () => ({ streamingService: { sendEvent: jest.fn(), close: jest.fn(), emitHitlRequired: jest.fn() } }));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({ resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]) }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../run-state/service', () => ({ agentRunStateService: {} }));
jest.mock('../../platform-callback/client', () => ({ getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn() }));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: {} }));
jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../tool-interceptor', () => ({ interceptToolCalls: jest.fn().mockReturnValue([]) }));
jest.mock('../../interactive-chat/system-prompt', () => ({ getHitlDescription: jest.fn().mockReturnValue('level description') }));
jest.mock('../../connectors/connector-service-client', () => ({ getPrefetchThreadClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/capability-approval-signal', () => ({
  recordCapabilityApproval: jest.fn(), capabilityApprovalKey: () => null,
  capabilityHandleNeedsApproval: () => false, consumeCapabilityApproval: jest.fn(),
}));

// ── The inputs this test moves ────────────────────────────────────────────
const retrievedSkills = jest.fn<Promise<unknown[]>, unknown[]>().mockResolvedValue([]);
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: (...a: unknown[]) => retrievedSkills(...a),
  buildSkillContextBlock: (skills: Array<{ id: string; name?: string }>) =>
    `## Skills\n${skills.map((s) => `- ${s.id}`).join('\n') || '- (baseline)'}`,
  skillDisclosureMode: () => 'inline',
}));
jest.mock('../../skills/bundle-materializer', () => ({ describeSkillFiles: () => null }));
const openTaskLedger = jest.fn<Promise<unknown[]>, unknown[]>().mockResolvedValue([]);
jest.mock('../task-ledger/service', () => ({
  getOpenTaskLedger: (...a: unknown[]) => openTaskLedger(...a),
  renderTaskLedgerBlock: (items: unknown[]) => (items.length ? `\n\n## Open tasks\n- ${items.length} open` : ''),
}));
const landscapeBlock = jest.fn<string, unknown[]>().mockReturnValue('');
jest.mock('../../connector-replica/landscape-service', () => ({
  getDataLandscape: jest.fn().mockResolvedValue({}),
  renderLandscapeBlock: (...a: unknown[]) => landscapeBlock(...a),
}));
const priorWorkBlock = jest.fn<string | null, unknown[]>().mockReturnValue(null);
jest.mock('../prior-work', () => ({
  priorWork: jest.fn().mockResolvedValue([]),
  renderPriorWorkBlock: (...a: unknown[]) => priorWorkBlock(...a),
}));
const visibleBrowser = jest.fn<Promise<boolean>, unknown[]>().mockResolvedValue(false);
jest.mock('../../interactive-chat/web-tool-selection', () => {
  const actual = jest.requireActual('../../interactive-chat/web-tool-selection');
  return { ...actual, hasVisibleBrowserFrom: (...a: unknown[]) => visibleBrowser(...a) };
});
jest.mock('../../memory/service', () => ({
  buildMemoryContextBlock: (memories: Array<{ content: string }>) =>
    `## Memories\n${memories.map((m) => `- ${m.content}`).join('\n')}`,
}));

// Record every TieredPrompt the assembly builds, so the tiers can be read
// back without the service growing a test-only return shape.
const tieredPrompts: Array<import('../prompt-tiers').TieredPrompt> = [];
jest.mock('../prompt-tiers', () => {
  const actual = jest.requireActual('../prompt-tiers') as typeof import('../prompt-tiers');
  class RecordingTieredPrompt extends actual.TieredPrompt {
    constructor() {
      super();
      tieredPrompts.push(this);
    }
  }
  return { ...actual, TieredPrompt: RecordingTieredPrompt };
});

import { AgentExecutionService } from '../service';
import type { ExecutionContext, ExecutionState } from '../types';

const TENANT = 'tenant-1';
const AGENT = 'agent-1';

function makeContext(over: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    tenantId: TENANT, agentId: AGENT, workflowId: 'wf-1', taskId: 'task-1',
    instructionVersion: 3,
    instruction: {
      allowedConnectors: ['gmail-1'],
      allowedActionTypes: ['*'],
      allowedTools: ['*'],
      writeScopes: [],
      systemPrompt: 'You are the Support Desk team. Answer what was asked; escalate what you cannot.',
      userInstructions: 'Always cite the ticket number.',
      instructionsMd: '## Pitfalls and gotchas\n- Never promise a refund date.',
    } as unknown as ExecutionContext['instruction'],
    traceId: 'tr-1', agentType: 'agent',
    hitlLevel: 3,
    modelConfig: { provider: 'anthropic' } as ExecutionContext['modelConfig'],
    execConfig: {} as ExecutionContext['execConfig'],
    memoryScope: {} as ExecutionContext['memoryScope'],
    integrations: [{ id: 'gmail-1', type: 'google_mail', alias: 'gmail-1' }] as unknown as ExecutionContext['integrations'],
    invocationId: 'inv-1',
    trustLevel: 'trusted',
    ...over,
  };
}

function makeState(context: ExecutionContext): ExecutionState {
  return {
    context, reasoningSteps: 0, toolCallsExecuted: 0, startTime: new Date(0), steps: [],
    conversationHistory: [], pendingToolCalls: [], completedToolCalls: [],
    toolFailureCounts: new Map(), injectedSkillIds: [],
  };
}

interface Assembly {
  prompt: string;
  stable: string;
  session: string;
  volatile: string;
}

/** Assemble the fixed agent's prompt once and read the tiers back. */
async function assemble(context: ExecutionContext, objective = 'Answer ticket 4711 about the delayed order'): Promise<Assembly> {
  const svc = new AgentExecutionService();
  const before = tieredPrompts.length;
  const prompt = await (svc as unknown as {
    buildSystemPrompt(state: ExecutionState, objective: string): Promise<string>;
  }).buildSystemPrompt(makeState(context), objective);
  const built = tieredPrompts.slice(before);
  expect(built).toHaveLength(1);
  const ordered = built[0].ordered();
  const tier = (t: 'stable' | 'session' | 'volatile') => ordered.filter((s) => s.tier === t).map((s) => s.text).join('\n\n');
  return { prompt, stable: tier('stable'), session: tier('session'), volatile: tier('volatile') };
}

const ENGINE_FLAGS = ['OPENAI_ENGINE', 'GOOGLE_ENGINE', 'XAI_ENGINE', 'OPENROUTER_ENGINE'] as const;
const savedFlags: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const f of ENGINE_FLAGS) { savedFlags[f] = process.env[f]; delete process.env[f]; }
  // The two reads the assembly makes of the database: the agent's role and its
  // learned role instructions. Empty, and the same both times.
  mockPoolQuery.mockImplementation(async () => ({ rows: [] }));
  retrievedSkills.mockResolvedValue([]);
  openTaskLedger.mockResolvedValue([]);
  landscapeBlock.mockReturnValue('');
  priorWorkBlock.mockReturnValue(null);
  visibleBrowser.mockResolvedValue(false);
});
afterEach(() => {
  for (const f of ENGINE_FLAGS) {
    if (savedFlags[f] === undefined) delete process.env[f];
    else process.env[f] = savedFlags[f];
  }
});

describe('two assemblies of one agent', () => {
  it('are byte-identical in the stable and session tiers, and in full', async () => {
    const a = await assemble(makeContext());
    const b = await assemble(makeContext());
    expect(a.stable.length).toBeGreaterThan(1000);
    expect(b.stable).toBe(a.stable);
    expect(b.session).toBe(a.session);
    expect(b.prompt).toBe(a.prompt);
  });
});

// Each row flips ONE input the tiering documents as not part of the stable
// prefix, and asserts the stable render did not move. The `moves` column says
// where the change is allowed to land, so a row also proves the harness saw
// the flip rather than passing on a fixture that did nothing.
type Flip = {
  name: string;
  arm: () => void;
  context?: Partial<ExecutionContext>;
  objective?: string;
  /** Where the flipped input is allowed to show up. */
  moves: 'volatile' | 'session' | 'outside_tiers' | 'nowhere';
};

const FLIPS: Flip[] = [
  {
    name: 'the objective',
    arm: () => {},
    objective: 'Close ticket 9000 as a duplicate',
    moves: 'volatile',
  },
  {
    name: 'the recalled memories',
    arm: () => {},
    context: { memories: [{ id: 'm1', content: 'The customer prefers email.' }] as unknown as ExecutionContext['memories'] },
    moves: 'volatile',
  },
  {
    name: 'the prior run summary',
    arm: () => {},
    context: { priorInvocationSummary: 'Last run replied to ticket 4710.' } as Partial<ExecutionContext>,
    moves: 'volatile',
  },
  {
    name: 'the retrieved skills',
    arm: () => { retrievedSkills.mockResolvedValue([{ id: 'refund-policy', name: 'Refund policy', instruction: 'x', description: 'x' }]); },
    moves: 'volatile',
  },
  {
    name: 'the browser session',
    arm: () => {},
    context: { activeBrowserSession: { id: 'bs-1' } } as unknown as Partial<ExecutionContext>,
    moves: 'session',
  },
  {
    name: 'the data landscape',
    arm: () => { landscapeBlock.mockReturnValue('## What is in your systems\n- 14 threads'); },
    moves: 'session',
  },
  {
    name: 'the prior work',
    arm: () => { priorWorkBlock.mockReturnValue('## What you have already produced\n- a reply'); },
    moves: 'session',
  },
  {
    name: 'the content trust level',
    arm: () => {},
    context: { trustLevel: 'untrusted_inbound' },
    moves: 'outside_tiers',
  },
  {
    name: 'the open task ledger',
    arm: () => { openTaskLedger.mockResolvedValue([{ id: 't1' }]); },
    moves: 'outside_tiers',
  },
  {
    name: 'the engine flags',
    arm: () => {
      process.env.OPENAI_ENGINE = 'agents';
      process.env.GOOGLE_ENGINE = 'adk';
      process.env.XAI_ENGINE = 'wire';
      process.env.OPENROUTER_ENGINE = 'wire';
    },
    moves: 'nowhere',
  },
];

describe.each(FLIPS.map((f) => [f.name, f] as const))('flipping %s', (_name, flip) => {
  it('leaves the stable render unchanged', async () => {
    const baseline = await assemble(makeContext());
    flip.arm();
    const flipped = await assemble(makeContext(flip.context), flip.objective);

    expect(flipped.stable).toBe(baseline.stable);

    switch (flip.moves) {
      case 'volatile':
        expect(flipped.volatile).not.toBe(baseline.volatile);
        expect(flipped.session).toBe(baseline.session);
        break;
      case 'session':
        expect(flipped.session).not.toBe(baseline.session);
        expect(flipped.volatile).toBe(baseline.volatile);
        break;
      case 'outside_tiers':
        // Changed the prompt, but landed outside every tier: the untrusted
        // directive is appended after the tail on purpose (its position is its
        // argument), and the task ledger sits above it.
        expect(flipped.prompt).not.toBe(baseline.prompt);
        expect(flipped.session).toBe(baseline.session);
        expect(flipped.volatile).toBe(baseline.volatile);
        break;
      case 'nowhere':
        // An engine is a deployment fact the prompt never learns.
        expect(flipped.prompt).toBe(baseline.prompt);
        break;
    }
  });
});
