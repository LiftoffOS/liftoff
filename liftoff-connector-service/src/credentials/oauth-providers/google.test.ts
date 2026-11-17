// Google OAuth refresh tests.
//
// Representative of the "static-client, JSON body with expires_in,
// non-rotating refresh_token" pattern. Tests exercise:
//   - happy path
//   - invalid_grant → reconnect_required
//   - HTTP 5xx → vendor_unavailable
//   - malformed response (missing expires_in) → unknown
//   - env var missing → unknown

import { refreshGoogle } from './google.js';
import { OAuthRefreshError } from '../service.js';

const originalFetch = global.fetch;

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

function stubFetch(
  response: { status: number; body: unknown; ok?: boolean; throws?: Error },
): FakeFetchCall[] {
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

describe('oauth-providers/google', () => {
  const baseArgs = {
    connectorId: 'c1',
    tenantId: 't1',
    connectorType: 'google_drive',
    refreshToken: 'rt-old',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  };

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'google-test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'google-test-secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  it('returns new access_token and preserves refresh_token on happy path', async () => {
    const calls = stubFetch({
      status: 200,
      body: { access_token: 'new-at', expires_in: 3600, token_type: 'Bearer' },
    });
    const out = await refreshGoogle(baseArgs);
    expect(out.accessToken).toBe('new-at');
    // Google doesn't rotate refresh_tokens — fallback preserves the input.
    expect(out.refreshToken).toBe('rt-old');
    expect(out.tokenType).toBe('Bearer');
    expect(out.expiresAt).toBeDefined();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    const body = (calls[0].init.body as URLSearchParams).toString();
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=rt-old');
    expect(body).toContain('client_id=google-test-client');
  });

  it('maps invalid_grant to reconnect_required', async () => {
    stubFetch({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    });
    await expect(refreshGoogle(baseArgs)).rejects.toBeInstanceOf(OAuthRefreshError);
    try {
      await refreshGoogle(baseArgs);
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
      expect((err as OAuthRefreshError).vendor).toBe('google');
    }
  });

  it('maps HTTP 401 to reconnect_required', async () => {
    stubFetch({ status: 401, body: { error: 'unauthorized' } });
    try {
      await refreshGoogle(baseArgs);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
    }
  });

  it('maps HTTP 500 to vendor_unavailable', async () => {
    stubFetch({ status: 500, body: { error: 'server_error' } });
    try {
      await refreshGoogle(baseArgs);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('vendor_unavailable');
    }
  });

  it('maps network error to vendor_unavailable', async () => {
    stubFetch({ status: 0, body: null, throws: new Error('ECONNRESET') });
    try {
      await refreshGoogle(baseArgs);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('vendor_unavailable');
    }
  });

  it('throws unknown when expires_in is missing', async () => {
    stubFetch({ status: 200, body: { access_token: 'new-at' } });
    try {
      await refreshGoogle(baseArgs);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('unknown');
    }
  });

  it('throws unknown when env vars missing', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      await refreshGoogle(baseArgs);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('unknown');
      expect((err as OAuthRefreshError).message).toContain('GOOGLE_CLIENT_ID');
    }
  });
});
