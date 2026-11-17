// sendPushNotification — the delivery path, and the three ways it can quietly
// stop working.
//
// Every failure mode here is invisible from the browser: the person granted
// permission, the UI says notifications are on, and nothing arrives. So each
// one gets a test rather than a comment.

const sendEachForMulticastMock = jest.fn();
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({ sendEachForMulticast: sendEachForMulticastMock }),
}));

const listLiveDevicesMock = jest.fn();
const revokeSubscriptionsMock = jest.fn();
jest.mock('../repository', () => ({
  listLiveDevices: (...a: unknown[]) => listLiveDevicesMock(...a),
  revokeSubscriptions: (...a: unknown[]) => revokeSubscriptionsMock(...a),
}));

const logInfoMock = jest.fn();
const logWarnMock = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: (...a: unknown[]) => logInfoMock(...a),
    warn: (...a: unknown[]) => logWarnMock(...a),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { sendPushNotification, pushOrigin } from '../service';

const ACCT = '11111111-1111-1111-1111-111111111111';
const MESSAGE = {
  title: 'Atlas',
  body: 'Four contracts expire before December.',
  link: 'https://example.com/notification/abc',
  tag: 'task_update:thread-1',
};

const ORIGINAL_URL = process.env.FRONTEND_URL;

// A registered device, addressed by its FID.
function fidRows(n: number, prefix = 'f') {
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${prefix}${i}`,
    fid: `${prefix}${i}`,
  }));
}

function ok(n: number) {
  return { successCount: n, responses: Array.from({ length: n }, () => ({ success: true })) };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FRONTEND_URL = 'https://example.com';
  revokeSubscriptionsMock.mockResolvedValue(0);
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL_URL;
});

describe('pushOrigin', () => {
  it('scopes sends to this environment', () => {
    process.env.FRONTEND_URL = 'https://dev.example.com';
    expect(pushOrigin()).toBe('https://dev.example.com');
  });

  it('is null when the frontend URL is unusable, which disables push', () => {
    process.env.FRONTEND_URL = 'nonsense';
    expect(pushOrigin()).toBeNull();
  });
});

describe('sendPushNotification', () => {
  it('sends to every live device for this account and origin', async () => {
    listLiveDevicesMock.mockResolvedValue(fidRows(2));
    sendEachForMulticastMock.mockResolvedValue(ok(2));

    expect(await sendPushNotification(ACCT, MESSAGE)).toBe(2);
    expect(listLiveDevicesMock).toHaveBeenCalledWith(ACCT, 'https://example.com');

    const payload = sendEachForMulticastMock.mock.calls[0][0];
    expect(payload.fids).toEqual(['f0', 'f1']);
    // fcmOptions.link is what a click opens; data.link is what the service
    // worker reads so it can focus an open tab instead of opening a second.
    expect(payload.webpush.fcmOptions.link).toBe(MESSAGE.link);
    expect(payload.data.link).toBe(MESSAGE.link);
    expect(payload.webpush.notification.tag).toBe(MESSAGE.tag);
  });

  it('does not call FCM at all for an account with no devices', async () => {
    listLiveDevicesMock.mockResolvedValue([]);
    expect(await sendPushNotification(ACCT, MESSAGE)).toBe(0);
    expect(sendEachForMulticastMock).not.toHaveBeenCalled();
  });

  it('sends nothing when the origin cannot be resolved', async () => {
    process.env.FRONTEND_URL = 'nonsense';
    expect(await sendPushNotification(ACCT, MESSAGE)).toBe(0);
    expect(listLiveDevicesMock).not.toHaveBeenCalled();
  });

  // FCM rejects a batch over 500 outright, so an account that crossed the line
  // would receive nothing at all rather than degrade.
  it('batches beyond the 500-target multicast limit', async () => {
    listLiveDevicesMock.mockResolvedValue(fidRows(1001));
    sendEachForMulticastMock
      .mockResolvedValueOnce(ok(500))
      .mockResolvedValueOnce(ok(500))
      .mockResolvedValueOnce(ok(1));

    expect(await sendPushNotification(ACCT, MESSAGE)).toBe(1001);
    expect(sendEachForMulticastMock).toHaveBeenCalledTimes(3);
    expect(sendEachForMulticastMock.mock.calls[0][0].fids).toHaveLength(500);
    expect(sendEachForMulticastMock.mock.calls[2][0].fids).toHaveLength(1);
  });

  // Unpruned dead tokens are retried on every future send forever.
  it('retires devices FCM reports as no longer registered', async () => {
    listLiveDevicesMock.mockResolvedValue(fidRows(3));
    sendEachForMulticastMock.mockResolvedValue({
      successCount: 1,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/invalid-registration-token' } },
      ],
    });

    expect(await sendPushNotification(ACCT, MESSAGE)).toBe(1);
    // By row id, not by identifier: the two partitions are addressed through
    // different columns, so the row is the only unambiguous handle.
    expect(revokeSubscriptionsMock).toHaveBeenCalledWith(['row-f1', 'row-f2']);
  });

  it('keeps a device whose send failed for a transient reason', async () => {
    listLiveDevicesMock.mockResolvedValue(fidRows(2));
    sendEachForMulticastMock.mockResolvedValue({
      successCount: 1,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/internal-error', message: 'try later' } },
      ],
    });

    expect(await sendPushNotification(ACCT, MESSAGE)).toBe(1);
    expect(revokeSubscriptionsMock).not.toHaveBeenCalled();
  });

  // This is the cross-project 403 shape: the backend service account missing
  // roles/firebasecloudmessaging.admin on the web project. It must not take
  // down the turn that produced the notification.
  it('never throws when FCM rejects the whole call', async () => {
    listLiveDevicesMock.mockResolvedValue(fidRows(1));
    sendEachForMulticastMock.mockRejectedValue(new Error('403 PERMISSION_DENIED'));
    await expect(sendPushNotification(ACCT, MESSAGE)).resolves.toBe(0);
  });
});

// Every outcome of this function has to be distinguishable from the logs: if
// success logs nothing, and the ways it returns 0 log nothing either, nothing is
// observable. When somebody reports that no notification arrived, "we handed it
// to FCM" and "we never called FCM" are the first fork in the diagnosis.
describe('what the logs say afterwards', () => {
  it('records a send that FCM accepted', async () => {
    listLiveDevicesMock.mockResolvedValue(fidRows(2));
    sendEachForMulticastMock.mockResolvedValue(ok(2));

    await sendPushNotification(ACCT, MESSAGE);

    const sent = logInfoMock.mock.calls.find((c) => c[0]?.metric === 'push.sent');
    expect(sent).toBeDefined();
    expect(sent![0]).toMatchObject({ accountId: ACCT, targets: 2, delivered: 2, retired: 0 });
  });

  // The honest count. FCM accepting a message is not a person seeing one, and a
  // log that implied otherwise would send the next investigation the wrong way.
  it('reports what FCM accepted, not what it sent', async () => {
    listLiveDevicesMock.mockResolvedValue(fidRows(3));
    sendEachForMulticastMock.mockResolvedValue({
      successCount: 1,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/internal-error', message: 'boom' } },
      ],
    });

    await sendPushNotification(ACCT, MESSAGE);

    const sent = logInfoMock.mock.calls.find((c) => c[0]?.metric === 'push.sent');
    expect(sent![0]).toMatchObject({ targets: 3, delivered: 1, retired: 1 });
  });

  it('says so when the account has no device to send to', async () => {
    listLiveDevicesMock.mockResolvedValue([]);

    await expect(sendPushNotification(ACCT, MESSAGE)).resolves.toBe(0);

    expect(logInfoMock.mock.calls.some((c) => c[0]?.metric === 'push.no_targets')).toBe(true);
    expect(logInfoMock.mock.calls.some((c) => c[0]?.metric === 'push.sent')).toBe(false);
    expect(sendEachForMulticastMock).not.toHaveBeenCalled();
  });
});

// Cleanup must never cost the count of what was actually delivered.
describe('pruning is cleanup, not the send', () => {
  // enqueueNotification reads the return as `pushedDevices > 0` to decide
  // whether the account had any channel at all. Reporting 0 because CLEANUP
  // failed would record a delivered notification as an undelivered one.
  it('reports what was delivered even when pruning fails', async () => {
    listLiveDevicesMock.mockResolvedValue(fidRows(2));
    sendEachForMulticastMock.mockResolvedValue({
      successCount: 1,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/installation-id-not-registered' } },
      ],
    });
    revokeSubscriptionsMock.mockRejectedValue(new Error('db gone'));

    expect(await sendPushNotification(ACCT, MESSAGE)).toBe(1);
  });
});
