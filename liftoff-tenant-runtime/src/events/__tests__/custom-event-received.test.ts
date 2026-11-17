// Tests for the event.custom_received → agent-executor handler in
// subscriber.ts. Verifies the handler:
//   - re-checks agent lifecycle before invoking
//   - propagates trustLevel='untrusted_inbound' to the executor
//   - sets harvestEligible=false on the executor input
//   - skips invocation when the target agent isn't ACTIVE
//   - routes to the correct agentId from the envelope payload

const mockPool = { query: jest.fn() };

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPool),
  getPoolForService: jest.fn(() => mockPool),
  pool: new Proxy({} as Record<string, unknown>, {
    get(_, prop) { return (mockPool as Record<string, unknown>)[prop as string]; },
  }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../instruction-compiler/internal-agent-instruction-service', () => ({
  internalAgentInstructionService: { createAndActivateForInternalAgent: jest.fn() },
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({})),
}));

const mockExecuteTask = jest.fn().mockResolvedValue({ success: true });
const mockCreateThread = jest.fn().mockResolvedValue({ id: 'thread-1' });
const mockUpdateThreadStatus = jest.fn().mockResolvedValue(undefined);

jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: { executeTask: (input: unknown) => mockExecuteTask(input) },
}));
jest.mock('../../invocations/service', () => ({
  invocationsService: {
    createThread: (input: unknown) => mockCreateThread(input),
    updateThreadStatus: (id: string, t: string, s: string) => mockUpdateThreadStatus(id, t, s),
  },
}));

// dispatchEvent is what the push handler calls. Import after mocks.

import { dispatchEvent } from '../subscriber';

function buildEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'evt-1',
    tenant_id: '00000000-0000-0000-0000-000000000001',
    entity_type: 'event_source',
    entity_id: '00000000-0000-0000-0000-0000000000aa',
    event_type: 'event.custom_received',
    event_version: 1,
    occurred_at: new Date().toISOString(),
    payload: {
      sourceId: '00000000-0000-0000-0000-0000000000aa',
      triggerRuleId: '00000000-0000-0000-0000-0000000000bb',
      agentId: '00000000-0000-0000-0000-0000000000cc',
      deliveryId: '00000000-0000-0000-0000-0000000000dd',
      trustLevel: 'untrusted_inbound',
      harvestEligible: false,
      event: {
        eventId: 'evt_payload_1',
        eventType: 'lead.created',
        occurredAt: '2026-05-15T00:00:00Z',
        subject: { type: 'lead', id: 'lead_1' },
        actor: { type: 'system', id: 'untrusted_source' },
        data: { company: 'Acme' },
        contentRedacted: false,
      },
      receivedAt: '2026-05-15T00:00:00Z',
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockExecuteTask.mockClear();
  mockCreateThread.mockClear();
  mockUpdateThreadStatus.mockClear();
});

describe('handleCustomEventReceived', () => {
  // Helper for the standard mapping-row + lifecycle response.
  const mappingResponse = (runtimeId = 'runtime-agent-1', lifecycle = 'ACTIVE') => ({
    rows: [{ agent_id: runtimeId, lifecycle }],
  });

  it('resolves PB internal_agent_id → runtime agent_id and invokes executor with the runtime id', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('internal_agent_runtime_mapping')) return mappingResponse('runtime-cc');
      return { rows: [] };
    });

    await dispatchEvent(buildEvent());

    expect(mockExecuteTask).toHaveBeenCalledTimes(1);
    const input = mockExecuteTask.mock.calls[0][0];

    // The executor input MUST use the runtime agent id, not the PB id
    // from the payload. (PB id was '...cc'; mapping resolves to 'runtime-cc'.)
    expect(input.agentId).toBe('runtime-cc');

    // Trigger union still carries the wire payload as-is.
    expect(input.trigger).toMatchObject({
      kind: 'custom_event',
      trustLevel: 'untrusted_inbound',
    });
    expect(input.trigger.source.sourceId).toBe('00000000-0000-0000-0000-0000000000aa');
    expect(input.trigger.event.eventType).toBe('lead.created');

    expect(input.triggeredBy).toBe('event');
    expect(input.inputData.harvestEligible).toBe(false);
    expect(input.inputData.webhookEvent.eventType).toBe('lead.created');
    expect(input.inputData.webhookEvent.contentRedacted).toBe(false);

    // workflow_id / action_id columns downstream (usage_events,
    // workflow_escalations, workflows) are typed UUID. The handler must
    // produce bare UUIDs — a non-UUID prefix would cause INSERTs to fail
    // and trigger a Pub/Sub retry loop.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(input.workflowId).toMatch(uuidRe);
    expect(input.taskId).toMatch(uuidRe);
  });

  it('thread is created with the runtime agent id (not the PB id)', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('internal_agent_runtime_mapping')) return mappingResponse('runtime-cc');
      return { rows: [] };
    });
    await dispatchEvent(buildEvent());
    expect(mockCreateThread).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'runtime-cc',
    }));
  });

  it('skips invocation when target agent lifecycle is not ACTIVE', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('internal_agent_runtime_mapping')) return mappingResponse('runtime-cc', 'PAUSED');
      return { rows: [] };
    });

    await dispatchEvent(buildEvent());

    expect(mockExecuteTask).not.toHaveBeenCalled();
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('drops event when the runtime has no mapping for the PB internal_agent_id', async () => {
    // mapping query returns zero rows → "drift" case the reconciler is
    // supposed to repair; handler must not blow up.
    mockPool.query.mockImplementation(async () => ({ rows: [] }));

    await dispatchEvent(buildEvent());

    expect(mockExecuteTask).not.toHaveBeenCalled();
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('drops event when payload lacks agentId', async () => {
    mockPool.query.mockImplementation(async () => mappingResponse());
    await dispatchEvent(buildEvent({
      payload: { event: { eventType: 't', eventId: 'e' } },
    }));
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('drops event when payload lacks event envelope', async () => {
    mockPool.query.mockImplementation(async () => mappingResponse());
    await dispatchEvent(buildEvent({
      payload: { agentId: '00000000-0000-0000-0000-0000000000cc' },
    }));
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('updates the thread status from executor result', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('internal_agent_runtime_mapping')) return mappingResponse();
      return { rows: [] };
    });
    mockExecuteTask.mockResolvedValueOnce({ success: false, escalated: true });
    await dispatchEvent(buildEvent());
    expect(mockUpdateThreadStatus).toHaveBeenCalledWith(
      'thread-1',
      '00000000-0000-0000-0000-000000000001',
      'waiting_on_human',
    );
  });

  it('passes a per-(agent,event) triggerKey and onConflict:defer so lock contention is durably retried', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('internal_agent_runtime_mapping')) return mappingResponse('runtime-xyz');
      return { rows: [] };
    });
    await dispatchEvent(buildEvent());
    const input = mockExecuteTask.mock.calls[0][0];
    // event_id 'evt-1' + the resolved runtime agent id → one ledger row per (agent,event).
    expect(input.triggerKey).toBe('evt:evt-1:runtime-xyz');
    expect(input.onConflict).toBe('defer');
  });

  it('leaves the thread untouched when the run is deferred (stays open for the durable retry)', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('internal_agent_runtime_mapping')) return mappingResponse();
      return { rows: [] };
    });
    // A deferred run is NOT a terminal outcome — the thread must not be marked failed.
    mockExecuteTask.mockResolvedValueOnce({ success: false, deferred: true });
    await dispatchEvent(buildEvent());
    expect(mockUpdateThreadStatus).not.toHaveBeenCalled();
  });
});
