// The prepaid floor: the balance below which a pre-pay workspace stops
// being admitted to new work, before the balance is actually gone.
//
// The drain suspends an account the moment a charge takes its balance below
// zero, but spend reaches the balance late: LLM tokens and sandbox time
// arrive through the ingest run (every two minutes), and a run in flight
// keeps spending until the next admission check. A workspace admitted at a
// balance of one cent therefore spends a couple of minutes' worth of tokens
// the platform cannot recover. The floor closes that window: once a
// workspace is past its plan's allowance (the band where every charge drains
// the reload balance) and the balance is under the floor, the served
// entitlement snapshot reads as billing-suspended and every admission gate —
// the runtime's per-call gates and this service's execution guard — refuses
// new work. Sized to the booking lag, not to any single call's price.
//
// One predicate, used by every reader, so the runtime's snapshot and the
// execution guard cannot disagree on whether a workspace may spend.

export const DEFAULT_PREPAID_SPEND_FLOOR_USD = 2;

export function prepaidSpendFloorUsd(): number {
  const raw = process.env.PREPAID_SPEND_FLOOR_USD;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PREPAID_SPEND_FLOOR_USD;
}

/** Past the plan's allowance: included, precommit and the referral bonus
 *  consumed, so the next charge drains the reload balance. `bc` is the
 *  billing_controls alias in the caller's query. */
export const PAST_ALLOWANCE_SQL =
  'bc.ous_consumed_this_period >= bc.plan_included_ous + bc.precommit_extra_ous + bc.referral_bonus_ous';

/** The floor one account stops at. With auto-reload on and a threshold under
 *  the floor, the account stops at its threshold instead. Auto-reload fires
 *  only from the drain, when a charge takes the balance to the threshold; a
 *  workspace stopped above it makes no more charges, so at the plain floor the
 *  reload would never fire. At the threshold, the charge that stops the
 *  workspace is the one that fires the reload, and new work waits only while
 *  that reload lands. */
export function accountFloorUsd(
  floorUsd: number,
  autoReload: { enabled: boolean | null; thresholdUsd: string | number | null },
): number {
  if (!autoReload.enabled || autoReload.thresholdUsd == null) return floorUsd;
  const threshold = Number(autoReload.thresholdUsd);
  return Number.isFinite(threshold) ? Math.min(floorUsd, threshold) : floorUsd;
}

/** accountFloorUsd in SQL, over the `bc` alias and a bound `$floorParam`. */
export function accountFloorSql(floorParam: string): string {
  return `CASE WHEN bc.auto_reload_enabled AND bc.auto_reload_threshold_usd IS NOT NULL THEN LEAST(${floorParam}, bc.auto_reload_threshold_usd) ELSE ${floorParam} END`;
}

/** True when the workspace may not be admitted to spend: held after a payment
 *  was reported as fraud, suspended, or a pre-pay account past its allowance
 *  with a reload balance under its floor (accountFloorSql; the caller binds the
 *  floor as `$floorParam`). A missing billing row — internal and exempt
 *  accounts — reads FALSE, as it always has.
 *
 *  The hold is first because it is not a money fact and no money event lifts
 *  it: a top-up clears `suspended` and raises the balance, and a held
 *  workspace must still read as stopped afterwards. Only an operator clears
 *  it (migration 532). */
export function billingStoppedSql(floorParam: string): string {
  return `COALESCE(bc.fraud_hold_at IS NOT NULL OR bc.suspended OR (bc.billing_mode = 'pre_pay' AND ${PAST_ALLOWANCE_SQL} AND bc.reload_balance_usd < ${accountFloorSql(floorParam)}), FALSE)`;
}
