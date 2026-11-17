// Unit tests for the governance-engine event publisher.
// The publisher wraps @liftoffos/pubsub's PubSubPublisher — here we inject
// a fake and assert topic + envelope + attributes + fire-and-forget
// semantics (errors never throw).

import {
  publishCorrectionCaptured,
  publishLateFeedbackFlagged,
  publishActionCompensated,
  GOVERNANCE_EVENT_TYPES,
  __resetPublisherForTests,
} from './publisher';

jest.mock('../infrastructure/logging', () => {
  const silent = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { logger: silent, log: silent };
});

type FakePublish = jest.Mock<Promise<string>, [string, unknown, unknown?]>;

function makeFakePublisher(): { publish: FakePublish; publishBatch: jest.Mock } {
  const publish = jest.fn().mockResolvedValue('msg-id-123') as FakePublish;
  return { publish, publishBatch: jest.fn() };
}

describe('governance events publisher', () => {
  const origEnv = process.env.ENVIRONMENT;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = origEnv;
    __resetPublisherForTests(null);
  });

  it('publishes correction_captured on governance-events-{env} with attributes', async () => {
    process.env.ENVIRONMENT = 'test';
    const fake = makeFakePublisher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __resetPublisherForTests(fake as any);

    await publishCorrectionCaptured({
      tenantId: 'tenant-9',
      agentId: 'agent-1',
      actionId: null,
      correctionType: 'rejected',
      correctionPayload: {
        pendingToolCalls: [],
        rejectionReason: 'nope',
        approvalId: 'appr-1',
      },
    });

    expect(fake.publish).toHaveBeenCalledTimes(1);
    const [topic, envelope, options] = fake.publish.mock.calls[0];
    expect(topic).toBe('governance-events-test');
    expect(envelope).toEqual(
      expect.objectContaining({
        eventType: GOVERNANCE_EVENT_TYPES.CORRECTION_CAPTURED,
        occurredAt: expect.any(String),
        payload: expect.objectContaining({
          tenantId: 'tenant-9',
          agentId: 'agent-1',
          correctionType: 'rejected',
        }),
      }),
    );
    expect((options as { attributes: Record<string, string> }).attributes).toEqual(
      expect.objectContaining({
        eventType: GOVERNANCE_EVENT_TYPES.CORRECTION_CAPTURED,
        tenantId: 'tenant-9',
      }),
    );
  });

  it('publishes late_feedback_flagged with correct event type', async () => {
    const fake = makeFakePublisher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __resetPublisherForTests(fake as any);

    await publishLateFeedbackFlagged({
      tenantId: 'tenant-9',
      agentId: 'agent-1',
      feedbackId: 'fb-1',
      approvalId: 'appr-1',
      decision: 'rejected',
      rejectionReason: 'stale',
    });

    const [, envelope, options] = fake.publish.mock.calls[0];
    expect((envelope as { eventType: string }).eventType).toBe(
      GOVERNANCE_EVENT_TYPES.LATE_FEEDBACK_FLAGGED,
    );
    expect((options as { attributes: Record<string, string> }).attributes.eventType).toBe(
      GOVERNANCE_EVENT_TYPES.LATE_FEEDBACK_FLAGGED,
    );
  });

  it('publishes action_compensated with correct event type', async () => {
    const fake = makeFakePublisher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __resetPublisherForTests(fake as any);

    await publishActionCompensated({
      tenantId: 'tenant-9',
      agentId: 'agent-1',
      actionId: 'act-1',
    });

    const [, envelope] = fake.publish.mock.calls[0];
    expect((envelope as { eventType: string }).eventType).toBe(
      GOVERNANCE_EVENT_TYPES.ACTION_COMPENSATED,
    );
  });

  it('never throws when the underlying publisher rejects', async () => {
    const fake = {
      publish: jest.fn().mockRejectedValue(new Error('pubsub down')),
      publishBatch: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __resetPublisherForTests(fake as any);

    await expect(
      publishActionCompensated({
        tenantId: 'tenant-9',
        agentId: 'agent-1',
        actionId: 'act-1',
      }),
    ).resolves.toBeUndefined();
  });
});
