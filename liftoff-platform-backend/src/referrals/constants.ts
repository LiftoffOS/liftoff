// The programme's numbers, in one place on the server side.
//
// The backend is the pricing authority: the dashboard renders what
// GET /api/referrals/program serves, so a repricing takes effect without a
// frontend deploy. The mirror in liftoff-react's src/constants/referralProgram.ts
// exists only for /referral/terms, which is public, has no tenant and no auth,
// and therefore cannot ask the API. Repricing is those two files.

/** Credit the referrer earns per qualifying subscription, in USD. Flat, on
 *  every plan, with no cap on the number of referrals or the total. The 60 day
 *  vesting hold is what makes a flat amount safe: Core is $20/month, so earning
 *  $20 costs the referred side two paid months. */
export const REFERRAL_REWARD_USD = 20;

/** Bonus Operating Units granted to the referred workspace's first billing
 *  period. Compute rather than money off the invoice, deliberately: a $20
 *  discount would zero a $20 Core invoice, disqualifying the referral under the
 *  full-price rule and halving the cost of manufacturing one.
 *
 *  It is ONE MONTH OF CORE, which is the rule that fixes the number: it tracks
 *  Core's included allowance, and moves with it. REFEREE_BONUS_USD below is the
 *  same grant stated in dollars, so the two only stay consistent if this
 *  follows the allowance rather than holding a unit count. */
export const REFEREE_BONUS_OUS = 1400;

/** List value of REFEREE_BONUS_OUS, in USD. Served rather than derived, because
 *  multiplying units by a rate in the frontend would make that page a second
 *  pricing authority and would go quietly wrong the moment OU pricing changed.
 *  Shown in dollars because the person being invited has never used Liftoff and
 *  would have to learn what an Operating Unit is before the offer meant
 *  anything. */
export const REFEREE_BONUS_USD = 20;

// The 60 day vesting hold and the 90 day expiry timer are deliberately NOT here.
// Nothing in this plane reads them: vesting, expiry and application all happen
// where the invoice is, in liftoff-billing, and its own constants are the ones
// that decide. Mirroring them here would put two numbers in the estate with no
// mechanism keeping them equal, and only one of them doing anything — which is
// how a repricing ends up half-applied.

/** Attribution window, click to ACCOUNT CREATION — not click to payment. Last
 *  touch wins. Someone who signs up on day 29 and subscribes in month four
 *  still earns the referrer credit, because the code is bound at account
 *  creation and the earning event is the first paid invoice. */
export const REFERRAL_ATTRIBUTION_WINDOW_DAYS = 30;

/**
 * Days a signup may sit without converting before its row reads `expired`.
 *
 * PRESENTATIONAL ONLY, and that is the important part. It does not disqualify
 * anything: the conversion event is the first full-priced paid invoice whenever
 * it arrives, so a workspace that subscribes on day 200 still earns the
 * referrer credit and its row moves straight back to `subscribed`. What the
 * status does is stop a signup from sitting in `pendingCount` forever, while
 * keeping the row visible — the list must not silently shrink under somebody
 * who is counting.
 *
 * Six months, which is longer than every other clock in the programme (30 day
 * attribution, 60 day vesting, 90 day credit expiry) because it is the only one
 * that describes a person changing their mind rather than a rule being applied.
 */
export const REFERRAL_SIGNUP_EXPIRY_DAYS = 180;

/** Invitations one workspace may send per day. No lifetime cap, consistent with
 *  the no-cap decision on rewards. */
export const REFERRAL_INVITES_PER_DAY = 30;

/** Longest free-text note allowed on an invitation. */
export const REFERRAL_INVITE_MESSAGE_MAX = 500;

/** Most addresses one call may carry. Below the daily cap so a single request
 *  cannot spend the whole day's budget in one badly-formed paste. */
export const REFERRAL_INVITE_BATCH_MAX = 30;

// ── The acceptance-ratio throttle ────────────────────────────────────────────
//
// Left open by the plan; these are the thresholds chosen. A workspace has to
// have sent enough invitations for a ratio to mean anything before the ratio is
// allowed to say anything, so the floor comes first: below it, nothing is
// throttled. Above it, an acceptance rate under the floor takes `canSendInvites`
// away. Spam has a near-zero acceptance rate, so this targets behaviour rather
// than penalising an effective referrer, which a fixed cap alone cannot do.
//
// 20 is two thirds of one day's cap: a legitimate referrer sending to a real
// list clears it in one sitting, and so does a spammer, but only one of them
// gets replies. 10% is well above the acceptance rate of address-list spam and
// well below what any genuine personal recommendation achieves.

/** Invitations a workspace must have sent before the ratio is consulted. */
export const REFERRAL_THROTTLE_MIN_SENT = 20;

/** Acceptance rate below which sending is withdrawn, once the floor is passed. */
export const REFERRAL_THROTTLE_MIN_ACCEPTANCE_RATIO = 0.1;
