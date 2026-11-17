// Live external-agent tool enumeration.
//
// external_agents was the last MCP class serving a discovery-time snapshot.
// A vendor that shrinks its surface leaves the snapshot listing dozens of
// REST-shaped tools while the live server exposes two, so agents are offered
// tools that answer "Unknown tool" — and the pre-dispatch existence check
// validated against that same snapshot, so the calls passed and died at the
// far end.

const fetchVendorToolListMock = jest.fn();

jest.mock('../../agent-execution/adapter/vendor-mcp-enumerate', () => ({
  fetchVendorToolList: (...args: unknown[]) => fetchVendorToolListMock(...args),
  clearVendorMcpToolListCache: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../observability/runtime-extensions-metrics', () => ({
  external_agent_tool_list_degraded_total: { inc: jest.fn() },
}));

import {
  listExternalAgentTools,
  buildExternalAgentAuthHeaders,
  isUnknownToolError,
} from '../external-agent-tools';
import type { ExternalAgentConfig, ExternalAgentCredentials } from '../external-agent-handler';

const SNAPSHOT = [
  { name: 'get_simple_price', description: 'stale', inputSchema: { type: 'object' } },
  { name: 'get_coins_markets', description: 'stale', inputSchema: { type: 'object' } },
];
const LIVE = [
  { name: 'search_docs', description: 'live', inputSchema: { type: 'object' } },
  { name: 'execute', description: 'live', inputSchema: { type: 'object' } },
];

function config(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: 'ext-1',
    tenantId: 't1',
    name: 'CoinGecko',
    endpointUrl: 'https://mcp.api.coingecko.com/mcp',
    transportType: 'streamable-http',
    authType: 'none',
    collaborationMode: 'request_help',
    allowedInternalAgentIds: [],
    requestRules: [],
    toolClassifications: {},
    rawMcpTools: SNAPSHOT,
    status: 'connected',
    summary: null,
    collaborationHints: null,
    ...overrides,
  } as ExternalAgentConfig;
}

const noAuth: ExternalAgentCredentials = { authType: 'none' };

beforeEach(() => jest.clearAllMocks());

describe('listExternalAgentTools', () => {
  it('returns the LIVE list, not the stored snapshot', async () => {
    fetchVendorToolListMock.mockResolvedValueOnce(LIVE);
    const tools = await listExternalAgentTools(config(), noAuth);
    expect(tools.map(t => t.name)).toEqual(['search_docs', 'execute']);
  });

  it('falls back to the snapshot — never to [] — when the fetch fails', async () => {
    // Vendor MCP degrades to [] because it has no fallback. Doing that here
    // would strip an agent of every tool it owns on a transient blip.
    fetchVendorToolListMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const tools = await listExternalAgentTools(config(), noAuth);
    expect(tools.map(t => t.name)).toEqual(['get_simple_price', 'get_coins_markets']);
  });

  it('skips the live fetch for a2a transports, which have no tools/list', async () => {
    const tools = await listExternalAgentTools(
      config({ transportType: 'a2a' as ExternalAgentConfig['transportType'] }),
      noAuth,
    );
    expect(fetchVendorToolListMock).not.toHaveBeenCalled();
    expect(tools.map(t => t.name)).toEqual(['get_simple_price', 'get_coins_markets']);
  });

  it('passes the endpoint, auth headers and transport through to the fetch', async () => {
    fetchVendorToolListMock.mockResolvedValueOnce(LIVE);
    await listExternalAgentTools(
      config({ authType: 'bearer_token' }),
      { authType: 'bearer_token', bearerToken: 'tok' },
    );
    expect(fetchVendorToolListMock).toHaveBeenCalledWith(
      'https://mcp.api.coingecko.com/mcp',
      { Authorization: 'Bearer tok' },
      'streamable-http',
    );
  });

  it('carries the degraded marker across from the snapshot (INV-PB-008)', async () => {
    // `degraded` is computed by PB's discovery pipeline; a raw tools/list cannot
    // know it. Both catalog builders skip degraded tools, so losing the marker
    // would silently stop enforcing the invariant and let a tool with an
    // LLM-unacceptable schema reach the model.
    fetchVendorToolListMock.mockResolvedValueOnce(LIVE);
    const tools = await listExternalAgentTools(
      config({
        rawMcpTools: [
          { name: 'execute', description: 'x', inputSchema: {}, degraded: true },
        ] as unknown as ExternalAgentConfig['rawMcpTools'],
      }),
      noAuth,
    );
    expect(tools.find(t => t.name === 'execute')).toMatchObject({ degraded: true });
    expect(tools.find(t => t.name === 'search_docs')).not.toHaveProperty('degraded');
  });

  it('treats a newly added tool as acceptable — it has no verdict yet', async () => {
    fetchVendorToolListMock.mockResolvedValueOnce(LIVE);
    const tools = await listExternalAgentTools(config({ rawMcpTools: [] }), noAuth);
    expect(tools.every(t => !(t as { degraded?: boolean }).degraded)).toBe(true);
  });

  it('tolerates a missing snapshot', async () => {
    fetchVendorToolListMock.mockRejectedValueOnce(new Error('boom'));
    const tools = await listExternalAgentTools(
      config({ rawMcpTools: undefined as unknown as ExternalAgentConfig['rawMcpTools'] }),
      noAuth,
    );
    expect(tools).toEqual([]);
  });
});

describe('buildExternalAgentAuthHeaders', () => {
  it('maps each auth type the way the dispatch path does', () => {
    expect(buildExternalAgentAuthHeaders({ authType: 'none' })).toEqual({});
    expect(buildExternalAgentAuthHeaders({ authType: 'bearer_token', bearerToken: 'b' }))
      .toEqual({ Authorization: 'Bearer b' });
    expect(buildExternalAgentAuthHeaders({ authType: 'api_key', apiKey: 'k' }))
      .toEqual({ 'X-Service-Token': 'k' });
    expect(buildExternalAgentAuthHeaders({
      authType: 'custom_headers',
      customHeaders: [{ key: 'X-A', value: '1' }, { key: 'X-B', value: '2' }],
    })).toEqual({ 'X-A': '1', 'X-B': '2' });
  });
});

describe('isUnknownToolError', () => {
  it('recognises the shapes a server uses to say the tool is gone', () => {
    // The exact error CoinGecko returns.
    expect(isUnknownToolError({ error: 'MCP error -32603: Unknown tool: get_simple_price' })).toBe(true);
    expect(isUnknownToolError('{"code":-32601,"message":"Method not found"}')).toBe(true);
  });

  it('does not fire on unrelated errors', () => {
    expect(isUnknownToolError({ error: 'rate limited' })).toBe(false);
    expect(isUnknownToolError(undefined)).toBe(false);
  });
});
