// HubSpot OAuth refresh tests.
//
// Representative of the "application/x-www-form-urlencoded" pattern.
// HubSpot rotates refresh_tokens and flags failure via either
// `status:"error"` or the standard `error` code.

import { refreshHubSpot } from './hubspot.js';
import { OAuthRefreshError } from '../service.js';

const originalFetch = global.fetch;

function stubFetch(response: {
  status: number;
  body: unknown;
  throws?: Error;
}): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (response.throws) throw response.throws;
    const text = JSON.stringify(response.body);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('oauth-providers/hubspot', () => {
  const args = {
    connectorId: 'c2',
    tenantId: 't2',
    connectorType: 'hubspot',
    refreshToken: 'hs-rt-old',
    scopes: ['contacts'],
  };

  beforeEach(() => {
    process.env.HUBSPOT_CLIENT_ID = 'hs-client';
    process.env.HUBSPOT_CLIENT_SECRET = 'hs-secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.HUBSPOT_CLIENT_ID;
    delete process.env.HUBSPOT_CLIENT_SECRET;
  });

  it('sends form-encoded body and rotates refresh_token', async () => {
    const calls = stubFetch({
      status: 200,
      body: {
        access_token: 'new-hs-at',
        refresh_token: 'new-hs-rt',
        expires_in: 1800,
      },
    });
    const out = await refreshHubSpot(args);
    expect(out.accessToken).toBe('new-hs-at');
    expect(out.refreshToken).toBe('new-hs-rt'); // rotation preserved
    expect(calls[0].url).toBe('https://api.hubapi.com/oauth/v1/token');
    expect(calls[0].init.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(calls[0].init.body).toBeInstanceOf(URLSearchParams);
  });

  it('maps status:"error" to vendor_unavailable / unknown even on 200', async () => {
    stubFetch({
      status: 200,
      body: { status: 'error', message: 'something broke', access_token: undefined },
    });
    try {
      await refreshHubSpot(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('unknown');
    }
  });

  it('maps invalid_grant to reconnect_required', async () => {
    stubFetch({ status: 400, body: { error: 'invalid_grant', error_description: 'dead' } });
    try {
      await refreshHubSpot(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
    }
  });

  it('maps HTTP 503 to vendor_unavailable', async () => {
    stubFetch({ status: 503, body: {} });
    try {
      await refreshHubSpot(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('vendor_unavailable');
    }
  });

  it('preserves old refresh_token when HubSpot does not rotate', async () => {
    stubFetch({
      status: 200,
      body: { access_token: 'new-hs-at', expires_in: 1800 },
    });
    const out = await refreshHubSpot(args);
    expect(out.refreshToken).toBe('hs-rt-old');
  });
});
