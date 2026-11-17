// Promo-abuse eligibility check. Consulted by /subscribe and /promo/lookup
// before redeeming a promotion code so re-signups of previously-deleted
// users can't burn the same promo. Two independent signals:
//
//   * fingerprint_deleted — the card's Stripe fingerprint was previously
//     seen on a soft-deleted customer (billing-local table).
//   * email_deletion      — the signup's email hash matches a row in
//     accounts_deletion_ledger (PB-owned).
//
// Either signal denies. Surfaced upstream as the generic invalid_promo_code
// toast — silent denial, no information leaked about why.

import type Stripe from 'stripe';
import type { Pool } from 'pg';
import type { PlatformBackendClient } from './infrastructure/platform-backend-client.js';

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; signals: Array<'fingerprint_deleted' | 'email_deletion'> };

export async function checkPromoEligibility(
  deps: { stripe: Stripe; pool: Pool; pbClient: PlatformBackendClient },
  args: { stripeCustomerId: string; paymentMethodId: string },
): Promise<EligibilityResult> {
  const signals: Array<'fingerprint_deleted' | 'email_deletion'> = [];

  // 1. Fingerprint check (local table). The same physical card across two
  // different stripe customers shares a fingerprint, so seeing it on a
  // deleted customer is a re-attempt signal.
  const pm = await deps.stripe.paymentMethods.retrieve(args.paymentMethodId);
  const fingerprint = pm.card?.fingerprint;
  if (fingerprint) {
    const fp = await deps.pool.query( // rls-fence: allow (cross-tenant fraud fingerprint check)
      `SELECT 1 FROM payment_method_fingerprints_seen
        WHERE fingerprint = $1
          AND customer_status = 'deleted'
          AND stripe_customer_id != $2
        LIMIT 1`,
      [fingerprint, args.stripeCustomerId],
    );
    if ((fp.rowCount ?? 0) > 0) signals.push('fingerprint_deleted');
  }

  // 2. Email-hash check (call PB). When the current customer was created via
  // soft-scrub reuse (Phase 6), its metadata.email_sha256 was preserved and
  // the new account inherits it — meaning the freshly-signed-up user matches
  // the prior deletion's email hash exactly.
  const customer = await deps.stripe.customers.retrieve(args.stripeCustomerId);
  const emailHash = (customer as Stripe.Customer).metadata?.email_sha256;
  if (emailHash) {
    const r = await deps.pbClient.checkDeletionHistory(emailHash);
    if (r.matched) signals.push('email_deletion');
  }

  return signals.length === 0 ? { eligible: true } : { eligible: false, signals };
}
