// MCP Server Collab Tools — unit tests
// Covers: send_agent_message (sender_id from context), read_agent_messages,
// find_teammates (includes mcp_tokens users).

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => ({ name: _name, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[] }) => ({ type: 'sdk', name: opts.name || 'test', tools: opts.tools })),
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

jest.mock('../../tools/standard-tools', () => ({ STANDARD_TOOLS: [] }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));

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

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { createToolGatewayMcpServer } from '../mcp-server';
import { parseToolErrorEnvelope } from '../tool-error-envelope';

// ── Setup ──────────────────────────────────────────────────────────────────

const PLATFORM_URL = 'http://platform-backend-test';
const CALLBACK_TOKEN = 'test-callback-token';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const RECIPIENT_ID = '33333333-3333-3333-3333-333333333333';
const MSG_ID = '44444444-4444-4444-4444-444444444444';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    instructionVersion: 1,
    traceId: 'trace',
    allowedConnectors: [],
    toolGateway: { execute: jest.fn() },
    ...overrides,
     
  } as any;
}

/** Find a registered tool by name from the MCP server */
function findTool(tools: { name: string; handler: (...args: unknown[]) => unknown }[], name: string) {
  return tools.find((t) => t.name === name);
}

beforeEach(() => {
  // mockReset (not clearAllMocks) so any mockResolvedValueOnce values queued
  // by a previous test but never consumed (e.g. when PLATFORM_BACKEND_URL is
  // missing and the build skips its fetch) are flushed. clearAllMocks does
  // not drain the Once queue, which silently shifted later tests' expected
  // calls into earlier slots.
  mockFetch.mockReset();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });

  process.env.PLATFORM_BACKEND_URL = PLATFORM_URL;
  process.env.PLATFORM_CALLBACK_TOKEN = CALLBACK_TOKEN;

  // createToolGatewayMcpServer now calls /api/internal/knowledge/count at
  // build time (knowledge-exposure-cache → tenantHasBoundKnowledge) to gate
  // corpus_search registration. Queue a one-shot response so this consumes
  // the FIRST fetch call, before any per-test mockResolvedValueOnce.
  // count=0 → corpus_search hidden, which these tests don't care about.
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ count: 0 }),
  });

  // Reset the in-process exposure cache so the count fetch actually fires
  // each test instead of returning a cached value from a previous case.
  const { __resetKnowledgeExposureCache } = jest.requireActual('../knowledge-exposure-cache');
  __resetKnowledgeExposureCache();
});

afterEach(() => {
  delete process.env.PLATFORM_BACKEND_URL;
  delete process.env.PLATFORM_CALLBACK_TOKEN;
});

// ── find_teammates ─────────────────────────────────────────────────────────

describe('find_teammates tool', () => {
  it('is registered when PLATFORM_BACKEND_URL and PLATFORM_CALLBACK_TOKEN are set', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        teammates: [
          { id: RECIPIENT_ID, type: 'internal_agent', name: 'HR Agent' },
          { id: 'mcp-tok-1', type: 'collab', name: 'Alice' },
        ],
        total: 2,
      }),
    });

    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string; handler: (...args: unknown[]) => unknown }[];
    const tool = findTool(tools, 'find_teammates');
    expect(tool).toBeDefined();

    const response = await tool!.handler({ query: 'HR' });
    const content = (response as { content: { text: string }[] }).content[0].text;
    const data = JSON.parse(content);
    expect(data.teammates.some((t: { type: string }) => t.type === 'internal_agent')).toBe(true);
    expect(data.teammates.some((t: { type: string }) => t.type === 'collab')).toBe(true);
  });

  it('calls the correct platform-backend URL with tenantId and query', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ teammates: [], total: 0 }),
    });

    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string; handler: (...args: unknown[]) => unknown }[];
    const tool = findTool(tools, 'find_teammates');
    await tool!.handler({ query: 'billing' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`tenantId=${TENANT_ID}`),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Service-Auth': CALLBACK_TOKEN }) }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('query=billing'),
      expect.anything(),
    );
  });

  it('is skipped when PLATFORM_BACKEND_URL is not set', async () => {
    delete process.env.PLATFORM_BACKEND_URL;
    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string }[];
    expect(tools.find((t) => t.name === 'find_teammates')).toBeUndefined();
  });
});

// ── send_agent_message ─────────────────────────────────────────────────────

describe('send_agent_message tool', () => {
  it('is registered when env vars are set', async () => {
    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string }[];
    expect(tools.find((t) => t.name === 'send_agent_message')).toBeDefined();
  });

  it('uses agentId from context (not params) as senderAgentId', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, messageId: MSG_ID }),
    });

    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string; handler: (...args: unknown[]) => unknown }[];
    const tool = findTool(tools, 'send_agent_message');

    await tool!.handler({ recipientAgentId: RECIPIENT_ID, content: 'hello from agent' });

    // calls[0] is the knowledge-count build-time fetch; the send-agent-message
    // call is whichever entry hits the platform-tools endpoint.
    const call = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/internal/platform-tools/send-agent-message'),
    );
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string) as { senderAgentId: string };
    expect(body.senderAgentId).toBe(AGENT_ID);
  });

  it('sends to the correct platform-backend endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, messageId: MSG_ID }),
    });

    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string; handler: (...args: unknown[]) => unknown }[];
    const tool = findTool(tools, 'send_agent_message');
    await tool!.handler({ recipientAgentId: RECIPIENT_ID, content: 'task for you' });

    expect(mockFetch).toHaveBeenCalledWith(
      `${PLATFORM_URL}/api/internal/platform-tools/send-agent-message`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces a classified TOOL_ERROR envelope on platform error (#3)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, text: async () => 'Not Found', status: 404 });

    const result = await createToolGatewayMcpServer(baseInput());

    const tools = (result.mcpServer as any).tools as { name: string; handler: (...args: unknown[]) => unknown }[];
    const tool = findTool(tools, 'send_agent_message');
    const response = await tool!.handler({ recipientAgentId: RECIPIENT_ID, content: 'x' });

    const typed = response as { content: { text: string }[]; isError: boolean };
    // Platform errors now route through buildToolErrorContent so the model reads
    // the uniform TOOL_ERROR envelope with a classified code/retryable/recovery
    // instead of a bare {success:false} JSON blob.
    expect(typed.isError).toBe(true);
    const parsed = parseToolErrorEnvelope(typed.content[0].text);
    expect(parsed).not.toBeNull();
    expect(parsed!.code).toBe('not_found');   // "Platform returned 404" → not_found
    expect(parsed!.retryable).toBe(false);
  });

  // The control plane explains a refusal in the body, in words written for the
  // agent to act on. A bare status code leads nowhere; the reason does.
  it('carries the platform\'s reason to the model, not only the status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 429,
      text: async () => JSON.stringify({ error: 'Sending too fast: more than 20 messages in a minute. Wait before sending again.' }),
    });

    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string; handler: (...args: unknown[]) => unknown }[];
    const tool = findTool(tools, 'send_agent_message');
    const response = await tool!.handler({ recipientAgentId: RECIPIENT_ID, content: 'x' });

    const typed = response as { content: { text: string }[]; isError: boolean };
    expect(typed.isError).toBe(true);
    const parsed = parseToolErrorEnvelope(typed.content[0].text);
    expect(parsed!.error).toBe('Platform returned 429: Sending too fast: more than 20 messages in a minute. Wait before sending again.');
  });

  it('falls back to the status alone when the body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' });

    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string; handler: (...args: unknown[]) => unknown }[];
    const tool = findTool(tools, 'send_agent_message');
    const response = await tool!.handler({ recipientAgentId: RECIPIENT_ID, content: 'x' });

    const parsed = parseToolErrorEnvelope((response as { content: { text: string }[] }).content[0].text);
    expect(parsed!.error).toBe('Platform returned 502');
  });
});

// ── read_agent_messages ────────────────────────────────────────────────────

describe('read_agent_messages tool', () => {
  it('is registered when env vars are set', async () => {
    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string }[];
    expect(tools.find((t) => t.name === 'read_agent_messages')).toBeDefined();
  });

  it('calls platform-backend with agentId from context', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: MSG_ID, senderType: 'internal_agent', senderId: 'agent-x', content: 'hello', metadata: {}, createdAt: new Date() }], count: 1 }),
    });

    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string; handler: (...args: unknown[]) => unknown }[];
    const tool = findTool(tools, 'read_agent_messages');
    await tool!.handler({});

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`agentId=${AGENT_ID}`),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Service-Auth': CALLBACK_TOKEN }) }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`tenantId=${TENANT_ID}`),
      expect.anything(),
    );
  });

  it('returns messages from platform-backend response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messages: [{ id: MSG_ID, senderType: 'internal_agent', senderId: 'agent-x', content: 'do the thing', metadata: {}, createdAt: new Date().toISOString() }],
        count: 1,
      }),
    });

    const result = await createToolGatewayMcpServer(baseInput());
     
    const tools = (result.mcpServer as any).tools as { name: string; handler: (...args: unknown[]) => unknown }[];
    const tool = findTool(tools, 'read_agent_messages');
    const response = await tool!.handler({});

    const content = (response as { content: { text: string }[] }).content[0].text;
    const data = JSON.parse(content) as { count: number; messages: { id: string }[] };
    expect(data.count).toBe(1);
    expect(data.messages[0].id).toBe(MSG_ID);
  });
});
