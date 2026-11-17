// Unit tests for event-trigger helpers.
//
// handleConnectorEvent() has too many heavy dependencies (PubSub, agent execution,
// invocations service) to unit-test as an orchestrator.  We test the two
// pieces that carry the logic we care about:
//   1. registerEventAgent / deregisterEventAgent — pure in-memory registry ops
//   2. markEventSeen — the dedup INSERT-or-skip, tested against a mock pool

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The dispatch orchestrator resolves the agent-execution + invocations services
// lazily via require(); mock both so the defer-on-contention wiring can be tested
// without their heavy real dependencies.
const mockExecuteTask = jest.fn();
const mockCreateThread = jest.fn();
const mockUpdateThreadStatus = jest.fn();
jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: { executeTask: (i: unknown) => mockExecuteTask(i) },
}));
jest.mock('../../invocations/service', () => ({
  invocationsService: {
    createThread: (i: unknown) => mockCreateThread(i),
    updateThreadStatus: (id: string, t: string, s: string) => mockUpdateThreadStatus(id, t, s),
  },
}));

import { getPool } from '../../infrastructure/database';
import {
  registerEventAgent,
  deregisterEventAgent,
  markEventSeen,
  outlookEventMatches,
  getAgentConnectorBindingConfig,
  dispatchConnectorEventDirect,
} from '../event-trigger';

const mockGetPool = getPool as jest.Mock;

// ── 1. Registry ───────────────────────────────────────────────────────────────

describe('registerEventAgent / deregisterEventAgent', () => {
  afterEach(() => {
    deregisterEventAgent('agent-1', 'tenant-1', 'email.received');
    deregisterEventAgent('agent-2', 'tenant-1', 'email.received');
    deregisterEventAgent('agent-1', 'tenant-1', 'ticket.created');
  });

  it('registers an agent so it can be looked up by topic', () => {
    registerEventAgent('agent-1', 'tenant-1', 'email.received');
    // Registering again (idempotent) should not throw
    registerEventAgent('agent-1', 'tenant-1', 'email.received');
  });

  it('deregisters an agent without affecting other agents on the same topic', () => {
    registerEventAgent('agent-1', 'tenant-1', 'email.received');
    registerEventAgent('agent-2', 'tenant-1', 'email.received');
    deregisterEventAgent('agent-1', 'tenant-1', 'email.received');
    // agent-2 still registered — deregister it on cleanup
  });

  it('deregistering a non-existent agent does not throw', () => {
    expect(() =>
      deregisterEventAgent('no-such-agent', 'tenant-99', 'email.received'),
    ).not.toThrow();
  });

  it('registers an agent on multiple topics independently', () => {
    registerEventAgent('agent-1', 'tenant-1', 'email.received');
    registerEventAgent('agent-1', 'tenant-1', 'ticket.created');
    deregisterEventAgent('agent-1', 'tenant-1', 'email.received');
    // ticket.created entry cleaned up by afterEach
  });
});

// ── 2. markEventSeen ──────────────────────────────────────────────────────────

describe('markEventSeen', () => {
  function makeMockPool(rowCount: number) {
    return { query: jest.fn().mockResolvedValue({ rows: [], rowCount }) };
  }

  it('returns true when the INSERT inserts a new row (rowCount=1)', async () => {
    const mockPool = makeMockPool(1);
    mockGetPool.mockReturnValue(mockPool);

    const result = await markEventSeen('tenant-abc', 'event-xyz');

    expect(result).toBe(true);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0] as [string, string[]];
    expect(sql).toContain('INSERT INTO connector_event_seen');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(params).toEqual(['tenant-abc', 'event-xyz']);
  });

  it('returns false when ON CONFLICT fires (rowCount=0 — already seen)', async () => {
    const mockPool = makeMockPool(0);
    mockGetPool.mockReturnValue(mockPool);

    const result = await markEventSeen('tenant-abc', 'event-xyz');

    expect(result).toBe(false);
  });

  it('forwards pool errors to the caller', async () => {
    const mockPool = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    mockGetPool.mockReturnValue(mockPool);

    await expect(markEventSeen('tenant-abc', 'event-xyz')).rejects.toThrow('db down');
  });
});

// ── 3. outlookEventMatches — OData $filter subset predicate ───────────────────

describe('outlookEventMatches', () => {
  it('returns true when filter is undefined (no filter)', () => {
    expect(outlookEventMatches(undefined, {})).toBe(true);
  });

  it('matches from/emailAddress/address eq', () => {
    const msg = { from: { emailAddress: { address: 'Alice@Example.com' } } };
    expect(
      outlookEventMatches("from/emailAddress/address eq 'alice@example.com'", msg),
    ).toBe(true);
    expect(
      outlookEventMatches("from/emailAddress/address eq 'bob@example.com'", msg),
    ).toBe(false);
  });

  it('matches toRecipients/any(t:t/emailAddress/address eq ...)', () => {
    const msg = {
      toRecipients: [
        { emailAddress: { address: 'support@example.com' } },
        { emailAddress: { address: 'cc@example.com' } },
      ],
    };
    expect(
      outlookEventMatches(
        "toRecipients/any(t:t/emailAddress/address eq 'support@example.com')",
        msg,
      ),
    ).toBe(true);
    expect(
      outlookEventMatches(
        "toRecipients/any(t:t/emailAddress/address eq 'other@example.com')",
        msg,
      ),
    ).toBe(false);
  });

  it('matches categories/any(c:c eq ...)', () => {
    const msg = { categories: ['Support', 'Urgent'] };
    expect(
      outlookEventMatches("categories/any(c:c eq 'Support')", msg),
    ).toBe(true);
    expect(
      outlookEventMatches("categories/any(c:c eq 'Sales')", msg),
    ).toBe(false);
  });

  it('composes multiple clauses with AND (all must match)', () => {
    const msg = {
      from: { emailAddress: { address: 'alice@example.com' } },
      categories: ['Support'],
    };
    expect(
      outlookEventMatches(
        "from/emailAddress/address eq 'alice@example.com' and categories/any(c:c eq 'Support')",
        msg,
      ),
    ).toBe(true);
    expect(
      outlookEventMatches(
        "from/emailAddress/address eq 'alice@example.com' and categories/any(c:c eq 'Sales')",
        msg,
      ),
    ).toBe(false);
  });

  it('returns false on unsupported clauses (conservative reject) when filter-evaluable fields ARE present', () => {
    // `categories: []` is enough to put us out of the Composio-minimal branch,
    // so the predicate evaluates normally and rejects the unsupported token.
    expect(outlookEventMatches('isRead eq false', { categories: [] })).toBe(false);
  });

  // ── Composio webhook minimal shape — fail-open with warning ────────────────
  //
  // Composio's OUTLOOK_MESSAGE_TRIGGER ships only { id, event_type }
  // (authoritative schema fetched live from
  //  GET /api/v3/triggers_types/OUTLOOK_MESSAGE_TRIGGER). The previous
  // version of outlookEventMatches walked every clause and returned false
  // on the first one because every field (from, toRecipients, categories)
  // was undefined — so every Composio Outlook event was silently dropped
  // for any agent with a non-empty outlookFilter. We can't evaluate the
  // predicate client-side from this shape, so we fail-open with a log and
  // let the agent self-filter via its read-message tools.

  it('Composio shape: bypasses the predicate when no filter-evaluable fields are present', () => {
    const composioPayload = { id: 'AAMkAG-real-id', event_type: 'message.created' };
    expect(
      outlookEventMatches("toRecipients/any(t:t/emailAddress/address eq 'support@example.com')", composioPayload),
    ).toBe(true);
    expect(
      outlookEventMatches("from/emailAddress/address eq 'anyone@example.com'", composioPayload),
    ).toBe(true);
  });

  it('Composio shape: bypass holds even when the binding has multiple clauses', () => {
    const composioPayload = { id: 'AAMkAG-real-id', event_type: 'message.created' };
    expect(
      outlookEventMatches(
        "from/emailAddress/address eq 'a@b.com' and categories/any(c:c eq 'Support')",
        composioPayload,
      ),
    ).toBe(true);
  });

  it('Composio shape: still returns true when filter is empty (no agent-side filter, no fields)', () => {
    expect(outlookEventMatches(undefined, { id: 'x', event_type: 'message.created' })).toBe(true);
  });

  it('Direct Graph shape with empty fields still applies the predicate (NOT confused with Composio shape)', () => {
    // Even one field present (toRecipients: []) takes us out of the
    // Composio-minimal branch and the predicate evaluates normally.
    expect(
      outlookEventMatches(
        "toRecipients/any(t:t/emailAddress/address eq 'support@example.com')",
        { toRecipients: [] },
      ),
    ).toBe(false);
  });
});

// ── 4. getAgentConnectorBindingConfig — connector binding lookup ──────────────
//
// Regression test for the production bug where the query targeted PB's
// `internal_agents` table (which does not exist in the tenant runtime DB),
// failing with `relation "internal_agents" does not exist` and silently
// falling back to no-filter behavior. The fix queries
// `cached_internal_agents` JOIN `internal_agent_runtime_mapping` so the
// agent's bindings are actually consulted before dispatch.

describe('getAgentConnectorBindingConfig', () => {
  it('queries cached_internal_agents joined to runtime mapping (NOT internal_agents)', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ integrations: [{ type: 'google_mail', config: { gmailQuery: 'to:support@x' } }] }],
        rowCount: 1,
      }),
    };
    mockGetPool.mockReturnValue(mockPool);

    const result = await getAgentConnectorBindingConfig<{ gmailQuery?: string }>(
      'tenant-1',
      'runtime-agent-1',
      'google_mail',
    );

    expect(result).toEqual({ gmailQuery: 'to:support@x' });

    const [sql, params] = mockPool.query.mock.calls[0] as [string, string[]];
    // Pin the schema choice: the query MUST hit the local cache table joined to
    // the mapping, not the PB-side internal_agents (which doesn't exist here).
    expect(sql).toContain('FROM cached_internal_agents');
    expect(sql).toContain('JOIN internal_agent_runtime_mapping');
    expect(sql).toMatch(/m\.agent_id\s*=\s*\$1/);
    expect(sql).toMatch(/m\.tenant_id\s*=\s*\$2/);
    expect(sql).not.toMatch(/FROM\s+internal_agents\b/);
    expect(params).toEqual(['runtime-agent-1', 'tenant-1']);
  });

  it('returns undefined when the agent has no row in the mapping', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    mockGetPool.mockReturnValue(mockPool);
    const result = await getAgentConnectorBindingConfig('tenant-1', 'unknown-agent', 'google_mail');
    expect(result).toBeUndefined();
  });

  it('returns undefined when the agent has integrations but not the requested connector type', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ integrations: [{ type: 'slack', config: { workspaceId: 'T123' } }] }],
        rowCount: 1,
      }),
    };
    mockGetPool.mockReturnValue(mockPool);
    const result = await getAgentConnectorBindingConfig('tenant-1', 'agent-1', 'google_mail');
    expect(result).toBeUndefined();
  });

  it('returns undefined when integrations column is null (defensive)', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({ rows: [{ integrations: null }], rowCount: 1 }),
    };
    mockGetPool.mockReturnValue(mockPool);
    const result = await getAgentConnectorBindingConfig('tenant-1', 'agent-1', 'google_mail');
    expect(result).toBeUndefined();
  });

  it('swallows DB errors and returns undefined (fail-open by design — event still dispatches)', async () => {
    const mockPool = { query: jest.fn().mockRejectedValue(new Error('connection lost')) };
    mockGetPool.mockReturnValue(mockPool);
    const result = await getAgentConnectorBindingConfig('tenant-1', 'agent-1', 'google_mail');
    expect(result).toBeUndefined();
  });
});


// ── 6. dispatchConnectorEventDirect — defer on per-agent lock contention ──────
//
// The fix's fan-out path (Change 5). resolveEventTopics always includes the
// `${source}.${entityType}` topic, so a registered agent matches without loading
// the connector catalog. A neutral source (not gmail/outlook/github) skips the
// per-binding filters. We assert each fan-out run carries a per-(agent,event)
// triggerKey + onConflict:'defer', and that a deferred run leaves its thread open
// (no status update) while a run that completes marks its thread 'completed'.

describe('dispatchConnectorEventDirect — defer on lock contention', () => {
  const tenantId = 'tenant-def';
  const agentId = 'agent-def-1';
  const TOPIC = 'salesforce.lead';

  beforeEach(() => {
    mockExecuteTask.mockReset();
    mockCreateThread.mockReset().mockResolvedValue({ id: 'thread-x' });
    mockUpdateThreadStatus.mockReset().mockResolvedValue(undefined);
    // markEventSeen INSERT → new (rowCount 1); lifecycle SELECT → ACTIVE.
    mockGetPool.mockReturnValue({
      query: jest.fn(async (sql: string) => {
        if (sql.includes('connector_event_seen')) return { rows: [], rowCount: 1 };
        if (sql.includes('lifecycle')) return { rows: [{ lifecycle: 'ACTIVE' }] };
        return { rows: [] };
      }),
    });
    registerEventAgent(agentId, tenantId, TOPIC);
  });

  afterEach(() => {
    deregisterEventAgent(agentId, tenantId, TOPIC);
  });

  it('two events for the same agent: one runs (thread completed), one is deferred (thread left open)', async () => {
    mockExecuteTask
      .mockResolvedValueOnce({ success: true, toolCallsExecuted: 1, reasoningSteps: 1 })
      .mockResolvedValueOnce({ success: false, deferred: true, toolCallsExecuted: 0, reasoningSteps: 0 });

    await dispatchConnectorEventDirect({ source: 'salesforce', entityType: 'lead', tenantId, eventId: 'evt-A', data: { payload: { data: {} } } });
    await dispatchConnectorEventDirect({ source: 'salesforce', entityType: 'lead', tenantId, eventId: 'evt-B', data: { payload: { data: {} } } });

    // Each fan-out run gets its own per-(agent,event) ledger key + defer policy.
    expect(mockExecuteTask).toHaveBeenCalledTimes(2);
    expect(mockExecuteTask.mock.calls[0][0]).toMatchObject({ triggerKey: `evt:evt-A:${agentId}`, onConflict: 'defer' });
    expect(mockExecuteTask.mock.calls[1][0]).toMatchObject({ triggerKey: `evt:evt-B:${agentId}`, onConflict: 'defer' });

    // The run that completed marks the thread; the deferred run leaves it open.
    expect(mockUpdateThreadStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateThreadStatus).toHaveBeenCalledWith('thread-x', tenantId, 'completed');
  });

  it('a deferred run is NOT reported as a failed thread', async () => {
    mockExecuteTask.mockResolvedValue({ success: false, deferred: true, toolCallsExecuted: 0, reasoningSteps: 0 });

    await dispatchConnectorEventDirect({ source: 'salesforce', entityType: 'lead', tenantId, eventId: 'evt-C', data: { payload: { data: {} } } });

    expect(mockExecuteTask).toHaveBeenCalledTimes(1);
    expect(mockUpdateThreadStatus).not.toHaveBeenCalled();
  });
});
