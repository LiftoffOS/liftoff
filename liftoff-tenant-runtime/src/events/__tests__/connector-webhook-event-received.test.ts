// connector.webhook_event_received — the hop that carries a vendor webhook to an agent.
//
// Producer: liftoff-connector-service `src/events/connector-webhook-event.ts`.
// It cannot publish onto the topic agent-service reads — that is a different
// topic of the same name in the tenant project — so the delivery arrives here
// on control-plane-events and this handler forwards it.
//
// Each property below fails SILENTLY when it regresses: a delivered message, a
// green log line, and no agent run.
//
//   1. It republishes at all (the paired-file contract with connector-service).
//   2. `payload.data` survives verbatim, because githubEventMatches filters on
//      GitHub's native field names and a reshaped body matches nothing.
//   3. The dedupe key is the VENDOR delivery id, not the control-plane event id
//      — which is minted fresh per publish and would dedupe nothing.
//   4. Another tenant's event is dropped rather than republished here.

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

// A trimmed but structurally faithful GitHub `pull_request` delivery — every
// field the runtime's githubEventMatches reads is present.
const GITHUB_PR_DATA = {
  action: 'opened',
  pull_request: {
    number: 42,
    draft: false,
    merged: false,
    user: { login: 'Alex Rivera' },
    base: { ref: 'main', repo: { full_name: 'acme/webapp' } },
  },
  repository: { full_name: 'acme/webapp' },
};

function githubEvent(over: Record<string, unknown> = {}) {
  return {
    event_id: 'cpe-uuid-1',
    tenant_id: LOCAL_TENANT,
    entity_type: 'PullRequest',
    entity_id: '2468',
    event_type: 'connector.webhook_event_received',
    event_version: 1,
    occurred_at: '2026-08-26T17:10:00Z',
    payload: {
      source: 'github',
      subtype: 'pull_request',
      connectorId: 'conn-gh-1',
      entityType: 'PullRequest',
      entityId: '2468',
      eventId: 'gh-delivery-abc:tenant-local',
      occurredAt: '2026-08-26T17:10:00Z',
      data: GITHUB_PR_DATA,
    },
    ...over,
  };
}

describe('handleConnectorWebhookEventReceived', () => {
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

  it('republishes a GitHub pull_request onto the tenant connector-events topic', async () => {
    await handle(githubEvent());

    expect(mockTopic).toHaveBeenCalledWith('connector-events-test');
    expect(mockPublishMessage).toHaveBeenCalledTimes(1);

    const call = mockPublishMessage.mock.calls[0][0];
    const body = JSON.parse(call.data.toString());
    expect(body).toMatchObject({
      tenantId: LOCAL_TENANT,
      connectorId: 'conn-gh-1',
      entityType: 'PullRequest',
      entityId: '2468',
      eventType: 'connector.record.synced',
      occurredAt: '2026-08-26T17:10:00Z',
    });
    expect(call.attributes).toEqual({
      tenantId: LOCAL_TENANT,
      entityType: 'PullRequest',
      source: 'github',
      eventType: 'connector.record.synced',
      delivery: 'push',
    });
  });

  it('carries the GitHub body through verbatim', async () => {
    // githubEventMatches reads action / pull_request.draft / pull_request.merged
    // / repository.full_name / base.ref / user.login off this object. Reshaping
    // it makes every one of those filters unmatchable while the event still
    // looks delivered.
    await handle(githubEvent());

    const body = JSON.parse(mockPublishMessage.mock.calls[0][0].data.toString());
    expect(body.payload).toEqual({
      source: 'github',
      subtype: 'pull_request',
      data: GITHUB_PR_DATA,
    });
  });

  it('dedupes on the vendor delivery id, not the control-plane event id', async () => {
    await handle(githubEvent());
    const body = JSON.parse(mockPublishMessage.mock.calls[0][0].data.toString());
    // agent-service passes body.eventId to markEventSeen. The control-plane
    // event_id is a fresh UUID per publish, so keying on it lets a GitHub
    // redelivery run the agent a second time.
    expect(body.eventId).toBe('gh-delivery-abc:tenant-local');
    expect(body.eventUUID).toBe('cpe-uuid-1');
  });

  it('does not republish an event belonging to another tenant', async () => {
    // control-plane-events fans out to every tenant's coordinator, so most
    // deliveries here are somebody else's.
    mockPool.query.mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 }));
    await handle(githubEvent({ tenant_id: 'tenant-someone-else' }));
    expect(mockPublishMessage).not.toHaveBeenCalled();
  });

  it('skips an event with no tenant, source or entityType rather than guessing', async () => {
    await handle(githubEvent({ tenant_id: undefined }));
    await handle(githubEvent({ payload: { source: 'github', data: {} } }));
    await handle(githubEvent({ payload: { entityType: 'PullRequest', data: {} } }));
    expect(mockPublishMessage).not.toHaveBeenCalled();
  });

  it('surfaces a publish failure so Pub/Sub redelivers', async () => {
    mockPublishMessage.mockRejectedValue(new Error('pubsub-boom'));
    await expect(handle(githubEvent())).rejects.toThrow('pubsub-boom');
  });

  it('routes a Slack delivery through the same handler', async () => {
    // Slack has the identical topology problem: publishSlackEvent reaches
    // harvest-service and nothing else without this hop.
    await handle(githubEvent({
      entity_type: 'Message',
      payload: {
        source: 'slack',
        subtype: 'message',
        connectorId: 'conn-slack-1',
        entityType: 'Message',
        entityId: '1717720000.123456',
        eventId: 'Ev0001',
        data: { type: 'message', channel: 'C1', text: 'hi' },
      },
    }));

    const call = mockPublishMessage.mock.calls[0][0];
    const body = JSON.parse(call.data.toString());
    expect(body).toMatchObject({ entityType: 'Message', entityId: '1717720000.123456', eventId: 'Ev0001' });
    expect(body.payload).toEqual({ source: 'slack', subtype: 'message', data: { type: 'message', channel: 'C1', text: 'hi' } });
    expect(call.attributes.source).toBe('slack');
  });

  it('is not reported as an unhandled hole', async () => {
    // The default branch of the dispatch switch records an unwired event type
    // as a hole and skips the version write. If the case label is ever removed,
    // this is what catches it.
    const { logger } = await import('../../infrastructure/logging');
    await handle(githubEvent());
    expect(logger.error).not.toHaveBeenCalledWith(
      'Unhandled event type — no handler is wired for it',
      expect.anything(),
    );
  });
});
