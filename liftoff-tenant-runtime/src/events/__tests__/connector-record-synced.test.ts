// connector.record_synced — the hop that carries a POLLED record to an agent.
//
// Producer: liftoff-connector-service `src/events/connector-record-synced.ts`.
// Sibling of connector-webhook-event-received.test.ts, and the same topology:
// connector-service publishes `connector-events-${env}` in the CONTROL project,
// whose only subscriber is harvest-service, while agent-service reads a
// same-named topic in the TENANT project. Nothing bridges them, so a polled
// record reaches an agent only through this handler.
//
// Until this existed, every poll-reactive connector in the catalog advertised
// event topics that could not fire. Each property below fails SILENTLY when it
// regresses: a delivered message, a green log line, and no agent run.
//
//   1. It republishes at all (the paired-file contract with connector-service).
//   2. `payload.data` survives verbatim — the event filters and the agent's
//      input template read the normalized record off exactly this object.
//   3. The dedupe key is the POLLER's `${externalId}-${version}`, not the
//      control-plane event id. The poller re-emits every visible record every
//      cycle, so the wrong key wakes an agent once a minute per record forever.
//   4. Another tenant's record is dropped rather than republished here.

const mockPool = { query: jest.fn(), connect: jest.fn() };

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPool),
  getPoolForService: jest.fn(() => mockPool),
  pool: new Proxy({} as Record<string, unknown>, {
    get(_, prop) {
      return (mockPool as Record<string, unknown>)[prop as string];
    },
  }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../instruction-compiler/internal-agent-instruction-service', () => ({
  internalAgentInstructionService: { createAndActivateForInternalAgent: jest.fn() },
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    activate: jest.fn(), pause: jest.fn(), archive: jest.fn(), ensureSchedulerJob: jest.fn(),
  })),
}));
jest.mock('../../connectors/tool-schema-cache', () => ({ getToolSchemas: jest.fn().mockReturnValue([]) }));
jest.mock('../../tool-gateway/external-agent-handler', () => ({
  externalAgentHandler: { clearConfigCache: jest.fn() },
}));
jest.mock('../../tools/standard-tool-handler', () => ({
  anchorClient: { closeSession: jest.fn(), deleteIdentity: jest.fn() },
}));

const LOCAL_TENANT = 'tenant-local';

// A normalized Attio person record, as the poller's normalizer emits it.
const ATTIO_CONTACT_DATA = {
  name: 'Ada Lovelace',
  email_addresses: ['ada@example.com'],
  __attioObject: 'people',
};

function pollEvent(over: Record<string, unknown> = {}) {
  return {
    event_id: 'cpe-uuid-poll-1',
    tenant_id: LOCAL_TENANT,
    entity_type: 'Contact',
    entity_id: 'rec-123',
    event_type: 'connector.record_synced',
    event_version: 1,
    occurred_at: '2026-08-29T04:00:00Z',
    payload: {
      source: 'attio',
      connectorId: 'conn-attio-1',
      entityType: 'Contact',
      entityId: 'rec-123',
      eventId: 'rec-123-v4',
      occurredAt: '2026-08-29T04:00:00Z',
      data: ATTIO_CONTACT_DATA,
    },
    ...over,
  };
}

describe('handleConnectorRecordSynced', () => {
  let mockPublishMessage: jest.Mock;
  let mockTopic: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.ENVIRONMENT = 'test';
    mockPublishMessage = jest.fn().mockResolvedValue('msg-id-1');
    mockTopic = jest.fn(() => ({ publishMessage: mockPublishMessage }));
    jest.doMock('@google-cloud/pubsub', () => ({ PubSub: jest.fn(() => ({ topic: mockTopic })) }));
    // Default: the event's tenant IS this runtime's tenant.
    mockPool.query.mockImplementation((sql: string) =>
      /FROM tenants WHERE id/.test(sql)
        ? Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 }),
    );
  });

  afterEach(() => {
    jest.dontMock('@google-cloud/pubsub');
  });

  const handle = async (event: Record<string, unknown>) => {
    const { subscriberInternals } = await import('../subscriber');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriberInternals.handleEvent(event as any);
  };

  it('republishes a polled record onto the tenant connector-events topic', async () => {
    await handle(pollEvent());

    expect(mockTopic).toHaveBeenCalledWith('connector-events-test');
    expect(mockPublishMessage).toHaveBeenCalledTimes(1);

    const call = mockPublishMessage.mock.calls[0][0];
    const body = JSON.parse(call.data.toString());
    expect(body).toMatchObject({
      tenantId: LOCAL_TENANT,
      connectorId: 'conn-attio-1',
      entityType: 'Contact',
      entityId: 'rec-123',
      eventType: 'connector.record.synced',
      occurredAt: '2026-08-29T04:00:00Z',
    });
    expect(call.attributes).toEqual({
      tenantId: LOCAL_TENANT,
      entityType: 'Contact',
      source: 'attio',
      eventType: 'connector.record.synced',
      delivery: 'poll',
    });
  });

  it('carries the normalized record through verbatim', async () => {
    await handle(pollEvent());

    const body = JSON.parse(mockPublishMessage.mock.calls[0][0].data.toString());
    expect(body.payload).toEqual({ source: 'attio', data: ATTIO_CONTACT_DATA });
  });

  it('dedupes on the poller id, not the control-plane event id', async () => {
    // The poller re-emits every record it can still see on EVERY cycle —
    // harvest-service logs most of its traffic as `reason: unchanged`. The
    // control-plane event_id is a fresh UUID per publish, so keying on it turns
    // an unchanged record into a fresh agent run once a minute, forever.
    await handle(pollEvent());
    const body = JSON.parse(mockPublishMessage.mock.calls[0][0].data.toString());
    expect(body.eventId).toBe('rec-123-v4');
    expect(body.eventUUID).toBe('cpe-uuid-poll-1');
  });

  it('does not republish a record belonging to another tenant', async () => {
    // control-plane-events fans out to every tenant's coordinator, so most
    // deliveries here are somebody else's. Republishing one would put another
    // workspace's CRM records on this workspace's topic.
    mockPool.query.mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 }));
    await handle(pollEvent({ tenant_id: 'tenant-someone-else' }));
    expect(mockPublishMessage).not.toHaveBeenCalled();
  });

  it('skips an event with no tenant, source or entityType rather than guessing', async () => {
    await handle(pollEvent({ tenant_id: undefined }));
    await handle(pollEvent({ payload: { source: 'attio', data: {} } }));
    await handle(pollEvent({ payload: { entityType: 'Contact', data: {} } }));
    expect(mockPublishMessage).not.toHaveBeenCalled();
  });

  it('surfaces a publish failure so Pub/Sub redelivers', async () => {
    mockPublishMessage.mockRejectedValue(new Error('pubsub-boom'));
    await expect(handle(pollEvent())).rejects.toThrow('pubsub-boom');
  });

  it('routes any poll-reactive connector through the same handler', async () => {
    // Nothing here is Attio-specific — the hop was missing for every polled
    // connector, so the fix is generic.
    await handle(pollEvent({
      entity_type: 'CalendarEvent',
      payload: {
        source: 'google_calendar',
        connectorId: 'conn-gcal-1',
        entityType: 'CalendarEvent',
        entityId: 'evt-77',
        eventId: 'evt-77-v2',
        data: { summary: 'Standup' },
      },
    }));

    const call = mockPublishMessage.mock.calls[0][0];
    const body = JSON.parse(call.data.toString());
    expect(body).toMatchObject({ entityType: 'CalendarEvent', entityId: 'evt-77', eventId: 'evt-77-v2' });
    expect(body.payload).toEqual({ source: 'google_calendar', data: { summary: 'Standup' } });
    expect(call.attributes.source).toBe('google_calendar');
  });

  it('is not reported as an unhandled hole', async () => {
    // The default branch of the dispatch switch records an unwired event type
    // as a hole and skips the version write. If the case label is ever removed,
    // this is what catches it — and the failure mode it guards against is
    // exactly the silence this whole change fixes.
    const { logger } = await import('../../infrastructure/logging');
    await handle(pollEvent());
    expect(logger.error).not.toHaveBeenCalledWith(
      'Unhandled event type — no handler is wired for it',
      expect.anything(),
    );
  });
});
