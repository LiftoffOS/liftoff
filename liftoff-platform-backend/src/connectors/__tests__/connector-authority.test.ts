// Tests for the two readers that were answering connector questions from this
// repo's own `connectors` table (INV-PB-012 / ADR-049).
//
// That table stopped receiving rows at the Phase 2a cutover. It does not error
// on a connector it has never heard of — it returns no rows, which each caller
// interpreted its own way:
//
//   - harvest's tenant resolver turned a live connector into 404, and harvest
//     nacks on any non-200, so the message retried until it aged out.
//   - the operator dashboard's health panel wrapped three broken queries in
//     `.catch(() => ({ rows: [] }))` and rendered zeros. Two of them could
//     never have run at all: the table has no `connector_type` column (it is
//     `type`) and `connector_sync_logs` does not exist in this database.
//     Zero failing connectors and a query that cannot execute looked the same.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn(async () => ({})),
}));

import { getConnectorOwner, getConnectorHealthSummary } from '../connector-service-client';

const ORIG_ENV = { ...process.env };
let fetchMock: jest.Mock;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIG_ENV, CONNECTOR_SERVICE_URL: 'http://connector.local' };
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  process.env = ORIG_ENV;
});

describe('getConnectorOwner', () => {
  it('resolves the owning tenant from the service that owns connector rows', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { tenantId: 't-1', connectorType: 'google_drive', status: 'active' }),
    );

    const owner = await getConnectorOwner('8fbfbd68-fc15-47d1-b777-dca252f14a0d');

    expect(owner).toEqual({ tenantId: 't-1', connectorType: 'google_drive', status: 'active' });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/connectors/internal/admin/connectors/8fbfbd68-fc15-47d1-b777-dca252f14a0d/tenant',
    );
  });

  it('returns null for a connector that genuinely does not exist', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'Connector not found' }));
    await expect(getConnectorOwner('8fbfbd68-fc15-47d1-b777-dca252f14a0d')).resolves.toBeNull();
  });

  it('throws when the lookup itself fails, so an outage is not read as "no such connector"', async () => {
    // `mockResolvedValue`, not `...Once`: a 5xx is retried once, so a sustained
    // outage answers twice. The property under test is unchanged — a failed
    // lookup must throw rather than return null — it just now takes two
    // attempts to establish that the failure is not momentary.
    fetchMock.mockResolvedValue(jsonResponse(503, { error: 'unavailable' }));
    await expect(getConnectorOwner('8fbfbd68-fc15-47d1-b777-dca252f14a0d')).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('getConnectorHealthSummary', () => {
  it('returns the estate roll-up from the owning service', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        totalConnectors: 21,
        activeCount: 12,
        errorCount: 1,
        disconnectedCount: 7,
        pendingCount: 1,
        connectorsWithSyncErrorsLast24h: 2,
        connectorsByType: { google_drive: 3 },
        recentSyncFailures: [],
      }),
    );

    const summary = await getConnectorHealthSummary();

    expect(summary.totalConnectors).toBe(21);
    expect(summary.connectorsByType).toEqual({ google_drive: 3 });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/connectors/internal/admin/health/summary',
    );
  });

  it('throws instead of reporting an empty, healthy-looking estate', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'connection refused' }));
    await expect(getConnectorHealthSummary()).rejects.toThrow(/500/);
  });
});
