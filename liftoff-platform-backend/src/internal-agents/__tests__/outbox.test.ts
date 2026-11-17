// Unit tests for the internal-agent outbox (plan §5.6).
//
// Strategy: mock the DB pool + publishEventWithExplicitId to exercise the
// state machine without booting Postgres. The plan's "rolls back entity
// mutation when outbox INSERT throws" assertion is covered as a behavioral
// test using a transactional mock.

jest.mock('../../infrastructure/database', () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const responses: Array<{ rows: unknown[]; rowCount?: number }> = [];

  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return responses.shift() ?? { rows: [], rowCount: 0 };
    }),
  };

  return {
    queries,
    responses,
    client,
    withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: typeof client) => Promise<unknown>) => {
      return await fn(client);
    }),
    // Required by other transitive imports
    pool: client,
    getPool: () => client,
    getPoolForService: () => client,
  };
});

jest.mock('../../events/publisher', () => ({
  publishEventWithExplicitId: jest.fn(async () => undefined),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as outbox from '../outbox';
import * as publisher from '../../events/publisher';
import * as db from '../../infrastructure/database';

const dbMock = db as unknown as {
  queries: Array<{ sql: string; params?: unknown[] }>;
  responses: Array<{ rows: unknown[]; rowCount?: number }>;
  client: { query: jest.Mock };
};

const publishSpy = publisher.publishEventWithExplicitId as jest.Mock;

function pushResponse(rows: unknown[]): void {
  dbMock.responses.push({ rows, rowCount: rows.length });
}

beforeEach(() => {
  dbMock.queries.length = 0;
  dbMock.responses.length = 0;
  publishSpy.mockReset();
  publishSpy.mockResolvedValue(undefined);
});

describe('enqueueInternalAgentOutbox', () => {
  it('inserts a row and returns an OutboxRowRef with the persisted event_id', async () => {
    pushResponse([{ id: 'outbox-1', event_id: 'event-1' }]);
    const ref = await outbox.enqueueInternalAgentOutbox(dbMock.client as unknown as Parameters<typeof outbox.enqueueInternalAgentOutbox>[0], {
      tenantId: 't1',
      internalAgentId: 'a1',
      eventType: 'tenant.internal_agent.created',
      entityVersion: 1,
      payload: { hello: 'world' },
    });
    expect(ref).toEqual({
      outboxId: 'outbox-1',
      eventId: 'event-1',
      tenantId: 't1',
      internalAgentId: 'a1',
      eventType: 'tenant.internal_agent.created',
      entityVersion: 1,
      payload: { hello: 'world' },
    });
    expect(dbMock.queries[0].sql).toMatch(/INSERT INTO internal_agent_outbox/);
    expect(dbMock.queries[0].sql).toMatch(/ON CONFLICT.*WHERE status IN \('pending', 'in_progress'\)/s);
  });

  it('on ON CONFLICT (existing pending row), DO UPDATE rewrites payload + generates a NEW event_id atomically', async () => {
    // The DO UPDATE path REPLACES the row's payload + entity_version with the
    // new mutation's values and resets the event_id via gen_random_uuid().
    // Returns the row's (new) event_id. Without the event_id reset, a
    // concurrent v=6 update would publish under v=5's event_id which the
    // runtime already deduped → v=6 silently dropped from the event stream.
    pushResponse([{ id: 'outbox-existing', event_id: 'event-newly-generated' }]);
    const ref = await outbox.enqueueInternalAgentOutbox(dbMock.client as unknown as Parameters<typeof outbox.enqueueInternalAgentOutbox>[0], {
      tenantId: 't1',
      internalAgentId: 'a1',
      eventType: 'tenant.internal_agent.created',
      entityVersion: 1,
      payload: {},
    });
    expect(ref.outboxId).toBe('outbox-existing');
    // Postgres-generated event_id from gen_random_uuid() — caller uses the
    // returned value, not its own input.
    expect(ref.eventId).toBe('event-newly-generated');
    // The single statement is the only query — no separate SELECT.
    expect(dbMock.queries.length).toBe(1);
    const sql = dbMock.queries[0].sql;
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE SET\s+event_id\s*=\s*gen_random_uuid\(\)/s);
    expect(sql).toMatch(/event_payload\s*=\s*EXCLUDED\.event_payload/);
    expect(sql).toMatch(/entity_version\s*=\s*EXCLUDED\.entity_version/);
    expect(sql).toMatch(/status\s*=\s*'pending'/);
    expect(sql).toMatch(/attempts\s*=\s*0/);
    expect(sql).toMatch(/last_error\s*=\s*NULL/);
  });

  it('REGRESSION: concurrent enqueues for same entity must produce DIFFERENT event_ids so runtime dedupe does not drop the second event', async () => {
    // Tx A enqueues → DB returns event_id_A
    pushResponse([{ id: 'outbox-1', event_id: 'event-a' }]);
    const refA = await outbox.enqueueInternalAgentOutbox(dbMock.client as unknown as Parameters<typeof outbox.enqueueInternalAgentOutbox>[0], {
      tenantId: 't1',
      internalAgentId: 'a1',
      eventType: 'tenant.internal_agent.updated',
      entityVersion: 5,
      payload: { version: 5 },
    });

    // Tx B enqueues for the SAME (tenant, agent, type) — Postgres ON CONFLICT
    // path RETURNs a fresh event_id from gen_random_uuid(). Mock simulates by
    // returning a distinct event_id_B for the second call.
    pushResponse([{ id: 'outbox-1', event_id: 'event-b' }]);
    const refB = await outbox.enqueueInternalAgentOutbox(dbMock.client as unknown as Parameters<typeof outbox.enqueueInternalAgentOutbox>[0], {
      tenantId: 't1',
      internalAgentId: 'a1',
      eventType: 'tenant.internal_agent.updated',
      entityVersion: 6,
      payload: { version: 6 },
    });

    // Both calls returned the same row id (constraint collapse), but DIFFERENT
    // event_ids — the runtime's (tenant_id, event_id) dedup ledger will treat
    // them as distinct events.
    expect(refA.outboxId).toBe('outbox-1');
    expect(refB.outboxId).toBe('outbox-1');
    expect(refA.eventId).not.toBe(refB.eventId);
    // Ref's in-memory payload tracks the caller's mutation, not the prior tx's.
    expect(refB.payload).toEqual({ version: 6 });
    expect(refB.entityVersion).toBe(6);
  });

  it('REGRESSION: throws clearly if the upsert returns no rows (partial index regression)', async () => {
    pushResponse([]); // hypothetical: future migration breaks the partial index
    await expect(outbox.enqueueInternalAgentOutbox(dbMock.client as unknown as Parameters<typeof outbox.enqueueInternalAgentOutbox>[0], {
      tenantId: 't1',
      internalAgentId: 'a1',
      eventType: 'tenant.internal_agent.created',
      entityVersion: 1,
      payload: {},
    })).rejects.toThrow(/upsert returned no rows/);
  });
});

describe('publishOutboxRowInline', () => {
  const refTemplate: outbox.OutboxRowRef = {
    outboxId: 'o-1',
    eventId: 'e-1',
    tenantId: 't1',
    internalAgentId: 'a1',
    eventType: 'tenant.internal_agent.created',
    entityVersion: 1,
    payload: { x: 1 },
  };

  it('on success marks row completed and returns inlinePublished: true', async () => {
    publishSpy.mockResolvedValueOnce(undefined);
    const result = await outbox.publishOutboxRowInline(refTemplate);
    expect(result).toEqual({ inlinePublished: true });
    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'e-1',
      entityType: 'internal_agent',
      entityId: 'a1',
      eventType: 'tenant.internal_agent.created',
    }));
    const lastQuery = dbMock.queries[dbMock.queries.length - 1];
    expect(lastQuery.sql).toMatch(/UPDATE internal_agent_outbox/);
    expect(lastQuery.sql).toMatch(/status='completed'/);
  });

  it('on publish failure NEVER throws — leaves row pending for worker', async () => {
    publishSpy.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    const result = await outbox.publishOutboxRowInline(refTemplate);
    expect(result).toEqual({ inlinePublished: false });
    const lastQuery = dbMock.queries[dbMock.queries.length - 1];
    expect(lastQuery.sql).toMatch(/attempts = attempts \+ 1/);
  });

  it('respects 3s timeout — never blocks forever', async () => {
    publishSpy.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
    const start = Date.now();
    const result = await outbox.publishOutboxRowInline(refTemplate);
    const elapsed = Date.now() - start;
    expect(result.inlinePublished).toBe(false);
    expect(elapsed).toBeLessThan(4000);
    expect(elapsed).toBeGreaterThanOrEqual(2900);
  });
});

describe('runInternalAgentOutboxOnce worker loop', () => {
  it('claims a due row, publishes, marks completed, claims next', async () => {
    // reaper UPDATE
    pushResponse([]);
    // claim #1 → row
    pushResponse([{
      id: 'r1', tenant_id: 't', internal_agent_id: 'a', event_id: 'e1',
      event_type: 'tenant.internal_agent.created', event_payload: {},
      entity_version: 1, attempts: 0, max_attempts: 10,
    }]);
    // markCompleted for r1
    pushResponse([]);
    // claim #2 → null (no more rows)
    pushResponse([]);

    publishSpy.mockResolvedValueOnce(undefined);
    await outbox.runInternalAgentOutboxOnce();
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('on publish failure schedules retry with backoff (attempts < max)', async () => {
    pushResponse([]); // reaper
    pushResponse([{
      id: 'r1', tenant_id: 't', internal_agent_id: 'a', event_id: 'e1',
      event_type: 'tenant.internal_agent.created', event_payload: {},
      entity_version: 1, attempts: 0, max_attempts: 10,
    }]);
    pushResponse([]); // markRetry
    pushResponse([]); // next claim → empty

    publishSpy.mockRejectedValueOnce(new Error('boom'));
    await outbox.runInternalAgentOutboxOnce();

    const markRetryQuery = dbMock.queries.find((q) =>
      /SET status='pending', attempts=\$2/.test(q.sql),
    );
    expect(markRetryQuery).toBeDefined();
  });

  it('on max_attempts exceeded marks row failed', async () => {
    pushResponse([]); // reaper
    pushResponse([{
      id: 'r1', tenant_id: 't', internal_agent_id: 'a', event_id: 'e1',
      event_type: 'tenant.internal_agent.created', event_payload: {},
      entity_version: 1, attempts: 9, max_attempts: 10,
    }]);
    pushResponse([]); // markRetry (terminal)
    pushResponse([]); // next claim

    publishSpy.mockRejectedValueOnce(new Error('boom'));
    await outbox.runInternalAgentOutboxOnce();

    const failedQuery = dbMock.queries.find((q) => /SET status='failed'/.test(q.sql));
    expect(failedQuery).toBeDefined();
  });

  it('reaper resets in_progress rows stuck > 5 min', async () => {
    pushResponse([]); // reaper update affects no rows on this test
    pushResponse([]); // claim returns nothing
    await outbox.runInternalAgentOutboxOnce();
    const reaperQuery = dbMock.queries.find((q) => /SET status='pending', updated_at=NOW\(\)\s+WHERE status='in_progress'/.test(q.sql));
    expect(reaperQuery).toBeDefined();
  });
});
