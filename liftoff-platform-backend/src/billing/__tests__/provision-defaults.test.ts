// What a newly provisioned workspace is allowed to do depends on whether
// anybody is billing it.
//
// Both of these flags used to be constants, and both were correct for exactly
// one deployment. `agent_execution_allowed` started FALSE because
// provisionSubscription flipped it once Stripe acknowledged a subscription:
// the flag records a payment relationship existing. With no billing system
// there is nothing to flip it, so every self-hosted tenant was provisioned
// permanently unable to run an agent — and the symptom is not an error anyone
// can act on. The workspace accepts a request and then refuses to execute it,
// for a reason no surface shows and no operator can change.
//
// Asserted in BOTH directions on purpose. A test that only pinned the unbilled
// value would pass if someone made it unconditional, which would hand every
// Stripe tenant execution before it had paid for anything.

import { getBillingProvider } from '../provider';

const ORIGINAL = process.env.STRIPE_SECRET_KEY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL;
});

describe('provisioning defaults follow the billing provider', () => {
  it('with no billing system: agents may run, and no prepaid row is seeded', () => {
    delete process.env.STRIPE_SECRET_KEY;
    const billing = getBillingProvider();

    expect(billing.kind).toBe('unbilled');
    // Nothing exists to grant this later.
    expect(billing.agentExecutionAllowedOnProvision).toBe(true);
    // A seeded row would start suspended with no way to fund it, which is
    // strictly worse than no row: execution-guard LEFT JOINs and coalesces
    // suspension to FALSE, so a workspace with no row is admitted.
    expect(billing.seedsPrepaidControls).toBe(false);
  });

  it('with Stripe: execution waits for the subscription acknowledgement', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
    const billing = getBillingProvider();

    expect(billing.kind).toBe('stripe');
    expect(billing.agentExecutionAllowedOnProvision).toBe(false);
    expect(billing.seedsPrepaidControls).toBe(true);
  });

  it('the two flags answer opposite questions in both deployments', () => {
    // "May it run before paying" and "does a billing row get written" are not
    // the same question, and a refactor collapsing them into one would be
    // wrong in one deployment or the other. They happen to be inverses, which
    // is what makes that collapse tempting.
    for (const key of [undefined, 'sk_test_not_a_real_key']) {
      if (key === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = key;
      const billing = getBillingProvider();
      expect(billing.agentExecutionAllowedOnProvision).not.toBe(billing.seedsPrepaidControls);
    }
  });
});
