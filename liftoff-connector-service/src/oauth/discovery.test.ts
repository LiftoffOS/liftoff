// Tests for oauth/discovery.ts.
//
// Pure-function coverage for the SSRF allowlist + discovery-config
// validation. DB / network paths are intentionally out of scope — they
// require a live Postgres + outbound HTTPS (see platform-backend
// integration tests).

// The issuer-pinning cases below drive getDiscoveredOAuthConfig, whose DCR-row
// cache lives in connector-pg. The pool is mocked so the discovery dance runs
// end to end against stubbed fetches without a database.
const adminQuery = jest.fn();
jest.mock('../db/pool.js', () => ({
  withAdminScope: jest.fn(async (_meta: unknown, fn: (client: { query: typeof adminQuery }) => unknown) =>
    fn({ query: adminQuery })),
}));

import {
  isAllowedDiscoveryUrl,
  fetchAuthorizationEndpointOnly,
  getDiscoveredOAuthConfig,
  OAuthDiscoveryError,
  validateDiscoveryConfigs,
  _resetCacheForTesting,
  _parseRegistrationResponseForTesting,
  authServerMetadataUrls,
} from './discovery.js';

describe('oauth/discovery — SSRF allowlist (isAllowedDiscoveryUrl)', () => {
  afterEach(() => {
    _resetCacheForTesting();
  });

  it('accepts allowlisted HTTPS issuers', () => {
    expect(isAllowedDiscoveryUrl('https://mcp.notion.com/.well-known/oauth-protected-resource')).toBe(true);
    expect(isAllowedDiscoveryUrl('https://mcp.linear.app/register')).toBe(true);
    expect(isAllowedDiscoveryUrl('https://api.notion.com/v1/oauth/token')).toBe(true);
    expect(isAllowedDiscoveryUrl('https://mcp.paypal.com/token')).toBe(true);
    expect(isAllowedDiscoveryUrl('https://mcp.datadoghq.com/.well-known/oauth-authorization-server')).toBe(true);
    expect(isAllowedDiscoveryUrl('https://mcp.clay.earth/.well-known/oauth-authorization-server')).toBe(true);
    expect(isAllowedDiscoveryUrl('https://clay.earth/register')).toBe(true);
  });

  it('accepts subdomains of allowlisted roots', () => {
    // Subdomain match: *.notion.com is allowed because 'notion.com' is
    // in the allowlist root set.
    expect(isAllowedDiscoveryUrl('https://foo.notion.com/register')).toBe(true);
    expect(isAllowedDiscoveryUrl('https://alt.calendly.com/oauth/authorize')).toBe(true);
  });

  it('rejects HTTP (non-TLS)', () => {
    expect(isAllowedDiscoveryUrl('http://mcp.notion.com/register')).toBe(false);
  });

  it('rejects localhost', () => {
    expect(isAllowedDiscoveryUrl('https://localhost/register')).toBe(false);
    expect(isAllowedDiscoveryUrl('https://127.0.0.1/register')).toBe(false);
  });

  it('rejects RFC 1918 private IPv4 ranges', () => {
    expect(isAllowedDiscoveryUrl('https://10.0.0.1/register')).toBe(false);
    expect(isAllowedDiscoveryUrl('https://10.255.255.255/register')).toBe(false);
    expect(isAllowedDiscoveryUrl('https://172.16.0.5/register')).toBe(false);
    expect(isAllowedDiscoveryUrl('https://172.31.255.254/register')).toBe(false);
    expect(isAllowedDiscoveryUrl('https://192.168.1.1/register')).toBe(false);
  });

  it('rejects the GCP / AWS metadata IP (169.254.169.254) + link-local', () => {
    expect(isAllowedDiscoveryUrl('https://169.254.169.254/computeMetadata/v1/')).toBe(false);
    expect(isAllowedDiscoveryUrl('https://169.254.0.1/whatever')).toBe(false);
  });

  it('rejects the GCP metadata hostname', () => {
    expect(isAllowedDiscoveryUrl('https://metadata.google.internal/computeMetadata/v1/')).toBe(false);
  });

  it('rejects IPv6 literal hostnames', () => {
    expect(isAllowedDiscoveryUrl('https://[::1]/register')).toBe(false);
    expect(isAllowedDiscoveryUrl('https://[fe80::1]/register')).toBe(false);
  });

  it('rejects hosts outside the allowlist', () => {
    expect(isAllowedDiscoveryUrl('https://evil.example.com/register')).toBe(false);
    expect(isAllowedDiscoveryUrl('https://attacker.com/register')).toBe(false);
    // 'notionsomething.com' must NOT match 'notion.com' by accident.
    expect(isAllowedDiscoveryUrl('https://notionx.com/register')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedDiscoveryUrl('not a url')).toBe(false);
    expect(isAllowedDiscoveryUrl('')).toBe(false);
    expect(isAllowedDiscoveryUrl('https://')).toBe(false);
  });

  it('treats 0.0.0.0 as private/loopback', () => {
    expect(isAllowedDiscoveryUrl('https://0.0.0.0/register')).toBe(false);
  });
});

describe('oauth/discovery — OAuthDiscoveryError', () => {
  it('carries code + message', () => {
    const err = new OAuthDiscoveryError('boom', 'ssrf_blocked');
    expect(err.code).toBe('ssrf_blocked');
    expect(err.name).toBe('OAuthDiscoveryError');
    expect(err.message).toBe('boom');
  });
});

describe('oauth/discovery — validateDiscoveryConfigs', () => {
  it('passes for the real OAUTH_PROVIDER_CONFIGS map', () => {
    // All discovery entries in types.ts must have an HTTPS discoveryBaseUrl.
    expect(() => validateDiscoveryConfigs()).not.toThrow();
  });
});

describe('oauth/discovery — fetchAuthorizationEndpointOnly', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    _resetCacheForTesting();
  });

  function stubFetchSequence(responses: Array<{ ok: boolean; body: unknown }>): void {
    let call = 0;
    global.fetch = (async (_url: string) => {
      const resp = responses[call++] ?? { ok: false, body: {} };
      return {
        ok: resp.ok,
        status: resp.ok ? 200 : 500,
        json: async () => resp.body,
        text: async () => JSON.stringify(resp.body),
      } as Response;
    }) as unknown as typeof fetch;
  }

  it('returns the authorization_endpoint from the well-known documents', async () => {
    stubFetchSequence([
      // Step 1: protected resource metadata
      { ok: true, body: { authorization_servers: ['https://mcp.notion.com'] } },
      // Step 2: authorization server metadata
      {
        ok: true,
        body: {
          issuer: 'https://mcp.notion.com',
          authorization_endpoint: 'https://mcp.notion.com/oauth/authorize',
          token_endpoint: 'https://mcp.notion.com/oauth/token',
        },
      },
    ]);
    const endpoint = await fetchAuthorizationEndpointOnly('notion');
    expect(endpoint).toBe('https://mcp.notion.com/oauth/authorize');
  });

  it('caches the result so subsequent calls skip the network', async () => {
    stubFetchSequence([
      { ok: true, body: { authorization_servers: ['https://mcp.notion.com'] } },
      {
        ok: true,
        body: {
          issuer: 'https://mcp.notion.com',
          authorization_endpoint: 'https://mcp.notion.com/oauth/authorize',
          token_endpoint: 'https://mcp.notion.com/oauth/token',
        },
      },
    ]);
    await fetchAuthorizationEndpointOnly('notion');
    // Second call — fetch should not be called again (no more stubs in sequence)
    const endpoint = await fetchAuthorizationEndpointOnly('notion');
    expect(endpoint).toBe('https://mcp.notion.com/oauth/authorize');
  });

  it('throws OAuthDiscoveryError for unknown provider', async () => {
    await expect(fetchAuthorizationEndpointOnly('not_a_real_provider')).rejects.toThrow(OAuthDiscoveryError);
  });

  it('falls back to the discovery base as authorization server when host-level protected-resource metadata is unavailable', async () => {
    // Some MCP servers scope PRM under the resource path (e.g. Clay.com:
    // /.well-known/oauth-protected-resource/v3/mcp), so the host-level path 404s.
    stubFetchSequence([
      // Step 1: host-level protected-resource metadata not found
      { ok: false, body: { error: 'not found' } },
      // Step 2: authorization-server metadata served directly at the discovery base
      {
        ok: true,
        body: {
          issuer: 'https://mcp.notion.com',
          authorization_endpoint: 'https://mcp.notion.com/oauth/authorize',
          token_endpoint: 'https://mcp.notion.com/oauth/token',
        },
      },
    ]);
    const endpoint = await fetchAuthorizationEndpointOnly('notion');
    expect(endpoint).toBe('https://mcp.notion.com/oauth/authorize');
  });

  it('throws when neither protected-resource nor authorization-server metadata is available', async () => {
    stubFetchSequence([
      { ok: false, body: { error: 'not found' } },
      { ok: false, body: { error: 'not found' } },
    ]);
    await expect(fetchAuthorizationEndpointOnly('notion')).rejects.toThrow();
  });

  it('SSRF: rejects authorization_endpoint not on allowlist', async () => {
    stubFetchSequence([
      { ok: true, body: { authorization_servers: ['https://mcp.notion.com'] } },
      {
        ok: true,
        body: {
          issuer: 'https://mcp.notion.com',
          authorization_endpoint: 'https://evil.example.com/authorize',
          token_endpoint: 'https://mcp.notion.com/oauth/token',
        },
      },
    ]);
    await expect(fetchAuthorizationEndpointOnly('notion')).rejects.toThrow(/not allowed/);
  });
});

// RFC 8414 §3.3: the metadata's issuer must match the server it was fetched
// from. Three vendors serve their authorization-server metadata on the MCP host
// but declare the issuer on another origin, so the expected issuer is pinned
// per provider in EXPECTED_ISSUER_BY_PROVIDER. The comparison stays exact — it
// is made against the pin instead of the fetched origin — and an unpinned
// provider is judged exactly as before.
describe('oauth/discovery — issuer pinning (getDiscoveredOAuthConfig)', () => {
  const originalFetch = global.fetch;
  const originalBackendUrl = process.env.BACKEND_URL;

  beforeEach(() => {
    process.env.BACKEND_URL = 'https://api-dev.example.com';
    adminQuery.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.BACKEND_URL = originalBackendUrl;
    _resetCacheForTesting();
  });

  function stubFetchByUrl(routes: Record<string, { ok: boolean; body: unknown }>): void {
    global.fetch = (async (url: string) => {
      const resp = routes[url] ?? { ok: false, body: { error: `unstubbed ${url}` } };
      return {
        ok: resp.ok,
        status: resp.ok ? 200 : 404,
        json: async () => resp.body,
        text: async () => JSON.stringify(resp.body),
      } as Response;
    }) as unknown as typeof fetch;
  }

  it('accepts a pinned provider whose metadata issuer matches the pin (omnisend)', async () => {
    // No cached DCR row, then the persisted row on registration.
    adminQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          client_id: 'omni-client',
          authorization_endpoint: 'https://app.omnisend.com/oauth/authorize',
          token_endpoint: 'https://app.omnisend.com/oauth/token',
        }],
      });
    stubFetchByUrl({
      'https://mcp.omnisend.com/.well-known/oauth-protected-resource': {
        ok: true, body: { authorization_servers: ['https://mcp.omnisend.com'] },
      },
      'https://mcp.omnisend.com/.well-known/oauth-authorization-server': {
        ok: true,
        body: {
          // Served by mcp.omnisend.com, issued by app.omnisend.com — the pin.
          issuer: 'https://app.omnisend.com',
          authorization_endpoint: 'https://app.omnisend.com/oauth/authorize',
          token_endpoint: 'https://app.omnisend.com/oauth/token',
          registration_endpoint: 'https://app.omnisend.com/oauth/register',
        },
      },
      'https://app.omnisend.com/oauth/register': { ok: true, body: { client_id: 'omni-client' } },
    });

    const config = await getDiscoveredOAuthConfig('omnisend');
    expect(config.clientId).toBe('omni-client');
    expect(config.authorizationEndpoint).toBe('https://app.omnisend.com/oauth/authorize');
  });

  it('still throws issuer_mismatch for an unpinned provider whose issuer is another origin', async () => {
    adminQuery.mockResolvedValueOnce({ rows: [] });
    stubFetchByUrl({
      'https://mcp.notion.com/.well-known/oauth-protected-resource': {
        ok: true, body: { authorization_servers: ['https://mcp.notion.com'] },
      },
      'https://mcp.notion.com/.well-known/oauth-authorization-server': {
        ok: true,
        body: {
          issuer: 'https://api.notion.com',
          authorization_endpoint: 'https://mcp.notion.com/oauth/authorize',
          token_endpoint: 'https://mcp.notion.com/oauth/token',
          registration_endpoint: 'https://mcp.notion.com/oauth/register',
        },
      },
    });

    await expect(getDiscoveredOAuthConfig('notion')).rejects.toMatchObject({
      name: 'OAuthDiscoveryError',
      code: 'issuer_mismatch',
    });
  });
});

describe('oauth/discovery — parseRegistrationResponse (DCR)', () => {
  const REG_ENDPOINT = 'https://mcp.datadoghq.com/api/unstable/mcp-server/register';

  it('accepts a standard absolute registration_client_uri', () => {
    const result = _parseRegistrationResponseForTesting(
      { client_id: 'abc', registration_client_uri: 'https://mcp.datadoghq.com/register/abc' },
      REG_ENDPOINT,
    );
    expect(result.registration_client_uri).toBe('https://mcp.datadoghq.com/register/abc');
  });

  it('resolves a relative registration_client_uri against the registration endpoint (Datadog pattern)', () => {
    const result = _parseRegistrationResponseForTesting(
      { client_id: 'mcp_abc123', registration_client_uri: '/api/unstable/mcp-server/register/mcp_abc123' },
      REG_ENDPOINT,
    );
    expect(result.registration_client_uri).toBe(
      'https://mcp.datadoghq.com/api/unstable/mcp-server/register/mcp_abc123',
    );
  });

  it('omits registration_client_uri when absent', () => {
    const result = _parseRegistrationResponseForTesting({ client_id: 'abc' }, REG_ENDPOINT);
    expect(result.registration_client_uri).toBeUndefined();
  });

  it('throws schema_invalid when client_id is missing', () => {
    expect(() => _parseRegistrationResponseForTesting({}, REG_ENDPOINT)).toThrow(OAuthDiscoveryError);
  });

  it('throws schema_invalid when registration_client_uri resolves to a non-HTTPS URL', () => {
    expect(() =>
      _parseRegistrationResponseForTesting(
        { client_id: 'abc', registration_client_uri: 'http://mcp.datadoghq.com/register/abc' },
        REG_ENDPOINT,
      ),
    ).toThrow(OAuthDiscoveryError);
  });

  it('parses service_redirect_uri when present and HTTPS (Datadog MCP pattern)', () => {
    const result = _parseRegistrationResponseForTesting(
      {
        client_id: 'mcp_abc',
        service_redirect_uri: 'https://mcp.datadoghq.com/api/unstable/mcp-server/redirect',
      },
      REG_ENDPOINT,
    );
    expect(result.service_redirect_uri).toBe(
      'https://mcp.datadoghq.com/api/unstable/mcp-server/redirect',
    );
  });

  it('omits service_redirect_uri when absent', () => {
    const result = _parseRegistrationResponseForTesting({ client_id: 'abc' }, REG_ENDPOINT);
    expect(result.service_redirect_uri).toBeUndefined();
  });

  it('omits service_redirect_uri when non-HTTPS', () => {
    const result = _parseRegistrationResponseForTesting(
      { client_id: 'abc', service_redirect_uri: 'http://insecure.example.com/redirect' },
      REG_ENDPOINT,
    );
    expect(result.service_redirect_uri).toBeUndefined();
  });
});

// RFC 8414 §3.1 — the well-known segment is INSERTED between host and path when
// the issuer carries one. Building `new URL('/.well-known/…', issuer)` instead
// DROPS the path, which 404'd every path-bearing authorization server and
// surfaced as "Invalid authorization-server metadata (issuer)" — the parse
// choking on a 404 body rather than anything about the issuer. Stripe
// (issuer https://access.stripe.com/mcp) was the first we hit.
describe('authServerMetadataUrls', () => {
  it('inserts the well-known segment before a path-bearing issuer, per RFC 8414', () => {
    const urls = authServerMetadataUrls('https://access.stripe.com/mcp');
    expect(urls[0]).toBe('https://access.stripe.com/.well-known/oauth-authorization-server/mcp');
  });

  it('still offers the OIDC-style suffix and the bare root as fallbacks', () => {
    const urls = authServerMetadataUrls('https://access.stripe.com/mcp');
    expect(urls).toContain('https://access.stripe.com/mcp/.well-known/oauth-authorization-server');
    expect(urls).toContain('https://access.stripe.com/.well-known/oauth-authorization-server');
  });

  it('emits exactly the root form for a pathless issuer', () => {
    expect(authServerMetadataUrls('https://app.attio.com')).toEqual([
      'https://app.attio.com/.well-known/oauth-authorization-server',
    ]);
  });

  it('treats a trailing slash as no path', () => {
    expect(authServerMetadataUrls('https://app.attio.com/')).toEqual([
      'https://app.attio.com/.well-known/oauth-authorization-server',
    ]);
  });
});
