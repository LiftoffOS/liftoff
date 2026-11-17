// Atlassian OAuth refresh tests.
//
// Exercises the JSON-body pattern (Atlassian rejects form-encoded) and
// confirms refresh_token rotation is preserved. Both Jira and Confluence
// route through the same handler.

import { refreshAtlassian, ATLASSIAN_CONNECTOR_TYPES } from './atlassian.js';
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

describe('oauth-providers/atlassian', () => {
  const args = {
    connectorId: 'c5',
    tenantId: 't5',
    connectorType: 'atlassian_jira',
    refreshToken: 'atl-rt-old',
    scopes: ['read:jira-work'],
  };

  beforeEach(() => {
    process.env.ATLASSIAN_CLIENT_ID = 'atl-client';
    process.env.ATLASSIAN_CLIENT_SECRET = 'atl-secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.ATLASSIAN_CLIENT_ID;
    delete process.env.ATLASSIAN_CLIENT_SECRET;
  });

  it('sends JSON body and rotates refresh_token', async () => {
    const calls = stubFetch({
      status: 200,
      body: {
        access_token: 'atl-at-new',
        refresh_token: 'atl-rt-new',
        expires_in: 3600,
      },
    });
    const out = await refreshAtlassian(args);
    expect(out.accessToken).toBe('atl-at-new');
    expect(out.refreshToken).toBe('atl-rt-new');
    expect(calls[0].url).toBe('https://auth.atlassian.com/oauth/token');
    expect(calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.grant_type).toBe('refresh_token');
    expect(body.client_id).toBe('atl-client');
  });

  it('registers both jira and confluence handlers', () => {
    expect(ATLASSIAN_CONNECTOR_TYPES).toContain('atlassian_jira');
    expect(ATLASSIAN_CONNECTOR_TYPES).toContain('atlassian_confluence');
  });

  it('invalid_grant → reconnect_required', async () => {
    stubFetch({ status: 403, body: { error: 'invalid_grant', error_description: 'refresh token expired' } });
    try {
      await refreshAtlassian(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
    }
  });

  it('HTTP 503 → vendor_unavailable', async () => {
    stubFetch({ status: 503, body: {} });
    try {
      await refreshAtlassian(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('vendor_unavailable');
    }
  });
});
