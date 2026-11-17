// resolveConnectorId unit tests.
//
// The poller resolves a connector TYPE (source.connectorRef) to the concrete
// connectors.id UUID that connector-service.execute expects. It must query the
// real `connectors` table (NOT the phantom agent_integration_permissions) by
// tenant + type + status='active', preferring the agent's own connector and
// falling back to a tenant-shared one (agent_id IS NULL). It throws when no
// active connector matches, so the poller's catch can markError the row.

const mockPoolQuery = jest.fn();

// Mock the transitive imports the poller pulls in at module load so importing
// it doesn't drag in ../fire -> ../../invocations/service (which touches the
// real pool at import time). Mirrors computed-metric-edge.test.ts.
jest.mock('../repository', () => ({ reactiveSubscriptionRepo: {} }));
jest.mock('../../connectors/connector-service-client', () => ({ getConnectorServiceClient: () => ({ execute: jest.fn() }) }));
jest.mock('../fire', () => ({ fireAgentForSubscription: jest.fn() }));
jest.mock('../predicate-evaluator', () => ({ evaluate: jest.fn() }));
jest.mock('../../infrastructure/database', () => ({ getPool: () => ({ query: mockPoolQuery }) }));
jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { resolveConnectorId } from '../computed-metric-poller';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveConnectorId', () => {
  it('queries the connectors table by tenant + type + active status with agent scoping and returns the id', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'conn-uuid-1' }] });

    const id = await resolveConnectorId('t1', 'a1', 'slack');

    expect(id).toBe('conn-uuid-1');
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    // Resolves against the real connectors table, not the phantom one.
    expect(sql).toMatch(/FROM connectors/);
    expect(sql).not.toMatch(/agent_integration_permissions/);
    // Scoped by tenant, type, active status, and agent-or-shared.
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(sql).toMatch(/type = \$3/);
    expect(sql).toMatch(/status = 'active'/);
    expect(sql).toMatch(/agent_id = \$2 OR agent_id IS NULL/);
    // Prefers the agent's own connector over a tenant-shared one.
    expect(sql).toMatch(/ORDER BY \(agent_id = \$2\) DESC/);
    expect(params).toEqual(['t1', 'a1', 'slack']);
  });

  it('throws when no active connector matches the ref', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    await expect(resolveConnectorId('t1', 'a1', 'slack')).rejects.toThrow(
      /connectorRef 'slack' not found in connectors for tenant t1/,
    );
  });
});
