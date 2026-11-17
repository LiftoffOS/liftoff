// billing DLQ drainer — unit tests.
//
// The drainer must republish parseable messages with a drain_attempt stamp,
// abandon messages that exceeded MAX_DRAIN_ATTEMPTS (ack without republish —
// the runtime-ingester backstop owns them), and ack unparseable messages
// loudly. Everything pulled must be acked so nothing loops in the DLQ.

const mockPublishMessage = jest.fn();
const mockPull = jest.fn();
const mockAcknowledge = jest.fn();

jest.mock('@google-cloud/pubsub', () => ({
  PubSub: jest.fn(() => ({
    topic: jest.fn(() => ({ publishMessage: mockPublishMessage })),
  })),
  v1: {
    SubscriberClient: jest.fn(() => ({
      subscriptionPath: (proj: string, name: string) => `projects/${proj}/subscriptions/${name}`,
      pull: mockPull,
      acknowledge: mockAcknowledge,
    })),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runDrain } from '../drain-invocation-completed-dlq';

function pubsubMessage(payload: unknown, attributes: Record<string, string> = {}, ackId = 'ack-1') {
  return {
    ackId,
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString('base64'),
      attributes,
    },
  };
}

describe('runDrain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DLQ_SUBSCRIPTION = 'projects/test-proj/subscriptions/invocation-completed-dlq-test-drain-sub';
    process.env.LIVE_TOPIC = 'projects/test-proj/topics/invocation-completed-test';
    mockPublishMessage.mockResolvedValue('msg-id');
    mockAcknowledge.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.DLQ_SUBSCRIPTION;
    delete process.env.LIVE_TOPIC;
  });

  it('republishes a parseable message with manual_retry and an incremented drain_attempt, then acks', async () => {
    const payload = { tenantId: 't1', invocationId: 'inv-1', costUsd: 0.5 };
    mockPull.mockResolvedValueOnce([{ receivedMessages: [pubsubMessage(payload)] }]);

    const result = await runDrain();

    expect(result).toEqual({ pulled: 1, republished: 1, abandoned: 0, unparseable: 0 });
    expect(mockPublishMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ manual_retry: 'true', drain_attempt: '1' }),
      }),
    );
    const sent = JSON.parse((mockPublishMessage.mock.calls[0][0] as { data: Buffer }).data.toString('utf8'));
    expect(sent).toEqual(payload);
    expect(mockAcknowledge).toHaveBeenCalledWith(expect.objectContaining({ ackIds: ['ack-1'] }));
  });

  it('abandons a message at max drain attempts: acks without republishing', async () => {
    mockPull.mockResolvedValueOnce([{
      receivedMessages: [pubsubMessage({ invocationId: 'inv-2' }, { drain_attempt: '3' }, 'ack-2')],
    }]);

    const result = await runDrain();

    expect(result).toEqual({ pulled: 1, republished: 0, abandoned: 1, unparseable: 0 });
    expect(mockPublishMessage).not.toHaveBeenCalled();
    expect(mockAcknowledge).toHaveBeenCalledWith(expect.objectContaining({ ackIds: ['ack-2'] }));
  });

  it('acks unparseable messages without republishing', async () => {
    mockPull.mockResolvedValueOnce([{
      receivedMessages: [{ ackId: 'ack-3', message: { data: Buffer.from('not json').toString('base64'), attributes: {} } }],
    }]);

    const result = await runDrain();

    expect(result).toEqual({ pulled: 1, republished: 0, abandoned: 0, unparseable: 1 });
    expect(mockPublishMessage).not.toHaveBeenCalled();
    expect(mockAcknowledge).toHaveBeenCalledWith(expect.objectContaining({ ackIds: ['ack-3'] }));
  });

  it('does not call acknowledge when the pull returns nothing', async () => {
    mockPull.mockResolvedValueOnce([{ receivedMessages: [] }]);

    const result = await runDrain();

    expect(result).toEqual({ pulled: 0, republished: 0, abandoned: 0, unparseable: 0 });
    expect(mockAcknowledge).not.toHaveBeenCalled();
  });
});
