// governanceAuthHeaders OIDC parity tests.
//
// Bug: the REST helper attached ONLY X-Service-Auth, while the Connect-RPC
// interceptor attaches BOTH X-Service-Auth AND the Cloud Run OIDC identity
// token. Governance-engine requires an authenticated invoker (OIDC), so REST
// callers were 403'd -> fail-open. governanceAuthHeaders is private, so these
// tests exercise it through the exported REST caller getGovernanceApprovalPolicy,
// capturing the headers handed to fetch.

const mockBuildOidc = jest.fn();

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: (...a: unknown[]) => mockBuildOidc(...a),
}));

import { getGovernanceApprovalPolicy } from '../governance-service-client';

const originalFetch = global.fetch;
const originalToken = process.env.GOVERNANCE_SERVICE_TOKEN;
const originalUrl = process.env.GOVERNANCE_SERVICE_URL;

let fetchMock: jest.Mock;

function lastHeaders(): Record<string, string> {
  const call = fetchMock.mock.calls[0];
  return (call[1] as { headers: Record<string, string> }).headers;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOVERNANCE_SERVICE_URL = 'https://governance-engine.example.com';
  process.env.GOVERNANCE_SERVICE_TOKEN = 'svc-token-123';
  fetchMock = jest.fn().mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({ id: 'p1' }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.GOVERNANCE_SERVICE_TOKEN;
  else process.env.GOVERNANCE_SERVICE_TOKEN = originalToken;
  if (originalUrl === undefined) delete process.env.GOVERNANCE_SERVICE_URL;
  else process.env.GOVERNANCE_SERVICE_URL = originalUrl;
});

describe('governanceAuthHeaders (via getGovernanceApprovalPolicy)', () => {
  it('attaches BOTH the OIDC identity header and X-Service-Auth when OIDC resolves', async () => {
    mockBuildOidc.mockResolvedValue({ Authorization: 'Bearer oidc-id-token' });

    await getGovernanceApprovalPolicy('t1', 'a1', 'gate');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The OIDC header is built against the resolved governance base URL.
    expect(mockBuildOidc).toHaveBeenCalledWith('https://governance-engine.example.com');
    const headers = lastHeaders();
    expect(headers['Authorization']).toBe('Bearer oidc-id-token');
    expect(headers['X-Service-Auth']).toBe('svc-token-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('still attaches X-Service-Auth and does not throw when OIDC rejects (local dev, no metadata server)', async () => {
    mockBuildOidc.mockRejectedValue(new Error('no metadata server'));

    // Must not throw despite the OIDC failure.
    const result = await getGovernanceApprovalPolicy('t1', 'a1', 'gate');
    expect(result).toEqual({ id: 'p1' });

    const headers = lastHeaders();
    expect(headers['X-Service-Auth']).toBe('svc-token-123');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('omits X-Service-Auth when no token env is set but still attaches OIDC', async () => {
    delete process.env.GOVERNANCE_SERVICE_TOKEN;
    mockBuildOidc.mockResolvedValue({ Authorization: 'Bearer oidc-id-token' });

    await getGovernanceApprovalPolicy('t1', 'a1', 'gate');

    const headers = lastHeaders();
    expect(headers['X-Service-Auth']).toBeUndefined();
    expect(headers['Authorization']).toBe('Bearer oidc-id-token');
  });
});
