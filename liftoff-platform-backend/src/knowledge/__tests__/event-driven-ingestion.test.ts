// End-to-end test (stubbed Pub/Sub) for the event-driven extract → embed
// pipeline (plan §9).
//
// Path under test:
//   1. batchCreate enqueues the outbox row in the same tx.
//   2. publishOutboxRowInline invokes publishEventWithExplicitId (stubbed) and
//      captures the envelope payload that would flow through Pub/Sub.
//   3. handleControlPlaneEvent dispatches `knowledge.items.created` to the
//      handler with that payload.
//   4. The handler calls extractAndPersistItem → embedItem.
//   5. Assert end-state: extracted_text persisted AND knowledge_item_chunks
//      INSERT fires AND knowledge_items.embedding_v2 UPDATE fires (proves the
//      embedding write path actually runs, not just the extraction path).

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  insertAuditLogDirect: jest.fn(),
  logAudit: jest.fn(),
}));

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn(async () => ({})),
  // Stub CircuitBreaker — importing subscriber.ts pulls in the
  // agent-audit-logs → notifications → tenant-runtime-client chain, which
  // instantiates a CircuitBreaker at module load. Without this stub the
  // import chain throws before any test runs.
  CircuitBreaker: jest.fn().mockImplementation(() => ({
    execute: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    getState: jest.fn(() => 'closed'),
  })),
}));

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'http://localhost',
}));

const mockEmbed = jest.fn(async () => ({
  embeddings: [new Array(768).fill(0.42)],
  promptTokens: 1,
  model: 'g',
  provider: 'google',
}));
jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: { embed: (...args: unknown[]) => mockEmbed(...args) },
}));

const adminClient = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
const tenantClient = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: typeof adminClient) => Promise<unknown>) => fn(adminClient)),
  withTenantScope: jest.fn(async (_t: string, fn: (c: typeof tenantClient) => Promise<unknown>) => fn(tenantClient)),
}));

// Capture the envelope payload published by enqueueKnowledgeOutbox →
// publishOutboxRowInline → publishEventWithExplicitId.
interface CapturedEnvelope {
  eventId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  tenantId?: string;
  payload: { tenantId: string; itemId: string };
}
const publishedEnvelopes: CapturedEnvelope[] = [];
jest.mock('../../events/publisher', () => ({
  publishEventWithExplicitId: jest.fn(async (input: CapturedEnvelope) => {
    publishedEnvelopes.push(input);
  }),
}));

import { batchCreate } from '../repository';
import { handleControlPlaneEvent } from '../../events/subscriber';
import { publishOutboxRefs } from '../outbox';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const ITEM_ID = '00000000-0000-0000-0000-00000000000a';

const ORIG_ENV = { ...process.env };
let fetchMock: jest.Mock;

function pendingDocumentRow(): Record<string, unknown> {
  return {
    id: ITEM_ID,
    tenant_id: TENANT_ID,
    title: 'Account Recovery FAQ',
    source_url: 'https://help.example.com/articles/123',
    connector_id: 'conn-1',
    connector_type: 'zendesk',
    external_id: 'ext-1',
    content_type: 'document',
    excerpt: null,
    metadata: {},
    import_mode: 'auto_import',
    sync_status: 'synced',
    last_synced_at: new Date(),
    parent_id: null,
    extraction_status: 'pending',
    extracted_text: null,
    extracted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

beforeEach(() => {
  publishedEnvelopes.length = 0;
  adminClient.query.mockReset();
  tenantClient.query.mockReset();
  mockEmbed.mockClear();
  adminClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  tenantClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  process.env = { ...ORIG_ENV, CONNECTOR_SERVICE_URL: 'http://connector.local' };
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  process.env = ORIG_ENV;
});

describe('event-driven ingestion: batchCreate → outbox → subscriber → extract → embed', () => {
  it('document end-to-end: extract via stubbed HTTP, write chunks AND embedding_v2', async () => {
    // ── Stage 1: batchCreate tx ──────────────────────────────────────────────
    // 1. INSERT INTO knowledge_items ... RETURNING * (1 row, status=pending)
    // 2. INSERT INTO knowledge_outbox ... RETURNING id, event_id
    tenantClient.query
      .mockResolvedValueOnce({ rows: [pendingDocumentRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1', event_id: 'event-1' }] });

    const { items, outboxRefs } = await batchCreate(TENANT_ID, [{
      title: 'Account Recovery FAQ',
      connectorId: 'conn-1',
      connectorType: 'zendesk',
      externalId: 'ext-1',
      contentType: 'document',
      extractionStatus: 'pending',
    }]);
    expect(items).toHaveLength(1);
    expect(outboxRefs).toHaveLength(1);
    expect(outboxRefs[0]).toMatchObject({
      outboxId: 'outbox-1',
      eventId: 'event-1',
      itemId: ITEM_ID,
      eventType: 'knowledge.items.created',
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });

    // ── Stage 2: inline publish (also triggers markCompleted in adminScope) ──
    await publishOutboxRefs(outboxRefs);
    expect(publishedEnvelopes).toHaveLength(1);
    expect(publishedEnvelopes[0]).toMatchObject({
      eventId: 'event-1',
      entityType: 'knowledge_item',
      entityId: ITEM_ID,
      eventType: 'knowledge.items.created',
      tenantId: TENANT_ID,
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });

    // ── Stage 3: subscriber dispatch ─────────────────────────────────────────
    // The subscriber handler will issue (in order):
    //   3. SELECT findById → returns the pending row
    //   4. UPDATE markExtracting
    // Then extractItemContent does an HTTP fetch to the connector-service
    // (we stub it to return article HTML).
    //   5. UPDATE saveExtractedText (extracted_text + status='done')
    //   6. SELECT embedItem load row (extracted_text, status='synced')
    //   7. DELETE FROM knowledge_item_chunks
    //   8. INSERT INTO knowledge_item_chunks
    //   9. UPDATE knowledge_items SET embedding_v2
    tenantClient.query
      .mockResolvedValueOnce({ rows: [pendingDocumentRow()] })  // findById
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // markExtracting
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // saveExtractedText
      .mockResolvedValueOnce({
        rows: [{
          id: ITEM_ID,
          tenant_id: TENANT_ID,
          extracted_text: 'Hello world: how to recover your account.',
        }],
      })                                                          // embedItem SELECT
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })           // DELETE chunks
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })           // INSERT chunks
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });          // UPDATE embedding_v2

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ html: '<p>Hello world: how to recover your account.</p>' }),
    } as unknown as Response);

    await handleControlPlaneEvent({
      event_id: 'event-1',
      event_type: 'knowledge.items.created',
      tenant_id: TENANT_ID,
      entity_id: ITEM_ID,
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });

    // ── Assertions: full chain fired ─────────────────────────────────────────
    // The connector-service /content endpoint was hit
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain('/api/connectors/conn-1/content/ext-1');

    // saveExtractedText wrote the stripped article text
    const saveCall = tenantClient.query.mock.calls.find(([sql]) =>
      /UPDATE knowledge_items[\s\S]*SET[\s\S]*extracted_text/.test(String(sql)),
    );
    expect(saveCall).toBeDefined();
    const saveParams = saveCall![1] as unknown[];
    expect(String(saveParams[1])).toMatch(/Hello world/);

    // embedding provider was called with the persisted text as input
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    const embedInput = mockEmbed.mock.calls[0][0] as { input: string[]; taskType: string; context: Record<string, string> };
    expect(embedInput.input[0]).toMatch(/Hello world/);
    expect(embedInput.taskType).toBe('retrieval_document');
    expect(embedInput.context).toMatchObject({ tenantId: TENANT_ID, itemId: ITEM_ID, purpose: 'knowledge_embedding' });

    // DELETE-then-INSERT pattern on knowledge_item_chunks (idempotent replace)
    const deleteChunks = tenantClient.query.mock.calls.find(([sql]) =>
      /DELETE FROM knowledge_item_chunks/.test(String(sql)),
    );
    const insertChunks = tenantClient.query.mock.calls.find(([sql]) =>
      /INSERT INTO knowledge_item_chunks/.test(String(sql)),
    );
    expect(deleteChunks).toBeDefined();
    expect(insertChunks).toBeDefined();

    // embedding_v2 UPDATE on knowledge_items (the "is embedded?" assertion)
    const updateEmbeddingV2 = tenantClient.query.mock.calls.find(([sql]) =>
      /UPDATE knowledge_items SET embedding_v2/.test(String(sql)),
    );
    expect(updateEmbeddingV2).toBeDefined();
    const embeddingParams = updateEmbeddingV2![1] as unknown[];
    expect(embeddingParams[0]).toBe(ITEM_ID);
    expect(String(embeddingParams[1])).toMatch(/^\[0\.42,/);
  });

  it('idempotency: re-dispatching the SAME event for an already-done item is a no-op', async () => {
    // Subscriber loads the item via findById and sees extractionStatus='done'
    // → returns without calling extract or embed.
    tenantClient.query.mockResolvedValueOnce({
      rows: [{ ...pendingDocumentRow(), extraction_status: 'done' }],
    });

    await handleControlPlaneEvent({
      event_id: 'event-1',
      event_type: 'knowledge.items.created',
      tenant_id: TENANT_ID,
      entity_id: ITEM_ID,
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
    // Only the findById SELECT ran — no UPDATEs to extraction_status or chunks
    expect(tenantClient.query).toHaveBeenCalledTimes(1);
  });

  it('subscriber dispatch is robust when the item was deleted between publish and consume', async () => {
    // findById returns null (race: tenant deleted the item before subscriber consumed)
    tenantClient.query.mockResolvedValueOnce({ rows: [] });

    await handleControlPlaneEvent({
      event_id: 'event-1',
      event_type: 'knowledge.items.created',
      tenant_id: TENANT_ID,
      entity_id: ITEM_ID,
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});
