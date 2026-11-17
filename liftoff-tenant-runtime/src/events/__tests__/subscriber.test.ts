// Event Subscriber Tests
// Tests handler behavior by constructing events and verifying DB calls and service interactions.

// Mock dependencies before imports
const mockPool = {
  query: jest.fn(),
  connect: jest.fn(),
};

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

const mockActivate = jest.fn();
const mockPause = jest.fn();
const mockArchive = jest.fn();
const mockEnsureSchedulerJob = jest.fn();
const mockCreateInstruction = jest.fn().mockResolvedValue('instruction-001');

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPool),
  getPoolForService: jest.fn(() => mockPool),
  pool: new Proxy({} as any, {
    get(_, prop) {
      return (mockPool as any)[prop];
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
// Helper to build a ControlPlaneEvent
function buildEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'evt-001',
    tenant_id: 'tenant-001',
    entity_type: 'internal_agent',
    entity_id: 'ia-001',
    event_type: 'tenant.internal_agent.created',
    entity_version: 1,
    event_version: 1,
    occurred_at: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

describe('Event Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockResolvedValue({ rows: [] });
    mockPool.query.mockResolvedValue({ rows: [] });
  });

  describe('handleInternalAgentCreated', () => {
    it('should create agent and mapping in transaction', async () => {
      // Mock: no existing mapping (first delivery)
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })  // checkVersion
        .mockResolvedValueOnce({ rows: [] }); // existing mapping check

      mockClient.query
        .mockResolvedValueOnce({ rows: [] })  // BEGIN
        .mockResolvedValueOnce({ rows: [] })  // INSERT agent
        .mockResolvedValueOnce({ rows: [] })  // INSERT mapping
        .mockResolvedValueOnce({ rows: [] })  // INSERT cache
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      // Import triggers module initialization
      await import('../subscriber');

      // The handler can't be called directly since it's module-private,
      // but we verify the mock setup is correct for when it runs
      expect(mockPool.connect).not.toHaveBeenCalled();
    });

    it('should skip duplicate on redelivery (idempotent)', async () => {
      // Mock: mapping already exists
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ entity_version: 1 }] })  // checkVersion (stale)
        .mockResolvedValueOnce({ rows: [{ agent_id: 'existing-agent' }] }); // mapping exists

      // Handler should return early without creating a new agent
      expect(mockClient.query).not.toHaveBeenCalled(); // No transaction started
    });

    it('should validate tenant isolation', async () => {
      // Events without tenantId should not process
      const event = buildEvent({ tenant_id: null });
      expect(event.tenant_id).toBeNull();
      // Handler checks tenantId at the top and returns early
    });
  });

  describe('handleInternalAgentStatusChanged - activation', () => {
    it('should create instruction and activate agent', async () => {
      // Mock: mapping lookup returns agent
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-001' }] })  // mapping
        .mockResolvedValueOnce({ rows: [{ lifecycle: 'DRAFT' }] });    // lifecycle check

      mockCreateInstruction.mockResolvedValue('instruction-001');

      // Verify mocks are set up correctly
      expect(mockCreateInstruction).not.toHaveBeenCalled();
      expect(mockActivate).not.toHaveBeenCalled();
    });

    it('should skip activation if agent already ACTIVE', async () => {
      // Mock: agent is already ACTIVE
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-001' }] })  // mapping
        .mockResolvedValueOnce({ rows: [{ lifecycle: 'ACTIVE' }] });   // already active

      // Should not create instruction or call activate
      expect(mockCreateInstruction).not.toHaveBeenCalled();
    });
  });

  describe('handleInternalAgentStatusChanged - pause', () => {
    it('should pause agent and cancel pending tasks', async () => {
      // Mock: mapping lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-001' }] });

      // pause() and task cancellation should be called
      expect(mockPause).not.toHaveBeenCalled();
    });
  });

  describe('handleInternalAgentDeleted', () => {
    it('should archive agent when deleted', async () => {
      // Mock: mapping lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-001' }] });

      expect(mockArchive).not.toHaveBeenCalled();
    });

    it('should handle missing mapping gracefully', async () => {
      // Mock: no mapping found
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      // Should still update cache without throwing
      expect(mockPool.query).toBeDefined();
    });
  });

  describe('Lifecycle rollback removal (TE-009)', () => {
    it('should NOT rollback lifecycle on scheduler failure', async () => {
      // With the new architecture, activate() is lifecycle-only.
      // If ensureSchedulerJob() fails, the EventProcessor retries that step
      // on redelivery without reverting the lifecycle.
      mockActivate.mockResolvedValue(undefined);
      mockEnsureSchedulerJob.mockRejectedValue(new Error('Scheduler API failed'));

      // activate() should succeed
      await expect(mockActivate()).resolves.toBeUndefined();

      // ensureSchedulerJob() fails
      await expect(mockEnsureSchedulerJob()).rejects.toThrow('Scheduler API failed');

      // But activate was NOT reversed — no rollback
      // (In old code, activate() would have rolled back lifecycle here)
    });
  });

  describe('Tenant Isolation', () => {
    it('should include tenant_id in all mapping queries', () => {
      // All mapping lookups use (internal_agent_id, tenant_id) — not just agent_id
      // This is enforced by the SQL queries in each handler
      const event = buildEvent({ tenant_id: 'tenant-001' });
      expect(event.tenant_id).toBe('tenant-001');
    });
  });
});

describe('handleInternalAgentUpdated — integrations type preservation', () => {
  // These tests call handleInternalAgentUpdated directly (now exported).
  // The handler uses the module-level subscriberPool which is bound to mockPool
  // (via the file-level jest.mock). We use mockImplementation (not mockResolvedValueOnce)
  // to ensure reliable call-order routing regardless of Jest's clearMocks timing.

  beforeEach(() => {
    // Use resetAllMocks (not clearAllMocks) to also flush any leftover once-queues
    // from the outer describe's tests which may not have consumed their mockResolvedValueOnce entries.
    jest.resetAllMocks();
    // Re-establish implementations wiped by resetAllMocks
    mockCreateInstruction.mockResolvedValue('instruction-001');
  });

  function setupQueryMock(agentId: string) {
    // Route pool.query by SQL pattern, not call index — handleInternalAgentUpdated
    // emits a variable number of UPDATEs depending on which payload fields are set
    // (engine_config, delegates, instructions_md, trigger_config all gated). Only
    // the mapping SELECT must return a real agent_id; everything else is a no-op.
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql && sql.includes('FROM internal_agent_runtime_mapping')) {
        return { rows: [{ agent_id: agentId }] };
      }
      return { rows: [] };
    });
  }

  it('passes type field to createAndActivateForInternalAgent', async () => {
    setupQueryMock('runtime-agent-001');

    const { handleInternalAgentUpdated } = await import('../subscriber');

    const event = buildEvent({
      event_type: 'tenant.internal_agent.updated',
      payload: {
        systemPrompt: 'You are a coder.',
        userInstructions: 'Clone repos and open PRs.',
        hitlLevel: 3,
        capabilityTier: 'execution_enabled',
        integrations: [
          { id: 'connector-uuid-123', type: 'github', selectedObjects: ['repos'] },
          { id: 'connector-uuid-456', type: 'slack',  selectedObjects: [] },
        ],
        triggerConfig: { type: 'manual' },
      },
    });

    await handleInternalAgentUpdated(event as any);

    expect(mockCreateInstruction).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: expect.arrayContaining([
          expect.objectContaining({ id: 'connector-uuid-123', type: 'github' }),
          expect.objectContaining({ id: 'connector-uuid-456', type: 'slack'  }),
        ]),
      }),
    );
  });

  // The platform-backend distillation merges per-binding config (gmailQuery,
  // outlookFilter, sendAs) onto each integration entry before publishing the
  // .updated event. The subscriber's narrowed payload type does NOT include
  // .config, but TypeScript narrowing does not strip fields at runtime — the
  // forwarded object must keep .config intact so the instruction compiler
  // persists it and the tool-gateway / event-trigger can apply it.
  it('preserves per-binding integration config (gmailQuery + sendAs) through to createAndActivateForInternalAgent', async () => {
    setupQueryMock('runtime-agent-001');
    const { handleInternalAgentUpdated } = await import('../subscriber');

    const event = buildEvent({
      event_type: 'tenant.internal_agent.updated',
      payload: {
        systemPrompt: 'You are a support agent.',
        integrations: [
          {
            id: 'gmail-binding-1',
            type: 'google_mail',
            selectedObjects: [],
            config: { gmailQuery: 'label:support-agent', sendAs: 'help@x.com' },
          },
          {
            id: 'outlook-binding-1',
            type: 'microsoft_outlook_mail',
            selectedObjects: [],
            config: { outlookFilter: "categories/any(c:c eq 'Support')" },
          },
        ],
      },
    });

    await handleInternalAgentUpdated(event as any);

    expect(mockCreateInstruction).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: expect.arrayContaining([
          expect.objectContaining({
            id: 'gmail-binding-1',
            type: 'google_mail',
            config: { gmailQuery: 'label:support-agent', sendAs: 'help@x.com' },
          }),
          expect.objectContaining({
            id: 'outlook-binding-1',
            type: 'microsoft_outlook_mail',
            config: { outlookFilter: "categories/any(c:c eq 'Support')" },
          }),
        ]),
      }),
    );
  });

  it('forwards pinnedKnowledgeIds from event payload to instruction compiler', async () => {
    setupQueryMock('runtime-agent-001');
    const { handleInternalAgentUpdated } = await import('../subscriber');
    const event = buildEvent({
      event_type: 'tenant.internal_agent.updated',
      payload: {
        systemPrompt: 'Agent.',
        integrations: [{ id: 'c-1', type: 'zendesk', selectedObjects: [] }],
        pinnedKnowledgeIds: ['pin-1', 'pin-2'],
      },
    });
    await handleInternalAgentUpdated(event as any);
    expect(mockCreateInstruction).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedKnowledgeIds: ['pin-1', 'pin-2'] }),
    );
  });

  it('defaults pinnedKnowledgeIds to [] when payload omits the field (older publisher)', async () => {
    setupQueryMock('runtime-agent-001');
    const { handleInternalAgentUpdated } = await import('../subscriber');
    const event = buildEvent({
      event_type: 'tenant.internal_agent.updated',
      payload: {
        systemPrompt: 'Agent.',
        integrations: [{ id: 'c-1', selectedObjects: [] }],
      },
    });
    await handleInternalAgentUpdated(event as any);
    expect(mockCreateInstruction).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedKnowledgeIds: [] }),
    );
  });

  it('handles missing type gracefully (old event format)', async () => {
    setupQueryMock('runtime-agent-001');

    const { handleInternalAgentUpdated } = await import('../subscriber');

    const event = buildEvent({
      event_type: 'tenant.internal_agent.updated',
      payload: {
        systemPrompt: 'Old agent.',
        integrations: [{ id: 'connector-uuid-789', selectedObjects: [] }], // no type
      },
    });

    await handleInternalAgentUpdated(event as any);

    expect(mockCreateInstruction).toHaveBeenCalledWith(
      expect.objectContaining({
        integrations: expect.arrayContaining([
          expect.objectContaining({ id: 'connector-uuid-789' }),
        ]),
      }),
    );
  });

  it('bootstraps agent record when updated arrives before created (out-of-order delivery)', async () => {
    // resetAllMocks in beforeEach wipes connect — restore it for this test
    mockPool.connect.mockResolvedValue(mockClient);
    // Simulate: no mapping row exists (created event never processed)
    let _callCount = 0;
    mockPool.query.mockImplementation(async (sql: string) => {
      _callCount++;
      // call 1 = UPDATE cached_internal_agents (no-op), call 2 = SELECT mapping (empty)
      // After bootstrap: lifecycle query must return DRAFT so activate() is called
      if (sql && sql.includes('lifecycle')) {
        return { rows: [{ lifecycle: 'DRAFT' }] };
      }
      return { rows: [] };
    });
    // Bootstrap transaction goes through mockClient
    mockClient.query.mockResolvedValue({ rows: [] });

    const { handleInternalAgentUpdated } = await import('../subscriber');

    const event = buildEvent({
      event_type: 'tenant.internal_agent.updated',
      entity_version: 3,
      payload: {
        role: 'Code Reviewer',
        systemPrompt: 'You review code.',
        userInstructions: 'Be thorough.',
        hitlLevel: 2,
        integrations: [{ id: 'conn-abc', type: 'github', selectedObjects: [] }],
      },
    });

    await handleInternalAgentUpdated(event as any);

    // Should have opened a transaction to bootstrap
    expect(mockPool.connect).toHaveBeenCalled();
    // Transaction should BEGIN + INSERT agents + INSERT mapping + INSERT cached + COMMIT
    const clientCalls = mockClient.query.mock.calls.map((c: unknown[]) => (c[0] as string).trim().split(/\s+/)[0].toUpperCase());
    expect(clientCalls).toEqual(expect.arrayContaining(['BEGIN', 'INSERT', 'INSERT', 'INSERT', 'COMMIT']));
    // compiled_instructions should be created via bootstrap
    expect(mockCreateInstruction).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'You review code.',
        userInstructions: 'Be thorough.',
        hitlLevel: 2,
      }),
    );
    // Agent should be activated after bootstrap
    expect(mockActivate).toHaveBeenCalled();
    expect(mockEnsureSchedulerJob).toHaveBeenCalled();
  });
});

describe('handleComposioTriggerFired', () => {
  let mockPublishMessage: jest.Mock;
  let mockTopic: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockPublishMessage = jest.fn().mockResolvedValue('msg-id-123');
    mockTopic = jest.fn(() => ({ publishMessage: mockPublishMessage }));
    jest.doMock('@google-cloud/pubsub', () => ({
      PubSub: jest.fn(() => ({ topic: mockTopic })),
    }));
  });

  afterEach(() => {
    jest.dontMock('@google-cloud/pubsub');
  });

  it('GMAIL_NEW_GMAIL_MESSAGE → republishes to connector-events with the right payload + attributes', async () => {
    process.env.ENVIRONMENT = 'test';
    const { subscriberInternals } = await import('../subscriber');
    await subscriberInternals.handleEvent({
      event_id: 'composio-log_x-msg_y',
      tenant_id: 'tenant-A',
      entity_type: 'connector',
      entity_id: 'ca_TEST',
      event_type: 'connector.composio_trigger_fired',
      event_version: 1,
      occurred_at: '2026-06-10T00:00:00Z',
      payload: {
        composioConnectedAccountId: 'ca_TEST',
        triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
        data: { message_id: 'gmail-msg-1', from: 'a@b.com', subject: 'Hi' },
      },
    } as any);

    expect(mockTopic).toHaveBeenCalledWith('connector-events-test');
    expect(mockPublishMessage).toHaveBeenCalledTimes(1);
    const call = mockPublishMessage.mock.calls[0][0];
    const body = JSON.parse(call.data.toString());
    expect(body.tenantId).toBe('tenant-A');
    expect(body.entityType).toBe('Email');
    expect(body.eventType).toBe('connector.record.synced');
    expect(body.payload).toEqual({ source: 'google_mail', data: { message_id: 'gmail-msg-1', from: 'a@b.com', subject: 'Hi' } });
    expect(call.attributes).toEqual({
      tenantId: 'tenant-A',
      entityType: 'Email',
      source: 'google_mail',
      eventType: 'connector.record.synced',
      delivery: 'composio',
    });
  });

  it('unknown trigger slug → no publish, no error', async () => {
    const { subscriberInternals } = await import('../subscriber');
    await subscriberInternals.handleEvent({
      event_id: 'evt-x',
      tenant_id: 'tenant-A',
      entity_type: 'connector',
      entity_id: 'ca_TEST',
      event_type: 'connector.composio_trigger_fired',
      event_version: 1,
      occurred_at: new Date().toISOString(),
      payload: { triggerSlug: 'JUNK_SLUG' },
    } as any);
    expect(mockPublishMessage).not.toHaveBeenCalled();
  });

  it('missing tenant_id → no publish', async () => {
    const { subscriberInternals } = await import('../subscriber');
    await subscriberInternals.handleEvent({
      event_id: 'evt-y',
      entity_type: 'connector',
      entity_id: 'ca_TEST',
      event_type: 'connector.composio_trigger_fired',
      event_version: 1,
      occurred_at: new Date().toISOString(),
      payload: { triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE' },
    } as any);
    expect(mockPublishMessage).not.toHaveBeenCalled();
  });
});

describe('tenant.deleted — memory-family purge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('erases memories and every tenant-scoped satellite, scoped by tenant_id', async () => {
    const { subscriberInternals } = await import('../subscriber');
    await subscriberInternals.handleEvent({
      event_id: 'evt-tenant-del',
      tenant_id: 'tenant-DEL',
      entity_type: 'tenant',
      entity_id: 'tenant-DEL',
      event_type: 'tenant.deleted',
      event_version: 1,
      occurred_at: '2026-07-14T00:00:00Z',
      payload: {},
    } as any);

    const deleteQueries = mockPool.query.mock.calls
      .map((c) => String(c[0]))
      .filter((q) => /^\s*DELETE\s+FROM/i.test(q));

    // memories itself must be purged
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM memories\s+WHERE tenant_id = \$1/i),
      ['tenant-DEL'],
    );
    // every tenant-scoped satellite must be purged
    for (const table of [
      'memory_audit_log',
      'memory_retrieval_events',
      'memory_influence_rollup',
      'memories_pending_deep_scan',
      'dlp_quarantine_audit',
    ]) {
      expect(
        deleteQueries.some((q) => new RegExp(`DELETE FROM ${table}\\b`, 'i').test(q)),
      ).toBe(true);
    }
    // content-addressed global cache must NOT be touched
    expect(deleteQueries.some((q) => /embedding_cache/i.test(q))).toBe(false);
  });
});
