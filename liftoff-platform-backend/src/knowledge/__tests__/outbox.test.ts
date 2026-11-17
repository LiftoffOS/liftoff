// Unit tests for the knowledge outbox (plan §9). Mirror of
// internal-agents/__tests__/outbox.test.ts.

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

describe('enqueueKnowledgeOutbox', () => {
  it('inserts a row and returns an OutboxRowRef with the persisted event_id', async () => {
    pushResponse([{ id: 'outbox-1', event_id: 'event-1' }]);
    const ref = await outbox.enqueueKnowledgeOutbox(
      dbMock.client as unknown as Parameters<typeof outbox.enqueueKnowledgeOutbox>[0],
      {
        tenantId: 't1',
        itemId: 'i1',
        eventType: 'knowledge.items.created',
        entityVersion: null,
        payload: { tenantId: 't1', itemId: 'i1' },
      },
    );
    expect(ref).toEqual({
      outboxId: 'outbox-1',
      eventId: 'event-1',
      tenantId: 't1',
      itemId: 'i1',
      eventType: 'knowledge.items.created',
      entityVersion: null,
      payload: { tenantId: 't1', itemId: 'i1' },
    });
    expect(dbMock.queries[0].sql).toMatch(/INSERT INTO knowledge_outbox/);
    expect(dbMock.queries[0].sql).toMatch(/ON CONFLICT.*WHERE status IN \('pending', 'in_progress'\)/s);
  });

  it('on ON CONFLICT DO UPDATE rewrites payload and resets event_id (idempotent enqueue)', async () => {
    pushResponse([{ id: 'outbox-existing', event_id: 'event-newly-generated' }]);
    const ref = await outbox.enqueueKnowledgeOutbox(
      dbMock.client as unknown as Parameters<typeof outbox.enqueueKnowledgeOutbox>[0],
      {
        tenantId: 't1',
        itemId: 'i1',
        eventType: 'knowledge.items.created',
        entityVersion: null,
        payload: { tenantId: 't1', itemId: 'i1' },
      },
    );
    expect(ref.outboxId).toBe('outbox-existing');
    expect(ref.eventId).toBe('event-newly-generated');
    expect(dbMock.queries.length).toBe(1);
    const sql = dbMock.queries[0].sql;
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE SET\s+event_id\s*=\s*gen_random_uuid\(\)/s);
    expect(sql).toMatch(/event_payload\s*=\s*EXCLUDED\.event_payload/);
    expect(sql).toMatch(/status\s*=\s*'pending'/);
    expect(sql).toMatch(/attempts\s*=\s*0/);
    expect(sql).toMatch(/last_error\s*=\s*NULL/);
  });

  it('throws clearly if the upsert returns no rows (partial index regression)', async () => {
    pushResponse([]);
    await expect(outbox.enqueueKnowledgeOutbox(
      dbMock.client as unknown as Parameters<typeof outbox.enqueueKnowledgeOutbox>[0],
      {
        tenantId: 't1',
        itemId: 'i1',
        eventType: 'knowledge.items.created',
        entityVersion: null,
        payload: {},
      },
    )).rejects.toThrow(/upsert returned no rows/);
  });
});

describe('publishOutboxRowInline', () => {
  const refTemplate: outbox.OutboxRowRef = {
    outboxId: 'o-1',
    eventId: 'e-1',
    tenantId: 't1',
    itemId: 'i1',
    eventType: 'knowledge.items.created',
    entityVersion: null,
    payload: { x: 1 },
  };

  it('on success marks row completed and returns inlinePublished: true', async () => {
    publishSpy.mockResolvedValueOnce(undefined);
    const result = await outbox.publishOutboxRowInline(refTemplate);
    expect(result).toEqual({ inlinePublished: true });
    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'e-1',
      entityType: 'knowledge_item',
      entityId: 'i1',
      eventType: 'knowledge.items.created',
    }));
    const lastQuery = dbMock.queries[dbMock.queries.length - 1];
    expect(lastQuery.sql).toMatch(/UPDATE knowledge_outbox/);
    expect(lastQuery.sql).toMatch(/status='completed'/);
  });

  it('on publish failure NEVER throws — leaves row pending for worker', async () => {
    publishSpy.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    const result = await outbox.publishOutboxRowInline(refTemplate);
    expect(result).toEqual({ inlinePublished: false });
    const lastQuery = dbMock.queries[dbMock.queries.length - 1];
    expect(lastQuery.sql).toMatch(/attempts = attempts \+ 1/);
  });
});

describe('runKnowledgeOutboxOnce worker loop', () => {
  it('claims a due row, publishes, marks completed, claims next', async () => {
    pushResponse([]); // reaper UPDATE
    pushResponse([{
      id: 'r1', tenant_id: 't', item_id: 'i', event_id: 'e1',
      event_type: 'knowledge.items.created', event_payload: {},
      entity_version: null, attempts: 0, max_attempts: 10,
    }]); // claim #1
    pushResponse([]); // markCompleted
    pushResponse([]); // claim #2 → null

    publishSpy.mockResolvedValueOnce(undefined);
    await outbox.runKnowledgeOutboxOnce();
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('reaper resets in_progress rows stuck > 5 min', async () => {
    pushResponse([]); // reaper
    pushResponse([]); // claim returns nothing
    await outbox.runKnowledgeOutboxOnce();
    const reaperQuery = dbMock.queries.find((q) => /SET status='pending', updated_at=NOW\(\)\s+WHERE status='in_progress'/.test(q.sql));
    expect(reaperQuery).toBeDefined();
  });
});
