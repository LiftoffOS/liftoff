// Registering a device and wanting browser delivery are the same act, so the
// subscription endpoints own both.
//
// This exists because they did not. The token write and the preference write
// were separate requests, the preferences schema is .strict() and did not yet
// know notificationDelivery, and the PATCH 400'd while the token write
// succeeded. That left a live token with delivery off — a state the UI cannot
// reach or repair, because the banner hides once permission is granted and the
// token sync deliberately does not touch preferences. Nobody saw an error; the
// only symptom was Settings showing the channel as off.

const upsertSubscriptionByFidMock = jest.fn();
const revokeDeviceForAccountMock = jest.fn();
jest.mock('../repository', () => ({
  upsertSubscriptionByFid: (...a: unknown[]) => upsertSubscriptionByFidMock(...a),
  revokeDeviceForAccount: (...a: unknown[]) => revokeDeviceForAccountMock(...a),
}));

const setPreferenceFieldMock = jest.fn();
const findByFirebaseUidMock = jest.fn();
jest.mock('../../accounts/repository', () => ({
  AccountRepository: class {
    setPreferenceField = setPreferenceFieldMock;
    findByFirebaseUid = findByFirebaseUidMock;
  },
}));

import express from 'express';
import request from 'supertest';
import { pushAuthedRouter } from '../router';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const FID = 'c'.repeat(22);
const ORIGINAL_URL = process.env.FRONTEND_URL;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { user: { uid: string } }).user = { uid: 'firebase-uid' };
    next();
  });
  a.use('/api/push', pushAuthedRouter);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FRONTEND_URL = 'https://example.com';
  findByFirebaseUidMock.mockResolvedValue({ id: ACCOUNT_ID });
  upsertSubscriptionByFidMock.mockResolvedValue({ id: 'sub-1' });
  revokeDeviceForAccountMock.mockResolvedValue(1);
  setPreferenceFieldMock.mockResolvedValue(undefined);
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL_URL;
});

describe('POST /api/push/subscriptions', () => {
  it('registers the device and turns browser delivery on in the same request', async () => {
    const res = await request(app()).post('/api/push/subscriptions').send({ fid: FID });

    expect(res.status).toBe(201);
    expect(upsertSubscriptionByFidMock).toHaveBeenCalledTimes(1);
    expect(setPreferenceFieldMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
      ['notificationDelivery', 'browser'],
      true,
    );
  });

  // A path-targeted write, not the shallow merge in update(): the email
  // sibling must survive.
  it('writes only the browser key, leaving email alone', async () => {
    await request(app()).post('/api/push/subscriptions').send({ fid: FID });
    const [, path] = setPreferenceFieldMock.mock.calls[0];
    expect(path).toEqual(['notificationDelivery', 'browser']);
    expect(path).not.toContain('email');
  });

  it('records no preference when it refuses to register the device', async () => {
    process.env.FRONTEND_URL = 'nonsense';
    const res = await request(app()).post('/api/push/subscriptions').send({ fid: FID });
    expect(res.status).toBe(503);
    expect(setPreferenceFieldMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed body before touching anything', async () => {
    const res = await request(app()).post('/api/push/subscriptions').send({ fid: 'x' });
    expect(res.status).toBe(400);
    expect(upsertSubscriptionByFidMock).not.toHaveBeenCalled();
    expect(setPreferenceFieldMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/push/subscriptions', () => {
  // Symmetric with register. Leaving the preference on would advertise a
  // channel with nothing behind it.
  it('retires the device and turns browser delivery off', async () => {
    const res = await request(app()).delete('/api/push/subscriptions').send({ fid: FID });

    expect(res.status).toBe(204);
    expect(revokeDeviceForAccountMock).toHaveBeenCalledWith(ACCOUNT_ID, FID);
    expect(setPreferenceFieldMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
      ['notificationDelivery', 'browser'],
      false,
    );
  });
});

// Registering by Firebase Installation ID — the only identifier now.

describe('POST /api/push/subscriptions — by FID', () => {
  it('registers the device by FID and turns browser delivery on', async () => {
    const res = await request(app()).post('/api/push/subscriptions').send({ fid: FID });

    expect(res.status).toBe(201);
    expect(upsertSubscriptionByFidMock).toHaveBeenCalledTimes(1);
    expect(upsertSubscriptionByFidMock.mock.calls[0][0]).toMatchObject({
      accountId: ACCOUNT_ID,
      fid: FID,
      origin: 'https://example.com',
    });
    expect(setPreferenceFieldMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
      ['notificationDelivery', 'browser'],
      true,
    );
  });

  it('rejects a body naming no device', async () => {
    const res = await request(app()).post('/api/push/subscriptions').send({});

    expect(res.status).toBe(400);
    expect(upsertSubscriptionByFidMock).not.toHaveBeenCalled();
    expect(upsertSubscriptionByFidMock).not.toHaveBeenCalled();
    expect(setPreferenceFieldMock).not.toHaveBeenCalled();
  });

  // The origin decides which environment may later send to this device. Dev and
  // prod share the Firebase project, so a client-supplied value would let a dev
  // browser register itself as a production target.
  it('never takes the origin from the request', async () => {
    await request(app())
      .post('/api/push/subscriptions')
      .send({ fid: FID, origin: 'https://evil.example' });

    expect(upsertSubscriptionByFidMock.mock.calls[0][0].origin).toBe('https://example.com');
  });
});

describe('DELETE /api/push/subscriptions — by FID', () => {
  it('retires the device named by its FID', async () => {
    const res = await request(app()).delete('/api/push/subscriptions').send({ fid: FID });

    expect(res.status).toBe(204);
    expect(revokeDeviceForAccountMock).toHaveBeenCalledWith(ACCOUNT_ID, FID);
  });

  it('rejects a body naming no device', async () => {
    const res = await request(app()).delete('/api/push/subscriptions').send({});

    expect(res.status).toBe(400);
    expect(revokeDeviceForAccountMock).not.toHaveBeenCalled();
  });
});
