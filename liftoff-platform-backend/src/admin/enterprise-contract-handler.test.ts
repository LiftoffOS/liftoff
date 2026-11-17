// Tests for syncRatesToBillingAndStripe — PR 1 / Gap E.
//
// The function must:
//   - Always run the billing_controls UPDATE (rate continuity).
//   - Skip Stripe-side mutations when the live sub is not active/trialing.
//   - Skip Stripe-side mutations when the sub returns resource_missing.
//   - Apply metadata update + price swap when the sub IS active.
//
// Unit-style mocks per Q4 — no real Postgres, no real Stripe.

const mockSubscriptionsRetrieve = jest.fn();
const mockSubscriptionsUpdate = jest.fn();
const mockPricesCreate = jest.fn();

jest.mock('stripe', () => {
  // Keep real Stripe.errors so `err instanceof Stripe.errors.StripeInvalidRequestError`
  // checks behave correctly.
  const RealStripe = jest.requireActual('stripe');
  const mockInstance = {
    subscriptions: {
      retrieve: mockSubscriptionsRetrieve,
      update: mockSubscriptionsUpdate,
    },
    prices: { create: mockPricesCreate },
  };
  const MockStripe = jest.fn(() => mockInstance) as unknown as {
    (...args: unknown[]): typeof mockInstance;
    errors: typeof RealStripe.errors;
  };
  MockStripe.errors = RealStripe.errors;
  return { __esModule: true, default: MockStripe };
});

const mockPoolQuery = jest.fn();
jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
}));

jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn(async () => 'sk_test_dummy'),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../infrastructure/logging', () => ({ log: mockLog }));

jest.mock('./middleware', () => ({
  logAdminAction: jest.fn(async () => ({
    actionId: 'audit_1',
    action: 'account.enterprise_contract.upsert',
    actor: { accountId: 'admin_1', email: null },
    timestamp: '2026-05-17T00:00:00.000Z',
  })),
}));

import Stripe from 'stripe';
import { syncRatesToBillingAndStripe } from './enterprise-contract-handler';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const SUB_ID = 'sub_test_123';
const CUSTOMER_ID = 'cus_test_456';

const baseRates = {
  includedOus: 1_000_000,
  precommitExtraOus: 0,
  includedRateUsdPerOu: 0.02,
  precommitRateUsdPerOu: 0.02,
  reloadRateUsdPerOu: 0.02,
  stripeBilled: true,
  isAnnualPlan: false,
  annualTotalUsdCents: null,
};

// Helper: program getPool().query to return the billing_controls row that
// syncRates reads after the UPDATE (sub_id + customer_id).
function programBillingControlsLookup(): void {
  // 1st query: the UPDATE on billing_controls (returns no rows; rowCount only).
  mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
  // 2nd query: SELECT stripe_subscription_id, stripe_customer_id ...
  mockPoolQuery.mockResolvedValueOnce({
    rows: [{ stripe_subscription_id: SUB_ID, stripe_customer_id: CUSTOMER_ID }],
  });
}

function makeLiveSub(status: Stripe.Subscription.Status): Stripe.Subscription {
  return {
    id: SUB_ID,
    status,
    customer: CUSTOMER_ID,
    items: {
      data: [
        {
          id: 'si_test_1',
          price: { id: 'price_test_old', unit_amount: 1_000 } as unknown as Stripe.Price,
        } as unknown as Stripe.SubscriptionItem,
      ],
    } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
  } as unknown as Stripe.Subscription;
}

describe('syncRatesToBillingAndStripe — PR 1 inactive-sub guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips Stripe mutations when sub status is canceled', async () => {
    programBillingControlsLookup();
    mockSubscriptionsRetrieve.mockResolvedValueOnce(makeLiveSub('canceled'));

    await syncRatesToBillingAndStripe(ACCOUNT_ID, baseRates);

    expect(mockSubscriptionsRetrieve).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockPricesCreate).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID, subId: SUB_ID, status: 'canceled' }),
      'admin.enterprise_contract.sync_skipped_inactive_sub',
    );
  });

  it('skips Stripe mutations when sub status is incomplete_expired', async () => {
    programBillingControlsLookup();
    mockSubscriptionsRetrieve.mockResolvedValueOnce(makeLiveSub('incomplete_expired'));

    await syncRatesToBillingAndStripe(ACCOUNT_ID, baseRates);

    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockPricesCreate).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'incomplete_expired' }),
      'admin.enterprise_contract.sync_skipped_inactive_sub',
    );
  });

  it('skips Stripe mutations when Stripe returns resource_missing', async () => {
    programBillingControlsLookup();
    // Construct a real StripeInvalidRequestError so the `instanceof` guard passes.
    const err = new Stripe.errors.StripeInvalidRequestError({
      message: 'No such subscription: sub_test_123',
      type: 'invalid_request_error',
      code: 'resource_missing',
    });
    mockSubscriptionsRetrieve.mockRejectedValueOnce(err);

    await expect(syncRatesToBillingAndStripe(ACCOUNT_ID, baseRates)).resolves.toBeUndefined();

    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockPricesCreate).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID, subId: SUB_ID, status: 'resource_missing' }),
      'admin.enterprise_contract.sync_skipped_inactive_sub',
    );
  });

  it('still updates billing_controls rates when sub is canceled (regression)', async () => {
    programBillingControlsLookup();
    mockSubscriptionsRetrieve.mockResolvedValueOnce(makeLiveSub('canceled'));

    await syncRatesToBillingAndStripe(ACCOUNT_ID, baseRates);

    // First mockPoolQuery call is the UPDATE on billing_controls — must fire
    // even though the Stripe sync skipped.
    const updateCall = mockPoolQuery.mock.calls[0];
    expect(updateCall[0]).toMatch(/UPDATE billing_controls SET/);
    expect(updateCall[1]).toEqual([
      ACCOUNT_ID,
      baseRates.includedOus,
      baseRates.precommitExtraOus,
      baseRates.includedRateUsdPerOu,
      baseRates.precommitRateUsdPerOu,
      baseRates.reloadRateUsdPerOu,
      baseRates.isAnnualPlan,
    ]);
  });

  it('applies metadata update + price swap when sub is active (positive control)', async () => {
    programBillingControlsLookup();
    mockSubscriptionsRetrieve.mockResolvedValueOnce(makeLiveSub('active'));
    // The current price is 1_000 cents (from makeLiveSub); the computed
    // expectedFeeCents for baseRates is 1_000_000 * 0.02 * 100 = 2_000_000.
    // So the swap branch will fire.
    mockPricesCreate.mockResolvedValueOnce({ id: 'price_test_new' });
    mockSubscriptionsUpdate.mockResolvedValue({});

    await syncRatesToBillingAndStripe(ACCOUNT_ID, baseRates);

    // First update: metadata.
    expect(mockSubscriptionsUpdate).toHaveBeenNthCalledWith(1, SUB_ID, {
      metadata: {
        stripe_billed: 'true',
        included_ous: String(baseRates.includedOus),
        precommit_extra_ous: '0',
        included_rate_usd_per_ou: String(baseRates.includedRateUsdPerOu),
        precommit_rate_usd_per_ou: String(baseRates.precommitRateUsdPerOu),
        reload_rate_usd_per_ou: String(baseRates.reloadRateUsdPerOu),
        is_annual_plan: 'false',
      },
    });
    // Price swap fired.
    expect(mockPricesCreate).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsUpdate).toHaveBeenNthCalledWith(2, SUB_ID, {
      items: [{ id: 'si_test_1', price: 'price_test_new' }],
      proration_behavior: 'create_prorations',
    });
    expect(mockLog.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'admin.enterprise_contract.sync_skipped_inactive_sub',
    );
  });

  it('also applies updates when sub status is trialing (positive control)', async () => {
    programBillingControlsLookup();
    mockSubscriptionsRetrieve.mockResolvedValueOnce(makeLiveSub('trialing'));
    mockPricesCreate.mockResolvedValueOnce({ id: 'price_test_new' });
    mockSubscriptionsUpdate.mockResolvedValue({});

    await syncRatesToBillingAndStripe(ACCOUNT_ID, baseRates);

    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(SUB_ID, expect.objectContaining({ metadata: expect.any(Object) }));
  });

  it('rethrows non-resource_missing Stripe errors (so callers see real failures)', async () => {
    programBillingControlsLookup();
    const err = new Stripe.errors.StripeAPIError({
      message: 'Stripe down',
      type: 'api_error',
    });
    mockSubscriptionsRetrieve.mockRejectedValueOnce(err);

    await expect(syncRatesToBillingAndStripe(ACCOUNT_ID, baseRates)).rejects.toBe(err);
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });

  it('early-returns before any Stripe call when billing_controls has no subId/customerId', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // UPDATE
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ stripe_subscription_id: null, stripe_customer_id: null }],
    });

    await syncRatesToBillingAndStripe(ACCOUNT_ID, baseRates);

    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });
});
