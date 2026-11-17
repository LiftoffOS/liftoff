// Unit tests for the entitlements subscriber handler.
// We mock withTenantScope so we can assert the SQL upsert arguments without
// standing up a real Postgres.

jest.mock('../infrastructure/logging', () => {
  const silent = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { logger: silent, log: silent };
});

const mockClientQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('../infrastructure/database', () => ({
  withTenantScope: async (
    _tenantId: string,
    fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>,
  ) => fn({ query: mockClientQuery }),
  pool: { query: jest.fn() },
}));

import { handleEntitlementMessage } from './entitlements-subscriber';

function makeMessage(
  body: Record<string, unknown>,
): { data: Buffer; ack: jest.Mock; nack: jest.Mock } {
  return {
    data: Buffer.from(JSON.stringify(body)),
    ack: jest.fn(),
    nack: jest.fn(),
  };
}

describe('handleEntitlementMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('upserts cached_entitlements on tenant.entitlement.updated', async () => {
    const msg = makeMessage({
      event_id: 'e-1',
      event_type: 'tenant.entitlement.updated',
      tenant_id: 'tenant-1',
      entity_version: 4,
      payload: {
        customerId: 'cus_abc',
        plan: 'pro',
        operationalStatus: 'active',
      },
    });

    await handleEntitlementMessage(msg);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.nack).not.toHaveBeenCalled();
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    const call = mockClientQuery.mock.calls[0];
    const [sql, params] = call;
    expect(sql).toMatch(/INSERT INTO cached_entitlements/);
    expect(params[0]).toBe('tenant-1'); // tenant_id
    expect(JSON.parse(params[1])).toEqual(
      expect.objectContaining({ customerId: 'cus_abc', plan: 'pro' }),
    );
    expect(params[2]).toBe(4); // entity_version
    expect(params[3]).toBe('active'); // operational_status
  });

  it('acks and ignores unrelated event types without writing', async () => {
    const msg = makeMessage({
      event_type: 'tenant.suspended',
      tenant_id: 'tenant-1',
      payload: {},
    });

    await handleEntitlementMessage(msg);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('nacks on DB failure so Pub/Sub redelivers', async () => {
    mockClientQuery.mockRejectedValueOnce(new Error('db down'));

    const msg = makeMessage({
      event_type: 'tenant.entitlement.updated',
      tenant_id: 'tenant-1',
      entity_version: 1,
      payload: { customerId: 'cus_x' },
    });

    await handleEntitlementMessage(msg);

    expect(msg.nack).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('acks events missing tenant_id and does not write', async () => {
    const msg = makeMessage({
      event_type: 'tenant.entitlement.updated',
      payload: {},
    });
    await handleEntitlementMessage(msg);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('also recognises the legacy tenant.entitlement_updated event type', async () => {
    const msg = makeMessage({
      event_type: 'tenant.entitlement_updated',
      tenant_id: 'tenant-9',
      entity_version: 1,
      payload: { customerId: 'cus_legacy' },
    });

    await handleEntitlementMessage(msg);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
  });
});
