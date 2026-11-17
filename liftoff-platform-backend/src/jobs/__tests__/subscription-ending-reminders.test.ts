// Daily Cloud Scheduler job that finds accounts whose plan ends in 7 days
// or 1 day and fires the corresponding email. Dedupe via INSERT ... ON
// CONFLICT into subscription_ending_reminders_sent so re-invocation in the
// same day is a no-op.

import express from 'express';
import request from 'supertest';

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const sendSubscriptionEnding7dEmail = jest.fn().mockResolvedValue('email-7d');
const sendSubscriptionEnding1dEmail = jest.fn().mockResolvedValue('email-1d');

jest.mock('../../infrastructure/email', () => ({
  sendSubscriptionEnding7dEmail,
  sendSubscriptionEnding1dEmail,
}));

import { getPool } from '../../infrastructure/database';
import { subscriptionEndingRemindersRouter } from '../subscription-ending-reminders';

const SERVICE_TOKEN = 'test-platform-callback-token-32c';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', subscriptionEndingRemindersRouter);
  return app;
}

function call(app: ReturnType<typeof buildApp>, header?: string) {
  const req = request(app).post('/api/internal/subscription-ending-reminders');
  if (header) req.set('X-Service-Auth', header);
  return req.send({});
}

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    email: 'ada@example.com', first_name: 'Ada',
    plan_type: 'core', billing_tier: 'standard',
    plan_included_ous: 800, is_annual_plan: false,
    self_serve_display_name: 'Core', self_serve_price_cents: 2000,
    enterprise_annual_cents: null, enterprise_included_ous: null,
    enterprise_included_rate: null, enterprise_precommit_ous: null,
    enterprise_precommit_rate: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_CALLBACK_TOKEN = SERVICE_TOKEN;
});

describe('POST /subscription-ending-reminders', () => {
  it('401 without X-Service-Auth', async () => {
    const res = await call(buildApp());
    expect(res.status).toBe(401);
  });

  it('401 with wrong X-Service-Auth value', async () => {
    const res = await call(buildApp(), 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('no accounts to remind → 200 with zero counts', async () => {
    let i = 0;
    const responses: Array<{ rows: unknown[]; rowCount?: number }> = [
      { rows: [], rowCount: 0 },                                    // SELECT due reminders
    ];
    (getPool as jest.Mock).mockReturnValue({
      query: jest.fn().mockImplementation(() => Promise.resolve(responses[i++] ?? { rows: [], rowCount: 0 })),
    });

    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ processed: 0, sent: 0, skipped: 0, failed: 0 });
    expect(sendSubscriptionEnding7dEmail).not.toHaveBeenCalled();
    expect(sendSubscriptionEnding1dEmail).not.toHaveBeenCalled();
  });

  it('7-day and 1-day reminders fire with correct send fn + plan name', async () => {
    let i = 0;
    const accessEnds7d = new Date('2026-05-22T00:00:00.000Z');
    const accessEnds1d = new Date('2026-05-16T00:00:00.000Z');
    const responses: Array<{ rows: unknown[]; rowCount?: number }> = [
      { rows: [
        { account_id: 'acct-7d', access_ends_at: accessEnds7d, days_until: 7 },
        { account_id: 'acct-1d', access_ends_at: accessEnds1d, days_until: 1 },
      ] },
      { rows: [{ account_id: 'acct-7d' }], rowCount: 1 },          // INSERT dedupe 7d (won)
      { rows: [planRow({ self_serve_display_name: 'Growth' })] },  // JOIN for acct-7d
      { rows: [{ account_id: 'acct-1d' }], rowCount: 1 },          // INSERT dedupe 1d (won)
      { rows: [planRow({ self_serve_display_name: 'Scale' })] },   // JOIN for acct-1d
    ];
    (getPool as jest.Mock).mockReturnValue({
      query: jest.fn().mockImplementation(() => Promise.resolve(responses[i++] ?? { rows: [], rowCount: 0 })),
    });

    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ processed: 2, sent: 2, skipped: 0, failed: 0 });

    expect(sendSubscriptionEnding7dEmail).toHaveBeenCalledTimes(1);
    expect(sendSubscriptionEnding7dEmail.mock.calls[0][2]).toMatchObject({
      planName: 'Growth',
      accessEndsDate: accessEnds7d,
    });

    expect(sendSubscriptionEnding1dEmail).toHaveBeenCalledTimes(1);
    expect(sendSubscriptionEnding1dEmail.mock.calls[0][2]).toMatchObject({
      planName: 'Scale',
      accessEndsDate: accessEnds1d,
    });
  });

  it('skips accounts that already have a dedupe row for today (rowCount=0)', async () => {
    let i = 0;
    const responses: Array<{ rows: unknown[]; rowCount?: number }> = [
      { rows: [
        { account_id: 'acct-7d', access_ends_at: new Date(), days_until: 7 },
      ] },
      { rows: [], rowCount: 0 },                                   // INSERT dedupe — ON CONFLICT DO NOTHING
    ];
    (getPool as jest.Mock).mockReturnValue({
      query: jest.fn().mockImplementation(() => Promise.resolve(responses[i++] ?? { rows: [], rowCount: 0 })),
    });

    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ processed: 1, sent: 0, skipped: 1, failed: 0 });
    expect(sendSubscriptionEnding7dEmail).not.toHaveBeenCalled();
  });

  it('counts send failures without rolling back the dedupe row', async () => {
    let i = 0;
    const responses: Array<{ rows: unknown[]; rowCount?: number }> = [
      { rows: [
        { account_id: 'acct-7d', access_ends_at: new Date(), days_until: 7 },
      ] },
      { rows: [{ account_id: 'acct-7d' }], rowCount: 1 },          // INSERT dedupe won
      { rows: [planRow()] },                                       // JOIN ok
    ];
    (getPool as jest.Mock).mockReturnValue({
      query: jest.fn().mockImplementation(() => Promise.resolve(responses[i++] ?? { rows: [], rowCount: 0 })),
    });
    sendSubscriptionEnding7dEmail.mockRejectedValueOnce(new Error('resend down'));

    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ processed: 1, sent: 0, skipped: 0, failed: 1 });
  });
});
