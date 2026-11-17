// One predicate decides whether a workspace may spend: held after a payment
// was reported as fraud, suspended, or a pre-pay account past its allowance
// with a reload balance under the floor. The served snapshot and the execution
// guard read the same rule.

import { accountFloorUsd, billingStoppedSql, PAST_ALLOWANCE_SQL, prepaidSpendFloorUsd, DEFAULT_PREPAID_SPEND_FLOOR_USD } from '../prepaid-floor';

afterEach(() => { delete process.env.PREPAID_SPEND_FLOOR_USD; });

it('defaults the floor and honours a configured one, refusing nonsense', () => {
  expect(prepaidSpendFloorUsd()).toBe(DEFAULT_PREPAID_SPEND_FLOOR_USD);
  process.env.PREPAID_SPEND_FLOOR_USD = '5';
  expect(prepaidSpendFloorUsd()).toBe(5);
  process.env.PREPAID_SPEND_FLOOR_USD = 'lots';
  expect(prepaidSpendFloorUsd()).toBe(DEFAULT_PREPAID_SPEND_FLOOR_USD);
  process.env.PREPAID_SPEND_FLOOR_USD = '-1';
  expect(prepaidSpendFloorUsd()).toBe(DEFAULT_PREPAID_SPEND_FLOOR_USD);
});

it('the predicate reads FALSE for a missing billing row, counts the referral bonus in the allowance, and binds the floor where told', () => {
  const sql = billingStoppedSql('$2');
  expect(sql.startsWith('COALESCE(')).toBe(true);
  expect(sql.endsWith(', FALSE)')).toBe(true);
  expect(sql).toContain('bc.suspended OR (');
  expect(sql).toContain("bc.billing_mode = 'pre_pay'");
  expect(sql).toContain(PAST_ALLOWANCE_SQL);
  expect(PAST_ALLOWANCE_SQL).toContain('bc.referral_bonus_ous');
  expect(sql).toContain('bc.reload_balance_usd < CASE WHEN bc.auto_reload_enabled');
});

// The hold is the one term no money event lifts. A top-up clears `suspended`
// and raises the balance in the same statement, so if the hold were expressed
// through either of those a stolen card's own top-up would release the
// workspace it had just got held.
it('a fraud hold stops the workspace on its own, unconditionally', () => {
  const sql = billingStoppedSql('$2');
  expect(sql).toContain('bc.fraud_hold_at IS NOT NULL');

  // Its own top-level disjunct, ahead of the money terms: not inside the
  // pre_pay parenthesis, where it would only apply to one billing mode, and
  // not qualified by the balance or the allowance.
  const hold = 'bc.fraud_hold_at IS NOT NULL OR ';
  expect(sql.startsWith(`COALESCE(${hold}`)).toBe(true);
  expect(sql.indexOf('bc.fraud_hold_at')).toBeLessThan(sql.indexOf("bc.billing_mode = 'pre_pay'"));
});

// Auto-reload fires only from the drain, when a charge takes the balance to
// the threshold. A workspace stopped above its threshold makes no charge, so
// its reload would never fire; with auto-reload on, it stops at the lower of
// the two instead.
it('an account with auto-reload on stops at its threshold when that is under the floor', () => {
  expect(accountFloorUsd(2, { enabled: true, thresholdUsd: '1.00' })).toBe(1);
  expect(accountFloorUsd(2, { enabled: true, thresholdUsd: 10 })).toBe(2);
  expect(accountFloorUsd(2, { enabled: false, thresholdUsd: '1.00' })).toBe(2);
  expect(accountFloorUsd(2, { enabled: null, thresholdUsd: null })).toBe(2);
  expect(accountFloorUsd(2, { enabled: true, thresholdUsd: null })).toBe(2);

  const sql = billingStoppedSql('$2');
  expect(sql).toContain('CASE WHEN bc.auto_reload_enabled AND bc.auto_reload_threshold_usd IS NOT NULL THEN LEAST($2, bc.auto_reload_threshold_usd) ELSE $2 END');
});
