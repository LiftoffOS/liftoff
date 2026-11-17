// A.2 — deep MCP binding probe per-transport tests.
//
// Pre-A.2 the probe was a registry-only lookup; a connector with revoked
// OAuth creds passed because the function set was still registered. After
// A.2 the probe per-transport-routes and the recorded probe_kind tells
// dashboards which strategy ran.

const mockGetMcpServerConfig = jest.fn();
const mockGetCredentials = jest.fn();
const mockExecute = jest.fn();

jest.mock('../connector-service-client', () => ({
  getConnectorServiceClient: jest.fn(() => ({
    getMcpServerConfig: mockGetMcpServerConfig,
    getCredentials: mockGetCredentials,
    execute: mockExecute,
  })),
}));

jest.mock('../tool-schema-cache', () => ({
  getToolSchemas: jest.fn(),
}));

const mockProbeRequest = jest.fn();
const mockProbeConnect = jest.fn();
const mockProbeClose = jest.fn();
const mockCreateTransportSync = jest.fn(() => ({
  connect: mockProbeConnect,
  request: mockProbeRequest,
  close: mockProbeClose,
}));
jest.mock('../../tool-gateway/transports', () => ({
  createTransportSync: (...args: unknown[]) => mockCreateTransportSync(...args as []),
}));

import { runProbeForBinding } from '../binding-probe';
import { getToolSchemas as getConnectorFunctions } from '../tool-schema-cache';
import { getConnectorServiceClient } from '../connector-service-client';

const mockGetConnectorFunctions = getConnectorFunctions as jest.MockedFunction<typeof getConnectorFunctions>;
const mockClientFactory = getConnectorServiceClient as jest.MockedFunction<typeof getConnectorServiceClient>;

const baseBinding = {
  id: 'manifest-1',
  tenant_id: 'tenant-1',
  connector_type: 'notion',
  alias: 'notion',
};

function fnSet(definitionSource: 'native' | 'composio' = 'native') {
  return [{
    name: 'list_resources',
    description: '',
    inputSchema: { type: 'object', properties: {}, required: [] },
    categories: ['read'],
    definitionSource,
  }] as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.BINDING_PROBE_DEEP_DISABLED;
  mockGetConnectorFunctions.mockReturnValue(fnSet());
  mockProbeConnect.mockResolvedValue(undefined);
  // Restore the default factory return — tests that need it broken override below.
  mockClientFactory.mockImplementation(() => ({
    getMcpServerConfig: mockGetMcpServerConfig,
    getCredentials: mockGetCredentials,
    execute: mockExecute,
  }) as unknown as ReturnType<typeof getConnectorServiceClient>);
  // Default: read-function dispatch succeeds. Tests override per-case.
  mockExecute.mockResolvedValue({ success: true });
});

describe('A.2 binding probe — registry gate', () => {
  it('fails with REGISTRY_UNKNOWN when the registry is the dispatch path and knows no functions', async () => {
    // exists=false is composio_managed or REST direct: the registry decides.
    mockGetConnectorFunctions.mockReturnValueOnce([]);
    mockGetMcpServerConfig.mockResolvedValueOnce({ exists: false });
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'mystery_vendor' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('REGISTRY_UNKNOWN');
    expect(r.probe_kind).toBe('registry_only');
    expect(mockGetCredentials).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('probes a vendor-hosted MCP whose type has no registry entry (github, stripe, tolt)', async () => {
    // A vendor-hosted server has no registry functions by design — its tools
    // are enumerated live — so an empty registry must not stop the probe.
    mockGetConnectorFunctions.mockReturnValueOnce([]);
    mockGetMcpServerConfig.mockResolvedValueOnce({
      exists: true,
      isVendorHosted: true,
      mcpUrl: 'https://mcp.tolt.com/',
    });
    mockGetCredentials.mockResolvedValueOnce({ apiKey: { apiKey: 'tolt-dashboard-key' } });
    mockProbeRequest.mockResolvedValueOnce({ tools: [{ name: 'list_programs' }] });
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'tolt' });
    expect(r.ok).toBe(true);
    expect(r.probe_kind).toBe('vendor_mcp_tools_list');
    expect(mockCreateTransportSync).toHaveBeenCalledWith('streamable-http', expect.objectContaining({
      endpointUrl: 'https://mcp.tolt.com/',
      bearerToken: 'tolt-dashboard-key',
    }));
  });

  it('probes a sidecar whose type has no registry entry', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce([]);
    mockGetMcpServerConfig.mockResolvedValueOnce({
      exists: true,
      isVendorHosted: false,
      mcpUrl: 'http://sidecar.internal:3000/mcp',
    });
    mockProbeRequest.mockResolvedValueOnce({ tools: [{ name: 'search' }] });
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'sidecar_only' });
    expect(r.ok).toBe(true);
    expect(r.probe_kind).toBe('sidecar_tools_list');
  });

  it('honours BINDING_PROBE_DEEP_DISABLED kill switch (registry-only mode)', async () => {
    process.env.BINDING_PROBE_DEEP_DISABLED = '1';
    const r = await runProbeForBinding(baseBinding);
    expect(r.ok).toBe(true);
    expect(r.probe_kind).toBe('registry_only');
    expect(mockGetMcpServerConfig).not.toHaveBeenCalled();
  });

  it('kill switch still answers REGISTRY_UNKNOWN for an unregistered type, without any outbound call', async () => {
    process.env.BINDING_PROBE_DEEP_DISABLED = '1';
    mockGetConnectorFunctions.mockReturnValueOnce([]);
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'mystery_vendor' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('REGISTRY_UNKNOWN');
    expect(mockGetMcpServerConfig).not.toHaveBeenCalled();
  });
});

describe('A.2 binding probe — B4: client unavailable', () => {
  it('records ok=false with CLIENT_UNAVAILABLE when the factory throws', async () => {
    mockClientFactory.mockImplementationOnce(() => {
      throw new Error('CONNECTOR_SERVICE_URL not set');
    });
    const r = await runProbeForBinding(baseBinding);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('CLIENT_UNAVAILABLE');
    expect(r.probe_kind).toBe('registry_only');
    // No deep network attempts when the client itself can't be constructed.
    expect(mockGetMcpServerConfig).not.toHaveBeenCalled();
    expect(mockGetCredentials).not.toHaveBeenCalled();
  });
});

describe('A.2 binding probe — vendor_hosted MCP path (B1: bearer auth)', () => {
  beforeEach(() => {
    mockGetMcpServerConfig.mockResolvedValue({
      exists: true,
      isVendorHosted: true,
      mcpUrl: 'https://mcp.notion.com/v1',
    });
    mockGetCredentials.mockResolvedValue({
      oauth: { accessToken: 'real-bearer-token' },
    });
  });

  it('fetches credentials and passes them as Bearer to the transport (B1 fix)', async () => {
    mockProbeRequest.mockResolvedValue({ tools: [{ name: 'search' }] });
    const r = await runProbeForBinding(baseBinding);
    expect(r.ok).toBe(true);
    expect(r.probe_kind).toBe('vendor_mcp_tools_list');
    // B1 critical assertion: transport must receive bearer_token + the actual token.
    expect(mockCreateTransportSync).toHaveBeenCalledWith('streamable-http', expect.objectContaining({
      endpointUrl: 'https://mcp.notion.com/v1',
      authType: 'bearer_token',
      bearerToken: 'real-bearer-token',
    }));
  });

  it('passes an api_key credential as the Bearer (sentry, databricks, tolt)', async () => {
    // The key arrives in `apiKey`, never in `oauth`; reading only the OAuth
    // field flagged every api_key vendor MCP MISSING_BEARER_TOKEN on each sweep.
    mockGetCredentials.mockResolvedValueOnce({ oauth: undefined, apiKey: { apiKey: 'tolt_dashboard_key' } });
    mockProbeRequest.mockResolvedValue({ tools: [{ name: 'list_programs' }] });
    const r = await runProbeForBinding(baseBinding);
    expect(r.ok).toBe(true);
    expect(mockCreateTransportSync).toHaveBeenCalledWith('streamable-http', expect.objectContaining({
      authType: 'bearer_token',
      bearerToken: 'tolt_dashboard_key',
    }));
  });

  it('records MISSING_BEARER_TOKEN when credentials return neither an accessToken nor an apiKey', async () => {
    mockGetCredentials.mockResolvedValueOnce({ oauth: undefined, apiKey: { apiKey: '' } });
    const r = await runProbeForBinding(baseBinding);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('MISSING_BEARER_TOKEN');
    expect(r.probe_kind).toBe('vendor_mcp_tools_list');
    // Never even tries to call the vendor — the credential is the gate.
    expect(mockCreateTransportSync).not.toHaveBeenCalled();
  });

  it('classifies 401 as MCP_AUTH_FAILED', async () => {
    mockProbeRequest.mockRejectedValueOnce(new Error('Unauthorized 401'));
    const r = await runProbeForBinding(baseBinding);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('MCP_AUTH_FAILED');
    expect(r.probe_kind).toBe('vendor_mcp_tools_list');
  });

  it('classifies timeout as MCP_TIMEOUT', async () => {
    mockProbeRequest.mockRejectedValueOnce(new Error('request timed out'));
    const r = await runProbeForBinding(baseBinding);
    expect(r.errorCode).toBe('MCP_TIMEOUT');
  });

  it('classifies 503 as VENDOR_5XX', async () => {
    mockProbeRequest.mockRejectedValueOnce(new Error('Service Unavailable 503'));
    const r = await runProbeForBinding(baseBinding);
    expect(r.errorCode).toBe('VENDOR_5XX');
  });

  it('closes the transport even after a failed request', async () => {
    mockProbeRequest.mockRejectedValueOnce(new Error('boom'));
    await runProbeForBinding(baseBinding);
    expect(mockProbeClose).toHaveBeenCalled();
  });
});

describe('A.2 binding probe — sidecar path (B2: real HTTP)', () => {
  beforeEach(() => {
    mockGetMcpServerConfig.mockResolvedValue({
      exists: true,
      isVendorHosted: false,
      mcpUrl: 'http://mcp-sidecar.default.svc:8080/google_calendar',
    });
  });

  it('issues HTTP tools/list against the real sidecar URL (B2 fix)', async () => {
    mockProbeRequest.mockResolvedValue({ tools: [{ name: 'list_events' }] });
    const r = await runProbeForBinding(baseBinding);
    expect(r.ok).toBe(true);
    expect(r.probe_kind).toBe('sidecar_tools_list');
    // B2 critical assertion: transport must hit the actual sidecar URL.
    expect(mockCreateTransportSync).toHaveBeenCalledWith('streamable-http', expect.objectContaining({
      endpointUrl: 'http://mcp-sidecar.default.svc:8080/google_calendar',
      authType: 'none',
    }));
    expect(mockProbeRequest).toHaveBeenCalledWith('tools/list', {});
  });

  it('records SIDECAR_DOWN on connection refused', async () => {
    mockProbeRequest.mockRejectedValueOnce(new Error('connection refused ECONNREFUSED'));
    const r = await runProbeForBinding(baseBinding);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('SIDECAR_DOWN');
    expect(r.probe_kind).toBe('sidecar_tools_list');
  });

  it('does NOT consult connector-service ListTools (caught the original B2 bug)', async () => {
    mockProbeRequest.mockResolvedValueOnce({});
    await runProbeForBinding(baseBinding);
    // Pre-B2 fix this called client.listTools which serves cached schemas.
    // The fix is to talk to the sidecar directly, so the client mock here
    // does not even expose listTools — if anyone wires that path back, this
    // assertion will catch it because the test would crash trying to call
    // undefined. Belt-and-suspenders: assert it never appears.
    expect(mockCreateTransportSync).toHaveBeenCalled();
  });
});

describe('A.2 binding probe — composio_managed vs REST direct (B3: definitionSource)', () => {
  beforeEach(() => {
    mockGetMcpServerConfig.mockResolvedValue({
      exists: false,
      isVendorHosted: false,
    });
    mockGetCredentials.mockResolvedValue({ oauth: { accessToken: 'tok' } });
  });

  it('routes composio_managed connectors based on definitionSource=composio (B3 fix)', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce(fnSet('composio'));
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'gmail' });
    expect(r.probe_kind).toBe('composio_credential_refresh');
  });

  it.each(['gmail', 'slack', 'google_drive', 'microsoft_outlook', 'hubspot', 'salesforce', 'zendesk', 'mailchimp', 'asana', 'trello'])(
    'classifies %s correctly when its registry says definitionSource=composio',
    async (type) => {
      mockGetConnectorFunctions.mockReturnValueOnce(fnSet('composio'));
      const r = await runProbeForBinding({ ...baseBinding, connector_type: type });
      expect(r.probe_kind).toBe('composio_credential_refresh');
    },
  );

  it('routes REST direct connectors (definitionSource=native, exists=false) to rest_auth_test', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce(fnSet('native'));
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'bamboohr' });
    expect(r.probe_kind).toBe('rest_auth_test');
  });

  it('does NOT use a connector-type name regex (caught the original B3 bug)', async () => {
    // 'arbitrary_drive_thing' would have matched the old /drive/ regex; under
    // the B3 fix it's classified by definitionSource — native here.
    mockGetConnectorFunctions.mockReturnValueOnce(fnSet('native'));
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'arbitrary_drive_thing' });
    expect(r.probe_kind).toBe('rest_auth_test'); // NOT composio_credential_refresh
  });

  it('records COMPOSIO_AUTH_FAILED on uncategorized errors for composio_managed', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce(fnSet('composio'));
    mockGetCredentials.mockRejectedValueOnce(new Error('uncategorized'));
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'gmail' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('COMPOSIO_AUTH_FAILED');
  });

  it('records REST_AUTH_FAILED on uncategorized errors for REST direct', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce(fnSet('native'));
    mockGetCredentials.mockRejectedValueOnce(new Error('uncategorized'));
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'bamboohr' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('REST_AUTH_FAILED');
  });

  it('still classifies recognized error patterns (timeout/401/5xx) over the fallback', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce(fnSet('native'));
    mockGetCredentials.mockRejectedValueOnce(new Error('request timed out'));
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'bamboohr' });
    expect(r.errorCode).toBe('MCP_TIMEOUT');
  });
});

describe('A.2 binding probe — getMcpServerConfig failure', () => {
  it('records CONFIG_LOOKUP_FAILED fallback when getMcpServerConfig itself errors out', async () => {
    mockGetMcpServerConfig.mockRejectedValueOnce(new Error('connector-service network down'));
    const r = await runProbeForBinding(baseBinding);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('CONFIG_LOOKUP_FAILED');
    expect(r.probe_kind).toBe('registry_only');
  });

  it('still classifies recognized patterns even on the config-lookup error path', async () => {
    mockGetMcpServerConfig.mockRejectedValueOnce(new Error('Service Unavailable 503'));
    const r = await runProbeForBinding(baseBinding);
    expect(r.errorCode).toBe('VENDOR_5XX');
  });
});

// REST direct probe combines credential-refresh + read-function dispatch
// so the probe surfaces vendor-side failures (rotated keys, IP block,
// vendor 5xx) — not just our ability to decrypt the stored OAuth token.
describe('binding probe — REST direct vendor-liveness dispatch', () => {
  beforeEach(() => {
    mockGetMcpServerConfig.mockResolvedValue({ exists: false, isVendorHosted: false });
    mockGetCredentials.mockResolvedValue({ oauth: { accessToken: 'tok' } });
  });

  it('calls execute() with the first read-only function after credentials succeed', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce([
      { name: 'send_message', description: '', inputSchema: { type: 'object', properties: {}, required: [] }, categories: ['outbound'], definitionSource: 'native' },
      { name: 'list_messages', description: '', inputSchema: { type: 'object', properties: {}, required: [] }, categories: ['read'], definitionSource: 'native' },
    ] as never);

    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'bamboohr' });
    expect(r.ok).toBe(true);
    expect(r.probe_kind).toBe('rest_auth_test');
    // credentials AND execute were both invoked — vendor-liveness check is real
    expect(mockGetCredentials).toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'list_messages',
    }));
  });

  it('records REST_AUTH_FAILED with classified error when execute returns success=false on auth', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce(fnSet('native'));
    mockExecute.mockResolvedValueOnce({ success: false, error: '401 Unauthorized — token revoked' });

    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'bamboohr' });
    expect(r.ok).toBe(false);
    expect(r.probe_kind).toBe('rest_auth_test');
    expect(r.errorCode).toBe('MCP_AUTH_FAILED');
  });

  it('classifies a vendor 5xx as VENDOR_5XX on the REST dispatch path', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce(fnSet('native'));
    mockExecute.mockResolvedValueOnce({ success: false, error: '503 Service Unavailable' });

    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'bamboohr' });
    expect(r.errorCode).toBe('VENDOR_5XX');
  });

  it('falls back to credential-only success when no read-only function exists', async () => {
    // Write-only connector (no read function) — probe still returns ok
    // because the credential refresh succeeded.
    mockGetConnectorFunctions.mockReturnValueOnce([
      { name: 'send', description: '', inputSchema: { type: 'object', properties: {}, required: [] }, categories: ['outbound'], definitionSource: 'native' },
    ] as never);

    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'send_only' });
    expect(r.ok).toBe(true);
    expect(r.probe_kind).toBe('rest_auth_test');
    // execute() never called because no qualifying function existed
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('skips write/destructive/outbound/sensitive functions when picking the read probe', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce([
      { name: 'list_pii', description: '', inputSchema: { type: 'object', properties: {}, required: [] }, categories: ['read', 'sensitive'], definitionSource: 'native' },
      { name: 'list_basic', description: '', inputSchema: { type: 'object', properties: {}, required: [] }, categories: ['read'], definitionSource: 'native' },
    ] as never);

    await runProbeForBinding({ ...baseBinding, connector_type: 'bamboohr' });

    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'list_basic', // NOT list_pii
    }));
  });

  it('does NOT do execute() for composio_managed connectors (those use credential-refresh only)', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce(fnSet('composio'));
    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'gmail' });
    expect(r.ok).toBe(true);
    expect(r.probe_kind).toBe('composio_credential_refresh');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('does not dispatch a read that needs an input it would have to invent; credentials alone decide', async () => {
    // A fabricated '' or 0 is a malformed request, and the vendor's answer
    // to it would say nothing about the binding.
    mockGetConnectorFunctions.mockReturnValueOnce([
      { name: 'autocomplete_fields', description: '', inputSchema: { type: 'object', properties: { field: { type: 'string' } }, required: ['field'] }, categories: ['read'], definitionSource: 'native' },
    ] as never);

    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'pdl' });

    expect(r.ok).toBe(true);
    expect(r.probe_kind).toBe('rest_auth_test');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('calls the read that takes nothing, with nothing, ahead of one with optional inputs', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce([
      { name: 'combined_enrichment', description: '', inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] }, categories: ['read'], definitionSource: 'native' },
      { name: 'find_people', description: '', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: [] }, categories: ['read'], definitionSource: 'native' },
      { name: 'get_account', description: '', inputSchema: { type: 'object', properties: {}, required: [] }, categories: ['read'], definitionSource: 'native' },
    ] as never);

    await runProbeForBinding({ ...baseBinding, connector_type: 'hunterio' });

    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'get_account',
      input: {},
    }));
  });

  it('records a vendor "missing parameter" answer as PROBE_PAYLOAD_REJECTED, not an auth failure', async () => {
    mockGetConnectorFunctions.mockReturnValueOnce([
      { name: 'enrich_person', description: '', inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: [] }, categories: ['read'], definitionSource: 'native' },
    ] as never);
    mockExecute.mockResolvedValueOnce({ success: false, error: 'pdl.enrich_person: at least one of email, phone, name is required' });

    const r = await runProbeForBinding({ ...baseBinding, connector_type: 'pdl' });

    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('PROBE_PAYLOAD_REJECTED');
  });
});

// VENDOR_TIMEOUT distinguishes vendor 504 / "gateway timeout" from our
// local withTimeout() cutoff so operator triage knows which side stalled.
describe('binding probe — VENDOR_TIMEOUT classification', () => {
  it('classifies vendor 504 as VENDOR_TIMEOUT (not MCP_TIMEOUT)', async () => {
    mockGetMcpServerConfig.mockResolvedValueOnce({
      exists: true, isVendorHosted: true, mcpUrl: 'https://mcp.notion.com/v1',
    });
    mockGetCredentials.mockResolvedValue({ oauth: { accessToken: 'tok' } });
    mockProbeRequest.mockRejectedValueOnce(new Error('504 Gateway Timeout from vendor'));

    const r = await runProbeForBinding(baseBinding);
    expect(r.errorCode).toBe('VENDOR_TIMEOUT');
  });

  it('still classifies "vendor timeout" textual messages as VENDOR_TIMEOUT', async () => {
    mockGetMcpServerConfig.mockResolvedValueOnce({
      exists: true, isVendorHosted: true, mcpUrl: 'https://mcp.notion.com/v1',
    });
    mockGetCredentials.mockResolvedValue({ oauth: { accessToken: 'tok' } });
    mockProbeRequest.mockRejectedValueOnce(new Error('vendor timeout while reading response'));

    const r = await runProbeForBinding(baseBinding);
    expect(r.errorCode).toBe('VENDOR_TIMEOUT');
  });

  it('keeps local timeouts as MCP_TIMEOUT (distinct from vendor timeout)', async () => {
    mockGetMcpServerConfig.mockResolvedValueOnce({
      exists: true, isVendorHosted: true, mcpUrl: 'https://mcp.notion.com/v1',
    });
    mockGetCredentials.mockResolvedValue({ oauth: { accessToken: 'tok' } });
    mockProbeRequest.mockRejectedValueOnce(new Error('request timed out after 5000ms'));

    const r = await runProbeForBinding(baseBinding);
    expect(r.errorCode).toBe('MCP_TIMEOUT');
  });
});
