// Square OAuth refresh tests — validates the ISO `expires_at`
// translation and the Square-specific headers.

import { refreshSquare } from './square.js';
import { OAuthRefreshError } from '../service.js';

const originalFetch = global.fetch;

function stubFetch(resp: { status: number; body: unknown }): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      text: async () => JSON.stringify(resp.body),
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('oauth-providers/square', () => {
  const args = {
    connectorId: 'c7',
    tenantId: 't7',
    connectorType: 'square',
    refreshToken: 'sq-rt-old',
    scopes: ['MERCHANT_PROFILE_READ'],
  };

  beforeEach(() => {
    process.env.SQUARE_CLIENT_ID = 'sq-client';
    process.env.SQUARE_CLIENT_SECRET = 'sq-secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SQUARE_CLIENT_ID;
    delete process.env.SQUARE_CLIENT_SECRET;
  });

  it('translates ISO expires_at to expiresAt', async () => {
    const iso = '2030-01-01T00:00:00Z';
    const calls = stubFetch({
      status: 200,
      body: {
        access_token: 'sq-at-new',
        refresh_token: 'sq-rt-new',
        expires_at: iso,
      },
    });
    const out = await refreshSquare(args);
    expect(out.accessToken).toBe('sq-at-new');
    expect(out.refreshToken).toBe('sq-rt-new');
    expect(out.expiresAt).toBe(new Date(iso).toISOString());
    expect(calls[0].init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Square-Version': '2024-01-17',
    });
  });

  it('falls back to 30-day expiry when expires_at missing', async () => {
    stubFetch({
      status: 200,
      body: { access_token: 'sq-at-new', refresh_token: 'sq-rt-new' },
    });
    const out = await refreshSquare(args);
    expect(out.expiresAt).toBeDefined();
    // ~30 days from now
    const delta = new Date(out.expiresAt!).getTime() - Date.now();
    expect(delta).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });

  it('invalid_grant → reconnect_required', async () => {
    stubFetch({ status: 401, body: { error: 'invalid_grant' } });
    try {
      await refreshSquare(args);
      fail('should have thrown');
    } catch (err) {
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
    }
  });
});
