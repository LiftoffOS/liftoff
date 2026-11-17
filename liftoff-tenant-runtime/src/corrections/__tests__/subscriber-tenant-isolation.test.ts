// The correction subscriber's tenant guard.
//
// Correction events ride the control plane's shared control-plane-events topic,
// which carries every tenant's events. The handlers act on the tenant named in
// the event rather than on the runtime's own, so a runtime that processed a
// foreign message would execute a compensating tool call against another
// tenant's data. The subscription filter is meant to prevent that; this asserts
// the runtime refuses independently, because a filter is configuration and
// configuration drifts.

import { jest } from '@jest/globals';

type MessageHandler = (message: unknown) => void;

const handlers: Record<string, MessageHandler> = {};
const subscriptionNames: string[] = [];
const topicNames: string[] = [];
const mockSubscription = {
  on: (event: string, handler: MessageHandler) => { handlers[event] = handler; },
};
const mockTopicPublish = jest.fn<() => Promise<string>>().mockResolvedValue('msg-1');

jest.mock('@google-cloud/pubsub', () => ({
  PubSub: class {
    subscription(name: string) { subscriptionNames.push(name); return mockSubscription; }
    topic(name: string) {
      topicNames.push(name);
      return { publishMessage: (...a: unknown[]) => mockTopicPublish(...(a as [])) };
    }
  },
  Message: class {},
}));

/** The subscription's message callback fires the async handler without
 *  awaiting it, so the assertions need the microtask queue drained first. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const mockExecuteCorrection = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.mock('../executor', () => ({
  executeCorrection: (...a: unknown[]) => mockExecuteCorrection(...(a as [])),
}));
jest.mock('../dlq-handler', () => ({
  sendToDeadLetterQueue: jest.fn(),
  reportCorrectionFailure: jest.fn(),
  reportCorrectionTimeout: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// TWO served tenants, not one. A runtime serves every tenant in its database,
// and a guard tested against a single "own" tenant passes while dropping the
// traffic of every other tenant the same runtime is responsible for.
const SERVED_TENANT = '11111111-1111-4111-8111-111111111111';
const ALSO_SERVED_TENANT = '33333333-3333-4333-8333-333333333333';
const FOREIGN_TENANT = '22222222-2222-4222-8222-222222222222';

// The env var is the tenant SLUG and the wire carries the tenant UUID. Keeping
// them different here is the point: a guard that compared against the slug
// would reject every event, and a test using one value for both would pass.
const TENANT_SLUG = 'acme';

// The DATABASE is stubbed; the real registry reads it. Mocking the registry
// itself would replace the decision under test with this file's assumption.
import { servedTenantsPool } from '../../test-utils/served-tenants';

const servedIds: string[] = [SERVED_TENANT, ALSO_SERVED_TENANT];
jest.mock('../../infrastructure/database', () => ({
  getPool: () => servedTenantsPool(servedIds),
}));

import { initCorrectionSubscriber } from '../subscriber';

function messageFor(tenantId: string) {
  return {
    data: Buffer.from(JSON.stringify({
      event_type: 'correction.requested',
      tenant_id: tenantId,
      payload: {
        correctionRequestId: 'cr-1',
        tenantId,
        originalAuditLogId: 'al-1',
        correctionToolName: 'send_email',
        correctionType: 'compensate',
        requiresPreviousState: false,
        reason: 'wrong recipient',
        requestedBy: 'user-1',
        timeout: new Date(Date.now() + 60_000).toISOString(),
        maxRetries: 3,
        retryCount: 0,
      },
    })),
    attributes: { eventType: 'correction.requested', tenantId },
    ack: jest.fn(),
    nack: jest.fn(),
  };
}

beforeEach(() => {
  mockExecuteCorrection.mockClear();
  servedIds.splice(0, servedIds.length, SERVED_TENANT, ALSO_SERVED_TENANT);
  subscriptionNames.length = 0;
  topicNames.length = 0;
  process.env.TENANT_ID = TENANT_SLUG;
});

it('subscribes per tenant rather than per environment', () => {
  // An environment-wide subscription would hand every tenant's corrections to
  // whichever runtime happened to pull the message first. Named by the slug,
  // which is what Terraform names the subscription with.
  initCorrectionSubscriber();

  expect(subscriptionNames).toEqual([`correction-events-${TENANT_SLUG}`]);
});

it('checks the tenant UUID, not the slug in TENANT_ID', async () => {
  // The regression this pins: comparing the event's tenant UUID against the
  // slug rejects everything, which looks exactly like the silent drop the
  // subscriber was built to fix.
  initCorrectionSubscriber();

  const message = messageFor(SERVED_TENANT);
  handlers.message(message);
  await flush();

  expect(mockExecuteCorrection).toHaveBeenCalled();
});

it('accepts EVERY tenant it serves, not just the first one', async () => {
  // The property a single-tenant fixture cannot express. A guard that resolves
  // one id and compares against it accepts the first tenant and silently drops
  // the rest — which on this deployment is fifteen paying workspaces.
  initCorrectionSubscriber();

  const message = messageFor(ALSO_SERVED_TENANT);
  handlers.message(message);
  await flush();

  expect(mockExecuteCorrection).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: ALSO_SERVED_TENANT }),
  );
  expect(message.ack).toHaveBeenCalled();
});

it('drops a correction for a tenant this runtime does not serve', async () => {
  initCorrectionSubscriber();

  const message = messageFor(FOREIGN_TENANT);
  handlers.message(message);
  await flush();

  expect(mockExecuteCorrection).not.toHaveBeenCalled();
  // Acked, not nacked: redelivering a message this runtime must never process
  // would loop it forever.
  expect(message.ack).toHaveBeenCalled();
  expect(message.nack).not.toHaveBeenCalled();
});

it('executes a correction addressed to a tenant it serves', async () => {
  initCorrectionSubscriber();

  const message = messageFor(SERVED_TENANT);
  handlers.message(message);
  await flush();

  expect(mockExecuteCorrection).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: SERVED_TENANT, correctionRequestId: 'cr-1' }),
  );
  expect(message.ack).toHaveBeenCalled();
});

it('does not start without a tenant id', () => {
  delete process.env.TENANT_ID;
  delete handlers.message;

  initCorrectionSubscriber();

  expect(handlers.message).toBeUndefined();
});
