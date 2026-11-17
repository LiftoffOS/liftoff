// The daily sweep as one run: every binding probed, every result recorded,
// the reconnect report raised once a binding has failed enough probes in a
// row, and a customer-hosted server's probe recorded like any other binding's.

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

jest.mock('../../infrastructure/secret-store', () => ({
  getManagedSecret: () => 'service-token',
}));

// A vendor-hosted binding whose server refuses the token, so the run has a
// failure to report.
const mockGetMcpServerConfig = jest.fn();
const mockGetCredentials = jest.fn();
const mockExecute = jest.fn();
jest.mock('../connector-service-client', () => ({
  getConnectorServiceClient: () => ({
    getMcpServerConfig: mockGetMcpServerConfig,
    getCredentials: mockGetCredentials,
    execute: (...a: unknown[]) => mockExecute(...a),
  }),
}));
jest.mock('../tool-schema-cache', () => ({ getToolSchemas: jest.fn(() => []) }));
import * as toolSchemaCache from '../tool-schema-cache';

const mockProbeRequest = jest.fn();
jest.mock('../../tool-gateway/transports', () => ({
  createTransportSync: () => ({
    connect: () => Promise.resolve(),
    request: (...a: unknown[]) => mockProbeRequest(...a),
    close: jest.fn(),
  }),
}));

const mockBuildProbeTransport = jest.fn();
jest.mock('../../tool-gateway/custom-mcp-server-handler', () => ({
  customMcpServerHandler: {
    buildProbeTransport: (...a: unknown[]) => mockBuildProbeTransport(...a),
  },
}));

import { probeAllBindings } from '../binding-probe';

const TENANT = 'tenant-1';
const MANIFEST = 'conn-vendor-1';
const BYOC = 'conn-byoc-1';

const inserts: Array<{ id: string; ok: boolean; kind: string }> = [];
let streakRows: Array<{ ok: boolean }> = [];
let byocRows: Array<{ tenant_id: string; connector_id: string }> = [];

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  inserts.length = 0;
  streakRows = [];
  byocRows = [];
  process.env.CONNECTOR_SERVICE_URL = 'https://connector-service.test';
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  fetchMock.mockResolvedValue({ ok: true, status: 200 });

  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/FROM connector_manifests/.test(sql)) {
      return { rows: [{ id: MANIFEST, tenant_id: TENANT, connector_type: 'stripe', alias: 'stripe' }], rowCount: 1 };
    }
    if (/INSERT INTO connector_binding_probes/.test(sql)) {
      const p = params as [string, string, boolean, string | null, number | null, string];
      inserts.push({ id: p[0], ok: p[2], kind: p[5] });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT ok FROM connector_binding_probes/.test(sql)) {
      // The streak reads the most recent probes first; the table's timestamp
      // column is probed_at and nothing else orders it.
      expect(sql).toMatch(/ORDER BY probed_at DESC/);
      return { rows: streakRows, rowCount: streakRows.length };
    }
    if (/FROM cached_internal_agents/.test(sql)) {
      return { rows: byocRows, rowCount: byocRows.length };
    }
    return { rows: [], rowCount: 0 };
  });

  mockGetMcpServerConfig.mockResolvedValue({ exists: true, isVendorHosted: true, mcpUrl: 'https://mcp.stripe.com/' });
  mockGetCredentials.mockResolvedValue({ oauth: { accessToken: 'revoked' } });
  mockProbeRequest.mockRejectedValue(new Error('HTTP 401 Unauthorized'));
});

afterEach(() => {
  delete process.env.CONNECTOR_SERVICE_URL;
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('probeAllBindings', () => {
  it('reports a binding as reconnect-required once it has failed two probes in a row', async () => {
    streakRows = [{ ok: false }, { ok: false }];

    const stats = await probeAllBindings();

    expect(stats).toEqual({ probed: 1, ok: 0, failed: 1 });
    expect(inserts).toEqual([{ id: MANIFEST, ok: false, kind: 'vendor_mcp_tools_list' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://connector-service.test/api/connectors/internal/admin/connectors/reconnect-required',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ connectorId: MANIFEST, reason: 'binding_probe_MCP_AUTH_FAILED' }),
      }),
    );
  });

  it('does not report a single failure — one timeout is a blip, not a broken binding', async () => {
    streakRows = [{ ok: false }, { ok: true }];

    await probeAllBindings();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never reports a binding whose only failure is the probe asking a malformed question', async () => {
    // REST direct: the registry decides, and the vendor rejects the request
    // rather than the credential.
    mockGetMcpServerConfig.mockResolvedValue({ exists: false, isVendorHosted: false });
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/FROM connector_manifests/.test(sql)) {
        return { rows: [{ id: MANIFEST, tenant_id: TENANT, connector_type: 'pdl', alias: 'pdl' }], rowCount: 1 };
      }
      if (/INSERT INTO connector_binding_probes/.test(sql)) {
        const p = params as [string, string, boolean, string | null, number | null, string];
        inserts.push({ id: p[0], ok: p[2], kind: p[5] });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT ok FROM connector_binding_probes/.test(sql)) return { rows: [{ ok: false }, { ok: false }], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    });
    jest.spyOn(toolSchemaCache, 'getToolSchemas').mockReturnValue([
      { name: 'enrich_person', description: '', inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: [] }, categories: ['read'], definitionSource: 'native' },
    ] as never);
    mockExecute.mockResolvedValueOnce({ success: false, error: 'pdl.enrich_person: at least one of email, phone, name is required' });

    const stats = await probeAllBindings();

    expect(stats).toEqual({ probed: 1, ok: 0, failed: 1 });
    expect(inserts).toEqual([{ id: MANIFEST, ok: false, kind: 'rest_auth_test' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records a customer-hosted server probe under its connector id and counts it', async () => {
    byocRows = [{ tenant_id: TENANT, connector_id: BYOC }];
    mockBuildProbeTransport.mockResolvedValueOnce({
      connect: () => Promise.resolve(),
      request: () => Promise.resolve({ tools: [{ name: 'search' }] }),
      close: jest.fn().mockResolvedValue(undefined),
    });

    const stats = await probeAllBindings();

    expect(stats).toEqual({ probed: 2, ok: 1, failed: 1 });
    expect(inserts).toContainEqual({ id: BYOC, ok: true, kind: 'customer_hosted_tools_list' });
    // The health view is refreshed after every binding, BYOC included.
    expect(mockQuery).toHaveBeenCalledWith(expect.stringMatching(/REFRESH MATERIALIZED VIEW/));
  });
});
