// Tests for the connector-service audit producer. Verifies the envelope
// shape that lands on the shared control-plane topic and that the
// platform-backend subscriber arm can decode it without surprises.

import {
  __setPublisher,
  publishEvent as _unused,
} from './publisher.js';
import { publishAuditEvent } from './audit-publisher.js';

void _unused;

type PublishArgs = [
  topic: string,
  data: unknown,
  options?: { attributes?: Record<string, string> },
];

function makeMockPublisher(): {
  calls: PublishArgs[];
  publisher: { publish: (...args: PublishArgs) => Promise<string> };
} {
  const calls: PublishArgs[] = [];
  return {
    calls,
    publisher: {
      publish: async (topic, data, options) => {
        calls.push([topic, data, options as PublishArgs[2]]);
        return 'msg-id';
      },
    },
  };
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const ACCOUNT = '22222222-2222-2222-2222-222222222222';
const CONNECTOR = '33333333-3333-3333-3333-333333333333';

describe('publishAuditEvent', () => {
  beforeEach(() => {
    __setPublisher(null);
  });

  it('publishes an audit.platform_event envelope with the expected payload', async () => {
    const { calls, publisher } = makeMockPublisher();
    __setPublisher(publisher as never);

    await publishAuditEvent({
      tenantId: TENANT,
      userId: ACCOUNT,
      eventType: 'connector.created',
      resourceId: CONNECTOR,
      newState: { connectorType: 'hubspot' },
    });

    expect(calls).toHaveLength(1);
    const [, data, options] = calls[0];
    const envelope = data as Record<string, unknown>;
    expect(envelope.event_type).toBe('audit.platform_event');
    expect(envelope.entity_type).toBe('connector');
    expect(envelope.entity_id).toBe(CONNECTOR);
    expect(envelope.tenant_id).toBe(TENANT);

    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.tenantId).toBe(TENANT);
    expect(payload.userId).toBe(ACCOUNT);
    expect(payload.eventType).toBe('connector.created');
    expect(payload.resourceType).toBe('connector');
    expect(payload.resourceId).toBe(CONNECTOR);
    expect(payload.action).toBe('created');
    expect(payload.newState).toEqual({ connectorType: 'hubspot' });
    expect(payload.occurredAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    // Default attributes carry eventType / entityType / entityId / tenantId
    expect(options?.attributes?.eventType).toBe('audit.platform_event');
    expect(options?.attributes?.tenantId).toBe(TENANT);
  });

  it('omits previousState/newState when not provided', async () => {
    const { calls, publisher } = makeMockPublisher();
    __setPublisher(publisher as never);

    await publishAuditEvent({
      tenantId: TENANT,
      userId: ACCOUNT,
      eventType: 'connector.disconnected',
      resourceId: CONNECTOR,
    });

    const payload = (calls[0][1] as { payload: Record<string, unknown> }).payload;
    expect(payload.previousState).toBeNull();
    expect(payload.newState).toBeNull();
  });

  it("extracts action from the dotted eventType (everything after the first dot)", async () => {
    const { calls, publisher } = makeMockPublisher();
    __setPublisher(publisher as never);

    await publishAuditEvent({
      tenantId: TENANT,
      userId: ACCOUNT,
      eventType: 'connector.apikey_connected',
      resourceId: CONNECTOR,
    });

    const payload = (calls[0][1] as { payload: Record<string, unknown> }).payload;
    expect(payload.action).toBe('apikey_connected');
  });
});
