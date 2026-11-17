// The daily stale-signup sweep.
//
// A scheduled endpoint that mutates rows across every tenant, so the gate in
// front of it is the thing worth testing first: it is mounted under
// /api/internal/, which the global Firebase auth deliberately skips, leaving
// the shared X-Service-Auth token as the only thing between Cloud Scheduler and
// a cross-tenant UPDATE.

import express from 'express';
import request from 'supertest';
import { referralSignupExpiryRouter } from '../referral-signup-expiry';

const expireStaleSignups = jest.fn();

jest.mock('../../referrals/service', () => ({
  ReferralService: jest.fn().mockImplementation(() => ({
    expireStaleSignups: (...args: unknown[]) => expireStaleSignups(...args),
  })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TOKEN = 'test-platform-callback-token-32ch';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', referralSignupExpiryRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  expireStaleSignups.mockResolvedValue({ expired: 4 });
});

describe('POST /api/internal/jobs/referral-signup-expiry', () => {
  it('sweeps and reports the count', async () => {
    const res = await request(buildApp())
      .post('/api/internal/jobs/referral-signup-expiry')
      .set('X-Service-Auth', TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ expired: 4 });
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(buildApp())
      .post('/api/internal/jobs/referral-signup-expiry')
      .send({});

    expect(res.status).toBe(401);
    expect(expireStaleSignups).not.toHaveBeenCalled();
  });

  it('refuses a wrong token', async () => {
    const res = await request(buildApp())
      .post('/api/internal/jobs/referral-signup-expiry')
      .set('X-Service-Auth', 'not-the-token-but-same-lengthhh')
      .send({});

    expect(res.status).toBe(401);
    expect(expireStaleSignups).not.toHaveBeenCalled();
  });

  it('answers 500 so the scheduler retries rather than reporting a clean run', async () => {
    expireStaleSignups.mockRejectedValue(new Error('database down'));

    const res = await request(buildApp())
      .post('/api/internal/jobs/referral-signup-expiry')
      .set('X-Service-Auth', TOKEN)
      .send({});

    expect(res.status).toBe(500);
  });
});
