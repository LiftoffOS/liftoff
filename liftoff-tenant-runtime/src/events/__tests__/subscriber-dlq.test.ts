// Behavioural tests for dispatchEvent's catch-block routing (plan §2.3).
// Exercises the real classification logic (DlqRouted ack, EntityBusy nack,
// about-to-DLQ warn, ordinary retry) without booting the full handler graph.
//
// After the streaming-pull → push migration, dispatchEvent throws on failure
// and the push handler translates the exception to an HTTP status. This test
// asserts the exception type + log shape; HTTP translation is covered in
// push-handler.test.ts.

jest.mock('../../infrastructure/database', () => ({
  subscriberPool: { query: jest.fn(async () => ({ rows: [] })) },
  getPoolForService: () => ({ query: jest.fn(async () => ({ rows: [] })) }),
}));

jest.mock('../../infrastructure/logging', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { logger, log: logger };
});

import { dispatchEvent, MAX_DELIVERY_ATTEMPTS, subscriberInternals } from '../subscriber';
import { logger } from '../../infrastructure/logging';
import { DlqRoutedError, EntityBusyError } from '../event-processor';

const loggerMock = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

const sampleEvent = {
  event_id: 'evt-1',
  event_type: 'tenant.internal_agent.created',
  entity_type: 'internal_agent',
  entity_id: 'agent-1',
  tenant_id: 'tenant-1',
  entity_version: 1,
};

describe('dispatchEvent — catch-block routing', () => {
  const originalHandleEvent = subscriberInternals.handleEvent;

  beforeEach(() => {
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
  });

  afterEach(() => {
    subscriberInternals.handleEvent = originalHandleEvent;
  });

  it('on success: resolves and emits no error log', async () => {
    subscriberInternals.handleEvent = jest.fn(async () => { return; });
    await expect(dispatchEvent(sampleEvent, 1, 'sub-x')).resolves.toBeUndefined();
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('on DlqRoutedError: rethrows so the push handler returns 204 (event preserved in DLQ)', async () => {
    subscriberInternals.handleEvent = jest.fn(async () => { throw new DlqRoutedError('evt-1'); });
    await expect(dispatchEvent(sampleEvent, 1, 'sub-x')).rejects.toBeInstanceOf(DlqRoutedError);
  });

  it('on EntityBusyError: logs info-level "deferred" and rethrows; never error', async () => {
    subscriberInternals.handleEvent = jest.fn(async () => { throw new EntityBusyError('evt-1', 'agent-1'); });
    await expect(dispatchEvent(sampleEvent, 2, 'sub-x')).rejects.toBeInstanceOf(EntityBusyError);
    expect(loggerMock.info).toHaveBeenCalledWith(
      'Event deferred (entity busy), nacking for redelivery',
      expect.objectContaining({ subscription: 'sub-x', event_id: 'evt-1', entity_id: 'agent-1' }),
    );
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('on generic failure with deliveryAttempt === MAX-1: logs the "about to be DLQ-routed" error with full event context', async () => {
    subscriberInternals.handleEvent = jest.fn(async () => { throw new Error('boom'); });
    await expect(
      dispatchEvent(sampleEvent, MAX_DELIVERY_ATTEMPTS - 1, 'control-plane-events-prod-coordinator-push'),
    ).rejects.toThrow('boom');
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Event about to be DLQ-routed (last attempt before max_delivery_attempts)',
      expect.objectContaining({
        subscription: 'control-plane-events-prod-coordinator-push',
        attempt: MAX_DELIVERY_ATTEMPTS - 1,
        max_delivery_attempts: MAX_DELIVERY_ATTEMPTS,
        event_id: 'evt-1',
        event_type: 'tenant.internal_agent.created',
        entity_type: 'internal_agent',
        entity_id: 'agent-1',
        tenant_id: 'tenant-1',
        error_message: 'boom',
      }),
    );
  });

  it('on generic failure with deliveryAttempt === MAX (10): still classified as about-to-DLQ', async () => {
    subscriberInternals.handleEvent = jest.fn(async () => { throw new Error('boom'); });
    await expect(
      dispatchEvent(sampleEvent, MAX_DELIVERY_ATTEMPTS, 'sub-x'),
    ).rejects.toThrow('boom');
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('about to be DLQ-routed'),
      expect.anything(),
    );
  });

  it('on generic failure with deliveryAttempt < MAX-1: logs ordinary retry error (no DLQ warning)', async () => {
    subscriberInternals.handleEvent = jest.fn(async () => { throw new Error('transient'); });
    await expect(dispatchEvent(sampleEvent, 3, 'sub-x')).rejects.toThrow('transient');
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Event handling failed, nacking for retry',
      expect.objectContaining({ subscription: 'sub-x', attempt: 3, error_message: 'transient' }),
    );
    expect(loggerMock.error).not.toHaveBeenCalledWith(
      expect.stringContaining('about to be DLQ-routed'),
      expect.anything(),
    );
  });

  it('schema-invalid raw event → writes to dlq_messages, throws DlqRoutedError, never reaches handleEvent', async () => {
    const handleSpy = jest.fn(async () => { return; });
    subscriberInternals.handleEvent = handleSpy;
    await expect(
      dispatchEvent({ /* missing required fields */ }, 1, 'sub-x'),
    ).rejects.toBeInstanceOf(DlqRoutedError);
    expect(handleSpy).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Invalid event schema, routing to DLQ',
      expect.objectContaining({ subscription: 'sub-x' }),
    );
  });
});

describe('MAX_DELIVERY_ATTEMPTS constant', () => {
  // Must match the terraform `max_delivery_attempts = 10` in
  // agent_creation_resilience.tf + pubsub_push.tf. If you change one, change
  // the others.
  it('matches the terraform max_delivery_attempts value (10)', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(10);
  });
});
