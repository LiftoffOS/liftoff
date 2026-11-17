// Tests for the control-plane event publisher.
//
// The Pub/Sub client is fully mocked via __setPublisher, so these tests
// never touch @google-cloud/pubsub or network. We verify:
//
//   1. publishCredentialsStored emits the expected envelope + attributes.
//   2. publishCredentialsStored is fire-and-forget — publisher failures
//      MUST NOT propagate to the caller (the OAuth callback).
//   3. The generic publishEvent path still honours per-call attributes
//      and merges them onto the default { eventType, entityType,
//      entityId, tenantId } set.

import {
  __setPublisher,
  publishCredentialsStored,
  publishEvent,
} from './publisher.js';

type PublishArgs = [
  topic: string,
  data: unknown,
  options?: { attributes?: Record<string, string> },
];

type MockPublisher = {
  publish: (topic: string, data: unknown, options?: unknown) => Promise<string>;
};

function makeMockPublisher(): {
  calls: PublishArgs[];
  publisher: MockPublisher;
} {
  const calls: PublishArgs[] = [];
  const publisher: MockPublisher = {
    publish: async (topic, data, options) => {
      calls.push([topic, data, options as PublishArgs[2]]);
      return 'msg-id';
    },
  };
  return { calls, publisher };
}

describe('events/publisher — publishCredentialsStored', () => {
  const OLD_ENV = process.env.ENVIRONMENT;

  beforeEach(() => {
    process.env.ENVIRONMENT = 'dev';
  });

  afterEach(() => {
    __setPublisher(null);
    if (OLD_ENV === undefined) {
      delete process.env.ENVIRONMENT;
    } else {
      process.env.ENVIRONMENT = OLD_ENV;
    }
  });

  it('publishes to control-plane-events-{env} with correct envelope + attributes', async () => {
    const { calls, publisher } = makeMockPublisher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __setPublisher(publisher as any);

    const before = Date.now();
    await publishCredentialsStored({
      tenantId: 'tenant-123',
      connectorId: 'conn-abc',
      connectorType: 'slack',
    });
    const after = Date.now();

    expect(calls).toHaveLength(1);
    const [topic, data, options] = calls[0];

    expect(topic).toBe('control-plane-events-dev');

    const envelope = data as {
      event_type: string;
      entity_type: string;
      entity_id: string;
      tenant_id?: string;
      event_id: string;
      occurred_at: string;
      payload?: Record<string, unknown>;
    };
    expect(envelope.event_type).toBe('connector.credentials_stored');
    expect(envelope.entity_type).toBe('connector');
    expect(envelope.entity_id).toBe('conn-abc');
    expect(envelope.tenant_id).toBe('tenant-123');
    expect(typeof envelope.event_id).toBe('string');
    expect(envelope.event_id.length).toBeGreaterThan(0);

    expect(envelope.payload).toBeDefined();
    const payload = envelope.payload as {
      connectorId: string;
      connectorType: string;
      timestamp: number;
    };
    expect(payload.connectorId).toBe('conn-abc');
    expect(payload.connectorType).toBe('slack');
    expect(payload.timestamp).toBeGreaterThanOrEqual(before);
    expect(payload.timestamp).toBeLessThanOrEqual(after);

    expect(options?.attributes).toEqual({
      eventType: 'connector.credentials_stored',
      entityType: 'connector',
      entityId: 'conn-abc',
      tenantId: 'tenant-123',
      connectorType: 'slack',
    });
  });

  it('resolves the topic name using ENVIRONMENT=prod', async () => {
    process.env.ENVIRONMENT = 'prod';
    const { calls, publisher } = makeMockPublisher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __setPublisher(publisher as any);

    await publishCredentialsStored({
      tenantId: 't',
      connectorId: 'c',
      connectorType: 'github',
    });

    expect(calls[0][0]).toBe('control-plane-events-prod');
  });

  it('is fire-and-forget — swallows publisher errors and does not throw', async () => {
    let calledCount = 0;
    const publisher: MockPublisher = {
      publish: async () => {
        calledCount += 1;
        throw new Error('pubsub exploded');
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __setPublisher(publisher as any);

    await expect(
      publishCredentialsStored({
        tenantId: 't',
        connectorId: 'c',
        connectorType: 'slack',
      }),
    ).resolves.toBeUndefined();

    expect(calledCount).toBe(1);
  });
});

describe('events/publisher — publishEvent extra attributes', () => {
  beforeEach(() => {
    process.env.ENVIRONMENT = 'dev';
  });

  afterEach(() => {
    __setPublisher(null);
  });

  it('merges per-call attributes onto the default attribute set', async () => {
    const { calls, publisher } = makeMockPublisher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __setPublisher(publisher as any);

    await publishEvent({
      entityType: 'connector',
      entityId: 'c-1',
      eventType: 'connector.some_event',
      entityVersion: 1,
      eventVersion: 1,
      tenantId: 't-1',
      attributes: { connectorType: 'slack', extra: 'value' },
    });

    const options = calls[0][2];
    expect(options?.attributes).toEqual({
      eventType: 'connector.some_event',
      entityType: 'connector',
      entityId: 'c-1',
      tenantId: 't-1',
      connectorType: 'slack',
      extra: 'value',
    });
  });

  it('ignores empty-string extra attribute values', async () => {
    const { calls, publisher } = makeMockPublisher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __setPublisher(publisher as any);

    await publishEvent({
      entityType: 'connector',
      entityId: 'c-1',
      eventType: 'connector.some_event',
      entityVersion: 1,
      eventVersion: 1,
      tenantId: 't-1',
      attributes: { connectorType: '', keep: 'ok' },
    });

    const options = calls[0][2];
    expect(options?.attributes?.connectorType).toBeUndefined();
    expect(options?.attributes?.keep).toBe('ok');
  });
});
