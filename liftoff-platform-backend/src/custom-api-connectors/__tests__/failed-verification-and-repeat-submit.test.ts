// FEATURE TEST 2 — a failed verification is VISIBLE and retryable, and a
// repeated submit of the same capture token does not produce a second
// connection.
//
// Two properties, both of which have a real failure behind them:
//
//   * `pending` is only for the moment the submit and the verification are in
//     flight. The Connections page filters to `active` and `error` precisely so
//     a broken connector is visible and reconnectable, and a `pending` row
//     would be HIDDEN — a connection nobody can see is a connection nobody can
//     fix. Our own custom-MCP path has the opposite behaviour today: a failed
//     discovery leaves the row `active` with no tools, which is how a Help
//     Center server sat healthy on the page for three months while every call
//     401'd.
//   * The claim is atomic and the connector id is written back onto it, so a
//     second submit RESOLVES rather than duplicating.

const mockRegister = jest.fn();
const mockListCustomApi = jest.fn();
const mockListConnectors = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  registerCustomApiConnection: (...a: unknown[]) => mockRegister(...a),
  listCustomApiConnections: (...a: unknown[]) => mockListCustomApi(...a),
  listConnectorsForTenant: (...a: unknown[]) => mockListConnectors(...a),
  describeCustomApiSpec: jest.fn(),
  isCustomApiRefusal: (v: Record<string, unknown>) => 'refused' in v,
}));

const mockClaim = jest.fn();
const mockRecordConnector = jest.fn();
const mockRelease = jest.fn();
jest.mock('../repository', () => ({
  CAPTURE_TOKEN_TTL_SECONDS: 3600,
  createCaptureToken: jest.fn(),
  claimCaptureToken: (...a: unknown[]) => mockClaim(...a),
  recordCaptureConnector: (...a: unknown[]) => mockRecordConnector(...a),
  releaseCaptureClaim: (...a: unknown[]) => mockRelease(...a),
  findCaptureTokenByHash: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { submitCapture } from '../service';
import type { CaptureToken, CustomApiSpec } from '../types';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ACCOUNT = '33333333-3333-3333-3333-333333333333';
const CONNECTOR = '44444444-4444-4444-4444-444444444444';

const SPEC: CustomApiSpec = {
  providerSlug: 'acme-crm',
  displayName: 'Acme CRM',
  baseUrl: 'https://api.acme.example',
  apiHosts: ['api.acme.example'],
  auth: { scheme: 'header', name: 'X-Api-Key' },
  verification: { method: 'GET', path: '/v1/me' },
  specSourceUrl: 'https://api.acme.example/openapi.json',
  purpose: 'Reading open deals.',
};

function token(over: Partial<CaptureToken> = {}): CaptureToken {
  return {
    id: 'cap-1',
    tenantId: TENANT,
    requestedByAccountId: ACCOUNT,
    spec: SPEC,
    specHash: 'spec-hash',
    attemptId: 'attempt-1',
    reconnectConnectorId: null,
    claimedAt: new Date(),
    claimedByAccountId: ACCOUNT,
    connectorId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListCustomApi.mockResolvedValue([]);
  mockListConnectors.mockResolvedValue([]);
});

describe('a failed verification, and a link submitted twice', () => {
  it('surfaces a failed verification as a visible error, naming the layer', async () => {
    mockClaim.mockResolvedValue({ kind: 'claimed', token: token() });
    mockRegister.mockResolvedValue({
      connectorId: CONNECTOR,
      status: 'error',
      operationCount: 42,
      reused: false,
      verification: {
        ok: false,
        layer: 'authentication',
        httpStatus: 401,
        message: 'The provider refused the credential at https://api.acme.example/v1/me (401).',
      },
    });

    const outcome = await submitCapture({
      tenantId: TENANT,
      accountId: ACCOUNT,
      token: 'liftoff_cap_x',
      credential: 'a-key-that-does-not-work',
    });

    // NOT pending. `error` is what the Connections page shows and what a
    // reconnect is offered from.
    expect(outcome).toMatchObject({ kind: 'connected', status: 'error', connectorId: CONNECTOR });
    // The reason names the LAYER, because a 401 is not proof the person typed
    // the key wrong: placement, host, environment and scope come first.
    expect(outcome).toMatchObject({ verification: { layer: 'authentication' } });

    // A failed verification still connected something, so the claim carries
    // the connector id and the link is spent. Retrying is a RECONNECT, not a
    // replay of this link.
    expect(mockRecordConnector).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: CONNECTOR }),
    );
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('a second submit of the same link returns the first connection and registers nothing', async () => {
    mockClaim.mockResolvedValue({
      kind: 'already_connected',
      token: token({ connectorId: CONNECTOR }),
    });
    mockListCustomApi.mockResolvedValue([
      { connectorId: CONNECTOR, name: 'Acme CRM', providerSlug: 'acme-crm', apiHosts: ['api.acme.example'], operationCount: 42 },
    ]);
    mockListConnectors.mockResolvedValue([{ id: CONNECTOR, type: 'custom_api_connector', status: 'active' }]);

    const outcome = await submitCapture({
      tenantId: TENANT,
      accountId: ACCOUNT,
      token: 'liftoff_cap_x',
      credential: 'the-same-key-again',
    });

    expect(outcome).toMatchObject({
      kind: 'connected',
      connectorId: CONNECTOR,
      status: 'active',
      operationCount: 42,
    });
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('a submit while the first one is still running waits instead of starting a second', async () => {
    mockClaim.mockResolvedValue({ kind: 'in_progress', token: token() });

    const outcome = await submitCapture({
      tenantId: TENANT,
      accountId: ACCOUNT,
      token: 'liftoff_cap_x',
      credential: 'the-same-key-again',
    });

    expect(outcome.kind).toBe('in_progress');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('a claim whose attempt died is re-driven against the SAME attempt id', async () => {
    mockClaim.mockResolvedValue({ kind: 'redrive', token: token() });
    mockRegister.mockResolvedValue({
      connectorId: CONNECTOR,
      status: 'active',
      operationCount: 42,
      // connector-service found the connector the dead attempt had already
      // created, keyed on the attempt id, rather than creating a second one.
      reused: true,
    });

    const outcome = await submitCapture({
      tenantId: TENANT,
      accountId: ACCOUNT,
      token: 'liftoff_cap_x',
      credential: 'the-same-key-again',
    });

    expect(outcome).toMatchObject({ kind: 'connected', connectorId: CONNECTOR });
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: 'attempt-1' }),
    );
  });

  it('releases the claim when connector-service was never reached, so the same link works again', async () => {
    mockClaim.mockResolvedValue({ kind: 'claimed', token: token() });
    mockRegister.mockRejectedValue(new Error('ECONNREFUSED'));

    const outcome = await submitCapture({
      tenantId: TENANT,
      accountId: ACCOUNT,
      token: 'liftoff_cap_x',
      credential: 'a-key',
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'registration_failed' });
    expect(mockRelease).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
    expect(mockRecordConnector).not.toHaveBeenCalled();
  });

  it('relays a named specification refusal and releases the link', async () => {
    mockClaim.mockResolvedValue({ kind: 'claimed', token: token() });
    mockRegister.mockResolvedValue({
      refused: 'unsupported_specification',
      message: 'That specification contains operations this connection cannot dispatch...',
      operations: ['POST /v1/files'],
    });

    const outcome = await submitCapture({
      tenantId: TENANT,
      accountId: ACCOUNT,
      token: 'liftoff_cap_x',
      credential: 'a-key',
    });

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'unsupported_specification',
      operations: ['POST /v1/files'],
    });
    expect(mockRelease).toHaveBeenCalled();
  });
});
