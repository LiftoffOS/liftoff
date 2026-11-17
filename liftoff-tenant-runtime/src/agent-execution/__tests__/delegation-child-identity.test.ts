// The delegated child IS the agent — the contract, asserted end to end at the
// executeTask seam WITHOUT stubbing the enforcement it exists to prove.
//
// delegate-to-agent.test.ts asserts delegateToAgent's contract with executeTask
// (what a parent may contribute). This file asserts the other half: that what
// executeTask assembles for a delegated child is the CHILD's own identity and
// governance, not a hand-rolled substitute. The three assertions here are the
// three ways the old path failed:
//
//   1. governance: the child ran at hitlLevel 5, so a workspace configured to
//      draft all outbound communication had delegated children sending live;
//   2. identity: the child ran on the one-line "You are a specialist agent"
//      prompt, so persona, instructions and boundaries were all absent;
//   3. shape: depth was dropped, so every child was an orchestrator and a
//      chain could recurse to the container's OOM.
//
// The hitl-enforcement module is NOT mocked here. Mocking it is precisely how
// a fully-inert control once shipped fully green.

const mockPoolQuery = jest.fn();
const mockGetAgent = jest.fn();
const mockCreateAdapter = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => ({ query: mockPoolQuery })),
  // hitl-enforcement's real module reads both named pools.
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  pool: { query: (...a: unknown[]) => mockPoolQuery(...a) },
}));
jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger, logAudit: jest.fn() };
});
jest.mock('../../infrastructure/pubsub', () => ({
  publisher: { publish: jest.fn().mockResolvedValue('msg-id') },
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    getAgent: mockGetAgent,
    pause: jest.fn().mockResolvedValue(undefined),
    updateRuntimeStatus: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({ recordUsage: jest.fn().mockResolvedValue(undefined) })),
}));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getModelForTask: jest.fn().mockResolvedValue(undefined),
    getFeatureFlags: jest.fn().mockResolvedValue({}),
  }),
}));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({ dispatch: jest.fn() }) }));
jest.mock('../../tool-gateway/dispatcher', () => ({ getToolGatewayDispatcher: jest.fn().mockReturnValue({ execute: jest.fn() }) }));
jest.mock('../adapter', () => ({
  createAdapter: (...args: unknown[]) => mockCreateAdapter(...args),
}));
jest.mock('../../memory', () => ({
  memoryService: { retrieve: jest.fn().mockResolvedValue([]), recordRetrievalEvent: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../memory/embedding', () => ({ generateEmbedding: jest.fn().mockResolvedValue([]) }));
jest.mock('../../invocations', () => ({
  invocationsService: {
    createInvocation: jest.fn().mockImplementation(async (input: { id?: string }) => ({
      id: input.id ?? 'child-inv-1',
      startedAt: new Date('2026-01-01T00:00:00Z'),
    })),
    completeInvocation: jest.fn().mockResolvedValue(undefined),
    failInvocation: jest.fn().mockResolvedValue(undefined),
    markBillingQueued: jest.fn().mockResolvedValue(undefined),
    getMessages: jest.fn().mockResolvedValue([]),
    getInvocation: jest.fn().mockResolvedValue(null),
    listInvocations: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../streaming', () => ({ streamingService: { sendEvent: jest.fn(), close: jest.fn(), emitHitlRequired: jest.fn() } }));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/citation-warning', () => ({
  deriveInternalDomains: jest.fn().mockReturnValue([]),
  evaluateCitationWarning: jest.fn().mockReturnValue({}),
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    findByConnectorId: jest.fn().mockResolvedValue(null),
    getManifestsForAgent: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn().mockReturnValue(undefined),
  getToolSchemas: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../run-state/service', () => ({
  agentRunStateService: {
    create: jest.fn().mockResolvedValue({}),
    load: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
    appendItem: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: jest.fn().mockResolvedValue([]),
  buildSkillContextBlock: jest.fn().mockReturnValue(''),
  buildSkillTextBlock: jest.fn().mockReturnValue(''),
  skillDisclosureMode: jest.fn().mockReturnValue('inline'),
}));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../reflection-engine/trigger-service', () => ({
  reflectionTriggerService: { maybeTrigger: jest.fn().mockResolvedValue(undefined), onTaskCompleted: jest.fn() },
}));
jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({
  calculateCost: jest.fn().mockReturnValue({ costUsd: 0, inputPricePerMillion: 3, outputPricePerMillion: 15 }),
  getModelPricing: jest.fn().mockReturnValue({ inputPricePerMillion: 3, outputPricePerMillion: 15 }),
  googleSearchGroundingCostUsd: jest.fn().mockReturnValue(0),
  openAiWebSearchCostUsd: jest.fn().mockReturnValue(0),
  xaiWebSearchCostUsd: jest.fn().mockReturnValue(0),
  anthropicWebSearchCostUsd: jest.fn().mockReturnValue(0),
}));
jest.mock('../tool-interceptor', () => ({ interceptToolCalls: jest.fn().mockReturnValue([]) }));
jest.mock('../../interactive-chat/system-prompt', () => ({ getHitlDescription: jest.fn().mockReturnValue('level description') }));

import { AgentExecutionService } from '../service';
import { AGENT_VOICE_BLOCK } from '../../interactive-chat/agent-voice';

const TENANT = 'tenant-1';
const CHILD = 'child-agent-1';

/** The child's own compiled instruction: a real persona, so the prompt
 *  assertion can tell the agent's identity from the old generic line. */
function makeInstructionRow() {
  return {
    id: 'inst-1', tenant_id: TENANT, agent_id: CHILD, version: 3, status: 'active',
    instruction: JSON.stringify({
      allowedConnectors: [],
      allowedActionTypes: ['*'],
      systemPrompt: 'You are the Security Review team. Refuse to approve unaudited dependencies.',
      userInstructions: 'Always cite the CVE database.',
    }),
    validation_result: null, preview: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    instructions_md: null,
  };
}

/** The child's own agent row. hitl_level 2 = the team's own configured level
 *  ("controlled"), which is exactly what the old path overrode with 5. */
function makeAgentRow(hitlLevel = 2) {
  return {
    agent_type: 'agent', hitl_level: hitlLevel,
    model_config: JSON.stringify({ provider: 'anthropic' }),
    exec_config: JSON.stringify({ maxToolCalls: 12 }),
    memory_scope: JSON.stringify({}),
    workflow_steps: null,
    engine_config: JSON.stringify({ type: 'claude-agent-sdk' }),
    workflow_steps_hash: null,
  };
}

function routePool(overrides?: { oversightRow?: Record<string, unknown> | null }) {
  mockPoolQuery.mockImplementation(async (sql: string) => {
    if (/FROM compiled_instructions/i.test(sql)) return { rows: [makeInstructionRow()] };
    if (/FROM agents\b/i.test(sql)) return { rows: [makeAgentRow()] };
    if (/count\(\*\) AS n FROM delegation_active/i.test(sql)) return { rows: [{ n: '0' }] };
    if (/FROM delegation_active/i.test(sql)) return { rows: [] };
    if (/FROM invocations/i.test(sql)) return { rows: [{ delegation_depth: 0 }] };
    // tenant oversight cache read (hitl-enforcement getOversightSettings).
    if (/tenant_oversight_cache/i.test(sql)) {
      return {
        rows: overrides?.oversightRow === null ? [] : [overrides?.oversightRow ?? {
          tenant_id: TENANT,
          autonomy: 'controlled',
          escalation: 'important',
          sensitive_work: JSON.stringify({ customerCommunication: true }),
          communication: 'draft',
        }],
      };
    }
    return { rows: [] };
  });
}

function makeService() {
  const service = new AgentExecutionService();
  (service as unknown as { admissionService: unknown }).admissionService = {
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
  };
  jest.spyOn(service as never, 'verifyCanonicalAgentStatus' as never).mockResolvedValue('active' as never);
  mockGetAgent.mockResolvedValue({ id: CHILD, tenantId: TENANT, lifecycle: 'ACTIVE' });
  return service;
}

/** Adapter that records what it was invoked with and succeeds with one line. */
function recordingAdapter() {
  const invocations: Array<Record<string, unknown>> = [];
  mockCreateAdapter.mockReturnValue({
    registerToolCatalog: jest.fn(),
    registerHitlGate: jest.fn(),
    registerAnomalyHandler: jest.fn(),
    registerTrajectoryRecorder: jest.fn(),
    invoke: jest.fn().mockImplementation((input: Record<string, unknown>) => {
      invocations.push(input);
      return (async function* () {
        yield { type: 'assistant_message', content: [{ type: 'text', text: 'done' }] };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'completion', outcome: 'success' };
      })();
    }),
  });
  return invocations;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolQuery.mockReset();
});

describe('what a delegated child actually runs as', () => {
  it('runs on the CHILD’s own persona, not a generic specialist line', async () => {
    routePool();
    const service = makeService();
    // Skip only the catalog build (network/DB heavy); the prompt is assembled
    // by the real buildSystemPrompt over the real instruction row.
    jest.spyOn(service as never, 'buildPlatformMcpCatalog' as never)
      .mockResolvedValue({ tools: [], servers: [] } as never);
    const invocations = recordingAdapter();

    await service.delegateToAgent({
      collect: true, agentId: CHILD, tenantId: TENANT, objective: 'Review this dependency',
    });

    expect(invocations).toHaveLength(1);
    const prompt = String(invocations[0].systemPrompt);
    expect(prompt).toContain('You are the Security Review team');
    expect(prompt).toContain('Always cite the CVE database.');
    expect(prompt).not.toContain('You are a specialist agent. Answer the objective concisely');
  });

  it('resolves the CHILD’s own HITL level and oversight, not a constant', async () => {
    routePool();
    const service = makeService();
    let capturedContext: { hitlLevel?: number; oversight?: { communication?: string } } | undefined;
    jest.spyOn(service as never, 'buildPlatformMcpCatalog' as never)
      .mockImplementation((async (state: { context: typeof capturedContext }) => {
        capturedContext = state.context;
        return { tools: [], servers: [] };
      }) as never);
    recordingAdapter();

    await service.delegateToAgent({
      collect: true, agentId: CHILD, tenantId: TENANT, objective: 'x',
    });

    // The agent row says 2; the old path hardcoded 5. Any constant here is the
    // same bug with a different number.
    expect(capturedContext?.hitlLevel).toBe(2);
    // Oversight is ON the context, so the gateway's draft/review outbound
    // filter and the sensitive-work categories are live for the child. The old
    // context omitted the key entirely, and oversight-decision returns `allow`
    // for undefined — which is how a draft-everything workspace sent live.
    expect(capturedContext?.oversight).toBeDefined();
    expect(capturedContext?.oversight?.communication).toBe('draft');
  });

  it('carries the resolved depth on the context, so the child’s role can bind', async () => {
    routePool();
    const service = makeService();
    let capturedContext: { delegationDepth?: number | null } | undefined;
    jest.spyOn(service as never, 'buildPlatformMcpCatalog' as never)
      .mockImplementation((async (state: { context: typeof capturedContext }) => {
        capturedContext = state.context;
        return { tools: [], servers: [] };
      }) as never);
    recordingAdapter();

    await service.delegateToAgent({
      collect: true, agentId: CHILD, tenantId: TENANT, objective: 'x',
      parentInvocationId: 'parent-inv-1',
    });

    // Parent row at depth 0 → child at 1. The old path left the context's
    // depth unset, which resolved role 'orchestrator' at every level.
    expect(capturedContext?.delegationDepth).toBe(1);
  });

  it('refuses the hop that would exceed the chain cap', async () => {
    routePool();
    // The parent is already AT the default cap (2), so its child would be hop
    // 3. This is the recursion bound working through the same entry point the
    // model actually calls, engine-independent because it runs in the tool
    // handler path rather than in any engine's catalog handling.
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (/FROM compiled_instructions/i.test(sql)) return { rows: [makeInstructionRow()] };
      if (/FROM agents\b/i.test(sql)) return { rows: [makeAgentRow()] };
      if (/count\(\*\) AS n FROM delegation_active/i.test(sql)) return { rows: [{ n: '0' }] };
      if (/FROM invocations/i.test(sql)) return { rows: [{ delegation_depth: 2 }] };
      return { rows: [] };
    });
    const service = makeService();
    recordingAdapter();

    await expect(
      service.delegateToAgent({
        collect: true, agentId: CHILD, tenantId: TENANT, objective: 'x',
        parentInvocationId: 'deep-parent',
      }),
    ).rejects.toMatchObject({ code: 'depth_exceeded' });
  });
});

// The voice rules reach an AUTONOMOUS run, asserted through the real
// buildSystemPrompt rather than by reading the source.
//
// This is the half of the contract that breaks quietly. Rules baked into each team's
// distilled prompt by platform-backend's distiller, which is only TOLD to include
// them, end up missing from many teams. Interactive chat hides that completely,
// because buildAgentChatSystemPrompt injects its own copy on every turn, so any test
// of the chat path passes regardless. A delegated run is the
// cheapest real exercise of the autonomous path in this suite, and it goes through the
// same buildSystemPrompt every scheduled and event-triggered run uses.
describe('what an autonomous run is told about voice', () => {
  it('carries the canonical voice block, alongside the child’s own persona', async () => {
    routePool();
    const service = makeService();
    jest.spyOn(service as never, 'buildPlatformMcpCatalog' as never)
      .mockResolvedValue({ tools: [], servers: [] } as never);
    const invocations = recordingAdapter();

    await service.delegateToAgent({
      collect: true, agentId: CHILD, tenantId: TENANT, objective: 'Review this dependency',
    });

    const prompt = String(invocations[0].systemPrompt);

    expect(prompt).toContain(AGENT_VOICE_BLOCK);
    // The block ADDS to the persona; it must not have displaced it.
    expect(prompt).toContain('You are the Security Review team');
  });

  it('places the block in the cacheable stable prefix', async () => {
    // It is byte-identical on every run of every team, so anywhere but the stable
    // tier re-sends the whole prefix uncached on every single turn. prompt-tiers.ts
    // exists because that regression already happened once.
    routePool();
    const service = makeService();
    jest.spyOn(service as never, 'buildPlatformMcpCatalog' as never)
      .mockResolvedValue({ tools: [], servers: [] } as never);
    const invocations = recordingAdapter();

    await service.delegateToAgent({
      collect: true, agentId: CHILD, tenantId: TENANT, objective: 'Review this dependency',
    });

    const prompt = String(invocations[0].systemPrompt);
    const blockAt = prompt.indexOf(AGENT_VOICE_BLOCK);
    const objectiveAt = prompt.indexOf('## Current Objective');

    expect(blockAt).toBeGreaterThan(-1);
    // The objective is the first volatile block. Everything stable precedes it.
    expect(objectiveAt).toBeGreaterThan(-1);
    expect(blockAt).toBeLessThan(objectiveAt);
  });

  it('states the non-disclosure rules exactly once', async () => {
    // BASELINE_SKILLS used to carry its own copy. Two statements of one rule in a
    // single prompt is how the previous arrangement drifted.
    routePool();
    const service = makeService();
    jest.spyOn(service as never, 'buildPlatformMcpCatalog' as never)
      .mockResolvedValue({ tools: [], servers: [] } as never);
    const invocations = recordingAdapter();

    await service.delegateToAgent({
      collect: true, agentId: CHILD, tenantId: TENANT, objective: 'Review this dependency',
    });

    const prompt = String(invocations[0].systemPrompt);

    expect(prompt.split('Never disclose internal implementation').length - 1).toBe(1);
  });
});
