// The three provisioning-time decisions, asserted BOTH ways.
//
// These are the decisions that made the product undeployable by anybody else:
// an account got a Stripe customer before its row was written (outside the
// try, so a deployment with no Stripe account could not sign anybody up at
// all), a workspace was activated with execution disabled because a
// subscription was expected to turn it on, and a `billing_controls` row was
// seeded suspended with no way to fund it.
//
// Each is now the provider's answer rather than a constant, and this file is
// ENUMERATING on purpose: the loop asserts that every provider answers all
// three, so a third one cannot land having answered two. That is the shape of
// the defect this replaces — a decision that looked like a constant.

import { getBillingProvider, type BillingProvider } from '../provider';

const ENV_KEYS = ['BILLING_PROVIDER', 'STRIPE_SECRET_KEY'] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  jest.restoreAllMocks();
});

describe('which provider a deployment gets', () => {
  it('uses Stripe when a secret key is present, so an existing deployment is unchanged', () => {
    delete process.env.BILLING_PROVIDER;
    process.env.STRIPE_SECRET_KEY = 'sk_test_whatever';
    expect(getBillingProvider().kind).toBe('stripe');
  });

  // The point of keying off the secret: `terraform apply` into an empty
  // project produces a working deployment with no billing configuration at
  // all. Requiring a new variable would mean the default install is the broken
  // one.
  it('falls to unbilled with no secret key, needing no billing configuration', () => {
    delete process.env.BILLING_PROVIDER;
    delete process.env.STRIPE_SECRET_KEY;
    expect(getBillingProvider().kind).toBe('unbilled');
  });

  it('lets BILLING_PROVIDER override the detection in both directions', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_whatever';
    process.env.BILLING_PROVIDER = 'unbilled';
    expect(getBillingProvider().kind).toBe('unbilled');

    delete process.env.STRIPE_SECRET_KEY;
    process.env.BILLING_PROVIDER = 'stripe';
    expect(getBillingProvider().kind).toBe('stripe');
  });

  it("accepts 'none' as a spelling of unbilled", () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.BILLING_PROVIDER = 'none';
    expect(getBillingProvider().kind).toBe('unbilled');
  });

  // A typo must not silently become "no billing", which on a deployment that
  // IS billing would stop every charge while everything kept working.
  it('ignores an unrecognised value and detects instead', () => {
    process.env.BILLING_PROVIDER = 'stipe';
    process.env.STRIPE_SECRET_KEY = 'sk_test_whatever';
    expect(getBillingProvider().kind).toBe('stripe');
  });
});

describe('every provider answers all three provisioning decisions', () => {
  const providers: Array<[string, () => BillingProvider]> = [
    ['stripe', () => {
      process.env.BILLING_PROVIDER = 'stripe';
      return getBillingProvider();
    }],
    ['unbilled', () => {
      process.env.BILLING_PROVIDER = 'unbilled';
      return getBillingProvider();
    }],
  ];

  it.each(providers)('%s decides execution-on-activation and controls seeding', (_name, build) => {
    const p = build();
    expect(typeof p.executionAllowedOnActivation).toBe('boolean');
    expect(typeof p.seedsPrepaidControls).toBe('boolean');
    expect(typeof p.ensureCustomer).toBe('function');
    expect(typeof p.discardCustomer).toBe('function');
    expect(typeof p.provisionSubscription).toBe('function');
  });

  // The two have to DISAGREE on both flags. A provider that answered the same
  // as Stripe would be a seam with no effect, which is the failure mode worth
  // catching: the code would look configurable and still be undeployable.
  it('disagrees where it matters', () => {
    process.env.BILLING_PROVIDER = 'stripe';
    const stripe = getBillingProvider();
    process.env.BILLING_PROVIDER = 'unbilled';
    const unbilled = getBillingProvider();

    expect(stripe.executionAllowedOnActivation).toBe(false);
    expect(unbilled.executionAllowedOnActivation).toBe(true);
    expect(stripe.seedsPrepaidControls).toBe(true);
    expect(unbilled.seedsPrepaidControls).toBe(false);
  });
});

describe('the unbilled provider', () => {
  beforeEach(() => {
    process.env.BILLING_PROVIDER = 'unbilled';
  });

  it('creates no customer and reports nothing to undo', async () => {
    const out = await getBillingProvider().ensureCustomer({
      accountId: 'acc-1',
      email: 'someone@example.com',
      name: 'Some One',
      firebaseUid: 'uid-1',
      emailHash: 'deadbeef',
    });
    expect(out).toEqual({ customerId: null, createdFresh: false });
  });

  // null, not a throw. A throw here would reach the caller's catch, which
  // enqueues an outbox retry — and no retry can produce a subscription with no
  // billing system behind it, so it would spend its whole attempt budget
  // proving that and log CRITICAL at the end of it.
  it('returns null from provisionSubscription rather than failing', async () => {
    await expect(getBillingProvider().provisionSubscription('tenant-1', null)).resolves.toBeNull();
  });

  it('discards nothing without complaint', async () => {
    await expect(getBillingProvider().discardCustomer('cus_nothing')).resolves.toBeUndefined();
  });
});

describe('the stripe provider', () => {
  beforeEach(() => {
    process.env.BILLING_PROVIDER = 'stripe';
  });

  // The guard that used to sit inline in TenantService.activate. It belongs to
  // the provider that needs it: under Stripe a tenant cannot be provisioned
  // without a customer, and saying so here keeps the caller free of the
  // question.
  it('refuses to provision a subscription with no customer id', async () => {
    await expect(
      getBillingProvider().provisionSubscription('tenant-1', null),
    ).rejects.toThrow(/no stripe_customer_id/);
  });
});
