// The allowlist narrows what is REGISTERED, not what is displayed.
//
// A capability step's web-only fallback turn hands the gateway an allowlist,
// and the property that matters is that every engine sees the same narrowed
// catalog: the Claude Agent SDK mounts the in-process McpServer instance and
// reads its tools; the OpenAI/Gemini bridge reads `modelTools` and
// `toolInputSchemas`. All three come from the same filtered list here, and the
// vendor server map — connector tools by another route — is empty. A list
// filtered only for display would leave the tools callable underneath it.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((name: string, _desc: string, _schema: unknown, handler: (..._args: unknown[]) => unknown) => ({ name, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[]; name?: string }) => ({ type: 'sdk', name: opts.name || 'test', tools: opts.tools })),
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn().mockReturnValue([]),
  listConnectorTypes: jest.fn().mockReturnValue([]),
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
// The standard tools a capability step's turns can reach: both capability
// tools, three web tools, and an unrelated control.
jest.mock('../../tools/standard-tools', () => ({
  STANDARD_TOOLS: [
    { name: 'capability_search', description: 'd', input_schema: { type: 'object', properties: {} } },
    { name: 'run_capability', description: 'd', input_schema: { type: 'object', properties: {} } },
    { name: 'web_search', description: 'd', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'web_fetch_advanced', description: 'd', input_schema: { type: 'object', properties: { url: { type: 'string' } } } },
    { name: 'web_task', description: 'd', input_schema: { type: 'object', properties: {} } },
    { name: 'note_save', description: 'd', input_schema: { type: 'object', properties: {} } },
  ],
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
// Every standard tool is exposed, so the allowlist is the only thing that narrows.
jest.mock('../../integrations/web-fetch/expose-tools', () => ({
  buildExposedStandardTools: jest.fn(async (tools: unknown[]) => tools),
}));
const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => ({ query: mockQuery }) }));
jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../connectors/connector-service-client', () => ({ getConnectorServiceClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { createToolGatewayMcpServer } from '../mcp-server';
import { webFallbackToolAllowlist, CAPABILITY_WEB_FALLBACK_TOOLS } from '../../agent-execution/engine/capability-step-prompt';
import { STANDARD_TOOL_EFFECTS } from '../tool-effect';
import { WEB_OUTCOME_TOOLS } from '../capability-outcome-signal';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    instructionVersion: 1,
    traceId: 'trace',
    allowedConnectors: [],
    toolGateway: { execute: jest.fn() },
    ...overrides,
  } as never;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  process.env.PLATFORM_BACKEND_URL = 'http://platform-backend-test';
  process.env.PLATFORM_CALLBACK_TOKEN = 'tok';
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ count: 0 }) });
  const { __resetKnowledgeExposureCache } = jest.requireActual('../knowledge-exposure-cache');
  __resetKnowledgeExposureCache();
});

type Registered = { name: string };

describe('createToolGatewayMcpServer with a toolAllowlist', () => {
  it('registers only the allowed names on the SDK server, the bridge list and the schema map alike', async () => {
    const result = await createToolGatewayMcpServer(baseInput({
      stepOutputField: 'result',
      stepOutputKeys: ['posts'],
      toolAllowlist: webFallbackToolAllowlist('result'),
    }));
    const sdkNames = (result.mcpServer as unknown as { tools: Registered[] }).tools.map((t) => t.name).sort();
    const bridgeNames = result.modelTools.map((t) => t.name).sort();
    const schemaNames = Object.keys(result.toolInputSchemas).sort();

    expect(sdkNames).toEqual(['record_step_output', 'web_fetch_advanced', 'web_search']);
    expect(bridgeNames).toEqual(sdkNames);
    expect(schemaNames).toEqual(sdkNames);
    for (const name of ['capability_search', 'run_capability', 'web_task', 'note_save']) {
      expect(sdkNames).not.toContain(name);
    }
    expect(result.vendorMcpServers).toEqual({});
    expect(result.withheldByOversight).toEqual([]);
  });

  it('without an allowlist registers everything as before, capability tools included', async () => {
    const result = await createToolGatewayMcpServer(baseInput({ stepOutputField: 'result', stepOutputKeys: [] }));
    const sdkNames = (result.mcpServer as unknown as { tools: Registered[] }).tools.map((t) => t.name);
    for (const name of ['capability_search', 'run_capability', 'web_search', 'web_fetch_advanced', 'web_task', 'note_save', 'record_step_output']) {
      expect(sdkNames).toContain(name);
    }
  });

  it('keeps record_step_output out of the allowlist when the step declares no outputField', () => {
    expect(webFallbackToolAllowlist(undefined).has('record_step_output')).toBe(false);
    expect(webFallbackToolAllowlist('x').has('record_step_output')).toBe(true);
    expect(webFallbackToolAllowlist('x').has('capability_search')).toBe(false);
    expect(webFallbackToolAllowlist('x').has('run_capability')).toBe(false);
  });

  it('every web tool on the fallback allowlist is classified read-only, and none drives a browser', () => {
    for (const name of CAPABILITY_WEB_FALLBACK_TOOLS) {
      expect(STANDARD_TOOL_EFFECTS[name]).toBe('read');
    }
    for (const name of ['web_task', 'run_browser_task', 'web_identity_connect', 'web_session_save', 'web_session_close', 'web_session_forget', 'capability_search', 'run_capability']) {
      expect(CAPABILITY_WEB_FALLBACK_TOOLS.has(name)).toBe(false);
    }
    // And every standard web tool that IS read-only is on it: the list is
    // the read-only web surface, not a hand-picked subset of it.
    const readOnlyWebTools = Object.entries(STANDARD_TOOL_EFFECTS)
      .filter(([name, effect]) => name.startsWith('web_') && effect === 'read' && !name.startsWith('web_session_'))
      .map(([name]) => name)
      .sort();
    expect([...CAPABILITY_WEB_FALLBACK_TOOLS].sort()).toEqual(readOnlyWebTools);
    // The window counts every tool the fallback may use: a need met on the
    // first turn by any of them is a need met.
    for (const name of CAPABILITY_WEB_FALLBACK_TOOLS) expect(WEB_OUTCOME_TOOLS.has(name)).toBe(true);
  });
});
