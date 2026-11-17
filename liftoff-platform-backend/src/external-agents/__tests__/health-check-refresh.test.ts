// The scheduled sweep now also keeps the tool snapshot honest.
//
// It used to call client.ping() only — "for health checks, we skip auth since
// we're just pinging" — so an authenticated server was probed anonymously and
// a vendor that changed its tool surface left raw_mcp_tools wrong forever.
// discover() is the same round-trip class as ping and gives us the current
// list, but the LLM-backed capability analyzer is expensive, so it only runs
// when a cheap fingerprint actually changed.

const discoverMock = jest.fn();
const pingMock = jest.fn();
const rediscoverMock = jest.fn(async () => ({ agent: {}, requiresReview: false, changes: [] }));
const getCredentialsForDiscoveryMock = jest.fn(async () => ({}));
const updateStatusMock = jest.fn();
const discoverWithProgressMock = jest.fn();
const adminQuery = jest.fn(async () => ({ rows: [] }));

jest.mock('../../mcp/client', () => ({
  MCPClient: class {
    constructor(public cfg: unknown) {}
    ping = (...a: unknown[]) => pingMock(...a);
    discover = (...a: unknown[]) => discoverMock(...a);
  },
}));
jest.mock('../service', () => ({
  externalAgentService: {
    rediscover: (...a: unknown[]) => rediscoverMock(...(a as [])),
    getCredentialsForDiscovery: (...a: unknown[]) => getCredentialsForDiscoveryMock(...(a as [])),
    updateStatus: (...a: unknown[]) => updateStatusMock(...a),
  },
}));
jest.mock('../discover-adapter', () => ({
  discoverExternalAgentWithProgress: (...a: unknown[]) => discoverWithProgressMock(...a),
}));
jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn() },
  withAdminScope: (_o: unknown, fn: (c: unknown) => unknown) => fn({ query: adminQuery }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../events/publisher', () => ({ publishEvent: jest.fn() }));

import { checkSingleAgentHealth } from '../health-check-service';

const TOOLS = [
  { name: 'search_docs', description: 'd1', inputSchema: { type: 'object' } },
  { name: 'execute', description: 'd2', inputSchema: { type: 'object' } },
];

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ext-1',
    tenant_id: 't1',
    endpoint_url: 'https://mcp.api.coingecko.com/mcp',
    auth_type: 'none',
    transport_type: 'streamable-http',
    status: 'connected',
    raw_mcp_tools: TOOLS,
    ...overrides,
  };
}

/** checkSingleAgentHealth loads the row itself; stub that read. */
function primeAgent(row: Record<string, unknown>) {
  adminQuery.mockImplementation(async (sql: string) =>
    /SELECT \* FROM external_agents WHERE id/i.test(sql) ? { rows: [row] } : { rows: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  adminQuery.mockResolvedValue({ rows: [] });
  discoverWithProgressMock.mockResolvedValue({
    capabilities: [], resources: [], toolClassifications: {},
    rawMcpTools: TOOLS, rawMcpResources: [], transportType: 'streamable-http',
    summary: 's', collaborationHints: 'c',
  });
});

describe('health sweep tool-surface refresh', () => {
  it('does NOT run the discovery pipeline when the tool surface is unchanged', async () => {
    primeAgent(agentRow());
    discoverMock.mockResolvedValue({ tools: TOOLS });

    await checkSingleAgentHealth('ext-1', 't1');

    expect(discoverMock).toHaveBeenCalled();
    // The expensive LLM-backed path must stay untouched on a no-op sweep.
    expect(discoverWithProgressMock).not.toHaveBeenCalled();
    expect(rediscoverMock).not.toHaveBeenCalled();
  });

  it('refreshes with reviewPolicy=live when the surface changed', async () => {
    // The CoinGecko case: stored 49-ish, live 2.
    primeAgent(agentRow({
      raw_mcp_tools: [{ name: 'get_simple_price', description: 'x', inputSchema: {} }],
    }));
    discoverMock.mockResolvedValue({ tools: TOOLS });

    await checkSingleAgentHealth('ext-1', 't1');

    expect(rediscoverMock).toHaveBeenCalledTimes(1);
    const [, , , opts] = rediscoverMock.mock.calls[0] as unknown[];
    // 'live' keeps the agent connected. An unattended sweep must not take an
    // integration out of service because a vendor renamed a tool; the manual
    // route keeps its pending_review gate.
    expect(opts).toEqual({ reviewPolicy: 'live' });
  });

  it('hands rediscover the effect classes and versions the discovery returned, beside the categories', async () => {
    // The cache upsert writes what it is handed: a refresh that dropped these
    // would null the class every tool already had.
    primeAgent(agentRow({
      raw_mcp_tools: [{ name: 'get_simple_price', description: 'x', inputSchema: {} }],
    }));
    discoverMock.mockResolvedValue({ tools: TOOLS });
    discoverWithProgressMock.mockResolvedValueOnce({
      capabilities: [], resources: [], toolClassifications: { get_simple_price: [] },
      toolEffectClasses: { get_simple_price: 'read' }, toolClassificationVersions: { get_simple_price: 1 },
      rawMcpTools: TOOLS, rawMcpResources: [], transportType: 'streamable-http', summary: 's', collaborationHints: 'h',
    });

    await checkSingleAgentHealth('ext-1', 't1');

    const [, , result] = rediscoverMock.mock.calls[0] as unknown[];
    expect(result).toMatchObject({
      toolClassifications: { get_simple_price: [] },
      toolEffectClasses: { get_simple_price: 'read' },
      toolClassificationVersions: { get_simple_price: 1 },
    });
  });

  it('detects a description-only change, not just added/removed names', async () => {
    primeAgent(agentRow({
      raw_mcp_tools: TOOLS.map(t => ({ ...t, description: 'CHANGED' })),
    }));
    discoverMock.mockResolvedValue({ tools: TOOLS });

    await checkSingleAgentHealth('ext-1', 't1');
    expect(rediscoverMock).toHaveBeenCalledTimes(1);
  });

  it('is order-insensitive — a reordered list is not a change', async () => {
    primeAgent(agentRow({ raw_mcp_tools: [...TOOLS].reverse() }));
    discoverMock.mockResolvedValue({ tools: TOOLS });

    await checkSingleAgentHealth('ext-1', 't1');
    expect(rediscoverMock).not.toHaveBeenCalled();
  });

  it('keeps ping-only semantics for a2a, which has no tools/list', async () => {
    primeAgent(agentRow({ transport_type: 'a2a' }));

    await checkSingleAgentHealth('ext-1', 't1');

    expect(pingMock).toHaveBeenCalled();
    expect(discoverMock).not.toHaveBeenCalled();
    expect(rediscoverMock).not.toHaveBeenCalled();
  });

  it('resolves credentials instead of probing anonymously', async () => {
    primeAgent(agentRow({ auth_type: 'bearer_token' }));
    discoverMock.mockResolvedValue({ tools: TOOLS });

    await checkSingleAgentHealth('ext-1', 't1');

    expect(getCredentialsForDiscoveryMock).toHaveBeenCalledWith('ext-1', 't1', 'bearer_token');
  });

  it('treats a refresh failure as non-fatal — the agent is still reachable', async () => {
    primeAgent(agentRow({ raw_mcp_tools: [] }));
    discoverMock.mockResolvedValue({ tools: TOOLS });
    discoverWithProgressMock.mockRejectedValue(new Error('analyzer down'));

    await expect(checkSingleAgentHealth('ext-1', 't1')).resolves.not.toThrow();
    expect(updateStatusMock).not.toHaveBeenCalledWith('ext-1', 't1', 'error');
  });
});
