// FEATURE TEST 1 — an assistant asks, a person confirms, a person enters the
// key, the provider is checked, and the connection is visibly active.
//
// The whole path this feature exists for, in one test: the workspace-action
// tool previews what connecting would give, mints a link on confirm, the
// capture submit claims that link and hands the credential to
// connector-service, and what comes back is a connection the Connections page
// will show as connected.
//
// The credential is asserted on directly, because "the value never enters a
// conversation" is the property the whole design is arranged around: it is not
// in the preview, not in the tool's answer, and it reaches exactly one place.

const mockDescribe = jest.fn();
const mockRegister = jest.fn();
const mockListCustomApi = jest.fn();
const mockListConnectors = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  describeCustomApiSpec: (...a: unknown[]) => mockDescribe(...a),
  registerCustomApiConnection: (...a: unknown[]) => mockRegister(...a),
  listCustomApiConnections: (...a: unknown[]) => mockListCustomApi(...a),
  listConnectorsForTenant: (...a: unknown[]) => mockListConnectors(...a),
  isCustomApiRefusal: (v: Record<string, unknown>) => 'refused' in v,
  getCatalog: jest.fn(),
  getConnectorForTenant: jest.fn(),
  deleteConnectorForTenant: jest.fn(),
  getConnectorHealthStats: jest.fn(),
  listGithubInstallTargets: jest.fn(),
  startGithubInstall: jest.fn(),
  startIamGrantConnect: jest.fn(),
  startOAuthConnect: jest.fn(),
  verifyIamGrantConnect: jest.fn(),
}));

const mockCreateToken = jest.fn();
const mockClaim = jest.fn();
const mockRecordConnector = jest.fn();
const mockRelease = jest.fn();
const mockFindByHash = jest.fn();
jest.mock('../repository', () => ({
  CAPTURE_TOKEN_TTL_SECONDS: 3600,
  createCaptureToken: (...a: unknown[]) => mockCreateToken(...a),
  claimCaptureToken: (...a: unknown[]) => mockClaim(...a),
  recordCaptureConnector: (...a: unknown[]) => mockRecordConnector(...a),
  releaseCaptureClaim: (...a: unknown[]) => mockRelease(...a),
  findCaptureTokenByHash: (...a: unknown[]) => mockFindByHash(...a),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

// The dispatcher re-resolves the actor before every write, so anything it does
// not carry is gone by the time the tool runs. Mocked at the membership read
// so the real `resolveActor` runs and the carry is actually exercised.
const mockGetMembership = jest.fn();
jest.mock('../../tenant-members', () => ({
  tenantMembersService: { getMembership: (...a: unknown[]) => mockGetMembership(...a) },
}));
jest.mock('../../accounts/service', () => ({
  AccountService: class { async getById() { return { firstName: 'Alice', lastName: 'A', email: 'a@x.test' }; } },
}));
jest.mock('../../infrastructure/idempotency', () => ({
  claimIdempotencyKey: jest.fn(async () => 'claimed'),
  settleIdempotencyKey: jest.fn(async () => undefined),
}));

import { connectionRequestApiAccessTool } from '../../workspace-actions/tools/connections';
import { dispatchWorkspaceAction } from '../../workspace-actions/tools';
import type { Actor } from '../../workspace-actions/actor';
import { submitCapture } from '../service';
import type { CustomApiSpec } from '../types';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ASKER = '22222222-2222-2222-2222-222222222222';
const KEY_HOLDER = '33333333-3333-3333-3333-333333333333';
const CONNECTOR = '44444444-4444-4444-4444-444444444444';
const CREDENTIAL = 'acme_live_sk_9f3c11d7aa42';

function actor(over: Partial<Actor> = {}): Actor {
  return {
    tenantId: TENANT,
    accountId: ASKER,
    role: 'owner',
    displayName: 'Alice',
    surface: 'liftoff',
    ...over,
  };
}

const SPEC: CustomApiSpec = {
  providerSlug: 'acme-crm',
  displayName: 'Acme CRM',
  baseUrl: 'https://api.acme.example',
  apiHosts: ['api.acme.example'],
  auth: { scheme: 'bearer_header' },
  verification: { method: 'GET', path: '/v1/me', accountIdentityField: 'data.email' },
  specSourceUrl: 'https://api.acme.example/openapi.json',
  purpose: 'Reading open deals so the sales agent can report on them.',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockListCustomApi.mockResolvedValue([]);
  mockListConnectors.mockResolvedValue([]);
  mockGetMembership.mockResolvedValue({ role: 'owner' });
});

describe('connecting a custom API, from the ask to a connection that works', () => {
  it('previews what connecting gives, mints a link, captures the key and comes back active', async () => {
    // 1. The assistant describes the connection. The preview says what
    //    connecting would give — including how many operations — and never a
    //    credential, because at this point there is not one.
    mockDescribe.mockResolvedValue({
      operationCount: 42,
      specHash: 'abc123',
      sampleOperations: ['get_v1_deals', 'create_v1_deals'],
    });
    const preview = await connectionRequestApiAccessTool.preview!({ connection: SPEC }, actor()) as Record<string, unknown>;

    expect(preview).toMatchObject({
      provider: 'Acme CRM',
      hosts: ['api.acme.example'],
      verification: 'GET /v1/me',
      purpose: SPEC.purpose,
      operationCount: 42,
      willMintLink: true,
    });
    expect(JSON.stringify(preview)).not.toContain(CREDENTIAL);

    // 2. The person confirms, and the mint writes a capture-token row and
    //    NOTHING else — no connector row, so an abandoned flow leaves no tile.
    mockCreateToken.mockResolvedValue({
      id: 'cap-1',
      tenantId: TENANT,
      requestedByAccountId: ASKER,
      spec: SPEC,
      specHash: 'spec-hash',
      attemptId: 'attempt-1',
      reconnectConnectorId: null,
      claimedAt: null,
      claimedByAccountId: null,
      connectorId: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const minted = await connectionRequestApiAccessTool.execute({ connection: SPEC }, actor()) as Record<string, unknown>;

    expect(minted.kind).toBe('capture_link');
    expect(String(minted.url)).toContain('/connections/capture/liftoff_cap_');
    expect(mockRegister).not.toHaveBeenCalled();

    // 3. A COLLEAGUE opens the link and enters the key. The token is scoped to
    //    the tenant and the description, not to whoever asked.
    mockClaim.mockResolvedValue({
      kind: 'claimed',
      token: {
        id: 'cap-1',
        tenantId: TENANT,
        requestedByAccountId: ASKER,
        spec: SPEC,
        specHash: 'spec-hash',
        attemptId: 'attempt-1',
        reconnectConnectorId: null,
        claimedAt: new Date(),
        claimedByAccountId: KEY_HOLDER,
        connectorId: null,
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    mockRegister.mockResolvedValue({
      connectorId: CONNECTOR,
      status: 'active',
      operationCount: 42,
      externalAccountLabel: 'ops@acme.example',
      reused: false,
    });

    const outcome = await submitCapture({
      tenantId: TENANT,
      accountId: KEY_HOLDER,
      token: 'liftoff_cap_whatever',
      credential: CREDENTIAL,
    });

    // 4. Verified, then active — and the connector id written back onto the
    //    claim, which is what makes a repeat submit a replay rather than a
    //    second connection.
    expect(outcome).toMatchObject({
      kind: 'connected',
      connectorId: CONNECTOR,
      status: 'active',
      operationCount: 42,
      externalAccountLabel: 'ops@acme.example',
    });
    expect(mockRecordConnector).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, connectorId: CONNECTOR }),
    );

    // The credential reached exactly one place: connector-service, with the
    // attempt id creation is keyed on and the completing account.
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        accountId: KEY_HOLDER,
        attemptId: 'attempt-1',
        credential: CREDENTIAL,
      }),
    );
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIAL);
  });

  it('names the existing connection instead of minting a second link', async () => {
    mockListCustomApi.mockResolvedValue([
      { connectorId: CONNECTOR, name: 'Acme CRM', providerSlug: 'acme-crm', apiHosts: ['api.acme.example'], operationCount: 42 },
    ]);
    mockListConnectors.mockResolvedValue([{ id: CONNECTOR, type: 'custom_api_connector', status: 'active' }]);

    const answer = await connectionRequestApiAccessTool.execute({ connection: SPEC }, actor()) as Record<string, unknown>;

    expect(answer.kind).toBe('already_connected');
    expect(answer.connectorId).toBe(CONNECTOR);
    expect(mockCreateToken).not.toHaveBeenCalled();
  });

  it('declines an unsupported scheme by name rather than minting a link', async () => {
    const answer = await connectionRequestApiAccessTool.execute(
      { connection: SPEC, unsupportedScheme: 'request_signing' },
      actor(),
    ) as Record<string, unknown>;

    expect(answer.kind).toBe('unsupported_scheme');
    expect(answer.reason).toBe('request_signing');
    expect(String(answer.message)).toContain('signs each request');
    expect(mockCreateToken).not.toHaveBeenCalled();
  });

  it('refuses an unusable description with what is wrong with it, not a scheme name', async () => {
    // A base address on a host the connection does not list is not a
    // password-only provider, and calling it one would send the assistant to
    // fix the wrong thing.
    const wrong = { ...SPEC, baseUrl: 'https://elsewhere.example' };

    await expect(
      connectionRequestApiAccessTool.preview!({ connection: wrong }, actor()),
    ).rejects.toMatchObject({ reason: 'description_not_usable' });
    expect(mockDescribe).not.toHaveBeenCalled();
    expect(mockCreateToken).not.toHaveBeenCalled();
  });

  it('refuses a plain-http connection, which would put the key on the wire in the clear', async () => {
    await expect(
      connectionRequestApiAccessTool.preview!(
        { connection: { ...SPEC, baseUrl: 'http://api.acme.example' } },
        actor(),
      ),
    ).rejects.toMatchObject({ reason: 'description_not_usable' });
  });

  it('refuses when nobody is there to open the link', async () => {
    const unattended = actor({ unattended: true });

    await expect(
      connectionRequestApiAccessTool.preview!({ connection: SPEC }, unattended),
    ).rejects.toMatchObject({ reason: 'nobody_present' });

    const executed = await connectionRequestApiAccessTool.execute({ connection: SPEC }, unattended) as Record<string, unknown>;
    expect(executed).toMatchObject({ refused: true, reason: 'nobody_present' });
    expect(mockCreateToken).not.toHaveBeenCalled();
  });

  it('still refuses THROUGH THE DISPATCHER, which re-resolves the actor first', async () => {
    // The refusal is only real if it survives `resolveActor`: the dispatcher
    // re-reads membership and role before every write, and an actor field it
    // does not carry is gone by the time the tool runs. This is the assertion
    // that the carry exists — without it the tool's own check is unreachable
    // on the one path that actually calls it.
    const answer = await dispatchWorkspaceAction(
      'connection_request_api_access',
      { connection: SPEC },
      actor({ unattended: true }),
    );

    expect(JSON.parse(answer)).toMatchObject({ refused: true, reason: 'nobody_present' });
    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(mockDescribe).not.toHaveBeenCalled();
  });
});
