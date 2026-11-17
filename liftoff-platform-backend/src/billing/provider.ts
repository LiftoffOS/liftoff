// What the deployment's billing system decides when an account and a workspace
// are first created.
//
// Three decisions are made at provisioning time, before anybody has done any
// work, and all three assumed Stripe:
//
//   1. an account gets a customer record before its row is written,
//   2. a workspace starts with `agent_execution_allowed = false`, because a
//      subscription is what turns it on,
//   3. a `billing_controls` row is seeded `suspended = 'zero_prepaid_balance'`,
//      because a pay-as-you-go workspace has not funded anything yet.
//
// Every one of them is correct when a card is coming and wrong when none is.
// A deployment with no Stripe account could not create an account at all (the
// customer call ran before the first database write, outside the try), and a
// workspace that got past it could not run a single turn.
//
// So this is a seam rather than a deletion. Two implementations:
//
//   stripe    — all three decisions above, for a deployment that bills by card.
//   unbilled  — no customer, execution allowed on activation, no controls row.
//
// The seam is also the documentation. The money design here is worth reading —
// one money authority, the OU buckets, the admission chain — and it is far
// easier to follow with the Stripe path sitting next to the inert one than it
// would be with the Stripe path cut out and described in a comment.
//
// WHAT THIS IS NOT: the admission decision. `execution-guard`, the bucket math
// and `billing_controls` are untouched (INV-PB-010 — one money authority). An
// unbilled deployment still meters, still drains buckets and still reports; it
// simply never had a charge to make. Nothing here reads `billing_exempt`
// either, which INV-PB-011 confines to the charge boundary.
//
// Selection, in order:
//   BILLING_PROVIDER=stripe|unbilled   explicit, wins
//   STRIPE_SECRET_KEY present          stripe
//   otherwise                          unbilled
//
// Keyed off the secret rather than requiring a new variable, so an existing
// deployment behaves exactly as it did and a fresh one needs no billing
// configuration to work. `unbilled` is therefore what a `terraform apply` into
// an empty project produces.

import Stripe from 'stripe';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { log } from '../infrastructure/logging';
import { getBillingAdminClient } from './billing-admin-client';

/** Who the customer record is for. `emailHash` is how a prior one is found. */
export interface BillingCustomerIdentity {
  accountId: string;
  email: string;
  name: string;
  firebaseUid: string;
  emailHash: string;
}

export interface EnsuredCustomer {
  /** Null when the deployment has no billing system to hold a customer. */
  customerId: string | null;
  /**
   * True only when this call CREATED a record. A failure downstream must undo
   * a fresh customer and must leave a reused one alone — a soft-scrubbed
   * tombstone is what lets the next retry find the same customer again.
   */
  createdFresh: boolean;
}

export interface BillingProvider {
  readonly kind: 'stripe' | 'unbilled';

  /** The customer record for this account, created or reattached. */
  ensureCustomer(identity: BillingCustomerIdentity): Promise<EnsuredCustomer>;

  /** Compensation for an account insert that failed after ensureCustomer. */
  discardCustomer(customerId: string): Promise<void>;

  /**
   * Set up the workspace's subscription.
   *
   * Returns null when there is nothing to provision, which is DIFFERENT from a
   * provisioning failure: the caller treats null as done rather than enqueueing
   * a retry for a condition no retry can fix.
   */
  provisionSubscription(
    tenantId: string,
    customerId: string | null,
  ): Promise<{ alreadyExists: boolean } | null>;

  /**
   * Whether a workspace may run work the moment it is activated.
   *
   * False under Stripe: a subscription decides, and the webhook flips it. True
   * when unbilled, because nothing else is ever going to.
   */
  readonly executionAllowedOnActivation: boolean;

  /**
   * Whether to seed the pay-as-you-go `billing_controls` row.
   *
   * The seeded row starts `suspended='zero_prepaid_balance'`, so with no way to
   * fund it the workspace is suspended forever. It is also strictly worse than
   * no row at all: `execution-guard` LEFT JOINs `billing_controls` and
   * coalesces suspension to FALSE, so a workspace with NO row is admitted.
   */
  readonly seedsPrepaidControls: boolean;

  /**
   * Whether a newly provisioned workspace may run its agents straight away.
   *
   * FALSE under Stripe, and that is correct there: `agent_execution_allowed`
   * starts off and `provisionSubscription` flips it once Stripe acknowledges a
   * subscription. The flag is the record of a payment relationship existing.
   *
   * TRUE with no billing system, because otherwise there is nothing to flip it.
   * A self-hosted deployment has no Stripe to acknowledge anything, so every
   * tenant was provisioned permanently unable to run an agent — and the
   * symptom is not an error anybody can act on, it is a workspace that accepts
   * a request and then refuses to execute it, for a reason the operator cannot
   * see or change from any surface.
   *
   * The flag is not welded to Stripe in either direction: AdminService.enableTenant
   * and TenantService.reactivate already write it, which is what makes this a
   * default rather than a removal.
   */
  readonly agentExecutionAllowedOnProvision: boolean;
}

// ---------------------------------------------------------------- stripe

let stripe: Stripe | null = null;

async function getStripe(): Promise<Stripe> {
  if (!stripe) {
    stripe = new Stripe(await getStripeSecretKey());
  }
  return stripe;
}

const stripeProvider: BillingProvider = {
  kind: 'stripe',
  executionAllowedOnActivation: false,
  seedsPrepaidControls: true,
  agentExecutionAllowedOnProvision: false,

  async ensureCustomer(identity) {
    const client = await getStripe();

    const matches = await client.customers.search({
      query: `metadata['email_sha256']:'${identity.emailHash}'`,
    });

    if (matches.data.length > 0) {
      // Reattach PII to the prior customer so its contact details reflect the
      // new account owner. email_sha256 and deleted_at are preserved on
      // purpose — the abuse layer reads them.
      const existing = matches.data[0];
      await client.customers.update(existing.id, {
        email: identity.email,
        name: identity.name,
        metadata: {
          ...existing.metadata,
          accountId: identity.accountId,
          firebaseUid: identity.firebaseUid,
        },
      });
      log.info(
        { accountId: identity.accountId, stripeCustomerId: existing.id },
        'billing.provider: reusing soft-scrubbed Stripe customer',
      );
      return { customerId: existing.id, createdFresh: false };
    }

    const customer = await client.customers.create({
      email: identity.email,
      name: identity.name,
      metadata: { accountId: identity.accountId, firebaseUid: identity.firebaseUid },
    });
    return { customerId: customer.id, createdFresh: true };
  },

  async discardCustomer(customerId) {
    const client = await getStripe();
    await client.customers.del(customerId).catch((err: unknown) => {
      log.error(
        { stripeCustomerId: customerId, error: (err as Error).message },
        'CRITICAL: failed to delete orphan Stripe customer after DB insert failure — requires manual reconciliation',
      );
    });
  },

  async provisionSubscription(tenantId, customerId) {
    if (!customerId) {
      throw new Error(
        `tenant ${tenantId}: the account has no stripe_customer_id — cannot provision subscription`,
      );
    }
    return getBillingAdminClient().provisionSubscription(tenantId, customerId);
  },
};

// -------------------------------------------------------------- unbilled

const unbilledProvider: BillingProvider = {
  kind: 'unbilled',
  executionAllowedOnActivation: true,
  seedsPrepaidControls: false,
  agentExecutionAllowedOnProvision: true,

  async ensureCustomer() {
    return { customerId: null, createdFresh: false };
  },

  async discardCustomer() {
    // Nothing was created, so there is nothing to undo. Reached only if a
    // caller ignores `createdFresh`, and silence is the right answer.
  },

  async provisionSubscription() {
    // Not a failure — there is no subscription to create. The caller must not
    // enqueue a retry: no retry can produce a subscription with no billing
    // system behind it, and the outbox would spend its whole attempt budget
    // proving that.
    return null;
  },
};

// ------------------------------------------------------------- selection

export function getBillingProvider(): BillingProvider {
  const explicit = process.env.BILLING_PROVIDER?.trim().toLowerCase();
  if (explicit === 'stripe') return stripeProvider;
  if (explicit === 'unbilled' || explicit === 'none') return unbilledProvider;
  if (explicit) {
    log.warn(
      { BILLING_PROVIDER: explicit },
      'billing.provider: unrecognised BILLING_PROVIDER — falling through to detection',
    );
  }
  return process.env.STRIPE_SECRET_KEY ? stripeProvider : unbilledProvider;
}
