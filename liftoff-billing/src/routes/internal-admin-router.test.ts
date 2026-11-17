// POST /api/internal/provision-subscription — error classification.
//
// platform-backend calls this from TenantService.activate() at signup, while the
// fused-onboarding wizard does not collect payment until step 7. Stripe
// therefore rejects every self-serve signup with resource_missing "This customer
// has no attached payment source or default payment method". Forwarded as a raw
// 400 it is indistinguishable from a transient fault, so the caller's
// provisioning outbox retried it for ~2 days before giving up.
//
// The boundary tested here is the whole point: "no card yet" must answer 402 so
// the caller can defer, and everything else must keep failing loudly so it
// keeps being retried.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import { createHmac } from 'node:crypto';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const mockProvisionForTenant = mockFn();
jest.mock('./provision.js', () => ({
  provisionForTenant: (...args: unknown[]) => mockProvisionForTenant(...args),
}));

jest.mock('../infrastructure/database.js', () => ({
  withBillingTenant: async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn({ query: mockFn() }),
}));

import { registerInternalAdminRouter } from './internal-admin-router';
import type { PlatformBackendClient } from '../infrastructure/platform-backend-client.js';

const TOKEN = 'test-billing-token';
const PATH = '/api/internal/provision-subscription';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = 'cus_no_pm';

function sign(body: object): Record<string, string> {
  const timestamp = String(Date.now());
  const bodyStr = JSON.stringify(body ?? {});
  const signature = createHmac('sha256', TOKEN)
    .update(`POST\n${PATH}\n${timestamp}\n${bodyStr}`)
    .digest('hex');
  return { 'x-billing-timestamp': timestamp, 'x-billing-signature': signature };
}

/** Shape Stripe actually raises when the customer has no payment method. */
function missingPaymentMethodError(): Stripe.errors.StripeError {
  return {
    type: 'StripeInvalidRequestError',
    code: 'resource_missing',
    message:
      'This customer has no attached payment source or default payment method. Please consider adding a default payment method.',
  } as Stripe.errors.StripeError;
}

describe('POST /api/internal/provision-subscription', () => {
  let app: FastifyInstance;
  const mockSubscriptionActivated = mockFn().mockResolvedValue(undefined);

  beforeEach(async () => {
    mockProvisionForTenant.mockReset();
    mockSubscriptionActivated.mockClear();
    process.env.STRIPE_PLAN_CORE_MONTHLY_PRICE_ID = 'price_core_monthly';

    app = Fastify();
    registerInternalAdminRouter(app, {
      stripe: {} as Stripe,
      pool: {} as Pool,
      billingServiceToken: TOKEN,
      ouPriceId: 'price_ou',
      pbClient: { subscriptionActivated: mockSubscriptionActivated } as unknown as PlatformBackendClient,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function post(): Promise<{ statusCode: number; body: string }> {
    const body = { tenantId: TENANT_ID, stripeCustomerId: CUSTOMER };
    const res = await app.inject({ method: 'POST', url: PATH, headers: sign(body), payload: body });
    return { statusCode: res.statusCode, body: res.body };
  }

  it('returns 200 with alreadyExists on the happy path', async () => {
    mockProvisionForTenant.mockResolvedValue({ alreadyExists: false, stripeSubscriptionId: 'sub_1' });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ alreadyExists: false, stripeSubscriptionId: 'sub_1' });
  });

  it('returns 402 no_payment_method when the customer has no card', async () => {
    mockProvisionForTenant.mockRejectedValue(missingPaymentMethodError());
    const res = await post();
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body)).toEqual({ error: 'no_payment_method' });
  });

  // A 402 means "provisioned nothing", so billing_controls must not be told a
  // plan went active. Getting this wrong would leave platform-backend showing a
  // Core plan for a tenant with no subscription.
  it('does not notify platform-backend when it defers', async () => {
    mockProvisionForTenant.mockRejectedValue(missingPaymentMethodError());
    await post();
    expect(mockSubscriptionActivated).not.toHaveBeenCalled();
  });

  // resource_missing is Stripe's code for ANY absent object. Deferring on the
  // code alone would silently stop retrying a genuinely broken price.
  it('does NOT defer a resource_missing that is not about a payment method', async () => {
    mockProvisionForTenant.mockRejectedValue({
      type: 'StripeInvalidRequestError',
      code: 'resource_missing',
      message: 'No such price: price_deadbeef',
    } as Stripe.errors.StripeError);
    const res = await post();
    expect(res.statusCode).not.toBe(402);
  });

  it('does NOT defer an unrelated Stripe failure', async () => {
    mockProvisionForTenant.mockRejectedValue({
      type: 'StripeAPIError',
      code: 'api_error',
      message: 'Stripe is down',
    } as Stripe.errors.StripeError);
    const res = await post();
    expect(res.statusCode).not.toBe(402);
  });

  // The comped-account path: provision-test-account attaches a 100%-off coupon
  // and no card, the invoice draws to $0, and Stripe accepts the create. This is
  // why the discriminator is the error rather than a listPaymentMethods
  // pre-check, which would have broken exactly this case.
  it('still provisions a customer with no card when the invoice is $0', async () => {
    mockProvisionForTenant.mockResolvedValue({ alreadyExists: false, stripeSubscriptionId: 'sub_comped' });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(mockSubscriptionActivated).toHaveBeenCalled();
  });
});
