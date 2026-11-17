// The review queue has one definition of "actionable", and these tests hold it
// to that. Before ACTIONABLE_QUEUE_PREDICATES existed, five places re-derived
// the rule and disagreed: a tenant with 141 pending escalations and no
// approvals read "0 items awaiting decision" beside a full queue.
//
// The SQL itself is exercised against a real database in
// review-queue-predicate.integration.test.ts. What is pinned here is what a
// mocked pool can honestly pin: that both statements embed the same predicate
// text, that the counts map into an exhaustive partition, and that the keyset
// cursor is carried and consumed correctly.

jest.mock('../../infrastructure/database', () => {
  const sharedQuery = jest.fn().mockResolvedValue({ rows: [] });
  return {
    pool: { query: sharedQuery },
    withTenantScope: jest.fn(async (_tenantId: string, fn: (c: unknown) => unknown) =>
      fn({ query: sharedQuery })),
  };
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { pool } from '../../infrastructure/database';
import {
  hitlEnforcementService,
  encodeQueueCursor,
  decodeQueueCursor,
  PASSED_WINDOW_LOOKBACK,
} from '../service';

const mockPool = pool as unknown as { query: jest.Mock };

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';

/** The SQL text of the nth pool.query call. */
const sqlOf = (call: number): string => mockPool.query.mock.calls[call][0] as string;
/** The bound parameters of the nth pool.query call. */
const paramsOf = (call: number): unknown[] => mockPool.query.mock.calls[call][1] as unknown[];

function approvalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'approval',
    sort_cursor: '2026-08-06 23:01:24.596146+00',
    id: '33333333-3333-3333-3333-333333333333',
    tenant_id: TENANT,
    agent_id: AGENT,
    workflow_id: '44444444-4444-4444-4444-444444444444',
    task_id: '55555555-5555-5555-5555-555555555555',
    hitl_level: 2,
    reason: 'super_destructive_gate',
    pending_tool_calls: [],
    tool_calls_hash: 'hash-1',
    status: 'pending',
    decided_by: null,
    decided_by_role: null,
    decision: null,
    rejection_reason: null,
    decided_at: null,
    idempotency_key: null,
    injected_skill_ids: [],
    source: 'agent',
    context: null,
    action_summary: null,
    why_summary: null,
    detail: null,
    thread_id: null,
    created_at: '2026-08-06T23:01:24.596Z',
    updated_at: '2026-08-06T23:01:24.596Z',
    expires_at: '2026-08-07T23:01:24.596Z',
    ...overrides,
  };
}

function clarificationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'clarification',
    sort_cursor: '2026-08-06 23:01:24.596146+00',
    id: '66666666-6666-6666-6666-666666666666',
    tenant_id: TENANT,
    agent_id: AGENT,
    thread_id: '77777777-7777-7777-7777-777777777777',
    question: 'Which repository should I open the pull request against?',
    clarification_source: 'recovery_llm',
    vendor_request_id: null,
    created_at: '2026-08-06T23:01:24.596Z',
    expires_at: '2026-08-13T23:01:24.596Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
});

describe('one definition of actionable', () => {
  it('embeds the same predicate text in the listing and the count', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT);
    await hitlEnforcementService.getPendingItemsCount(TENANT);

    const listSql = sqlOf(0);
    const countSql = sqlOf(1);

    // Approvals: pending, and a null expiry is a gate with no deadline, which
    // stays live. The write path agrees, so the read must not hide it.
    for (const fragment of [
      "status = 'pending'",
      '(expires_at IS NULL OR expires_at > NOW())',
      "objective = 'clarification-expiry'",
      'AND review_listed',
      '($2::uuid IS NULL OR agent_id = $2::uuid)',
    ]) {
      expect(listSql).toContain(fragment);
      expect(countSql).toContain(fragment);
    }
  });

  it('keeps a question parked under "Only exceptions" off the page, in the listing and the count alike', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT);
    await hitlEnforcementService.getPendingItemsCount(TENANT);

    // The write path files such a question under the run's paused state
    // (review_listed = false, migration 430): the question waits in its chat
    // thread and nobody is notified. The page's count follows the listing, so
    // "1 item awaiting decision" can never point at an item the list hides.
    for (const sql of [sqlOf(0), sqlOf(1)]) {
      const clarificationClause = sql.slice(sql.indexOf("objective = 'clarification-expiry'"));
      expect(clarificationClause).toContain('AND review_listed');
    }
  });

  it('scopes both statements to the same tenant and agent parameters', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT, { agentId: AGENT });
    await hitlEnforcementService.getPendingItemsCount(TENANT, { agentId: AGENT });

    expect(paramsOf(0).slice(0, 2)).toEqual([TENANT, AGENT]);
    expect(paramsOf(1)).toEqual([TENANT, AGENT]);
  });

  it('passes a null agent filter when no agent was asked for', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT);
    await hitlEnforcementService.getPendingItemsCount(TENANT);

    expect(paramsOf(0)[1]).toBeNull();
    expect(paramsOf(1)[1]).toBeNull();
  });

  it('does not filter clarifications by expiry, because the write path does not', async () => {
    await hitlEnforcementService.getPendingItemsCount(TENANT);

    // fires_at is the clarification's deadline column. Guarding on it here
    // would hide a question that respondToClarification still accepts.
    expect(sqlOf(0)).not.toContain('fires_at >');
  });
});

describe('getPendingItemsCount', () => {
  it('returns a breakdown whose buckets partition the total', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{
        total: '7',
        approvals_standard: '2',
        approvals_critical: '1',
        approvals_other: '3',
        clarifications: '1',
      }],
    });

    const counts = await hitlEnforcementService.getPendingItemsCount(TENANT);

    expect(counts).toEqual({
      total: 7,
      approvalsStandard: 2,
      approvalsCritical: 1,
      approvalsOther: 3,
      clarifications: 1,
    });
    expect(
      counts.approvalsStandard + counts.approvalsCritical + counts.approvalsOther +
      counts.clarifications,
    ).toBe(counts.total);
  });

  it('buckets approvals outside levels 1 and 2 rather than dropping them', async () => {
    await hitlEnforcementService.getPendingItemsCount(TENANT);

    // hitl_level is the tenant's autonomy level, 1 to 5, default 3. A two-way
    // split leaves level 3 in neither bucket, which is how the queue's "All"
    // label came to undercount.
    expect(sqlOf(0)).toContain('hitl_level NOT IN (1, 2)');
  });

  it('reads zero from an empty database rather than NaN', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    expect(await hitlEnforcementService.getPendingItemsCount(TENANT)).toEqual({
      total: 0,
      approvalsStandard: 0,
      approvalsCritical: 0,
      approvalsOther: 0,
      clarifications: 0,
    });
  });
});

describe('keyset pagination', () => {
  it('round-trips a cursor without losing the timestamp precision', () => {
    const sortAt = '2026-08-06 23:01:24.596146+00';
    const encoded = encodeQueueCursor(sortAt, 'approval', 'abc-123');

    expect(encoded).not.toContain('|');
    expect(decodeQueueCursor(encoded)).toEqual({
      sortAt,
      kind: 'approval',
      id: 'abc-123',
    });
  });

  it('reads a malformed cursor as no cursor, so the caller gets page one', () => {
    expect(decodeQueueCursor('not-base64-at-all!!')).toBeNull();
    expect(decodeQueueCursor('')).toBeNull();
    expect(decodeQueueCursor(undefined)).toBeNull();
    expect(decodeQueueCursor(Buffer.from('no-separators').toString('base64'))).toBeNull();
  });

  it('asks for one row beyond the limit so hasMore needs no second query', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 20 });

    expect(paramsOf(0)[5]).toBe(21);
  });

  it('caps the limit at 100', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 5000 });

    expect(paramsOf(0)[5]).toBe(101);
  });

  it('binds the cursor row-wise so page two resumes where page one stopped', async () => {
    const cursor = encodeQueueCursor('2026-08-06 23:01:24.596146+00', 'approval', 'row-1');

    await hitlEnforcementService.listPendingItemsForTenant(TENANT, { cursor });

    expect(sqlOf(0)).toContain('(sort_at, kind, id) < ($3::timestamptz, $4::text, $5::text)');
    expect(paramsOf(0).slice(2, 5)).toEqual([
      '2026-08-06 23:01:24.596146+00',
      'approval',
      'row-1',
    ]);
  });

  it('orders by the full keyset, newest first', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT);

    expect(sqlOf(0)).toContain('ORDER BY sort_at DESC, kind DESC, id DESC');
  });

  it('sorts a null created_at last instead of stranding it on page one', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT);

    // workflow_escalations.created_at is nullable. Coalescing to epoch gives
    // those rows the NULLS LAST position they deserve and keeps the row-wise
    // comparison total, since a NULL inside it would yield NULL and exclude
    // the row from every later page.
    expect(sqlOf(0)).toContain("COALESCE(created_at, 'epoch'::timestamptz) AS sort_at");
  });

  it('builds nextCursor from the last row on a full page', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => approvalRow({
      id: `row-${i}`,
      sort_cursor: `2026-08-0${i + 1} 10:00:00.000123+00`,
    }));
    mockPool.query.mockResolvedValue({ rows });

    const result = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(decodeQueueCursor(result.nextCursor)).toEqual({
      sortAt: '2026-08-02 10:00:00.000123+00',
      kind: 'approval',
      id: 'row-1',
    });
  });

  it('returns no cursor on the last page', async () => {
    mockPool.query.mockResolvedValue({ rows: [approvalRow()] });

    const result = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 20 });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});

describe('the passed window', () => {
  it('selects lapsed approvals instead of actionable ones', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT, { window: 'passed' });
    const sql = sqlOf(0);

    // Both sides of the sweeper: a lapsed approval reads 'pending' until the
    // runtime flips it, which can take ~30 minutes.
    expect(sql).toContain("status IN ('pending', 'expired')");
    expect(sql).toContain('expires_at <= NOW()');
    expect(sql).not.toContain('(expires_at IS NULL OR expires_at > NOW())');
  });

  it('bounds the view to a lookback rather than growing without limit', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT, { window: 'passed' });

    expect(sqlOf(0)).toContain(`NOW() - INTERVAL '${PASSED_WINDOW_LOOKBACK}'`);
  });

  it('is approvals only, since nothing else has a decision window', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT, { window: 'passed' });
    const sql = sqlOf(0);

    expect(sql).not.toContain('agent_scheduled_invocations');
    expect(sql).not.toContain('workflow_escalations');
  });

  it('leaves the actionable view carrying the two kinds that park a run', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT);
    const sql = sqlOf(0);

    expect(sql).toContain('hitl_approval_requests');
    expect(sql).toContain('agent_scheduled_invocations');
    // Escalations are gone from the queue entirely: an escalated run has
    // already ended, so nothing an answer could restart was ever in here.
    expect(sql).not.toContain('workflow_escalations');
  });

  it('keeps the keyset and the agent scope in the passed view', async () => {
    const cursor = encodeQueueCursor('2026-08-06 23:01:24.596146+00', 'approval', 'row-1');

    await hitlEnforcementService.listPendingItemsForTenant(TENANT, {
      window: 'passed', cursor, agentId: AGENT,
    });

    expect(sqlOf(0)).toContain('(sort_at, kind, id) < ($3::timestamptz, $4::text, $5::text)');
    expect(paramsOf(0)[1]).toBe(AGENT);
  });
})

// Every queue item names the agent it belongs to, and the listing is the only
// place that name can come from: the id on the row is a RUNTIME agents.id
// (INV-TR-010) and every consumer knows teams by their control-plane
// internal_agents.id, so nothing downstream can turn one into the other.
describe('the agent name on a queue item', () => {
  it('resolves the name in the listing, because no consumer can resolve it later', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT);

    expect(sqlOf(0)).toContain('SELECT a.name FROM agents a WHERE a.id = base.agent_id::uuid');
    expect(sqlOf(0)).toContain('AS agent_name');
  });

  it('resolves it for a lapsed approval too, since the passed view renders the same card', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT, { window: 'passed' });

    expect(sqlOf(0)).toContain('SELECT a.name FROM agents a WHERE a.id = base.agent_id::uuid');
  });

  it('carries the name onto an approval', async () => {
    mockPool.query.mockResolvedValue({ rows: [approvalRow({ agent_name: 'Code Reviewer' })] });

    const { items } = await hitlEnforcementService.listPendingItemsForTenant(TENANT);

    expect(items[0].agentName).toBe('Code Reviewer');
  });

  it('carries the name onto a clarification', async () => {
    mockPool.query.mockResolvedValue({ rows: [clarificationRow({ agent_name: 'Code Reviewer' })] });

    const { items } = await hitlEnforcementService.listPendingItemsForTenant(TENANT);

    expect(items[0].kind).toBe('clarification');
    expect(items[0].agentName).toBe('Code Reviewer');
  });

  // A clarification carries no FK to agents, so it can outlive its team. Null
  // says exactly that, and leaves the surface to word it.
  it('reports a vanished team as null rather than inventing a label from the id', async () => {
    mockPool.query.mockResolvedValue({ rows: [clarificationRow({ agent_name: null })] });

    const { items } = await hitlEnforcementService.listPendingItemsForTenant(TENANT);

    expect(items[0].agentName).toBeNull();
  });
});

describe('the approval blocking a thread', () => {
  it('is an indexed lookup on the thread, not a scan of the queue', async () => {
    mockPool.query.mockResolvedValue({ rows: [approvalRow()] });

    await hitlEnforcementService.findActionableApprovalForThread(TENANT, 'thread-1');

    const sql = sqlOf(0)
    expect(sql).toContain('thread_id = $3::uuid')
    expect(sql).toContain('LIMIT 1')
    expect(paramsOf(0)).toEqual([TENANT, null, 'thread-1'])
  });

  it('holds the banner to the same actionability rule as the queue', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await hitlEnforcementService.findActionableApprovalForThread(TENANT, 'thread-1');

    const sql = sqlOf(0);
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('(expires_at IS NULL OR expires_at > NOW())');
  });

  it('returns null when the thread has nothing waiting', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    expect(
      await hitlEnforcementService.findActionableApprovalForThread(TENANT, 'thread-1'),
    ).toBeNull();
  });

  it('scopes to the agent when one is given', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await hitlEnforcementService.findActionableApprovalForThread(TENANT, 'thread-1', AGENT);

    expect(paramsOf(0)[1]).toBe(AGENT);
  });
})

describe('listed approvals carry their full row', () => {
  it('maps the columns the listing now projects', async () => {
    mockPool.query.mockResolvedValue({ rows: [approvalRow()] });

    const result = await hitlEnforcementService.listPendingItemsForTenant(TENANT);
    const item = result.items[0];

    expect(item.kind).toBe('approval');
    if (item.kind !== 'approval') throw new Error('expected an approval');

    // These four used to be absent from the projection, so every listed
    // approval shipped status: undefined and an Invalid Date updatedAt.
    expect(item.status).toBe('pending');
    expect(item.toolCallsHash).toBe('hash-1');
    expect(item.source).toBe('agent');
    expect(item.updatedAt.getTime()).not.toBeNaN();
  });

  it('projects every column mapApprovalRequest reads', async () => {
    await hitlEnforcementService.listPendingItemsForTenant(TENANT);
    const listSql = sqlOf(0);

    for (const column of [
      'tool_calls_hash', 'status', 'decided_by', 'decided_by_role', 'decision',
      'rejection_reason', 'decided_at', 'idempotency_key', 'injected_skill_ids',
      'source', 'context', 'updated_at',
    ]) {
      expect(listSql).toContain(column);
    }
  });
});
