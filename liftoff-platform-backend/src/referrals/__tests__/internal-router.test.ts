// The liftoff-billing → platform-backend seam.
//
// Two properties matter here and neither is visible from either side's own
// tests. The HMAC must actually gate the routes — this router mounts under
// `/api/internal/`, which the global Firebase auth deliberately skips, so its
// own signature check is the only thing in front of it. And `lookup` must
// answer 200 with null for a workspace nobody referred, because that is the
// ordinary answer for almost every invoice and a 404 would make billing's
// client treat the common case as a failure.

import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';

const lookupForBilling = jest.fn();
const markSubscribed = jest.fn();
const markIneligible = jest.fn();

jest.mock('../service', () => ({
  ReferralService: jest.fn().mockImplementation(() => ({
    lookupForBilling: (...args: unknown[]) => lookupForBilling(...args),
    markSubscribed: (...args: unknown[]) => markSubscribed(...args),
    markIneligible: (...args: unknown[]) => markIneligible(...args),
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { referralsInternalRouter } from '../internal-router';

const TOKEN = 'test-billing-service-token-32chars';
const TENANT = '11111111-1111-4111-8111-111111111111';
const REFERRAL = '55555555-5555-4555-8555-555555555555';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/referrals', referralsInternalRouter);
  return app;
}

/** Signs exactly as liftoff-billing's PlatformBackendClient does. */
function signedPost(path: string, body: object) {
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', TOKEN)
    .update(`POST\n${path}\n${timestamp}\n${JSON.stringify(body)}`)
    .digest('hex');
  return request(buildApp())
    .post(path)
    .set('X-Billing-Timestamp', timestamp)
    .set('X-Billing-Signature', signature)
    .send(body);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BILLING_SERVICE_TOKEN = TOKEN;
});

describe('the HMAC gate', () => {
  it('refuses an unsigned call', async () => {
    const res = await request(buildApp())
      .post('/api/internal/referrals/lookup')
      .send({ tenantId: TENANT });

    expect(res.status).toBe(401);
    expect(lookupForBilling).not.toHaveBeenCalled();
  });

  it('refuses a signature over a different body', async () => {
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', TOKEN)
      .update(`POST\n/api/internal/referrals/lookup\n${timestamp}\n{}`)
      .digest('hex');

    const res = await request(buildApp())
      .post('/api/internal/referrals/lookup')
      .set('X-Billing-Timestamp', timestamp)
      .set('X-Billing-Signature', signature)
      .send({ tenantId: TENANT });

    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed call', async () => {
    lookupForBilling.mockResolvedValue(null);

    const res = await signedPost('/api/internal/referrals/lookup', { tenantId: TENANT });

    expect(res.status).toBe(200);
  });
});

describe('POST /lookup', () => {
  it('answers 200 with null for a workspace nobody referred', async () => {
    lookupForBilling.mockResolvedValue(null);

    const res = await signedPost('/api/internal/referrals/lookup', { tenantId: TENANT });

    // The ordinary answer for almost every invoice. A 404 would make billing's
    // client treat it as a failure.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ referral: null });
  });

  it('returns the referral, both Stripe customers included', async () => {
    lookupForBilling.mockResolvedValue({
      referralId: REFERRAL,
      referrerStripeCustomerId: 'cus_a',
      referredStripeCustomerId: 'cus_b',
    });

    const res = await signedPost('/api/internal/referrals/lookup', { tenantId: TENANT });

    // Both, because the enforceable half of the self-referral rules is a
    // payment-method fingerprint and only billing holds those.
    expect(res.body.referral.referrerStripeCustomerId).toBe('cus_a');
    expect(res.body.referral.referredStripeCustomerId).toBe('cus_b');
  });

  it('rejects a tenant id that is not one', async () => {
    const res = await signedPost('/api/internal/referrals/lookup', { tenantId: 'nope' });

    expect(res.status).toBe(400);
    expect(lookupForBilling).not.toHaveBeenCalled();
  });
});

describe('POST /:referralId/subscribed', () => {
  it('records the conversion', async () => {
    markSubscribed.mockResolvedValue({ subscribedAt: new Date('2026-03-01T00:00:00.000Z') });

    const res = await signedPost(`/api/internal/referrals/${REFERRAL}/subscribed`, {
      subscribedAt: '2026-03-01T00:00:00.000Z',
    });

    expect(res.status).toBe(200);
    expect(markSubscribed).toHaveBeenCalledWith(REFERRAL, new Date('2026-03-01T00:00:00.000Z'));
  });

  it('404s a referral that is not there', async () => {
    markSubscribed.mockResolvedValue(null);

    const res = await signedPost(`/api/internal/referrals/${REFERRAL}/subscribed`, {
      subscribedAt: '2026-03-01T00:00:00.000Z',
    });

    expect(res.status).toBe(404);
  });

  it('400s a malformed referral id instead of letting it reach SQL', async () => {
    const res = await signedPost('/api/internal/referrals/not-a-uuid/subscribed', {
      subscribedAt: '2026-03-01T00:00:00.000Z',
    });

    expect(res.status).toBe(400);
    expect(markSubscribed).not.toHaveBeenCalled();
  });
});

describe('POST /:referralId/ineligible', () => {
  it('records the reason', async () => {
    markIneligible.mockResolvedValue({ ineligibleReason: 'discounted_signup' });

    const res = await signedPost(`/api/internal/referrals/${REFERRAL}/ineligible`, {
      reason: 'discounted_signup',
    });

    expect(res.status).toBe(200);
    expect(res.body.ineligibleReason).toBe('discounted_signup');
  });

  it('refuses a reason the page has no wording for', async () => {
    // The frontend prints these by name, so an unknown one would render as a
    // blank cell where an explanation should be.
    const res = await signedPost(`/api/internal/referrals/${REFERRAL}/ineligible`, {
      reason: 'because_we_felt_like_it',
    });

    expect(res.status).toBe(400);
    expect(markIneligible).not.toHaveBeenCalled();
  });
});
