// How much of an invoice may be refunded.
//
// This is the part that decides money, so it is tested apart from the route.
// The annual formula carries most of the weight: the obvious reading of it —
// return the unstarted months at the annual rate — is wrong in a way that costs
// real money, because it hands the commitment discount to somebody who did not
// commit and makes annual strictly cheaper than monthly for anyone who leaves
// early. The table below is what stops that reading coming back.

import { describe, it, expect } from '@jest/globals';
import {
  computeRefundEligibility,
  monthsStarted,
  REFUND_WINDOW_DAYS,
  DE_MINIMIS_CONSUMPTION_FRACTION,
  type RefundEligibilityInput,
} from './refund-eligibility.js';

const DAY = 24 * 60 * 60 * 1000;
const TERM_START = new Date('2026-01-15T00:00:00Z');

/** Scale: 9 200 units a month at $0.021739 = $200.00 monthly, $2 000 annual. */
function scaleAnnual(overrides: Partial<RefundEligibilityInput> = {}): RefundEligibilityInput {
  return {
    invoiceType: 'subscription_cycle',
    amountPaidCents: 200_000,
    amountRefundedCents: 0,
    paidAt: TERM_START,
    periodStart: TERM_START,
    isAnnual: true,
    planIncludedOus: 9200,
    includedRateUsdPerOu: 0.021739,
    ousConsumedThisPeriod: 0,
    now: TERM_START,
    ...overrides,
  };
}

/** Core: 800 units a month at $0.025 = $20.00 monthly. */
function coreMonthly(overrides: Partial<RefundEligibilityInput> = {}): RefundEligibilityInput {
  return {
    invoiceType: 'subscription_cycle',
    amountPaidCents: 2_000,
    amountRefundedCents: 0,
    paidAt: TERM_START,
    periodStart: TERM_START,
    isAnnual: false,
    planIncludedOus: 800,
    includedRateUsdPerOu: 0.025,
    ousConsumedThisPeriod: 0,
    now: new Date(TERM_START.getTime() + 2 * DAY),
    ...overrides,
  };
}

describe('months started', () => {
  it('counts the month you are inside as started', () => {
    expect(monthsStarted(TERM_START, TERM_START)).toBe(1);
    expect(monthsStarted(TERM_START, new Date('2026-01-31T00:00:00Z'))).toBe(1);
  });

  it('does not advance until the same day of the next month', () => {
    expect(monthsStarted(TERM_START, new Date('2026-02-10T00:00:00Z'))).toBe(1);
    expect(monthsStarted(TERM_START, new Date('2026-02-15T00:00:00Z'))).toBe(2);
  });

  it('counts across a year boundary', () => {
    expect(monthsStarted(TERM_START, new Date('2027-01-15T00:00:00Z'))).toBe(13);
  });
});

describe('an annual invoice', () => {
  // Annual is ten months' price for twelve months of service. Every early exit
  // must therefore land on exactly the monthly price, and the discount must
  // exist only on completion.
  const cases: Array<[string, string, number, number]> = [
    ['month 1', '2026-01-20T00:00:00Z', 1, 180_000],
    ['month 4', '2026-04-20T00:00:00Z', 4, 120_000],
    ['month 9', '2026-09-20T00:00:00Z', 9, 20_000],
  ];

  it.each(cases)('at %s returns what was paid less the months started at monthly list', (_label, nowIso, expectedMonths, expectedRefund) => {
    const result = computeRefundEligibility(scaleAnnual({ now: new Date(nowIso) }));
    expect(result.monthsStarted).toBe(expectedMonths);
    expect(result.refundableCents).toBe(expectedRefund);
    expect(result.refusal).toBeNull();
  });

  // The floor. Ten months at $200 is the whole $2 000 annual fee, so from month
  // ten there is nothing left — and the customer keeps months eleven and twelve,
  // which is the discount they earned by completing.
  it('reaches zero at month ten and never goes negative', () => {
    for (const nowIso of ['2026-10-20T00:00:00Z', '2026-12-20T00:00:00Z', '2027-01-20T00:00:00Z']) {
      const result = computeRefundEligibility(scaleAnnual({ now: new Date(nowIso) }));
      expect(result.refundableCents).toBe(0);
      expect(result.refusal).toBe('term_fully_consumed');
    }
  });

  it('derives the monthly list price from the allowance and rate', () => {
    // The identity the whole billing model rests on: included OUs x rate is the
    // monthly fee to the cent.
    expect(computeRefundEligibility(scaleAnnual()).monthlyListCents).toBe(20_000);
  });

  it('is not gated on the 14 day window — the proration is the policy', () => {
    const result = computeRefundEligibility(
      scaleAnnual({ now: new Date('2026-04-20T00:00:00Z'), paidAt: TERM_START }),
    );
    expect(result.refusal).toBeNull();
  });

  it('nets off what was already refunded', () => {
    const result = computeRefundEligibility(
      scaleAnnual({ now: new Date('2026-04-20T00:00:00Z'), amountRefundedCents: 100_000 }),
    );
    expect(result.refundableCents).toBe(100_000);
  });
});

describe('a monthly invoice', () => {
  it('returns the whole charge when it is recent and barely used', () => {
    const result = computeRefundEligibility(coreMonthly());
    expect(result.refundableCents).toBe(2_000);
    expect(result.refusal).toBeNull();
  });

  it('refuses outside the window', () => {
    const result = computeRefundEligibility(
      coreMonthly({ now: new Date(TERM_START.getTime() + (REFUND_WINDOW_DAYS + 1) * DAY) }),
    );
    expect(result.refusal).toBe('outside_refund_window');
    expect(result.refundableCents).toBe(0);
  });

  it('refuses once the allowance has been used', () => {
    const justOver = 800 * DE_MINIMIS_CONSUMPTION_FRACTION + 1;
    const result = computeRefundEligibility(coreMonthly({ ousConsumedThisPeriod: justOver }));
    expect(result.refusal).toBe('allowance_already_consumed');
  });

  it('allows a charge sitting exactly on the de minimis line', () => {
    const result = computeRefundEligibility(
      coreMonthly({ ousConsumedThisPeriod: 800 * DE_MINIMIS_CONSUMPTION_FRACTION }),
    );
    expect(result.refusal).toBeNull();
  });

  it('refuses an invoice that was never paid', () => {
    expect(computeRefundEligibility(coreMonthly({ paidAt: null })).refusal).toBe('outside_refund_window');
  });
});

describe('what is out of scope entirely', () => {
  // The mirror of the clawback, which touches only prepaid_reload. Between the
  // two, every invoice type has exactly one owner.
  it('refuses a prepaid top-up, because credit is non-refundable', () => {
    const result = computeRefundEligibility(coreMonthly({ invoiceType: 'prepaid_reload' }));
    expect(result.refusal).toBe('not_a_subscription_invoice');
    expect(result.refundableCents).toBe(0);
  });

  it.each(['threshold', 'recovery', 'unknown'])('refuses a %s invoice', (invoiceType) => {
    expect(computeRefundEligibility(coreMonthly({ invoiceType })).refusal).toBe(
      'not_a_subscription_invoice',
    );
  });

  it('refuses when the whole charge has already come back', () => {
    const result = computeRefundEligibility(coreMonthly({ amountRefundedCents: 2_000 }));
    expect(result.refusal).toBe('nothing_left_to_refund');
  });
});
