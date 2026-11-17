// Tests for pubsub-dlq-drainer. Mocks @google-cloud/pubsub clients and pg
// Pool to exercise the pull → insert → publish → ack pipeline.
//
// The replay-cap cases are the reason half this file exists. Unconditional
// republishing loops: an event that fails for a reason republishing cannot
// change comes straight back and gets drained again ten minutes later, piling
// up failed_events rows without end. The cap turns that loop into three
// attempts and a durable record.

const pullMock = jest.fn();
const acknowledgeMock = jest.fn();
const publishMessageMock = jest.fn();
const poolQueryMock = jest.fn();
const poolEndMock = jest.fn();
const loggerErrorMock = jest.fn();

jest.mock('@google-cloud/pubsub', () => ({
  PubSub: jest.fn().mockImplementation(() => ({
    topic: () => ({ publishMessage: publishMessageMock }),
  })),
  v1: {
    SubscriberClient: jest.fn().mockImplementation(() => ({
      subscriptionPath: (p: string, s: string) => `projects/${p}/subscriptions/${s}`,
      pull: pullMock,
      acknowledge: acknowledgeMock,
    })),
  },
}));

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: poolQueryMock,
    end: poolEndMock,
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), error: loggerErrorMock, warn: jest.fn() },
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const SUB = 'projects/tenant-test-dev/subscriptions/control-plane-events-dev-dlq-sub';

/** Route each statement by shape. `priorReplays` is what the replay-cap
 *  COUNT returns, which is the only input that decides republish vs hold. */
function primePool(opts: { priorReplays?: number } = {}) {
  poolQueryMock.mockReset();
  poolQueryMock.mockImplementation(async (sql: string) => {
    if (/count\(\*\)/i.test(sql)) {
      return { rows: [{ n: String(opts.priorReplays ?? 0) }] };
    }
    return { rows: [{ id: 'fe-1' }] };
  });
}

function sqlCalls(fragment: RegExp): Array<[string, unknown[]]> {
  return poolQueryMock.mock.calls
    .filter((c) => fragment.test(c[0] as string))
    .map((c) => [c[0] as string, c[1] as unknown[]]);
}

function received(opts: { ackId: string; messageId: string; body: string }) {
  return [{
    receivedMessages: [{
      ackId: opts.ackId,
      deliveryAttempt: 3,
      message: {
        messageId: opts.messageId,
        data: Buffer.from(opts.body).toString('base64'),
        attributes: { source: 'unit-test' },
        publishTime: '2026-05-31T00:00:00Z',
      },
    }],
  }];
}

const EVENT_ID = '97ad66e5-25d5-4bf1-aef0-342def728d7b';

describe('pubsub-dlq-drainer', () => {
  const originalEnv = process.env;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    pullMock.mockReset();
    acknowledgeMock.mockReset();
    publishMessageMock.mockReset();
    poolEndMock.mockReset();
    loggerErrorMock.mockReset();
    primePool();
    process.env = {
      ...originalEnv,
      DLQ_SUBSCRIPTION: SUB,
      LIVE_TOPIC: 'projects/YOUR_CONTROL_PROJECT_STAGING/topics/control-plane-events-dev',
      TENANT_ID: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
      DB_HOST: '10.0.0.1',
      DB_USER: 'tenant_app',
      DB_NAME: 'tenant_runtime',
      DB_PASSWORD: 'pw',
    };
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.env = originalEnv;
  });

  it('empty DLQ → no inserts, exit 0', async () => {
    pullMock.mockResolvedValue([{ receivedMessages: [] }]);
    const { main } = await import('../pubsub-dlq-drainer');
    await main();
    expect(poolQueryMock).not.toHaveBeenCalled();
    expect(acknowledgeMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('parseable payload under the cap → insert + republish + ack', async () => {
    pullMock.mockResolvedValue(received({
      ackId: 'ack-1', messageId: 'm-1',
      body: JSON.stringify({ event_id: EVENT_ID, foo: 'bar' }),
    }));
    publishMessageMock.mockResolvedValue('new-msg-id');

    const { main } = await import('../pubsub-dlq-drainer');
    await main();

    expect(sqlCalls(/INSERT INTO failed_events/i)).toHaveLength(1);
    expect(publishMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      attributes: expect.objectContaining({
        manual_retry: 'true',
        republished_from_dlq: 'true',
        original_dlq_message_id: 'm-1',
      }),
    }));
    expect(sqlCalls(/SET republished = TRUE/i)).toHaveLength(1);
    expect(acknowledgeMock).toHaveBeenCalledWith({ subscription: SUB, ackIds: ['ack-1'] });
  });

  it('unparseable payload → insert, no republish, reason recorded, ack', async () => {
    pullMock.mockResolvedValue(received({
      ackId: 'ack-2', messageId: 'm-2', body: 'not json at all',
    }));

    const { main } = await import('../pubsub-dlq-drainer');
    await main();

    expect(publishMessageMock).not.toHaveBeenCalled();
    // Held, with a reason, rather than left blank: republished = FALSE plus a
    // populated republish_error is what the retention sweep counts as
    // outstanding and refuses to delete.
    const [[, params]] = sqlCalls(/SET republish_error = \$2/i);
    expect(params[1]).toMatch(/not valid UTF-8 JSON/);
    expect(acknowledgeMock).toHaveBeenCalledWith({ subscription: SUB, ackIds: ['ack-2'] });
  });

  it('publishMessage throws → no ack, exit 1', async () => {
    pullMock.mockResolvedValue(received({
      ackId: 'ack-3', messageId: 'm-3', body: JSON.stringify({ event_id: EVENT_ID }),
    }));
    publishMessageMock.mockRejectedValue(new Error('quota exceeded'));

    const { main } = await import('../pubsub-dlq-drainer');
    await main();

    expect(acknowledgeMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  describe('replay cap', () => {
    it('still republishes on the last lap inside the budget', async () => {
      const { MAX_REPLAYS_PER_EVENT } = await import('../pubsub-dlq-drainer');
      primePool({ priorReplays: MAX_REPLAYS_PER_EVENT - 1 });
      pullMock.mockResolvedValue(received({
        ackId: 'ack-4', messageId: 'm-4', body: JSON.stringify({ event_id: EVENT_ID }),
      }));
      publishMessageMock.mockResolvedValue('new-msg-id');

      const { main } = await import('../pubsub-dlq-drainer');
      await main();

      expect(publishMessageMock).toHaveBeenCalledTimes(1);
    });

    it('stops republishing once the budget is spent', async () => {
      const { MAX_REPLAYS_PER_EVENT } = await import('../pubsub-dlq-drainer');
      primePool({ priorReplays: MAX_REPLAYS_PER_EVENT });
      pullMock.mockResolvedValue(received({
        ackId: 'ack-5', messageId: 'm-5', body: JSON.stringify({ event_id: EVENT_ID }),
      }));

      const { main } = await import('../pubsub-dlq-drainer');
      await main();

      expect(publishMessageMock).not.toHaveBeenCalled();
      const [[, params]] = sqlCalls(/SET republish_error = \$2/i);
      expect(params[0]).toBe('m-5');
      expect(params[1]).toMatch(/replay cap reached/);
    });

    it('acks the capped message so the broker DLQ still drains', async () => {
      // The record is durable in failed_events. Nacking would leave the
      // message on the DLQ subscription, where it re-pulls every ten minutes
      // and keeps the Pub/Sub depth alert firing on work that is already
      // recorded and already triaged.
      const { MAX_REPLAYS_PER_EVENT } = await import('../pubsub-dlq-drainer');
      primePool({ priorReplays: MAX_REPLAYS_PER_EVENT + 5 });
      pullMock.mockResolvedValue(received({
        ackId: 'ack-6', messageId: 'm-6', body: JSON.stringify({ event_id: EVENT_ID }),
      }));

      const { main } = await import('../pubsub-dlq-drainer');
      await main();

      expect(acknowledgeMock).toHaveBeenCalledWith({ subscription: SUB, ackIds: ['ack-6'] });
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('will not stamp a hold onto a row that already republished', async () => {
      // The insert is ON CONFLICT DO NOTHING, so a message re-pulled after a
      // failed ack lands back on its existing row — which may already say
      // republished = TRUE and may by now be over the cap. Writing a hold onto
      // that row would produce a state the sweep reads both ways: deleted as
      // finished, missing from the backlog count.
      const { MAX_REPLAYS_PER_EVENT } = await import('../pubsub-dlq-drainer');
      primePool({ priorReplays: MAX_REPLAYS_PER_EVENT });
      pullMock.mockResolvedValue(received({
        ackId: 'ack-10', messageId: 'm-10', body: JSON.stringify({ event_id: EVENT_ID }),
      }));

      const { main } = await import('../pubsub-dlq-drainer');
      await main();

      expect(sqlCalls(/SET republish_error = \$2/i)[0][0]).toMatch(/AND NOT republished/);
    });

    it('emits the alertable event when it gives up', async () => {
      const { MAX_REPLAYS_PER_EVENT } = await import('../pubsub-dlq-drainer');
      primePool({ priorReplays: MAX_REPLAYS_PER_EVENT });
      pullMock.mockResolvedValue(received({
        ackId: 'ack-7', messageId: 'm-7', body: JSON.stringify({ event_id: EVENT_ID }),
      }));

      const { main } = await import('../pubsub-dlq-drainer');
      await main();

      expect(loggerErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'dlq_replay_capped',

          event_id: EVENT_ID,
          topic: 'control-plane-events-dev',
          prior_replays: MAX_REPLAYS_PER_EVENT,
          cap: MAX_REPLAYS_PER_EVENT,
        }),
        expect.any(String),
      );
    });

    it('counts only successful republishes of the same event', async () => {
      // Rows the drainer held are not evidence that replay was tried, and the
      // current lap's own row is inserted before the count runs — it must not
      // count itself, or the effective budget would be one short.
      primePool({ priorReplays: 0 });
      pullMock.mockResolvedValue(received({
        ackId: 'ack-8', messageId: 'm-8', body: JSON.stringify({ event_id: EVENT_ID }),
      }));
      publishMessageMock.mockResolvedValue('new-msg-id');

      const { main } = await import('../pubsub-dlq-drainer');
      await main();

      const [[sql, params]] = sqlCalls(/count\(\*\)/i);
      expect(sql).toMatch(/FROM failed_events/);
      expect(sql).toMatch(/original_event_id = \$1 AND republished/);
      expect(params).toEqual([EVENT_ID]);
    });

    it('holds a payload it cannot identify rather than replaying it unbounded', async () => {
      // The cap counts laps by event_id. A parseable payload without one would
      // sail past the budget forever, which is the same loop the cap exists to
      // stop — so it is held instead. It would fail schema validation at the
      // receiver anyway; every control-plane event carries an event_id.
      pullMock.mockResolvedValue(received({
        ackId: 'ack-9', messageId: 'm-9', body: JSON.stringify({ no_event_id: true }),
      }));

      const { main } = await import('../pubsub-dlq-drainer');
      await main();

      expect(sqlCalls(/count\(\*\)/i)).toHaveLength(0);
      expect(publishMessageMock).not.toHaveBeenCalled();
      const [[, params]] = sqlCalls(/SET republish_error = \$2/i);
      expect(params[1]).toMatch(/no event_id/);
      expect(acknowledgeMock).toHaveBeenCalledWith({ subscription: SUB, ackIds: ['ack-9'] });
    });
  });

  // One execution drains every DLQ: a backstop that usually finds nothing
  // should cost one container start a day, not eight.
  describe('several DLQs in one execution', () => {
    const SUB2 = 'projects/tenant-test-dev/subscriptions/tenant-suspended-dev-dlq-sub';
    const LIVE = 'projects/YOUR_CONTROL_PROJECT_STAGING/topics/control-plane-events-dev';
    const LIVE2 = 'projects/YOUR_CONTROL_PROJECT_STAGING/topics/tenant-suspended-dev';

    it('parses DLQ_PAIRS, and falls back to the single pair', async () => {
      const { drainTargets } = await import('../pubsub-dlq-drainer');
      expect(drainTargets({ DLQ_PAIRS: `${SUB}|${LIVE}, ${SUB2}|${LIVE2}` })).toEqual([
        { dlqSubFqn: SUB, liveTopicFqn: LIVE },
        { dlqSubFqn: SUB2, liveTopicFqn: LIVE2 },
      ]);
      expect(drainTargets({ DLQ_SUBSCRIPTION: SUB, LIVE_TOPIC: LIVE })).toEqual([{ dlqSubFqn: SUB, liveTopicFqn: LIVE }]);
      expect(() => drainTargets({ DLQ_PAIRS: SUB })).toThrow(/not <subscription>\|<topic>/);
      expect(() => drainTargets({})).toThrow(/required/);
    });

    it('drains each, and one failing does not stop the next', async () => {
      process.env.DLQ_PAIRS = `${SUB}|${LIVE},${SUB2}|${LIVE2}`;
      pullMock
        .mockRejectedValueOnce(new Error('pull failed'))
        .mockResolvedValueOnce(received({
          ackId: 'ack-2', messageId: 'm-2',
          body: JSON.stringify({ event_id: EVENT_ID }),
        }));
      publishMessageMock.mockResolvedValue('new-msg-id');

      const { main } = await import('../pubsub-dlq-drainer');
      await main();

      expect(pullMock).toHaveBeenCalledTimes(2);
      expect(acknowledgeMock).toHaveBeenCalledWith({ subscription: SUB2, ackIds: ['ack-2'] });
      expect(poolEndMock).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
