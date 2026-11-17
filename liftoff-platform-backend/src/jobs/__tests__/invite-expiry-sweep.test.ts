// Daily Cloud Scheduler job that flips lapsed invitations to 'expired' and emails
// each inviter ONE aggregated notice — several invitees expiring on the same day
// arrive as a single message, not one each.

import express from 'express';
import request from 'supertest';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const collectExpiredInvitationsForNotification = jest.fn();
jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: { collectExpiredInvitationsForNotification },
}));

const sendInvitesExpiredEmail = jest.fn().mockResolvedValue('email-id');
jest.mock('../../infrastructure/email', () => ({ sendInvitesExpiredEmail }));

import { inviteExpirySweepRouter } from '../invite-expiry-sweep';

const SERVICE_TOKEN = 'test-platform-callback-token-32c';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', inviteExpirySweepRouter);
  return app;
}

function call(app: ReturnType<typeof buildApp>, header?: string) {
  const req = request(app).post('/api/internal/invite-expiry-sweep');
  if (header) req.set('X-Service-Auth', header);
  return req.send({});
}

beforeEach(() => {
  jest.clearAllMocks();
  sendInvitesExpiredEmail.mockResolvedValue('email-id');
  process.env.PLATFORM_CALLBACK_TOKEN = SERVICE_TOKEN;
});

describe('POST /invite-expiry-sweep', () => {
  it('401 without X-Service-Auth', async () => {
    const res = await call(buildApp());
    expect(res.status).toBe(401);
    expect(collectExpiredInvitationsForNotification).not.toHaveBeenCalled();
  });

  it('401 with wrong X-Service-Auth value', async () => {
    const res = await call(buildApp(), 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('no expired invitations → 200 with zero counts, no email', async () => {
    collectExpiredInvitationsForNotification.mockResolvedValue([]);
    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: 0, invitations: 0, sent: 0, failed: 0 });
    expect(sendInvitesExpiredEmail).not.toHaveBeenCalled();
  });

  it('aggregates several invitees for one inviter into a SINGLE email', async () => {
    collectExpiredInvitationsForNotification.mockResolvedValue([
      {
        inviterEmail: 'paul@northwind.com',
        inviterFirstName: 'Paul',
        tenantId: 't1',
        tenantName: 'Northwind',
        invitees: [
          { email: 'ellyn.fitzgerald@northwind.com', invitedAt: new Date('2026-08-25T00:00:00Z') },
          { email: 'richard.lee@northwind.com', invitedAt: new Date('2026-08-26T00:00:00Z') },
        ],
      },
    ]);

    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: 1, invitations: 2, sent: 1, failed: 0 });

    // ONE email, carrying BOTH invitees.
    expect(sendInvitesExpiredEmail).toHaveBeenCalledTimes(1);
    const [to, firstName, params] = sendInvitesExpiredEmail.mock.calls[0];
    expect(to).toBe('paul@northwind.com');
    expect(firstName).toBe('Paul');
    expect(params.tenantName).toBe('Northwind');
    expect(params.inviteUrl).toContain('/dashboard/settings/workspace');
    expect(params.invitees.map((i: { email: string }) => i.email)).toEqual([
      'ellyn.fitzgerald@northwind.com',
      'richard.lee@northwind.com',
    ]);
  });

  it('sends one email per inviter and falls back to "there" for a null first name', async () => {
    collectExpiredInvitationsForNotification.mockResolvedValue([
      { inviterEmail: 'paul@northwind.com', inviterFirstName: 'Paul', tenantId: 't1', tenantName: 'Northwind', invitees: [{ email: 'a@x.com', invitedAt: new Date() }] },
      { inviterEmail: 'zoe@acme.com', inviterFirstName: null, tenantId: 't2', tenantName: 'Acme', invitees: [{ email: 'b@y.com', invitedAt: new Date() }] },
    ]);

    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: 2, invitations: 2, sent: 2, failed: 0 });
    expect(sendInvitesExpiredEmail).toHaveBeenCalledTimes(2);
    expect(sendInvitesExpiredEmail.mock.calls[1][1]).toBe('there');
  });

  it('counts a send failure without throwing (invitations already flipped)', async () => {
    collectExpiredInvitationsForNotification.mockResolvedValue([
      { inviterEmail: 'paul@northwind.com', inviterFirstName: 'Paul', tenantId: 't1', tenantName: 'Northwind', invitees: [{ email: 'a@x.com', invitedAt: new Date() }] },
    ]);
    sendInvitesExpiredEmail.mockRejectedValueOnce(new Error('resend down'));

    const res = await call(buildApp(), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: 1, invitations: 1, sent: 0, failed: 1 });
  });
});
