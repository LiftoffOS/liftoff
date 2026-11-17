// Router tests, focused on the boundary rather than the payload.
//
// Two things are worth pinning here. A tenant id in the query string must not
// outrun the membership the middleware verified — this page reports what a
// workspace earned and can send mail on its behalf, so a mismatch is an IDOR.
// And the invite endpoint must answer 402 itself: `canSendInvites` exists so
// the page can render the right control, not so it can decide.

import express from 'express';
import request from 'supertest';
import { referralsRouter } from '../router';
import { InvitesNotPermittedError, NoReferralProgramError } from '../service';

const getProgram = jest.fn();
const listReferrals = jest.fn();
const sendInvites = jest.fn();

jest.mock('../service', () => {
  const actual = jest.requireActual('../service');
  return {
    ...actual,
    ReferralService: jest.fn().mockImplementation(() => ({
      getProgram: (...args: unknown[]) => getProgram(...args),
      listReferrals: (...args: unknown[]) => listReferrals(...args),
      sendInvites: (...args: unknown[]) => sendInvites(...args),
    })),
  };
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** Stands in for tenantAuthMiddleware, the only thing that may set this. */
function withVerifiedTenant(tenantId: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request).ctx = { requestId: 'test', tenantId, operation: 'test' };
    next();
  });
  app.use('/api/referrals', referralsRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  getProgram.mockResolvedValue({ code: 'northwind-7f3a' });
  listReferrals.mockResolvedValue({ referrals: [], hasMore: false, nextCursor: null });
  sendInvites.mockResolvedValue({ sent: 1, rejected: [] });
});

describe('GET /api/referrals/program', () => {
  it('serves the programme when the verified tenant matches the query', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .get('/api/referrals/program')
      .query({ tenantId: TENANT });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe('northwind-7f3a');
  });

  it('refuses a tenant the middleware did not verify', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .get('/api/referrals/program')
      .query({ tenantId: OTHER });

    expect(res.status).toBe(403);
    expect(getProgram).not.toHaveBeenCalled();
  });

  it('refuses when no tenant was verified at all', async () => {
    const res = await request(withVerifiedTenant(undefined))
      .get('/api/referrals/program')
      .query({ tenantId: TENANT });

    expect(res.status).toBe(403);
  });

  it('404s a workspace with no programme, which the page treats as terminal', async () => {
    getProgram.mockRejectedValue(new NoReferralProgramError(TENANT));

    const res = await request(withVerifiedTenant(TENANT))
      .get('/api/referrals/program')
      .query({ tenantId: TENANT });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/referrals', () => {
  it('defaults to the page size the frontend asks for', async () => {
    await request(withVerifiedTenant(TENANT)).get('/api/referrals').query({ tenantId: TENANT });

    expect(listReferrals).toHaveBeenCalledWith(TENANT, 50, null);
  });

  it('passes the cursor through', async () => {
    await request(withVerifiedTenant(TENANT))
      .get('/api/referrals')
      .query({ tenantId: TENANT, limit: 10, cursor: 'abc' });

    expect(listReferrals).toHaveBeenCalledWith(TENANT, 10, 'abc');
  });

  it('caps the page size rather than accepting an unbounded read', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .get('/api/referrals')
      .query({ tenantId: TENANT, limit: 100000 });

    expect(res.status).toBe(400);
  });

  it('refuses a tenant the middleware did not verify', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .get('/api/referrals')
      .query({ tenantId: OTHER });

    expect(res.status).toBe(403);
    expect(listReferrals).not.toHaveBeenCalled();
  });
});

describe('POST /api/referrals/invites', () => {
  it('sends for a permitted workspace', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .post('/api/referrals/invites')
      .query({ tenantId: TENANT })
      .send({ emails: ['jordan@example.com'], message: 'a note' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 1, rejected: [] });
  });

  it('answers 402 when the service refuses, for either cause', async () => {
    sendInvites.mockRejectedValue(new InvitesNotPermittedError('no_subscription'));

    const res = await request(withVerifiedTenant(TENANT))
      .post('/api/referrals/invites')
      .query({ tenantId: TENANT })
      .send({ emails: ['jordan@example.com'] });

    expect(res.status).toBe(402);
  });

  it('refuses a tenant the middleware did not verify, before any mail moves', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .post('/api/referrals/invites')
      .query({ tenantId: OTHER })
      .send({ emails: ['jordan@example.com'] });

    expect(res.status).toBe(403);
    expect(sendInvites).not.toHaveBeenCalled();
  });

  it('rejects an over-long note rather than truncating it silently', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .post('/api/referrals/invites')
      .query({ tenantId: TENANT })
      .send({ emails: ['jordan@example.com'], message: 'x'.repeat(501) });

    expect(res.status).toBe(400);
  });

  it('rejects an empty address list', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .post('/api/referrals/invites')
      .query({ tenantId: TENANT })
      .send({ emails: [] });

    expect(res.status).toBe(400);
  });
});
