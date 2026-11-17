// Tests for the control-plane event subscriber dispatcher.
//
// We only exercise handleControlPlaneEvent here — the Pub/Sub wiring in
// startEventSubscribers is a thin boot-time setup around @google-cloud/pubsub
// and is covered by integration tests elsewhere. Unit scope: given an
// inbound envelope, the right handler is called with the right args.

const mockResolve = jest.fn();

jest.mock('../../internal-agents/pending-integration-service', () => ({
  resolvePendingIntegrationsForConnector: (...args: unknown[]) =>
    mockResolve(...args),
}));

const mockDeleteConnectorContent = jest.fn();
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    deleteConnectorContent: (...args: unknown[]) =>
      mockDeleteConnectorContent(...args),
  },
}));

const mockInsertAuditLogDirect = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  insertAuditLogDirect: (...args: unknown[]) => mockInsertAuditLogDirect(...args),
}));

const mockFindById = jest.fn();
jest.mock('../../knowledge/repository', () => ({
  findById: (...args: unknown[]) => mockFindById(...args),
}));

const mockExtractAndPersistItem = jest.fn();
const mockDeleteItemsForConnector = jest.fn();
jest.mock('../../knowledge/service', () => ({
  extractAndPersistItem: (...args: unknown[]) => mockExtractAndPersistItem(...args),
  // cleanupWebhooksForConnector is also imported by subscriber.ts
  cleanupWebhooksForConnector: jest.fn(),
  deleteItemsForConnector: (...args: unknown[]) => mockDeleteItemsForConnector(...args),
}));

const mockEmbedItem = jest.fn();
jest.mock('../../knowledge/embedding-service', () => ({
  embedItem: (...args: unknown[]) => mockEmbedItem(...args),
}));

import { handleControlPlaneEvent } from '../subscriber';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const CONNECTOR_ID = '00000000-0000-0000-0000-000000000002';

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue({ agentsUpdated: 1, agentIds: ['agent-1'] });
  mockDeleteConnectorContent.mockResolvedValue(undefined);
  mockDeleteItemsForConnector.mockResolvedValue(0);
});

describe('handleControlPlaneEvent — connector.credentials_stored', () => {
  it('calls resolvePendingIntegrationsForConnector with tenantId, connectorId, connectorType', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-1',
      event_type: 'connector.credentials_stored',
      entity_type: 'connector',
      entity_id: CONNECTOR_ID,
      tenant_id: TENANT_ID,
      payload: { connectorType: 'hubspot' },
    });

    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith(TENANT_ID, CONNECTOR_ID, 'hubspot');
  });

  it('also accepts snake_case connector_type in the payload', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-2',
      event_type: 'connector.credentials_stored',
      entity_id: CONNECTOR_ID,
      tenant_id: TENANT_ID,
      payload: { connector_type: 'google_calendar' },
    });

    expect(mockResolve).toHaveBeenCalledWith(
      TENANT_ID,
      CONNECTOR_ID,
      'google_calendar',
    );
  });

  it('ignores event types it does not care about', async () => {
    // Use an unhandled event type — `connector.deleted` is now consumed by
    // the subscriber (triggers content/webhook cleanup), so it would no
    // longer satisfy "ignored". Pick something the dispatch switch falls
    // through on.
    await handleControlPlaneEvent({
      event_id: 'evt-3',
      event_type: 'connector.something_unhandled',
      entity_id: CONNECTOR_ID,
      tenant_id: TENANT_ID,
      payload: { connectorType: 'hubspot' },
    });

    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('skips when tenant_id is missing', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-4',
      event_type: 'connector.credentials_stored',
      entity_id: CONNECTOR_ID,
      payload: { connectorType: 'hubspot' },
    });

    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('skips when entity_id (connectorId) is missing', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-5',
      event_type: 'connector.credentials_stored',
      tenant_id: TENANT_ID,
      payload: { connectorType: 'hubspot' },
    });

    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('skips when connectorType is missing from the payload', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-6',
      event_type: 'connector.credentials_stored',
      entity_id: CONNECTOR_ID,
      tenant_id: TENANT_ID,
      payload: {},
    });

    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('swallows errors from resolvePendingIntegrationsForConnector so the message still acks', async () => {
    mockResolve.mockRejectedValueOnce(new Error('db exploded'));

    await expect(
      handleControlPlaneEvent({
        event_id: 'evt-7',
        event_type: 'connector.credentials_stored',
        entity_id: CONNECTOR_ID,
        tenant_id: TENANT_ID,
        payload: { connectorType: 'hubspot' },
      }),
    ).resolves.toBeUndefined();
  });

  // ── connector.deleted (soft delete; agent bindings are KEPT) ──────────

  // The binding is the only record of what the agent was configured to use —
  // a Gmail binding carries its own sendAs and query. Scrubbing it threw that
  // away and left the Teams page with nothing to report, which is exactly the
  // silence the status badge exists to end. Disconnect is a soft delete, so
  // the id still resolves and the validator still accepts the agent on save.
  it('connector.deleted leaves the agent binding in place', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-del-1',
      event_type: 'connector.deleted',
      entity_type: 'connector',
      entity_id: CONNECTOR_ID,
      tenant_id: TENANT_ID,
      payload: { connectorType: 'google_mail' },
    });

    // The scrub module is gone entirely, so the guard here is that the delete
    // path still runs its remaining handlers and nothing re-grants bindings.
    // credentials_stored side-effect must NOT fire for delete events.
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockDeleteConnectorContent).toHaveBeenCalledTimes(1);
  });

  // INV-PB-012 / ADR-049: `knowledge_items.connector_id` holds a
  // connector-service id, so no FK in this database can cascade the delete.
  // This event IS the cleanup — if it stops firing, a deleted connector's
  // knowledge stays in the library forever.
  it('connector.deleted deletes the knowledge items imported from that connector', async () => {
    mockDeleteItemsForConnector.mockResolvedValueOnce(3);

    await handleControlPlaneEvent({
      event_id: 'evt-del-kb',
      event_type: 'connector.deleted',
      entity_type: 'connector',
      entity_id: CONNECTOR_ID,
      tenant_id: TENANT_ID,
      payload: { connectorType: 'google_drive' },
    });

    expect(mockDeleteItemsForConnector).toHaveBeenCalledTimes(1);
    expect(mockDeleteItemsForConnector).toHaveBeenCalledWith(TENANT_ID, CONNECTOR_ID);
  });

  it('connector.deleted still acks when the knowledge cleanup throws', async () => {
    // Best-effort: the earlier handlers (runtime content, webhook subs) have
    // already run by this point. Nacking would replay them.
    mockDeleteItemsForConnector.mockRejectedValueOnce(new Error('db down'));

    await expect(
      handleControlPlaneEvent({
        event_id: 'evt-del-kb-err',
        event_type: 'connector.deleted',
        entity_type: 'connector',
        entity_id: CONNECTOR_ID,
        tenant_id: TENANT_ID,
        payload: { connectorType: 'google_drive' },
      }),
    ).resolves.toBeUndefined();

    expect(mockDeleteConnectorContent).toHaveBeenCalledTimes(1);
  });

  // ── connector.disconnected (audit-only) ────────────────────────────────

  it('connector.disconnected is acked as an audit-only event (no side effects expected)', async () => {
    // Emitted by the composio-migrate-reconnect script and the user-initiated
    // disconnect path. Platform-backend does NOT write a notification row
    // (user-facing "Needs Reconnect" is data-driven via status='error'),
    // but the case must exist so the event doesn't fall through to the
    // generic ignore branch — operators rely on the dedicated log line for
    // migration observability.
    await expect(
      handleControlPlaneEvent({
        event_id: 'evt-disconnect-1',
        event_type: 'connector.disconnected',
        entity_id: CONNECTOR_ID,
        tenant_id: TENANT_ID,
        payload: { connectorType: 'cal_com', reason: 'composio_migration' },
      }),
    ).resolves.toBeUndefined();
    // Crucially, the credentials_stored side effect must NOT fire for this
    // event type.
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe('handleControlPlaneEvent — audit.platform_event', () => {
  beforeEach(() => {
    mockInsertAuditLogDirect.mockReset();
  });

  it('inserts an audit_log row when userId is present', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-audit-1',
      event_type: 'audit.platform_event',
      entity_type: 'connector',
      entity_id: CONNECTOR_ID,
      tenant_id: TENANT_ID,
      payload: {
        tenantId: TENANT_ID,
        userId: '99999999-9999-9999-9999-999999999999',
        eventType: 'connector.reauthorized',
        resourceType: 'connector',
        resourceId: CONNECTOR_ID,
        action: 'reauthorized',
        newState: { connectorType: 'hubspot' },
        previousState: null,
        occurredAt: '2026-05-21T12:00:00.000Z',
      },
    });

    expect(mockInsertAuditLogDirect).toHaveBeenCalledTimes(1);
    const insertArg = mockInsertAuditLogDirect.mock.calls[0][0];
    expect(insertArg).toMatchObject({
      eventType: 'connector.reauthorized',
      tenantId: TENANT_ID,
      userId: '99999999-9999-9999-9999-999999999999',
      resourceType: 'connector',
      resourceId: CONNECTOR_ID,
      action: 'reauthorized',
      newState: { connectorType: 'hubspot' },
    });
    expect(insertArg.timestamp).toBeInstanceOf(Date);
  });

  it('drops audit.platform_event with null userId (system/cron)', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-audit-2',
      event_type: 'audit.platform_event',
      entity_type: 'connector',
      entity_id: CONNECTOR_ID,
      tenant_id: TENANT_ID,
      payload: {
        tenantId: TENANT_ID,
        userId: null,
        eventType: 'connector.refreshed_by_cron',
        resourceType: 'connector',
        resourceId: CONNECTOR_ID,
        action: 'refreshed',
        occurredAt: '2026-05-21T12:00:00.000Z',
      },
    });

    expect(mockInsertAuditLogDirect).not.toHaveBeenCalled();
  });

  it('forwards optional metadata, ipAddress, userAgent, traceId', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-audit-3',
      event_type: 'audit.platform_event',
      entity_type: 'connector',
      entity_id: CONNECTOR_ID,
      tenant_id: TENANT_ID,
      payload: {
        tenantId: TENANT_ID,
        userId: '99999999-9999-9999-9999-999999999999',
        eventType: 'connector.created',
        resourceType: 'connector',
        resourceId: CONNECTOR_ID,
        action: 'created',
        occurredAt: '2026-05-21T12:00:00.000Z',
        metadata: { source: 'oauth' },
        ipAddress: '1.2.3.4',
        userAgent: 'jest',
        traceId: 'trace-1',
      },
    });

    const insertArg = mockInsertAuditLogDirect.mock.calls[0][0];
    expect(insertArg.metadata).toEqual({ source: 'oauth' });
    expect(insertArg.ipAddress).toBe('1.2.3.4');
    expect(insertArg.userAgent).toBe('jest');
    expect(insertArg.traceId).toBe('trace-1');
  });
});

describe('handleControlPlaneEvent — knowledge.items.created', () => {
  const ITEM_ID = '00000000-0000-0000-0000-00000000000a';

  beforeEach(() => {
    mockFindById.mockReset();
    mockExtractAndPersistItem.mockReset();
    mockEmbedItem.mockReset();
  });

  it('drops the message when payload is missing tenantId/itemId', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-k-1',
      event_type: 'knowledge.items.created',
      payload: {},
    });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockExtractAndPersistItem).not.toHaveBeenCalled();
    expect(mockEmbedItem).not.toHaveBeenCalled();
  });

  it('logs and returns when the item is not found', async () => {
    mockFindById.mockResolvedValueOnce(null);
    await handleControlPlaneEvent({
      event_id: 'evt-k-2',
      event_type: 'knowledge.items.created',
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });
    expect(mockFindById).toHaveBeenCalledWith(ITEM_ID, TENANT_ID);
    expect(mockExtractAndPersistItem).not.toHaveBeenCalled();
  });

  it('skips when item is already extracted (extraction_status != pending) — idempotency under at-least-once delivery', async () => {
    mockFindById.mockResolvedValueOnce({ id: ITEM_ID, tenantId: TENANT_ID, extractionStatus: 'done' });
    await handleControlPlaneEvent({
      event_id: 'evt-k-3',
      event_type: 'knowledge.items.created',
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });
    expect(mockExtractAndPersistItem).not.toHaveBeenCalled();
    expect(mockEmbedItem).not.toHaveBeenCalled();
  });

  it('happy path: pending item → calls extractAndPersistItem → embedItem', async () => {
    const item = { id: ITEM_ID, tenantId: TENANT_ID, extractionStatus: 'pending' };
    mockFindById.mockResolvedValueOnce(item);
    mockExtractAndPersistItem.mockResolvedValueOnce({ ok: true });
    mockEmbedItem.mockResolvedValueOnce({ embedded: true });

    await handleControlPlaneEvent({
      event_id: 'evt-k-4',
      event_type: 'knowledge.items.created',
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });

    expect(mockExtractAndPersistItem).toHaveBeenCalledWith(item);
    expect(mockEmbedItem).toHaveBeenCalledWith(TENANT_ID, ITEM_ID);
  });

  it('skips embed when extract returns ok:false (backstop cron retries later)', async () => {
    mockFindById.mockResolvedValueOnce({ id: ITEM_ID, tenantId: TENANT_ID, extractionStatus: 'pending' });
    mockExtractAndPersistItem.mockResolvedValueOnce({ ok: false });

    await handleControlPlaneEvent({
      event_id: 'evt-k-5',
      event_type: 'knowledge.items.created',
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });
    expect(mockEmbedItem).not.toHaveBeenCalled();
  });

  it('swallows embed errors so the subscriber acks (cron retries embed)', async () => {
    mockFindById.mockResolvedValueOnce({ id: ITEM_ID, tenantId: TENANT_ID, extractionStatus: 'pending' });
    mockExtractAndPersistItem.mockResolvedValueOnce({ ok: true });
    mockEmbedItem.mockRejectedValueOnce(new Error('provider 503'));

    await expect(handleControlPlaneEvent({
      event_id: 'evt-k-6',
      event_type: 'knowledge.items.created',
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    })).resolves.toBeUndefined();
  });

  it('skips when status is extracting (race: cron is mid-flight)', async () => {
    mockFindById.mockResolvedValueOnce({ id: ITEM_ID, tenantId: TENANT_ID, extractionStatus: 'extracting' });
    await handleControlPlaneEvent({
      event_id: 'evt-k-7',
      event_type: 'knowledge.items.created',
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });
    expect(mockExtractAndPersistItem).not.toHaveBeenCalled();
    expect(mockEmbedItem).not.toHaveBeenCalled();
  });

  it('skips when status is error (cron will re-pick this up; subscriber does not retry)', async () => {
    mockFindById.mockResolvedValueOnce({ id: ITEM_ID, tenantId: TENANT_ID, extractionStatus: 'error' });
    await handleControlPlaneEvent({
      event_id: 'evt-k-8',
      event_type: 'knowledge.items.created',
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    });
    expect(mockExtractAndPersistItem).not.toHaveBeenCalled();
  });

  it('drops when payload has only tenantId (missing itemId)', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-k-9',
      event_type: 'knowledge.items.created',
      payload: { tenantId: TENANT_ID },
    });
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('drops when payload has only itemId (missing tenantId)', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-k-10',
      event_type: 'knowledge.items.created',
      payload: { itemId: ITEM_ID },
    });
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('drops when payload is entirely missing (envelope had no payload)', async () => {
    await handleControlPlaneEvent({
      event_id: 'evt-k-11',
      event_type: 'knowledge.items.created',
    });
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('findById errors bubble out of the handler; the outer Pub/Sub listener catches + acks (see subscriber.ts:367-382)', async () => {
    mockFindById.mockRejectedValueOnce(new Error('db down'));
    // Documents the current behavior: the handler does NOT have its own
    // try/catch around findById. Production safety comes from the outer
    // listener's catch+ack wrapper. If a future refactor moves the catch
    // inward, change this expectation accordingly.
    await expect(handleControlPlaneEvent({
      event_id: 'evt-k-12',
      event_type: 'knowledge.items.created',
      payload: { tenantId: TENANT_ID, itemId: ITEM_ID },
    })).rejects.toThrow(/db down/);
  });
});
