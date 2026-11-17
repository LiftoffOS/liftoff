// The connector catalog must not be cached for the life of the process.
//
// If `_catalogPromise` is memoised with no expiry, a serving revision keeps the
// catalog it fetched at startup. A capability added in connector-service later
// (say `nativeEventDelivery` on the GitHub connector) is then invisible: a
// redistill sees GitHub as unable to deliver events, `deliversEvents` returns
// false, EVENT TOPICS come up empty, and the distiller correctly converts
// reactive responsibilities into cron polling — rebuilding the agent onto the
// design reactive events replaced.
//
// Nothing errors. The output looks like a reasonable decision, which is why it
// takes tracing the whole chain to find rather than reading a log.

const mockFetch = jest.fn();

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getCatalog, _resetCatalogCache } from '../connector-service-client';

const catalog = (marker: string) => ({ connectors: [{ type: marker }], version: marker, categoryLabels: {} });

beforeEach(() => {
  // resolveBaseUrl throws without it; this test is about caching, not routing.
  process.env.CONNECTOR_SERVICE_URL = 'https://connector-service.test';
  jest.restoreAllMocks();
  _resetCatalogCache();
  mockFetch.mockReset();
  global.fetch = ((...a: unknown[]) => mockFetch(...a)) as unknown as typeof fetch;
});

afterEach(() => { jest.useRealTimers(); });

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('catalog cache', () => {
  it('serves from cache inside the TTL — the reason a cache exists', () => {
    // A REST call with a 3s timeout on every read of connector metadata would put
    // a network dependency on the distill path.
    return (async () => {
      mockFetch.mockResolvedValue(ok(catalog('a')));
      await getCatalog();
      await getCatalog();
      await getCatalog();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    })();
  });

  it('REFETCHES once the TTL expires — the defect', async () => {
    jest.useFakeTimers();
    mockFetch.mockResolvedValue(ok(catalog('old')));
    expect((await getCatalog()).version).toBe('old');

    mockFetch.mockResolvedValue(ok(catalog('new')));
    // Six minutes: past the five-minute TTL. Under the old code this returned
    // 'old' forever, for the life of the process.
    jest.advanceTimersByTime(6 * 60 * 1000);

    expect((await getCatalog()).version).toBe('new');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('serves the last good copy when a refresh fails', async () => {
    // Better than throwing: a distillation on a slightly stale catalog beats one
    // that fails outright. The old code cleared the cache and rethrew, putting
    // connector-service availability directly on the distill path.
    jest.useFakeTimers();
    mockFetch.mockResolvedValue(ok(catalog('good')));
    await getCatalog();

    mockFetch.mockRejectedValue(new Error('connector-service down'));
    jest.advanceTimersByTime(6 * 60 * 1000);

    expect((await getCatalog()).version).toBe('good');
  });

  it('still throws when there is nothing good to serve', async () => {
    // A first fetch that fails must not hand back an empty catalog: an empty one
    // reads as "no connector can deliver events", which is how a reactive agent
    // silently becomes a polling one.
    mockFetch.mockRejectedValue(new Error('cold start, service down'));
    await expect(getCatalog()).rejects.toThrow(/cold start/);
  });


  it('_resetCatalogCache clears the value, not just the in-flight promise', async () => {
    mockFetch.mockResolvedValue(ok(catalog('a')));
    await getCatalog();
    _resetCatalogCache();
    mockFetch.mockResolvedValue(ok(catalog('b')));
    expect((await getCatalog()).version).toBe('b');
  });
});
