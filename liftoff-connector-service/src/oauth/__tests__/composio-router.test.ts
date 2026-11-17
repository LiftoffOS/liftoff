// Unit tests for the Composio-managed branches of the OAuth router.
//
// Covers:
//   - POST /:connectorType/start: when catalog entry is composio_managed,
//     calls linkComposioAccount and writes a cmp_-prefixed oauth_state row
//     with extras, no Liftoff OAuth client lookup happens.
//   - GET /callback: when state starts with cmp_, polls Composio for the
//     connected account, creates a connector row with composio* fields in
//     config, and does NOT call credentialService.storeCredentials.
//   - GET /callback: composio polling failure surfaces as composio_link_failed.

// ── Module mocks (hoisted before all imports) ─────────────────────────────────

jest.mock('../../db/pool.js', () => ({
  withAdminScope: jest.fn().mockImplementation(async (_meta, fn) => fn({ query: jest.fn() })),
  withTenantScope: jest.fn().mockImplementation(async (_tenant, fn) => fn({ query: jest.fn() })),
}));

const mockComposioState = {
  state: 'cmp_ca_test123',
  tenantId: 'tenant_xyz',
  accountId: 'acct_abc',
  connectorType: 'gong',
  scopes: [],
  redirectUri: 'https://app.example.com/dashboard/connections',
  codeVerifier: null,
  expiresAt: new Date(Date.now() + 600_000),
  createdAt: new Date(),
  extra: {
    composioConnectedAccountId: 'ca_test123',
    composioAuthConfigId: 'ac_test_dev',
  },
};

const mockedConnectorOps = {
  createOAuthState: jest.fn(),
  createComposioOAuthState: jest.fn().mockResolvedValue(mockComposioState),
  verifyOAuthState: jest.fn().mockResolvedValue(mockComposioState),
  peekOAuthState: jest.fn().mockResolvedValue(mockComposioState),
  deleteOAuthState: jest.fn().mockResolvedValue(true),
  findConnectorByTenantAndType: jest.fn(),
  findConnectorByTenantTypeAndExternalAccountId: jest.fn().mockResolvedValue(null),
  findMigrationMarkedConnector: jest.fn().mockResolvedValue(null),
  adoptMigrationMarkedConnector: jest.fn(),
  createConnector: jest.fn().mockResolvedValue({ id: 'connector_uuid_1', config: {} }),
  createConnectorReusingOnAccountConflict: jest
    .fn()
    .mockResolvedValue({ id: 'connector_uuid_1', config: {} }),
  getConnectorById: jest.fn().mockResolvedValue(null),
  updateConnectorStatus: jest.fn().mockResolvedValue({ id: 'connector_uuid_1', config: {} }),
  setMetaUserId: jest.fn(),
  mergeConnectorConfig: jest.fn(),
};
jest.mock('../connector-ops.js', () => mockedConnectorOps);

// The resolver prefers this deployment's own config/composio-resources.json over
// the ids baked into the catalogue. These tests synthesise the pre-bootstrap
// state by regressing a CATALOGUE id to a placeholder, so they must not also
// read the real resource file — in which that toolkit is provisioned, which
// would override the placeholder and defeat the test. (The pairing cannot occur
// in this repo: composio-resources-parity.test.ts asserts the two agree.)
// Resolution itself is covered by catalog/__tests__/composio-resources.test.ts.
jest.mock('../../catalog/composio-resources', () => ({
  composioAuthConfigId: (_slug: string, baked: Record<string, string> | undefined, env: string) => baked?.[env],
  composioMcpServerId: (_slug: string, baked: Record<string, string> | undefined, env: string) => baked?.[env],
  _resetComposioResourceCache: () => {},
}));


// We need to re-export the real `ComposioConnectionPendingError` from the
// mock so router.ts's `instanceof` check still works. requireActual lets us
// reach past jest.mock for that specific symbol.
class ComposioConnectionPendingErrorMock extends Error {
  constructor(public readonly connectedAccountId: string, public readonly lastStatus: string) {
    super(`Composio connection ${connectedAccountId} still ${lastStatus}`);
    this.name = 'ComposioConnectionPendingError';
  }
}

const mockedComposioClient = {
  linkComposioAccount: jest.fn().mockResolvedValue({
    redirectUrl: 'https://backend.composio.dev/oauth/start?token=xyz',
    connectedAccountId: 'ca_test123',
  }),
  pollConnectedAccountActive: jest.fn().mockResolvedValue({
    id: 'ca_test123',
    status: 'ACTIVE',
    params: { account_email: 'user@example.com' },
  }),
  // Identity extractor uses getComposio() for the layer-3 whoami fallback.
  // Heuristic + id_token decode resolve identity for fixture data here
  // (params.account_email), so the whoami tool is never actually invoked;
  // we just need the getter to return something the extractor will accept.
  getComposio: jest.fn().mockReturnValue({
    tools: {
      execute: jest.fn().mockResolvedValue({ successful: true, data: {} }),
    },
  }),
  ComposioConnectionPendingError: ComposioConnectionPendingErrorMock,
};
jest.mock('../composio-client.js', () => mockedComposioClient);

const mockedCredentialService = {
  credentialService: {
    storeCredentials: jest.fn(),
  },
};
jest.mock('../../credentials/service.js', () => mockedCredentialService);

jest.mock('../../secrets/client.js', () => ({
  getConnectorCredential: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../infra/idempotency-rest-middleware.js', () => ({
  withIdempotencyRest: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../events/publisher.js', () => ({
  emitCredentialsStored: jest.fn(),
}));

// fetchExternalIdentity is wired up but should never run on the composio path
jest.mock('../identity-fetchers.js', () => {
  const actual = jest.requireActual<typeof import('../identity-fetchers.js')>(
    '../identity-fetchers.js',
  );
  return {
    ...actual,
    fetchExternalIdentity: jest.fn().mockResolvedValue(null),
  };
});

import express from 'express';
import request from 'supertest';
import { oauthRouter } from '../router.js';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/connectors/oauth', oauthRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedConnectorOps.createComposioOAuthState.mockResolvedValue(mockComposioState);
  mockedConnectorOps.verifyOAuthState.mockResolvedValue(mockComposioState);
  mockedConnectorOps.peekOAuthState.mockResolvedValue(mockComposioState);
  mockedConnectorOps.deleteOAuthState.mockResolvedValue(true);
  mockedConnectorOps.findConnectorByTenantTypeAndExternalAccountId.mockResolvedValue(null);
  mockedConnectorOps.findMigrationMarkedConnector.mockResolvedValue(null);
  mockedConnectorOps.createConnector.mockResolvedValue({ id: 'connector_uuid_1', config: {} });
  mockedConnectorOps.createConnectorReusingOnAccountConflict.mockResolvedValue({
    id: 'connector_uuid_1',
    config: {},
  });
  mockedConnectorOps.getConnectorById.mockResolvedValue(null);
  mockedConnectorOps.updateConnectorStatus.mockResolvedValue({ id: 'connector_uuid_1', config: {} });
  mockedComposioClient.linkComposioAccount.mockResolvedValue({
    redirectUrl: 'https://backend.composio.dev/oauth/start?token=xyz',
    connectedAccountId: 'ca_test123',
  });
  mockedComposioClient.pollConnectedAccountActive.mockResolvedValue({
    id: 'ca_test123',
    status: 'ACTIVE',
    params: { account_email: 'user@example.com' },
  });
});

describe('POST /:connectorType/start — composio_managed branch', () => {
  const ORIGINAL_BACKEND_URL = process.env.BACKEND_URL;
  const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;
  // The seed catalog now ships with bootstrapped real ids for every
  // Composio-managed entry; the placeholder-rejection branch is exercised
  // by REGRESSING the relevant catalog entry back to `<from-phase-0>`
  // for the duration of the test. `promoteGongToFullyBootstrapped` is
  // kept for tests that rewrite gong's mcpServerIds to deterministic
  // test values, which the catalog flow assertions still depend on.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CONNECTORS } = require('../../catalog/connectors.js') as typeof import('../../catalog/connectors.js');
  type ComposioMcp = {
    authConfigIds: { dev: string; prod: string };
    mcpServerIds: { dev: string; prod: string };
  };
  const ORIGINAL_GONG_AUTH_IDS = { ...(CONNECTORS.gong!.mcp as ComposioMcp).authConfigIds };
  const ORIGINAL_GONG_MCP_IDS = { ...(CONNECTORS.gong!.mcp as ComposioMcp).mcpServerIds };
  const ORIGINAL_DYNAMICS_AUTH_IDS = { ...(CONNECTORS.microsoft_dynamics!.mcp as ComposioMcp).authConfigIds };
  const ORIGINAL_DYNAMICS_MCP_IDS = { ...(CONNECTORS.microsoft_dynamics!.mcp as ComposioMcp).mcpServerIds };

  function promoteGongToFullyBootstrapped() {
    (CONNECTORS.gong!.mcp as ComposioMcp).mcpServerIds = {
      dev: 'mcp_test_dev',
      prod: 'mcp_test_prod',
    };
  }

  function regressMicrosoftDynamicsAuthToPlaceholder() {
    (CONNECTORS.microsoft_dynamics!.mcp as ComposioMcp).authConfigIds = {
      dev: '<from-phase-0>',
      prod: '<from-phase-0>',
    };
  }

  function regressGongMcpToPlaceholder() {
    (CONNECTORS.gong!.mcp as ComposioMcp).mcpServerIds = {
      dev: '<from-phase-0>',
      prod: '<from-phase-0>',
    };
  }

  beforeEach(() => {
    process.env.BACKEND_URL = 'https://api.example.test';
    process.env.FRONTEND_URL = 'https://app.example.test';
  });
  afterEach(() => {
    // Always restore real ids so each test starts from the bootstrapped
    // baseline (matches the actual shipped catalog state).
    (CONNECTORS.gong!.mcp as ComposioMcp).authConfigIds = { ...ORIGINAL_GONG_AUTH_IDS };
    (CONNECTORS.gong!.mcp as ComposioMcp).mcpServerIds = { ...ORIGINAL_GONG_MCP_IDS };
    (CONNECTORS.microsoft_dynamics!.mcp as ComposioMcp).authConfigIds = { ...ORIGINAL_DYNAMICS_AUTH_IDS };
    (CONNECTORS.microsoft_dynamics!.mcp as ComposioMcp).mcpServerIds = { ...ORIGINAL_DYNAMICS_MCP_IDS };
  });
  afterAll(() => {
    if (ORIGINAL_BACKEND_URL === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = ORIGINAL_BACKEND_URL;
    if (ORIGINAL_FRONTEND_URL === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
  });

  it('routes through Composio with Liftoff /callback in the callbackUrl (state pre-encoded)', async () => {
    promoteGongToFullyBootstrapped();
    const res = await request(buildApp())
      .post('/api/connectors/oauth/gong/start')
      .set('x-account-id', 'acct_abc')
      .send({ tenantId: 'tenant_xyz', returnUrl: 'https://app.example.test/oauth/callback' });

    expect(res.status).toBe(200);
    expect(res.body.authUrl).toBe('https://backend.composio.dev/oauth/start?token=xyz');
    expect(res.body.state).toMatch(/^cmp_[0-9a-f]{32}$/);

    // CRITICAL: the callbackUrl handed to Composio is Liftoff's /callback
    // (NOT the frontend) with the state encoded in the query — otherwise
    // /callback never fires and the connector row is never created.
    const linkArgs = mockedComposioClient.linkComposioAccount.mock.calls[0][0];
    expect(linkArgs.tenantId).toBe('tenant_xyz');
    expect(linkArgs.authConfigId).toMatch(/^ac_/);
    expect(linkArgs.callbackUrl).toMatch(
      /^https:\/\/api\.example\.test\/api\/connectors\/oauth\/callback\?state=cmp_[0-9a-f]{32}$/,
    );

    expect(mockedConnectorOps.createComposioOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.stringMatching(/^cmp_[0-9a-f]{32}$/),
        tenantId: 'tenant_xyz',
        accountId: 'acct_abc',
        connectorType: 'gong',
        // redirectUri is where /callback redirects the browser AFTER processing.
        redirectUri: 'https://app.example.test/oauth/callback',
        extra: expect.objectContaining({
          composioConnectedAccountId: 'ca_test123',
          composioAuthConfigId: expect.stringMatching(/^ac_/),
        }),
      }),
    );
    // The vendor OAuth helpers must NOT have been called on this branch.
    expect(mockedConnectorOps.createOAuthState).not.toHaveBeenCalled();
  });

  it('rejects when tenantId is missing', async () => {
    const res = await request(buildApp())
      .post('/api/connectors/oauth/gong/start')
      .set('x-account-id', 'acct_abc')
      .send({ returnUrl: 'https://app.example.test/oauth/callback' });
    expect(res.status).toBe(400);
    expect(mockedComposioClient.linkComposioAccount).not.toHaveBeenCalled();
  });

  it('rejects when x-account-id header is missing', async () => {
    const res = await request(buildApp())
      .post('/api/connectors/oauth/gong/start')
      .send({ tenantId: 'tenant_xyz' });
    expect(res.status).toBe(401);
    expect(mockedComposioClient.linkComposioAccount).not.toHaveBeenCalled();
  });

  it('rejects with 503 when authConfigId is still a placeholder (bootstrap not yet run)', async () => {
    // Synthesize the pre-bootstrap state by regressing dynamics' authConfigIds
    // back to placeholders.
    regressMicrosoftDynamicsAuthToPlaceholder();
    const res = await request(buildApp())
      .post('/api/connectors/oauth/microsoft_dynamics/start')
      .set('x-account-id', 'acct_abc')
      .send({ tenantId: 'tenant_xyz' });
    expect(res.status).toBe(503);
    expect(mockedComposioClient.linkComposioAccount).not.toHaveBeenCalled();
  });

  it('rejects with 503 when mcpServerId is still a placeholder (auth config provisioned, mcp not)', async () => {
    // Synthesize the partial-bootstrap state: authConfigIds real, mcpServerIds
    // still placeholder. /start must refuse — otherwise the user would
    // complete OAuth, get a "Connected" tile, and then have every agent tool
    // call against gong 404 at the MCP registry. Belt-and-suspenders for
    // the effective-status downgrade.
    regressGongMcpToPlaceholder();
    const res = await request(buildApp())
      .post('/api/connectors/oauth/gong/start')
      .set('x-account-id', 'acct_abc')
      .send({ tenantId: 'tenant_xyz', returnUrl: 'https://app.example.test/oauth/callback' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/MCP server/);
    expect(mockedComposioClient.linkComposioAccount).not.toHaveBeenCalled();
  });

  it('rejects with 500 when BACKEND_URL is not configured', async () => {
    promoteGongToFullyBootstrapped();
    delete process.env.BACKEND_URL;
    const res = await request(buildApp())
      .post('/api/connectors/oauth/gong/start')
      .set('x-account-id', 'acct_abc')
      .send({ tenantId: 'tenant_xyz', returnUrl: 'https://app.example.test/oauth/callback' });
    expect(res.status).toBe(500);
    expect(mockedComposioClient.linkComposioAccount).not.toHaveBeenCalled();
  });

  it('rejects with 500 when BOTH FRONTEND_URL is missing AND returnUrl is omitted', async () => {
    // Composio path is strict: no silent fallback to the prod URL when no
    // redirect destination is known. /start refuses rather than landing a
    // dev user on app.example.com.
    delete process.env.FRONTEND_URL;
    const res = await request(buildApp())
      .post('/api/connectors/oauth/gong/start')
      .set('x-account-id', 'acct_abc')
      .send({ tenantId: 'tenant_xyz' }); // no returnUrl
    expect(res.status).toBe(500);
    expect(mockedComposioClient.linkComposioAccount).not.toHaveBeenCalled();
  });

  it('still accepts when FRONTEND_URL is missing but returnUrl is supplied', async () => {
    promoteGongToFullyBootstrapped();
    delete process.env.FRONTEND_URL;
    const res = await request(buildApp())
      .post('/api/connectors/oauth/gong/start')
      .set('x-account-id', 'acct_abc')
      .send({ tenantId: 'tenant_xyz', returnUrl: 'https://app.example.test/oauth/callback' });
    expect(res.status).toBe(200);
    expect(mockedComposioClient.linkComposioAccount).toHaveBeenCalledTimes(1);
  });

  it('rejects with 500 when ENVIRONMENT is not dev|prod', async () => {
    process.env.ENVIRONMENT = 'staging';
    const res = await request(buildApp())
      .post('/api/connectors/oauth/gong/start')
      .set('x-account-id', 'acct_abc')
      .send({ tenantId: 'tenant_xyz', returnUrl: 'https://app.example.test/oauth/callback' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ENVIRONMENT/);
    expect(mockedComposioClient.linkComposioAccount).not.toHaveBeenCalled();
    delete process.env.ENVIRONMENT;
  });
});

describe('GET /callback — composio branch', () => {
  it('polls Composio, creates the connector with composio* config, and never calls storeCredentials', async () => {
    const res = await request(buildApp())
      .get('/api/connectors/oauth/callback')
      .query({ state: 'cmp_ca_test123' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('connected=gong');
    expect(res.headers.location).toContain('connectorId=connector_uuid_1');

    expect(mockedComposioClient.pollConnectedAccountActive).toHaveBeenCalledWith('ca_test123');
    // Path (3) fresh connect now goes through the 23505-safe create wrapper,
    // which takes the externalAccountId as its second arg for reuse-on-conflict.
    expect(mockedConnectorOps.createConnectorReusingOnAccountConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_xyz',
        type: 'gong',
        config: expect.objectContaining({
          externalAccountId: 'ca_test123',
          externalAccountLabel: 'user@example.com',
          composioConnectedAccountId: 'ca_test123',
          composioAuthConfigId: 'ac_test_dev',
        }),
      }),
      'ca_test123',
    );
    expect(mockedCredentialService.credentialService.storeCredentials).not.toHaveBeenCalled();
  });

  it('redirects with composio_link_failed when polling throws', async () => {
    mockedComposioClient.pollConnectedAccountActive.mockRejectedValueOnce(
      new Error('Composio connection FAILED: user denied consent'),
    );
    const res = await request(buildApp())
      .get('/api/connectors/oauth/callback')
      .query({ state: 'cmp_ca_test123' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=composio_link_failed');
    expect(mockedConnectorOps.createConnector).not.toHaveBeenCalled();
  });

  it('reuses the existing connector row on reconnect and refreshes the composio config', async () => {
    mockedConnectorOps.findConnectorByTenantTypeAndExternalAccountId.mockResolvedValueOnce({
      id: 'existing_uuid',
      config: {
        externalAccountId: 'ca_test123',
        // Stale identifiers from a previous link (e.g. operator re-ran
        // bootstrap, yielding a new auth_config; or Composio rotated the
        // connected-account id). /callback must update these on reconnect.
        composioConnectedAccountId: 'ca_OLD',
        composioAuthConfigId: 'ac_OLD',
      },
    });
    mockedConnectorOps.updateConnectorStatus.mockResolvedValueOnce({
      id: 'existing_uuid',
      config: {},
    });

    const res = await request(buildApp())
      .get('/api/connectors/oauth/callback')
      .query({ state: 'cmp_ca_test123' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('connectorId=existing_uuid');
    expect(mockedConnectorOps.createConnector).not.toHaveBeenCalled();
    expect(mockedConnectorOps.updateConnectorStatus).toHaveBeenCalledWith(
      'tenant_xyz',
      'existing_uuid',
      'active',
    );
    // Critical for the reconnect path: the new ids are written through.
    // Skipping this leaves the row referencing the obsolete auth_config /
    // connected-account, which makes debugging painful when the link
    // misbehaves and an operator inspects the row.
    expect(mockedConnectorOps.mergeConnectorConfig).toHaveBeenCalledWith(
      'tenant_xyz',
      'existing_uuid',
      expect.objectContaining({
        composioConnectedAccountId: 'ca_test123',
        composioAuthConfigId: 'ac_test_dev',
      }),
    );
  });

  it('reconnect (state.extra.reconnectConnectorId) adopts an un-claimed row and HEALS externalAccountId onto it', async () => {
    // The card the user clicked Reconnect on carries its row id in state.extra.
    // The row is un-claimed (no externalAccountId yet — e.g. created before
    // identity tracking, or a stale duplicate), so the tier-0 reconnect branch
    // adopts it. No account row exists for this identity yet, so the normal
    // externalAccountId lookup returns null and would otherwise create a NEW row.
    mockedConnectorOps.peekOAuthState.mockResolvedValueOnce({
      ...mockComposioState,
      extra: {
        composioConnectedAccountId: 'ca_test123',
        composioAuthConfigId: 'ac_test_dev',
        reconnectConnectorId: 'reconnect_uuid',
      },
    });
    mockedConnectorOps.getConnectorById.mockResolvedValueOnce({
      id: 'reconnect_uuid',
      type: 'gong',
      config: {}, // un-claimed → eligible for adoption
    });
    mockedConnectorOps.findConnectorByTenantTypeAndExternalAccountId.mockResolvedValue(null);
    mockedConnectorOps.updateConnectorStatus.mockResolvedValue({
      id: 'reconnect_uuid',
      config: {},
    });

    const res = await request(buildApp())
      .get('/api/connectors/oauth/callback')
      .query({ state: 'cmp_ca_test123' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('connectorId=reconnect_uuid');
    // Adopted, not created.
    expect(mockedConnectorOps.createConnector).not.toHaveBeenCalled();
    expect(mockedConnectorOps.createConnectorReusingOnAccountConflict).not.toHaveBeenCalled();
    // The A3 heal: externalAccountId must be written onto the adopted row —
    // without it the row stays un-claimed forever and never becomes dedup-able.
    expect(mockedConnectorOps.mergeConnectorConfig).toHaveBeenCalledWith(
      'tenant_xyz',
      'reconnect_uuid',
      expect.objectContaining({ externalAccountId: 'ca_test123' }),
    );
  });

  it('on poll-timeout (ComposioConnectionPendingError), KEEPS oauth_state alive for browser-refresh retry', async () => {
    // Critical orphan-prevention design: if polling times out but Composio
    // hasn't terminated, we MUST NOT delete the oauth_state. The user can
    // refresh the browser → /callback fires again → peek-and-poll picks
    // up the same INITIATED row. Deleting would orphan an ACTIVE-eventually
    // row in Composio.
    mockedComposioClient.pollConnectedAccountActive.mockRejectedValueOnce(
      new ComposioConnectionPendingErrorMock('ca_test123', 'INITIATED'),
    );
    const res = await request(buildApp())
      .get('/api/connectors/oauth/callback')
      .query({ state: 'cmp_ca_test123' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=composio_link_failed');
    expect(mockedConnectorOps.createConnector).not.toHaveBeenCalled();
    expect(mockedConnectorOps.deleteOAuthState).not.toHaveBeenCalled();
  });

  it('on terminal poll-failure (FAILED/EXPIRED/REVOKED), CONSUMES oauth_state (no recovery possible)', async () => {
    mockedComposioClient.pollConnectedAccountActive.mockRejectedValueOnce(
      new Error('Composio connection FAILED: user denied consent'),
    );
    const res = await request(buildApp())
      .get('/api/connectors/oauth/callback')
      .query({ state: 'cmp_ca_test123' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=composio_link_failed');
    expect(mockedConnectorOps.createConnector).not.toHaveBeenCalled();
    // Terminal failure → state row consumed so retries hit 'invalid_state'.
    expect(mockedConnectorOps.deleteOAuthState).toHaveBeenCalledWith('cmp_ca_test123');
  });

  it('on ACTIVE success, CONSUMES oauth_state via deleteOAuthState (not verifyOAuthState)', async () => {
    // Composio path uses peek (read-only) for /callback's state lookup.
    // Consumption is explicit and happens ONLY after the connector row is
    // committed — so the user can refresh on transient errors without
    // losing recoverability.
    const res = await request(buildApp())
      .get('/api/connectors/oauth/callback')
      .query({ state: 'cmp_ca_test123' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('connected=gong');
    expect(mockedConnectorOps.peekOAuthState).toHaveBeenCalledWith('cmp_ca_test123');
    // verifyOAuthState is the CONSUMING legacy-OAuth variant; should not
    // be used on the composio path.
    expect(mockedConnectorOps.verifyOAuthState).not.toHaveBeenCalled();
    expect(mockedConnectorOps.deleteOAuthState).toHaveBeenCalledWith('cmp_ca_test123');
  });

  it('adopts a migration-marked legacy row instead of creating a duplicate', async () => {
    // The migration script left an 'error' row of the same (tenant, type)
    // with disconnect_reason='composio_migration'. /callback should UPDATE
    // that row in place (preserving its connector_id) instead of creating
    // a new row and leaving the old "Needs Reconnect" tile dangling.
    mockedConnectorOps.findMigrationMarkedConnector.mockResolvedValueOnce({
      id: 'legacy_calcom_uuid',
      tenantId: 'tenant_xyz',
      type: 'cal_com',
      status: 'error',
      config: { disconnect_reason: 'composio_migration', api_key_hint: 'ab••' },
    });
    mockedConnectorOps.adoptMigrationMarkedConnector.mockResolvedValueOnce({
      id: 'legacy_calcom_uuid',
      tenantId: 'tenant_xyz',
      type: 'cal_com',
      status: 'active',
      config: { externalAccountId: 'ca_test123' },
    });

    const res = await request(buildApp())
      .get('/api/connectors/oauth/callback')
      .query({ state: 'cmp_ca_test123' });

    expect(res.status).toBe(302);
    // Same connector_id as the legacy row — agent bindings stay valid.
    expect(res.headers.location).toContain('connectorId=legacy_calcom_uuid');
    expect(mockedConnectorOps.adoptMigrationMarkedConnector).toHaveBeenCalledWith(
      'tenant_xyz',
      'legacy_calcom_uuid',
      expect.objectContaining({
        composioConnectedAccountId: 'ca_test123',
        composioAuthConfigId: 'ac_test_dev',
        externalAccountId: 'ca_test123',
        externalAccountLabel: 'user@example.com',
      }),
    );
    expect(mockedConnectorOps.createConnector).not.toHaveBeenCalled();
  });

  it('adopts a legacy direct-OAuth row (no migration marker) instead of creating a duplicate', async () => {
    // Path (2b), for connectors switched from sidecar to composio_managed. Existing `available` direct-OAuth rows (e.g. a
    // tenant connected Gmail before the switch) are not migration-marked
    // but ARE collision targets for the (tenant, type, name) unique index.
    // Without adoption, createConnector blows up with
    // `connectors_tenant_id_type_name_key` and the user sees
    // `composio_link_failed` on every reconnect.
    mockedConnectorOps.findConnectorByTenantTypeAndExternalAccountId.mockResolvedValueOnce(null);
    mockedConnectorOps.findMigrationMarkedConnector.mockResolvedValueOnce(null);
    mockedConnectorOps.findConnectorByTenantAndType.mockResolvedValueOnce({
      id: 'legacy_gmail_uuid',
      tenantId: 'tenant_xyz',
      type: 'gong',
      status: 'active',
      config: {
        externalAccountId: 'google-user-123',
        externalAccountLabel: 'person@example.com',
      },
    });
    mockedConnectorOps.adoptMigrationMarkedConnector.mockResolvedValueOnce({
      id: 'legacy_gmail_uuid',
      tenantId: 'tenant_xyz',
      type: 'gong',
      status: 'active',
      config: { externalAccountId: 'ca_test123' },
    });

    const res = await request(buildApp())
      .get('/api/connectors/oauth/callback')
      .query({ state: 'cmp_ca_test123' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('connectorId=legacy_gmail_uuid');
    expect(mockedConnectorOps.adoptMigrationMarkedConnector).toHaveBeenCalledWith(
      'tenant_xyz',
      'legacy_gmail_uuid',
      expect.objectContaining({
        composioConnectedAccountId: 'ca_test123',
        composioAuthConfigId: 'ac_test_dev',
        externalAccountId: 'ca_test123',
      }),
    );
    expect(mockedConnectorOps.createConnector).not.toHaveBeenCalled();
  });
});
