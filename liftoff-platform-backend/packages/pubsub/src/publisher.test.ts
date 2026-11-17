// Mock @google-cloud/pubsub before the import-under-test resolves it.
const publishMessageMock = jest.fn();
const topicMock = jest.fn((name: string) => {
  void name;
  return { publishMessage: publishMessageMock };
});
const pubSubCtorMock = jest.fn();

jest.mock('@google-cloud/pubsub', () => ({
  PubSub: class {
    constructor(opts?: { projectId?: string }) {
      pubSubCtorMock(opts);
    }
    topic(name: string) {
      return topicMock(name);
    }
  },
  Topic: class {},
}));

import { PubSubPublisher } from './publisher.js';

describe('PubSubPublisher.publish', () => {
  beforeEach(() => {
    publishMessageMock.mockReset().mockResolvedValue('msg-1');
    topicMock.mockClear();
    pubSubCtorMock.mockClear();
  });

  it('resolves topic via resolveTopicName and caches the handle', async () => {
    const pub = new PubSubPublisher({
      resolveTopicName: (short) => `${short}-dev`,
    });

    await pub.publish('foo', { x: 1 });
    await pub.publish('foo', { x: 2 });

    expect(topicMock).toHaveBeenCalledTimes(1);
    expect(topicMock).toHaveBeenCalledWith('foo-dev');
  });

  it('serialises the payload as JSON into a Buffer', async () => {
    const pub = new PubSubPublisher();
    await pub.publish('topic', { hello: 'world' });

    expect(publishMessageMock).toHaveBeenCalledTimes(1);
    const msg = publishMessageMock.mock.calls[0][0];
    expect(Buffer.isBuffer(msg.data)).toBe(true);
    expect(JSON.parse(msg.data.toString('utf8'))).toEqual({ hello: 'world' });
  });

  it('merges default and per-call attributes (per-call wins)', async () => {
    const pub = new PubSubPublisher({
      defaultAttributes: () => ({ timestamp: '2026-04-18', source: 'test' }),
    });

    await pub.publish('t', {}, { attributes: { source: 'override' } });

    const msg = publishMessageMock.mock.calls[0][0];
    expect(msg.attributes).toEqual({ timestamp: '2026-04-18', source: 'override' });
  });

  it('passes orderingKey when supplied', async () => {
    const pub = new PubSubPublisher();
    await pub.publish('t', {}, { orderingKey: 'order-abc' });

    const msg = publishMessageMock.mock.calls[0][0];
    expect(msg.orderingKey).toBe('order-abc');
  });

  it('logs on success via injected logger', async () => {
    const debug = jest.fn();
    const pub = new PubSubPublisher({ logger: { debug, error: jest.fn() } });
    await pub.publish('t', {});

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ topicName: 't', messageId: 'msg-1' }),
      'Message published to Pub/Sub',
    );
  });

  it('logs and re-throws on publish failure', async () => {
    const err = new Error('network');
    publishMessageMock.mockRejectedValueOnce(err);
    const error = jest.fn();
    const pub = new PubSubPublisher({ logger: { debug: jest.fn(), error } });

    await expect(pub.publish('t', {})).rejects.toBe(err);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ topicName: 't', error: 'network' }),
      'Failed to publish message to Pub/Sub',
    );
  });

  it('passes projectId to PubSub constructor when provided', () => {
    new PubSubPublisher({ projectId: 'my-proj' });
    expect(pubSubCtorMock).toHaveBeenCalledWith({ projectId: 'my-proj' });
  });
});

describe('PubSubPublisher.publishBatch', () => {
  beforeEach(() => {
    publishMessageMock.mockReset().mockImplementation(async () => `msg-${Math.random()}`);
    topicMock.mockClear();
  });

  it('publishes every message and returns their ids', async () => {
    publishMessageMock
      .mockResolvedValueOnce('a')
      .mockResolvedValueOnce('b')
      .mockResolvedValueOnce('c');

    const pub = new PubSubPublisher();
    const ids = await pub.publishBatch('t', [{ i: 1 }, { i: 2 }, { i: 3 }]);

    expect(ids).toEqual(['a', 'b', 'c']);
    expect(publishMessageMock).toHaveBeenCalledTimes(3);
  });

  it('reuses the same Topic handle for the whole batch', async () => {
    const pub = new PubSubPublisher();
    await pub.publishBatch('t', [{}, {}, {}]);
    expect(topicMock).toHaveBeenCalledTimes(1);
  });
});
