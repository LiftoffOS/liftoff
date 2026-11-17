// Integration Enrichment Tests
//
// Tests enrichIntegrationsWithType — the function that stamps a `type` field onto each
// integration permission entry at Pub/Sub publish time so the tenant runtime can resolve
// integrations by connector type rather than by UUID.

const mockQuery = jest.fn();
const mockResolveConnectorTypes = jest.fn();

jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  pool: { query: mockQuery },
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../connectors/connector-service-client', () => ({
  resolveConnectorTypes: (...args: unknown[]) => mockResolveConnectorTypes(...args),
}));

import { enrichIntegrationsWithType } from '../integration-enrichment';
import type { IntegrationPermission } from '../types';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

// Helper: set up the three parallel lookups (connector-service resolveTypes,
// external_agents query, internal_agents query) in order.
function setupDbMocks(
  connectorRows: { id: string; type: string; status?: string }[],
  externalAgentRows: { id: string }[],
  internalAgentRows: { id: string }[],
) {
  mockResolveConnectorTypes.mockResolvedValueOnce(
    connectorRows.map((r) => ({ id: r.id, type: r.type, status: r.status ?? 'active' })),
  );
  mockQuery
    .mockResolvedValueOnce({ rows: externalAgentRows })
    .mockResolvedValueOnce({ rows: internalAgentRows });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('enrichIntegrationsWithType', () => {
  // --- Empty / null / undefined ---

  it('returns empty array for empty input without querying DB', async () => {
    const result = await enrichIntegrationsWithType(TENANT_ID, []);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns empty array for null input', async () => {
    const result = await enrichIntegrationsWithType(TENANT_ID, null);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns empty array for undefined input', async () => {
    const result = await enrichIntegrationsWithType(TENANT_ID, undefined);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // --- Connector enrichment ---

  it('enriches connector integration with connector type from DB', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000001';
    setupDbMocks([{ id, type: 'google_sheets' }], [], []);

    const input: IntegrationPermission[] = [{ id, selectedObjects: [] }];
    const result = await enrichIntegrationsWithType(TENANT_ID, input);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id, type: 'google_sheets', selectedObjects: [] });
  });

  // --- External agent enrichment ---

  it('enriches external agent integration with type: external_agent', async () => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000001';
    setupDbMocks([], [{ id }], []);

    const input: IntegrationPermission[] = [{ id, selectedObjects: [] }];
    const result = await enrichIntegrationsWithType(TENANT_ID, input);

    expect(result[0]).toMatchObject({ id, type: 'external_agent' });
  });

  // --- Internal agent enrichment ---

  it('enriches internal agent with type: internal_agent and defaults collaborationMode to two_way', async () => {
    const id = 'cccccccc-0000-0000-0000-000000000001';
    setupDbMocks([], [], [{ id }]);

    const input: IntegrationPermission[] = [{ id, selectedObjects: [] }];
    const result = await enrichIntegrationsWithType(TENANT_ID, input);

    expect(result[0]).toMatchObject({ id, type: 'internal_agent', collaborationMode: 'two_way' });
  });

  it('preserves explicit collaborationMode on internal agent — does not overwrite with default', async () => {
    const id = 'cccccccc-0000-0000-0000-000000000002';
    setupDbMocks([], [], [{ id }]);

    const input: IntegrationPermission[] = [
      { id, selectedObjects: [], collaborationMode: 'receive_delegated' },
    ];
    const result = await enrichIntegrationsWithType(TENANT_ID, input);

    expect(result[0]).toMatchObject({ id, type: 'internal_agent', collaborationMode: 'receive_delegated' });
  });

  // --- Unknown IDs ---

  it('throws on unknown id (no matching connector / external_agent / internal_agent)', async () => {
    const id = 'dddddddd-0000-0000-0000-000000000001';
    setupDbMocks([], [], []);

    const input: IntegrationPermission[] = [{ id, selectedObjects: [] }];
    await expect(enrichIntegrationsWithType(TENANT_ID, input)).rejects.toThrow(
      /no resolvable type/,
    );
  });

  // --- config round-trip ---

  it('preserves the config field on a connector-typed permission', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000010';
    setupDbMocks([{ id, type: 'google_mail' }], [], []);

    const input: IntegrationPermission[] = [
      {
        id,
        selectedObjects: [],
        config: { gmailQuery: 'label:support-agent', sendAs: 'support@example.com' },
      },
    ];
    const result = await enrichIntegrationsWithType(TENANT_ID, input);

    expect(result[0]).toMatchObject({
      id,
      type: 'google_mail',
      config: { gmailQuery: 'label:support-agent', sendAs: 'support@example.com' },
    });
  });

  it('preserves config on a pre-typed permission without re-querying DB', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000011';
    const input: IntegrationPermission[] = [
      {
        id,
        type: 'google_mail',
        selectedObjects: [],
        config: { gmailQuery: 'label:x' },
      },
    ];
    const result = await enrichIntegrationsWithType(TENANT_ID, input);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      id,
      type: 'google_mail',
      config: { gmailQuery: 'label:x' },
    });
  });

  // --- Pre-typed entries (already have a `type` set) ---

  it('applies collaborationMode default to pre-typed internal_agent entry without querying DB', async () => {
    const id = 'eeeeeeee-0000-0000-0000-000000000001';
    const input: IntegrationPermission[] = [
      { id, type: 'internal_agent', selectedObjects: [] },
    ];
    const result = await enrichIntegrationsWithType(TENANT_ID, input);

    expect(result[0]).toMatchObject({ id, type: 'internal_agent', collaborationMode: 'two_way' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not overwrite existing collaborationMode on pre-typed internal_agent entry', async () => {
    const id = 'eeeeeeee-0000-0000-0000-000000000002';
    const input: IntegrationPermission[] = [
      { id, type: 'internal_agent', selectedObjects: [], collaborationMode: 'observe_only' },
    ];
    const result = await enrichIntegrationsWithType(TENANT_ID, input);

    expect(result[0]).toMatchObject({ id, type: 'internal_agent', collaborationMode: 'observe_only' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns pre-typed non-internal-agent entries as-is without querying DB', async () => {
    const id = 'ffffffff-0000-0000-0000-000000000001';
    const input: IntegrationPermission[] = [
      { id, type: 'external_agent', selectedObjects: [] },
    ];
    const result = await enrichIntegrationsWithType(TENANT_ID, input);

    expect(result[0]).toMatchObject({ id, type: 'external_agent' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // --- Connector-service integration ---

  it('calls connector-service resolveConnectorTypes with the unenriched ids', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000099';
    setupDbMocks([{ id, type: 'google_mail' }], [], []);

    const input: IntegrationPermission[] = [{ id, selectedObjects: [] }];
    await enrichIntegrationsWithType(TENANT_ID, input);

    expect(mockResolveConnectorTypes).toHaveBeenCalledWith(TENANT_ID, [id]);
  });

  it('does NOT query the local platform-backend connectors table for connector resolution', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-00000000009a';
    setupDbMocks([{ id, type: 'slack' }], [], []);

    const input: IntegrationPermission[] = [{ id, selectedObjects: [] }];
    await enrichIntegrationsWithType(TENANT_ID, input);

    // mockQuery should have been called for external_agents and internal_agents only.
    // No call should target the `connectors` table.
    for (const call of mockQuery.mock.calls) {
      const sql = String(call[0]);
      expect(sql).not.toMatch(/FROM\s+connectors/i);
    }
  });

  // --- Mixed entries ---

  it('handles mixed pre-typed and unenriched entries, querying DB only for unenriched IDs', async () => {
    const preTypedId = 'eeeeeeee-0000-0000-0000-000000000003';
    const unenrichedId = 'cccccccc-0000-0000-0000-000000000003';
    // Only unenrichedId should be sent to the DB
    setupDbMocks([], [], [{ id: unenrichedId }]);

    const input: IntegrationPermission[] = [
      { id: preTypedId, type: 'internal_agent', selectedObjects: [], collaborationMode: 'observe_only' },
      { id: unenrichedId, selectedObjects: [] },
    ];
    const result = await enrichIntegrationsWithType(TENANT_ID, input);

    expect(result[0]).toMatchObject({ id: preTypedId, type: 'internal_agent', collaborationMode: 'observe_only' });
    expect(result[1]).toMatchObject({ id: unenrichedId, type: 'internal_agent', collaborationMode: 'two_way' });

    // Verify the DB was queried with only the unenriched ID
    const firstQueryParams = mockQuery.mock.calls[0][1];
    expect(firstQueryParams[1]).toEqual([unenrichedId]);
    expect(firstQueryParams[1]).not.toContain(preTypedId);
  });
});
