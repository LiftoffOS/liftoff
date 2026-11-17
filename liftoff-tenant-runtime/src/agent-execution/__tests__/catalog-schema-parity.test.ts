/**
 * Catalog ↔ schema parity invariant.
 *
 * The adapter dispatch surface is buildPlatformMcpCatalog (calls
 * createToolGatewayMcpServer). The workflow-graph validation surface
 * (D23) is buildToolsSchema. For the tool families both sides
 * enumerate — connector, agent_slack, sandbox primitives, vendor-
 * filtered standard tools — their outputs must agree exactly.
 *
 * A THIRD surface asks the same question ahead of time: the workflow steps
 * audit. Outside this invariant it can drift into answering from chat's
 * catalog instead, so it goes through buildValidationToolNames, pinned by the
 * first case below and by its own call-site test in
 * src/jobs/__tests__/workflow-steps-audit-catalog-source.test.ts.
 *
 * Without this test the two enumerations can drift: a future change
 * adding (or removing) a tool source on one side would silently leave
 * the LLM unable to dispatch a tool the validator says is available,
 * or pass validation for a tool the dispatcher can't see (e.g. slack +
 * sandbox + web on the schema side but missing from the catalog).
 * This test catches such regressions at CI time.
 *
 * TIERED TOOLS COUNT AS PRESENT. A collapsed group contributes a search/call
 * pair instead of its members, and the members move to `deferredVendorTools`
 * where dispatchFunctionCall still resolves them. They are deferred, not
 * removed, so the parity question — "can the LLM dispatch what the validator
 * says is available?" — is asked against kept ∪ deferred. Comparing only the
 * visible half would report a regression every time a group is collapsed, which
 * is the behaviour rather than a defect.
 *
 * Out of scope (legitimately differs):
 *   - Catalog-only tools the schema doesn't enumerate (in-process MCP
 *     primitives: search, find_teammates, code_session,
 *     review_recent_activity, delegate_to_agent, spawn_child_task)
 *   - Schema-only tools whose catalog form is a remote vendor MCP
 *     server (GitHub MCP, Stripe MCP, custom_mcp_server, external__*) —
 *     those are discovered live by the vendor SDKs at connect time and
 *     don't appear in catalog.tools, only in catalog.servers as remote
 *     URLs.
 */

// ── Mocks (mirror the hybrid-loop-integration harness) ──────────────────

// Faithful to the real `tool()`, which returns SdkMcpToolDefinition —
// `{ name, description, inputSchema, handler }`. A mock that drops
// `inputSchema` cannot assert the schema half of "catalog ↔ schema parity" at
// all: every tool looks argument-less to the test, which hides the same gap on
// every non-Anthropic engine.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((name: string, description: string, inputSchema: unknown, handler: (...args: unknown[]) => unknown) =>
    ({ name, description, inputSchema, handler })),
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

// Connector manifest registry — single fake connector. id matches the
// integration id below so buildToolsSchema's bound-integration filter
// (multi-account safety guard) accepts it.
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifests: jest.fn().mockResolvedValue([
      { id: 'conn-1', connectorType: 'google-mail', alias: 'my_gmail', displayName: 'My Gmail', enabled: true },
    ]),
    getManifestsForAgent: jest.fn().mockResolvedValue([
      { id: 'conn-1', connectorType: 'google-mail', alias: 'my_gmail', displayName: 'My Gmail', enabled: true },
    ]),
  },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([
    { name: 'send_email', description: 'Send email', inputSchema: { type: 'object', properties: {} }, categories: ['write'], entityType: 'message' },
    { name: 'read_email', description: 'Read email', inputSchema: { type: 'object', properties: {} }, categories: ['read'], entityType: 'message' },
  ]),
  listConnectorTypes: jest.fn().mockReturnValue(['google-mail']),
}));

// Standard tools — small fixed set including a web tool to exercise
// the vendor-filter alignment.
jest.mock('../../tools/standard-tools', () => ({
  STANDARD_TOOLS: [
    { name: 'memory_save', description: 'Save memory', input_schema: { type: 'object', properties: {} } },
    { name: 'memory_retrieve', description: 'Retrieve memory', input_schema: { type: 'object', properties: {} } },
    { name: 'web_research', description: 'Web research', input_schema: { type: 'object', properties: {} } },
    // The bridged basic search: the one standard tool the two surfaces are
    // allowed to disagree on, and only in one direction (see the asymmetry
    // case below).
    { name: 'web_search', description: 'Web search', input_schema: { type: 'object', properties: {} } },
    // The agent's own read of its own ledger — the tool the workflow catalog
    // handed to the gate unclassified. Its name holds no verb the fallback
    // classifier knows, so only the stated effect can say it is a read.
    { name: 'have_i_acted_on', description: 'Own ledger', input_schema: { type: 'object', properties: {} } },
  ],
}));

// Pin web-vendor flags: only perplexity ON. web_research depends on
// any-research-backend (perplexity included), so it should survive.
jest.mock('../../integrations/web-fetch/global-flags', () => ({
  getAllVendorFlags: jest.fn().mockResolvedValue({ perplexity: true, openai: false, google: false }),
}));
jest.mock('../../integrations/web-fetch/web-tool-secrets', () => ({
  getTenantConnectedWebVendors: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('../../browser-sessions/repository', () => ({
  getActiveForThread: jest.fn().mockResolvedValue(null),
}));

// Per-agent Slack: one install with a real bot token.
jest.mock('../../agent-chat/agent-slack-client', () => ({
  listAgentSlackInstalls: jest.fn().mockResolvedValue([
    { slackTeamId: 'T1', botToken: 'xoxb-stub', botUserId: 'U1' },
  ]),
}));

// Per-agent Teams: one bound conversation so teams_* tools surface on both
// sides (catalog via mcp-server, schema via buildToolsSchema).
jest.mock('../../agent-chat/agent-teams-client', () => ({
  listAgentTeamsConversations: jest.fn().mockResolvedValue([
    { conversationId: 'C1', scope: 'channel' },
  ]),
}));

// Knowledge-bound check (gates corpus_search) — neither side exposes
// it in this test, so a 0 here keeps both paths aligned.
jest.mock('../../tool-gateway/knowledge-exposure-cache', () => ({
  tenantHasBoundKnowledge: jest.fn().mockResolvedValue(false),
}));

// Cloud Tasks / DB stubs (not exercised by buildToolsSchema or the
// catalog directly, but loaded by the service constructor).
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

// runtime-env.requireEnv throws for missing PLATFORM_BACKEND_URL /
// PLATFORM_CALLBACK_TOKEN — buildToolsSchema reaches it via
// loadExternalAgentsForInternalAgent. Set sentinel values so the
// service construction + tool schema build complete; the find_teammates
// MCP tool path is bucketed as "other" by the parity classifier so it
// doesn't pollute the shared-family comparison.
process.env.PLATFORM_BACKEND_URL = 'https://platform-backend.local';
process.env.PLATFORM_CALLBACK_TOKEN = 'test-token';

// loadExternalAgentsForInternalAgent calls global fetch — stub it
// at the global level so the network call doesn't fire.
(globalThis as { fetch?: typeof fetch }).fetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ agents: [] }),
}) as unknown as typeof fetch;

// ── Imports under test ──────────────────────────────────────────────────

import { AgentExecutionService, sandboxCapabilitiesForTier } from '../service';
import { nativeWebSearchFor } from '../adapter/native-web-search';
import type { ExecutionState, ExecutionContext } from '../types';

// ── Fixtures ────────────────────────────────────────────────────────────

function makeContext(): ExecutionContext {
  return {
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    workflowId: 'wf-1',
    taskId: 'task-1',
    instructionVersion: 1,
    instruction: {
      systemPrompt: 'test',
      allowedConnectors: ['google-mail'],
      allowedActionTypes: ['*'],
      allowedTools: ['*'],
      writeScopes: [],
      userInstructions: '',
    } as unknown as ExecutionContext['instruction'],
    traceId: 'trace-1',
    agentType: 'agent',
    hitlLevel: 0,
    modelConfig: {} as ExecutionContext['modelConfig'],
    execConfig: {},
    memoryScope: {},
    integrations: [{ id: 'conn-1', type: 'google_mail' }],
    sandboxCapabilities: ['shell', 'file'],
    threadId: 'thread-1',
    invocationId: 'inv-1',
  } as ExecutionContext;
}

function makeState(): ExecutionState {
  return {
    context: makeContext(),
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

/** Tool-name classes both enumerations are responsible for, used to
 *  bucket each side's output before comparison. Bucketing keeps the
 *  "catalog has internal MCP tools schema doesn't" and "schema has
 *  vendor-MCP tools catalog enumerates as remote servers" divergences
 *  out of the assertion — those are legitimate. */
function classify(name: string): 'slack' | 'teams' | 'sandbox' | 'standard' | 'connector' | 'other' {
  // code_session is the higher-level vendor-coding-agent entry point
  // (Claude Code / Codex / Gemini) registered only on the catalog
  // side; despite starting with code_ it is NOT a sandbox primitive.
  if (name === 'code_session') return 'other';

  // Per-agent Slack (AGENT_SLACK_TOOL_NAMES from agent-slack-tool-catalog).
  // Prefix slack_ is exact: every AGENT_SLACK_TOOL starts with it.
  if (name.startsWith('slack_')) return 'slack';

  // Per-agent Teams (AGENT_TEAMS_TOOL_NAMES from agent-teams-tool-catalog).
  // Prefix teams_ is exact: every AGENT_TEAMS_TOOL starts with it.
  if (name.startsWith('teams_')) return 'teams';

  // Sandbox primitives — filterSandboxFunctionsByCapabilities families.
  if (
    name.startsWith('shell_') || name.startsWith('bash_') || name.startsWith('nodejs_') ||
    name.startsWith('file_') || name.startsWith('git_') ||
    name.startsWith('browser_') || name.startsWith('proxy_') ||
    name.startsWith('vscode_') ||
    name.startsWith('util_') || name.startsWith('code_')
  ) {
    return 'sandbox';
  }

  // Connector tools — alias__action format from manifest registry.
  // Filter out internal__ (internal-agents) and external__ (external agents).
  if (name.includes('__') && !name.startsWith('internal__') && !name.startsWith('external__')) {
    return 'connector';
  }

  // Standard tools — every name in STANDARD_TOOLS that survived the
  // vendor-availability filter. In this test fixture STANDARD_TOOLS is
  // mocked to [memory_save, memory_retrieve, web_research, web_search,
  // have_i_acted_on].
  if (['memory_save', 'memory_retrieve', 'corpus_search', 'web_research', 'web_search'].includes(name)) {
    return 'standard';
  }

  return 'other';
}

/** Names in the schema (run) side that the catalog (model) side lacks. */
function standardDifference(catalogStandard: string[] | undefined, schemaStandard: string[] | undefined): string[] {
  const inCatalog = new Set(catalogStandard ?? []);
  return (schemaStandard ?? []).filter((n) => !inCatalog.has(n));
}

/** What that difference must be for a context: the bridged `web_search` alone
 *  where the MODEL surface's engine searches natively, nothing otherwise. The
 *  provider is read the way buildPlatformMcpCatalog reads it — the stamped
 *  resolution, else the agent config, else 'anthropic' — because that default
 *  is what the model surface applies to a context that resolved nothing. */
function expectedStandardDifference(context: ExecutionContext): string[] {
  const provider = ((context as { resolvedProvider?: string }).resolvedProvider
    ?? (context.modelConfig?.provider as string | undefined)) ?? 'anthropic';
  return nativeWebSearchFor(provider, undefined) === true ? ['web_search'] : [];
}

function bucket(names: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of names) {
    const k = classify(n);
    if (k === 'other') continue;
    (out[k] ??= []).push(n);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

/** Every tool the model can reach: the ones it sees, plus the ones a collapsed
 *  group's search/call pair resolves. The synthetic pair itself is dropped —
 *  it is machinery, not a tool the validator knows about. */
function dispatchableNames(catalog: {
  tools: Array<{ name: string }>;
  deferredVendorTools?: Map<string, Array<{ name: string }>>;
}): string[] {
  const visible = catalog.tools
    .map((t) => t.name)
    .filter((n) => !/^search_.+_tools$/.test(n) && !/^call_.+_tool$/.test(n));
  const deferred = [...(catalog.deferredVendorTools?.values() ?? [])]
    .flat()
    .map((t) => t.name);
  return [...visible, ...deferred];
}

// ── Suite ───────────────────────────────────────────────────────────────

describe('catalog ↔ schema parity invariant', () => {
  let service: AgentExecutionService;

  beforeEach(() => {
    service = new AgentExecutionService();
  });

  // ── Third surface: the pre-flight audit ───────────────────────────────
  //
  // The invariant above covers the two surfaces a RUN uses. There is a third:
  // the workflow steps audit answers "would this graph run" ahead of time. Built
  // from `buildChatToolCatalog`, whose `toolNames` come from
  // `gatewayResult.modelTools` — an array complete before vendor servers are
  // contacted and never updated after — its catalog cannot hold a GitHub tool,
  // and it reports GitHub-bound agents as unable to run while the engine
  // resolves their steps fine.
  //
  // `buildValidationToolNames` is now the one entry point, and this pins it to
  // the same enumeration the validator checks against. A future change that
  // gives the audit its own catalog again fails here.
  it('the audit asks for exactly the names the validator checks against', async () => {
    const state = makeState();
    const [validationNames, schema] = await Promise.all([
      service.buildValidationToolNames(state.context),
      (service as unknown as {
        buildToolsSchema: (c: ExecutionContext) => Promise<Array<{ name: string }>>;
      }).buildToolsSchema(state.context),
    ]);

    expect([...validationNames].sort()).toEqual(schema.map((t) => t.name).sort());
    // Not vacuous: a catalog that came back empty would satisfy the equality
    // above and tell us nothing, which is the shape of the defect this covers.
    expect(validationNames.size).toBeGreaterThan(0);
  });

  it('produces identical (slack ∪ sandbox ∪ connector ∪ standard) tool sets', async () => {
    const state = makeState();
    const [catalog, schema] = await Promise.all([
      (service as unknown as {
        buildPlatformMcpCatalog: (s: ExecutionState) => Promise<{
          tools: Array<{ name: string }>;
          deferredVendorTools?: Map<string, Array<{ name: string }>>;
        }>;
      }).buildPlatformMcpCatalog(state),
      (service as unknown as {
        buildToolsSchema: (c: ExecutionContext) => Promise<Array<{ name: string }>>;
      }).buildToolsSchema(state.context),
    ]);

    const catalogNames = dispatchableNames(catalog);
    const schemaNames = schema.map((t) => t.name);
    const catalogBuckets = bucket(catalogNames);
    const schemaBuckets = bucket(schemaNames);

    // Connector tools — both should enumerate my_gmail__send_email +
    // my_gmail__read_email from the same manifest source.
    expect(catalogBuckets.connector).toEqual(schemaBuckets.connector);

    // Per-agent Slack tools — both should enumerate the same
    // AGENT_SLACK_TOOLS list since the install mock returns a bot token.
    expect(catalogBuckets.slack).toEqual(schemaBuckets.slack);

    // Per-agent Teams tools — both should enumerate the same
    // AGENT_TEAMS_TOOLS list since the conversation mock returns one.
    expect(catalogBuckets.teams).toEqual(schemaBuckets.teams);

    // Sandbox primitives — both should enumerate
    // filterSandboxFunctionsByCapabilities(['shell','file']).
    expect(catalogBuckets.sandbox).toEqual(schemaBuckets.sandbox);

    // Standard tools — both should apply buildExposedStandardTools
    // (perplexity ON, others OFF), so memory_save/memory_retrieve
    // survive and web_research survives via the perplexity backend.
    //
    // Exact equality is no longer the invariant here: the RUN's catalog
    // (schema) carries the bridged `web_search` wherever a backend exists,
    // because a deterministic step never calls the model; the MODEL's list
    // (catalog) withholds it where the engine attaches the vendor's own
    // search. That is the one permitted difference, in that one direction,
    // and the asymmetry case below pins it to exactly `web_search`.
    expect(standardDifference(catalogBuckets.standard, schemaBuckets.standard))
      .toEqual(expectedStandardDifference(state.context));
  });

  // ── The one permitted asymmetry ───────────────────────────────────────
  //
  // Schema minus catalog is exactly ['web_search'] on an engine that searches
  // natively and exactly [] on one that does not. Asserting the difference
  // rather than merely tolerating it means a second asymmetry cannot shelter
  // behind this one, and a regression that withholds `web_search` from the run
  // catalog again (the shape that degraded every `tool_call web_search` step
  // on the Anthropic engine) fails on the first branch.
  it.each([
    ['anthropic', true],   // claude-agent-sdk attaches Claude's WebSearch
    ['xai', false],        // opencode attaches no vendor search
  ] as const)('schema minus catalog is exactly the bridged web_search on a native-search engine (%s → native=%s)', async (provider, native) => {
    const state = makeState();
    (state.context as { resolvedProvider?: string }).resolvedProvider = provider;
    expect(nativeWebSearchFor(provider, undefined)).toBe(native);
    const [catalog, schema] = await Promise.all([
      (service as unknown as {
        buildPlatformMcpCatalog: (s: ExecutionState) => Promise<{
          tools: Array<{ name: string }>;
          deferredVendorTools?: Map<string, Array<{ name: string }>>;
        }>;
      }).buildPlatformMcpCatalog(state),
      (service as unknown as {
        buildToolsSchema: (c: ExecutionContext) => Promise<Array<{ name: string }>>;
      }).buildToolsSchema(state.context),
    ]);
    const catalogStandard = bucket(dispatchableNames(catalog)).standard ?? [];
    const schemaStandard = bucket(schema.map((t) => t.name)).standard ?? [];
    // The run catalog carries it either way: a step can name it on any engine.
    expect(schemaStandard).toContain('web_search');
    expect(standardDifference(catalogStandard, schemaStandard)).toEqual(native ? ['web_search'] : []);
    // Never the other direction: nothing the model can call is missing from
    // the catalog the validator and the gate use.
    expect(catalogStandard.filter((n) => !schemaStandard.includes(n))).toEqual([]);
  });

  it('states the same side-effect class for every standard tool on both surfaces', async () => {
    // The gate reads `effect`. If the bridge stamps it on every standard tool
    // while the workflow catalog pushes the raw definitions, which carry none,
    // a run on the workflow path asks a person to approve `have_i_acted_on`,
    // the agent's own read of its own ledger, on every inbound poll.
    // Same tool, two catalogs, one fact: this holds them to it.
    const state = makeState();
    const [catalog, schema] = await Promise.all([
      (service as unknown as {
        buildPlatformMcpCatalog: (s: ExecutionState) => Promise<{ tools: Array<{ name: string; effect?: string }> }>;
      }).buildPlatformMcpCatalog(state),
      (service as unknown as {
        buildToolsSchema: (c: ExecutionContext) => Promise<Array<{ name: string; effect?: string }>>;
      }).buildToolsSchema(state.context),
    ]);
    const schemaEffect = new Map(schema.map((t) => [t.name, t.effect]));
    const standard = catalog.tools.filter((t) => classify(t.name) === 'standard');
    expect(standard.length).toBeGreaterThan(0);
    for (const t of standard) {
      expect({ tool: t.name, effect: schemaEffect.get(t.name) }).toEqual({ tool: t.name, effect: t.effect });
      expect(t.effect).toBeDefined();
    }
    // The tool that raised the cards, by name, so the parity above is not
    // vacuously satisfied by both sides omitting it.
    expect(schemaEffect.get('have_i_acted_on')).toBe('read');
  });

  it('agrees on filtered web tools when only perplexity vendor is enabled', async () => {
    // web_research's gate is anyResearchBackend = perplexity || webclaw
    // || firecrawl || tavily || exa. perplexity ON → web_research should
    // survive on both sides.
    const state = makeState();
    const [catalog, schema] = await Promise.all([
      (service as unknown as {
        buildPlatformMcpCatalog: (s: ExecutionState) => Promise<{
          tools: Array<{ name: string }>;
          deferredVendorTools?: Map<string, Array<{ name: string }>>;
        }>;
      }).buildPlatformMcpCatalog(state),
      (service as unknown as {
        buildToolsSchema: (c: ExecutionContext) => Promise<Array<{ name: string }>>;
      }).buildToolsSchema(state.context),
    ]);
    expect(catalog.tools.map((t) => t.name)).toContain('web_research');
    expect(schema.map((t) => t.name)).toContain('web_research');
  });

  it('agrees on the empty sandbox set when sandboxCapabilities is empty', async () => {
    const state = makeState();
    (state.context as { sandboxCapabilities?: readonly string[] }).sandboxCapabilities = [];
    const [catalog, schema] = await Promise.all([
      (service as unknown as {
        buildPlatformMcpCatalog: (s: ExecutionState) => Promise<{
          tools: Array<{ name: string }>;
          deferredVendorTools?: Map<string, Array<{ name: string }>>;
        }>;
      }).buildPlatformMcpCatalog(state),
      (service as unknown as {
        buildToolsSchema: (c: ExecutionContext) => Promise<Array<{ name: string }>>;
      }).buildToolsSchema(state.context),
    ]);
    const catalogBuckets = bucket(dispatchableNames(catalog));
    const schemaBuckets = bucket(schema.map((t) => t.name));
    expect(catalogBuckets.sandbox ?? []).toEqual([]);
    expect(schemaBuckets.sandbox ?? []).toEqual([]);
  });

  // ── R5 capability-tier contract ─────────────────────────────────────
  // Every context builder derives context.sandboxCapabilities from the
  // compiled instruction's capability_tier via sandboxCapabilitiesForTier
  // (the REAL production helper, imported above): execution_enabled → all
  // four families, anything else → []. These tests pin both tier-shaped
  // ends of that contract on BOTH enumeration sides, so a regression in
  // either the mapping or the consumers' gating surfaces here.
  it('exposes the full sandbox family for an execution_enabled-shaped context', async () => {
    const state = makeState();
    (state.context as { sandboxCapabilities?: readonly string[] }).sandboxCapabilities =
      sandboxCapabilitiesForTier('execution_enabled');
    const [catalog, schema] = await Promise.all([
      (service as unknown as {
        buildPlatformMcpCatalog: (s: ExecutionState) => Promise<{
          tools: Array<{ name: string }>;
          deferredVendorTools?: Map<string, Array<{ name: string }>>;
        }>;
      }).buildPlatformMcpCatalog(state),
      (service as unknown as {
        buildToolsSchema: (c: ExecutionContext) => Promise<Array<{ name: string }>>;
      }).buildToolsSchema(state.context),
    ]);
    const catalogBuckets = bucket(dispatchableNames(catalog));
    const schemaBuckets = bucket(schema.map((t) => t.name));
    expect(catalogBuckets.sandbox).toEqual(schemaBuckets.sandbox);
    // Representative member of each granted family, so a silently-dropped
    // family cannot pass on set-equality alone.
    expect(catalogBuckets.sandbox).toEqual(expect.arrayContaining([
      'shell_exec', 'file_write', 'browser_navigate',
    ]));

    // And the tiering did what it exists to do: the browser family is behind a
    // search pair rather than enumerated. Asserted here, next to the parity
    // check, so "deferred" cannot quietly become "still fully enumerated".
    const visible = catalog.tools.map((t) => t.name);
    expect(visible).toContain('search_sandbox_browser_tools');
    expect(visible).not.toContain('browser_navigate');
    // Tools the distilled prompts name stay visible.
    expect(visible).toEqual(expect.arrayContaining(['shell_exec', 'file_read', 'file_write']));
  });

  it('exposes no sandbox tools for a connector_only-shaped context', async () => {
    const state = makeState();
    (state.context as { sandboxCapabilities?: readonly string[] }).sandboxCapabilities =
      sandboxCapabilitiesForTier('connector_only');
    const [catalog, schema] = await Promise.all([
      (service as unknown as {
        buildPlatformMcpCatalog: (s: ExecutionState) => Promise<{
          tools: Array<{ name: string }>;
          deferredVendorTools?: Map<string, Array<{ name: string }>>;
        }>;
      }).buildPlatformMcpCatalog(state),
      (service as unknown as {
        buildToolsSchema: (c: ExecutionContext) => Promise<Array<{ name: string }>>;
      }).buildToolsSchema(state.context),
    ]);
    expect(bucket(dispatchableNames(catalog)).sandbox ?? []).toEqual([]);
    expect(bucket(schema.map((t) => t.name)).sandbox ?? []).toEqual([]);
  });

  it('agrees on the empty slack set when no installs have a bot token', async () => {
    const slackClient = await import('../../agent-chat/agent-slack-client');
    (slackClient.listAgentSlackInstalls as jest.Mock).mockResolvedValueOnce([]);
    (slackClient.listAgentSlackInstalls as jest.Mock).mockResolvedValueOnce([]);
    const state = makeState();
    const [catalog, schema] = await Promise.all([
      (service as unknown as {
        buildPlatformMcpCatalog: (s: ExecutionState) => Promise<{
          tools: Array<{ name: string }>;
          deferredVendorTools?: Map<string, Array<{ name: string }>>;
        }>;
      }).buildPlatformMcpCatalog(state),
      (service as unknown as {
        buildToolsSchema: (c: ExecutionContext) => Promise<Array<{ name: string }>>;
      }).buildToolsSchema(state.context),
    ]);
    const catalogBuckets = bucket(catalog.tools.map((t) => t.name));
    const schemaBuckets = bucket(schema.map((t) => t.name));
    expect(catalogBuckets.slack ?? []).toEqual([]);
    expect(schemaBuckets.slack ?? []).toEqual([]);
  });

  it('communication=draft → adapter catalog never exposes my_gmail__send_email (structural HITL enforcement)', async () => {
    // Regression guard: if the adapter path bypasses the oversight policy,
    // an agent sends real Gmail replies under communication='draft'. The
    // catalog filters outbound tools out at construction time when
    // policy says draft and a draftVariant exists. This test asserts
    // that filter holds.
    //
    // Mock STANDARD_TOOLS catalog under tool-schema-cache returns
    // send_email with draftVariant='create_draft'. With oversight set
    // to draft, the catalog must NOT contain my_gmail__send_email.
    const cache = await import('../../connectors/tool-schema-cache');
    (cache.getToolSchemas as jest.Mock).mockReturnValueOnce([
      { name: 'send_email', description: 'Send', inputSchema: { type: 'object', properties: {} }, categories: ['outbound'], draftVariant: 'create_draft' },
      { name: 'create_draft', description: 'Draft', inputSchema: { type: 'object', properties: {} }, categories: ['write'] },
      { name: 'read_email', description: 'Read', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },
    ]);
    const state = makeState();
    (state.context as { oversight?: unknown }).oversight = {
      autonomy: 'controlled',
      escalation: 'important',
      communication: 'draft',
      sensitiveWork: {},
    };
    const catalog = await (service as unknown as {
      buildPlatformMcpCatalog: (s: ExecutionState) => Promise<{ tools: Array<{ name: string }> }>;
    }).buildPlatformMcpCatalog(state);
    const names = catalog.tools.map((t) => t.name);
    expect(names).not.toContain('my_gmail__send_email');
    expect(names).toContain('my_gmail__create_draft');
    expect(names).toContain('my_gmail__read_email');
  });

  // ── The schema half of the same invariant ───────────────────────────────
  //
  // Comparing names alone leaves a parity that matters just as much
  // unasserted: if `catalog.tools[].inputSchema` is read off a field `ModelTool`
  // does not have, it is `{}` for every in-process tool. The Claude Agent SDK
  // never reads it — it mounts the live server and gets the Zod shapes — so
  // nothing fails there. Every other engine builds its function-tool list from
  // that field, and gets a catalog of tools with no arguments.
  //
  // What that costs is not a degraded call, it is an impossible one: the model
  // has to invent argument names, and a required argument it guesses wrong is
  // rejected identically on every retry until the step's turn budget is gone.
  // Every invocation on an OpenAI-wire engine fails, while the same agents
  // succeed on the Anthropic engine.
  it('gives every in-process tool the arguments it was registered with', async () => {
    const state = makeState();
    const catalog = await (service as unknown as {
      buildPlatformMcpCatalog: (s: ExecutionState) => Promise<{
        tools: Array<{ name: string; serverId: string; inputSchema: Record<string, unknown> }>;
        servers: Array<{ kind: string; config?: { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> } }>;
      }>;
    }).buildPlatformMcpCatalog(state);

    // The shapes as REGISTERED, straight off the server the Anthropic path
    // mounts. Comparing against these rather than against a hand-written list
    // is what keeps this from drifting as tools are added.
    const registered = new Map(
      (catalog.servers.find((s) => s.kind === 'in-process')?.config?.tools ?? [])
        .map((t) => [t.name, Object.keys(t.inputSchema ?? {}).sort()] as const),
    );
    const inProcess = catalog.tools.filter((t) => t.serverId === 'liftoff-tool-gateway');
    expect(inProcess.length).toBeGreaterThan(0);

    // A tool with no arguments still has to say it is an object; `{}` leaves the
    // model choosing the shape as well as the value.
    for (const t of inProcess) {
      expect({ tool: t.name, type: t.inputSchema?.type }).toEqual({ tool: t.name, type: 'object' });
    }

    const argumentBearing = inProcess.filter((t) => (registered.get(t.name) ?? []).length > 0);
    // Not vacuous: if the registration side came back empty, the loop below
    // would pass by running zero times — which is the defect, not the fix.
    expect(argumentBearing.length).toBeGreaterThan(0);
    for (const t of argumentBearing) {
      const published = Object.keys(
        (t.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
      ).sort();
      expect({ tool: t.name, args: published }).toEqual({ tool: t.name, args: registered.get(t.name) });
    }
  });

  type Reads = Array<{ key: string; iterated: boolean }>;
  const recorderFor = async (stepOutputField: string, stepOutputReads: Reads) => {
    const state = makeState();
    const catalog = await (service as unknown as {
      buildPlatformMcpCatalog: (
        s: ExecutionState,
        o: { stepOutputField: string; stepOutputReads: Reads },
      ) => Promise<{ tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }>;
    }).buildPlatformMcpCatalog(state, { stepOutputField, stepOutputReads });
    return catalog.tools.find((t) => t.name === 'record_step_output');
  };

  it('names the required root key on the step-output contract', async () => {
    // The failing registration shape: a step declaring `outputField: 'triage'`
    // whose successors read four keys out of it. The model is told the root key
    // is required, or it cannot satisfy a contract whose failure is a hard step
    // failure.
    const recorder = await recorderFor('triage', [
      { key: 'question', iterated: false }, { key: 'shape', iterated: false },
      { key: 'urls', iterated: false }, { key: 'reason', iterated: false },
    ]);
    expect(recorder).toBeDefined();
    expect(recorder!.inputSchema.required).toEqual(['triage']);
    expect((recorder!.inputSchema.properties as Record<string, { type?: string }>).triage.type)
      .toBe('object');
  });

  it('types an ITERATED key as an array, so a null cannot be recorded for it', async () => {
    // The enforcement point for the battle-card defect. A loop reading a key
    // that holds null, an object or nothing runs its body zero times and the
    // step reports success — so the refusal has to happen at the recording,
    // where the model can still correct it, not at the consumer three steps on.
    const recorder = await recorderFor('analysis', [
      { key: 'has_material', iterated: false },
      { key: 'cards_to_refresh', iterated: true },
    ]);
    expect(recorder).toBeDefined();
    const root = (recorder!.inputSchema.properties as Record<string, {
      type?: string;
      required?: string[];
      properties?: Record<string, { type?: string }>;
    }>).analysis;
    expect(root.type).toBe('object');
    // The iterated key is typed and required; the rest stay free-form, because
    // the reads are the contract and nothing reads them as a shape.
    expect(root.properties?.cards_to_refresh?.type).toBe('array');
    expect(root.required).toEqual(['cards_to_refresh']);
    expect(root.properties?.has_material).toBeUndefined();
  });
});
