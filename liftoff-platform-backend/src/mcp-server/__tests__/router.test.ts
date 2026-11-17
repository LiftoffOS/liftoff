// MCP Router — unit tests
// Covers: initialize handshake, tools/list, tools/call dispatch,
// unknown method, no-auth rejection, hard-reject when mcpAuth absent, and the
// per-call membership gate in front of every tool.

import express from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock auth middleware to inject mcpAuth without DB lookups
const mockMcpAuth = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  accountId: '22222222-2222-2222-2222-222222222222',
  keyId: '33333333-3333-3333-3333-333333333333',
  keyType: 'claude_code' as const,
};

let injectAuth = true;

// The actor the membership gate resolves for every tool call. A member by
// default; a test that removes the membership sets it to null.
const mockActor = {
  ...mockMcpAuth,
  role: 'member',
  displayName: 'Alice Example',
  client: 'Claude Code',
};
const mockResolveMcpActor = jest.fn();
jest.mock('../actor', () => ({
  resolveMcpActor: (...args: unknown[]) => mockResolveMcpActor(...args),
}));

// The per-person overview: initialize and server/discover put it ahead of
// the standing text. Mocked here; its own composition is overview.test.ts.
const mockBuildInstructions = jest.fn();
jest.mock('../overview', () => ({
  buildInstructions: (...args: unknown[]) => mockBuildInstructions(...args),
}));

jest.mock('../mcp-auth', () => ({
  mcpOriginGuard: (_req: unknown, _res: unknown, next: () => void) => next(),
  mcpAuthMiddleware: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    if (injectAuth) req.mcpAuth = mockMcpAuth;
    next();
  },
}));

// Mock service handlers
const mockFindTeammates = jest.fn().mockResolvedValue({ teammates: [], total: 0 });
const mockListLearnedContext = jest.fn().mockResolvedValue({ memories: [], nextCursor: null, total: 0 });
const mockRemoveLearnedContext = jest.fn().mockResolvedValue({ success: true });
const mockDelegateTask = jest.fn().mockResolvedValue({ success: true, agentId: 'agent-1', status: 'queued' });
const mockSearchConnectorContent = jest.fn().mockResolvedValue({ results: [] });
const mockChat = jest.fn().mockResolvedValue({ status: 'completed' });
const mockGetChatReply = jest.fn().mockResolvedValue({ status: 'completed' });
const mockListConversations = jest.fn().mockResolvedValue({ conversations: [], total: 0 });

jest.mock('../service', () => ({
  findTeammates: (...args: unknown[]) => mockFindTeammates(...args),
  listLearnedContext: (...args: unknown[]) => mockListLearnedContext(...args),
  removeLearnedContext: (...args: unknown[]) => mockRemoveLearnedContext(...args),
  delegateTask: (...args: unknown[]) => mockDelegateTask(...args),
  searchConnectorContent: (...args: unknown[]) => mockSearchConnectorContent(...args),
  chat: (...args: unknown[]) => mockChat(...args),
  getChatReply: (...args: unknown[]) => mockGetChatReply(...args),
  listConversations: (...args: unknown[]) => mockListConversations(...args),
}));

const mockGetAiProvider = jest.fn().mockResolvedValue({ workspaceProvider: 'anthropic', options: ['default', 'anthropic'] });
const mockSetAiProvider = jest.fn().mockResolvedValue({ result: 'preview (confirmationId: abc)' });
const mockGetAiProviderKeys = jest.fn().mockResolvedValue({ providers: [], page: 'https://example.com/dashboard/settings/workspace' });
const mockGetCommunication = jest.fn().mockResolvedValue({ notificationFrequency: 'realtime' });
const mockSetCommunication = jest.fn().mockResolvedValue({ changed: ['notificationFrequency'] });
jest.mock('../settings', () => {
  const actual = jest.requireActual('../settings');
  return {
    ...actual,
    getAiProvider: (...a: unknown[]) => mockGetAiProvider(...a),
    setAiProvider: (...a: unknown[]) => mockSetAiProvider(...a),
    getCommunicationSettings: (...a: unknown[]) => mockGetCommunication(...a),
    getAiProviderKeys: (...a: unknown[]) => mockGetAiProviderKeys(...a),
    setCommunicationSettings: (...a: unknown[]) => mockSetCommunication(...a),
  };
});

import { mcpRouter } from '../router';
import { TOOL_MANIFESTS } from '../types';
import { SERVER_INSTRUCTIONS } from '../server-instructions';

// ── Test app ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use('/mcp', mcpRouter);
  return app;
}

function makeRequest(
  app: express.Express,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer liftoff_sk_test', ...headers },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  injectAuth = true;
  mockResolveMcpActor.mockResolvedValue(mockActor);
  mockBuildInstructions.mockImplementation(async () => `OVERVIEW FOR ${mockActor.displayName}\n\n${SERVER_INSTRUCTIONS}`);
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MCP initialize', () => {
  it('returns protocol version and server info', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    expect(res.status).toBe(200);
    const result = (res.body as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } }).result;
    // No supported version requested → server offers its latest (2026-07-28).
    expect(result?.protocolVersion).toBe('2026-07-28');
    expect(result?.serverInfo?.name).toBe('liftoff');
  });
});

describe('MCP notifications/initialized', () => {
  it('acknowledges without error', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 2, method: 'notifications/initialized' });

    // Notifications must not receive a JSON-RPC result (plan v6.1): 202, empty.
    expect(res.status).toBe(202);
  });
});

describe('MCP tools/list', () => {
  it('returns all 12 tools with required fields', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 3, method: 'tools/list' });

    expect(res.status).toBe(200);
    const tools = (res.body as { result?: { tools?: { name: string; description: string; inputSchema: unknown }[] } }).result?.tools;
    expect(tools).toHaveLength(12);

    // The Anthropic tools API rejects oneOf/allOf/anyOf at the schema top
    // level; a single offending tool 400s the client's whole model call.
    for (const t of tools!) {
      const schema = t.inputSchema as Record<string, unknown>;
      expect(schema.oneOf).toBeUndefined();
      expect(schema.allOf).toBeUndefined();
      expect(schema.anyOf).toBeUndefined();
      expect(schema.type).toBe('object');
    }

    const toolNames = tools!.map((t) => t.name);
    expect(toolNames).toContain('liftoff_find_teammates');
    expect(toolNames).toContain('liftoff_list_learned_context');
    expect(toolNames).toContain('liftoff_remove_learned_context');
    expect(toolNames).toContain('liftoff_delegate_task');
    expect(toolNames).toContain('liftoff_search_connector_content');
    expect(toolNames).toContain('liftoff_list_conversations');
    expect(toolNames).toContain('liftoff_get_settings');
    expect(toolNames).toContain('liftoff_get_ai_provider_keys');
    expect(toolNames).toContain('liftoff_set_ai_provider');
    expect(toolNames).toContain('liftoff_set_communication_settings');

    for (const tool of tools!) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('carries MCP annotations on every tool: reads are readOnlyHint, liftoff_chat is destructiveHint', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = (res.body as { result?: { tools?: Array<{ name: string; annotations?: Record<string, boolean> }> } }).result!.tools!;
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    for (const name of [
      'liftoff_find_teammates', 'liftoff_list_learned_context',
      'liftoff_search_connector_content', 'liftoff_get_chat_reply', 'liftoff_list_conversations',
      'liftoff_get_settings', 'liftoff_get_ai_provider_keys',
    ]) {
      expect(byName.get(name)?.readOnlyHint).toBe(true);
    }
    expect(byName.get('liftoff_chat')?.destructiveHint).toBe(true);
    expect(byName.get('liftoff_search_connector_content')?.openWorldHint).toBe(true);
  });
});

describe('MCP tools/call', () => {
  it('dispatches liftoff_find_teammates to handler', async () => {
    const app = buildApp();
    const res = await makeRequest(app, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'liftoff_find_teammates', arguments: { query: 'engineer' } },
    });

    expect(res.status).toBe(200);
    // Router now parses through FindTeammatesInput zod schema, which fills in
    // default `limit: 10` and undefined caller* attribution fields.
    expect(mockFindTeammates).toHaveBeenCalledWith({
      query: 'engineer',
      limit: 10,
      callerAgentId: undefined,
      callerThreadId: undefined,
      callerInvocationId: undefined,
    }, mockActor);
  });

  it('liftoff_get_settings reads both halves in one call, with no input to give', async () => {
    const app = buildApp();
    const res = await makeRequest(app, {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'liftoff_get_settings', arguments: {} },
    });
    expect(res.status).toBe(200);
    expect(mockGetAiProvider).toHaveBeenCalled();
    expect(mockGetCommunication).toHaveBeenCalled();
    const text = ((res.body.result as { content: { text: string }[] }).content[0]).text;
    expect(JSON.parse(text)).toMatchObject({
      aiProvider: { workspaceProvider: 'anthropic' },
      communication: { notificationFrequency: 'realtime' },
    });
  });

  it('liftoff_set_ai_provider needs a vendor and passes the confirmation handle through', async () => {
    const app = buildApp();
    const bad = await makeRequest(app, {
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: { name: 'liftoff_set_ai_provider', arguments: {} },
    });
    expect((bad.body.error as { code: number }).code).toBe(-32602);
    expect(mockSetAiProvider).not.toHaveBeenCalled();

    await makeRequest(app, {
      jsonrpc: '2.0', id: 22, method: 'tools/call',
      params: { name: 'liftoff_set_ai_provider', arguments: { vendor: 'openai', confirmationId: 'abc' } },
    });
    expect(mockSetAiProvider).toHaveBeenCalledWith({ vendor: 'openai', confirmationId: 'abc' }, expect.anything());
  });

  // A change nobody asked for is the failure mode: an empty argument object must
  // not reach the write and read as "saved".
  it('liftoff_set_communication_settings refuses a change with nothing in it', async () => {
    const app = buildApp();
    const res = await makeRequest(app, {
      jsonrpc: '2.0', id: 23, method: 'tools/call',
      params: { name: 'liftoff_set_communication_settings', arguments: {} },
    });
    expect((res.body.error as { code: number }).code).toBe(-32602);
    expect(mockSetCommunication).not.toHaveBeenCalled();

    await makeRequest(app, {
      jsonrpc: '2.0', id: 24, method: 'tools/call',
      params: { name: 'liftoff_set_communication_settings', arguments: { emailDelivery: false } },
    });
    expect(mockSetCommunication).toHaveBeenCalledWith({ emailDelivery: false }, expect.anything());
  });

  it('liftoff_get_ai_provider_keys reads key state and needs no input', async () => {
    const app = buildApp();
    const res = await makeRequest(app, {
      jsonrpc: '2.0', id: 25, method: 'tools/call',
      params: { name: 'liftoff_get_ai_provider_keys', arguments: {} },
    });
    expect(res.status).toBe(200);
    expect(mockGetAiProviderKeys).toHaveBeenCalled();
  });

  // The reason this tool is read-only is that a tool argument is a token in a
  // model's context first, and from there it is in the transcript, the logs and
  // — since recall — an embedded, searchable turn. So no tool may offer anywhere
  // to put one. Asserted over the WHOLE manifest rather than this one tool,
  // because the hazard is a future tool adding such a field, not this one.
  it('no tool anywhere accepts a key, a secret or a token', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 26, method: 'tools/list' });
    const tools = (res.body as { result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] } }).result.tools;
    const forbidden = /(^|_)(api_?key|secret|token|password|credential|private_?key)s?($|_)/i;
    const offenders: string[] = [];
    let fieldsSeen = 0;
    for (const tool of tools) {
      for (const field of Object.keys(tool.inputSchema.properties ?? {})) {
        fieldsSeen++;
        // The FIELD is matched, never `name.field`: the pattern anchors on a
        // word boundary, and a qualified string puts a '.' where the anchor has
        // to be, so every field silently passed. Found by injecting an `apiKey`
        // field and watching this go green.
        if (forbidden.test(field)) offenders.push(`${tool.name}.${field}`);
      }
    }
    // A manifest this test could not read would also report no offenders.
    expect(fieldsSeen).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it('dispatches liftoff_list_learned_context through its zod schema', async () => {
    const app = buildApp();
    const res = await makeRequest(app, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'liftoff_list_learned_context', arguments: { team: 'Marketing' } },
    });

    expect(res.status).toBe(200);
    expect(mockListLearnedContext).toHaveBeenCalledWith({ team: 'Marketing' }, mockActor);
  });

  it('refuses liftoff_remove_learned_context without a memoryId as a protocol error', async () => {
    const app = buildApp();
    const res = await makeRequest(app, {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'liftoff_remove_learned_context', arguments: { team: 'Marketing' } },
    });

    const body = res.body as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32602);
    expect(mockRemoveLearnedContext).not.toHaveBeenCalled();
  });

  it('dispatches liftoff_remove_learned_context to handler', async () => {
    const app = buildApp();
    await makeRequest(app, {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'liftoff_remove_learned_context', arguments: { team: 'Marketing', memoryId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } },
    });

    expect(mockRemoveLearnedContext).toHaveBeenCalledWith(
      { team: 'Marketing', memoryId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      mockActor,
    );
  });

  it('returns a JSON-RPC error for unknown tool name (plan v6.1: lifted out of result)', async () => {
    const app = buildApp();
    const res = await makeRequest(app, {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'liftoff_nonexistent', arguments: {} },
    });

    expect(res.status).toBe(200);
    const body = res.body as { result?: unknown; error?: { code?: number } };
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32601);
  });
});

describe('MCP method routing', () => {
  it('returns -32601 for unknown method', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 7, method: 'unknownMethod' });

    expect(res.status).toBe(200);
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32601);
  });
});

describe('Auth enforcement', () => {
  it('hard-rejects if req.mcpAuth is not set after middleware', async () => {
    injectAuth = false;
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 8, method: 'initialize' });

    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32001);
  });
});

describe('Membership gate (per call, fail closed)', () => {
  const serviceMocks = [
    mockFindTeammates, mockListLearnedContext, mockRemoveLearnedContext,
    mockDelegateTask, mockSearchConnectorContent, mockChat, mockGetChatReply, mockListConversations,
  ];

  it('answers -32001 on EVERY tool when the account is no longer a member, and calls no handler', async () => {
    mockResolveMcpActor.mockResolvedValue(null);
    const app = buildApp();
    for (const manifest of TOOL_MANIFESTS) {
      const res = await makeRequest(app, {
        jsonrpc: '2.0', id: 50, method: 'tools/call',
        params: { name: manifest.name, arguments: { query: 'x', message: 'x', team: 't', objective: 'o', chatRunId: '77777777-7777-7777-7777-777777777777', memoryId: '77777777-7777-7777-7777-777777777777' } },
      });
      const body = res.body as { result?: unknown; error?: { code?: number; message?: string } };
      expect(body.result).toBeUndefined();
      expect(body.error?.code).toBe(-32001);
      expect(body.error?.message).toContain('member');
    }
    for (const m of serviceMocks) expect(m).not.toHaveBeenCalled();
  });

  it('resolves the actor from the auth context on each call and hands it to the handler', async () => {
    const app = buildApp();
    await makeRequest(app, {
      jsonrpc: '2.0', id: 51, method: 'tools/call',
      params: { name: 'liftoff_list_learned_context', arguments: { team: 'Marketing' } },
    });
    expect(mockResolveMcpActor).toHaveBeenCalledWith(mockMcpAuth);
    expect(mockListLearnedContext).toHaveBeenCalledWith({ team: 'Marketing' }, mockActor);
  });

  it("passes a viewer's role through so the service can refuse a Learned Context change", async () => {
    const viewer = { ...mockActor, role: 'viewer' };
    mockResolveMcpActor.mockResolvedValue(viewer);
    mockRemoveLearnedContext.mockResolvedValueOnce({ success: false, error: 'Viewers cannot manage Learned Context' });
    const app = buildApp();
    const res = await makeRequest(app, {
      jsonrpc: '2.0', id: 52, method: 'tools/call',
      params: { name: 'liftoff_remove_learned_context', arguments: { team: 'Marketing', memoryId: '77777777-7777-7777-7777-777777777777' } },
    });
    expect(mockRemoveLearnedContext).toHaveBeenCalledWith(expect.objectContaining({ team: 'Marketing' }), viewer);
    const result = (res.body as { result?: { structuredContent?: { success?: boolean } } }).result;
    expect(result?.structuredContent?.success).toBe(false);
  });

  it('dispatches liftoff_list_conversations with parsed filters', async () => {
    const app = buildApp();
    await makeRequest(app, {
      jsonrpc: '2.0', id: 53, method: 'tools/call',
      params: { name: 'liftoff_list_conversations', arguments: { team: 'Marketing', query: 'launch' } },
    });
    expect(mockListConversations).toHaveBeenCalledWith({ team: 'Marketing', query: 'launch', limit: 20 }, mockActor);
  });
});


// ── Plan v6.1 conformance additions ───────────────────────────────────────

describe('MCP protocol conformance (v6.1)', () => {
  it('is liberal about the MCP-Protocol-Version header: serves an older or newer value, never 400s (INV-PB-008)', async () => {
    const app = buildApp();
    const older = await makeRequest(app, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'MCP-Protocol-Version': '2024-11-05' });
    expect(older.status).toBe(200);
    const newer = await makeRequest(app, { jsonrpc: '2.0', id: 33, method: 'tools/list' }, { 'MCP-Protocol-Version': '2026-07-28' });
    expect(newer.status).toBe(200);
    // An unknown far-future version is also served (not rejected).
    const future = await makeRequest(app, { jsonrpc: '2.0', id: 34, method: 'tools/list' }, { 'MCP-Protocol-Version': '2099-01-01' });
    expect(future.status).toBe(200);
  });

  it('accepts a missing version header (legacy default, no behavioral branch)', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect(res.status).toBe(200);
  });

  it('implements server/discover (stateless 2026-07-28 capability advertisement)', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 40, method: 'server/discover' });
    expect(res.status).toBe(200);
    const result = (res.body as { result?: { resultType?: string; protocolVersions?: string[]; serverInfo?: { name?: string }; capabilities?: Record<string, unknown> } }).result;
    expect(result?.resultType).toBe('complete');
    expect(result?.protocolVersions).toContain('2026-07-28');
    expect(result?.serverInfo?.name).toBe('liftoff');
    expect(result?.capabilities).toEqual({ tools: {}, prompts: {} });
  });

  it('stamps resultType + cache hints on tools/list (CacheableResult)', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 41, method: 'tools/list' });
    const result = (res.body as { result?: { resultType?: string; ttlMs?: number; cacheScope?: string; tools?: unknown[] } }).result;
    expect(result?.resultType).toBe('complete');
    expect(typeof result?.ttlMs).toBe('number');
    expect(result?.cacheScope).toBe('public');
    expect(Array.isArray(result?.tools)).toBe(true);
  });

  it('echoes a supported requested protocol version at initialize', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    const result = (res.body as { result?: { protocolVersion?: string; instructions?: string; capabilities?: Record<string, unknown> } }).result;
    expect(result?.protocolVersion).toBe('2025-03-26');
    expect(result?.instructions).toContain('liftoff_chat');
    expect(result?.instructions).toContain('liftoff_list_conversations');
    // The person's overview leads, built for the resolved actor.
    expect(result?.instructions?.startsWith('OVERVIEW FOR Alice Example')).toBe(true);
    expect(mockBuildInstructions).toHaveBeenCalledWith(mockActor);
    expect(result?.capabilities).toEqual({ tools: {}, prompts: {} });
  });

  it('falls back to the standing instructions when the caller is not a member or the overview fails', async () => {
    const app = buildApp();
    mockResolveMcpActor.mockResolvedValueOnce(null);
    const noActor = await makeRequest(app, { jsonrpc: '2.0', id: 42, method: 'server/discover' });
    expect((noActor.body as { result?: { instructions?: string } }).result?.instructions).toBe(SERVER_INSTRUCTIONS);

    mockBuildInstructions.mockRejectedValueOnce(new Error('db down'));
    const failed = await makeRequest(app, { jsonrpc: '2.0', id: 43, method: 'initialize', params: {} });
    expect((failed.body as { result?: { instructions?: string } }).result?.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it('405s GET /mcp without requiring auth', async () => {
    const app = buildApp();
    const res: { status: number } = await new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        fetch(`http://127.0.0.1:${addr.port}/mcp`).then((r) => { server.close(); resolve({ status: r.status }); })
          .catch((e) => { server.close(); reject(e); });
      });
    });
    expect(res.status).toBe(405);
  });

  it('serves the two static prompts', async () => {
    const app = buildApp();
    const res = await makeRequest(app, { jsonrpc: '2.0', id: 6, method: 'prompts/list' });
    const prompts = (res.body as { result?: { prompts?: Array<{ name: string }> } }).result?.prompts;
    expect(prompts?.map((p) => p.name)).toEqual(['chat', 'teammates']);
  });

  it('wraps tool results in the spec envelope with structuredContent', async () => {
    mockListLearnedContext.mockResolvedValueOnce({ memories: [], nextCursor: null, total: 0 });
    const app = buildApp();
    const res = await makeRequest(app, {
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'liftoff_list_learned_context', arguments: { team: 'Marketing' } },
    });
    const result = (res.body as { result?: { content?: Array<{ type: string; text: string }>; structuredContent?: unknown } }).result;
    expect(result?.content?.[0].type).toBe('text');
    expect(result?.structuredContent).toEqual({ memories: [], nextCursor: null, total: 0 });
  });

  it('marks thrown tool failures with isError: true (still a result, not a protocol error)', async () => {
    mockListLearnedContext.mockRejectedValueOnce(new Error('db down'));
    const app = buildApp();
    const res = await makeRequest(app, {
      jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'liftoff_list_learned_context', arguments: { team: 'Marketing' } },
    });
    const body = res.body as { result?: { isError?: boolean; structuredContent?: { error?: string } }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent?.error).toBe('db down');
  });
});

// ── liftoff_chat attachments: the body and schema boundaries ──────────────
//
// Inline media rides a JSON body, so two limits bound it: the schema caps
// each item at 1.5 MiB decoded (checked on the base64 length, before any
// decode) and four items per message; the router's body parser caps the
// whole request at 10 MB. Four items at the cap pass both; one byte over the
// per-item cap is refused by the schema with a message naming the limit; a
// body over 10 MB never reaches the schema.

describe('liftoff_chat attachments boundaries', () => {
  const ONE_AND_A_HALF_MIB = 1.5 * 1024 * 1024;
  const item = (bytes: number) => ({ name: 'shot.png', mimeType: 'image/png', base64: Buffer.alloc(bytes, 1).toString('base64') });
  const call = (mediaInline: unknown[]) => ({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'liftoff_chat', arguments: { team: 'Liftoff', message: 'look', mediaInline } },
  });

  it('four items at 1.5 MiB each pass the parser and the schema', async () => {
    const res = await makeRequest(buildApp(), call([item(ONE_AND_A_HALF_MIB), item(ONE_AND_A_HALF_MIB), item(ONE_AND_A_HALF_MIB), item(ONE_AND_A_HALF_MIB)]));
    expect(res.status).toBe(200);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect((mockChat.mock.calls[0][0] as { mediaInline: unknown[] }).mediaInline).toHaveLength(4);
  });

  it('one item at 1.5 MiB + 1 byte is refused by the schema, naming the limit', async () => {
    const res = await makeRequest(buildApp(), call([item(ONE_AND_A_HALF_MIB + 1)]));
    expect(res.status).toBe(200);
    const error = (res.body as { error?: { code: number; message: string; data?: unknown } }).error;
    expect(error?.code).toBe(-32602);
    expect(JSON.stringify(error)).toContain('1.5 MiB');
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('a fifth item is refused by the schema', async () => {
    const res = await makeRequest(buildApp(), call([item(10), item(10), item(10), item(10), item(10)]));
    const error = (res.body as { error?: { code: number } }).error;
    expect(error?.code).toBe(-32602);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('a body over 10 MB is refused by the parser (413)', async () => {
    // Five items just under the per-item cap: each passes the schema, together
    // they exceed the body limit, and the parser answers before the schema.
    const res = await makeRequest(buildApp(), call([item(ONE_AND_A_HALF_MIB), item(ONE_AND_A_HALF_MIB), item(ONE_AND_A_HALF_MIB), item(ONE_AND_A_HALF_MIB), item(ONE_AND_A_HALF_MIB), item(ONE_AND_A_HALF_MIB)]));
    expect(res.status).toBe(413);
    expect(mockChat).not.toHaveBeenCalled();
  });
});
