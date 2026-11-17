// Tunnels service tests — exercises route creation, unbound-route filtering,
// and the deploy artifact builder. Database queries are mocked.

import { TunnelsService } from '../service';

// Mock infrastructure — pool.query is the only call surface we exercise.
const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  pool: {
    query: jest.fn((...args: unknown[]) => mockQuery(...args)),
    connect: jest.fn(),
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

jest.mock('../../infrastructure/pubsub', () => ({
  pubSubPublisher: { publish: jest.fn().mockResolvedValue('msg-id') },
}));

// Mock Secret Manager so we don't try to hit GCP.
jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    createSecret: jest.fn().mockResolvedValue([{}]),
    addSecretVersion: jest.fn().mockResolvedValue([{ name: 'projects/example-project/secrets/s/versions/1' }]),
    getSecretVersion: jest.fn().mockResolvedValue([{ name: 'projects/example-project/secrets/s/versions/1' }]),
    disableSecretVersion: jest.fn().mockResolvedValue([{}]),
  })),
}));

describe('TunnelsService', () => {
  const tenantId = 'tenant-aaa';
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset history but PRESERVE mockResolvedValueOnce queues set inside each test.
    mockQuery.mockReset();
    process.env.GCP_PROJECT_ID = 'test-project';
    process.env.TUNNEL_BASE_DOMAIN = 'tunnels.example.com';
    process.env.TUNNEL_CLIENT_IMAGE = 'registry.example.com/tunnel-client:v0.1.0';
    // The deploy artifact tells the customer where to poll for config. It used
    // to fall back to a hard-coded host; it now falls through to BACKEND_URL,
    // which throws rather than inventing one, so the test has to supply it.
    process.env.BACKEND_URL = 'http://localhost:8080';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('createDeployment', () => {
    it('returns deployment + plaintext token + deploy artifact in a single shot', async () => {
      const service = new TunnelsService();
      const insertedRow = {
        id: 'dep-1',
        tenant_id: tenantId,
        name: 'acme-prod',
        tenant_prefix: 'acme-abc',
        tunnel_token_secret_name: 'mcp-tunnel-token-acme-abc',
        inner_tls_enabled: false,
        status: 'pending',
        last_seen_at: null,
        created_at: new Date('2026-05-01').toISOString(),
        updated_at: new Date('2026-05-01').toISOString(),
      };
      mockQuery.mockResolvedValueOnce({ rows: [insertedRow] });

      const result = await service.createDeployment({ tenantId, name: 'acme-prod', tenantPrefix: 'acme-abc' });

      expect(result.deployment.id).toBe('dep-1');
      expect(result.tunnelToken).toMatch(/^tk_[A-Za-z0-9_-]+$/);
      expect(result.deployArtifact.image).toBe('registry.example.com/tunnel-client:v0.1.0');
      expect(result.deployArtifact.dockerRunCommand).toContain('TUNNEL_TOKEN=' + result.tunnelToken);
      expect(result.deployArtifact.dockerRunCommand).toContain('TUNNEL_PREFIX=acme-abc');
    });

    it('rejects when GCP_PROJECT_ID is not set', async () => {
      const service = new TunnelsService();
      delete process.env.GCP_PROJECT_ID;
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(service.createDeployment({ tenantId, name: 'acme-prod' })).rejects.toThrow(
        /GCP_PROJECT_ID/,
      );
    });
  });

  describe('listTunneledUrlsForTenant', () => {
    it('returns the deduplicated set of public_urls for a tenant', async () => {
      const service = new TunnelsService();
      mockQuery.mockResolvedValueOnce({
        rows: [
          { public_url: 'https://acme-jira.tunnels.example.com' },
          { public_url: 'https://acme-confluence.tunnels.example.com' },
        ],
      });
      const urls = await service.listTunneledUrlsForTenant(tenantId);
      expect(urls).toEqual([
        'https://acme-jira.tunnels.example.com',
        'https://acme-confluence.tunnels.example.com',
      ]);
    });
  });

  describe('listUnboundRoutes', () => {
    it('filters out routes referenced by a custom_mcp_server or external_agent', async () => {
      const service = new TunnelsService();
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'route-unbound',
            deployment_id: 'dep-1',
            subdomain: 'unbound',
            upstream_url: 'http://localhost:7000',
            public_url: 'https://acme-unbound.tunnels.example.com',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
      const routes = await service.listUnboundRoutes(tenantId);
      expect(routes).toHaveLength(1);
      expect(routes[0]!.id).toBe('route-unbound');
      // Verify the SQL was a LEFT JOIN that scopes by tenant_id.
      const sql = mockQuery.mock.calls[0]![0] as string;
      expect(sql).toMatch(/LEFT JOIN custom_mcp_servers/i);
      expect(sql).toMatch(/LEFT JOIN external_agents/i);
      expect(sql).toMatch(/c\.id IS NULL/);
      expect(sql).toMatch(/ea\.id IS NULL/);
    });
  });

  describe('sweepStalePending', () => {
    it('deletes pending deployments older than the 10-minute threshold', async () => {
      const service = new TunnelsService();
      mockQuery.mockResolvedValueOnce({ rowCount: 3, rows: [] });
      const count = await service.sweepStalePending();
      expect(count).toBe(3);
      const sql = mockQuery.mock.calls[0]![0] as string;
      expect(sql).toMatch(/status = 'pending'/);
      expect(sql).toMatch(/INTERVAL '10 minutes'/);
    });
  });

  describe('sweepExpiredTokenVersions', () => {
    it('selects only rows past their grace window', async () => {
      const service = new TunnelsService();
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const disabled = await service.sweepExpiredTokenVersions();
      expect(disabled).toBe(0);
      const sql = mockQuery.mock.calls[0]![0] as string;
      expect(sql).toMatch(/prev_token_secret_version IS NOT NULL/);
      expect(sql).toMatch(/prev_token_expires_at <= NOW\(\)/);
    });
  });
});
