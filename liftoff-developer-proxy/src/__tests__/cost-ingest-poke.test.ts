// Usage recorded here reaches platform-backend's cost pass only when that pass
// polls the feed, and the pass now runs when armed rather than hourly. The
// poke is what arms it: once per bucket, with the token platform-backend
// already accepts from this service, never throwing, and tried again after a
// failure.

import { jest } from '@jest/globals';

let apiUrl = 'https://pb.test';
jest.unstable_mockModule('../infrastructure/config.js', () => ({
  loadConfig: () => ({ CONTROL_PLANE_API_URL: apiUrl, GCP_PROJECT_ID: 'p', TENANT_RUNTIME_SERVICE_TOKEN_SECRET: 's' }),
}));
jest.unstable_mockModule('@google-cloud/secret-manager', () => ({ SecretManagerServiceClient: jest.fn() }));

const { pokeCostIngest, POKE_BUCKET_MS, _resetPokeMemo } = await import('../usage/cost-ingest-poke.js');

const fetchMock = jest.fn(async () => new Response('', { status: 202 }));
const realFetch = globalThis.fetch;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'pb-token';
});
beforeEach(() => {
  apiUrl = 'https://pb.test';
  _resetPokeMemo();
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

it('pokes the cost pass with the platform-backend token', async () => {
  await pokeCostIngest(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://pb.test/api/internal/jobs/cost-attribution-ingest/soon');
  expect((init.headers as Record<string, string>)['x-service-auth']).toBe('pb-token');
});

it('pokes once per bucket', async () => {
  await pokeCostIngest(1_000);
  await pokeCostIngest(POKE_BUCKET_MS - 1);
  await pokeCostIngest(POKE_BUCKET_MS);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('never throws, and tries again after a failure', async () => {
  fetchMock.mockImplementationOnce(async () => new Response('', { status: 503 }));
  await expect(pokeCostIngest(0)).resolves.toBeUndefined();
  await pokeCostIngest(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('does nothing without a platform-backend to poke', async () => {
  apiUrl = '';
  await pokeCostIngest(0);
  expect(fetchMock).not.toHaveBeenCalled();
});
