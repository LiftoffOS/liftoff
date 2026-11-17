// The operator half of "Liftoff may investigate and disqualify".
//
// These routes move money somebody earned, on a human's discretion, so the two
// things worth pinning are that the decision is always recorded with a reason
// and an actor, and that neither lever can reach credit that was already spent.
// Absorb is absorb: a disqualification creates no negative balance and no
// re-bill, any more than a chargeback does — which is the whole reason
// automatic clawback was rejected in favour of this.

import express from 'express';
import request from 'supertest';
import { referralsAdminRouter } from '../admin-router';
import { getBillingAdminClient } from '../../billing/billing-admin-client';
import { logAudit } from '../../infrastructure/logging';

const disqualifyReferralCredit = jest.fn();
const forfeitReferralCredit = jest.fn();
const getProgram = jest.fn();
const listReferrals = jest.fn();

jest.mock('../../billing/billing-admin-client');
jest.mock('../service', () => ({
  ReferralService: jest.fn().mockImplementation(() => ({
    getProgram: (...args: unknown[]) => getProgram(...args),
    listReferrals: (...args: unknown[]) => listReferrals(...args),
  })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockClient = getBillingAdminClient as jest.MockedFunction<typeof getBillingAdminClient>;

const REFERRAL = '55555555-5555-4555-8555-555555555555';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: 'admin-1', email: 'ops@example.com' };

/** Stands in for adminAuthMiddleware, which is what sets adminAccount. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { adminAccount?: typeof ADMIN }).adminAccount = ADMIN;
    (req as express.Request).ctx = { requestId: 'test', operation: 'test' };
    next();
  });
  app.use('/api/admin/referrals', referralsAdminRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.mockReturnValue({
    disqualifyReferralCredit,
    forfeitReferralCredit,
  } as unknown as ReturnType<typeof getBillingAdminClient>);
  disqualifyReferralCredit.mockResolvedValue({ reversed: 1, absorbed: 0, found: true });
  forfeitReferralCredit.mockResolvedValue({ forfeited: 2 });
  getProgram.mockResolvedValue({ code: 'northwind-7f3a' });
  listReferrals.mockResolvedValue({ referrals: [], hasMore: false, nextCursor: null });
});

describe('POST /:referralId/disqualify', () => {
  it('reverses the credit and audits the actor and the reason', async () => {
    const res = await request(buildApp())
      .post(`/api/admin/referrals/${REFERRAL}/disqualify`)
      .send({ note: 'circular referral ring, tickets 4471 and 4472' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reversed: 1, absorbed: 0 });
    expect(logAudit).toHaveBeenCalledWith(
      'admin.referral.disqualified',
      expect.anything(),
      expect.objectContaining({
        referralId: REFERRAL,
        adminId: ADMIN.id,
        note: 'circular referral ring, tickets 4471 and 4472',
      }),
    );
  });

  it('reports what was absorbed rather than claiming it was recovered', async () => {
    disqualifyReferralCredit.mockResolvedValue({ reversed: 0, absorbed: 1, found: true });

    const res = await request(buildApp())
      .post(`/api/admin/referrals/${REFERRAL}/disqualify`)
      .send({ note: 'abuse' });

    // An operator told "disqualified" when the $20 was already spent would
    // believe something happened that did not.
    expect(res.body).toEqual({ reversed: 0, absorbed: 1 });
  });

  it('requires a note, because the audit row is the point', async () => {
    const res = await request(buildApp())
      .post(`/api/admin/referrals/${REFERRAL}/disqualify`)
      .send({});

    expect(res.status).toBe(400);
    expect(disqualifyReferralCredit).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('404s a referral that never earned anything', async () => {
    disqualifyReferralCredit.mockResolvedValue({ reversed: 0, absorbed: 0, found: false });

    const res = await request(buildApp())
      .post(`/api/admin/referrals/${REFERRAL}/disqualify`)
      .send({ note: 'abuse' });

    expect(res.status).toBe(404);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('rejects an id that is not one, before it reaches billing', async () => {
    const res = await request(buildApp())
      .post('/api/admin/referrals/not-a-uuid/disqualify')
      .send({ note: 'abuse' });

    expect(res.status).toBe(400);
    expect(disqualifyReferralCredit).not.toHaveBeenCalled();
  });

  it('answers 502 when billing cannot be reached, and audits nothing', async () => {
    disqualifyReferralCredit.mockRejectedValue(new Error('billing down'));

    const res = await request(buildApp())
      .post(`/api/admin/referrals/${REFERRAL}/disqualify`)
      .send({ note: 'abuse' });

    // Nothing moved, so nothing is recorded as having moved.
    expect(res.status).toBe(502);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('POST /tenants/:tenantId/forfeit', () => {
  it('forfeits the unspent balance and audits it', async () => {
    const res = await request(buildApp())
      .post(`/api/admin/referrals/tenants/${TENANT}/forfeit`)
      .send({ note: 'terminated for cause, ticket 5510' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ forfeited: 2 });
    expect(logAudit).toHaveBeenCalledWith(
      'admin.referral.forfeited',
      expect.anything(),
      expect.objectContaining({ tenantId: TENANT, forfeitedCredits: 2, adminId: ADMIN.id }),
    );
  });

  it('requires a note here too', async () => {
    const res = await request(buildApp())
      .post(`/api/admin/referrals/tenants/${TENANT}/forfeit`)
      .send({});

    expect(res.status).toBe(400);
    expect(forfeitReferralCredit).not.toHaveBeenCalled();
  });
});

describe('GET /tenants/:tenantId', () => {
  it('reads the same page the customer sees', async () => {
    const res = await request(buildApp()).get(`/api/admin/referrals/tenants/${TENANT}`);

    expect(res.status).toBe(200);
    expect(res.body.program.code).toBe('northwind-7f3a');
    // An operator acting on different numbers than the customer is looking at
    // is how a support conversation goes wrong.
    expect(getProgram).toHaveBeenCalledWith(TENANT);
    expect(listReferrals).toHaveBeenCalledWith(TENANT, 100, null);
  });
});
