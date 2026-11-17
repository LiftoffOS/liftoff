// Pending Integration Service Tests
//
// Verifies the auto-grant flow: on OAuth callback for a connector type,
// find every internal agent in the tenant whose pending_integrations
// array contains that type, move the entry into the integrations column
// with full access, and strip it from pending.

const mockQuery = jest.fn();

jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  pool: { query: mockQuery },
  getPool: () => ({ query: mockQuery }),
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockPublishEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../../events/publisher', () => ({
  publishEvent: (...args: unknown[]) => mockPublishEvent(...args),
}));

import { resolvePendingIntegrationsForConnector } from '../pending-integration-service';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const CONNECTOR_ID = '00000000-0000-0000-0000-000000000002';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolvePendingIntegrationsForConnector', () => {
  it('returns zero updates when no agents are waiting', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await resolvePendingIntegrationsForConnector(
      TENANT_ID,
      CONNECTOR_ID,
      'hubspot',
    );
    expect(result.agentsUpdated).toBe(0);
    expect(result.agentIds).toEqual([]);
    // Only the SELECT fired; no UPDATEs.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('moves the connector type from pending to integrations with full access', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'agent-1',
            integrations: [],
            pending_integrations: ['hubspot', 'slack'],
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 }); // the UPDATE

    const result = await resolvePendingIntegrationsForConnector(
      TENANT_ID,
      CONNECTOR_ID,
      'hubspot',
    );

    expect(result.agentsUpdated).toBe(1);
    expect(result.agentIds).toEqual(['agent-1']);

    // Verify the UPDATE call passed the new integrations + trimmed pending.
    const updateCall = mockQuery.mock.calls[1];
    const params = updateCall[1];
    expect(params[0]).toBe('agent-1');
    const newIntegrations = JSON.parse(params[1]);
    expect(newIntegrations).toEqual([
      { id: CONNECTOR_ID, type: 'hubspot', selectedObjects: [] },
    ]);
    const newPending = JSON.parse(params[2]);
    expect(newPending).toEqual(['slack']);
  });

  it('normalises kebab-case to snake_case in the pending match', async () => {
    // Agent has 'google-calendar' in pending; incoming type is
    // 'google_calendar'. Both forms should match.
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'agent-1',
            integrations: [],
            pending_integrations: ['google-calendar'],
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await resolvePendingIntegrationsForConnector(
      TENANT_ID,
      CONNECTOR_ID,
      'google_calendar',
    );
    expect(result.agentsUpdated).toBe(1);

    // The SELECT query should have been called with both normalised forms.
    const selectParams = mockQuery.mock.calls[0][1];
    expect(selectParams).toContain('google_calendar');
    expect(selectParams).toContain('google-calendar');
  });

  it('skips agents that already have the connector in integrations (race)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'agent-1',
            integrations: [
              { id: CONNECTOR_ID, type: 'hubspot', selectedObjects: [] },
            ],
            pending_integrations: ['hubspot'],
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await resolvePendingIntegrationsForConnector(
      TENANT_ID,
      CONNECTOR_ID,
      'hubspot',
    );
    // Agent was cleaned up (pending stripped) but not counted as updated.
    expect(result.agentsUpdated).toBe(0);
    expect(result.agentIds).toEqual([]);

    // The UPDATE should have just trimmed pending, not re-added the integration.
    const updateCall = mockQuery.mock.calls[1];
    const params = updateCall[1];
    expect(params[0]).toBe('agent-1');
    const newPending = JSON.parse(params[1]);
    expect(newPending).toEqual([]);
  });

  it('updates multiple matching agents in one call', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { id: 'agent-1', integrations: [], pending_integrations: ['hubspot'] },
          {
            id: 'agent-2',
            integrations: [{ id: 'other', type: 'slack', selectedObjects: [] }],
            pending_integrations: ['hubspot'],
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await resolvePendingIntegrationsForConnector(
      TENANT_ID,
      CONNECTOR_ID,
      'hubspot',
    );
    expect(result.agentsUpdated).toBe(2);
    expect(result.agentIds).toEqual(['agent-1', 'agent-2']);
  });

  it('publishes internal_agent.integrations_updated once per granted agent', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { id: 'agent-1', integrations: [], pending_integrations: ['hubspot'] },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    await resolvePendingIntegrationsForConnector(
      TENANT_ID,
      CONNECTOR_ID,
      'hubspot',
    );
    expect(mockPublishEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'internal_agent',
        entityId: 'agent-1',
        eventType: 'internal_agent.integrations_updated',
        tenantId: TENANT_ID,
        payload: expect.objectContaining({
          connectorId: CONNECTOR_ID,
          connectorType: 'hubspot',
          source: 'auto_grant',
        }),
      }),
    );
  });

  it('does not publish an event when an agent was only cleaned up (already had the integration)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'agent-1',
            integrations: [{ id: CONNECTOR_ID, type: 'hubspot', selectedObjects: [] }],
            pending_integrations: ['hubspot'],
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    await resolvePendingIntegrationsForConnector(
      TENANT_ID,
      CONNECTOR_ID,
      'hubspot',
    );
    expect(mockPublishEvent).not.toHaveBeenCalled();
  });

  it('fails soft on DB errors (returns zero, does not throw)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db boom'));
    const result = await resolvePendingIntegrationsForConnector(
      TENANT_ID,
      CONNECTOR_ID,
      'hubspot',
    );
    expect(result.agentsUpdated).toBe(0);
    expect(result.agentIds).toEqual([]);
  });
});
