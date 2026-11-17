// GitLab OAuth refresh tests — standard RFC 6749 refresh_token grant with
// rotation, expires_in → expiresAt translation, and invalid_grant mapping.

import { refreshGitlab } from './gitlab.js';
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

describe('oauth-providers/gitlab', () => {
  const args = {
    connectorId: 'c-gl',
    tenantId: 't-gl',
    connectorType: 'gitlab',
    refreshToken: 'gl-rt-old',
    scopes: ['api', 'read_user', 'read_repository', 'write_repository'],
  };

  beforeEach(() => {
    process.env.GITLAB_CLIENT_ID = 'gl-client';
    process.env.GITLAB_CLIENT_SECRET = 'gl-secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GITLAB_CLIENT_ID;
    delete process.env.GITLAB_CLIENT_SECRET;
  });

  it('refreshes and persists the rotated refresh_token', async () => {
    const calls = stubFetch({
      status: 200,
      body: {
        access_token: 'gl-at-new',
        refresh_token: 'gl-rt-new',
        token_type: 'Bearer',
        expires_in: 7200,
        scope: 'api read_user read_repository write_repository',
      },
    });
    const out = await refreshGitlab(args);
    expect(out.accessToken).toBe('gl-at-new');
    // GitLab rotates refresh_tokens — the NEW one must be stored, not the old.
    expect(out.refreshToken).toBe('gl-rt-new');
    expect(out.expiresAt).toBeDefined();
    // POST to the gitlab.com token endpoint with a refresh_token grant.
    expect(calls[0].url).toBe('https://gitlab.com/oauth/token');
    const sent = (calls[0].init.body as URLSearchParams).toString();
    expect(sent).toContain('grant_type=refresh_token');
    expect(sent).toContain('refresh_token=gl-rt-old');
    expect(sent).toContain('client_id=gl-client');
  });

  it('falls back to the 2h default when expires_in is omitted', async () => {
    stubFetch({
      status: 200,
      body: { access_token: 'gl-at-new', refresh_token: 'gl-rt-new' },
    });
    const out = await refreshGitlab(args);
    const delta = new Date(out.expiresAt!).getTime() - Date.now();
    // ~2 hours, allowing test-execution slack.
    expect(delta).toBeGreaterThan(110 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(120 * 60 * 1000);
  });

  it('preserves the prior refresh_token when the vendor omits a new one', async () => {
    stubFetch({ status: 200, body: { access_token: 'gl-at-new', expires_in: 7200 } });
    const out = await refreshGitlab(args);
    expect(out.refreshToken).toBe('gl-rt-old');
  });

  it('maps invalid_grant to reconnect_required', async () => {
    // A dead/rotated refresh token: gitlab.com returns 400 invalid_grant.
    stubFetch({ status: 400, body: { error: 'invalid_grant' } });
    await expect(refreshGitlab(args)).rejects.toMatchObject({
      reason: 'reconnect_required',
    });
  });

  it('throws OAuthRefreshError on missing client credentials', async () => {
    delete process.env.GITLAB_CLIENT_ID;
    await expect(refreshGitlab(args)).rejects.toBeInstanceOf(OAuthRefreshError);
  });
});
