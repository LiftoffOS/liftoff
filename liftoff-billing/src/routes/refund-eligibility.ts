// How much of an invoice may be refunded.
//
// Pure and separate from the route because this is the part that decides money,
// and because the quote and the issue must never disagree: both call this, so
// an operator cannot be shown one number and charged against another.
//
// The principle is the billing model's own. A plan fee is prepaid compute —
// `plan_included_ous x included_rate_usd_per_ou` equals the monthly fee to the
// cent — so what has been consumed has been delivered and cannot come back.
// What is refundable is what was paid for and not yet delivered.

/** Days after payment within which a monthly charge may be returned. */
export const REFUND_WINDOW_DAYS = 14;

/**
 * Share of a period's included allowance that still counts as "barely used".
 *
 * The policy promises a refund on a charge whose allowance is largely untouched,
 * which needs a line somewhere. A tenth is a starting point rather than a
 * measured one: there is no refund history to calibrate against yet, and on Core
 * it means 80 units, about $2 of compute against a $20 invoice. It is the one
 * number here worth revisiting once real requests exist.
 */
export const DE_MINIMIS_CONSUMPTION_FRACTION = 0.1;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RefundRefusal =
  | 'not_a_subscription_invoice'
  | 'nothing_left_to_refund'
  | 'outside_refund_window'
  | 'allowance_already_consumed'
  | 'term_fully_consumed';

export interface RefundEligibilityInput {
  /** The local `invoices.type`. */
  invoiceType: string;
  amountPaidCents: number;
  amountRefundedCents: number;
  paidAt: Date | null;
  /** `invoices.period_start` — when the term this invoice bought began. */
  periodStart: Date;
  isAnnual: boolean;
  /** MONTHLY allowance, even on an annual plan. */
  planIncludedOus: number;
  includedRateUsdPerOu: number;
  ousConsumedThisPeriod: number;
  now: Date;
}

export interface RefundEligibility {
  refundableCents: number;
  refusal: RefundRefusal | null;
  /** Populated for annual invoices, so a quote can show its working. */
  monthsStarted?: number;
  monthlyListCents?: number;
}

/**
 * Subscription months begun since the term started. A term in its first day has
 * begun one month, not zero: a month you are inside is a month you have started.
 */
export function monthsStarted(periodStart: Date, now: Date): number {
  let months =
    (now.getUTCFullYear() - periodStart.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - periodStart.getUTCMonth());
  // Not yet at the same day-of-month, so the latest month has not begun.
  if (now.getUTCDate() < periodStart.getUTCDate()) months -= 1;
  return Math.max(1, months + 1);
}

export function computeRefundEligibility(input: RefundEligibilityInput): RefundEligibility {
  // Only a subscription invoice. A prepaid top-up bought usage credits, which
  // are non-refundable — the exact mirror of the clawback, which touches only
  // `prepaid_reload`. Between them every invoice type has one owner.
  if (input.invoiceType !== 'subscription_cycle') {
    return { refundableCents: 0, refusal: 'not_a_subscription_invoice' };
  }

  const remaining = input.amountPaidCents - input.amountRefundedCents;
  if (!(remaining > 0)) {
    return { refundableCents: 0, refusal: 'nothing_left_to_refund' };
  }

  if (input.isAnnual) {
    // Annual is ten months' price for twelve months of service. Returning
    // unstarted months at the ANNUAL rate would hand the commitment discount to
    // somebody who did not commit, and make annual cheaper than monthly for
    // anyone leaving early. Charging the months used at MONTHLY list takes the
    // discount back, so every early exit lands on exactly the monthly price and
    // the two free months exist only on completion.
    const monthlyListCents = Math.round(
      input.planIncludedOus * input.includedRateUsdPerOu * 100,
    );
    const started = monthsStarted(input.periodStart, input.now);
    const consumedCents = started * monthlyListCents;
    const refundable = Math.min(remaining, Math.max(0, input.amountPaidCents - consumedCents));

    if (refundable === 0) {
      return {
        refundableCents: 0,
        refusal: 'term_fully_consumed',
        monthsStarted: started,
        monthlyListCents,
      };
    }
    return { refundableCents: refundable, refusal: null, monthsStarted: started, monthlyListCents };
  }

  // Monthly. There is no proration to compute — a month is the smallest thing
  // sold — so the question is only whether this charge is recent enough and
  // untouched enough to undo. Outside either, the customer has had what they
  // bought and cancellation already runs them to the end of the period.
  const paidAt = input.paidAt;
  if (!paidAt || input.now.getTime() - paidAt.getTime() > REFUND_WINDOW_DAYS * DAY_MS) {
    return { refundableCents: 0, refusal: 'outside_refund_window' };
  }

  const deMinimis = input.planIncludedOus * DE_MINIMIS_CONSUMPTION_FRACTION;
  if (input.ousConsumedThisPeriod > deMinimis) {
    return { refundableCents: 0, refusal: 'allowance_already_consumed' };
  }

  return { refundableCents: remaining, refusal: null };
}
