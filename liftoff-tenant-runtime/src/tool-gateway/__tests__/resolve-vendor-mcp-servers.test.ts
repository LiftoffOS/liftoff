// Locks in the GitHub / Stripe / Notion vendor-MCP wiring that Phase 2b
// silently deleted. Each case injects a stub ConnectorService client and
// asserts the outbound SDK config shape + correct handling of the boundary
// cases (non-vendor, missing config, missing token, RPC failure).

// The Claude Agent SDK is an ESM-only package that ts-jest can't transform;
// we mock the two symbols mcp-server.ts imports from it so the module graph
// loads cleanly in jest (matches the mock pattern in mcp-server.test.ts).
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name, handler })),
  createSdkMcpServer: jest.fn((opts: { name?: string; tools: unknown[] }) => ({ type: 'sdk', name: opts.name ?? 'test', tools: opts.tools })),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// These modules are pulled in at mcp-server.ts top-level — mocked away so
// the file imports cleanly without touching a DB or the connector registry
// for this isolated test of `resolveVendorMcpServers`.
jest.mock('../../connectors/tool-schema-cache', () => ({ getToolSchemas: jest.fn(() => []) }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../tools/standard-tools', () => ({ STANDARD_TOOLS: [] }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn() }));

const mockGetConnectorServiceClient = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => mockGetConnectorServiceClient(),
}));

import { resolveVendorMcpServers } from '../mcp-server';
import { McpTransport } from '@liftoffos/proto-gen/dist/liftoff/connector/v1/connector_service_pb';

// Stub ConnectorService client with only the methods under test.
function stubClient(responses: {
  getMcpServerConfig: jest.Mock;
  getCredentials: jest.Mock;
}) {
  mockGetConnectorServiceClient.mockReturnValue(responses);
  return responses;
}

function githubIntegration(id = '7d07a896-89f6-4f5c-8a26-1186c9fcf270') {
  return { id, type: 'github' };
}

describe('resolveVendorMcpServers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns an empty map when the caller has no integrations', async () => {
    const out = await resolveVendorMcpServers({ tenantId: 't1', integrations: [] });
    expect(out).toEqual({});
    expect(mockGetConnectorServiceClient).not.toHaveBeenCalled();
  });

  it('wires a vendor-hosted GitHub MCP server end-to-end (streamable-http + Bearer)', async () => {
    stubClient({
      getMcpServerConfig: jest.fn().mockResolvedValue({
        exists: true,
        isVendorHosted: true,
        mcpUrl: 'https://api.githubcopilot.com/mcp/',
        transport: McpTransport.STREAMABLE_HTTP,
      }),
      getCredentials: jest.fn().mockResolvedValue({
        oauth: { accessToken: 'gho_fake_token' },
      }),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
      integrations: [githubIntegration()],
    });

    // Keyed by `${type}-${first 8 hex of UUID (no dashes)}` so two GitHub
    // instances don't collide in the SDK's mcpServers map.
    expect(Object.keys(out)).toEqual(['github-7d07a896']);
    expect(out['github-7d07a896']).toEqual({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer gho_fake_token' },
    });
  });

  it('maps SSE transport to the SDK\'s `sse` type', async () => {
    stubClient({
      getMcpServerConfig: jest.fn().mockResolvedValue({
        exists: true,
        isVendorHosted: true,
        mcpUrl: 'https://mcp.stripe.com',
        transport: McpTransport.SSE,
      }),
      getCredentials: jest.fn().mockResolvedValue({
        oauth: { accessToken: 'sk_live_fake' },
      }),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', type: 'stripe' }],
    });
    expect(out['stripe-aaaaaaaa'].type).toBe('sse');
  });

  it('skips connectors whose type has no MCP config (exists=false)', async () => {
    stubClient({
      getMcpServerConfig: jest.fn().mockResolvedValue({
        exists: false,
        isVendorHosted: false,
        mcpUrl: '',
        transport: McpTransport.UNSPECIFIED,
      }),
      getCredentials: jest.fn(),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [{ id: '00000000-0000-0000-0000-000000000001', type: 'salesforce' }],
    });
    expect(out).toEqual({});
  });

  it('skips self-hosted MCP (isVendorHosted=false) so Execute RPC handles dispatch', async () => {
    stubClient({
      getMcpServerConfig: jest.fn().mockResolvedValue({
        exists: true,
        isVendorHosted: false,
        mcpUrl: 'https://sidecar.internal/google/mail',
        transport: McpTransport.STREAMABLE_HTTP,
      }),
      getCredentials: jest.fn(),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [{ id: '00000000-0000-0000-0000-000000000002', type: 'google_mail' }],
    });
    expect(out).toEqual({});
  });

  it('skips the integration and logs when the OAuth token is missing', async () => {
    stubClient({
      getMcpServerConfig: jest.fn().mockResolvedValue({
        exists: true,
        isVendorHosted: true,
        mcpUrl: 'https://api.githubcopilot.com/mcp/',
        transport: McpTransport.STREAMABLE_HTTP,
      }),
      getCredentials: jest.fn().mockResolvedValue({ oauth: undefined }),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [githubIntegration()],
    });
    expect(out).toEqual({});
  });

  // An api_key vendor-hosted MCP (sentry, databricks, tolt) authenticates with
  // the key as the Bearer. The credential arrives in `apiKey`, never in
  // `oauth`, so reading only the OAuth field skipped every such connector with
  // vendor_mcp_missing_oauth_token and the agent never saw its tools.
  it('uses an api_key credential as the Bearer for a vendor-hosted MCP (tolt)', async () => {
    stubClient({
      getMcpServerConfig: jest.fn().mockResolvedValue({
        exists: true,
        isVendorHosted: true,
        mcpUrl: 'https://mcp.tolt.com/',
        transport: McpTransport.STREAMABLE_HTTP,
      }),
      getCredentials: jest.fn().mockResolvedValue({
        oauth: undefined,
        apiKey: { apiKey: 'tolt_dashboard_key' },
      }),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', type: 'tolt' }],
    });
    expect(out).toEqual({
      'tolt-aaaaaaaa': {
        type: 'http',
        url: 'https://mcp.tolt.com/',
        headers: { Authorization: 'Bearer tolt_dashboard_key' },
      },
    });
  });

  it('skips and logs vendor_mcp_missing_oauth_token when neither field carries a token', async () => {
    const { logger } = jest.requireMock('../../infrastructure/logging') as { logger: { warn: jest.Mock } };
    stubClient({
      getMcpServerConfig: jest.fn().mockResolvedValue({
        exists: true,
        isVendorHosted: true,
        mcpUrl: 'https://mcp.tolt.com/',
        transport: McpTransport.STREAMABLE_HTTP,
      }),
      getCredentials: jest.fn().mockResolvedValue({ oauth: undefined, apiKey: { apiKey: '' } }),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', type: 'tolt' }],
    });
    expect(out).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorType: 'tolt' }),
      'vendor_mcp_missing_oauth_token',
    );
  });

  it('isolates failures — one bad integration does not drop the others', async () => {
    const getMcpServerConfig = jest.fn()
      .mockRejectedValueOnce(new Error('connector-service unreachable'))
      .mockResolvedValueOnce({
        exists: true,
        isVendorHosted: true,
        mcpUrl: 'https://api.githubcopilot.com/mcp/',
        transport: McpTransport.STREAMABLE_HTTP,
      });
    const getCredentials = jest.fn()
      .mockResolvedValueOnce({ oauth: { accessToken: 't2' } });

    stubClient({ getMcpServerConfig, getCredentials });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [
        { id: '00000000-0000-0000-0000-000000000001', type: 'notion' },
        { id: '7d07a896-89f6-4f5c-8a26-1186c9fcf270', type: 'github' },
      ],
    });

    expect(Object.keys(out)).toEqual(['github-7d07a896']);
  });

  it('returns empty when the ConnectorService client cannot be constructed', async () => {
    mockGetConnectorServiceClient.mockImplementation(() => {
      throw new Error('CONNECTOR_SERVICE_URL is not set');
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [githubIntegration()],
    });
    expect(out).toEqual({});
  });

  it('skips external_agent integrations without calling connector-service', async () => {
    // external_agent integrations have their own handler (external-agent-handler.ts)
    // and are wired separately through externalAgents[]. Calling connector-service
    // for them produces a misleading vendor_mcp_resolve_failed warning.
    const getMcpServerConfig = jest.fn();
    stubClient({
      getMcpServerConfig,
      getCredentials: jest.fn(),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [{ id: 'e8a6ccbb-75d1-43b2-865f-e3ac5be25d8f', type: 'external_agent' }],
    });
    expect(out).toEqual({});
    expect(getMcpServerConfig).not.toHaveBeenCalled();
  });

  it('skips internal_agent integrations without calling connector-service', async () => {
    const getMcpServerConfig = jest.fn();
    stubClient({
      getMcpServerConfig,
      getCredentials: jest.fn(),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [{ id: '00000000-0000-0000-0000-000000000099', type: 'internal_agent' }],
    });
    expect(out).toEqual({});
    expect(getMcpServerConfig).not.toHaveBeenCalled();
  });

  it('still resolves connector integrations when mixed with external_agent entries', async () => {
    const getMcpServerConfig = jest.fn().mockResolvedValue({
      exists: true,
      isVendorHosted: true,
      mcpUrl: 'https://api.githubcopilot.com/mcp/',
      transport: McpTransport.STREAMABLE_HTTP,
    });
    stubClient({
      getMcpServerConfig,
      getCredentials: jest.fn().mockResolvedValue({ oauth: { accessToken: 'tok' } }),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [
        { id: 'e8a6ccbb-75d1-43b2-865f-e3ac5be25d8f', type: 'external_agent' },
        githubIntegration(),
      ],
    });

    expect(Object.keys(out)).toEqual(['github-7d07a896']);
    expect(getMcpServerConfig).toHaveBeenCalledTimes(1); // not called for the external_agent
  });

  it('skips STDIO transport (not a valid remote transport for the SDK)', async () => {
    stubClient({
      getMcpServerConfig: jest.fn().mockResolvedValue({
        exists: true,
        isVendorHosted: true,
        mcpUrl: 'stdio://hypothetical',
        transport: McpTransport.STDIO,
      }),
      getCredentials: jest.fn(),
    });

    const out = await resolveVendorMcpServers({
      tenantId: 't1',
      integrations: [{ id: '00000000-0000-0000-0000-000000000003', type: 'hypothetical' }],
    });
    expect(out).toEqual({});
  });

  // ── Composio cutover-completion (C5) ──────────────────────────────────
  //
  // The composio direct-dispatch branch (vendorMcpServers entry built from
  // composioUserId) was REMOVED. composio_managed connectors now dispatch
  // in-process via composio.tools.execute() — see tool-gateway/composio-
  // dispatcher.ts and tool-gateway/__tests__/composio-dispatcher.test.ts.
  // connector-service's getMcpServerConfig returns exists=false for
  // composio_managed types, so resolveVendorMcpServers naturally produces
  // no entry for them. The legacy Bearer-path tests below stay green
  // because the composio_managed branch in mcp-server-registry.ts is also
  // removed in C5.

  it('post-C5 composio_managed: produces no vendorMcpServers entry (exists=false from connector-service)', async () => {
    const getCredentials = jest.fn();
    stubClient({
      getMcpServerConfig: jest.fn().mockResolvedValue({
        // Post-C5: connector-service mcp-server-registry.ts composio_managed
        // branch was deleted, so getMcpServerConfig returns exists=false
        // for these connector types.
        exists: false,
      }),
      getCredentials,
    });

    const out = await resolveVendorMcpServers({
      tenantId: 'tenant_abc',
      integrations: [{ id: '7d07a896-89f6-4f5c-8a26-1186c9fcf270', type: 'gong' }],
    });
    expect(out).toEqual({});
    // composio dispatch is in-process via composio.tools.execute(); no
    // credential fetch is needed because Composio holds the tokens.
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it('still attaches Bearer for legacy vendor-hosted entries (requiresBearerAuth=true)', async () => {
      // Old behavior must survive — Risk #5 in the plan: an old connector-service
      // build that sets requires_bearer_auth=true must keep getting Bearer headers.
      stubClient({
        getMcpServerConfig: jest.fn().mockResolvedValue({
          exists: true,
          isVendorHosted: true,
          mcpUrl: 'https://api.githubcopilot.com/mcp/',
          transport: McpTransport.STREAMABLE_HTTP,
          composioUserId: '',
          requiresBearerAuth: true,
        }),
        getCredentials: jest.fn().mockResolvedValue({ oauth: { accessToken: 'gho_x' } }),
      });

      const out = await resolveVendorMcpServers({
        tenantId: 'tenant_abc',
        integrations: [{ id: '7d07a896-89f6-4f5c-8a26-1186c9fcf270', type: 'github' }],
      });
    const key = Object.keys(out)[0];
    expect(out[key].headers).toEqual({ Authorization: 'Bearer gho_x' });
  });
});
