// Custom MCP Server service tests — exercises the public-URL + tunneled
// create paths and validates that tool classifications are persisted into
// tool_classification_cache under the per-instance namespace.

import { CustomMcpServerService } from '../service';

// E1: registration now runs the SSRF guard, which DNS-resolves the host before
// accepting it. These are unit tests against fictional hostnames, so resolution
// is stubbed to a public address — the guard's own behaviour is covered in
// common/__tests__/url-guard.test.ts.
jest.mock('dns/promises', () => ({
  __esModule: true,
  default: { lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) },
}));

const mockQuery = jest.fn();
const mockClient = {
  query: jest.fn((...args: unknown[]) => mockQuery(...args)),
  release: jest.fn(),
};

jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  pool: {
    query: jest.fn((...args: unknown[]) => mockQuery(...args)),
    connect: jest.fn().mockResolvedValue({
      query: (...args: unknown[]) => {
        // RLS: swallow the own-tx set_config so ordered mockResolvedValueOnce
        // sequences (and mock.calls indices) are unaffected.
        if (typeof args[0] === 'string' && (args[0] as string).includes('set_config')) {
          return Promise.resolve({ rows: [] });
        }
        return mockClient.query(...args);
      },
      release: () => mockClient.release(),
    }),
  },
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    createSecret: jest.fn().mockResolvedValue([{}]),
    addSecretVersion: jest.fn().mockResolvedValue([{}]),
    accessSecretVersion: jest.fn(),
  })),
}));

// Stub the discovery + classifier modules so we don't try to network/LLM.
const mockDiscover = jest.fn();
const mockPersist = jest.fn();
jest.mock('../discover-adapter', () => ({
  discoverCustomMcpServerWithProgress: (...args: unknown[]) => mockDiscover(...args),
  persistCustomMcpServerTools: (...args: unknown[]) => mockPersist(...args),
  // The per-instance classification namespace: the real derivation, so the
  // cache key the test asserts on is the one production writes.
  customMcpClassificationIntegrationType: (serverId: string) => `custom_mcp_server:${serverId}`,
}));

const mockClassifierCache = jest.fn();
jest.mock('../../mcp/tool-classifier', () => ({
  toolClassifier: {
    cacheClassification: (...args: unknown[]) => mockClassifierCache(...args),
    hashDescription: (s: string) => `hash:${s}`,
  },
}));

const mockGetRoute = jest.fn();
jest.mock('../../tunnels/service', () => ({
  tunnelsService: {
    getRoute: (...args: unknown[]) => mockGetRoute(...args),
  },
}));

const mockCreateConnectorRpc = jest.fn();
const mockDeleteConnectorRpc = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  createConnectorForTenant: (...args: unknown[]) => mockCreateConnectorRpc(...args),
  deleteConnectorForTenant: (...args: unknown[]) => mockDeleteConnectorRpc(...args),
}));

describe('CustomMcpServerService', () => {
  const tenantId = 'tenant-aaa';
  const accountId = 'user-bbb';

  beforeEach(() => {
    mockQuery.mockReset();
    mockClient.query.mockReset();
    mockClient.release.mockClear();
    mockDiscover.mockReset();
    mockPersist.mockReset();
    mockClassifierCache.mockReset();
    mockGetRoute.mockReset();
    mockCreateConnectorRpc.mockReset();
    mockDeleteConnectorRpc.mockReset();
    process.env.GCP_PROJECT_ID = 'test-project';

    mockDiscover.mockResolvedValue({
      capabilities: [],
      resources: [],
      toolClassifications: {
        send_email: ['customerCommunication'],
        list_users: [],
      },
      rawMcpTools: [
        { name: 'send_email', description: 'Send an email', inputSchema: { type: 'object' } },
        { name: 'list_users', description: 'List users', inputSchema: { type: 'object' } },
      ],
      rawMcpResources: [],
      transportType: 'streamable-http',
      summary: '',
      collaborationHints: '',
    });
  });

  describe('create (public_url)', () => {
    it('creates the connector in connector-service, mirrors locally with the same id, and caches classifications', async () => {
      const service = new CustomMcpServerService();

      mockCreateConnectorRpc.mockResolvedValueOnce({
        id: 'connector-1',
        type: 'custom_mcp_server',
        name: 'Analytics MCP',
        status: 'active',
      });

      // Inside the transaction:
      //   1. INSERT INTO connectors (mirror) — no RETURNING
      //   2. INSERT INTO custom_mcp_servers RETURNING *
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // INSERT connectors mirror
        .mockResolvedValueOnce({
          rows: [
            {
              tenant_id: tenantId,
              name: 'Analytics MCP',
              delivery_mode: 'public_url',
              endpoint_url: 'https://mcp.acme.com/mcp',
              auth_type: 'none',
              auth_secret_name: null,
              tunnel_route_id: null,
              raw_mcp_tools: [],
              connector_id: 'connector-1',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({}); // COMMIT

      // After transaction, the runDiscovery+cache flow + refreshed get() use pool.query.
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            tenant_id: tenantId,
            name: 'Analytics MCP',
            delivery_mode: 'public_url',
            endpoint_url: 'https://mcp.acme.com/mcp',
            auth_type: 'none',
            auth_secret_name: null,
            tunnel_route_id: null,
            raw_mcp_tools: [],
            connector_id: 'connector-1',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });

      const result = await service.create(tenantId, accountId, {
        name: 'Analytics MCP',
        deliveryMode: 'public_url',
        endpointUrl: 'https://mcp.acme.com/mcp',
        authType: 'none',
      });

      // id = connector_id post migration 268 (no more redundant local PK).
      expect(result.id).toBe('connector-1');
      expect(result.connectorId).toBe('connector-1');
      expect(result.endpointUrl).toBe('https://mcp.acme.com/mcp');
      // Connector-service called once with the right shape.
      expect(mockCreateConnectorRpc).toHaveBeenCalledTimes(1);
      expect(mockCreateConnectorRpc.mock.calls[0]).toEqual([
        tenantId,
        'custom_mcp_server',
        'Analytics MCP',
        { deliveryMode: 'public_url', endpointUrl: 'https://mcp.acme.com/mcp' },
        accountId,
        'active',
      ]);
      // Local mirror INSERT used the connector-service-issued id.
      const mirrorInsertCall = mockClient.query.mock.calls[1]!;
      expect(mirrorInsertCall[0]).toMatch(/INSERT INTO connectors/);
      expect(mirrorInsertCall[1][0]).toBe('connector-1');
      // Two classifications cached (send_email, list_users) per the mocked discovery output.
      expect(mockClassifierCache).toHaveBeenCalledTimes(2);
      expect(mockClassifierCache.mock.calls[0]![1]).toBe('custom_mcp_server:connector-1');
    });

    it('rolls back the connector-service row if the local INSERT fails', async () => {
      const service = new CustomMcpServerService();

      mockCreateConnectorRpc.mockResolvedValueOnce({
        id: 'connector-rollback',
        type: 'custom_mcp_server',
        name: 'Will Fail',
        status: 'active',
      });

      // Local mirror INSERT throws — simulating e.g. FK violation
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('local insert failed'))
        .mockResolvedValueOnce({}); // ROLLBACK

      mockDeleteConnectorRpc.mockResolvedValueOnce(undefined);

      await expect(
        service.create(tenantId, accountId, {
          name: 'Will Fail',
          deliveryMode: 'public_url',
          endpointUrl: 'https://mcp.acme.com/mcp',
          authType: 'none',
        }),
      ).rejects.toThrow(/local insert failed/);

      // Compensating delete fired with the same id.
      expect(mockDeleteConnectorRpc).toHaveBeenCalledTimes(1);
      expect(mockDeleteConnectorRpc.mock.calls[0]).toEqual(['connector-rollback', accountId]);
    });

    it('retries the compensating connector-service delete when the first attempt fails', async () => {
      const service = new CustomMcpServerService();

      mockCreateConnectorRpc.mockResolvedValueOnce({
        id: 'connector-retry',
        type: 'custom_mcp_server',
        name: 'Flaky',
        status: 'active',
      });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('local insert failed'))
        .mockResolvedValueOnce({}); // ROLLBACK

      // First two compensation attempts fail (simulating the original
      // orphan-producing failure mode), third succeeds. The retry loop
      // must keep going until success so the connector-service row gets
      // soft-deleted and the user never sees an undeletable duplicate tile.
      mockDeleteConnectorRpc
        .mockRejectedValueOnce(new Error('connector-service 503'))
        .mockRejectedValueOnce(new Error('connector-service 503'))
        .mockResolvedValueOnce(undefined);

      await expect(
        service.create(tenantId, accountId, {
          name: 'Flaky',
          deliveryMode: 'public_url',
          endpointUrl: 'https://mcp.acme.com/mcp',
          authType: 'none',
        }),
      ).rejects.toThrow(/local insert failed/);

      expect(mockDeleteConnectorRpc).toHaveBeenCalledTimes(3);
      for (const call of mockDeleteConnectorRpc.mock.calls) {
        expect(call).toEqual(['connector-retry', accountId]);
      }
    }, 15_000);

    it('rejects tunneled mode with no tunnelRouteId (before any connector-service call)', async () => {
      const service = new CustomMcpServerService();
      await expect(
        service.create(tenantId, accountId, {
          name: 'Analytics MCP',
          deliveryMode: 'tunneled',
          authType: 'none',
        }),
      ).rejects.toThrow(/tunnelRouteId is required/);
      expect(mockCreateConnectorRpc).not.toHaveBeenCalled();
    });

    it('rejects public_url mode with a tunnelRouteId set (before any connector-service call)', async () => {
      const service = new CustomMcpServerService();
      await expect(
        service.create(tenantId, accountId, {
          name: 'Analytics MCP',
          deliveryMode: 'public_url',
          endpointUrl: 'https://mcp.acme.com/mcp',
          authType: 'none',
          tunnelRouteId: '00000000-0000-0000-0000-000000000001',
        }),
      ).rejects.toThrow(/tunnelRouteId is not allowed/);
      expect(mockCreateConnectorRpc).not.toHaveBeenCalled();
    });
  });

  describe('create (tunneled)', () => {
    it('resolves the endpoint URL from the tunnel route public_url', async () => {
      const service = new CustomMcpServerService();
      mockGetRoute.mockResolvedValue({
        id: 'route-1',
        deploymentId: 'dep-1',
        subdomain: 'analytics',
        upstreamUrl: 'http://analytics.internal:7000',
        publicUrl: 'https://acme-analytics.tunnels.example.com',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockCreateConnectorRpc.mockResolvedValueOnce({
        id: 'connector-2',
        type: 'custom_mcp_server',
        name: 'Tunneled MCP',
        status: 'active',
      });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // INSERT connectors mirror
        .mockResolvedValueOnce({
          rows: [
            {
              tenant_id: tenantId,
              name: 'Tunneled MCP',
              delivery_mode: 'tunneled',
              endpoint_url: 'https://acme-analytics.tunnels.example.com',
              auth_type: 'none',
              auth_secret_name: null,
              tunnel_route_id: 'route-1',
              raw_mcp_tools: [],
              connector_id: 'connector-2',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({}); // COMMIT

      // get() after create
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            tenant_id: tenantId,
            name: 'Tunneled MCP',
            delivery_mode: 'tunneled',
            endpoint_url: 'https://acme-analytics.tunnels.example.com',
            auth_type: 'none',
            auth_secret_name: null,
            tunnel_route_id: 'route-1',
            raw_mcp_tools: [],
            connector_id: 'connector-2',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });

      const result = await service.create(tenantId, accountId, {
        name: 'Tunneled MCP',
        deliveryMode: 'tunneled',
        authType: 'none',
        tunnelRouteId: 'route-1',
      });

      expect(result.endpointUrl).toBe('https://acme-analytics.tunnels.example.com');
      expect(result.tunnelRouteId).toBe('route-1');
      expect(mockCreateConnectorRpc.mock.calls[0]![3]).toEqual({
        deliveryMode: 'tunneled',
        endpointUrl: 'https://acme-analytics.tunnels.example.com',
      });
    });
  });

  describe('delete', () => {
    it('deletes the local custom_mcp_servers row and the connector-service row', async () => {
      const service = new CustomMcpServerService();

      // service.delete first calls get() — return an existing server.
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              tenant_id: tenantId,
              name: 'X',
              delivery_mode: 'public_url',
              endpoint_url: 'https://x',
              auth_type: 'none',
              auth_secret_name: null,
              tunnel_route_id: null,
              raw_mcp_tools: [],
              connector_id: 'connector-1',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'connector-1' }] });

      mockDeleteConnectorRpc.mockResolvedValueOnce(undefined);

      const ok = await service.delete(tenantId, accountId, 'connector-1');
      expect(ok).toBe(true);
      expect(mockDeleteConnectorRpc).toHaveBeenCalledWith('connector-1', accountId);
    });

    it('returns false when the server does not exist (and does not call connector-service)', async () => {
      const service = new CustomMcpServerService();
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const ok = await service.delete(tenantId, accountId, 'missing');
      expect(ok).toBe(false);
      expect(mockDeleteConnectorRpc).not.toHaveBeenCalled();
    });
  });

  // Editing in place is what makes a broken BYOC server repairable. Delete and
  // recreate mints a new connector id, and every agent bound to the old one
  // has to be re-bound by hand — the same failure an OAuth reconnect avoids by
  // adopting the existing row.
  describe('update', () => {
    /** The row `get()` returns before the patch is applied. */
    function existingRow(over: Record<string, unknown> = {}) {
      return {
        id: 'srv-1',
        tenant_id: tenantId,
        name: 'Help Center MCP',
        delivery_mode: 'public_url',
        endpoint_url: 'https://old.example.com/mcp',
        auth_type: 'bearer_token',
        auth_secret_name: 'secret-old',
        tunnel_route_id: null,
        raw_mcp_tools: [],
        connector_id: 'conn-1',
        created_at: new Date(),
        updated_at: new Date(),
        ...over,
      };
    }

    it('moves the endpoint without touching the stored credential', async () => {
      const service = new CustomMcpServerService();
      mockQuery.mockResolvedValueOnce({ rows: [existingRow()] });
      mockQuery.mockResolvedValueOnce({
        rows: [existingRow({ endpoint_url: 'https://new.example.com/mcp' })],
      });
      mockQuery.mockResolvedValue({ rows: [] });

      const out = await service.update(tenantId, 'conn-1', {
        endpointUrl: 'https://new.example.com/mcp',
      });

      expect(out?.endpointUrl).toBe('https://new.example.com/mcp');
      const updateCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('UPDATE custom_mcp_servers'),
      );
      // Secret pointer preserved: the editor masks the value and cannot
      // resubmit it, so an absent credential means "leave it alone".
      expect(updateCall?.[1]).toEqual(
        expect.arrayContaining(['https://new.example.com/mcp', 'bearer_token', 'secret-old']),
      );
    });

    it('rewrites the secret when a new credential is supplied', async () => {
      const service = new CustomMcpServerService();
      mockQuery.mockResolvedValueOnce({ rows: [existingRow()] });
      mockQuery.mockResolvedValueOnce({ rows: [existingRow()] });
      mockQuery.mockResolvedValue({ rows: [] });

      await service.update(tenantId, 'conn-1', { bearerToken: 'rotated-token' });

      const updateCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('UPDATE custom_mcp_servers'),
      );
      expect(updateCall?.[1]?.[3]).not.toBe('secret-old');
    });

    it('drops the secret pointer when auth is turned off', async () => {
      const service = new CustomMcpServerService();
      mockQuery.mockResolvedValueOnce({ rows: [existingRow()] });
      mockQuery.mockResolvedValueOnce({ rows: [existingRow({ auth_type: 'none', auth_secret_name: null })] });
      mockQuery.mockResolvedValue({ rows: [] });

      await service.update(tenantId, 'conn-1', { authType: 'none' });

      const updateCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('UPDATE custom_mcp_servers'),
      );
      expect(updateCall?.[1]?.[2]).toBe('none');
      expect(updateCall?.[1]?.[3]).toBeNull();
    });

    // A tunnel resolves its own endpoint from the tunnel route, so an
    // endpointUrl sent for one is ignored rather than allowed to overwrite it.
    it('ignores an endpoint sent for a tunneled server', async () => {
      const service = new CustomMcpServerService();
      const tunneled = existingRow({
        delivery_mode: 'tunneled',
        endpoint_url: 'https://tunnel.example.com/r/abc',
        tunnel_route_id: 'route-1',
      });
      mockQuery.mockResolvedValueOnce({ rows: [tunneled] });
      mockQuery.mockResolvedValueOnce({ rows: [tunneled] });
      mockQuery.mockResolvedValue({ rows: [] });

      await service.update(tenantId, 'conn-1', { endpointUrl: 'https://elsewhere.example.com' });

      const updateCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('UPDATE custom_mcp_servers'),
      );
      expect(updateCall?.[1]?.[1]).toBe('https://tunnel.example.com/r/abc');
    });

    // The customer asserting the server is fixed should clear the Reconnect
    // card; if they are wrong the next probe puts it straight back.
    it('clears an error status so the probe can re-confirm', async () => {
      const service = new CustomMcpServerService();
      mockQuery.mockResolvedValueOnce({ rows: [existingRow()] });
      mockQuery.mockResolvedValueOnce({ rows: [existingRow()] });
      mockQuery.mockResolvedValue({ rows: [] });

      await service.update(tenantId, 'conn-1', { endpointUrl: 'https://new.example.com/mcp' });

      const clearCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string'
          && c[0].includes('UPDATE connectors')
          && c[0].includes("status = 'active'"),
      );
      expect(clearCall).toBeDefined();
    });

    it('returns null for a server this tenant does not have', async () => {
      const service = new CustomMcpServerService();
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const out = await service.update(tenantId, 'missing', { name: 'x' });
      expect(out).toBeNull();
    });
  });
});
