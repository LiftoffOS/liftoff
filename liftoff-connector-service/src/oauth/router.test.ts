// Tests for the OAuth router — PKCE flow, CSRF state handling, and
// static-provider callback.
//
// DB + Secret Manager are stubbed. Network fetch for token exchange is
// monkey-patched on global fetch so the callback path can run end-to-end.

import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { jest } from '@jest/globals';

// Stub the audit publisher so callback success fires (which emit
// publishAuditEvent for connector.created / connector.updated) don't try
// to reach Pub/Sub and stall the test until jest timeout. ts-jest hoists
// jest.mock() above imports at module-init time, so the mock is in
// place before `router.js` resolves its publisher import.
jest.mock('../events/audit-publisher.js', () => ({
  publishAuditEvent: jest.fn(() => Promise.resolve()),
}));

// emitCredentialsStored is deliberately fire-and-forget in the callback handler
// (it must never block or fail an OAuth callback), so its PubSub publish can
// still be resolving when jest tears the environment down — which surfaces as a
// "trying to import a file after the Jest environment has been torn down"
// ReferenceError whose appearance depends purely on test timing. Stub the one
// export the router uses and leave the rest of the module real.
jest.mock('../events/publisher.js', () => {
  const actual = jest.requireActual('../events/publisher.js') as Record<string, unknown>;
  return { ...actual, emitCredentialsStored: jest.fn() };
});

import {
  buildAuthUrl,
  exchangeCodeForTokens,
  oauthRouter,
  type TokenResponse,
} from './router.js';
import type { OAuthProviderConfig } from '../types.js';
import { OAUTH_PROVIDER_CONFIGS } from '../types.js';

import * as ops from './connector-ops.js';
import * as discovery from './discovery.js';
import { credentialService } from '../credentials/service.js';

function makeApp(): express.Express {
  const app = express();
  app.use('/api/connectors/oauth', express.json(), oauthRouter);
  return app;
}

function startServer(): Promise<{ server: http.Server; url: string }> {
  const app = makeApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

describe('oauth/router — buildAuthUrl', () => {
  it('builds a google URL with offline + prompt=consent', () => {
    const config = OAUTH_PROVIDER_CONFIGS.google as Extract<
      OAuthProviderConfig,
      { kind: 'static' }
    >;
    const url = buildAuthUrl('google', config, {
      clientId: 'cid',
      redirectUri: 'https://app/callback',
      scopes: ['email', 'profile'],
      state: 'abc',
    });
    expect(url).toContain('client_id=cid');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('scope=email+profile');
    expect(url).toContain('state=abc');
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
  });

  it('includes code_challenge for HubSpot when PKCE verifier present', () => {
    const config = OAUTH_PROVIDER_CONFIGS.hubspot;
    const url = buildAuthUrl('hubspot', config, {
      clientId: 'cid',
      redirectUri: 'https://app/callback',
      scopes: ['contacts'],
      state: 'abc',
      codeChallenge: 'challenge123',
    });
    expect(url).toContain('code_challenge=challenge123');
    expect(url).toContain('code_challenge_method=S256');
  });

  it('omits code_challenge when not provided (no PKCE)', () => {
    const config = OAUTH_PROVIDER_CONFIGS.github;
    const url = buildAuthUrl('github', config, {
      clientId: 'cid',
      redirectUri: 'https://app/callback',
      scopes: ['repo'],
      state: 'abc',
    });
    expect(url).not.toContain('code_challenge');
  });

  it('respects an overridden authBaseUrl (discovery case)', () => {
    const config = OAUTH_PROVIDER_CONFIGS.notion;
    const url = buildAuthUrl('notion', config, {
      clientId: 'cid',
      redirectUri: 'https://app/callback',
      scopes: [],
      state: 'abc',
      codeChallenge: 'cc',
      authBaseUrl: 'https://mcp.notion.com/authorize',
    });
    expect(url.startsWith('https://mcp.notion.com/authorize?')).toBe(true);
    expect(url).toContain('owner=user');
    expect(url).toContain('code_challenge=cc');
  });

  it('includes scope=mcp and PKCE for Clay.com (authorize requires scope)', () => {
    const config = OAUTH_PROVIDER_CONFIGS.clay;
    const url = buildAuthUrl('clay', config, {
      clientId: 'cid',
      redirectUri: 'https://app/callback',
      scopes: ['mcp'],
      state: 'abc',
      codeChallenge: 'cc',
      authBaseUrl: 'https://app.clay.com/oauth/authorize',
    });
    expect(url.startsWith('https://app.clay.com/oauth/authorize?')).toBe(true);
    expect(url).toContain('response_type=code');
    expect(url).toContain('scope=mcp');
    expect(url).toContain('code_challenge=cc');
    expect(url).toContain('code_challenge_method=S256');
  });

  it('includes scope for Mesh authorize', () => {
    const config = OAUTH_PROVIDER_CONFIGS.mesh;
    const url = buildAuthUrl('mesh', config, {
      clientId: 'cid',
      redirectUri: 'https://app/callback',
      scopes: ['read', 'write'],
      state: 'abc',
      codeChallenge: 'cc',
      authBaseUrl: 'https://mcp.clay.earth/authorize',
    });
    expect(url).toContain('scope=read+write');
    expect(url).toContain('code_challenge=cc');
  });

  it('sends scope=mcp AND PKCE for stripe, which authenticates by DCR', () => {
    // Stripe's case predated DCR: it set response_type + scope with no
    // code_challenge, so a live /start produced `scope=read_write` (the Connect
    // scope its DCR client was never granted) and no PKCE at all — against an
    // authorization server advertising S256 and token_endpoint_auth_method
    // `none`. A public client with no PKCE is what that combination forbids.
    const url = buildAuthUrl('stripe', OAUTH_PROVIDER_CONFIGS.stripe as OAuthProviderConfig, {
      clientId: 'oacli_test',
      redirectUri: 'https://backend.test/api/connectors/oauth/callback',
      state: 'st',
      scopes: ['mcp'],
      authBaseUrl: 'https://access.stripe.com/mcp/oauth2/authorize',
      codeChallenge: 'challenge_value',
    });
    const q = new URL(url).searchParams;
    expect(q.get('scope')).toBe('mcp');
    expect(q.get('code_challenge')).toBe('challenge_value');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('response_type')).toBe('code');
  });

  it('emits response_type=code (RFC default) + PKCE for a discovery provider not explicitly cased', () => {
    // Regression: buildAuthUrl had no `default` branch, so any dcr_oauth provider
    // not hardcoded in the switch produced an authorize URL with only
    // client_id/redirect_uri/state — missing the mandatory response_type. Vendors
    // reject it with "No authorization response type provided" (observed live for
    // supermetrics/ahrefs/similarweb/common_room).
    const config = OAUTH_PROVIDER_CONFIGS.supermetrics;
    const url = buildAuthUrl('supermetrics', config, {
      clientId: 'cid',
      redirectUri: 'https://app/callback',
      scopes: [],
      state: 'abc',
      codeChallenge: 'cc',
      authBaseUrl: 'https://api.supermetrics.com/oauth/authorize',
    });
    expect(url).toContain('response_type=code');
    expect(url).toContain('code_challenge=cc');
    expect(url).toContain('code_challenge_method=S256');
  });
});

describe('oauth/router — exchangeCodeForTokens expiry fix-ups', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sets long expiry for GitHub when server omits expires_in', async () => {
    const config = OAUTH_PROVIDER_CONFIGS.github;
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ access_token: 'gh_tok' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const resp: TokenResponse = await exchangeCodeForTokens('github', config, {
      code: 'x',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: 'r',
    });
    expect(resp.access_token).toBe('gh_tok');
    expect(resp.expires_in).toBe(365 * 24 * 60 * 60);
  });

  it('moves Slack authed_user.access_token to top-level for user_scope flows', async () => {
    const config = OAUTH_PROVIDER_CONFIGS.slack;
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          authed_user: { id: 'U1', access_token: 'xoxp-user', token_type: 'user', scope: 'channels:read' },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const resp = await exchangeCodeForTokens('slack', config, {
      code: 'x',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: 'r',
    });
    expect(resp.access_token).toBe('xoxp-user');
    expect(resp.expires_in).toBe(365 * 24 * 60 * 60);
  });

  it('preserves the Slack BOT token alongside the user-token swap (dual grant)', async () => {
    const config = OAUTH_PROVIDER_CONFIGS.slack;
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          access_token: 'xoxb-bot',
          bot_user_id: 'UBOT',
          team: { id: 'T1', name: 'Acme' },
          authed_user: { id: 'U1', access_token: 'xoxp-user', token_type: 'user', scope: 'channels:read' },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const resp = await exchangeCodeForTokens('slack', config, {
      code: 'x',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: 'r',
    });
    // Connector credential = user token; the bot half survives for the
    // platform-backend workspace-install handoff.
    expect(resp.access_token).toBe('xoxp-user');
    expect(resp.slack_bot_access_token).toBe('xoxb-bot');
    expect(resp.bot_user_id).toBe('UBOT');
    expect(resp.team).toEqual({ id: 'T1', name: 'Acme' });
  });

  it('maps Slack ok=false to a generic error string', async () => {
    const config = OAUTH_PROVIDER_CONFIGS.slack;
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ ok: false }), { status: 200 }),
    ) as unknown as typeof fetch;
    const resp = await exchangeCodeForTokens('slack', config, {
      code: 'x',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: 'r',
    });
    expect(resp.error).toBe('slack_oauth_failed');
  });

  it('falls back to 30min expiry for Xero when server omits it', async () => {
    const config = OAUTH_PROVIDER_CONFIGS.xero;
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ access_token: 'xero_tok' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const resp = await exchangeCodeForTokens('xero', config, {
      code: 'x',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: 'r',
    });
    expect(resp.expires_in).toBe(30 * 60);
  });
});

describe('oauth/router — HTTP endpoints', () => {
  const SAVED_ENV = { ...process.env };

  beforeEach(() => {
    // deterministic redirect destinations
    process.env.FRONTEND_URL = 'https://app.test';
    process.env.BACKEND_URL = 'https://backend.test';
    process.env.GITHUB_CLIENT_ID = 'gh_client';
    process.env.GITHUB_CLIENT_SECRET = 'gh_secret';
    process.env.GOOGLE_CLIENT_ID = 'g_client';
    process.env.GOOGLE_CLIENT_SECRET = 'g_secret';
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
    jest.restoreAllMocks();
  });

  it('rejects start call without tenantId', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/oauth/github/start')
        .set('x-account-id', 'acct_1')
        .send({ returnUrl: 'https://app.test/done' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tenantId/);
    } finally {
      server.close();
    }
  });

  it('rejects start call without x-account-id header', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/oauth/github/start')
        .query({ tenantId: 't1' })
        .send({ returnUrl: 'https://app.test/done' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Authentication/);
    } finally {
      server.close();
    }
  });

  it('rejects unsupported connector type', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/oauth/nope/start')
        .set('x-account-id', 'acct_1')
        .query({ tenantId: 't1' })
        .send({ returnUrl: 'https://app.test/done' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unsupported/);
    } finally {
      server.close();
    }
  });

  it('returns authUrl + state for a static OAuth provider', async () => {
    jest.spyOn(ops, 'createOAuthState').mockResolvedValue({
      id: 'state_id',
      state: 'the_state',
      tenantId: 't1',
      accountId: 'acct_1',
      connectorType: 'github',
      scopes: [],
      redirectUri: 'https://app.test/done',
      codeVerifier: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });

    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/oauth/github/start')
        .set('x-account-id', 'acct_1')
        .query({ tenantId: 't1' })
        .send({ returnUrl: 'https://app.test/done' });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('the_state');
      expect(res.body.authUrl).toContain('github.com/login/oauth/authorize');
      expect(res.body.authUrl).toContain('state=the_state');
    } finally {
      server.close();
    }
  });

  // ── DCR client override is local-dev-only ───────────────────────────
  //
  // A pinned clientIdEnvVar on a discovery (DCR) provider must NOT survive into
  // a deployed service. If it does, DCR never runs for that provider, the
  // pinned client is used forever, and the day the vendor expires it the
  // authorize step 401s `invalid_client` in the user's browser with nothing on
  // our side able to notice or heal it.
  //
  // K_SERVICE is injected by the Cloud Run runtime, so it is the deployed/local
  // discriminator.
  describe('DCR client override', () => {
    function mockAttioState() {
      jest.spyOn(ops, 'createOAuthState').mockResolvedValue({
        id: 'state_id',
        state: 'the_state',
        tenantId: 't1',
        accountId: 'acct_1',
        connectorType: 'attio',
        scopes: ['mcp', 'offline_access'],
        redirectUri: 'https://app.test/done',
        codeVerifier: 'verifier',
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      });
    }

    async function startAttio(): Promise<string> {
      const { server, url } = await startServer();
      try {
        const res = await request(url)
          .post('/api/connectors/oauth/attio/start')
          .set('x-account-id', 'acct_1')
          .query({ tenantId: 't1' })
          .send({ returnUrl: 'https://app.test/done' });
        expect(res.status).toBe(200);
        return res.body.authUrl as string;
      } finally {
        server.close();
      }
    }

    it('honours the env override off Cloud Run (local dev)', async () => {
      delete process.env.K_SERVICE;
      process.env.ATTIO_CLIENT_ID = 'pinned_client';
      mockAttioState();
      const endpointOnly = jest
        .spyOn(discovery, 'fetchAuthorizationEndpointOnly')
        .mockResolvedValue('https://app.attio.com/oidc/authorize');
      const dcr = jest.spyOn(discovery, 'getDiscoveredOAuthConfig');

      const authUrl = await startAttio();

      expect(authUrl).toContain('client_id=pinned_client');
      expect(endpointOnly).toHaveBeenCalled();
      expect(dcr).not.toHaveBeenCalled();
    });

    it('ignores the env override on Cloud Run and uses DCR instead', async () => {
      process.env.K_SERVICE = 'connector-service';
      process.env.ATTIO_CLIENT_ID = 'pinned_client';
      mockAttioState();
      const endpointOnly = jest.spyOn(discovery, 'fetchAuthorizationEndpointOnly');
      const dcr = jest
        .spyOn(discovery, 'getDiscoveredOAuthConfig')
        .mockResolvedValue({
          authorizationEndpoint: 'https://app.attio.com/oidc/authorize',
          tokenEndpoint: 'https://app.attio.com/oidc/token',
          clientId: 'registered_client',
        });

      const authUrl = await startAttio();

      expect(authUrl).toContain('client_id=registered_client');
      expect(authUrl).not.toContain('pinned_client');
      expect(dcr).toHaveBeenCalledWith('attio');
      expect(endpointOnly).not.toHaveBeenCalled();
    });
  });

  it('legacy GET start returns 410 Gone', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .get('/api/connectors/oauth/github/start')
        .set('x-account-id', 'acct_1');
      expect(res.status).toBe(410);
      expect(res.body.migration).toBe('SE-003');
    } finally {
      server.close();
    }
  });

  it('callback redirects with invalid_state when state is not in DB', async () => {
    jest.spyOn(ops, 'verifyOAuthState').mockResolvedValue(null);

    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .get('/api/connectors/oauth/callback')
        .query({ code: 'c', state: 'bogus' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=invalid_state');
    } finally {
      server.close();
    }
  });

  it('callback errors when no code+state provided', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/oauth/callback');
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  // Helper to mock the OAuth state + Google userinfo fetch.
  function setupGoogleOAuthMock(email: string) {
    jest.spyOn(ops, 'verifyOAuthState').mockResolvedValue({
      id: 'sid',
      state: 'the_state',
      tenantId: 't1',
      accountId: 'a1',
      connectorType: 'google_mail',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      redirectUri: 'https://app.test/done',
      codeVerifier: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/oauth2/v2/userinfo')) {
        return new Response(
          JSON.stringify({ id: `google-${email}`, email }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ access_token: 'g_tok', refresh_token: 'r_tok', expires_in: 3600 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return () => { global.fetch = originalFetch; };
  }

  it('callback uses generic identity-fetcher: lookup by externalAccountId and seeds label on a fresh connect', async () => {
    const restoreFetch = setupGoogleOAuthMock('person@example.com');

    const findSpy = jest
      .spyOn(ops, 'findConnectorByTenantTypeAndExternalAccountId')
      .mockResolvedValue(null);
    const findByTypeSpy = jest
      .spyOn(ops, 'findConnectorByTenantAndType')
      .mockResolvedValue(null);
    const createdConnector = {
      id: 'c-gmail',
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'pending' as const,
      config: {
        externalAccountId: 'google-person@example.com',
        externalAccountLabel: 'person@example.com',
      },
      apiKeyHint: null,
    };
    jest.spyOn(ops, 'findMigrationMarkedConnector').mockResolvedValue(null);
    const createSpy = jest
      .spyOn(ops, 'createConnectorReusingOnAccountConflict')
      .mockResolvedValue(createdConnector);
    jest.spyOn(ops, 'updateConnectorStatus').mockResolvedValue({
      ...createdConnector,
      status: 'active',
    });
    const mergeSpy = jest.spyOn(ops, 'mergeConnectorConfig').mockResolvedValue(undefined);
    jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);

    try {
      const { server, url } = await startServer();
      try {
        const res = await request(url)
          .get('/api/connectors/oauth/callback')
          .query({ code: 'authcode', state: 'the_state' });
        expect(res.status).toBe(302);
        // Lookup is keyed on externalAccountId — never falls back to (tenant, type)
        // when identity is available.
        expect(findSpy).toHaveBeenCalledWith(
          't1',
          'google_mail',
          'google-person@example.com',
        );
        expect(findByTypeSpy).not.toHaveBeenCalled();
        // New row is created (via the account-conflict-safe helper) with
        // externalAccountId + Label seeded directly.
        expect(createSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'google_mail',
            config: {
              externalAccountId: 'google-person@example.com',
              externalAccountLabel: 'person@example.com',
            },
          }),
          'google-person@example.com',
        );
        // createConnector seeded the config — backfill merge is a no-op.
        expect(mergeSpy).not.toHaveBeenCalled();
      } finally {
        server.close();
      }
    } finally {
      restoreFetch();
    }
  });

  it('callback ADOPTS a row marked for forced reconnect (source flip) instead of creating a colliding sibling', async () => {
    // Regression for a composio->native source flip (e.g. slack): the marked
    // row's stored externalAccountId belongs to the OLD dispatch source, so
    // the identity dedup can never match it, and before the marked-row
    // fallback the callback fell through to a create that 500'd on the
    // (tenant_id, type, name) unique constraint. Adoption must also preserve
    // the connector id (TR manifests + agent tool-name aliases hang off it).
    const restoreFetch = setupGoogleOAuthMock('person@example.com');

    jest.spyOn(ops, 'findConnectorByTenantTypeAndExternalAccountId').mockResolvedValue(null);
    const marked = {
      id: 'c-marked',
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'error' as const,
      config: {
        externalAccountId: 'old-source-account-id',
        disconnect_reason: 'source flip - reconnect required',
      },
      apiKeyHint: null,
    };
    const markedSpy = jest.spyOn(ops, 'findMigrationMarkedConnector').mockResolvedValue(marked);
    const createSpy = jest.spyOn(ops, 'createConnectorReusingOnAccountConflict');
    const adoptSpy = jest.spyOn(ops, 'adoptMigrationMarkedConnector').mockResolvedValue({
      ...marked,
      status: 'active' as const,
      config: { externalAccountId: 'google-person@example.com' },
    });
    jest.spyOn(ops, 'updateConnectorStatus').mockImplementation(async (_t, id) => ({
      ...marked,
      id,
      status: 'active' as const,
    }));
    jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);

    try {
      const { server, url } = await startServer();
      try {
        const res = await request(url)
          .get('/api/connectors/oauth/callback')
          .query({ code: 'authcode', state: 'the_state' });
        expect(res.status).toBe(302);
        expect(markedSpy).toHaveBeenCalledWith('t1', 'google_mail');
        // Adopted in place: the identity lands on the SAME row id, no create.
        //
        // Via adopt, which REPLACES the config, rather than a merge. The merge
        // this used to assert is what carried `composioConnectedAccountId`
        // across a composio→native revert, and makeConnectorTransport selects
        // the Composio proxy on that field alone — so Slack kept dispatching to
        // a connected account the migration had deleted. The row's prior
        // `disconnect_reason` must not survive either; that is the state being
        // migrated away from.
        expect(adoptSpy).toHaveBeenCalledWith(
          't1',
          'c-marked',
          expect.objectContaining({ externalAccountId: 'google-person@example.com' }),
        );
        const adoptedConfig = adoptSpy.mock.calls[0][2];
        expect(adoptedConfig).not.toHaveProperty('composioConnectedAccountId');
        expect(adoptedConfig).not.toHaveProperty('disconnect_reason');
        expect(createSpy).not.toHaveBeenCalled();
      } finally {
        server.close();
      }
    } finally {
      restoreFetch();
    }
  });

  it('callback with a NEW account on an existing connector type creates a separate row (multi-instance)', async () => {
    const restoreFetch = setupGoogleOAuthMock('support@example.com');

    // Lookup by externalAccountId for the SECOND account returns null —
    // the first account's row doesn't match because their ids differ.
    const findSpy = jest
      .spyOn(ops, 'findConnectorByTenantTypeAndExternalAccountId')
      .mockResolvedValue(null);
    jest.spyOn(ops, 'findMigrationMarkedConnector').mockResolvedValue(null);
    const createSpy = jest.spyOn(ops, 'createConnectorReusingOnAccountConflict').mockResolvedValue({
      id: 'c-gmail-2',
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'pending' as const,
      config: {
        externalAccountId: 'google-support@example.com',
        externalAccountLabel: 'support@example.com',
      },
      apiKeyHint: null,
    });
    jest.spyOn(ops, 'updateConnectorStatus').mockImplementation(async (_t, id) => ({
      id,
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'active' as const,
      config: {
        externalAccountId: 'google-support@example.com',
        externalAccountLabel: 'support@example.com',
      },
      apiKeyHint: null,
    }));
    jest.spyOn(ops, 'mergeConnectorConfig').mockResolvedValue(undefined);
    jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);

    try {
      const { server, url } = await startServer();
      try {
        await request(url)
          .get('/api/connectors/oauth/callback')
          .query({ code: 'authcode', state: 'the_state' });
        expect(findSpy).toHaveBeenCalledWith(
          't1',
          'google_mail',
          'google-support@example.com',
        );
        expect(createSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'google_mail',
            config: {
              externalAccountId: 'google-support@example.com',
              externalAccountLabel: 'support@example.com',
            },
          }),
          'google-support@example.com',
        );
      } finally {
        server.close();
      }
    } finally {
      restoreFetch();
    }
  });

  it('callback reusing the SAME account does not create a duplicate row', async () => {
    const restoreFetch = setupGoogleOAuthMock('person@example.com');

    // Existing row matches the identity — reused, not duplicated.
    const existing = {
      id: 'c-existing',
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'disconnected' as const,
      config: {
        externalAccountId: 'google-person@example.com',
        externalAccountLabel: 'person@example.com',
      },
      apiKeyHint: null,
    };
    jest.spyOn(ops, 'findConnectorByTenantTypeAndExternalAccountId').mockResolvedValue(existing);
    const createSpy = jest.spyOn(ops, 'createConnector');
    jest.spyOn(ops, 'updateConnectorStatus').mockResolvedValue({
      ...existing,
      status: 'pending',
    });
    const mergeSpy = jest.spyOn(ops, 'mergeConnectorConfig').mockResolvedValue(undefined);
    jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);

    try {
      const { server, url } = await startServer();
      try {
        await request(url)
          .get('/api/connectors/oauth/callback')
          .query({ code: 'authcode', state: 'the_state' });
        expect(createSpy).not.toHaveBeenCalled();
        // Identity on the existing row matches — backfill merge skipped.
        expect(mergeSpy).not.toHaveBeenCalled();
      } finally {
        server.close();
      }
    } finally {
      restoreFetch();
    }
  });

  it('reconnect (state.extra.reconnectConnectorId) adopts the un-claimed target row instead of creating', async () => {
    const restoreFetch = setupGoogleOAuthMock('person@example.com');
    // State carries a reconnect target.
    jest.spyOn(ops, 'verifyOAuthState').mockResolvedValue({
      id: 'sid',
      state: 'the_state',
      tenantId: 't1',
      accountId: 'a1',
      connectorType: 'google_mail',
      scopes: [],
      redirectUri: 'https://app.test/done',
      codeVerifier: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      extra: { reconnectConnectorId: 'conn-target' },
    });
    // No account row yet for this identity → forces the reconnect-adopt path.
    jest.spyOn(ops, 'findConnectorByTenantTypeAndExternalAccountId').mockResolvedValue(null);
    // Reconnect target is un-claimed (no externalAccountId) → adopted + healed.
    const target = {
      id: 'conn-target',
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'error' as const,
      config: {},
      apiKeyHint: null,
    };
    jest.spyOn(ops, 'getConnectorById').mockResolvedValue(target);
    const createSpy = jest.spyOn(ops, 'createConnectorReusingOnAccountConflict');
    const mergeSpy = jest.spyOn(ops, 'mergeConnectorConfig').mockResolvedValue(undefined);
    jest.spyOn(ops, 'updateConnectorStatus').mockResolvedValue({ ...target, status: 'pending' });
    jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);

    try {
      const { server, url } = await startServer();
      try {
        const res = await request(url)
          .get('/api/connectors/oauth/callback')
          .query({ code: 'authcode', state: 'the_state' });
        expect(res.status).toBe(302);
        expect(createSpy).not.toHaveBeenCalled(); // adopted, not created
        expect(mergeSpy).toHaveBeenCalledWith(
          't1',
          'conn-target',
          expect.objectContaining({ externalAccountId: 'google-person@example.com' }),
        );
      } finally {
        server.close();
      }
    } finally {
      restoreFetch();
    }
  });

  it('callback backfills externalAccountId+Label on a legacy row whose config lacks them', async () => {
    const restoreFetch = setupGoogleOAuthMock('person@example.com');

    // Existing row has empty config (e.g. created by an older revision before
    // identity fetchers landed). Lookup returns it via the externalAccountId
    // key — but since the existing config differs, mergeConnectorConfig must
    // write the canonical fields.
    const existing = {
      id: 'c-legacy',
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'disconnected' as const,
      config: {},
      apiKeyHint: null,
    };
    jest.spyOn(ops, 'findConnectorByTenantTypeAndExternalAccountId').mockResolvedValue(existing);
    jest.spyOn(ops, 'updateConnectorStatus').mockResolvedValue({
      ...existing,
      status: 'pending',
    });
    const mergeSpy = jest.spyOn(ops, 'mergeConnectorConfig').mockResolvedValue(undefined);
    jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);

    try {
      const { server, url } = await startServer();
      try {
        await request(url)
          .get('/api/connectors/oauth/callback')
          .query({ code: 'authcode', state: 'the_state' });
        expect(mergeSpy).toHaveBeenCalledWith('t1', 'c-legacy', {
          externalAccountId: 'google-person@example.com',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        server.close();
      }
    } finally {
      restoreFetch();
    }
  });

  it('callback for a static provider persists credentials + redirects success', async () => {
    jest.spyOn(ops, 'verifyOAuthState').mockResolvedValue({
      id: 'sid',
      state: 'the_state',
      tenantId: 't1',
      accountId: 'a1',
      connectorType: 'github',
      scopes: ['repo'],
      redirectUri: 'https://app.test/done',
      codeVerifier: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });

    jest.spyOn(ops, 'findConnectorByTenantAndType').mockResolvedValue(null);

    const createdConnector = {
      id: 'c-123',
      tenantId: 't1',
      type: 'github',
      name: 'GitHub',
      status: 'pending' as const,
      config: {},
      apiKeyHint: null,
    };
    jest.spyOn(ops, 'createConnector').mockResolvedValue(createdConnector);
    jest.spyOn(ops, 'updateConnectorStatus').mockResolvedValue({
      ...createdConnector,
      status: 'active',
    });

    jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);

    // Mock the token-exchange HTTP call
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'gh_tok', refresh_token: 'r_tok' }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    try {
      const { server, url } = await startServer();
      try {
        const res = await request(url)
          .get('/api/connectors/oauth/callback')
          .query({ code: 'authcode', state: 'the_state' });
        expect(res.status).toBe(302);
        expect(res.headers.location).toContain('https://app.test/done');
        expect(res.headers.location).toContain('connected=github');
        expect(res.headers.location).toContain('connectorId=c-123');
        expect(credentialService.storeCredentials).toHaveBeenCalledWith(
          't1',
          'c-123',
          'static_oauth',
          expect.objectContaining({ accessToken: 'gh_tok', refreshToken: 'r_tok' }),
          ['repo'],
        );
      } finally {
        server.close();
      }
    } finally {
      global.fetch = originalFetch;
    }
  });
});
