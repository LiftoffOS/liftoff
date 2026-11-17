// Salesforce OAuth refresh tests.
//
// Representative of "non-rotating refresh_token + instance_url threaded
// through". Salesforce always returns the org's instance_url on refresh;
// we must persist it so downstream API calls route correctly.

import { refreshSalesforce } from './salesforce.js';
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

describe('oauth-providers/salesforce', () => {
  const args = {
    connectorId: 'c6',
    tenantId: 't6',
    connectorType: 'salesforce',
    refreshToken: 'sfdc-rt',
    scopes: ['api', 'refresh_token'],
  };

  beforeEach(() => {
    process.env.SALESFORCE_CLIENT_ID = 'sfdc-client';
    process.env.SALESFORCE_CLIENT_SECRET = 'sfdc-secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SALESFORCE_CLIENT_ID;
    delete process.env.SALESFORCE_CLIENT_SECRET;
  });

  it('threads instance_url from the response into the secret', async () => {
    stubFetch({
      status: 200,
      body: {
        access_token: 'sfdc-at-new',
        instance_url: 'https://acme.my.salesforce.com',
        token_type: 'Bearer',
        issued_at: '0',
      },
    });
    const out = await refreshSalesforce(args);
    expect(out.accessToken).toBe('sfdc-at-new');
    expect(out.instanceUrl).toBe('https://acme.my.salesforce.com');
    // Salesforce doesn't rotate the refresh_token
    expect(out.refreshToken).toBe('sfdc-rt');
  });

  it('invalid_grant → reconnect_required', async () => {
    stubFetch({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'expired access/refresh token' },
    });
    try {
      await refreshSalesforce(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
    }
  });

  it('HTTP 502 → vendor_unavailable', async () => {
    stubFetch({ status: 502, body: {} });
    try {
      await refreshSalesforce(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('vendor_unavailable');
    }
  });
});
