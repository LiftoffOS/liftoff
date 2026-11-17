// Referral Service
//
// The referral program: every workspace gets one shareable link. When someone
// who arrives on that link subscribes to a paid plan, the referring workspace
// earns account credit that is applied against later months of its own
// subscription.
//
// Amounts cross the wire in whole dollars (USD), matching the billing service,
// which reports every other balance the same way. The reward per conversion is
// served rather than hard-coded here so the program can be repriced without a
// frontend deploy.

import { api } from './api'

// ── Types ──────────────────────────────────────────────────────────────────

export interface ReferralProgram {
  /** The workspace's referral code, e.g. "acme-7f3a". Stable for the life of
   *  the workspace: links already sent must keep working. */
  code: string
  /** Canonical share URL built by the backend so the origin matches the
   *  environment the workspace actually lives in. */
  url: string
  /** Credit earned per conversion, in USD. Paid to the referrer. */
  rewardPerReferralUsd: number
  /** Bonus Operating Units added to the referred workspace's first month.
   *
   *  Deliberately NOT money off their first invoice. A dollar discount equal to
   *  the cheapest plan would zero that invoice, which would both disqualify the
   *  referral under the full-price rule and halve the cost of manufacturing one
   *  (two paid months become one). Granting compute instead leaves the invoice
   *  full-priced and the fraud arithmetic unchanged, and costs marginal
   *  inference rather than revenue. */
  refereeBonusOus: number
  /** List value of `refereeBonusOus`, in USD, for display only.
   *
   *  Served rather than derived. Multiplying Operating Units by a per-unit rate
   *  in the frontend would make this page a second pricing authority, which
   *  INV-PB-010 forbids, and it would silently go wrong the moment OU pricing
   *  changes for a plan.
   *
   *  Shown in dollars because the person being invited has never used Liftoff
   *  and does not know what an Operating Unit is. Denominating a usage grant in
   *  currency is what the comparable platforms do: Hyperagent says "$1,000 in
   *  credits", DigitalOcean and Akamai say "$100 credit". The grant itself is
   *  still Operating Units, and the terms say so. */
  refereeBonusUsd: number
  /** Total credit earned to date, in USD. */
  creditEarnedUsd: number
  /** Portion of the earned credit already consumed by past invoices, in USD. */
  creditAppliedUsd: number
  /** Credit still waiting to reduce a future invoice, in USD. */
  creditAvailableUsd: number
  /** People who signed up on the link but have not subscribed yet. */
  pendingCount: number
  /** Whether this workspace can currently apply credit to an invoice.
   *
   *  False for a workspace with no active subscription, which can still earn
   *  and accumulate credit but has nothing to spend it against. Server-computed
   *  for the same reason as `canSendInvites`: billing is the one money
   *  authority, and a local check would be wrong for billing-exempt tenants and
   *  enterprise contracts. */
  creditRedeemable: boolean
  /** Whether this workspace may send referral invitations by email.
   *
   *  Server-computed, never derived here. INV-PB-010 makes billing the one
   *  money authority, and a local "does it have a subscription" check would be
   *  a second one: wrong for billing-exempt tenants, enterprise contracts, and
   *  anyone whose subscription activated by webhook after they skipped the plan
   *  step. The page renders the control from this flag; the endpoint still
   *  answers 402 and is the actual enforcement.
   *
   *  Gated because the invite endpoint sends mail from a Liftoff domain to
   *  addresses the caller chooses. An unpaid workspace costs an email address
   *  to create, which would make that a mail relay wearing our sending
   *  reputation. Sharing the link is not gated: a link is inert until clicked. */
  canSendInvites: boolean
  /** Conversions that earned credit. A subscriber whose payment was later
   *  charged back is not counted here, so this number and `creditEarnedUsd`
   *  always agree: the page renders them in one sentence. */
  convertedCount: number
}

/** Where a referred person has reached in the funnel.
 *
 *  `signed_up` is the state that earns nothing yet; `subscribed` is the one
 *  that pays. `expired` covers a sign-up that never converted inside the
 *  attribution window, and is kept visible so the list does not silently
 *  shrink under someone who is counting. */
export type ReferralStatus = 'signed_up' | 'subscribed' | 'expired'

/** Where a conversion's credit has reached.
 *
 *  `pending`  earned, but not yet spendable. Credit vests only once the
 *             reversal risk on the referred subscription has largely passed,
 *             so a chargeback usually lands here and costs nothing to undo.
 *  `granted`  vested and spendable against a subscription invoice.
 *  `reversed` the payment that earned it was refunded or charged back.
 *  `ineligible` the referral does not earn, under the exclusions in the terms.
 *
 *  Ineligibility is a property of the CREDIT, not of the person. Somebody can
 *  be `subscribed` and still earn nothing, because they already had a Liftoff
 *  account. Folding that into the funnel status would conflate two independent
 *  axes and lose the fact that they did subscribe.
 *
 *  `pending` credit is deliberately excluded from `creditAvailableUsd`: the
 *  page presents that figure as what comes off the next invoice, and pending
 *  credit does not. */
export type ReferralCreditStatus = 'none' | 'pending' | 'granted' | 'reversed' | 'ineligible'

export interface Referral {
  id: string
  /** The referred person's address, in full.
   *
   *  Deliberately never masked. This page reports what a workspace earned, and
   *  a partially blanked address on a row that paid them credit reads as the
   *  product hiding something. Display only, never a form value. */
  email: string
  /** Null until the referred person fills in a name. */
  name: string | null
  status: ReferralStatus
  signedUpAt: string
  /** Set only once the referred person starts paying. */
  subscribedAt: string | null
  /** Credit this referral earned, in USD. Zero until it converts. */
  creditUsd: number
  creditStatus: ReferralCreditStatus
  /** When `pending` credit becomes spendable. Null when it already is, or when
   *  there is nothing to wait for.
   *
   *  "Pending" on its own is the opaque case: it tells somebody their money is
   *  not available without telling them when it will be. */
  creditAvailableAt: string | null
  /** Why this referral earns nothing, when `creditStatus` is `ineligible`.
   *
   *  Required rather than optional in spirit: every exclusion in the terms is
   *  something the referrer cannot control and cannot see. Without a reason the
   *  row is a person who signed up, subscribed, and silently paid nothing, which
   *  reads as the programme not working. */
  ineligibleReason:
    | 'existing_account'
    | 'already_referred'
    | 'self_referral'
    | 'discounted_signup'
    | null
  /** When granted credit expires, if it does. Null when it does not.
   *
   *  Credit that disappears on a date the customer was never shown is the same
   *  trust problem as a redacted address. Hyperagent shows balance and expiry
   *  together in its billing settings for the same reason. */
  creditExpiresAt: string | null
}

/** A page of referrals, **newest signup first**.
 *
 *  The order is the backend's to hold, not this page's: sorting client-side
 *  would only order the rows already fetched, and would silently disagree with
 *  the cursor. Cursor pagination needs a stable total order or pages duplicate
 *  and skip rows.
 *
 *  Sorted on `signedUpAt` rather than on the most recent event per row, because
 *  every referral has one and it never changes meaning. Ties break on `id`. */
export interface ReferralListPage {
  referrals: Referral[]
  hasMore: boolean
  nextCursor: string | null
}

/** One address the invite could not be sent to, and why.
 *
 *  `daily_limit_reached` is the only one that resolves itself: the workspace has
 *  spent its 30 invitations for the day and the same call tomorrow succeeds. It
 *  is named rather than left out because an address that appears in neither
 *  `sent` nor `rejected` shows the person a success toast for a smaller number
 *  than they typed, with no way to learn which addresses went. */
export interface ReferralInviteRejection {
  email: string
  reason: 'already_invited' | 'already_a_customer' | 'invalid_email' | 'daily_limit_reached'
}

export interface ReferralInviteResult {
  sent: number
  rejected: ReferralInviteRejection[]
}

// ── Calls ──────────────────────────────────────────────────────────────────

export async function getReferralProgram(tenantId: string): Promise<ReferralProgram> {
  return api.get<ReferralProgram>(`/api/referrals/program?tenantId=${tenantId}`)
}

export async function listReferrals(
  tenantId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<ReferralListPage> {
  const params = new URLSearchParams({ tenantId })
  if (options.limit) params.set('limit', String(options.limit))
  if (options.cursor) params.set('cursor', options.cursor)
  return api.get<ReferralListPage>(`/api/referrals?${params.toString()}`)
}

export async function sendReferralInvites(
  tenantId: string,
  emails: string[],
  message?: string
): Promise<ReferralInviteResult> {
  return api.post<ReferralInviteResult>(`/api/referrals/invites?tenantId=${tenantId}`, {
    emails,
    message,
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** The link to put in front of a person.
 *
 *  Prefers the backend's canonical URL. The fallback exists because the link is
 *  the entire point of the page: a program payload that arrives without a url
 *  should still leave something copyable on screen rather than an empty field. */
export function referralLink(program: Pick<ReferralProgram, 'code' | 'url'>): string {
  if (program.url) return program.url
  if (!program.code) return ''
  return `${window.location.origin}/?ref=${encodeURIComponent(program.code)}`
}

/** Splits a pasted or typed list of addresses on commas, semicolons, and
 *  whitespace, so "a@x.com, b@y.com" and a pasted column both work. */
export function parseEmailList(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidReferralEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email)
}
