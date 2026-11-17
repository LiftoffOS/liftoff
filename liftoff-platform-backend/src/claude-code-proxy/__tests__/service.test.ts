// Service Tests
// Tests key creation, Anthropic key verification, Secret Manager caching, key resolution

const mockQuery = jest.fn();
(global as any).__mockQuery = mockQuery;

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({
    query: (...args: unknown[]) => (global as any).__mockQuery(...args),
  }),
  // createMcpToken / listMcpTokens / selfRevoke etc. now run under
  // withTenantScope; revokeMcpToken / bindCodeChallenge / exchangeSetupToken
  // run under withAdminScope. Both wrappers delegate query() to the same
  // global mock so tests already counting __mockQuery calls keep working.
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: (...args: unknown[]) => unknown }) => unknown) => {
    return fn({ query: (...args: unknown[]) => (global as any).__mockQuery(...args) });
  }),
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (client: { query: (...args: unknown[]) => unknown }) => unknown) => {
    return fn({ query: (...args: unknown[]) => (global as any).__mockQuery(...args) });
  }),
}));

const mockGetCredential = jest.fn();
let devProxyEnabled = true;
jest.mock('../developer-proxy-client', () => ({
  isDevProxyEnabled: () => devProxyEnabled,
  getCredential: (...args: unknown[]) => mockGetCredential(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
  logAudit: jest.fn(),
}));

const mockGetSecret = jest.fn();
const mockClearSecretCache = jest.fn();
jest.mock('../../infrastructure/secrets', () => ({
  getSecret: (...args: unknown[]) => mockGetSecret(...args),
  clearSecretCacheEntry: (...args: unknown[]) => mockClearSecretCache(...args),
}));

const mockCreateSecret = jest.fn().mockResolvedValue([{}]);
const mockAddSecretVersion = jest.fn().mockResolvedValue([{}]);
jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    createSecret: mockCreateSecret,
    addSecretVersion: mockAddSecretVersion,
  })),
}));

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { createMcpToken, revokeMcpToken, connectionBelongsToTenant } from '../service';

describe('service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GCP_PROJECT_ID = 'test-project';
    // Use the dev-environment alias for test fixtures; the prod alias is
    // rejected by getProxyBaseUrl() when NODE_ENV != 'production' (cross-env
    // trust guard in control-plane-url.ts).
    process.env.PROXY_BASE_URL = 'https://api-dev.example.com/proxy';
    // Reset cache so each test reads the freshly set env vars.
    const m = jest.requireActual('../../infrastructure/control-plane-url') as { _resetBackendUrlCacheForTests: () => void };
    m._resetBackendUrlCacheForTests();
  });

  // Proxy-key flows (createKey, listKeys, getKey, updateKey, revokeKey,
  // resolveProxyKey, getAnthropicApiKey, refreshAnthropicKeyCache) and their
  // tests were removed when migration 132 dropped the claude_code_proxy_keys
  // table. Production runs go to liftoff-developer-proxy via devProxyClient.

  describe('createMcpToken', () => {
    beforeEach(() => {
      mockQuery.mockReset();
      // mcp_tokens INSERT
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'mcp-token-id-1' }] });
      // setup_tokens INSERT
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // person_agent_assignments fire-and-forget INSERT
      mockQuery.mockResolvedValueOnce({ rows: [] });
    });

    it('generates liftoff_mcp_ prefixed token', async () => {
      const result = await createMcpToken({ tenantId: 'tenant-1', accountId: 'acct-1' });
      expect(result.id).toBe('mcp-token-id-1');
      expect(result.setupToken).toBeDefined();
      expect(result.proxyBaseUrl).toBeDefined();
    });

    it('auto-registers collab connection in person_agent_assignments', async () => {
      await createMcpToken({ tenantId: 'tenant-1', accountId: 'acct-1' });
      await new Promise(r => setTimeout(r, 50)); // let fire-and-forget settle
      const paaCall = mockQuery.mock.calls.find(([sql]: [string]) =>
        sql.includes('person_agent_assignments') && sql.includes('external')
      );
      expect(paaCall).toBeDefined();
      expect(paaCall![1]).toEqual(['tenant-1', 'acct-1', 'mcp-token-id-1', 'acct-1']);
    });

    it('does not throw if person_agent_assignments insert fails', async () => {
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'mcp-token-id-2' }] }); // mcp_tokens
      mockQuery.mockResolvedValueOnce({ rows: [] });                          // setup_tokens
      mockQuery.mockRejectedValueOnce(new Error('constraint violation'));     // PAA (fire-and-forget)

      await expect(
        createMcpToken({ tenantId: 'tenant-1', accountId: 'acct-1' })
      ).resolves.toBeDefined();
    });
  });

  describe('revokeMcpToken', () => {
    it('revokes a static token and soft-deletes its PAA row without touching token tables', async () => {
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE oauth_grants (static: no grant)
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE mcp_tokens
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE person_agent_assignments

      await revokeMcpToken('mcp-token-id-1', 'acct-1');

      expect(mockQuery).toHaveBeenCalledTimes(3);
      const [grantCall, anchorCall, paaCall] = mockQuery.mock.calls;
      expect(grantCall[0]).toContain('UPDATE oauth_grants');
      expect(grantCall[1]).toEqual(['mcp-token-id-1', 'acct-1']);
      expect(anchorCall[0]).toContain('UPDATE mcp_tokens');
      expect(anchorCall[0]).not.toContain("auth_kind = 'static'");
      expect(anchorCall[1]).toEqual(['mcp-token-id-1', 'acct-1']);
      expect(paaCall[0]).toContain('person_agent_assignments');
      expect(paaCall[0]).toContain('deleted_at = NOW()');
      expect(paaCall[1]).toEqual(['mcp-token-id-1']);
    });

    // A dashboard Archive on an OAuth-connected tool is the person's own
    // disconnect: the grant the tool presents is retired with its access and
    // refresh tokens before the anchor, each statement bound to that grant.
    it('retires an OAuth anchor through its grant family, bound to the anchor and the person', async () => {
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'grant-1' }] }); // UPDATE oauth_grants RETURNING id
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE oauth_access_tokens
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE oauth_refresh_tokens
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE mcp_tokens
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE person_agent_assignments

      await revokeMcpToken('anchor-1', 'acct-1');

      expect(mockQuery).toHaveBeenCalledTimes(5);
      const [grantCall, accessCall, refreshCall, anchorCall] = mockQuery.mock.calls;
      expect(grantCall[0]).toContain("status = 'revoked'");
      expect(grantCall[0]).toContain('mcp_token_id = $1 AND account_id = $2');
      expect(accessCall[0]).toContain('UPDATE oauth_access_tokens');
      expect(accessCall[1]).toEqual([['grant-1']]);
      expect(refreshCall[0]).toContain('UPDATE oauth_refresh_tokens');
      expect(refreshCall[1]).toEqual([['grant-1']]);
      expect(anchorCall[0]).toContain('UPDATE mcp_tokens');
    });
  });

  describe('connectionBelongsToTenant', () => {
    // A profile row is only written under an id the workspace owns: an
    // mcp_tokens anchor under the tenant, else a credential the developer
    // proxy answers for under the tenant.
    beforeEach(() => {
      mockQuery.mockReset();
      mockGetCredential.mockReset();
      devProxyEnabled = true;
    });

    it('is true for a live anchor of the tenant without asking the proxy', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      expect(await connectionBelongsToTenant('anchor-1', 'tenant-1', 'acct-1')).toBe(true);
      expect(mockQuery.mock.calls[0][1]).toEqual(['anchor-1', 'tenant-1']);
      expect(mockGetCredential).not.toHaveBeenCalled();
    });

    it('falls through to the proxy credential lookup under the tenant', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockGetCredential.mockResolvedValueOnce({ id: 'cred-1' });
      expect(await connectionBelongsToTenant('cred-1', 'tenant-1', 'acct-1')).toBe(true);
      expect(mockGetCredential).toHaveBeenCalledWith({ id: 'cred-1', tenantId: 'tenant-1', userId: 'acct-1' });
    });

    it('is false when neither family knows the id, or the proxy is off', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockGetCredential.mockResolvedValueOnce(null);
      expect(await connectionBelongsToTenant('x', 'tenant-1', 'acct-1')).toBe(false);

      devProxyEnabled = false;
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await connectionBelongsToTenant('x', 'tenant-1', 'acct-1')).toBe(false);
    });
  });
});
