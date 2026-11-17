// "Nothing is connected" and "I could not check" must never be the same answer.
//
// listTenantConnectors used to return [] for both. It called /api/connectors,
// which sits below platform-backend's authMiddleware and rejects this service's
// shared token, so it 401'd on every request — and the CAIO told a workspace
// with a dozen connected apps that it was starting from scratch. Nothing failed
// loudly: the catch swallowed the 401 and the caller's empty-list branch is
// indistinguishable from a genuinely empty workspace.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../infrastructure/service-auth.js', () => ({
  getServiceAuthHeaders: jest.fn().mockResolvedValue({
    Authorization: 'Bearer oidc-token',
    'X-Service-Auth': 'workforce-token',
  }),
}));

import { resetConfigForTests } from '../infrastructure/config.js';
import { listTenantConnectors } from '../workforce-plans/tenant-connectors.js';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'https://pb.example.com';
  process.env['GCP_PROJECT_ID'] = 'test';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:us-west1:test-db';
  process.env['WORKFORCE_SERVICE_TOKEN'] = 'workforce-token';
  fetchSpy = jest.spyOn(global, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
  resetConfigForTests();
});

describe('listTenantConnectors', () => {
  it('calls the internal route, not the Firebase-guarded one', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ connectors: [] }),
    } as unknown as Response);

    await listTenantConnectors(TENANT);

    const [url, init] = fetchSpy.mock.calls[0];
    // /api/connectors sits below `app.use('/api', authMiddleware)` and wants a
    // Firebase ID token. This service has a shared secret, so that route can
    // only ever 401 for it.
    expect(String(url)).toContain('/api/internal/connectors');
    expect(String(url)).not.toMatch(/\/api\/connectors\?/);
    expect((init as RequestInit).headers).toMatchObject({
      'X-Service-Auth': 'workforce-token',
    });
  });

  it('reports a failed lookup as a failure, not as an empty workspace', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401 } as unknown as Response);

    const result = await listTenantConnectors(TENANT);

    expect(result.ok).toBe(false);
    // The specific shape that caused the bug: `connectors` must not be readable
    // as an empty list on the failure branch.
    expect((result as { connectors?: unknown }).connectors).toBeUndefined();
    if (!result.ok) expect(result.reason).toContain('401');
  });

  it('reports a network failure the same way', async () => {
    fetchSpy.mockRejectedValue(new Error('socket hang up'));
    const result = await listTenantConnectors(TENANT);
    expect(result.ok).toBe(false);
  });

  it('returns the connectors on success, dropping disconnected rows', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        connectors: [
          { id: 'c1', connectorType: 'gmail', displayName: 'Gmail', status: 'active' },
          { id: 'c2', connectorType: 'slack', displayName: 'Slack', status: 'pending' },
          { id: 'c3', connectorType: 'notion', displayName: 'Notion', status: 'disconnected' },
        ],
      }),
    } as unknown as Response);

    const result = await listTenantConnectors(TENANT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connectors.map(c => c.type)).toEqual(['gmail', 'slack']);
      expect(result.connectors[0].displayName).toBe('Gmail');
    }
  });

  it('distinguishes a genuinely empty workspace from a failure', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ connectors: [] }),
    } as unknown as Response);

    const result = await listTenantConnectors(TENANT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.connectors).toEqual([]);
  });
});
