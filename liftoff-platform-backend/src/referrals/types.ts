// The referral programme's wire and row shapes.
//
// The frontend reads exactly what is in ReferralProgram and Referral — see
// liftoff-react src/services/referrals.ts, which this mirrors field for field.
// Every rule that decides money is a computed field here rather than something
// the page works out, because INV-PB-010 makes billing the one money authority
// and a local "does this workspace have a subscription" check would be a second
// one: wrong for billing-exempt tenants, enterprise contracts, and anyone whose
// subscription activated by webhook after they skipped the plan step.

/** Where a referred person has reached in the funnel. */
export type ReferralStatus = 'signed_up' | 'subscribed' | 'expired';

/**
 * Why a referral earns nothing.
 *
 * Sits on the credit rather than on the funnel status: somebody can be
 * `subscribed` and still earn nothing because they already had an account.
 */
export type ReferralIneligibleReason =
  | 'existing_account'
  | 'already_referred'
  | 'self_referral'
  | 'discounted_signup';

/** Where a conversion's credit has reached. `reversed` also carries the
 *  investigate-and-disqualify decision, which needs a state to move to. */
export type ReferralCreditStatus = 'none' | 'pending' | 'granted' | 'reversed' | 'ineligible';

/** One row of the referrals table. */
export interface ReferralRow {
  id: string;
  referrerTenantId: string;
  referredTenantId: string | null;
  referredAccountId: string;
  code: string;
  clickedAt: Date | null;
  signedUpAt: Date;
  subscribedAt: Date | null;
  status: ReferralStatus;
  ineligibleReason: ReferralIneligibleReason | null;
}

/** What liftoff-billing knows about one referral's credit. */
export interface ReferralCredit {
  referralId: string;
  amountUsd: number;
  status: 'pending' | 'granted' | 'reversed';
  availableAt: string | null;
  expiresAt: string | null;
}

/**
 * The money half of the programme payload, owned by liftoff-billing.
 *
 * `subscriptionActive` comes from billing rather than from this repo's
 * `subscriptions` mirror on purpose: billing owns Stripe, and the two flags it
 * drives (`creditRedeemable`, `canSendInvites`) are the ones the contract says
 * must never be a second authority's guess.
 */
export interface ReferralCreditSummary {
  creditEarnedUsd: number;
  creditAppliedUsd: number;
  creditAvailableUsd: number;
  convertedCount: number;
  subscriptionActive: boolean;
}

/** GET /api/referrals/program */
export interface ReferralProgramResponse {
  code: string;
  url: string;
  rewardPerReferralUsd: number;
  refereeBonusOus: number;
  refereeBonusUsd: number;
  creditEarnedUsd: number;
  creditAppliedUsd: number;
  creditAvailableUsd: number;
  creditRedeemable: boolean;
  canSendInvites: boolean;
  pendingCount: number;
  convertedCount: number;
}

/** One row of GET /api/referrals */
export interface ReferralResponse {
  id: string;
  email: string;
  name: string | null;
  status: ReferralStatus;
  signedUpAt: string;
  subscribedAt: string | null;
  creditUsd: number;
  creditStatus: ReferralCreditStatus;
  creditAvailableAt: string | null;
  creditExpiresAt: string | null;
  ineligibleReason: ReferralIneligibleReason | null;
}

/** GET /api/referrals */
export interface ReferralListResponse {
  referrals: ReferralResponse[];
  hasMore: boolean;
  nextCursor: string | null;
}

export type ReferralInviteRejectionReason =
  | 'already_invited'
  | 'already_a_customer'
  | 'invalid_email'
  /**
   * The workspace has spent its 30 invitations for the day.
   *
   * Named rather than dropped. An address that is simply not sent, and appears
   * in neither `sent` nor `rejected`, is the worst of the three outcomes: the
   * person sees a success toast for a smaller number than they typed and has no
   * way to learn which addresses went. This is the one rejection that resolves
   * itself — the same call tomorrow succeeds — so saying so is the whole value.
   */
  | 'daily_limit_reached';

/** POST /api/referrals/invites */
export interface ReferralInviteResponse {
  sent: number;
  rejected: Array<{ email: string; reason: ReferralInviteRejectionReason }>;
}
