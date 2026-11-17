// The live connector catalog fetch.
//
// Everything here defends one property: this module never reports "the platform
// does not support that" when the truth is "I could not find out". The CAIO
// reads its output as authority on what exists, and told a customer we had no
// WebClaw connector on the strength of a list that simply had not been updated.
//
// There is no hardcoded fallback. When a refresh fails the module serves the
// last catalog it read, flagged as stale with its age, because a copy that
// refreshes itself cannot fall behind the product the way a constant does.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../infrastructure/config.js', () => ({
  loadConfig: () => ({
    PLATFORM_BACKEND_URL: 'https://pb.example.com/',
    WORKFORCE_SERVICE_TOKEN: 'tok',
  }),
}));

jest.mock('../infrastructure/service-auth.js', () => ({
  getServiceAuthHeaders: jest.fn().mockResolvedValue({ 'x-service-auth': 'tok' }),
}));

import {
  fetchConnectorCatalog,
  _resetConnectorCatalogCache,
} from '../workforce-plans/connector-catalog.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const ONE = [{ type: 'a', displayName: 'A', category: 'c', status: 'available' }];

beforeEach(() => {
  jest.clearAllMocks();
  _resetConnectorCatalogCache();
});

describe('fetchConnectorCatalog', () => {
  it('returns the available entries, trimmed to what the CAIO needs', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        connectors: [
          {
            type: 'webclaw',
            displayName: 'WebClaw',
            category: 'web_tools',
            status: 'available',
            entitySchemas: { huge: 'payload' },
            polling: [],
          },
        ],
      }),
    );

    const result = await fetchConnectorCatalog();

    expect(result).toEqual({
      source: 'live',
      connectors: [{ type: 'webclaw', displayName: 'WebClaw', category: 'web_tools' }],
    });
  });

  it('calls the internal proxy path that carries the service token', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ connectors: ONE }));

    await fetchConnectorCatalog();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://pb.example.com/api/internal/connectors/catalog',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('drops connectors that are not connectable yet', async () => {
    // connector-service downgrades a Composio entry to coming_soon when its auth
    // config is still a placeholder. Recommending one sends the user into an
    // OAuth start that 503s.
    mockFetch.mockResolvedValue(
      jsonResponse({
        connectors: [
          { type: 'ready', displayName: 'Ready', category: 'crm', status: 'available' },
          { type: 'pending', displayName: 'Pending', category: 'crm', status: 'coming_soon' },
        ],
      }),
    );

    const result = await fetchConnectorCatalog();

    expect(result.source).toBe('live');
    expect(result.source !== 'unavailable' && result.connectors.map(c => c.type)).toEqual(['ready']);
  });

  it('reports unavailable, never an empty catalog, when nothing has ever been read', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await fetchConnectorCatalog();

    expect(result).toEqual({ source: 'unavailable', reason: 'ECONNREFUSED' });
  });

  it('reports a non-OK response as a failure', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, false, 503));

    expect((await fetchConnectorCatalog()).source).toBe('unavailable');
  });

  it('treats an empty catalog as a failure', async () => {
    // The service always serves well over a hundred available types, so zero
    // means the response shape moved and the parse matched nothing. Passing that
    // on as a real answer would tell the CAIO the platform supports no apps —
    // and caching it would poison the fallback too.
    mockFetch.mockResolvedValue(jsonResponse({ connectors: [] }));

    expect((await fetchConnectorCatalog()).source).toBe('unavailable');
  });

  it('caches a good answer instead of refetching per turn', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ connectors: ONE }));

    await fetchConnectorCatalog();
    await fetchConnectorCatalog();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  describe('when a refresh fails after a good read', () => {
    // This is the case the hardcoded 48-entry fallback used to serve, badly.
    // The last good copy is whatever the catalog said, so it grows with the
    // product; a constant only grows when someone remembers to edit it.
    it('serves the last good catalog rather than a hand-written list', async () => {
      jest.useFakeTimers();
      try {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({
            connectors: [
              { type: 'webclaw', displayName: 'WebClaw', category: 'web_tools', status: 'available' },
              { type: 'brand_new', displayName: 'Brand New', category: 'crm', status: 'available' },
            ],
          }),
        );
        const first = await fetchConnectorCatalog();
        expect(first.source).toBe('live');

        // Past the TTL, and the refresh now fails.
        jest.advanceTimersByTime(400_000);
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

        const second = await fetchConnectorCatalog();

        expect(second.source).toBe('last_known_good');
        if (second.source !== 'last_known_good') throw new Error('unreachable');
        // Including the connector that only exists because the catalog grew.
        expect(second.connectors.map(c => c.type).sort()).toEqual(['brand_new', 'webclaw']);
        expect(second.ageMs).toBeGreaterThanOrEqual(400_000);
        expect(second.reason).toBe('ECONNREFUSED');
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not cache the failure, so the next call can recover', async () => {
      mockFetch.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(
        jsonResponse({ connectors: ONE }),
      );

      const first = await fetchConnectorCatalog();
      const second = await fetchConnectorCatalog();

      expect(first.source).toBe('unavailable');
      expect(second.source).toBe('live');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
