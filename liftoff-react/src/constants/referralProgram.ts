/**
 * The referral programme's numbers, in one place.
 *
 * The dashboard page does NOT read these: it renders what
 * `GET /api/referrals/program` serves, so the backend stays the one authority
 * on what a referral is worth and a repricing takes effect without a deploy.
 *
 * These exist for code that cannot ask the API. The mock handler reads them,
 * so dev and the tests move with the backend.
 *
 * Changing the programme is therefore: this file, and the backend.
 */

/** Credit the referrer earns per qualifying subscription, in USD. */
export const REFERRAL_REWARD_USD = 20

/** Bonus Operating Units granted to the referred workspace's first period.
 *  ONE MONTH OF CORE: it tracks Core's included allowance and moves with it, so
 *  that REFEREE_BONUS_USD below — the same grant stated in dollars — stays
 *  true. */
export const REFEREE_BONUS_OUS = 1400

/** List value of REFEREE_BONUS_OUS, in USD. Shown to people who have never used
 *  Liftoff and would otherwise have to learn what an Operating Unit is. */
export const REFEREE_BONUS_USD = 20

/** Days the referred workspace must have been paying before credit vests. */
export const REFERRAL_VESTING_DAYS = 60

/** Days after credit becomes available before it expires. Never expires before
 *  the workspace's next subscription invoice, which is what protects annual
 *  billers whose next invoice can be up to a year out. */
export const REFERRAL_EXPIRY_DAYS = 90

/** Invitations one workspace may send per day. */
export const REFERRAL_INVITES_PER_DAY = 30
