// read_conversation_history gateway tool — registration, wiring, and failure
// modes. ServiceClient is mocked; every failure mode must surface an HONEST
// tool error (INV-4), never an empty transcript. A model told the thread is
// empty tells the person they never said the thing.
//
// The registration matrix is the part worth pinning, because it differs from
// recall_conversations' on purpose: this tool needs the thread alone. Gating it
// on the recall flag, the account id or the internal agent id would switch it
// off for exactly the turns that need it most.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => ({ name: _name, description: _desc, handler })),
  createSdkMcpServer: jest.fn((opts: { name?: string; tools: unknown[] }) => ({ type: 'sdk', name: opts.name || 'test', tools: opts.tools })),
}));

jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn().mockReturnValue([]),
  listConnectorTypes: jest.fn().mockReturnValue([]),
}));

jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifestsForAgent: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../../tools/standard-tools', () => ({
  STANDARD_TOOLS: [
    { name: 'memory_save', description: 'Save memory', input_schema: { type: 'object', properties: {} } },
  ],
}));

const mockCallbackFetch = jest.fn();
let mockCallbackClient: { fetch: typeof mockCallbackFetch } | null = { fetch: mockCallbackFetch };
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: jest.fn(() => mockCallbackClient),
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

jest.mock('../../audit', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

import { createToolGatewayMcpServer } from '../mcp-server';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUNTIME_AGENT = '22222222-2222-4222-8222-222222222222';
const THREAD = '66666666-6666-4666-8666-666666666666';

const TOOL = 'read_conversation_history';
const ENDPOINT = '/api/internal/platform-tools/thread-history';

const mockToolGateway = {
  execute: jest.fn().mockResolvedValue({ success: true, data: {}, traceId: 'tr' }),
  setCredentialService: jest.fn(),
};

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    agentId: RUNTIME_AGENT,
    instructionVersion: 1,
    traceId: 'trace',
    allowedConnectors: [],
    toolGateway: mockToolGateway as any,
    threadId: THREAD,
    ...overrides,
  } as any;
}

function defaultCallbackFetch() {
  mockCallbackFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0 }) });
  const { __resetKnowledgeExposureCache } = jest.requireActual('../knowledge-exposure-cache');
  __resetKnowledgeExposureCache();
}

type Handled = { content?: Array<{ text?: string }>; isError?: boolean };

function findTool(result: { mcpServer: { tools?: Array<{ name: string; description?: string; handler: (args: Record<string, unknown>) => Promise<Handled> }> } }) {
  return (result.mcpServer.tools ?? []).find((t) => t.name === TOOL);
}

/** The gateway calls the platform more than once while building. Only the
 *  handler's own call is asserted, so it is queued after the build. */
async function callTool(args: Record<string, unknown>, response: unknown) {
  const result = await createToolGatewayMcpServer(baseInput());
  const handler = findTool(result as any)!;
  mockCallbackFetch.mockReset();
  if (response instanceof Error) mockCallbackFetch.mockRejectedValueOnce(response);
  else mockCallbackFetch.mockResolvedValueOnce(response);
  const out = await handler.handler(args);
  return { out, call: mockCallbackFetch.mock.calls[0] };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallbackClient = { fetch: mockCallbackFetch };
  defaultCallbackFetch();
});

describe(`${TOOL} registration matrix`, () => {
  it('registers on a turn that has a thread', async () => {
    const result = await createToolGatewayMcpServer(baseInput());

    expect(result.modelTools.map((t) => t.name)).toContain(TOOL);
    expect(findTool(result as any)).toBeDefined();
  });

  it('is absent when the turn has no thread — there is nothing to read', async () => {
    const result = await createToolGatewayMcpServer(baseInput({ threadId: undefined }));

    expect(result.modelTools.map((t) => t.name)).not.toContain(TOOL);
  });

  it('is absent when the platform callback client is not configured', async () => {
    mockCallbackClient = null;
    const result = await createToolGatewayMcpServer(baseInput());

    expect(result.modelTools.map((t) => t.name)).not.toContain(TOOL);
  });

  it('does NOT depend on the recall flag, the account id or the turn id', async () => {
    // The three preconditions recall_conversations needs, all absent: that tool
    // searches ACROSS conversations for one person, this one reads the thread
    // the turn already holds.
    delete process.env.RECALL_CONVERSATIONS_ENABLED;
    const result = await createToolGatewayMcpServer(
      baseInput({ messageSenderAccountId: undefined, turnId: undefined }),
    );

    expect(result.modelTools.map((t) => t.name)).toContain(TOOL);
  });

  it('describes itself as reading THIS conversation, which is what makes a model reach for it', async () => {
    const result = await createToolGatewayMcpServer(baseInput());
    const description = findTool(result as any)!.description ?? '';

    expect(description).toContain('THIS conversation');
    expect(description).toContain('as I said above');
    // The product's own words: an internal agent is an agent, never an agent.
    expect(description).not.toMatch(/\bagents?\b/i);
  });
});

describe(`${TOOL} handler wiring`, () => {
  it('sends the tenant and the TURN\'s thread id, and the model\'s arguments beside them', async () => {
    const { call } = await callTool(
      { match: 'deadline', limit: 10, before: '2026-09-02T10:00:00.000Z' },
      { ok: true, status: 200, json: async () => ({ text: 'a transcript' }) },
    );

    expect(call[1]).toBe(ENDPOINT);
    expect(JSON.parse((call[2] as { body: string }).body)).toEqual({
      tenantId: TENANT,
      threadId: THREAD,
      match: 'deadline',
      limit: 10,
      before: '2026-09-02T10:00:00.000Z',
    });
  });

  it('ignores a threadId in the model\'s arguments: a model cannot name a conversation it is not in', async () => {
    const other = '77777777-7777-4777-8777-777777777777';
    const { call } = await callTool(
      { threadId: other },
      { ok: true, status: 200, json: async () => ({ text: 'a transcript' }) },
    );

    expect(JSON.parse((call[2] as { body: string }).body).threadId).toBe(THREAD);
  });

  it('returns the transcript as the model reads it', async () => {
    const { out } = await callTool({}, { ok: true, status: 200, json: async () => ({ text: 'Person: the deadline is 3 March' }) });

    expect(out.isError).toBe(false);
    expect(out.content?.[0]?.text).toBe('Person: the deadline is 3 March');
  });

  it('rides its own circuit breaker, so a recall outage does not close this one', async () => {
    const { call } = await callTool({}, { ok: true, status: 200, json: async () => ({ text: 'x' }) });

    expect((call[2] as { breakerKey: string }).breakerKey).toBe('platform:thread-history');
  });
});

describe(`${TOOL} failure modes surface honestly (INV-4)`, () => {
  it('a non-OK status is an error, never an empty history', async () => {
    const { out } = await callTool({}, { ok: false, status: 500, text: async () => 'boom' });

    expect(out.isError).toBe(true);
  });

  it('malformed JSON is an error', async () => {
    const { out } = await callTool({}, {
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json'); },
    });

    expect(out.isError).toBe(true);
  });

  it('a 200 carrying no transcript is an error, not an empty conversation', async () => {
    const { out } = await callTool({}, { ok: true, status: 200, json: async () => ({}) });

    expect(out.isError).toBe(true);
    expect(out.content?.[0]?.text).toContain('no transcript');
  });

  it('a transport failure or open breaker is an error', async () => {
    const { out } = await callTool({}, new Error('circuit open'));

    expect(out.isError).toBe(true);
  });
});

describe('the two recall tools steer a model to the right one', () => {
  // They answer different questions and a model picks between them on the
  // descriptions alone. recall_conversations returns short excerpts and at most
  // one hit per conversation, so aiming it at "what did I say earlier here"
  // gets a fragment of the answer and reads as though the rest was never said.
  it('recall_conversations claims OTHER conversations and points here for this one', async () => {
    process.env.RECALL_CONVERSATIONS_ENABLED = 'true';
    mockQuery.mockImplementation(async (sql: string) => (
      typeof sql === 'string' && sql.includes('internal_agent_runtime_mapping')
        ? { rows: [{ internal_agent_id: '33333333-3333-4333-8333-333333333333' }] }
        : { rows: [] }
    ));

    const result = await createToolGatewayMcpServer(baseInput({
      messageSenderAccountId: '44444444-4444-4444-8444-444444444444',
      turnId: '55555555-5555-4555-8555-555555555555',
    }));
    const recall = (result.mcpServer.tools ?? []).find((t: { name: string }) => t.name === 'recall_conversations') as
      { description?: string } | undefined;

    delete process.env.RECALL_CONVERSATIONS_ENABLED;

    expect(recall).toBeDefined();
    expect(recall!.description).toContain('OTHER conversations');
    expect(recall!.description).toContain(TOOL);
  });
});
