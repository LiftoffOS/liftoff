// slack-event-publisher tests.
//
// Verifies:
//   1. Envelope shape matches the polling publisher (consumers don't fork by mode)
//   2. entityType derivation per Slack event type
//   3. entityId derivation: message.ts → entityId, reaction.item.ts → entityId
//   4. occurredAt: parses Slack's float-seconds ts; falls back to now when absent
//   5. Topic name follows `connector-events-${ENVIRONMENT}` convention
//   6. Pub/Sub attributes include the filters reactive subscriptions need
//   7. The SECOND publish — the control-plane hop that is the only route from
//      this service to an agent. Without it a Slack event reaches
//      harvest-service and stops there.

const mockPublishEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('./publisher.js', () => ({ publishEvent: (...a: unknown[]) => mockPublishEvent(...a) }));

import { PubSubPublisher } from '@liftoffos/pubsub';
import { __setSlackEventPublisher, publishSlackEvent } from './slack-event-publisher';

type PublishCall = { topic: string; body: Record<string, unknown>; attributes: Record<string, string> };

function makeMockPublisher(): { calls: PublishCall[]; publisher: PubSubPublisher } {
  const calls: PublishCall[] = [];
  const publisher = {
    publish: async (topic: string, body: unknown, options?: { attributes?: Record<string, string> }) => {
      calls.push({ topic, body: body as Record<string, unknown>, attributes: options?.attributes ?? {} });
      return 'msg-id';
    },
  } as unknown as PubSubPublisher;
  return { calls, publisher };
}

describe('publishSlackEvent', () => {
  const OLD_ENV = process.env.ENVIRONMENT;
  let mock: ReturnType<typeof makeMockPublisher>;

  beforeEach(() => {
    process.env.ENVIRONMENT = 'dev';
    mockPublishEvent.mockClear();
    mockPublishEvent.mockResolvedValue(undefined);
    mock = makeMockPublisher();
    __setSlackEventPublisher(mock.publisher);
  });

  afterEach(() => {
    process.env.ENVIRONMENT = OLD_ENV;
    __setSlackEventPublisher(null);
  });

  it('publishes a message event with entityType=Message and entityId=ts', async () => {
    await publishSlackEvent({
      connectorId: 'conn-1',
      tenantId: 'tenant-1',
      slackTeamId: 'T_KNOWN',
      eventId: 'Ev0001',
      slackEvent: { type: 'message', channel: 'C1', ts: '1717720000.123456', user: 'U1', text: 'hi' },
    });
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call.topic).toBe('connector-events-dev');
    expect(call.body).toMatchObject({
      eventId: 'Ev0001',
      tenantId: 'tenant-1',
      connectorId: 'conn-1',
      entityType: 'Message',
      entityId: '1717720000.123456',
      eventType: 'connector.record.synced',
      payload: { source: 'slack', data: { type: 'message', text: 'hi' } },
    });
    expect(call.attributes).toMatchObject({
      tenantId: 'tenant-1',
      entityType: 'Message',
      source: 'slack',
      eventType: 'connector.record.synced',
      connectorId: 'conn-1',
      delivery: 'push',
      slack_team_id: 'T_KNOWN',
    });
  });

  it('treats app_mention as a Message entity', async () => {
    await publishSlackEvent({
      connectorId: 'conn-1',
      tenantId: 'tenant-1',
      slackTeamId: 'T_KNOWN',
      eventId: 'Ev0002',
      slackEvent: { type: 'app_mention', channel: 'C1', ts: '1717720100.000200', text: '<@BOT> hi' },
    });
    expect(mock.calls[0].body.entityType).toBe('Message');
    expect(mock.calls[0].body.entityId).toBe('1717720100.000200');
  });

  it('treats reaction_added as a Reaction entity and uses item.ts as entityId', async () => {
    await publishSlackEvent({
      connectorId: 'conn-1',
      tenantId: 'tenant-1',
      slackTeamId: 'T_KNOWN',
      eventId: 'Ev0003',
      slackEvent: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'white_check_mark',
        item: { type: 'message', channel: 'C1', ts: '1717720200.000300' },
      },
    });
    expect(mock.calls[0].body.entityType).toBe('Reaction');
    expect(mock.calls[0].body.entityId).toBe('1717720200.000300');
  });

  it('falls back to entityType=SlackEvent for unknown types and entityId=eventId when no ts', async () => {
    await publishSlackEvent({
      connectorId: 'conn-1',
      tenantId: 'tenant-1',
      slackTeamId: 'T_KNOWN',
      eventId: 'Ev0004',
      slackEvent: { type: 'some_future_event', detail: 'whatever' },
    });
    expect(mock.calls[0].body.entityType).toBe('SlackEvent');
    expect(mock.calls[0].body.entityId).toBe('Ev0004');
  });

  it('occurredAt parses Slack ts as float seconds since epoch', async () => {
    await publishSlackEvent({
      connectorId: 'c', tenantId: 't', slackTeamId: 'T', eventId: 'E',
      slackEvent: { type: 'message', ts: '1717720000.000000' },
    });
    expect(mock.calls[0].body.occurredAt).toBe(new Date(1717720000000).toISOString());
  });

  it('occurredAt falls back to now when ts is missing or invalid', async () => {
    const before = Date.now();
    await publishSlackEvent({
      connectorId: 'c', tenantId: 't', slackTeamId: 'T', eventId: 'E',
      slackEvent: { type: 'message' }, // no ts
    });
    const occurred = Date.parse(mock.calls[0].body.occurredAt as string);
    expect(occurred).toBeGreaterThanOrEqual(before);
    expect(occurred).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('uses ENVIRONMENT to derive the topic name (prod env)', async () => {
    process.env.ENVIRONMENT = 'prod';
    await publishSlackEvent({
      connectorId: 'c', tenantId: 't', slackTeamId: 'T', eventId: 'E',
      slackEvent: { type: 'message', ts: '1717720000.0' },
    });
    expect(mock.calls[0].topic).toBe('connector-events-prod');
  });

  it('propagates publisher errors to the caller', async () => {
    const failing = {
      publish: async () => {
        throw new Error('pubsub-boom');
      },
    } as unknown as PubSubPublisher;
    __setSlackEventPublisher(failing);
    await expect(
      publishSlackEvent({
        connectorId: 'c', tenantId: 't', slackTeamId: 'T', eventId: 'E',
        slackEvent: { type: 'message', ts: '1717720000.0' },
      }),
    ).rejects.toThrow('pubsub-boom');
  });

  // ── The control-plane hop ────────────────────────────────────────────────
  // harvest-service is the only subscriber of the connector-events topic this
  // service can publish to. The tenant runtime reads a different topic of the
  // same name in a different project. These pin the second publish, which is
  // the one an agent is downstream of.

  it('also publishes connector.webhook_event_received onto the control plane', async () => {
    await publishSlackEvent({
      connectorId: 'conn-1',
      tenantId: 'tenant-1',
      slackTeamId: 'T_KNOWN',
      eventId: 'Ev0001',
      slackEvent: { type: 'message', channel: 'C1', ts: '1717720000.123456', user: 'U1', text: 'hi' },
    });

    expect(mockPublishEvent).toHaveBeenCalledTimes(1);
    const call = mockPublishEvent.mock.calls[0][0];
    expect(call.eventType).toBe('connector.webhook_event_received');
    expect(call).toMatchObject({ entityType: 'Message', entityId: '1717720000.123456', tenantId: 'tenant-1' });
    expect(call.payload).toMatchObject({
      source: 'slack',
      subtype: 'message',
      connectorId: 'conn-1',
      // Slack's event_id is the runtime's dedupe key.
      eventId: 'Ev0001',
      data: { type: 'message', text: 'hi' },
    });
    expect(call.attributes).toMatchObject({ source: 'slack', connectorId: 'conn-1', delivery: 'push' });
  });

  it('a failed control-plane hop is reported as a failure, not swallowed', async () => {
    // The harvest publish succeeding while this one fails means the event
    // reached no agent. Returning normally would report that as a success.
    mockPublishEvent.mockRejectedValue(new Error('control-plane-boom'));
    await expect(
      publishSlackEvent({
        connectorId: 'c', tenantId: 't', slackTeamId: 'T', eventId: 'E',
        slackEvent: { type: 'message', ts: '1717720000.0' },
      }),
    ).rejects.toThrow('control-plane-boom');
    // The harvest publish did happen — the failure is in the second hop only.
    expect(mock.calls).toHaveLength(1);
  });
});
