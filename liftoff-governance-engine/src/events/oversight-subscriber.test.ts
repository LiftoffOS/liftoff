// Unit tests for the oversight subscriber handler.
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

import {
  handleOversightMessage,
  __resetSubscriberForTests,
} from './oversight-subscriber';

function makeMessage(
  body: Record<string, unknown>,
): { data: Buffer; ack: jest.Mock; nack: jest.Mock } {
  return {
    data: Buffer.from(JSON.stringify(body)),
    ack: jest.fn(),
    nack: jest.fn(),
  };
}

describe('handleOversightMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetSubscriberForTests();
  });

  it('upserts tenant_oversight_cache on tenant.oversight.updated', async () => {
    const msg = makeMessage({
      event_id: 'ev-1',
      event_type: 'tenant.oversight.updated',
      tenant_id: 'tenant-abc',
      entity_version: 3,
      payload: {
        autonomy: 'controlled',
        escalation: 'sensitive',
        sensitiveWork: {
          customerCommunication: true,
          financialActions: true,
          dataChanges: false,
          externalPublishing: true,
          hiringDecisions: false,
        },
        communication: 'review',
      },
    });

    await handleOversightMessage(msg);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.nack).not.toHaveBeenCalled();
    expect(mockClientQuery).toHaveBeenCalledTimes(1);

    const [sql, params] = mockClientQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO tenant_oversight_cache/);
    expect(sql).toMatch(/ON CONFLICT \(tenant_id\) DO UPDATE/);
    expect(sql).toMatch(/GREATEST/);
    expect(params[0]).toBe('tenant-abc');      // tenant_id
    expect(params[1]).toBe(3);                  // entity_version
    expect(params[2]).toBe('controlled');       // autonomy
    expect(params[3]).toBe('sensitive');        // escalation
    expect(JSON.parse(params[4])).toEqual({     // sensitive_work JSONB
      customerCommunication: true,
      financialActions: true,
      dataChanges: false,
      externalPublishing: true,
      hiringDecisions: false,
    });
    expect(params[5]).toBe('review');           // communication
  });

  it('acks and ignores unrelated event types without writing', async () => {
    const msg = makeMessage({
      event_type: 'tenant.entitlement.updated',
      tenant_id: 'tenant-1',
      payload: {},
    });

    await handleOversightMessage(msg);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('nacks on DB failure so Pub/Sub redelivers', async () => {
    mockClientQuery.mockRejectedValueOnce(new Error('db connection refused'));

    const msg = makeMessage({
      event_type: 'tenant.oversight.updated',
      tenant_id: 'tenant-1',
      entity_version: 1,
      payload: { autonomy: 'balanced' },
    });

    await handleOversightMessage(msg);

    expect(msg.nack).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('acks events missing tenant_id and does not write', async () => {
    const msg = makeMessage({
      event_type: 'tenant.oversight.updated',
      payload: { autonomy: 'balanced' },
    });

    await handleOversightMessage(msg);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('acks and drops invalid JSON without crashing', async () => {
    const msg = {
      data: Buffer.from('not valid json {{{'),
      ack: jest.fn(),
      nack: jest.fn(),
    };

    await handleOversightMessage(msg);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('uses default values when payload fields are missing', async () => {
    const msg = makeMessage({
      event_type: 'tenant.oversight.updated',
      tenant_id: 'tenant-xyz',
      entity_version: 1,
      payload: {},  // empty payload — all fields missing
    });

    await handleOversightMessage(msg);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    const [, params] = mockClientQuery.mock.calls[0];
    expect(params[2]).toBe('balanced');   // autonomy default
    expect(params[3]).toBe('sensitive');  // escalation default
    expect(JSON.parse(params[4])).toEqual({});  // empty sensitiveWork
    expect(params[5]).toBe('review');     // communication default
  });

  it('defaults entity_version to 1 when not provided', async () => {
    const msg = makeMessage({
      event_type: 'tenant.oversight.updated',
      tenant_id: 'tenant-2',
      // no entity_version
      payload: { autonomy: 'autonomous' },
    });

    await handleOversightMessage(msg);

    const [, params] = mockClientQuery.mock.calls[0];
    expect(params[1]).toBe(1);  // entity_version default
  });

  describe('all autonomy values', () => {
    it.each(['controlled', 'balanced', 'autonomous'])(
      'upserts autonomy=%s correctly',
      async (autonomy) => {
        const msg = makeMessage({
          event_type: 'tenant.oversight.updated',
          tenant_id: 'tenant-1',
          entity_version: 1,
          payload: { autonomy },
        });

        await handleOversightMessage(msg);

        const [, params] = mockClientQuery.mock.calls[0];
        expect(params[2]).toBe(autonomy);
      },
    );
  });

  describe('all escalation values', () => {
    it.each(['exceptions', 'important', 'sensitive'])(
      'upserts escalation=%s correctly',
      async (escalation) => {
        const msg = makeMessage({
          event_type: 'tenant.oversight.updated',
          tenant_id: 'tenant-1',
          entity_version: 1,
          payload: { escalation },
        });

        await handleOversightMessage(msg);

        const [, params] = mockClientQuery.mock.calls[0];
        expect(params[3]).toBe(escalation);
      },
    );
  });

  describe('all communication values', () => {
    it.each(['draft', 'auto', 'review'])(
      'upserts communication=%s correctly',
      async (communication) => {
        const msg = makeMessage({
          event_type: 'tenant.oversight.updated',
          tenant_id: 'tenant-1',
          entity_version: 1,
          payload: { communication },
        });

        await handleOversightMessage(msg);

        const [, params] = mockClientQuery.mock.calls[0];
        expect(params[5]).toBe(communication);
      },
    );
  });

  describe('sensitive work categories', () => {
    it('stores all five categories in sensitive_work JSONB', async () => {
      const sensitiveWork = {
        customerCommunication: true,
        financialActions: false,
        dataChanges: true,
        externalPublishing: false,
        hiringDecisions: true,
      };

      const msg = makeMessage({
        event_type: 'tenant.oversight.updated',
        tenant_id: 'tenant-1',
        entity_version: 2,
        payload: { autonomy: 'balanced', sensitiveWork },
      });

      await handleOversightMessage(msg);

      const [, params] = mockClientQuery.mock.calls[0];
      expect(JSON.parse(params[4])).toEqual(sensitiveWork);
    });

    it('stores partial sensitive work without error', async () => {
      const msg = makeMessage({
        event_type: 'tenant.oversight.updated',
        tenant_id: 'tenant-1',
        entity_version: 1,
        payload: {
          autonomy: 'balanced',
          sensitiveWork: { customerCommunication: true },
        },
      });

      await handleOversightMessage(msg);

      const [, params] = mockClientQuery.mock.calls[0];
      expect(JSON.parse(params[4])).toEqual({ customerCommunication: true });
    });
  });

  it('uses GREATEST() so out-of-order events do not downgrade entity_version', async () => {
    const msg = makeMessage({
      event_type: 'tenant.oversight.updated',
      tenant_id: 'tenant-3',
      entity_version: 7,
      payload: { autonomy: 'controlled' },
    });

    await handleOversightMessage(msg);

    const [sql] = mockClientQuery.mock.calls[0];
    expect(sql).toMatch(/GREATEST/);
    expect(sql).toMatch(/WHERE EXCLUDED\.entity_version >= tenant_oversight_cache\.entity_version/);
  });
});
