// The balances come from connector-service's internal route under the
// service token; an unreachable service or a malformed answer is nulls with
// the reason, never a guess.

jest.mock('@liftoffos/service-client', () => ({ buildOidcAuthHeader: jest.fn().mockResolvedValue({ Authorization: 'Bearer id' }) }));

import { fetchPlatformVendorBalances } from '../platform-vendor-balances';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; delete process.env.CONNECTOR_SERVICE_URL; delete process.env.CONNECTOR_SERVICE_TOKEN; });

it('reads both figures under the service token, and passes a vendor\'s own error through', async () => {
  process.env.CONNECTOR_SERVICE_URL = 'https://cs.example';
  process.env.CONNECTOR_SERVICE_TOKEN = 'svc';
  const fn = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ locus: { usd: 23.67 }, vaaya: { usd: null, error: 'vaaya wallet: HTTP 503' } }) });
  global.fetch = fn as unknown as typeof fetch;
  const out = await fetchPlatformVendorBalances();
  expect(out).toEqual({ locus: { usd: 23.67 }, vaaya: { usd: null, error: 'vaaya wallet: HTTP 503' } });
  const [url, init] = fn.mock.calls[0];
  expect(url).toBe('https://cs.example/api/connectors/platform-vendors/balances');
  expect((init as { headers: Record<string, string> }).headers).toMatchObject({ 'X-Service-Auth': 'svc', Authorization: 'Bearer id' });
});

it('answers nulls with the reason when the service is unset, refuses, or is down', async () => {
  expect(await fetchPlatformVendorBalances()).toEqual({ locus: { usd: null, error: 'CONNECTOR_SERVICE_URL is not set' }, vaaya: { usd: null, error: 'CONNECTOR_SERVICE_URL is not set' } });
  process.env.CONNECTOR_SERVICE_URL = 'https://cs.example';
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;
  expect((await fetchPlatformVendorBalances()).locus).toEqual({ usd: null, error: 'connector-service answered HTTP 401' });
  global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
  expect((await fetchPlatformVendorBalances()).vaaya).toEqual({ usd: null, error: 'ECONNREFUSED' });
});
