// The probe had two holes that made a broken binding invisible to the product.
//
// It skipped customer-hosted MCP servers entirely — they live in
// custom_mcp_servers, not connector_manifests — so a dead BYOC server read as
// Active forever. And even for the bindings it DID probe, nothing consumed the
// result: it wrote rows and refreshed a materialized view that no code path
// read, so a binding could fail every day for a month with no user-visible
// consequence.
//
// These cover the BYOC probe itself and the reporting hop that turns a failing
// probe into the `status='error'` the Connections page and the Teams badge
// already know how to render.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockQuery(...a) }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: jest.fn(), warn: jest.fn() },
}));

jest.mock('../tool-schema-cache', () => ({ getToolSchemas: () => [] }));
jest.mock('../connector-service-client', () => ({ getConnectorServiceClient: () => ({}) }));
jest.mock('../../tool-gateway/transports', () => ({ createTransportSync: jest.fn() }));

const mockBuildProbeTransport = jest.fn();
jest.mock('../../tool-gateway/custom-mcp-server-handler', () => ({
  customMcpServerHandler: {
    buildProbeTransport: (...a: unknown[]) => mockBuildProbeTransport(...a),
  },
}));

import { runCustomMcpProbe } from '../binding-probe';

const TENANT = 'tenant-1';
const CONNECTOR = 'conn-byoc-1';

function transportThat(behaviour: { connect?: () => Promise<void>; request?: () => Promise<unknown> }) {
  return {
    connect: behaviour.connect ?? (() => Promise.resolve()),
    request: behaviour.request ?? (() => Promise.resolve({ tools: [] })),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('runCustomMcpProbe', () => {
  it('passes when the customer server answers tools/list', async () => {
    const transport = transportThat({});
    mockBuildProbeTransport.mockResolvedValueOnce(transport);

    const result = await runCustomMcpProbe(TENANT, CONNECTOR);

    expect(result.ok).toBe(true);
    expect(result.probe_kind).toBe('customer_hosted_tools_list');
    // The probe must not leave a connection open against a customer's server.
    expect(transport.close).toHaveBeenCalled();
  });

  it('fails when the server refuses the connection', async () => {
    const transport = transportThat({
      connect: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:443')),
    });
    mockBuildProbeTransport.mockResolvedValueOnce(transport);

    const result = await runCustomMcpProbe(TENANT, CONNECTOR);

    expect(result.ok).toBe(false);
    expect(result.probe_kind).toBe('customer_hosted_tools_list');
    expect(transport.close).toHaveBeenCalled();
  });

  it('reports an auth rejection as an auth failure, not a dead server', async () => {
    mockBuildProbeTransport.mockResolvedValueOnce(
      transportThat({ request: () => Promise.reject(new Error('HTTP 401 unauthorized')) }),
    );

    const result = await runCustomMcpProbe(TENANT, CONNECTOR);

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('MCP_AUTH_FAILED');
  });

  // A server whose config cannot be resolved is broken from the agent's point
  // of view too — the dispatcher reads the same door and would also fail.
  it('fails when the runtime-config door has no config for it', async () => {
    mockBuildProbeTransport.mockResolvedValueOnce(null);

    const result = await runCustomMcpProbe(TENANT, CONNECTOR);

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('CONFIG_LOOKUP_FAILED');
  });

  // The transport still has to be released when the probe throws, or a daily
  // run leaks a socket per broken server.
  it('closes the transport even when the call throws', async () => {
    const transport = transportThat({
      request: () => Promise.reject(new Error('boom')),
    });
    mockBuildProbeTransport.mockResolvedValueOnce(transport);

    await runCustomMcpProbe(TENANT, CONNECTOR);

    expect(transport.close).toHaveBeenCalled();
  });
});
