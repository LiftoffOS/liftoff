// Polling event publisher — unit tests.
//
// Verifies the connectorId contract: it must appear both in the message body
// (so subscribers can route to a specific connector) and in the Pub/Sub
// attributes (so subscribers can filter without deserializing the body).

import { jest } from '@jest/globals';

const mockPublishEvent = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.mock('../../events/publisher.js', () => ({
  publishEvent: (...a: unknown[]) => mockPublishEvent(...a),
}));
import type { PubSubPublisher } from '@liftoffos/pubsub';
import { publishPollingEvent, __setPollingPublisher } from '../event-publisher.js';
import type { NormalizedRecord } from '../../normalizers/types.js';

describe('publishPollingEvent — connectorId contract', () => {
  // Capture publish calls so we can inspect both body and attributes.
  let capturedTopic: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let capturedBody: Record<string, any> | null;
  let capturedOpts: { attributes?: Record<string, string> } | undefined;
  let mockPublisher: PubSubPublisher;

  beforeEach(() => {
    capturedTopic = null;
    capturedBody = null;
    capturedOpts = undefined;

    mockPublisher = {
      publish: jest.fn(async (topic: string, body: Record<string, unknown>, opts?: { attributes?: Record<string, string> }) => {
        capturedTopic = topic;
        capturedBody = body;
        capturedOpts = opts;
        return 'mock-message-id';
      }),
    } as unknown as PubSubPublisher;

    __setPollingPublisher(mockPublisher);
  });

  afterEach(() => {
    __setPollingPublisher(null);
  });

  function makeRecord(externalId = 'ext-record-001', version = 'v-test-1'): NormalizedRecord {
    return {
      entityType: 'CalendarEvent',
      externalId,
      data: { foo: 'bar', nested: { baz: 1 } },
      metadata: {
        source: 'google_calendar',
        syncedAt: new Date('2026-04-30T00:00:00Z'),
        version,
      },
    };
  }

  it('places connectorId in the message body and the attributes', async () => {
    await publishPollingEvent({
      connectorId: 'abc-123-connector',
      connectorType: 'google_calendar',
      entityType: 'CalendarEvent',
      tenantId: 'tenant-xyz',
      record: makeRecord(),
    });

    expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
    expect(capturedBody).not.toBeNull();

    // Body has connectorId set to the regular string (not null, not '').
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(capturedBody!.connectorId).toBe('abc-123-connector');
    // Attributes also have it.
    expect(capturedOpts?.attributes?.connectorId).toBe('abc-123-connector');
  });

  it('includes tenantId, entityType, and entityId in the message body', async () => {
    await publishPollingEvent({
      connectorId: 'abc-123-connector',
      connectorType: 'google_calendar',
      entityType: 'CalendarEvent',
      tenantId: 'tenant-xyz',
      record: makeRecord('ext-record-99'),
    });

    expect(capturedBody).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const body = capturedBody!;
    expect(body.tenantId).toBe('tenant-xyz');
    expect(body.entityType).toBe('CalendarEvent');
    expect(body.entityId).toBe('ext-record-99');
    expect(body.eventType).toBe('connector.record.synced');
    expect((body.payload as Record<string, unknown>).source).toBe('google_calendar');
    expect((body.payload as Record<string, unknown>).data).toEqual({ foo: 'bar', nested: { baz: 1 } });
  });

  it('publishes to the correct topic for the current environment', async () => {
    const origEnv = process.env.ENVIRONMENT;
    process.env.ENVIRONMENT = 'dev';
    try {
      await publishPollingEvent({
        connectorId: 'abc-123-connector',
        connectorType: 'google_calendar',
        entityType: 'CalendarEvent',
        tenantId: 'tenant-xyz',
        record: makeRecord(),
      });
      expect(capturedTopic).toBe('connector-events-dev');
    } finally {
      if (origEnv === undefined) {
        delete process.env.ENVIRONMENT;
      } else {
        process.env.ENVIRONMENT = origEnv;
      }
    }
  });

  it('mirrors connectorId between body and attributes (same value)', async () => {
    await publishPollingEvent({
      connectorId: 'matched-id-42',
      connectorType: 'salesforce',
      entityType: 'Lead',
      tenantId: 'tenant-1',
      record: makeRecord(),
    });

    expect(capturedBody).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(capturedBody!.connectorId).toBe(capturedOpts?.attributes?.connectorId);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(capturedBody!.connectorId).toBe('matched-id-42');
  });

  it('produces the same eventId for identical records (determinism guarantee)', async () => {
    let firstEventId: string | undefined;
    let secondEventId: string | undefined;

    const capturePublisher = {
      publish: jest.fn(async (_topic: string, body: Record<string, unknown>) => {
        if (!firstEventId) firstEventId = body.eventId as string;
        else secondEventId = body.eventId as string;
        return 'mock-message-id';
      }),
    } as unknown as PubSubPublisher;
    __setPollingPublisher(capturePublisher);

    const record = makeRecord('thread-abc', '2026-04-30T12:00:00Z');
    await publishPollingEvent({ connectorId: 'c1', connectorType: 'google_mail', entityType: 'EmailThread', tenantId: 't1', record });
    await publishPollingEvent({ connectorId: 'c1', connectorType: 'google_mail', entityType: 'EmailThread', tenantId: 't1', record });

    expect(firstEventId).toBe(secondEventId);
    expect(firstEventId).toBe('thread-abc-2026-04-30T12:00:00Z');
  });

  it('produces different eventIds when record version changes', async () => {
    const capturedIds: string[] = [];
    const capturePublisher = {
      publish: jest.fn(async (_topic: string, body: Record<string, unknown>) => {
        capturedIds.push(body.eventId as string);
        return 'mock-message-id';
      }),
    } as unknown as PubSubPublisher;
    __setPollingPublisher(capturePublisher);

    await publishPollingEvent({ connectorId: 'c1', connectorType: 'zendesk', entityType: 'Ticket', tenantId: 't1', record: makeRecord('ticket-1', '2026-04-30T10:00:00Z') });
    await publishPollingEvent({ connectorId: 'c1', connectorType: 'zendesk', entityType: 'Ticket', tenantId: 't1', record: makeRecord('ticket-1', '2026-04-30T11:00:00Z') });

    expect(capturedIds[0]).not.toBe(capturedIds[1]);
    expect(capturedIds[0]).toBe('ticket-1-2026-04-30T10:00:00Z');
    expect(capturedIds[1]).toBe('ticket-1-2026-04-30T11:00:00Z');
  });
});

// The SECOND publish — the control-plane hop that is the only route from this
// service to an agent. The publish above reaches harvest-service and stops:
// connector-service publishes `connector-events-${env}` in the CONTROL project,
// while the tenant runtime reads a same-named topic in the TENANT project, and
// no subscription bridges them. Without this hop every poll-reactive connector advertises event topics that
// cannot fire.
describe('publishPollingEvent — control-plane relay to the tenant runtime', () => {
  let mockPublisher: PubSubPublisher;

  beforeEach(() => {
    mockPublishEvent.mockClear();
    mockPublishEvent.mockResolvedValue(undefined);
    mockPublisher = {
      publish: jest.fn(async () => 'mock-message-id'),
    } as unknown as PubSubPublisher;
    __setPollingPublisher(mockPublisher);
  });

  afterEach(() => {
    __setPollingPublisher(null);
  });

  function record(externalId = 'ext-1', version = 'v1'): NormalizedRecord {
    return {
      entityType: 'Contact',
      externalId,
      data: { name: 'Ada' },
      metadata: { source: 'attio', syncedAt: new Date('2026-08-29T00:00:00Z'), version },
    };
  }

  it('relays the record to the control plane alongside the harvest publish', async () => {
    await publishPollingEvent({
      connectorId: 'conn-1',
      connectorType: 'attio',
      entityType: 'Contact',
      tenantId: 'tenant-1',
      record: record(),
    });

    // Harvest keeps its feed — the relay is an addition, not a replacement.
    expect(mockPublisher.publish).toHaveBeenCalledTimes(1);

    expect(mockPublishEvent).toHaveBeenCalledTimes(1);
    const arg = mockPublishEvent.mock.calls[0][0] as {
      eventType: string;
      tenantId: string;
      payload: Record<string, unknown>;
      attributes: Record<string, string>;
    };
    expect(arg.eventType).toBe('connector.record_synced');
    expect(arg.tenantId).toBe('tenant-1');
    expect(arg.payload.source).toBe('attio');
    expect(arg.payload.entityType).toBe('Contact');
    expect(arg.payload.connectorId).toBe('conn-1');
    expect(arg.payload.data).toEqual({ name: 'Ada' });
    expect(arg.attributes.delivery).toBe('poll');
  });

  it('carries the dedupe key the poller mints, not a fresh id', async () => {
    // The poller re-emits every visible record on EVERY cycle. Keyed on a fresh
    // id per publish this would wake an agent once a minute per record forever;
    // `${externalId}-${version}` is stable while the record is unchanged.
    await publishPollingEvent({
      connectorId: 'conn-1',
      connectorType: 'attio',
      entityType: 'Contact',
      tenantId: 'tenant-1',
      record: record('ext-9', 'v7'),
    });

    const arg = mockPublishEvent.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(arg.payload.eventId).toBe('ext-9-v7');

    // Stable across cycles: same record, same version, same key.
    mockPublishEvent.mockClear();
    await publishPollingEvent({
      connectorId: 'conn-1',
      connectorType: 'attio',
      entityType: 'Contact',
      tenantId: 'tenant-1',
      record: record('ext-9', 'v7'),
    });
    const again = mockPublishEvent.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(again.payload.eventId).toBe('ext-9-v7');
  });

  it('does NOT fail the poll when the relay fails', async () => {
    // Five consecutive poll failures flip a connector to reconnect-required. A
    // control-plane hiccup must not cost a customer their connector, and the
    // next cycle re-emits the record with the same dedupe key.
    mockPublishEvent.mockRejectedValue(new Error('control plane unavailable'));

    await expect(
      publishPollingEvent({
        connectorId: 'conn-1',
        connectorType: 'attio',
        entityType: 'Contact',
        tenantId: 'tenant-1',
        record: record(),
      }),
    ).resolves.toBeUndefined();

    expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
  });
});
