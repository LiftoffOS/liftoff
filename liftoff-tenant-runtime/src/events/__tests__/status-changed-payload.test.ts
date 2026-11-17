// The control plane's status_changed payload, read end to end.
//
// This event carries the status under `status`; an older control-plane release
// called the same field `newStatus`. The handler read only `newStatus`, so
// every pause and every resume became a silent no-op that Pub/Sub acked as
// success — the runtime's agents.lifecycle only ever caught up on the
// canonical reconciler's five-minute tick, and a person who pressed Resume and
// opened chat was told the agent was still paused.
//
// These tests drive the real dispatch path with the payload the control plane
// actually publishes, so a regression on either name fails here rather than in
// production two minutes after somebody presses a button.

const mockPool = {
  query: jest.fn(),
  connect: jest.fn(),
};

const mockClient = { query: jest.fn(), release: jest.fn() };

const mockActivate = jest.fn();
const mockPause = jest.fn();
const mockArchive = jest.fn();
const mockEnsureSchedulerJob = jest.fn();
const mockCreateInstruction = jest.fn().mockResolvedValue('instruction-001');

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPool),
  getPoolForService: jest.fn(() => mockPool),
  pool: new Proxy({} as Record<string, unknown>, {
    get(_, prop) {
      return (mockPool as unknown as Record<string, unknown>)[prop as string];
    },
  }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../instruction-compiler/internal-agent-instruction-service', () => ({
  internalAgentInstructionService: {
    createAndActivateForInternalAgent: mockCreateInstruction,
  },
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    activate: mockActivate,
    pause: mockPause,
    archive: mockArchive,
    ensureSchedulerJob: mockEnsureSchedulerJob,
  })),
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tool-gateway/external-agent-handler', () => ({
  externalAgentHandler: { clearConfigCache: jest.fn() },
}));
jest.mock('../../tools/standard-tool-handler', () => ({
  anchorClient: { closeSession: jest.fn(), deleteIdentity: jest.fn() },
}));

// The ledger's claim/step bookkeeping is not what these tests are about: run
// every step in order and report success, so an assertion failure means the
// handler chose the wrong branch rather than that a mocked UPDATE returned no
// rows.
jest.mock('../event-processor', () => ({
  EventProcessor: jest.fn().mockImplementation(() => ({
    process: jest.fn(async (_event: unknown, steps: Array<{ execute: (ctx: unknown) => Promise<void> }>) => {
      for (const step of steps) {
        await step.execute({ pool: mockPool, metadata: {} });
      }
      return true;
    }),
  })),
  DlqRoutedError: class DlqRoutedError extends Error {},
  EntityBusyError: class EntityBusyError extends Error {},
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const INTERNAL_AGENT = '22222222-2222-4222-8222-222222222222';
const RUNTIME_AGENT = '33333333-3333-4333-8333-333333333333';

function statusChangedEvent(payload: Record<string, unknown>) {
  return {
    event_id: '44444444-4444-4444-8444-444444444444',
    tenant_id: TENANT,
    entity_type: 'internal_agent',
    entity_id: INTERNAL_AGENT,
    event_type: 'tenant.internal_agent.status_changed',
    entity_version: 25,
    event_version: 1,
    occurred_at: new Date().toISOString(),
    payload,
  };
}

/** Answer by SQL text, not call order — the handler's query sequence is free to
 *  change without silently turning these tests into no-ops. */
function routeQuery(sql: string) {
  if (sql.includes('FROM internal_agent_runtime_mapping')) {
    return { rows: [{ agent_id: RUNTIME_AGENT }] };
  }
  if (sql.includes('FROM cached_internal_agents')) {
    return { rows: [{ status: 'paused' }] };
  }
  return { rows: [] };
}

describe('tenant.internal_agent.status_changed — payload field names', () => {
  let handleEvent: (event: unknown) => Promise<void>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockResolvedValue({ rows: [] });
    mockPool.query.mockImplementation(async (sql: string) => routeQuery(sql));
    const subscriber = await import('../subscriber');
    handleEvent = subscriber.subscriberInternals.handleEvent as unknown as (e: unknown) => Promise<void>;
  });

  it('activates on the `status` field the control plane publishes today', async () => {
    await handleEvent(statusChangedEvent({
      id: INTERNAL_AGENT,
      status: 'active',
      previousStatus: 'paused',
      systemPrompt: 'be useful',
    }));

    expect(mockActivate).toHaveBeenCalledWith(RUNTIME_AGENT);
    expect(mockEnsureSchedulerJob).toHaveBeenCalledWith(RUNTIME_AGENT);
    expect(mockPause).not.toHaveBeenCalled();
  });

  it('pauses on the `status` field the control plane publishes today', async () => {
    await handleEvent(statusChangedEvent({
      id: INTERNAL_AGENT,
      status: 'paused',
      previousStatus: 'active',
    }));

    expect(mockPause).toHaveBeenCalledWith(RUNTIME_AGENT);
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it('still honours the older `newStatus` field', async () => {
    await handleEvent(statusChangedEvent({
      id: INTERNAL_AGENT,
      newStatus: 'active',
      previousStatus: 'paused',
    }));

    expect(mockActivate).toHaveBeenCalledWith(RUNTIME_AGENT);
  });

  it('prefers `newStatus` when a payload somehow carries both', async () => {
    await handleEvent(statusChangedEvent({
      id: INTERNAL_AGENT,
      newStatus: 'paused',
      status: 'active',
    }));

    expect(mockPause).toHaveBeenCalledWith(RUNTIME_AGENT);
    expect(mockActivate).not.toHaveBeenCalled();
  });

  // The regression itself: a status this handler cannot read must NOT be acked
  // as handled. Throwing nacks the message, so Pub/Sub redelivers and the DLQ
  // eventually surfaces it to a person. Returning quietly is what hid a broken
  // pause/resume path for three months.
  it('refuses to ack an event carrying no readable status', async () => {
    await expect(handleEvent(statusChangedEvent({
      id: INTERNAL_AGENT,
      previousStatus: 'paused',
    }))).rejects.toThrow(/no readable status/);

    expect(mockActivate).not.toHaveBeenCalled();
    expect(mockPause).not.toHaveBeenCalled();
  });

  it('refuses to ack a status outside the control plane\'s three values', async () => {
    await expect(handleEvent(statusChangedEvent({
      id: INTERNAL_AGENT,
      status: 'archived',
    }))).rejects.toThrow(/no readable status/);
  });

  // 'draft' is a real control-plane status and neither activates nor pauses;
  // it must resolve cleanly rather than land in the throw above.
  it('accepts draft without activating or pausing', async () => {
    await expect(handleEvent(statusChangedEvent({
      id: INTERNAL_AGENT,
      status: 'draft',
    }))).resolves.toBeUndefined();

    expect(mockActivate).not.toHaveBeenCalled();
    expect(mockPause).not.toHaveBeenCalled();
  });
});
