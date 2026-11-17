// Which tools the Claude Agent SDK is told never to defer.
//
// The SDK's tool search is ON BY DEFAULT and withholds tool definitions until a
// turn needs them (`defer_loading`; a live run can defer a hundred tools). That
// is the vendor doing what tool-tiering.ts does for the other engines — and it
// means rule one of that module, "a tool the agent's own instructions NAME is
// never hidden", was enforced on the other engines and not on this one.
//
// These tests assert the opt-out is actually passed, per tool, from the single
// vocabulary both mechanisms read. A prompt that says "read the file, then run
// the tests" cannot be followed if `file_read` has to be found by a ToolSearch
// first, and the browser-navigation rules hoisted above the persona block in
// interactive-chat/system-prompt.ts are what that failure costs.

// The extras argument is the whole point of this suite, so unlike every other
// mcp-server suite this mock keeps it.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((
    _name: string,
    _desc: string,
    _schema: unknown,
    handler: (...args: unknown[]) => unknown,
    extras?: { alwaysLoad?: boolean },
  ) => ({ name: _name, handler, alwaysLoad: extras?.alwaysLoad === true })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[]; name?: string }) => ({ type: 'sdk', name: opts.name || 'test', tools: opts.tools })),
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

// Three real names, not the full list: the two routine rails the chat prompt
// names (which must never be deferred) and one ordinary standard tool as the
// control that deferral still happens.
jest.mock('../../tools/standard-tools', () => ({
  STANDARD_TOOLS: [
    { name: 'propose_routine', description: 'd', input_schema: { type: 'object', properties: {} } },
    { name: 'run_routine_now', description: 'd', input_schema: { type: 'object', properties: {} } },
    { name: 'note_save', description: 'd', input_schema: { type: 'object', properties: {} } },
  ],
}));
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

import { createToolGatewayMcpServer } from '../mcp-server';
import { isAlwaysLoadedTool } from '../../agent-execution/adapter/tool-tiering';

interface Registered { name: string; alwaysLoad: boolean }

async function registeredTools(
  overrides: Record<string, unknown> = {},
): Promise<Registered[]> {
  const result = await createToolGatewayMcpServer(baseInput(overrides));
  return (result.mcpServer as unknown as { tools: Registered[] }).tools;
}

describe('SDK tool-search opt-out', () => {
  it('always-loads every sandbox tool the prompts name, and defers the rest', async () => {
    const tools = await registeredTools({
      sandboxCapabilities: ['shell', 'file', 'browser', 'vscode'],
    });
    const sandboxNames = tools.map((t) => t.name);

    // The vocabulary is opted out...
    for (const name of ['file_read', 'file_write', 'shell_exec', 'bash_session_exec', 'git_clone']) {
      expect(sandboxNames).toContain(name);
      expect(tools.find((t) => t.name === name)!.alwaysLoad).toBe(true);
    }
    // ...and the bulk is left to the SDK to defer, which is the point of having
    // a vocabulary rather than always-loading everything.
    const browser = tools.filter((t) => t.name.startsWith('browser_'));
    expect(browser.length).toBeGreaterThan(0);
    expect(browser.every((t) => t.alwaysLoad === false)).toBe(true);
  });

  it('always-loads code_session, the only code path an Anthropic run has', async () => {
    const tools = await registeredTools({
      sandboxCapabilities: ['shell', 'file', 'browser', 'vscode'],
    });
    const codeSession = tools.find((t) => t.name === 'code_session');
    expect(codeSession).toBeDefined();
    expect(codeSession!.alwaysLoad).toBe(true);
  });

  it('always-loads report_task_outcome, so the terminal contract needs no search', async () => {
    const tools = await registeredTools({ terminalOutcomeContract: true });
    const report = tools.find((t) => t.name === 'report_task_outcome');
    expect(report).toBeDefined();
    expect(report!.alwaysLoad).toBe(true);
  });

  it('always-loads the routine rails the chat prompt names, and defers other standard tools', async () => {
    // The chat prompt says, by name, that propose_routine is how schedules
    // change and run_routine_now is how the work runs in chat. Deferred behind
    // the SDK's tool search, the model searched "scheduling tools", found the
    // in-session wake machinery, and told the person to go edit a cron.
    const tools = await registeredTools({ workflowRunRef: { requested: false } });
    for (const name of ['propose_routine', 'run_routine_now']) {
      const t = tools.find((x) => x.name === name);
      expect(t).toBeDefined();
      expect(t!.alwaysLoad).toBe(true);
    }
    const control = tools.find((x) => x.name === 'note_save');
    expect(control).toBeDefined();
    expect(control!.alwaysLoad).toBe(false);
  });

  it('registers exactly what the shared predicate names, with no second list', async () => {
    const tools = await registeredTools({
      sandboxCapabilities: ['shell', 'file', 'browser', 'vscode'],
      terminalOutcomeContract: true,
    });
    for (const t of tools) {
      // Every divergence here is a tool whose disclosure differs between the SDK
      // and our own tiering, which is how a prompt's vocabulary goes missing on
      // one engine and not the other.
      expect({ name: t.name, alwaysLoad: t.alwaysLoad })
        .toEqual({ name: t.name, alwaysLoad: isAlwaysLoadedTool(t.name) });
    }
  });
});
