// Microsoft (Entra) OAuth refresh tests.
//
// The "static-client, JSON body with expires_in, ROTATING refresh_token"
// pattern — the rotation is the material difference from Google. Also pins the
// catalog-coverage contract: every microsoft_* static_oauth connector must have
// this handler, since the absence of one is the exact bug this file fixes.

import { refreshMicrosoft, MICROSOFT_CONNECTOR_TYPES } from './microsoft.js';
import { OAuthRefreshError } from '../service.js';
import { CONNECTORS } from '../../catalog/connectors.js';

const originalFetch = global.fetch;

interface FakeFetchCall { url: string; init: RequestInit; }

function stubFetch(response: { status: number; body: unknown; ok?: boolean; throws?: Error }): FakeFetchCall[] {
  const calls: FakeFetchCall[] = [];
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (response.throws) throw response.throws;
    const text = JSON.stringify(response.body);
    return {
      ok: response.ok ?? (response.status >= 200 && response.status < 300),
      status: response.status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('oauth-providers/microsoft', () => {
  const baseArgs = {
    connectorId: 'c1',
    tenantId: 't1',
    connectorType: 'microsoft_teams',
    refreshToken: 'rt-old',
    scopes: ['Chat.ReadWrite', 'offline_access'],
  };

  beforeEach(() => {
    process.env.MICROSOFT_CLIENT_ID = 'ms-test-client';
    process.env.MICROSOFT_CLIENT_SECRET = 'ms-test-secret';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
  });

  it('persists the ROTATED refresh_token and posts to the v2.0 common endpoint', async () => {
    const calls = stubFetch({
      status: 200,
      body: { access_token: 'new-at', refresh_token: 'rt-new', expires_in: 3600, token_type: 'Bearer' },
    });
    const out = await refreshMicrosoft(baseArgs);
    expect(out.accessToken).toBe('new-at');
    // Microsoft rotates — the NEW refresh_token must be stored, or the next
    // refresh fails against an invalidated token.
    expect(out.refreshToken).toBe('rt-new');
    expect(out.expiresAt).toBeDefined();
    expect(calls[0].url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    const body = (calls[0].init.body as URLSearchParams).toString();
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=rt-old');
    expect(body).toContain('client_id=ms-test-client');
    // No scope sent — reuse the consented scopes, keep the rotated refresh token.
    expect(body).not.toContain('scope=');
  });

  it('falls back to the input refresh_token if the vendor omits one', async () => {
    stubFetch({ status: 200, body: { access_token: 'new-at', expires_in: 3600 } });
    const out = await refreshMicrosoft(baseArgs);
    expect(out.refreshToken).toBe('rt-old');
  });

  it('maps invalid_grant (HTTP 400) to reconnect_required', async () => {
    stubFetch({ status: 400, body: { error: 'invalid_grant', error_description: 'expired' } });
    try {
      await refreshMicrosoft(baseArgs);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
      expect((err as OAuthRefreshError).vendor).toBe('microsoft');
    }
  });

  it('maps HTTP 500 to vendor_unavailable', async () => {
    stubFetch({ status: 500, body: { error: 'server_error' } });
    try {
      await refreshMicrosoft(baseArgs);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('vendor_unavailable');
    }
  });

  it('throws unknown when env vars are missing', async () => {
    delete process.env.MICROSOFT_CLIENT_ID;
    try {
      await refreshMicrosoft(baseArgs);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('unknown');
      expect((err as OAuthRefreshError).message).toContain('MICROSOFT_CLIENT_ID');
    }
  });
});

describe('microsoft handler covers every microsoft_* static_oauth connector', () => {
  it('MICROSOFT_CONNECTOR_TYPES matches the catalog exactly', () => {
    const catalogMicrosoft = Object.entries(CONNECTORS)
      .filter(([, def]) => {
        const auth = (def as { auth?: { kind?: string; clientIdEnvVar?: string } }).auth;
        return auth?.kind === 'static_oauth' && auth?.clientIdEnvVar === 'MICROSOFT_CLIENT_ID';
      })
      .map(([type]) => type);
    // Equal sets: a catalog type without a handler ships broken (the bug); a
    // handler type not in the catalog is dead registration.
    expect(new Set(MICROSOFT_CONNECTOR_TYPES)).toEqual(new Set(catalogMicrosoft));
  });
});
