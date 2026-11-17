// Tests for the WAL-side transport of the reconciliation job.
//
// The job compares two independent sources, so the failure that matters most
// is not "the diff is wrong" — it is the job reporting a confident answer when
// it could not actually ask one of the sides. Every test here is about that.

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn().mockResolvedValue({ authorization: 'Bearer id-token' }),
}));

import { fetchWalKeys } from '../reconcile-wal-vs-governance';

const OPTS = {
  tenantId: 'liftoffos',
  tenantRuntimeUrl: 'https://agent-service.example',
  tenantServiceToken: 'tok',
  governanceDbHost: '/cloudsql/x',
  governanceDbPort: 5432,
  governanceDbName: 'governance_engine',
  governanceDbUser: 'governance_app',
  governanceDbPassword: 'pw',
  windowHours: 25,
};

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

it('sends the service-auth header and the configured window', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ keys: ['a'], tenantIds: ['liftoffos'] }),
  });

  await fetchWalKeys(OPTS);

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toContain('/api/internal/governance/wal-keys');
  expect(url).toContain('windowHours=25');
  expect(init.headers['x-service-auth']).toBe('tok');
});

// agent-service enforces IAM run.invoker, so the service token alone gets a
// platform-level 403 that never reaches the runtime's own auth.
it('sends the OIDC identity token alongside the service token', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) });
  await fetchWalKeys(OPTS);
  const init = fetchMock.mock.calls[0][1];
  expect(init.headers.authorization).toBe('Bearer id-token');
  expect(init.headers['x-service-auth']).toBe('tok');
});

it('returns the key set and the runtime-reported tenant ids', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ keys: ['a', 'b'], tenantIds: ['liftoffos'] }),
  });

  const r = await fetchWalKeys(OPTS);
  expect([...r.keys].sort()).toEqual(['a', 'b']);
  expect(r.tenantIds).toEqual(['liftoffos']);
});

// The whole point. A 500 from the runtime must not read as "the runtime
// replicated nothing", which would report every governance row as an orphan.
it('throws on a non-200 rather than reporting an empty WAL', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
  await expect(fetchWalKeys(OPTS)).rejects.toThrow(/returned 500/);
});

it('throws when the body has no keys array', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ tenantIds: ['liftoffos'] }) });
  await expect(fetchWalKeys(OPTS)).rejects.toThrow(/no keys array/);
});

it('propagates a network failure instead of swallowing it', async () => {
  fetchMock.mockRejectedValue(new Error('ECONNRESET'));
  await expect(fetchWalKeys(OPTS)).rejects.toThrow('ECONNRESET');
});

it('tolerates a runtime that omits tenantIds', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) });
  const r = await fetchWalKeys(OPTS);
  expect(r.tenantIds).toEqual([]);
  expect(r.keys.size).toBe(0);
});

it('does not double the slash when the base URL has a trailing one', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) });
  await fetchWalKeys({ ...OPTS, tenantRuntimeUrl: 'https://agent-service.example' });
  expect(fetchMock.mock.calls[0][0]).not.toContain('//api/internal');
});
