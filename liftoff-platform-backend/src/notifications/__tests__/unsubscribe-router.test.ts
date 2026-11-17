// Plan §7f verification rows:
//   • POST /api/notifications/unsubscribe valid → 200 + correct preference field flipped
//   • POST /api/notifications/unsubscribe invalid token → 400 with {success: false}
//   • POST /api/notifications/unsubscribe-direct?token=... (Gmail one-click) → 200 + {success: true}

// Stub setPreferenceField at the repository level.
const setPreferenceFieldMock = jest.fn().mockResolvedValue(undefined);
const findByFirebaseUidMock = jest.fn().mockResolvedValue(null);
jest.mock('../../accounts/repository', () => ({
  AccountRepository: jest.fn().mockImplementation(() => ({
    setPreferenceField: setPreferenceFieldMock,
    findByFirebaseUid: findByFirebaseUidMock,
  })),
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
  withAdminScope: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { notificationsPublicRouter } from '../router';
import { buildUnsubscribeToken } from '../unsubscribe';

beforeAll(() => {
  process.env.UNSUBSCRIBE_SECRET = 'test-secret';
  process.env.FRONTEND_URL = 'https://app.test.local';
  process.env.BACKEND_URL = 'https://api.test.local';
});

beforeEach(() => {
  setPreferenceFieldMock.mockClear();
});

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsPublicRouter);
  return app;
}

const ACCT_ID = '11111111-2222-3333-4444-555555555555';

describe('POST /api/notifications/unsubscribe', () => {
  it('returns 400 when no token is provided', async () => {
    const res = await request(makeApp()).post('/api/notifications/unsubscribe').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an invalid token', async () => {
    const res = await request(makeApp())
      .post('/api/notifications/unsubscribe')
      .send({ token: 'garbage' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Invalid or expired/);
  });

  it('returns 200 and flips the preference for a valid disable:taskUpdates token', async () => {
    const token = buildUnsubscribeToken(ACCT_ID, 'disable:taskUpdates');
    const res = await request(makeApp())
      .post('/api/notifications/unsubscribe')
      .send({ token });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.friendlyLabel).toBe('task updates');
    expect(setPreferenceFieldMock).toHaveBeenCalledWith(
      ACCT_ID,
      ['notificationTypes', 'taskUpdates'],
      false,
    );
  });

  it('flips top-level newsletter to false for disable:newsletter', async () => {
    const token = buildUnsubscribeToken(ACCT_ID, 'disable:newsletter');
    const res = await request(makeApp())
      .post('/api/notifications/unsubscribe')
      .send({ token });
    expect(res.status).toBe(200);
    expect(setPreferenceFieldMock).toHaveBeenCalledWith(ACCT_ID, ['newsletter'], false);
  });

  it('sets notificationFrequency to "none" for cadence:none', async () => {
    const token = buildUnsubscribeToken(ACCT_ID, 'cadence:none');
    const res = await request(makeApp())
      .post('/api/notifications/unsubscribe')
      .send({ token });
    expect(res.status).toBe(200);
    expect(setPreferenceFieldMock).toHaveBeenCalledWith(
      ACCT_ID,
      ['notificationFrequency'],
      'none',
    );
  });
});

describe('POST /api/notifications/unsubscribe-direct (Gmail one-click)', () => {
  it('returns 200 with a valid token in the query string', async () => {
    const token = buildUnsubscribeToken(ACCT_ID, 'disable:teamActivity');
    const res = await request(makeApp())
      .post('/api/notifications/unsubscribe-direct')
      .query({ token });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(setPreferenceFieldMock).toHaveBeenCalledWith(
      ACCT_ID,
      ['notificationTypes', 'teamActivity'],
      false,
    );
  });

  it('returns 400 when token is missing', async () => {
    const res = await request(makeApp()).post('/api/notifications/unsubscribe-direct');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an invalid token', async () => {
    const res = await request(makeApp())
      .post('/api/notifications/unsubscribe-direct')
      .query({ token: 'bogus.signature' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
