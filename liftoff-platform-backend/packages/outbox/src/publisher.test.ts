import { OutboxPublisher, enqueueOutboxEvent } from './publisher.js';
import type { EventEnvelope } from './envelope.js';

function mockPool(rows: unknown[]) {
  const query = jest.fn();
  // First SELECT returns the batch; subsequent calls return empty / ack updates.
  let selectCalls = 0;
  query.mockImplementation(async (sql: string) => {
    if (/SELECT .* FROM outbox_events/i.test(sql)) {
      selectCalls++;
      return { rows: selectCalls === 1 ? rows : [] };
    }
    if (/UPDATE outbox_events SET published_at/i.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { query };
}

function mockPubsub(publishImpl?: () => Promise<void>) {
  const publishMessage = jest.fn().mockImplementation(async () => {
    if (publishImpl) await publishImpl();
    return 'message-id';
  });
  const topic = jest.fn(() => ({ publishMessage }));
  return { topic, _publishMessage: publishMessage };
}

describe('OutboxPublisher', () => {
  it('publishes unpublished rows and marks them published', async () => {
    const pool = mockPool([
      {
        id: 1,
        event_id: 'e1',
        event_type: 'billing.invoice.created',
        schema_version: 1,
        tenant_id: 'ten1',
        occurred_at: new Date(),
        source_service: 'liftoff-billing',
        trace_id: null,
        payload: { amount: 100 },
      },
    ]);
    const pubsub = mockPubsub();
    const publisher = new OutboxPublisher(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pubsub as any,
      { topicResolver: (env: EventEnvelope) => `${env.eventType.split('.')[0]}-events` },
    );
    const count = await publisher.drain();
    expect(count).toBe(1);
    expect(pubsub.topic).toHaveBeenCalledWith('billing-events', { messageOrdering: true });
    expect(pubsub._publishMessage).toHaveBeenCalledTimes(1);
    const updateCall = pool.query.mock.calls.find((c) => /UPDATE outbox_events/.test(c[0] as string));
    expect(updateCall).toBeDefined();
  });

  it('stops processing the batch when a publish fails', async () => {
    const pool = mockPool([
      { id: 1, event_id: 'e1', event_type: 'x.y', schema_version: 1, tenant_id: 't', occurred_at: new Date(), source_service: 's', trace_id: null, payload: {} },
      { id: 2, event_id: 'e2', event_type: 'x.y', schema_version: 1, tenant_id: 't', occurred_at: new Date(), source_service: 's', trace_id: null, payload: {} },
    ]);
    let firstCallDone = false;
    const pubsub = mockPubsub(async () => {
      if (firstCallDone) throw new Error('vendor 503');
      firstCallDone = true;
    });
    const publisher = new OutboxPublisher(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pubsub as any,
      { topicResolver: () => 'topic', logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
    );
    const count = await publisher.drain();
    // First publish succeeded, second failed — 1 row marked published.
    expect(count).toBe(1);
  });
});

describe('enqueueOutboxEvent', () => {
  it('inserts with ON CONFLICT DO NOTHING', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const env: EventEnvelope = {
      eventId: 'e1',
      eventType: 't',
      schemaVersion: 1,
      tenantId: 'ten',
      occurredAt: new Date('2026-04-20T00:00:00Z'),
      sourceService: 'svc',
      traceId: 'tr',
      payload: { ok: true },
    };
    await enqueueOutboxEvent({ query }, env);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/ON CONFLICT \(event_id\) DO NOTHING/);
    expect(query.mock.calls[0][1]).toEqual([
      'e1', 't', 1, 'ten', env.occurredAt, 'svc', 'tr', JSON.stringify({ ok: true }),
    ]);
  });
});
