// Tests for the outbox-enqueueing behavior of repo.create / repo.batchCreate.
//
// These verify the in-tx enqueue contract: the outbox row is inserted on the
// SAME PoolClient as the knowledge_items INSERT, so if the outbox insert
// throws the whole tx (knowledge_items insert + any prior queries) rolls back.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockTenantClient = { query: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) =>
    fn(mockTenantClient),
  ),
  withAdminScope: jest.fn(async (_meta: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn(mockTenantClient),
  ),
}));

import { create, batchCreate } from '../repository';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const ITEM_ID = '00000000-0000-0000-0000-00000000000a';

function pendingRow(id = ITEM_ID, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    tenant_id: TENANT_ID,
    title: 't',
    source_url: null,
    connector_id: null,
    connector_type: null,
    external_id: null,
    content_type: 'document',
    excerpt: null,
    metadata: {},
    import_mode: 'manual',
    sync_status: 'synced',
    last_synced_at: new Date(),
    parent_id: null,
    extraction_status: 'pending',
    extracted_text: null,
    extracted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('repo.create', () => {
  it('extractionStatus=pending → enqueues outbox row and returns ref', async () => {
    mockTenantClient.query
      .mockResolvedValueOnce({ rows: [pendingRow()] })                        // INSERT knowledge_items
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1', event_id: 'ev-1' }] }); // INSERT knowledge_outbox

    const result = await create(TENANT_ID, {
      title: 't',
      contentType: 'document',
      extractionStatus: 'pending',
    });

    expect(result.item.id).toBe(ITEM_ID);
    expect(result.outboxRef).toEqual({
      outboxId: 'outbox-1',
      eventId: 'ev-1',
      tenantId: TENANT_ID,
      itemId: ITEM_ID,
      eventType: 'knowledge.items.created',
      entityVersion: null,
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });
    // Two queries: knowledge_items INSERT then knowledge_outbox INSERT
    expect(mockTenantClient.query).toHaveBeenCalledTimes(2);
    const [insertItemsSql] = mockTenantClient.query.mock.calls[0];
    expect(String(insertItemsSql)).toMatch(/INSERT INTO knowledge_items/);
    const [insertOutboxSql] = mockTenantClient.query.mock.calls[1];
    expect(String(insertOutboxSql)).toMatch(/INSERT INTO knowledge_outbox/);
  });

  it('extractionStatus=none (folder) → does NOT enqueue, returns outboxRef=null', async () => {
    mockTenantClient.query.mockResolvedValueOnce({
      rows: [pendingRow(ITEM_ID, { extraction_status: 'none', content_type: 'folder' })],
    });

    const result = await create(TENANT_ID, {
      title: 'Drive folder',
      contentType: 'folder',
      extractionStatus: 'none',
    });

    expect(result.outboxRef).toBeNull();
    // Only the knowledge_items INSERT — no outbox INSERT
    expect(mockTenantClient.query).toHaveBeenCalledTimes(1);
  });

  it('outbox INSERT failure bubbles out of the tx (caller sees the error, knowledge_items rolls back)', async () => {
    mockTenantClient.query
      .mockResolvedValueOnce({ rows: [pendingRow()] })
      .mockRejectedValueOnce(new Error('unique violation'));

    await expect(create(TENANT_ID, {
      title: 't',
      contentType: 'document',
      extractionStatus: 'pending',
    })).rejects.toThrow(/unique violation/);
  });
});

describe('repo.batchCreate', () => {
  it('empty input: short-circuits, returns { items: [], outboxRefs: [] }, no DB call', async () => {
    const result = await batchCreate(TENANT_ID, []);
    expect(result).toEqual({ items: [], outboxRefs: [] });
    expect(mockTenantClient.query).not.toHaveBeenCalled();
  });

  it('one pending item: bulk INSERT then one outbox INSERT', async () => {
    mockTenantClient.query
      .mockResolvedValueOnce({ rows: [pendingRow()] })                        // bulk INSERT
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1', event_id: 'ev-1' }] }); // outbox INSERT

    const result = await batchCreate(TENANT_ID, [{
      title: 't',
      contentType: 'document',
      extractionStatus: 'pending',
    }]);

    expect(result.items).toHaveLength(1);
    expect(result.outboxRefs).toHaveLength(1);
    expect(result.outboxRefs[0].itemId).toBe(ITEM_ID);
  });

  it('mixed pending + none: only enqueues for pending items (folder filter)', async () => {
    const folderId = '00000000-0000-0000-0000-00000000000b';
    mockTenantClient.query
      .mockResolvedValueOnce({
        rows: [
          pendingRow(ITEM_ID, { extraction_status: 'pending' }),
          pendingRow(folderId, { extraction_status: 'none', content_type: 'folder' }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1', event_id: 'ev-1' }] });

    const result = await batchCreate(TENANT_ID, [
      { title: 'doc', contentType: 'document', extractionStatus: 'pending' },
      { title: 'folder', contentType: 'folder', extractionStatus: 'none' },
    ]);

    expect(result.items).toHaveLength(2);
    expect(result.outboxRefs).toHaveLength(1);
    expect(result.outboxRefs[0].itemId).toBe(ITEM_ID);
    // 1 bulk INSERT + 1 outbox INSERT (folder skipped)
    expect(mockTenantClient.query).toHaveBeenCalledTimes(2);
  });

  it('UPSERT path preserving done status: row returned with extraction_status=done → no event', async () => {
    // Simulates the re-import case: upsert hits an existing row that's already
    // 'done', the CASE clause preserves 'done', so the filter
    // `extractionStatus !== 'pending'` skips enqueue.
    mockTenantClient.query.mockResolvedValueOnce({
      rows: [pendingRow(ITEM_ID, { extraction_status: 'done' })],
    });

    const result = await batchCreate(TENANT_ID, [{
      title: 'reimport',
      connectorId: 'c1',
      externalId: 'x1',
      contentType: 'document',
      extractionStatus: 'pending',
    }]);

    expect(result.items).toHaveLength(1);
    expect(result.outboxRefs).toHaveLength(0);
    expect(mockTenantClient.query).toHaveBeenCalledTimes(1); // no outbox INSERT
  });

  it('multi-item enqueue: one outbox INSERT per pending row, sequential', async () => {
    const idA = '00000000-0000-0000-0000-0000000000aa';
    const idB = '00000000-0000-0000-0000-0000000000bb';
    mockTenantClient.query
      .mockResolvedValueOnce({
        rows: [pendingRow(idA), pendingRow(idB)],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'o-1', event_id: 'e-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'o-2', event_id: 'e-2' }] });

    const result = await batchCreate(TENANT_ID, [
      { title: 'a', contentType: 'document', extractionStatus: 'pending' },
      { title: 'b', contentType: 'document', extractionStatus: 'pending' },
    ]);

    expect(result.outboxRefs).toHaveLength(2);
    expect(result.outboxRefs.map((r) => r.itemId)).toEqual([idA, idB]);
    // 1 bulk + 2 outbox = 3 queries
    expect(mockTenantClient.query).toHaveBeenCalledTimes(3);
  });

  it('outbox INSERT mid-batch failure rejects the whole batch (tx rollback semantics)', async () => {
    const idA = '00000000-0000-0000-0000-0000000000aa';
    const idB = '00000000-0000-0000-0000-0000000000bb';
    mockTenantClient.query
      .mockResolvedValueOnce({ rows: [pendingRow(idA), pendingRow(idB)] })
      .mockResolvedValueOnce({ rows: [{ id: 'o-1', event_id: 'e-1' }] })
      .mockRejectedValueOnce(new Error('outbox FK violation'));

    await expect(batchCreate(TENANT_ID, [
      { title: 'a', contentType: 'document', extractionStatus: 'pending' },
      { title: 'b', contentType: 'document', extractionStatus: 'pending' },
    ])).rejects.toThrow(/outbox FK violation/);
  });
});

