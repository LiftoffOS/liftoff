// recall_conversations gateway tool — registration matrix, wiring, and
// failure modes (plan v13 Change 4). ServiceClient is mocked; every failure
// mode must surface an HONEST tool error (INV-4), never an empty success.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => ({ name: _name, handler })),
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

const mockLoggerWarn = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: (...a: unknown[]) => mockLoggerWarn(...a), error: jest.fn() },
}));

jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: jest.fn().mockReturnValue({}),
}));

jest.mock('../../audit', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

import { createToolGatewayMcpServer } from '../mcp-server';
import { LogSchemas } from '../../observability/log-schemas';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUNTIME_AGENT = '22222222-2222-4222-8222-222222222222';
const INTERNAL_AGENT = '33333333-3333-4333-8333-333333333333';
const SENDER = '44444444-4444-4444-8444-444444444444';
const TURN = '55555555-5555-4555-8555-555555555555';

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
    messageSenderAccountId: SENDER,
    turnId: TURN,
    ...overrides,
  } as any;
}

/** Make the runtime->internal mapping resolve (or not). */
function mockMapping(internalId: string | null, opts: { throw?: boolean } = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('internal_agent_runtime_mapping')) {
      if (opts.throw) throw new Error('mapping db down');
      return { rows: internalId ? [{ internal_agent_id: internalId }] : [] };
    }
    return { rows: [] };
  });
}

/** Default callback-client behavior for the gateway's build-time knowledge
 *  exposure check; per-call expectations use mockResolvedValueOnce AFTER the
 *  build so the handler sees them. */
function defaultCallbackFetch() {
  mockCallbackFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0 }) });
  const { __resetKnowledgeExposureCache } = jest.requireActual('../knowledge-exposure-cache');
  __resetKnowledgeExposureCache();
}

function findRecall(result: { mcpServer: { tools?: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> } }) {
  return (result.mcpServer.tools ?? []).find((t) => t.name === 'recall_conversations');
}

describe('recall_conversations registration matrix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallbackClient = { fetch: mockCallbackFetch };
    process.env.RECALL_CONVERSATIONS_ENABLED = 'true';
    defaultCallbackFetch();
    mockMapping(INTERNAL_AGENT);
  });

  afterEach(() => {
    delete process.env.RECALL_CONVERSATIONS_ENABLED;
  });

  it('registers when flag + client + messageSenderAccountId + turnId + mapping all present', async () => {
    const result = await createToolGatewayMcpServer(baseInput());
    expect(result.modelTools.map((t) => t.name)).toContain('recall_conversations');
    expect(findRecall(result as any)).toBeDefined();
  });

  it('absent when the flag is off', async () => {
    delete process.env.RECALL_CONVERSATIONS_ENABLED;
    const result = await createToolGatewayMcpServer(baseInput());
    expect(result.modelTools.map((t) => t.name)).not.toContain('recall_conversations');
  });

  it('absent when the platform callback client is not configured', async () => {
    mockCallbackClient = null;
    const result = await createToolGatewayMcpServer(baseInput());
    expect(result.modelTools.map((t) => t.name)).not.toContain('recall_conversations');
  });

  it('absent when messageSenderAccountId is missing (scheduled/cron/A2A turns)', async () => {
    const result = await createToolGatewayMcpServer(baseInput({ messageSenderAccountId: undefined }));
    expect(result.modelTools.map((t) => t.name)).not.toContain('recall_conversations');
  });

  it('absent when turnId is missing', async () => {
    const result = await createToolGatewayMcpServer(baseInput({ turnId: undefined }));
    expect(result.modelTools.map((t) => t.name)).not.toContain('recall_conversations');
  });

  it('absent with a skip log when the runtime->internal mapping is missing — no identity fallback', async () => {
    mockMapping(null);
    const result = await createToolGatewayMcpServer(baseInput());
    expect(result.modelTools.map((t) => t.name)).not.toContain('recall_conversations');
    const skip = mockLoggerWarn.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'recall_conversations_skipped',
    );
    expect(skip).toBeDefined();
  });

  it('a mapping lookup FAILURE skips registration without aborting the rest of the catalog', async () => {
    mockMapping(null, { throw: true });
    const result = await createToolGatewayMcpServer(baseInput());
    const names = result.modelTools.map((t) => t.name);
    expect(names).not.toContain('recall_conversations');
    expect(names).toContain('memory_save'); // catalog construction survived
    const skip = mockLoggerWarn.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'recall_conversations_skipped',
    );
    expect(skip).toBeDefined();
  });

  it('the skip log payload satisfies the registered schema (INV-TR-002)', () => {
    const parsed = LogSchemas.recall_conversations_skipped.safeParse({
      event: 'recall_conversations_skipped',
      tenantId: TENANT,
      reason: 'no runtime->internal agent mapping',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('recall_conversations handler wiring + failure modes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallbackClient = { fetch: mockCallbackFetch };
    process.env.RECALL_CONVERSATIONS_ENABLED = 'true';
    defaultCallbackFetch();
    mockMapping(INTERNAL_AGENT);
  });

  afterEach(() => {
    delete process.env.RECALL_CONVERSATIONS_ENABLED;
  });

  async function registeredHandler() {
    // Build FIRST (the gateway's knowledge-exposure check consumes callback
    // fetches during construction), then reset call history so handler
    // assertions see only the handler's own call.
    const result = await createToolGatewayMcpServer(baseInput());
    const tool = findRecall(result as any);
    expect(tool).toBeDefined();
    mockCallbackFetch.mockClear();
    return tool!.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError: boolean }>;
  }

  it('wires input.turnId end-to-end: the endpoint receives it as excludeTurnId (with internal agent id + account)', async () => {
    mockCallbackFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ turns: [] }),
    });
    const handler = await registeredHandler();
    const out = await handler({ query: 'previous discussion', limit: 3 });
    expect(out.isError).toBe(false);

    expect(mockCallbackFetch).toHaveBeenCalledWith(
      'platform',
      '/api/internal/platform-tools/agent-conversations',
      expect.objectContaining({
        method: 'POST',
        breakerKey: 'platform:agent-conversations',
      }),
    );
    const body = JSON.parse((mockCallbackFetch.mock.calls[0][2] as { body: string }).body);
    expect(body).toEqual({
      tenantId: TENANT,
      agentId: INTERNAL_AGENT,       // runtime id translated at the boundary
      accountId: SENDER,
      excludeTurnId: TURN,           // the CURRENT turn, excluded
      query: 'previous discussion',
      limit: 3,
    });
  });

  it('non-OK HTTP status surfaces an honest tool error', async () => {
    const handler = await registeredHandler();
    mockCallbackFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    const out = await handler({});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('Platform returned 500');
  });

  it('malformed JSON surfaces an honest tool error', async () => {
    const handler = await registeredHandler();
    mockCallbackFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unexpected token');
      },
    });
    const out = await handler({});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('malformed platform response');
  });

  it('transport error/timeout surfaces an honest tool error', async () => {
    const handler = await registeredHandler();
    mockCallbackFetch.mockRejectedValueOnce(new Error('fetch failed: ETIMEDOUT'));
    const out = await handler({});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('ETIMEDOUT');
  });

  it('circuit-open rejection surfaces an honest tool error', async () => {
    const handler = await registeredHandler();
    mockCallbackFetch.mockRejectedValueOnce(new Error('breaker platform:agent-conversations is OPEN'));
    const out = await handler({});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('OPEN');
  });
});
