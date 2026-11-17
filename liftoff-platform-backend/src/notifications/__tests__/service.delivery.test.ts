// Delivery channels: which types you get is notificationTypes, where they go is
// notificationDelivery. These two axes are independent, and the ways they can
// be wrongly coupled are all silent.

const sendPushMock = jest.fn();
jest.mock('../../push', () => ({
  sendPushNotification: (...a: unknown[]) => sendPushMock(...a),
}));

const insertNotificationMock = jest.fn();
const markDeliveredMock = jest.fn();
const markFailedMock = jest.fn();
jest.mock('../repository', () => ({
  insertNotification: (...a: unknown[]) => insertNotificationMock(...a),
  markDelivered: (...a: unknown[]) => markDeliveredMock(...a),
  markFailed: (...a: unknown[]) => markFailedMock(...a),
}));

const sendRealtimeMock = jest.fn();
jest.mock('../email', () => ({ sendRealtimeNotificationEmail: (...a: unknown[]) => sendRealtimeMock(...a) }));

const findByIdMock = jest.fn();
jest.mock('../../accounts/repository', () => ({
  AccountRepository: class {
    findById = findByIdMock;
  },
}));

import { enqueueNotification } from '../service';

const ACCT = '11111111-1111-1111-1111-111111111111';
const TENANT = '22222222-2222-2222-2222-222222222222';
const ROW_ID = '33333333-3333-3333-3333-333333333333';

function account(preferences: Record<string, unknown>) {
  return { id: ACCT, email: 'a@b.com', deletedAt: null, preferences };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCT,
    tenantId: TENANT,
    type: 'task_update' as const,
    payload: {
      internalAgentName: 'Atlas',
      eventTitle: 'Atlas',
      eventSummary: 'Something happened.',
      eventLink: 'https://example.com/notification/abc',
      threadId: 'thread-1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NOTIFICATION_DELIVERY_ENABLED = 'true';
  insertNotificationMock.mockResolvedValue({ id: ROW_ID, type: 'task_update', payload: {} });
  sendRealtimeMock.mockResolvedValue('msg-1');
  sendPushMock.mockResolvedValue(1);
});

describe('browser delivery', () => {
  // Off unless explicitly on: it cannot work without an OS permission, so
  // defaulting it on would claim a capability the account does not have.
  it('does not push for an account that never turned it on', async () => {
    findByIdMock.mockResolvedValue(account({}));
    const r = await enqueueNotification(input());
    expect(sendPushMock).not.toHaveBeenCalled();
    expect(r.pushedDevices).toBe(0);
  });

  it('pushes once the account asks for it', async () => {
    findByIdMock.mockResolvedValue(account({ notificationDelivery: { browser: true } }));
    const r = await enqueueNotification(input());
    expect(sendPushMock).toHaveBeenCalledTimes(1);
    expect(r.pushedDevices).toBe(1);
  });

  // Cadence is an email concept: the None option reads "Do not send email
  // notifications". Someone on Daily asked for slower mail, not for silence,
  // and a digest of push notifications is meaningless anyway.
  it('is not gated by cadence', async () => {
    findByIdMock.mockResolvedValue(
      account({ notificationDelivery: { browser: true }, notificationFrequency: 'weekly' }),
    );
    const r = await enqueueNotification(input());
    expect(sendPushMock).toHaveBeenCalledTimes(1);
    expect(r.pushedDevices).toBe(1);
  });

  // cadence 'none' returns before anything is inserted, so a push placed after
  // that branch would be stranded entirely for these accounts.
  it('still pushes when the account has switched email off entirely', async () => {
    findByIdMock.mockResolvedValue(
      account({ notificationDelivery: { browser: true }, notificationFrequency: 'none' }),
    );
    const r = await enqueueNotification(input());
    expect(sendPushMock).toHaveBeenCalledTimes(1);
    expect(r.pushedDevices).toBe(1);
    expect(insertNotificationMock).not.toHaveBeenCalled();
  });

  it('still pushes when email delivery is off but browser is on', async () => {
    findByIdMock.mockResolvedValue(
      account({ notificationDelivery: { email: false, browser: true } }),
    );
    const r = await enqueueNotification(input());
    expect(sendPushMock).toHaveBeenCalledTimes(1);
    expect(r.emailed).toBe(false);
    expect(insertNotificationMock).not.toHaveBeenCalled();
  });

  // The type toggles still rule both channels: turning task updates off must
  // not leave push as a back door.
  it('respects the type toggle', async () => {
    findByIdMock.mockResolvedValue(
      account({ notificationDelivery: { browser: true }, notificationTypes: { taskUpdates: false } }),
    );
    const r = await enqueueNotification(input());
    expect(sendPushMock).not.toHaveBeenCalled();
    expect(r.suppressed).toBe('type_off');
  });

  it('is stopped by the kill switch like every other channel', async () => {
    process.env.NOTIFICATION_DELIVERY_ENABLED = 'false';
    findByIdMock.mockResolvedValue(account({ notificationDelivery: { browser: true } }));
    const r = await enqueueNotification(input());
    expect(sendPushMock).not.toHaveBeenCalled();
    expect(r.suppressed).toBe('kill_switch');
  });
});

describe('email delivery', () => {
  it('is on for accounts that predate the field', async () => {
    findByIdMock.mockResolvedValue(account({ notificationFrequency: 'realtime' }));
    const r = await enqueueNotification(input({ type: 'escalation' as const }));
    expect(insertNotificationMock).toHaveBeenCalled();
    expect(r.emailed).toBe(true);
  });

  it('inserts nothing at all when switched off, so no digest picks it up later', async () => {
    findByIdMock.mockResolvedValue(account({ notificationDelivery: { email: false } }));
    const r = await enqueueNotification(input());
    expect(insertNotificationMock).not.toHaveBeenCalled();
    expect(sendRealtimeMock).not.toHaveBeenCalled();
    expect(r.suppressed).toBe('no_channel');
  });
});

describe('the push payload', () => {
  it('carries the opaque link, never a URL with ids in it', async () => {
    findByIdMock.mockResolvedValue(account({ notificationDelivery: { browser: true } }));
    await enqueueNotification(input());
    const msg = sendPushMock.mock.calls[0][1];
    expect(msg.link).toBe('https://example.com/notification/abc');
    expect(msg.link).not.toContain('agentId');
    expect(msg.link).not.toContain('thread=');
  });

  // Collapse key: several replies about one thread replace each other rather
  // than stacking into a pile the reader has to clear.
  it('keys the collapse tag on the thread', async () => {
    findByIdMock.mockResolvedValue(account({ notificationDelivery: { browser: true } }));
    await enqueueNotification(input());
    expect(sendPushMock.mock.calls[0][1].tag).toBe('task_update:thread-1');
  });

  // FCM caps a message at 4KB and eventSummary carries up to 2000 characters of
  // escalation reason.
  it('trims a long body rather than letting the platform cut it', async () => {
    findByIdMock.mockResolvedValue(account({ notificationDelivery: { browser: true } }));
    await enqueueNotification(
      input({ payload: { ...input().payload, eventSummary: 'x'.repeat(2000) } }),
    );
    const body = sendPushMock.mock.calls[0][1].body as string;
    expect(body.length).toBe(240);
    expect(body.endsWith('…')).toBe(true);
  });

  // A notification whose click goes nowhere interrupts and then strands.
  it('sends nothing when there is no link to open', async () => {
    findByIdMock.mockResolvedValue(account({ notificationDelivery: { browser: true } }));
    await enqueueNotification(input({ payload: { internalAgentName: 'Atlas' } }));
    expect(sendPushMock).not.toHaveBeenCalled();
  });

  it('never lets a push failure break the email that follows', async () => {
    findByIdMock.mockResolvedValue(
      account({ notificationDelivery: { browser: true }, notificationFrequency: 'realtime' }),
    );
    sendPushMock.mockRejectedValue(new Error('FCM down'));
    const r = await enqueueNotification(input({ type: 'escalation' as const }));
    expect(r.pushedDevices).toBe(0);
    expect(r.emailed).toBe(true);
  });
});
