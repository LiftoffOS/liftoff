// BillingAdminClient — provision-subscription error classification.
//
// The one behaviour that matters here: separating "this customer has no card
// yet, which is normal at signup and no retry can fix" from "provisioning
// genuinely failed and should be retried". Getting that boundary wrong in
// either direction is expensive — too narrow and every signup burns the outbox
// retry budget for two days, too broad and a real Stripe outage is silently
// swallowed as deferred and never retried.

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn(async () => ({})),
}));

import { BillingAdminClient, NoPaymentMethodError } from './billing-admin-client';

function respond(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

describe('BillingAdminClient.provisionSubscription', () => {
  const client = new BillingAdminClient('https://billing.example.com', 'test-token');
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns alreadyExists on success', async () => {
    fetchSpy.mockResolvedValueOnce(respond(200, JSON.stringify({ alreadyExists: true })));
    await expect(client.provisionSubscription('tenant-1', 'cus_abc')).resolves.toEqual({
      alreadyExists: true,
    });
  });

  // The shape liftoff-billing returns once its own classification ships.
  it('throws NoPaymentMethodError on a typed 402 no_payment_method', async () => {
    fetchSpy.mockResolvedValueOnce(respond(402, JSON.stringify({ error: 'no_payment_method' })));
    await expect(client.provisionSubscription('tenant-1', 'cus_abc')).rejects.toBeInstanceOf(
      NoPaymentMethodError,
    );
  });

  // The raw Stripe rejection billing forwards today. Recognising this shape is
  // what lets platform-backend retire already-queued rows without waiting on a
  // billing deploy, so the two services can ship in either order.
  it('throws NoPaymentMethodError on the legacy Stripe 400 resource_missing body', async () => {
    const body = JSON.stringify({
      statusCode: 400,
      code: 'resource_missing',
      error: 'Bad Request',
      message:
        'This customer has no attached payment source or default payment method. Please consider adding a default payment method.',
    });
    fetchSpy.mockResolvedValueOnce(respond(400, body));
    const err = await client.provisionSubscription('tenant-1', 'cus_abc').catch((e) => e);
    expect(err).toBeInstanceOf(NoPaymentMethodError);
    expect((err as NoPaymentMethodError).tenantId).toBe('tenant-1');
  });

  // Regression guard for the truncation bug this classification could easily
  // have shipped with: the payment-source phrase sits past the first 100
  // characters of the body, so matching against the sliced error message rather
  // than the full body would miss it.
  it('matches the payment-source phrase even when it sits late in the body', async () => {
    const body = JSON.stringify({
      statusCode: 400,
      code: 'resource_missing',
      error: 'Bad Request',
      requestId: 'req_'.padEnd(120, 'x'),
      message: 'This customer has no attached payment source or default payment method.',
    });
    expect(body.indexOf('no attached payment source')).toBeGreaterThan(100);
    fetchSpy.mockResolvedValueOnce(respond(400, body));
    await expect(client.provisionSubscription('tenant-1', 'cus_abc')).rejects.toBeInstanceOf(
      NoPaymentMethodError,
    );
  });

  // resource_missing is Stripe's code for ANY absent object. On its own it must
  // not defer, or a genuinely missing price would stop being retried.
  it('does NOT defer a resource_missing that is not about a payment method', async () => {
    const body = JSON.stringify({
      statusCode: 400,
      code: 'resource_missing',
      message: 'No such price: price_deadbeef',
    });
    fetchSpy.mockResolvedValueOnce(respond(400, body));
    const err = await client.provisionSubscription('tenant-1', 'cus_abc').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoPaymentMethodError);
  });

  it('does NOT defer an unrelated upstream failure', async () => {
    fetchSpy.mockResolvedValueOnce(respond(500, 'upstream exploded'));
    const err = await client.provisionSubscription('tenant-1', 'cus_abc').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoPaymentMethodError);
    expect((err as Error).message).toContain('500');
  });
});
