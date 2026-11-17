// The referral programme's money half.
//
// platform-backend decides WHETHER a referral counts. This module decides what
// it is worth, when it can be spent, how it reaches an invoice, and what
// happens when the payment that earned it is taken back. It is the only side
// that touches Stripe, which is the whole reason for the split: "invoice paid,
// is this the first and full-priced, write the grant" wants to sit next to the
// invoice event, and across a service boundary it would become retries,
// idempotency keys and duplicate-grant risk for $20 a time.
//
// Five things happen here, in the order a referral lives them:
//
//   1. EARN     — the referred workspace's first full-priced paid invoice
//                 writes a `pending` credit.
//   2. VEST     — 60 days later a sweep flips it to `granted` and stamps an
//                 expiry.
//   3. APPLY    — the referrer's next subscription invoice draws it down, via
//                 the Stripe customer balance, nearest expiry first.
//   4. EXPIRE   — anything still unspent at `expires_at` is reversed.
//   5. REVERSE  — a refund, dispute or cancellation takes it back, unless it
//                 has already been spent, in which case it is absorbed.

import type { PoolClient } from 'pg';
import type Stripe from 'stripe';
import { withBillingTenant, withCrossTenant } from '../infrastructure/database.js';
import type { PlatformBackendClient } from '../infrastructure/platform-backend-client.js';

export interface ReferralLogger {
  info: (msg: string, meta?: object) => void;
  warn: (msg: string, meta?: object) => void;
  error: (msg: string, meta?: object) => void;
}

// ── The programme's numbers ──────────────────────────────────────────────────
//
// Mirrored from platform-backend's src/referrals/constants.ts, which is the
// serving authority: the dashboard renders what its endpoint sends. These exist
// because the earning event happens here, where that endpoint is not in the
// call path.

/** Credit the referrer earns per qualifying subscription, in USD. */
export const REFERRAL_REWARD_USD = 20;

/** Bonus Operating Units granted to the referred workspace's first period.
 *  ONE MONTH OF CORE: it tracks Core's included allowance and moves with it, so
 *  the grant stays worth the $20 the offer states. Mirrored in
 *  platform-backend's src/referrals/constants.ts and liftoff-react's
 *  src/constants/referralProgram.ts. */
export const REFEREE_BONUS_OUS = 1400;

/** Days the referred workspace must have been paying before credit vests. */
export const REFERRAL_VESTING_DAYS = 60;

/** Days after credit becomes available before it expires. */
export const REFERRAL_EXPIRY_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an invoice was paid at FULL PRICE.
 *
 * A heavily discounted or fully comped first month must not earn a referral
 * credit, or the cheapest path to $20 of credit is a promo code and no hold
 * period closes that. Three things can reduce an invoice and all three
 * disqualify it:
 *
 *   - a coupon or promo, which Stripe reports per-discount in
 *     `total_discount_amounts`;
 *   - an existing customer balance, which shows up as a negative
 *     `starting_balance` — including, pointedly, referral credit itself, so a
 *     referral chain cannot bootstrap off its own rewards;
 *   - nothing actually being collected, which is what a $0 invoice is.
 *
 * Bonus Operating Units are deliberately NOT a reduction: they are the reason
 * the referee reward is compute rather than money, because a discount would
 * zero a $20 Core invoice and disqualify the very referral that granted it.
 */
export function isFullPricedInvoice(inv: Stripe.Invoice): boolean {
  const discountCents = (inv.total_discount_amounts ?? []).reduce(
    (sum, d) => sum + (d.amount ?? 0),
    0,
  );
  if (discountCents > 0) return false;
  if ((inv.starting_balance ?? 0) < 0) return false;
  return (inv.amount_paid ?? 0) > 0;
}

export class ReferralCreditService {
  // No Pool. Every read here goes through one of two doors — withBillingTenant
  // for a known tenant, withCrossTenant for work that genuinely spans them —
  // and neither can be reached without saying which it is. The unscoped read
  // that took the referral programme down was written on a Pool held exactly
  // here; removing it is what makes that line unwritable rather than merely
  // discouraged.
  constructor(
    private readonly stripe: Stripe,
    private readonly pbClient: PlatformBackendClient,
    private readonly log: ReferralLogger,
  ) {}

  // ── 1. Earning ─────────────────────────────────────────────────────────────

  /**
   * Called when a referred workspace pays a subscription invoice.
   *
   * The earning trigger is the FIRST full-priced paid invoice, not the
   * subscription record: a subscription is free to fake, a paid invoice is not.
   *
   * Both halves of the double-sided reward are granted here, together, because
   * they are the same decision. The referee's bonus is granted on the
   * Qualifying Subscription and never at signup — at signup 1,400 Operating
   * Units cost an attacker one email address and the programme becomes a
   * free-compute faucet; here they cost $20 to obtain $20 of usage.
   *
   * Throws on a platform-backend failure so the consumer 500s and Pub/Sub
   * retries. Every write it performs is idempotent (`referral_id` is UNIQUE,
   * the bonus grant refuses a second one), so a retry re-runs safely and a
   * silent swallow would lose the referral instead.
   */
  async onReferredInvoicePaid(
    client: PoolClient,
    referredTenantId: string,
    inv: Stripe.Invoice,
  ): Promise<void> {
    const referral = await this.pbClient.referralLookup(referredTenantId);
    if (!referral) return;

    // Already disqualified at binding — an existing account, a workspace
    // somebody else already referred, matching account details. The row stays
    // visible to the referrer with its reason; nothing more happens to it.
    if (referral.ineligibleReason) return;

    // The first invoice only. A referral earns once, on the conversion, not on
    // every renewal for the life of the subscription.
    if (!(await this.isFirstSubscriptionInvoice(client, referredTenantId, inv))) return;

    const paidAt = inv.status_transitions?.paid_at
      ? new Date(inv.status_transitions.paid_at * 1000)
      : new Date();

    // The conversion is recorded whether or not it earns. Somebody can be
    // `subscribed` and earn nothing, and collapsing that into the funnel status
    // would lose the fact that they did subscribe.
    await this.pbClient.referralSubscribed(referral.referralId, paidAt);

    if (!isFullPricedInvoice(inv)) {
      this.log.info('referrals.earn.discounted_signup', {
        referralId: referral.referralId,
        invoiceId: inv.id,
      });
      await this.pbClient.referralIneligible(referral.referralId, 'discounted_signup');
      return;
    }

    // The enforceable half of the self-referral rules. "Already had an
    // account", "previously referred" and "same person" are all defeated by a
    // fresh email address; a card fingerprint is not, and it applies at the
    // moment money moves, which is the moment worth checking.
    if (await this.sharesPaymentMethod(referral.referrerStripeCustomerId, referral.referredStripeCustomerId)) {
      this.log.warn('referrals.earn.self_referral_fingerprint', {
        referralId: referral.referralId,
      });
      await this.pbClient.referralIneligible(referral.referralId, 'self_referral');
      return;
    }

    // The referrer's credit: pending until the referred workspace has been
    // paying for 60 days. That hold is what makes a flat $20 safe — Core is
    // $20/month, so earning $20 costs the referred side two paid months, and
    // self-referral and circular rings lose money by construction, which is why
    // no cap is needed.
    const availableAt = new Date(paidAt.getTime() + REFERRAL_VESTING_DAYS * DAY_MS);
    const inserted = await this.insertPendingCredit({
      referralId: referral.referralId,
      referrerTenantId: referral.referrerTenantId,
      amountUsd: REFERRAL_REWARD_USD,
      earnedAt: paidAt,
      availableAt,
      earningInvoiceId: inv.id ?? null,
    });

    if (inserted) {
      this.log.info('referrals.earn.credit_pending', {
        referralId: referral.referralId,
        referrerTenantId: referral.referrerTenantId,
        amountUsd: REFERRAL_REWARD_USD,
        availableAt: availableAt.toISOString(),
      });
    }

    // The referee's bonus, into the allowance the billing tab already reports.
    // A separate bucket that page does not read would mean the referred
    // workspace is never told, and the share message's promise of bonus usage
    // is never visibly kept. This is the ONLY surface the referred party gets,
    // by decision.
    if (referral.referredStripeCustomerId) {
      const { granted } = await this.pbClient.referralBonus(referral.referredStripeCustomerId, {
        referralId: referral.referralId,
        bonusOus: REFEREE_BONUS_OUS,
      });
      this.log.info('referrals.earn.referee_bonus', {
        referralId: referral.referralId,
        granted,
        bonusOus: REFEREE_BONUS_OUS,
      });
    } else {
      this.log.warn('referrals.earn.referee_bonus_skipped_no_customer', {
        referralId: referral.referralId,
      });
    }
  }

  /**
   * Whether this is the referred workspace's first subscription invoice.
   *
   * Counted from the local invoices table, which upsertInvoice has already
   * written this invoice into by the time this runs — so "first" means "no
   * OTHER subscription invoice exists", and the row for the invoice in hand is
   * excluded by id rather than by counting to one.
   */
  private async isFirstSubscriptionInvoice(
    client: PoolClient,
    tenantId: string,
    inv: Stripe.Invoice,
  ): Promise<boolean> {
    const { rows } = await client.query<{ count: string }>( // rls-fence: allow (client pre-scoped via set_config-in-tx (outbox consumer))
      `SELECT COUNT(*)::text AS count
         FROM invoices
        WHERE tenant_id = $1
          AND invoice_type = 'subscription_cycle'
          AND stripe_invoice_id <> $2`,
      [tenantId, inv.id ?? ''],
    );
    return Number(rows[0]?.count ?? 0) === 0;
  }

  /**
   * Whether the two sides of a referral are funded by the same card.
   *
   * Compares Stripe payment-method fingerprints, which are stable across
   * re-tokenisations of the same underlying card. A missing customer on either
   * side, or a Stripe error, answers false: a detection failure must not
   * disqualify a real referral, and the hold plus the full-price rule already
   * make the economics of a manufactured one unprofitable.
   */
  private async sharesPaymentMethod(
    referrerCustomerId: string | null,
    referredCustomerId: string | null,
  ): Promise<boolean> {
    if (!referrerCustomerId || !referredCustomerId) return false;
    if (referrerCustomerId === referredCustomerId) return true;
    try {
      const [a, b] = await Promise.all([
        this.stripe.customers.listPaymentMethods(referrerCustomerId, { limit: 10 }),
        this.stripe.customers.listPaymentMethods(referredCustomerId, { limit: 10 }),
      ]);
      const fingerprints = new Set(
        a.data.map((pm) => pm.card?.fingerprint).filter((f): f is string => !!f),
      );
      return b.data.some((pm) => pm.card?.fingerprint && fingerprints.has(pm.card.fingerprint));
    } catch (err) {
      this.log.warn('referrals.fingerprint_check_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Writes the pending grant under the REFERRER's tenant context.
   *
   * Its own transaction, not the consumer's: the consumer is scoped to the
   * REFERRED workspace, and referral_credits' INSERT policy requires the
   * context to be the tenant the row belongs to. That is deliberate — it forces
   * the credit's owner to be stated rather than inherited from whichever tenant
   * the webhook happened to be about.
   *
   * Returns false when a credit for this referral already existed, which is the
   * ordinary answer on a webhook redelivery.
   */
  private async insertPendingCredit(input: {
    referralId: string;
    referrerTenantId: string;
    amountUsd: number;
    earnedAt: Date;
    availableAt: Date;
    earningInvoiceId: string | null;
  }): Promise<boolean> {
    return withBillingTenant(input.referrerTenantId, async (client) => {
      const { rowCount } = await client.query(
        `INSERT INTO referral_credits
           (referral_id, tenant_id, amount_usd, status, earned_at, available_at, earning_invoice_id)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6)
             ON CONFLICT (referral_id) DO NOTHING`,
        [
          input.referralId,
          input.referrerTenantId,
          input.amountUsd,
          input.earnedAt,
          input.availableAt,
          input.earningInvoiceId,
        ],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  // ── 2. Vesting ─────────────────────────────────────────────────────────────

  /**
   * Flips every credit whose hold has run out from `pending` to `granted`, and
   * stamps its expiry.
   *
   * The expiry has two conditions because either alone breaks. The clock starts
   * at AVAILABILITY rather than accrual: credit vests 60 days after the
   * referred workspace starts paying, so an accrual-based 90 days would leave
   * 30 usable days. And it never falls before the holder's next subscription
   * invoice, because Liftoff sells annual billing — a bare 90 day timer would
   * expire an annual subscriber's credit before it could ever be applied, on
   * the plan they paid more for up front. For a monthly subscriber the floor
   * never binds, since 90 days is three billing cycles.
   */
  async runVesting(now: Date = new Date()): Promise<{ vested: number }> {
    const rows = await withCrossTenant('vesting sweep reads pending credits for every tenant', async (client) => {
      const r = await client.query<{ id: string; tenant_id: string; available_at: Date }>(
        `SELECT id, tenant_id, available_at
           FROM referral_credits
          WHERE status = 'pending' AND available_at <= $1
          ORDER BY available_at ASC`,
        [now],
      );
      return r.rows;
    });

    let vested = 0;
    for (const row of rows) {
      const timerExpiry = new Date(row.available_at.getTime() + REFERRAL_EXPIRY_DAYS * DAY_MS);
      const nextInvoiceAt = await this.nextInvoiceAt(row.tenant_id);
      const expiresAt =
        nextInvoiceAt && nextInvoiceAt > timerExpiry ? nextInvoiceAt : timerExpiry;

      const updated = await withBillingTenant(row.tenant_id, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE referral_credits
              SET status = 'granted', expires_at = $2, updated_at = NOW()
            WHERE id = $1 AND status = 'pending'`,
          [row.id, expiresAt],
        );
        return (rowCount ?? 0) > 0;
      });
      if (updated) {
        vested += 1;
        this.log.info('referrals.vested', {
          creditId: row.id,
          tenantId: row.tenant_id,
          expiresAt: expiresAt.toISOString(),
        });
      }
    }
    return { vested };
  }

  /** The holder's next subscription invoice, from the local mirror. */
  private async nextInvoiceAt(tenantId: string): Promise<Date | null> {
    // Scoped for the same reason as `hasActiveSubscription`: same table, same
    // policy, same 22P02 on a connection whose scope has already been reset.
    return withBillingTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ current_period_end: Date | null }>(
        `SELECT current_period_end
           FROM subscriptions
          WHERE tenant_id = $1 AND status IN ('active', 'trialing')
          ORDER BY updated_at DESC
          LIMIT 1`,
        [tenantId],
      );
      return rows[0]?.current_period_end ?? null;
    });
  }

  // ── 3. Application ─────────────────────────────────────────────────────────

  /**
   * Draws vested credit down against a subscription invoice as it is created.
   *
   * A Stripe customer balance is the mechanism, which makes the monthly and
   * annual cases one code path: Stripe applies the balance when the invoice
   * finalizes, whatever its period. Spend order is NEAREST EXPIRY FIRST,
   * because the timer means each grant ages separately and spending the
   * longest-lived one first would burn credit the customer could still have
   * used.
   *
   * Credit reduces the recurring plan charge only, so this runs for
   * subscription invoices and for nothing else. It never applies more than the
   * invoice is for: credit is a discount ceiling, not a balance the customer
   * owns, and a surplus sitting in the Stripe balance would behave like one.
   */
  async applyToInvoice(tenantId: string, inv: Stripe.Invoice): Promise<{ appliedUsd: number }> {
    const amountDueCents = inv.amount_due ?? 0;
    if (amountDueCents <= 0) return { appliedUsd: 0 };

    const customerId =
      typeof inv.customer === 'string' ? inv.customer : (inv.customer as Stripe.Customer | null)?.id;
    if (!customerId) return { appliedUsd: 0 };

    const spendable = await withBillingTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string; amount_usd: string }>(
        `SELECT id, amount_usd
           FROM referral_credits
          WHERE tenant_id = $1
            AND status = 'granted'
            AND applied_invoice_id IS NULL
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY expires_at ASC NULLS LAST, earned_at ASC`,
        [tenantId],
      );
      return rows;
    });
    if (spendable.length === 0) return { appliedUsd: 0 };

    let remainingCents = amountDueCents;
    const chosen: Array<{ id: string; cents: number }> = [];
    for (const credit of spendable) {
      if (remainingCents <= 0) break;
      const cents = Math.round(parseFloat(credit.amount_usd) * 100);
      // Whole grants only. A partially spent grant would need a remaining
      // amount, a second expiry question and a partial-reversal rule, and every
      // grant is one flat reward — there is nothing to split.
      if (cents > remainingCents) continue;
      chosen.push({ id: credit.id, cents });
      remainingCents -= cents;
    }
    if (chosen.length === 0) return { appliedUsd: 0 };

    const totalCents = chosen.reduce((sum, c) => sum + c.cents, 0);
    const chosenIds = chosen.map((c) => c.id);

    // CLAIM THE ROWS FIRST, then hand the money to Stripe.
    //
    // The other order is the tempting one and it is wrong. Crediting Stripe
    // before marking the rows leaves a window where the balance has moved and
    // the grants still read as unspent — so the NEXT invoice picks the same
    // grants up and credits them again, and again, with nothing to stop it. The
    // failure this order risks instead is a grant marked spent that Stripe
    // never received: bounded at one invoice, visible in the log below, and
    // undone by the compensating update.
    //
    // `applied_invoice_id IS NULL` in the WHERE is what makes the claim atomic
    // against a concurrent invoice for the same workspace. A short claim means
    // somebody else took some of them, and the safe move is to take none.
    const claimed = await withBillingTenant(tenantId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE referral_credits
            SET applied_invoice_id = $2,
                applied_at         = NOW(),
                updated_at         = NOW()
          WHERE id = ANY($1::uuid[])
            AND applied_invoice_id IS NULL`,
        [chosenIds, inv.id ?? null],
      );
      return rowCount ?? 0;
    });
    if (claimed !== chosen.length) {
      this.log.warn('referrals.credit_claim_incomplete', {
        tenantId, invoiceId: inv.id, wanted: chosen.length, claimed,
      });
      if (claimed > 0) await this.releaseClaim(tenantId, chosenIds, inv.id ?? null);
      return { appliedUsd: 0 };
    }

    let txnId: string;
    try {
      // A NEGATIVE customer balance transaction is a credit in Stripe's model.
      // The idempotency key is derived from the grants themselves, so a retry
      // that re-selects the same set cannot double-credit inside Stripe's
      // dedupe window.
      const txn = await this.stripe.customers.createBalanceTransaction(
        customerId,
        {
          amount: -totalCents,
          currency: inv.currency ?? 'usd',
          description: 'Liftoff referral credit',
          metadata: {
            type: 'referral_credit',
            invoice_id: inv.id ?? '',
            credit_ids: chosenIds.join(','),
          },
        },
        { idempotencyKey: `referral-credit-${[...chosenIds].sort().join('-')}` },
      );
      txnId = txn.id;
    } catch (err) {
      // Compensating action, the same shape AccountService.create uses when a
      // Stripe customer outlives a failed insert: give the grants back rather
      // than leaving a customer holding credit they can never spend.
      await this.releaseClaim(tenantId, chosenIds, inv.id ?? null);
      throw err;
    }

    await withBillingTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE referral_credits
            SET stripe_balance_txn_id = $2, updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [chosenIds, txnId],
      );
    });

    const appliedUsd = totalCents / 100;
    this.log.info('referrals.credit_applied', {
      tenantId,
      invoiceId: inv.id,
      appliedUsd,
      creditIds: chosenIds,
    });
    return { appliedUsd };
  }

  /**
   * Undoes a claim whose Stripe leg did not land.
   *
   * Scoped to the claiming invoice so it can never release a grant some other
   * invoice legitimately took. A failure here is the one case that leaves a
   * customer's credit stranded, so it is logged at ERROR with everything an
   * operator needs to reissue it by hand.
   */
  private async releaseClaim(
    tenantId: string,
    creditIds: string[],
    invoiceId: string | null,
  ): Promise<void> {
    try {
      await withBillingTenant(tenantId, async (client) => {
        await client.query(
          `UPDATE referral_credits
              SET applied_invoice_id = NULL,
                  applied_at         = NULL,
                  updated_at         = NOW()
            WHERE id = ANY($1::uuid[])
              AND applied_invoice_id IS NOT DISTINCT FROM $2
              AND stripe_balance_txn_id IS NULL`,
          [creditIds, invoiceId],
        );
      });
    } catch (err) {
      this.log.error('referrals.credit_claim_release_failed', {
        tenantId,
        invoiceId,
        creditIds,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 4. Expiry ──────────────────────────────────────────────────────────────

  /**
   * Reverses vested credit that nobody spent before its expiry.
   *
   * This rarely bites an active customer, because credit auto-applies to the
   * next invoice as soon as it vests. The timer exists to stop indefinite
   * stockpiling by a workspace that never subscribes, not to claw back from
   * people who are using the product.
   */
  async runExpiry(now: Date = new Date()): Promise<{ expired: number }> {
    const rows = await withCrossTenant('expiry sweep reads granted credits for every tenant', async (client) => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id
           FROM referral_credits
          WHERE status = 'granted'
            AND applied_invoice_id IS NULL
            AND expires_at IS NOT NULL
            AND expires_at <= $1`,
        [now],
      );
      return r.rows;
    });

    let expired = 0;
    for (const row of rows) {
      const done = await this.reverse(row.tenant_id, [row.id], 'expired');
      expired += done;
    }
    if (expired > 0) this.log.info('referrals.credits_expired', { expired });
    return { expired };
  }

  // ── 5. Reversal ────────────────────────────────────────────────────────────

  /**
   * Takes credit back.
   *
   * Only credit that has NOT been applied is reversible. Spent credit is
   * absorbed: no negative balance, no re-billing. Automatic clawback against
   * future earnings was considered and rejected twice, because it misses
   * fraudsters — a negative balance is only collectable from somebody who
   * intends to keep earning, which describes the honest referrer and not the
   * attacker who abandons the workspace — and because referral links are public
   * by design, so anyone can sign up through one, pay, and charge back, driving
   * a victim's balance negative through no fault of theirs.
   */
  async reverse(
    tenantId: string,
    creditIds: string[],
    reason: 'refund' | 'dispute' | 'expired' | 'cancelled' | 'terms_violation' | 'disqualified',
  ): Promise<number> {
    if (creditIds.length === 0) return 0;
    return withBillingTenant(tenantId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE referral_credits
            SET status          = 'reversed',
                reversed_reason = $2,
                reversed_at     = NOW(),
                updated_at      = NOW()
          WHERE id = ANY($1::uuid[])
            AND status <> 'reversed'
            AND applied_invoice_id IS NULL`,
        [creditIds, reason],
      );
      return rowCount ?? 0;
    });
  }

  /**
   * Reverses the credit an invoice's payment earned, after that payment is
   * refunded or disputed.
   *
   * Automatic application makes the absorb path the DEFAULT rather than the
   * exception: credit lands on the next invoice as soon as it vests, so by the
   * time a late dispute arrives — a card dispute can be filed up to 120 days
   * after the transaction, and the hold only covers the first 60 — it is
   * usually already spent. That residual window is a known, accepted cost.
   */
  async onEarningPaymentReversed(
    invoiceId: string,
    reason: 'refund' | 'dispute',
  ): Promise<{ reversed: number; absorbed: number }> {
    const rows = await withCrossTenant('reversal is keyed by invoice; its tenant is what we are resolving', async (client) => {
      const r = await client.query<{
        id: string;
        tenant_id: string;
        applied_invoice_id: string | null;
        status: string;
      }>(
        `SELECT id, tenant_id, applied_invoice_id, status
           FROM referral_credits
          WHERE earning_invoice_id = $1`,
        [invoiceId],
      );
      return r.rows;
    });
    if (rows.length === 0) return { reversed: 0, absorbed: 0 };

    let reversed = 0;
    let absorbed = 0;
    for (const row of rows) {
      if (row.applied_invoice_id) {
        absorbed += 1;
        continue;
      }
      if (row.status === 'reversed') continue;
      reversed += await this.reverse(row.tenant_id, [row.id], reason);
    }

    this.log.info('referrals.earning_payment_reversed', {
      invoiceId,
      reason,
      reversed,
      absorbed,
    });
    return { reversed, absorbed };
  }

  /**
   * Restores the credit a dispute reversed, once that dispute is decided in our
   * favour and the funds come back.
   *
   * `charge.dispute.created` fires when a cardholder complains, which is months
   * before anyone decides who was right. Treating that as final means a
   * referrer loses earnings over a complaint we went on to win, and nothing
   * ever puts them back.
   *
   * Only a `dispute` reversal is reinstatable. A refund, an expiry, a
   * cancellation and a disqualification are all decisions that stand, and a
   * reinstatement that reopened them would undo a deliberate act.
   *
   * Restores to `pending` rather than to whatever the row was before. Vesting
   * is what stamps `expires_at`, so handing the row back to the vesting sweep
   * keeps one authority over that date instead of a second copy of the rule
   * here; a credit whose hold has already run out is picked up on the next
   * sweep. The prior status is therefore never needed, and no column has to
   * remember it.
   */
  async onEarningPaymentReinstated(invoiceId: string): Promise<{ restored: number }> {
    const rows = await withCrossTenant('reinstatement is keyed by invoice; its tenant is what we are resolving', async (client) => {
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id
           FROM referral_credits
          WHERE earning_invoice_id = $1
            AND status            = 'reversed'
            AND reversed_reason   = 'dispute'`,
        [invoiceId],
      );
      return r.rows;
    });
    if (rows.length === 0) return { restored: 0 };

    let restored = 0;
    for (const row of rows) {
      restored += await withBillingTenant(row.tenant_id, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE referral_credits
              SET status          = 'pending',
                  reversed_reason = NULL,
                  reversed_at     = NULL,
                  updated_at      = NOW()
            WHERE id              = $1
              AND status          = 'reversed'
              AND reversed_reason = 'dispute'`,
          [row.id],
        );
        return rowCount ?? 0;
      });
    }

    this.log.info('referrals.earning_payment_reinstated', { invoiceId, restored });
    return { restored };
  }

  /**
   * Forfeits everything unspent when a workspace cancels.
   *
   * No grace period. An earlier draft proposed a six month reinstatement window
   * copied from Shopify; it was dropped as over-engineering, since with a 90
   * day timer already running it is mostly unreachable. Cancelling does not
   * convert unspent credit into money — the credit was never money.
   */
  async onSubscriptionCancelled(tenantId: string): Promise<{ forfeited: number }> {
    const ids = await withBillingTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM referral_credits
          WHERE tenant_id = $1 AND status <> 'reversed' AND applied_invoice_id IS NULL`,
        [tenantId],
      );
      return rows.map((r) => r.id);
    });
    const forfeited = await this.reverse(tenantId, ids, 'cancelled');
    if (forfeited > 0) {
      this.log.info('referrals.credits_forfeited_on_cancellation', { tenantId, forfeited });
    }
    return { forfeited };
  }

  /**
   * Takes back the credit one referral earned, under the
   * investigate-and-disqualify clause.
   *
   * This is the enforcement backstop that REPLACES automatic clawback. Clawback
   * was rejected twice — it misses fraudsters, because a negative balance is
   * only collectable from somebody who intends to keep earning, and it is a
   * griefing vector, because referral links are public and one chargeback can
   * drive an innocent referrer negative. What survives is a human decision,
   * recorded: repetition is the fraud signal worth acting on, not any single
   * reversal.
   *
   * Still cannot touch spent credit. Absorb is absorb: a disqualification does
   * not create a negative balance or re-bill any more than a chargeback does,
   * and the return value says exactly how much was recovered so the operator is
   * not told a $20 was clawed back when it had already been applied.
   */
  async disqualifyReferral(
    referralId: string,
  ): Promise<{ reversed: number; absorbed: number; found: boolean }> {
    const rows = await withCrossTenant('disqualification is keyed by referral; its tenant is what we are resolving', async (client) => {
      const r = await client.query<{
        id: string;
        tenant_id: string;
        applied_invoice_id: string | null;
        status: string;
      }>(
        `SELECT id, tenant_id, applied_invoice_id, status
           FROM referral_credits
          WHERE referral_id = $1`,
        [referralId],
      );
      return r.rows;
    });
    if (rows.length === 0) return { reversed: 0, absorbed: 0, found: false };

    let reversed = 0;
    let absorbed = 0;
    for (const row of rows) {
      if (row.applied_invoice_id) {
        absorbed += 1;
        continue;
      }
      if (row.status === 'reversed') continue;
      reversed += await this.reverse(row.tenant_id, [row.id], 'disqualified');
    }

    this.log.warn('referrals.disqualified', { referralId, reversed, absorbed });
    return { reversed, absorbed, found: true };
  }

  /**
   * Forfeits a workspace's whole unspent balance on termination for cause or a
   * terms violation.
   *
   * Immediate, with no grace period, matching Formation and Mailchimp — and
   * matching what cancellation already does, because the reason a workspace
   * stops being a customer does not change what happens to credit that was
   * never money. Spent credit is untouched for the same reason as everywhere
   * else: there is nothing to take back.
   */
  async forfeitForTermsViolation(tenantId: string): Promise<{ forfeited: number }> {
    const ids = await withBillingTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM referral_credits
          WHERE tenant_id = $1 AND status <> 'reversed' AND applied_invoice_id IS NULL`,
        [tenantId],
      );
      return rows.map((r) => r.id);
    });
    const forfeited = await this.reverse(tenantId, ids, 'terms_violation');
    this.log.warn('referrals.forfeited_for_terms_violation', { tenantId, forfeited });
    return { forfeited };
  }

  // ── Reads for platform-backend ─────────────────────────────────────────────

  /**
   * The programme payload's money half.
   *
   * THE ONE SUBTLETY. Two of the contract's rules pull against each other, and
   * the resolution is deliberate rather than incidental:
   *
   *   - `creditEarnedUsd === creditAppliedUsd + creditAvailableUsd` MUST hold,
   *     because the page renders all three side by side and a mismatch reads as
   *     a bug in the programme rather than in the arithmetic.
   *   - `pending` credit is excluded from `creditAvailableUsd`, because the
   *     page presents that figure as what comes off the next invoice, and
   *     pending credit does not. The page's own wording depends on it: it says
   *     "ready for your next invoice".
   *
   * Both cannot hold if `creditEarnedUsd` counts pending credit, so it does
   * not. Earned is DERIVED as applied + available rather than summed
   * independently, which makes the identity true by construction — including in
   * the window between a credit passing its expiry and the daily sweep
   * reversing it, where an independently summed total would disagree with the
   * available figure for up to a day.
   *
   * What that means for the customer: a referral that has converted but not yet
   * vested shows on its own row as `pending` with the date it becomes
   * spendable, and contributes nothing to the totals until it does. That is the
   * honest reading of "what has this earned me and what can I spend", and the
   * row carries the rest.
   *
   * `convertedCount` counts exactly the conversions that make up
   * `creditEarnedUsd`, and that is the whole rule. The page renders the two in
   * one sentence — "$40 earned from 2 subscribers" — so any set that is not the
   * same set makes that sentence false. A reversed conversion is excluded; so
   * is one whose credit has not vested, because it contributes nothing to the
   * figure beside it, and "$0 earned from 1 subscriber" reads as a bug rather
   * than as a hold working correctly. What that referral is doing is on its own
   * row, as `pending` with the date it becomes spendable, which is the surface
   * the contract designed for exactly this.
   */
  async summary(tenantId: string): Promise<{
    creditEarnedUsd: number;
    creditAppliedUsd: number;
    creditAvailableUsd: number;
    convertedCount: number;
    subscriptionActive: boolean;
  }> {
    const [totals, subscriptionActive] = await Promise.all([
      withBillingTenant(tenantId, async (client) => {
        const { rows } = await client.query<{
          applied: string;
          available: string;
          converted: string;
        }>(
          // Applied credit stays counted after a late dispute reverses the
          // payment that earned it: that credit was spent and the loss is
          // absorbed, so it is part of what the referrer earned and used. Only
          // unspent credit can be taken back, and `status = 'reversed'` is
          // exactly the set that was.
          `SELECT
             COALESCE(SUM(amount_usd) FILTER (WHERE status <> 'reversed'
                                                AND applied_invoice_id IS NOT NULL), 0)::text AS applied,
             COALESCE(SUM(amount_usd) FILTER (WHERE status = 'granted'
                                                AND applied_invoice_id IS NULL
                                                AND (expires_at IS NULL OR expires_at > NOW())), 0)::text AS available,
             -- The same predicate as applied + available, deliberately: this
             -- count and creditEarnedUsd are rendered as one sentence, so they
             -- have to describe one set.
             COUNT(*) FILTER (WHERE status <> 'reversed'
                                AND (applied_invoice_id IS NOT NULL
                                     OR (status = 'granted'
                                         AND (expires_at IS NULL OR expires_at > NOW()))))::text AS converted
           FROM referral_credits WHERE tenant_id = $1`,
          [tenantId],
        );
        return rows[0];
      }),
      this.hasActiveSubscription(tenantId),
    ]);

    const applied = Number(totals?.applied ?? 0);
    const available = Number(totals?.available ?? 0);

    return {
      // Derived, never summed independently. See the note above.
      creditEarnedUsd: applied + available,
      creditAppliedUsd: applied,
      creditAvailableUsd: available,
      convertedCount: Number(totals?.converted ?? 0),
      subscriptionActive,
    };
  }

  /** The credit rows behind one page of the referrer's list. */
  async creditsByReferral(
    tenantId: string,
    referralIds: string[],
  ): Promise<Array<{
    referralId: string;
    amountUsd: number;
    status: 'pending' | 'granted' | 'reversed';
    availableAt: string | null;
    expiresAt: string | null;
  }>> {
    if (referralIds.length === 0) return [];
    return withBillingTenant(tenantId, async (client) => {
      const { rows } = await client.query<{
        referral_id: string;
        amount_usd: string;
        status: 'pending' | 'granted' | 'reversed';
        available_at: Date;
        expires_at: Date | null;
      }>(
        `SELECT referral_id, amount_usd, status, available_at, expires_at
           FROM referral_credits
          WHERE tenant_id = $1 AND referral_id = ANY($2::uuid[])`,
        [tenantId, referralIds],
      );
      return rows.map((r) => ({
        referralId: r.referral_id,
        amountUsd: Number(r.amount_usd),
        status: r.status,
        availableAt: r.available_at ? r.available_at.toISOString() : null,
        expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
      }));
    });
  }

  /**
   * Whether there is a subscription to redeem credit against.
   *
   * Asked here rather than in the control plane because billing owns Stripe.
   * The two flags this drives — `creditRedeemable` and `canSendInvites` — are
   * exactly the ones a local "does this workspace have a subscription" check
   * would get wrong: for billing-exempt tenants, enterprise contracts, and
   * anyone whose subscription activated by webhook after they skipped the plan
   * step.
   */
  private async hasActiveSubscription(tenantId: string): Promise<boolean> {
    // Scoped, not raw-pooled. `subscriptions` carries the tenant_isolation
    // policy from 002_rls.sql, which casts
    // `current_setting('app.current_tenant_id', false)::uuid`. A pooled
    // connection that carried a scope earlier comes back with that setting as
    // the empty string rather than unset, so an unscoped read here casts
    // ''::uuid and throws 22P02. That rejected `summary`'s Promise.all, the
    // route 500'd, and the control plane's catch served `subscriptionActive:
    // false` — silently hiding the invite control from every workspace.
    return withBillingTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM subscriptions
          WHERE tenant_id = $1 AND status IN ('active', 'trialing')`,
        [tenantId],
      );
      return Number(rows[0]?.count ?? 0) > 0;
    });
  }
}
