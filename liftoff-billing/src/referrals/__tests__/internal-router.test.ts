// The platform-backend → liftoff-billing seam, and the daily job.
//
// Two auth schemes sit side by side here on purpose and neither is optional:
// the read and enforcement routes are HMAC-signed by platform-backend, while
// the scheduled job carries a plain service token because Cloud Scheduler
// cannot sign a body. Mixing them up would either lock platform-backend out or
// leave a cross-tenant credit sweep reachable by anything that can hit the URL.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerReferralsInternalRouter } from '../internal-router.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fn = (impl?: any): any => (jest.fn as any)(impl);
/* eslint-enable @typescript-eslint/no-explicit-any */

const TOKEN = 'test-billing-service-token-32chars';
const TENANT = '11111111-1111-4111-8111-111111111111';
const REFERRAL = '55555555-5555-4555-8555-555555555555';

function makeService() {
  return {
    summary: fn(async () => ({
      creditEarnedUsd: 40,
      creditAppliedUsd: 20,
      creditAvailableUsd: 20,
      convertedCount: 2,
      subscriptionActive: true,
    })),
    creditsByReferral: fn(async () => [
      { referralId: REFERRAL, amountUsd: 20, status: 'granted', availableAt: null, expiresAt: null },
    ]),
    disqualifyReferral: fn(async () => ({ reversed: 1, absorbed: 0, found: true })),
    forfeitForTermsViolation: fn(async () => ({ forfeited: 2 })),
    runVesting: fn(async () => ({ vested: 3 })),
    runExpiry: fn(async () => ({ expired: 1 })),
  };
}

async function buildApp(service: ReturnType<typeof makeService>): Promise<FastifyInstance> {
  const app = Fastify();
  registerReferralsInternalRouter(app, {
    service: service as never,
    billingServiceToken: TOKEN,
    log: { info: fn(), error: fn() },
  });
  await app.ready();
  return app;
}

/** Signs exactly as platform-backend's BillingAdminClient does. */
function signed(path: string, body: object) {
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', TOKEN)
    .update(`POST\n${path}\n${timestamp}\n${JSON.stringify(body)}`)
    .digest('hex');
  return {
    'X-Billing-Timestamp': timestamp,
    'X-Billing-Signature': signature,
    'Content-Type': 'application/json',
  };
}

let service: ReturnType<typeof makeService>;
let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  service = makeService();
  app = await buildApp(service);
});

describe('the HMAC gate', () => {
  it('refuses an unsigned read', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/referrals/summary',
      payload: { tenantId: TENANT },
    });

    expect(res.statusCode).toBe(401);
    expect(service.summary).not.toHaveBeenCalled();
  });

  it('refuses a signature over a different body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/referrals/summary',
      headers: signed('/api/internal/referrals/summary', {}),
      payload: { tenantId: TENANT },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /summary', () => {
  it('serves the money half, subscription flag included', async () => {
    const body = { tenantId: TENANT };
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/referrals/summary',
      headers: signed('/api/internal/referrals/summary', body),
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ creditEarnedUsd: 40, subscriptionActive: true });
  });

  it('rejects a call with no workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/referrals/summary',
      headers: signed('/api/internal/referrals/summary', {}),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /credits', () => {
  it('serves the rows behind one page of the list', async () => {
    const body = { tenantId: TENANT, referralIds: [REFERRAL] };
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/referrals/credits',
      headers: signed('/api/internal/referrals/credits', body),
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().credits).toHaveLength(1);
    expect(service.creditsByReferral).toHaveBeenCalledWith(TENANT, [REFERRAL]);
  });
});

describe('enforcement', () => {
  it('disqualifies one referral', async () => {
    const path = `/api/internal/referrals/credits/${REFERRAL}/disqualify`;
    const res = await app.inject({
      method: 'POST', url: path, headers: signed(path, {}), payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reversed: 1, absorbed: 0 });
  });

  it('404s a referral that never earned credit', async () => {
    service.disqualifyReferral.mockResolvedValue({ reversed: 0, absorbed: 0, found: false });
    const path = `/api/internal/referrals/credits/${REFERRAL}/disqualify`;
    const res = await app.inject({
      method: 'POST', url: path, headers: signed(path, {}), payload: {},
    });

    expect(res.statusCode).toBe(404);
  });

  it('forfeits a workspace unspent balance', async () => {
    const path = `/api/internal/referrals/tenants/${TENANT}/forfeit`;
    const res = await app.inject({
      method: 'POST', url: path, headers: signed(path, {}), payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ forfeited: 2 });
  });

  it('refuses either lever unsigned', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/internal/referrals/tenants/${TENANT}/forfeit`,
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(service.forfeitForTermsViolation).not.toHaveBeenCalled();
  });
});

describe('the daily maintenance job', () => {
  it('vests before it expires, and reports both', async () => {
    const order: string[] = [];
    service.runVesting.mockImplementation(async () => {
      order.push('vest');
      return { vested: 3 };
    });
    service.runExpiry.mockImplementation(async () => {
      order.push('expire');
      return { expired: 1 };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/jobs/referral-credit-maintenance',
      headers: { 'X-Service-Auth': TOKEN },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ vested: 3, expired: 1 });
    // Vesting stamps the expiry date. The other order leaves a credit that
    // vests today with an expiry nothing checks for a full day.
    expect(order).toEqual(['vest', 'expire']);
  });

  it('refuses a caller with no service token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/jobs/referral-credit-maintenance',
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(service.runVesting).not.toHaveBeenCalled();
  });

  it('answers 500 so the scheduler retries rather than reporting a clean run', async () => {
    service.runVesting.mockRejectedValue(new Error('database down'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/jobs/referral-credit-maintenance',
      headers: { 'X-Service-Auth': TOKEN },
      payload: {},
    });

    expect(res.statusCode).toBe(500);
  });
});
