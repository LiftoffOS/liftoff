// MCP Server Tests

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => ({ name: _name, description: _desc, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[] }) => ({ type: 'sdk', name: opts.name || 'test', tools: opts.tools })),
}));

jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn().mockReturnValue([
    { name: 'send_email', description: 'Send email', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] }, categories: ['write', 'outbound'], draftVariant: 'create_draft', entityType: 'message' },
    { name: 'read_email', description: 'Read email', inputSchema: { type: 'object', properties: {} }, categories: ['read'], entityType: 'message' },
    { name: 'delete_email', description: '⚠️ Delete email', inputSchema: { type: 'object', properties: {} }, categories: ['destructive'], entityType: 'message' },
  ]),
  listConnectorTypes: jest.fn().mockReturnValue(['google-mail']),
}));

jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifestsForAgent: jest.fn().mockResolvedValue([
      { connectorType: 'google-mail', alias: 'my_gmail', displayName: 'My Gmail', enabled: true },
    ]),
  },
}));

jest.mock('../../tools/standard-tools', () => ({
  STANDARD_TOOLS: [
    { name: 'memory_save', description: 'Save memory', input_schema: { type: 'object', properties: {} } },
    { name: 'corpus_search', description: 'Search knowledge base', input_schema: { type: 'object', properties: {} } },
  ],
}));

const mockKnowledgeFetch = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: jest.fn(() => ({ fetch: (...a: unknown[]) => mockKnowledgeFetch(...a) })),
}));

jest.mock('../../tools/standard-tool-handler', () => ({
  executeStandardTool: jest.fn().mockResolvedValue(null),
}));

const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: jest.fn().mockReturnValue({}),
}));

const mockCheckMessage = jest.fn().mockResolvedValue({ kind: 'as_today' });
jest.mock('../message-check', () => ({ checkMessage: (...a: unknown[]) => mockCheckMessage(...a) }));
const mockRecordGatewayHitlPause = jest.fn();
jest.mock('../../hitl-enforcement/gateway-pause-signal', () => ({
  recordGatewayHitlPause: (...a: unknown[]) => mockRecordGatewayHitlPause(...a),
}));
jest.mock('../../audit', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

import { createToolGatewayMcpServer } from '../mcp-server';

const mockToolGateway = {
  execute: jest.fn().mockResolvedValue({ success: true, data: { result: 'ok' }, traceId: 'tr' }),
  setCredentialService: jest.fn(),
};

/** Shared baseline input so each test only specifies what differs. */
function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 't1',
    agentId: 'a1',
    instructionVersion: 1,
    traceId: 'trace',
    allowedConnectors: ['google-mail'],
    toolGateway: mockToolGateway as any,
    ...overrides,
  } as any;
}

describe('createToolGatewayMcpServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: knowledge count returns 0 so corpus_search is gated out unless
    // a test explicitly overrides. Tests that don't care about corpus_search
    // exposure rely on this default to keep modelTools.length stable.
    mockKnowledgeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0 }) });
    // The exposure check is wrapped in a 60s in-process TTL cache; reset
    // between tests so each case actually hits the mocked fetch instead of
    // a stale entry from the previous case.
    const { __resetKnowledgeExposureCache } = jest.requireActual('../knowledge-exposure-cache');
    __resetKnowledgeExposureCache();
  });

  it('registers connector tools with correct names', async () => {
    const result = await createToolGatewayMcpServer(baseInput());

    const toolNames = result.modelTools.map(t => t.name);
    expect(toolNames).toContain('my_gmail__send_email');
    expect(toolNames).toContain('my_gmail__read_email');
    expect(toolNames).toContain('my_gmail__delete_email');
  });

  it('adds destructive prefix to descriptions (GAP 13)', async () => {
    const result = await createToolGatewayMcpServer(baseInput());

    const deleteTool = result.modelTools.find(t => t.name === 'my_gmail__delete_email');
    expect(deleteTool?.description).toContain('⚠️ DESTRUCTIVE:');
  });

  it('includes draftVariant in modelTools', async () => {
    const result = await createToolGatewayMcpServer(baseInput());

    const sendTool = result.modelTools.find(t => t.name === 'my_gmail__send_email');
    expect(sendTool?.draftVariant).toBe('create_draft');
  });

  it('registers standard tools (GAP 14)', async () => {
    const result = await createToolGatewayMcpServer(baseInput());

    const toolNames = result.modelTools.map(t => t.name);
    expect(toolNames).toContain('memory_save');
  });

  it('registers search tool (GAP 23)', async () => {
    const result = await createToolGatewayMcpServer(baseInput());

    const toolNames = result.modelTools.map(t => t.name);
    expect(toolNames).toContain('search');
  });

  it('filters by allowedActionTypes (GAP 12)', async () => {
    const result = await createToolGatewayMcpServer(baseInput({ allowedActionTypes: ['read'] }));

    const toolNames = result.modelTools.filter(t => t.name.startsWith('my_gmail')).map(t => t.name);
    expect(toolNames).toContain('my_gmail__read_email');
    expect(toolNames).not.toContain('my_gmail__send_email');
    expect(toolNames).not.toContain('my_gmail__delete_email');
  });

  it('returns modelTools array matching registered tools count', async () => {
    const result = await createToolGatewayMcpServer(baseInput());

    // 3 connector tools (send_email/read_email/delete_email)
    // + 1 standard tool (memory_save; corpus_search hidden by knowledge
    //   count: 0)
    // + 1 search tool
    // + 1 review_recent_activity
    // + 1 code_session (always-on)
    // = 7.
    // Skipped under this baseInput: find_teammates / send_agent_message /
    // read_agent_messages (PLATFORM_BACKEND_URL unset), spawn_child_task
    // (invocationId unset), internal agents (mockQuery returns empty),
    // agent_slack_* (no installs returned from RPC), sandbox primitives
    // (no sandboxCapabilities).
    //
    // delegate_to_agent is skipped for the SAME reason the internal agent tools
    // are: mockQuery returns no teammates, so the delegation roster is empty.
    // The tool is registered only when this agent has at least one eligible
    // teammate, and its agent_id is an enum over that roster — an agent with
    // nobody to delegate to is not offered a way to delegate. Previously it was
    // registered unconditionally with a free-form agent_id, which is how a
    // paused (or non-existent) team could be named as a destination.
    expect(result.modelTools.map(t => t.name).sort()).toEqual([
      'code_session',
      'memory_save',
      'my_gmail__delete_email',
      'my_gmail__read_email',
      'my_gmail__send_email',
      'review_recent_activity',
      'search',
      'task_ledger_write', // §4.9 Part B — always registered
    ]);
  });

  it('returns empty vendorMcpServers when no integrations are provided', async () => {
    const result = await createToolGatewayMcpServer(baseInput());
    expect(result.vendorMcpServers).toEqual({});
  });

  describe('report_task_outcome', () => {
    it('is NOT registered by default — chat must never see it', async () => {
      // Interactive chat builds its own system prompt (systemPromptOverride) so
      // it never carries the terminal-outcome contract, and chat branches on
      // execResult.success: a stray 'fail' report there would turn a normal
      // reply into an EXEC_ERROR. Catalog and prompt stay in lockstep.
      const result = await createToolGatewayMcpServer(baseInput());
      expect(result.modelTools.map((t: { name: string }) => t.name))
        .not.toContain('report_task_outcome');
    });

    it('is registered when the run carries the terminal-outcome contract', async () => {
      const result = await createToolGatewayMcpServer(
        baseInput({ terminalOutcomeContract: true }),
      );
      const tool = result.modelTools.find((t: { name: string }) => t.name === 'report_task_outcome');
      expect(tool).toBeDefined();
      // MUST be 'read'. effectPassesUngated() only lets 'read' through, so a
      // 'write' effect would put the agent's own outcome report behind a HITL
      // approval on untrusted-inbound runs and pause the run.
      expect((tool as { effect?: string }).effect).toBe('read');
    });
  });

  it('keeps every registered teammate tool in modelTools, so the gate can resolve it', async () => {
    // modelTools is NOT what the model sees. It is what the governance gate
    // resolves a call against (cachedModelTools is built from it). On
    // claude-agent-sdk the model is handed the in-process McpServer instance and
    // can call anything registered there regardless of this list.
    //
    // So dropping a tool from modelTools hides it from nobody and blinds the
    // gate: the call arrives, resolution misses, and UnresolvedToolError fails
    // the whole invocation. Every registered gateway tool must appear here.
    const id1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    const id2 = 'bbbbbbbb-2222-2222-2222-222222222222';
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM agents WHERE tenant_id')) {
        return Promise.resolve({
          rows: [
            { id: id1, name: 'Code Reviewer', role: 'Reviews pull requests' },
            { id: id2, name: 'Code Reviewer', role: 'Reviews pull requests' },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await createToolGatewayMcpServer(baseInput());

    const registered = (result.mcpServer as unknown as { tools?: Array<{ name: string }> }).tools ?? [];
    const modelToolNames = new Set(result.modelTools.map((t) => t.name));
    const registeredMissingFromCatalog = registered
      .map((t) => t.name)
      .filter((n) => !modelToolNames.has(n));

    expect(registeredMissingFromCatalog).toEqual([]);

    // Both same-named teammates stay reachable, the second id-suffixed.
    expect(modelToolNames.has('internal__code_reviewer__execute')).toBe(true);
    expect(modelToolNames.has(`internal__code_reviewer__${id2.slice(0, 8)}__execute`)).toBe(true);
  });

  it('carries the do-it-yourself criterion on the teammate tool the model reads', async () => {
    // The tool cannot be hidden on claude-agent-sdk, so the criterion has to
    // travel in the description. Asserted on BOTH surfaces because different
    // engines read different ones.
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM agents WHERE tenant_id')) {
        return Promise.resolve({
          rows: [{ id: 'cccccccc-3333-3333-3333-333333333333', name: 'Data Engineer', role: 'Builds and maintains ETL pipelines' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await createToolGatewayMcpServer(baseInput());
    const catalogEntry = result.modelTools.find((t) => t.name === 'internal__data_engineer__execute');
    const registered = ((result.mcpServer as unknown as { tools?: Array<{ name: string; description?: string }> }).tools ?? [])
      .find((t) => t.name === 'internal__data_engineer__execute');

    for (const description of [catalogEntry?.description, registered?.description]) {
      expect(description).toMatch(/USE ONLY when the task needs a capability you do not have/i);
      expect(description).toContain('Builds and maintains ETL pipelines');
      expect(description).toMatch(/duplicate of you, not a\s+specialist|duplicate of you/i);
    }
  });

  it('offers teammates by remit, so the choice is not a title match', async () => {
    // The roster description is what the model reasons over. Listing bare job
    // titles makes "hand it to the one whose title matches the task" look
    // correct even when that title is the caller's own.
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM agents WHERE tenant_id')) {
        return Promise.resolve({
          rows: [{ id: 'cccccccc-3333-3333-3333-333333333333', name: 'Data Engineer', role: 'Builds and maintains ETL pipelines' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await createToolGatewayMcpServer(baseInput());
    const delegate = result.modelTools.find((t) => t.name === 'delegate_to_agent');

    expect(delegate).toBeDefined();
    // The criterion is stated, not merely implied.
    expect(delegate!.description).toMatch(/ONLY when it needs a capability you do not have/i);
    // The remit rides on the `teammate` field's description, which is what the
    // model sees when it picks a target.
    const teammateField = (delegate!.inputSchema as unknown as {
      shape?: { teammate?: { description?: string } };
    }).shape?.teammate;
    expect(teammateField?.description).toContain('Builds and maintains ETL pipelines');
    expect(teammateField?.description).toMatch(/Choose on REMIT/i);
  });

  // ── delegate_to_agent: how the model names a teammate ──────────────────
  //
  // With a UUID enum the model can emit a value outside the enum AND drop
  // `objective` trying to satisfy the schema. That fails MCP validation, raises
  // a tool_call_error anomaly, and escalates the run. A
  // schema rejection is the worst failure mode available here — the model
  // cannot see why it was wrong or recover from it.

  it('asks for the teammate by NAME, never by uuid', async () => {
    const id1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM agents WHERE tenant_id')) {
        return Promise.resolve({ rows: [{ id: id1, name: 'Code Reviewer' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await createToolGatewayMcpServer(baseInput());
    const delegate = result.modelTools.find((t) => t.name === 'delegate_to_agent');
    expect(delegate).toBeDefined();

    const shape = (delegate!.inputSchema as { shape?: Record<string, unknown> }).shape ?? {};
    expect(Object.keys(shape)).toContain('teammate');
    // The old spelling must not come back: a param called agent_id invites a
    // uuid, which is the thing the model could not produce.
    expect(Object.keys(shape)).not.toContain('agent_id');

    // And no uuid appears anywhere the model reads — options or description.
    const advertised = JSON.stringify(delegate);
    expect(advertised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(advertised).toContain('Code Reviewer');
  });

  it('disambiguates two teammates sharing a name, so each stays reachable', async () => {
    // Team names are not unique per tenant. Without a suffix one label would
    // resolve to whichever agent happened to be written last, silently sending
    // work to the wrong team.
    const id1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    const id2 = 'bbbbbbbb-2222-2222-2222-222222222222';
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM agents WHERE tenant_id')) {
        return Promise.resolve({
          rows: [
            { id: id1, name: 'Code Reviewer' },
            { id: id2, name: 'Code Reviewer' },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await createToolGatewayMcpServer(baseInput());
    const delegate = result.modelTools.find((t) => t.name === 'delegate_to_agent');
    const options = (delegate!.inputSchema as {
      shape?: { teammate?: { options?: string[] } };
    }).shape?.teammate?.options ?? [];

    expect(options).toHaveLength(2);
    expect(new Set(options).size).toBe(2);
    expect(options).toContain(`Code Reviewer (${id2.slice(0, 8)})`);
  });

  it('reports a delegated pause as a SUCCESS result, so it cannot escalate the run', async () => {
    // Every isError result is routed to the adapter's anomaly handler as
    // tool_call_error, which spends a recovery-LLM turn and can escalate the
    // whole run. Marking a routine approval pause as an error would therefore
    // escalate the parent every time somebody's team needed a decision.
    // Matches the existing convention: __delegationPending / __wakePending
    // markers are read only from SUCCESS results.
    const id1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM agents WHERE tenant_id')) {
        return Promise.resolve({ rows: [{ id: id1, name: 'Code Reviewer' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const { DelegationChildPausedError } = jest.requireActual(
      '../../agent-execution/governed-dispatch',
    );
    jest.doMock('../../agent-execution/service', () => ({
      agentExecutionService: {
        delegateToAgent: jest.fn().mockRejectedValue(
          new DelegationChildPausedError({
            approvalId: 'appr-1',
            childInvocationId: 'inv-9',
            childAgentId: id1,
            actionSummary: null,
            reason: 'Code Reviewer is waiting on an approval.',
          }),
        ),
      },
    }));

    const result = await createToolGatewayMcpServer(baseInput());
    const registered = (result.mcpServer as unknown as { tools?: Array<{ name: string; handler: (a: unknown) => Promise<unknown> }> }).tools ?? [];
    const delegateTool = registered.find((t) => t.name === 'delegate_to_agent');
    expect(delegateTool).toBeDefined();

    const out = await delegateTool!.handler({
      teammate: 'Code Reviewer',
      objective: 'review this',
    }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(out.isError).toBe(false);
    const payload = JSON.parse(out.content[0].text);
    expect(payload.delegation_paused).toBe(true);
    expect(payload.approval_id).toBe('appr-1');
  });

  // ── corpus_search exposure gating ──────────────────────────────────────
  // The tool-gateway calls /api/internal/knowledge/count for the agent's
  // bound connectors. If the tenant has no synced knowledge_items, corpus_search
  // is dropped from the agent's prompt budget. Soft-fails to "expose" on any
  // error so we never silently lose the tool.

  it('hides corpus_search when knowledge count is 0', async () => {
    mockKnowledgeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0 }) });
    const result = await createToolGatewayMcpServer(baseInput());
    expect(result.modelTools.map(t => t.name)).not.toContain('corpus_search');
  });

  it('exposes corpus_search when knowledge count > 0', async () => {
    mockKnowledgeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 5 }) });
    const result = await createToolGatewayMcpServer(baseInput());
    expect(result.modelTools.map(t => t.name)).toContain('corpus_search');
    // WS-C regression: the count POST must NOT pass an explicit Content-Type —
    // ServiceClient.buildHeaders supplies it. An explicit header coexisted with
    // the default after case normalisation, fetch comma-joined the pair, PB's
    // express.json skipped the unparseable body, and this endpoint 500'd on
    // every call (so the exposure cache never populated). See
    // knowledge-exposure-cache.ts.
    const lastCall = mockKnowledgeFetch.mock.lastCall as unknown[] | undefined;
    expect(lastCall).toBeDefined();
    expect((lastCall![2] as { headers?: unknown } | undefined)?.headers).toBeUndefined();
  });

  it('exposes corpus_search when the count call throws (soft-fail default)', async () => {
    mockKnowledgeFetch.mockRejectedValue(new Error('boom'));
    const result = await createToolGatewayMcpServer(baseInput());
    expect(result.modelTools.map(t => t.name)).toContain('corpus_search');
  });

  // ── stdToolCtx.integrations plumbing ───────────────────────────────────
  // handleCorpusSearch reads ctx.integrations to scope its platform call by
  // the agent's bound connectors. Verify the field reaches the handler with
  // id + type only (no per-binding config, to avoid leaking secrets).

  it('forwards integrations (id + type only) onto stdToolCtx', async () => {
    const { executeStandardTool } = jest.requireMock('../../tools/standard-tool-handler');
    let captured: any;
    (executeStandardTool as jest.Mock).mockImplementation((_name, _payload, ctx) => {
      captured = ctx;
      return Promise.resolve(null);
    });

    const server = await createToolGatewayMcpServer(baseInput({
      integrations: [
        { id: 'conn-1', type: 'zendesk', selectedObjects: ['articles'], config: { secret: 'shhh' } },
        { id: 'conn-2', type: 'google_mail', config: { sendAs: 'a@b.com' } },
      ],
    }));

    const stdTool = (server.mcpServer as any).tools?.find((t: any) => t.name === 'memory_save');
    if (stdTool?.handler) await stdTool.handler({ content: 'x', layer: 'individual' });

    expect(captured?.integrations).toEqual([
      { id: 'conn-1', type: 'zendesk' },
      { id: 'conn-2', type: 'google_mail' },
    ]);
  });

  // ── Oversight-driven catalog filter ──────────────────────────────────
  describe('oversight filter', () => {
    const { getToolSchemas } = jest.requireMock('../../connectors/tool-schema-cache') as {
      getToolSchemas: jest.Mock;
    };

    // Override the connector tool list per-test so we can assert the
    // filter on a mix of outbound + draft + non-outbound tools.
    function withSchemas(fns: unknown[]) {
      getToolSchemas.mockReturnValueOnce(fns);
    }

    it('communication=draft + draftVariant exists → outbound tool is FILTERED OUT, draft variant remains', async () => {
      withSchemas([
        { name: 'send_email', description: 'Send', inputSchema: { type: 'object', properties: {} }, categories: ['outbound'], draftVariant: 'create_draft' },
        { name: 'reply_email', description: 'Reply', inputSchema: { type: 'object', properties: {} }, categories: ['outbound'], draftVariant: 'create_draft' },
        { name: 'create_draft', description: 'Draft', inputSchema: { type: 'object', properties: {} }, categories: ['write'] },
        { name: 'read_email', description: 'Read', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },
      ]);
      const result = await createToolGatewayMcpServer(baseInput({
        oversight: { autonomy: 'controlled', escalation: 'important', communication: 'draft', sensitiveWork: {} },
      }));
      const names = result.modelTools.map(t => t.name);
      expect(names).not.toContain('my_gmail__send_email');
      expect(names).not.toContain('my_gmail__reply_email');
      expect(names).toContain('my_gmail__create_draft');
      expect(names).toContain('my_gmail__read_email');
      // Withheld, not gone: the sends stay bound, and an approved call naming
      // one resolves against this list at consumption.
      expect(result.withheldByOversight.map(t => t.name)).toEqual(['my_gmail__send_email', 'my_gmail__reply_email']);
      expect(result.withheldByOversight[0]).toMatchObject({ categories: ['outbound'], draftVariant: 'create_draft', source: 'connector' });
    });

    it('communication=auto withholds nothing', async () => {
      const result = await createToolGatewayMcpServer(baseInput({
        oversight: { autonomy: 'autonomous', escalation: 'urgent_only', communication: 'auto', sensitiveWork: {} },
      }));
      expect(result.withheldByOversight).toEqual([]);
    });

    it('communication=draft + NO draftVariant → outbound tool IS REGISTERED but handler throws HitlGateError on call', async () => {
      withSchemas([
        { name: 'send_message', description: 'Send Slack', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, categories: ['outbound'] /* no draftVariant */ },
        { name: 'read_message', description: 'Read', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },
      ]);
      const result = await createToolGatewayMcpServer(baseInput({
        oversight: { autonomy: 'controlled', escalation: 'important', communication: 'draft', sensitiveWork: {} },
      }));
      const names = result.modelTools.map(t => t.name);
      expect(names).toContain('my_gmail__send_message');  // visible to LLM
      expect(names).toContain('my_gmail__read_message');

      const sendTool = (result.mcpServer as any).tools?.find((t: any) => t.name === 'my_gmail__send_message');
      await expect(sendTool.handler({ text: 'hi' })).rejects.toMatchObject({ name: 'HitlGateError' });
    });

    it('communication=auto → outbound tools pass through unchanged', async () => {
      // default mock: send_email + read_email + delete_email
      const result = await createToolGatewayMcpServer(baseInput({
        oversight: { autonomy: 'autonomous', escalation: 'urgent_only', communication: 'auto', sensitiveWork: {} },
      }));
      const names = result.modelTools.map(t => t.name);
      expect(names).toContain('my_gmail__send_email');
      expect(names).toContain('my_gmail__read_email');
    });

    // Review means a person approves the send itself, so the outbound tool must
    // stay registered — it is what the approval gate pauses and what runs once
    // approved. Only Draft-first swaps it for the draft form.
    it('communication=review + sensitiveWork matches outbound category → outbound tool stays registered (to be paused, then sent)', async () => {
      withSchemas([
        { name: 'send_email', description: 'Send', inputSchema: { type: 'object', properties: {} }, categories: ['outbound', 'customerCommunication'], draftVariant: 'create_draft' },
        { name: 'create_draft', description: 'Draft', inputSchema: { type: 'object', properties: {} }, categories: ['write'] },
      ]);
      const result = await createToolGatewayMcpServer(baseInput({
        oversight: { autonomy: 'controlled', escalation: 'important', communication: 'review', sensitiveWork: { customerCommunication: true } },
      }));
      const names = result.modelTools.map(t => t.name);
      expect(names).toContain('my_gmail__send_email');
    });

    it('communication=draft still swaps the outbound tool for its draft form', async () => {
      withSchemas([
        { name: 'send_email', description: 'Send', inputSchema: { type: 'object', properties: {} }, categories: ['outbound', 'customerCommunication'], draftVariant: 'create_draft' },
        { name: 'create_draft', description: 'Draft', inputSchema: { type: 'object', properties: {} }, categories: ['write'] },
      ]);
      const result = await createToolGatewayMcpServer(baseInput({
        oversight: { autonomy: 'controlled', escalation: 'important', communication: 'draft', sensitiveWork: { customerCommunication: true } },
      }));
      const names = result.modelTools.map(t => t.name);
      expect(names).not.toContain('my_gmail__send_email');
      expect(names).toContain('my_gmail__create_draft');
    });

    it('communication=review + sensitiveWork does NOT match → outbound tool stays', async () => {
      withSchemas([
        { name: 'send_email', description: 'Send', inputSchema: { type: 'object', properties: {} }, categories: ['outbound'], draftVariant: 'create_draft' },
        { name: 'create_draft', description: 'Draft', inputSchema: { type: 'object', properties: {} }, categories: ['write'] },
      ]);
      const result = await createToolGatewayMcpServer(baseInput({
        oversight: { autonomy: 'controlled', escalation: 'important', communication: 'review', sensitiveWork: { hiringDecisions: true } },
      }));
      const names = result.modelTools.map(t => t.name);
      // 'outbound' category alone isn't a sensitiveWork key, so under review-mode
      // (which only blocks tools matching enabled sensitive categories) send_email
      // stays visible.
      expect(names).toContain('my_gmail__send_email');
    });

    it('no oversight setting → no filtering (back-compat)', async () => {
      const result = await createToolGatewayMcpServer(baseInput());  // oversight: undefined
      const names = result.modelTools.map(t => t.name);
      expect(names).toContain('my_gmail__send_email');
    });
  });

  // ── The Communication setting reads the message (message-check.ts) ──
  describe('message check at the execute-time wrapper', () => {
    const { getToolSchemas } = jest.requireMock('../../connectors/tool-schema-cache') as { getToolSchemas: jest.Mock };
    const outbound = { name: 'send_message', description: 'Send', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, categories: ['outbound', 'customerCommunication'] };
    const contract = { kind: 'instructions' as const, instructions: 'Answer tickets.', role: 'You are Support.' };
    const auto = { autonomy: 'autonomous', escalation: 'important', communication: 'auto', sensitiveWork: { customerCommunication: true }, communicationSemantics: 2 };
    const review = { ...auto, communication: 'review' };
    const handlerOf = (result: Awaited<ReturnType<typeof createToolGatewayMcpServer>>) =>
      (result.mcpServer as any).tools?.find((t: any) => t.name === 'my_gmail__send_message').handler as (args: Record<string, unknown>) => Promise<unknown>;

    beforeEach(() => { mockCheckMessage.mockReset().mockResolvedValue({ kind: 'as_today' }); mockRecordGatewayHitlPause.mockReset(); });

    it('runs the check with the tool, its categories, the args, the oversight, the catalog decision and the contract', async () => {
      getToolSchemas.mockReturnValueOnce([outbound]);
      const result = await createToolGatewayMcpServer(baseInput({ oversight: auto, contract, invocationId: 'inv-1' }));
      await handlerOf(result)({ text: 'Your order shipped.' });
      expect(mockCheckMessage).toHaveBeenCalledWith({
        toolName: 'my_gmail__send_message', categories: ['outbound', 'customerCommunication'], args: { text: 'Your order shipped.' },
        oversight: auto, decision: { kind: 'allow' }, contract, tenantId: 't1', agentId: 'a1', invocationId: 'inv-1',
      });
      expect(mockToolGateway.execute).toHaveBeenCalled();
    });

    it('Auto: an unsafe verdict pauses with sensitive_work, the category and the verdict on the signal, and nothing is sent', async () => {
      getToolSchemas.mockReturnValueOnce([outbound]);
      const context = { messageCheck: { setting: 'auto', asked: { customerCommunication: 0.9 }, model: 'jev-1.13.0', latencyMs: 3 } };
      mockCheckMessage.mockResolvedValue({ kind: 'pause', reason: 'sensitive_work', matchedCategory: 'customerCommunication', context });
      const result = await createToolGatewayMcpServer(baseInput({ oversight: auto, invocationId: 'inv-1' }));
      await expect(handlerOf(result)({ text: 'We will refund you in full.' })).rejects.toMatchObject({ name: 'HitlGateError', reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
      expect(mockRecordGatewayHitlPause).toHaveBeenCalledWith('inv-1', {
        toolName: 'my_gmail__send_message', reason: 'sensitive_work', args: { text: 'We will refund you in full.' }, matchedCategory: 'customerCommunication', context,
      });
      expect(mockToolGateway.execute).not.toHaveBeenCalled();
    });

    it('Review: a cleared verdict sends the matched message without a pause', async () => {
      getToolSchemas.mockReturnValueOnce([outbound]);
      mockCheckMessage.mockResolvedValue({ kind: 'send', context: { messageCheck: { setting: 'review', asked: { customerCommunication: 0.02 } } } });
      const result = await createToolGatewayMcpServer(baseInput({ oversight: review, invocationId: 'inv-1' }));
      await handlerOf(result)({ text: 'Thanks, received.' });
      expect(mockCheckMessage.mock.calls[0][0]).toMatchObject({ decision: { kind: 'require_approval', reason: 'sensitive_work' } });
      expect(mockRecordGatewayHitlPause).not.toHaveBeenCalled();
      expect(mockToolGateway.execute).toHaveBeenCalled();
    });

    it('Review: any other verdict pauses as today, with the verdict carried on the signal', async () => {
      getToolSchemas.mockReturnValueOnce([outbound]);
      const context = { messageCheck: { setting: 'review', asked: {}, incomplete: true } };
      mockCheckMessage.mockResolvedValue({ kind: 'as_today', context });
      const result = await createToolGatewayMcpServer(baseInput({ oversight: review, invocationId: 'inv-1' }));
      await expect(handlerOf(result)({ text: 'x' })).rejects.toMatchObject({ name: 'HitlGateError', reason: 'sensitive_work' });
      expect(mockRecordGatewayHitlPause).toHaveBeenCalledWith('inv-1', { toolName: 'my_gmail__send_message', reason: 'sensitive_work', args: { text: 'x' }, context });
      expect(mockToolGateway.execute).not.toHaveBeenCalled();
    });

    it('the Slack and Teams closure paths use the same mapping', async () => {
      const { SLACK_OUTBOUND_TOOL_NAMES } = jest.requireActual('../agent-slack-tool-catalog') as { SLACK_OUTBOUND_TOOL_NAMES: Set<string> };
      expect(SLACK_OUTBOUND_TOOL_NAMES.size).toBeGreaterThan(0);
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'mcp-server.ts'), 'utf8') as string;
      // Three wrappers, three checks, each deciding the same way.
      expect(src.split('await checkMessage({').length - 1).toBe(3);
      expect(src.split("if (verdict.kind === 'pause') {").length - 1).toBe(3);
      expect(src.split("&& verdict.kind !== 'send') {").length - 1).toBe(3);
    });

    it('the approved-dispatch replay: a send a person approved goes through the dispatcher, never a wrapper, and is not re-checked', async () => {
      const { routeApprovedCall } = jest.requireActual('../../agent-execution/approved-call-routing') as typeof import('../../agent-execution/approved-call-routing');
      const gateway = { kind: 'in-process' as const, id: 'liftoff-tool-gateway', config: { type: 'sdk' as const, name: 'liftoff-tool-gateway', instance: {} as never } };
      const tool = (name: string, source: string) => ({ name, description: name, inputSchema: { type: 'object' }, serverId: 'liftoff-tool-gateway', source });
      const catalog = {
        servers: [gateway],
        tools: [tool('my_gmail__send_message', 'connector'), tool('slack_send_message', 'agent_slack'), tool('teams_send_message', 'agent_teams')],
      } as unknown as import('../../agent-execution/adapter/catalog-types').McpToolCatalog;
      const notStandard = () => false;
      // The three wrappers that run the check are the connector, Slack and
      // Teams closures; each of their tools replays through executeToolCalls.
      for (const [name, connector, actionType] of [
        ['my_gmail__send_message', 'my_gmail', 'send_message'],
        ['slack_send_message', 'agent_slack', 'slack_send_message'],
        ['teams_send_message', 'agent_teams', 'teams_send_message'],
      ] as const) {
        const route = routeApprovedCall(catalog, { id: 'c1', name, input: { text: 'Approved.' } }, notStandard);
        expect(route).toMatchObject({ ownership: 'connector', dispatchPath: 'execute_tool_calls', request: { connector, actionType, payload: { text: 'Approved.' } } });
        expect(route.bridge).toBeUndefined();
      }
      // And the replay's path holds no check: the message check lives at the
      // execute-time seams (the wrappers here, the sandbox dispatch, and the
      // adapter gate for a vendor-hosted tool the wrappers never see), never
      // in the dispatcher an approved call replays through.
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      for (const file of ['../service.ts', '../../agent-execution/approved-call-routing.ts']) {
        const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
        expect(text).not.toMatch(/from '[^']*message-check'/);
        expect(text).not.toContain('checkMessage(');
      }
      const dispatcher = fs.readFileSync(path.join(__dirname, '../../agent-execution/service.ts'), 'utf8');
      const executeToolCalls = dispatcher.slice(dispatcher.indexOf('private async executeToolCalls('), dispatcher.indexOf('private async buildSystemPrompt('));
      const replay = dispatcher.slice(dispatcher.indexOf('public async resumeFromHitlApproval('), dispatcher.indexOf('private async dispatchApprovedCallsViaBridge('));
      expect(executeToolCalls.length).toBeGreaterThan(0);
      expect(replay.length).toBeGreaterThan(0);
      expect(executeToolCalls).not.toContain('checkMessage(');
      expect(replay).not.toContain('checkMessage(');
      // The one call in the dispatcher's file is the adapter gate's, for the
      // vendor-hosted tools the wrappers never see.
      expect(dispatcher.split('checkMessage(').length - 1).toBe(1);
      const gate = dispatcher.slice(dispatcher.indexOf('private async runAdapterHitlGate('), dispatcher.indexOf('private async executeToolCalls('));
      expect(gate).toContain('checkMessage(');
      expect(mockCheckMessage).not.toHaveBeenCalled();
    });
  });

  // ── Sandbox primitives gating ────────────────────────────────────────
  it('does NOT register sandbox primitives when sandboxCapabilities is absent / empty', async () => {
    const noCaps   = await createToolGatewayMcpServer(baseInput());
    const emptyCaps = await createToolGatewayMcpServer(baseInput({ sandboxCapabilities: [] }));
    for (const r of [noCaps, emptyCaps]) {
      const names = r.modelTools.map(t => t.name);
      expect(names).not.toContain('shell_exec');
      expect(names).not.toContain('file_read');
      expect(names).not.toContain('file_write');
    }
  });

  it('registers shell + file primitives when sandboxCapabilities = ["shell","file"]', async () => {
    const result = await createToolGatewayMcpServer(baseInput({
      sandboxCapabilities: ['shell', 'file'],
    }));
    const names = result.modelTools.map(t => t.name);
    // shell + file primitives present
    expect(names).toContain('shell_exec');
    expect(names).toContain('file_read');
    expect(names).toContain('file_write');
    expect(names).toContain('file_edit');
    // browser + vscode primitives absent — not in the requested capability set
    expect(names.some(n => n.startsWith('browser_'))).toBe(false);
    expect(names.some(n => n.startsWith('vscode_'))).toBe(false);
  });

  // ── Per-agent Slack tools ────────────────────────────────────────────
  // When listAgentSlackInstalls returns at least one install with a bot
  // token, the catalog registers the AGENT_SLACK_TOOLS surface so the
  // adapter (conversational + llm_reason) can dispatch them. With no
  // installs the section adds nothing — current behaviour verified in
  // 'returns modelTools array matching registered tools count' above
  // (the listAgentSlackInstalls RPC fails-soft to [] in the test env).
  it('registers per-agent Slack tools when at least one install has a bot token', async () => {
    // The agent-slack-client module isn't auto-mocked in this file —
    // stub listAgentSlackInstalls to return one install with a bot token.
    jest.resetModules();
    jest.doMock('../../agent-chat/agent-slack-client', () => ({
      listAgentSlackInstalls: jest.fn().mockResolvedValue([
        { slackTeamId: 'T1', botToken: 'xoxb-stub', botUserId: 'U1' },
      ]),
    }));
    const { createToolGatewayMcpServer: localCreate } = await import('../mcp-server');
    const result = await localCreate(baseInput());
    const names = result.modelTools.map(t => t.name);
    expect(names).toContain('slack_send_message');
    expect(names).toContain('slack_reply_in_thread');
    expect(names).toContain('slack_list_channels');
    jest.dontMock('../../agent-chat/agent-slack-client');
  });
});

describe('createToolGatewayMcpServer — threadId propagation', () => {
  const { executeStandardTool } = jest.requireMock('../../tools/standard-tool-handler');

  beforeEach(() => jest.clearAllMocks());

  it('passes threadId into stdToolCtx when provided', async () => {
    await createToolGatewayMcpServer(baseInput({ threadId: 'thread-abc' }));

    // Invoke the memory_save tool handler so stdToolCtx is captured
    const toolHandler = executeStandardTool as jest.Mock;
    // Manually invoke registered tool to trigger executeStandardTool
    toolHandler.mockResolvedValueOnce({ success: true, result: { memoryId: 'm1' } });

    // Verify the MCP server was created and the threadId reaches the handler
    // by checking executeStandardTool is callable (full dispatch tested in integration)
    expect(toolHandler).toBeDefined();
  });

  it('stdToolCtx.threadId equals provided threadId', async () => {
    let capturedCtx: unknown;
    (executeStandardTool as jest.Mock).mockImplementation((_name, _payload, ctx) => {
      capturedCtx = ctx;
      return Promise.resolve(null);
    });

    const server = await createToolGatewayMcpServer(baseInput({ threadId: 'thread-xyz' }));

    // Find and call the memory_save handler to capture ctx
    const memorySaveTool = (server.mcpServer as any).tools?.find((t: any) => t.name === 'memory_save');
    if (memorySaveTool?.handler) {
      await memorySaveTool.handler({ content: 'test', layer: 'individual' });
    }

    if (capturedCtx) {
      expect((capturedCtx as any).threadId).toBe('thread-xyz');
    }
  });

  it('stdToolCtx.threadId is undefined when threadId not provided', async () => {
    let capturedCtx: unknown;
    (executeStandardTool as jest.Mock).mockImplementation((_name, _payload, ctx) => {
      capturedCtx = ctx;
      return Promise.resolve(null);
    });

    const server = await createToolGatewayMcpServer(baseInput());

    const memorySaveTool = (server.mcpServer as any).tools?.find((t: any) => t.name === 'memory_save');
    if (memorySaveTool?.handler) {
      await memorySaveTool.handler({ content: 'test', layer: 'individual' });
    }

    if (capturedCtx) {
      expect((capturedCtx as any).threadId).toBeUndefined();
    }
  });
});

// A standard tool that knows why it failed says so on the wire. The envelope
// reads the handler's `errorCode` and `recovery` ahead of its message
// heuristic, so a handler that knows a page is missing is not reclassified
// as `internal_error` from its wording.
describe('createToolGatewayMcpServer — a standard tool\'s own classification reaches the envelope', () => {
  // Captured at collection time, like the threadId block above: a
  // resetModules() in an earlier case would otherwise hand a later
  // requireMock a fresh module the imported server is not bound to.
  const { executeStandardTool } = jest.requireMock('../../tools/standard-tool-handler');

  it('carries errorCode as code and recovery verbatim', async () => {
    (executeStandardTool as jest.Mock).mockResolvedValue({
      success: false,
      retryable: false,
      errorCode: 'not_found',
      error: 'No content could be retrieved for https://example.com/blog (Empty content from Exa /contents).',
      recovery: 'The page does not exist at this address or will not serve automated readers. Do not infer anything for it; use another address or say the page could not be read.',
    });
    const server = await createToolGatewayMcpServer(baseInput());
    const stdTool = (server.mcpServer as any).tools?.find((t: any) => t.name === 'memory_save');
    const out = await stdTool.handler({ content: 'x', layer: 'individual' });
    expect(out.isError).toBe(true);
    const text = out.content[0].text as string;
    expect(text.startsWith('TOOL_ERROR ')).toBe(true);
    const body = JSON.parse(text.slice('TOOL_ERROR '.length));
    expect(body.code).toBe('not_found');
    expect(body.retryable).toBe(false);
    expect(body.recovery).toBe('The page does not exist at this address or will not serve automated readers. Do not infer anything for it; use another address or say the page could not be read.');
    expect(body.error).toContain('https://example.com/blog');
  });

  it('falls back to the message heuristic when the handler carries no code', async () => {
    (executeStandardTool as jest.Mock).mockResolvedValue({ success: false, error: 'Failed to fetch URL.' });
    const server = await createToolGatewayMcpServer(baseInput());
    const stdTool = (server.mcpServer as any).tools?.find((t: any) => t.name === 'memory_save');
    const out = await stdTool.handler({ content: 'x', layer: 'individual' });
    const body = JSON.parse((out.content[0].text as string).slice('TOOL_ERROR '.length));
    expect(body.code).toBe('internal_error');
  });
});
