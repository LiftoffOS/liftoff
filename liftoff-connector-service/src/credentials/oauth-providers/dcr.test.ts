// DCR refresh tests.
//
// Representative of two things at once:
//   1. Notion-style rotating refresh_token — buildSecretData must pick
//      the new refresh_token from the response, not the old one.
//   2. The DCR path itself — client_id is read from the
//      oauth_dynamic_registrations table via withAdminScope, not env vars.
//
// We inject a stub DCR lookup via `__setDcrLookup` so the tests don't
// touch Postgres.

import { refreshDcr, __setDcrLookup, assertAllowedTokenEndpoint, resolveTokenEndpoint, DCR_CONNECTOR_TYPES, DCR_ISSUER_BY_TYPE } from './dcr.js';
import { OAuthRefreshError } from '../service.js';

const originalFetch = global.fetch;

function stubFetch(resp: { status: number; body: unknown; throws?: Error }): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (resp.throws) throw resp.throws;
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      text: async () => JSON.stringify(resp.body),
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('oauth-providers/dcr — Notion (rotating refresh_token)', () => {
  const args = {
    connectorId: 'c4',
    tenantId: 't4',
    connectorType: 'notion',
    refreshToken: 'notion-rt-old',
    scopes: [],
  };

  beforeEach(() => {
    __setDcrLookup(async () => ({
      clientId: 'notion-dcr-client',
      clientSecret: 'notion-dcr-secret',
      tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    __setDcrLookup(null);
  });

  it('persists the ROTATED refresh_token from the response', async () => {
    const calls = stubFetch({
      status: 200,
      body: {
        access_token: 'notion-at-new',
        refresh_token: 'notion-rt-rotated',
        expires_in: 3600,
      },
    });
    const out = await refreshDcr(args);
    expect(out.accessToken).toBe('notion-at-new');
    expect(out.refreshToken).toBe('notion-rt-rotated'); // must NOT be the old one
    expect(calls[0].url).toBe('https://api.notion.com/v1/oauth/token');
    const body = (calls[0].init.body as URLSearchParams).toString();
    expect(body).toContain('client_id=notion-dcr-client');
    expect(body).toContain('refresh_token=notion-rt-old');
  });

  it('falls back to old refresh_token when vendor omits rotation', async () => {
    stubFetch({
      status: 200,
      body: { access_token: 'notion-at-new', expires_in: 3600 },
    });
    const out = await refreshDcr(args);
    expect(out.refreshToken).toBe('notion-rt-old');
  });

  it('maps invalid_grant to reconnect_required', async () => {
    stubFetch({ status: 400, body: { error: 'invalid_grant' } });
    try {
      await refreshDcr(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
    }
  });

  it('maps HTTP 502 to vendor_unavailable', async () => {
    stubFetch({ status: 502, body: {} });
    try {
      await refreshDcr(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('vendor_unavailable');
    }
  });

  it('reconnect_required when DCR row is missing', async () => {
    __setDcrLookup(async () => {
      throw new OAuthRefreshError('reconnect_required', 'no DCR row', {
        connectorId: 'c4', tenantId: 't4', vendor: 'notion',
      });
    });
    try {
      await refreshDcr(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
    }
  });

  it('works with public client (no client_secret)', async () => {
    __setDcrLookup(async () => ({
      clientId: 'notion-public',
      clientSecret: null,
      tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
    }));
    const calls = stubFetch({
      status: 200,
      body: { access_token: 'at', expires_in: 3600 },
    });
    await refreshDcr(args);
    const body = (calls[0].init.body as URLSearchParams).toString();
    expect(body).toContain('client_id=notion-public');
    expect(body).not.toContain('client_secret=');
  });
});

describe('oauth-providers/dcr — SSRF guards', () => {
  const ctx = { connectorId: 'c', tenantId: 't', vendor: 'notion' };

  it('rejects non-https endpoints', () => {
    expect(() =>
      assertAllowedTokenEndpoint('http://api.notion.com/v1/oauth/token', ctx),
    ).toThrow(/must be https/);
  });

  it('rejects hosts not on the allowlist', () => {
    expect(() =>
      assertAllowedTokenEndpoint('https://evil.example.com/token', ctx),
    ).toThrow(/not in allowlist/);
  });

  it('accepts subdomains of allowlisted hosts', () => {
    expect(() =>
      assertAllowedTokenEndpoint('https://api.notion.com/v1/oauth/token', ctx),
    ).not.toThrow();
    expect(() =>
      assertAllowedTokenEndpoint('https://app.datadoghq.com/oauth2/v1/token', ctx),
    ).not.toThrow();
  });

  it('rejects malformed URLs', () => {
    expect(() =>
      assertAllowedTokenEndpoint('not-a-url', ctx),
    ).toThrow(/not a valid URL/);
  });
});

describe('oauth-providers/dcr — token endpoint resolution', () => {
  it('resolves per-vendor token endpoints', () => {
    expect(resolveTokenEndpoint('notion')).toBe('https://api.notion.com/v1/oauth/token');
    expect(resolveTokenEndpoint('linear')).toBe('https://api.linear.app/oauth/token');
    expect(resolveTokenEndpoint('calendly')).toBe('https://auth.calendly.com/oauth/token');
    expect(resolveTokenEndpoint('asana')).toBe('https://app.asana.com/-/oauth_token');
    expect(resolveTokenEndpoint('paypal')).toBe('https://api-m.paypal.com/v1/oauth2/token');
    expect(resolveTokenEndpoint('clay')).toBe('https://api.clay.com/oauth/token');
    expect(resolveTokenEndpoint('mesh')).toBe('https://mcp.clay.earth/token');
  });
});

// mcp.clay.earth is the Mesh (formerly Clay.earth) endpoint after the clay→clay.com split.
describe('oauth-providers/dcr — Mesh refresh', () => {
  const args = {
    connectorId: 'mesh-connector-1',
    tenantId: 'tenant-mesh',
    connectorType: 'mesh',
    refreshToken: 'clay-rt-old',
    scopes: ['read', 'write'],
  };

  beforeEach(() => {
    __setDcrLookup(async () => ({
      clientId: 'clay-dcr-client',
      clientSecret: null, // public client
      tokenEndpoint: 'https://mcp.clay.earth/token',
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    __setDcrLookup(null);
  });

  it('sends refresh_token grant to mcp.clay.earth/token without client_secret', async () => {
    const calls = stubFetch({
      status: 200,
      body: { access_token: 'clay-at-new', expires_in: 3600 },
    });
    const out = await refreshDcr(args);
    expect(out.accessToken).toBe('clay-at-new');
    expect(out.refreshToken).toBe('clay-rt-old');
    expect(calls[0].url).toBe('https://mcp.clay.earth/token');
    const body = (calls[0].init.body as URLSearchParams).toString();
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_id=clay-dcr-client');
    expect(body).toContain('refresh_token=clay-rt-old');
    expect(body).not.toContain('client_secret=');
  });

  it('preserves scopes from the original grant', async () => {
    stubFetch({ status: 200, body: { access_token: 'clay-at', expires_in: 3600 } });
    const out = await refreshDcr(args);
    expect(out.scopes).toEqual(['read', 'write']);
  });

  it('SSRF: rejects a tampered token endpoint outside the allowlist', () => {
    const ctx = { connectorId: 'c', tenantId: 't', vendor: 'clay' };
    expect(() =>
      assertAllowedTokenEndpoint('https://evil.example.com/token', ctx),
    ).toThrow(/not in allowlist/);
  });

  it('SSRF: accepts mcp.clay.earth token endpoint', () => {
    const ctx = { connectorId: 'c', tenantId: 't', vendor: 'clay' };
    expect(() =>
      assertAllowedTokenEndpoint('https://mcp.clay.earth/token', ctx),
    ).not.toThrow();
  });
});

// RATCHET: every dcr_oauth connector must have a refresh handler.
//
// A DCR token expires. Without a handler the first refresh throws
// "No OAuth refresh handler registered for <type>", which is classified
// reconnect_required, so the connector dies roughly an hour after it was
// connected — long after anyone is still watching. Stripe did exactly that on
// its first real connection: connected 07:39, error 08:35, one failure.
//
// Eight of fifteen were missing when that was found, so this is a class, not a
// vendor. Adding a dcr_oauth connector without registering it here is the same
// bug again, and this test is what stops it reaching a customer.
describe('every dcr_oauth connector has a refresh handler', () => {
  it('leaves no dcr_oauth connector unregistered', async () => {
    const { CONNECTORS } = await import('../../catalog/connectors.js');
    const dcrTypes = Object.entries(CONNECTORS)
      .filter(([, def]) => (def as { auth?: { kind?: string } }).auth?.kind === 'dcr_oauth')
      .map(([type]) => type);

    expect(dcrTypes.length).toBeGreaterThan(0);
    const missing = dcrTypes.filter((t) => !DCR_CONNECTOR_TYPES.includes(t));
    expect(missing).toEqual([]);
  });

  it('gives every registered type an issuer, since dcrLookup throws without one', () => {
    const noIssuer = DCR_CONNECTOR_TYPES.filter((t) => !DCR_ISSUER_BY_TYPE[t]);
    expect(noIssuer).toEqual([]);
  });
});
