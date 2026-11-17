// Connector Provider Tests
//
// Thin wrapper over tenantRuntimeClient.getActionsByConnector. Tests cover
// happy path, empty response, error → null fallback, and that it converts
// the TimeRange Date objects to ISO strings before calling the client.

const mockGetActionsByConnector = jest.fn();
jest.mock('../../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getActionsByConnector: (...args: unknown[]) => mockGetActionsByConnector(...args),
  },
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { getConnectorHealth } from '../../data-providers/connector-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';
const range = {
  start: new Date('2026-04-01T00:00:00Z'),
  end: new Date('2026-04-08T00:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getConnectorHealth', () => {
  it('forwards tenantId and ISO-string-converted dates to tenantRuntimeClient', async () => {
    mockGetActionsByConnector.mockResolvedValueOnce([]);
    await getConnectorHealth(tenantId, range);
    expect(mockGetActionsByConnector).toHaveBeenCalledWith(
      tenantId,
      '2026-04-01T00:00:00.000Z',
      '2026-04-08T00:00:00.000Z',
    );
  });

  it('returns the connector list when the client succeeds', async () => {
    mockGetActionsByConnector.mockResolvedValueOnce([
      {
        connector: 'gmail',
        totalActions: 100,
        successCount: 95,
        failureCount: 5,
        avgDurationMs: 250,
        errorRate: 0.05,
      },
      {
        connector: 'salesforce',
        totalActions: 30,
        successCount: 28,
        failureCount: 2,
        avgDurationMs: 450,
        errorRate: 0.067,
      },
    ]);

    const result = await getConnectorHealth(tenantId, range);

    expect(result).not.toBeNull();
    expect(result!).toHaveLength(2);
    expect(result![0].connector).toBe('gmail');
    expect(result![1].connector).toBe('salesforce');
  });

  it('returns an empty array when the client returns no connectors', async () => {
    mockGetActionsByConnector.mockResolvedValueOnce([]);
    const result = await getConnectorHealth(tenantId, range);
    expect(result).toEqual([]);
  });

  it('returns null when the client throws (Tenant Runtime unreachable)', async () => {
    mockGetActionsByConnector.mockRejectedValueOnce(new Error('tenant runtime unreachable'));
    const result = await getConnectorHealth(tenantId, range);
    expect(result).toBeNull();
  });
});
