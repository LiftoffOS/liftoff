// Daily Cloud Scheduler job that reminds a recipient ~48h before their pending
// invitation expires — once. Claim-first (mint reminder token + stamp
// reminded_at) then send, so a re-run does not double-remind and the original
// invitation link stays valid.

import express from 'express';
import request from 'supertest';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const findRemindableInvitations = jest.fn();
const mintReminderToken = jest.fn();
jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: { findRemindableInvitations, mintReminderToken },
}));

const sendInviteReminderEmail = jest.fn().mockResolvedValue('email-id');
jest.mock('../../infrastructure/email', () => ({ sendInviteReminderEmail }));

import { inviteReminderSweepRouter } from '../invite-reminder-sweep';

const SERVICE_TOKEN = 'test-platform-callback-token-32c';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', inviteReminderSweepRouter);
  return app;
}

function call(app: ReturnType<typeof buildApp>, header?: string) {
  const req = request(app).post('/api/internal/invite-reminder-sweep');
  if (header) req.set('X-Service-Auth', header);
  return req.send({});
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    recipientEmail: 'ellyn.fitzgerald@northwind.com',
    tenantId: 't1',
    tenantName: 'Northwind',
    inviterFirstName: 'Paul',
    inviterLastName: 'Drummond',
    inviterEmail: 'paul.drummond@northwind.com',
    expiresAt: new Date('2026-09-01T21:28:00Z'),
    inviterTimezone: 'Europe/London',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sendInviteReminderEmail.mockResolvedValue('email-id');
  process.env.PLATFORM_CALLBACK_TOKEN = SERVICE_TOKEN;
});

describe('POST /invite-reminder-sweep', () => {
  it('401 without X-Service-Auth', async () => {
    const res = await call(buildApp());
    expect(res.status).toBe(401);
    expect(findRemindableInvitations).not.toHaveBeenCalled();
  });

  it('401 with wrong X-Service-Auth value', async () => {
    const res = await call(buildApp(), 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('no invitations to remind → 200 zero counts, no mint, no email', async () => {
    findRemindableInvitations.mockResolvedValue([]);
    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ candidates: 0, sent: 0, skipped: 0, failed: 0 });
    expect(mintReminderToken).not.toHaveBeenCalled();
    expect(sendInviteReminderEmail).not.toHaveBeenCalled();
  });

  it('claims a token then sends the reminder with that token in the accept link', async () => {
    findRemindableInvitations.mockResolvedValue([candidate()]);
    mintReminderToken.mockResolvedValue('tok_reminder_abc');

    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ candidates: 1, sent: 1, skipped: 0, failed: 0 });

    // Claimed BEFORE sending.
    expect(mintReminderToken).toHaveBeenCalledWith('inv-1');
    expect(sendInviteReminderEmail).toHaveBeenCalledTimes(1);
    const [to, params] = sendInviteReminderEmail.mock.calls[0];
    expect(to).toBe('ellyn.fitzgerald@northwind.com');
    expect(params.tenantName).toBe('Northwind');
    expect(params.inviterFirstName).toBe('Paul');
    expect(params.inviterLastName).toBe('Drummond');
    expect(params.inviteUrl).toContain('/invitation/tok_reminder_abc');
    // Expiry + inviter zone flow through so the sender can render a concrete date;
    // inviter email flows through for the reply-to.
    expect(params.expiresAt).toEqual(new Date('2026-09-01T21:28:00Z'));
    expect(params.inviterTimezone).toBe('Europe/London');
    expect(params.inviterEmail).toBe('paul.drummond@northwind.com');
  });

  it('skips an invitation another run already reminded (mint returns null)', async () => {
    findRemindableInvitations.mockResolvedValue([candidate()]);
    mintReminderToken.mockResolvedValue(null);

    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ candidates: 1, sent: 0, skipped: 1, failed: 0 });
    expect(sendInviteReminderEmail).not.toHaveBeenCalled();
  });

  it('counts a send failure without throwing (already claimed, original link intact)', async () => {
    findRemindableInvitations.mockResolvedValue([candidate()]);
    mintReminderToken.mockResolvedValue('tok_reminder_abc');
    sendInviteReminderEmail.mockRejectedValueOnce(new Error('resend down'));

    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ candidates: 1, sent: 0, skipped: 0, failed: 1 });
  });
});
