import { http, HttpResponse } from 'msw'
import type {
  Referral,
  ReferralInviteResult,
  ReferralListPage,
  ReferralProgram,
} from '../../services/referrals'
import {
  REFEREE_BONUS_OUS,
  REFEREE_BONUS_USD,
  REFERRAL_REWARD_USD,
} from '../../constants/referralProgram'

// Six referrals covering every state the table can render: signed up but not
// converted, converted but ineligible, converted and pending, reversed,
// granted, and expired.
//
// The credit arithmetic is what the real programme produces, and the backend
// enforces it: creditEarnedUsd === creditAppliedUsd + creditAvailableUsd, with
// pending credit excluded from available, and convertedCount counting exactly
// the conversions that make up creditEarnedUsd.
//
// So two granted rows (Jordan applied, Wei available) back the $40 and the
// count of 2. Rosa is pending and contributes nothing to either. Dana was
// charged back and is excluded. Both must sit on the FIRST page: a contributor
// that only appears behind Load more leaves the default state claiming money no
// visible row earned.
const REWARD_USD = REFERRAL_REWARD_USD

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

const mockProgram: ReferralProgram = {
  code: 'k7m2q9',
  url: 'https://example.com/?ref=k7m2q9',
  rewardPerReferralUsd: REWARD_USD,
  refereeBonusOus: REFEREE_BONUS_OUS,
  refereeBonusUsd: REFEREE_BONUS_USD,
  creditEarnedUsd: 40,
  creditAppliedUsd: 20,
  creditAvailableUsd: 20,
  creditRedeemable: true,
  canSendInvites: true,
  pendingCount: 1,
  convertedCount: 2,
}

// Newest signup first, the order the contract specifies. Listed in that order
// here so dev and the tests exercise what production will send.
const mockReferrals: Referral[] = [
  {
    id: 'ref_003',
    email: 'sam@fielder-co.com',
    name: 'Sam Fielder',
    status: 'signed_up',
    signedUpAt: daysAgo(4),
    subscribedAt: null,
    creditUsd: 0,
    creditStatus: 'none',
    ineligibleReason: null,
    creditAvailableAt: null,
    creditExpiresAt: null,
  },
  {
    id: 'ref_006',
    email: 'marco@vellumtype.com',
    name: 'Marco Reyes',
    status: 'subscribed',
    signedUpAt: daysAgo(15),
    subscribedAt: daysAgo(12),
    creditUsd: 0,
    creditStatus: 'ineligible',
    ineligibleReason: 'existing_account',
    creditAvailableAt: null,
    creditExpiresAt: null,
  },
  {
    id: 'ref_002',
    email: 'rosa@harbourline.com',
    name: null,
    status: 'subscribed',
    signedUpAt: daysAgo(21),
    subscribedAt: daysAgo(9),
    creditUsd: REWARD_USD,
    creditStatus: 'pending',
    ineligibleReason: null,
    // Vests 60 days after the referred workspace started paying.
    creditAvailableAt: daysAgo(-51),
    creditExpiresAt: null,
  },
  {
    id: 'ref_009',
    email: 'wei@northgate-labs.com',
    name: 'Wei Zhang',
    status: 'subscribed',
    signedUpAt: daysAgo(30),
    subscribedAt: daysAgo(24),
    creditUsd: REWARD_USD,
    creditStatus: 'granted',
    ineligibleReason: null,
    creditAvailableAt: null,
    creditExpiresAt: null,
  },
  {
    id: 'ref_005',
    email: 'dana@kestrelworks.com',
    name: 'Dana Okafor',
    status: 'subscribed',
    signedUpAt: daysAgo(38),
    subscribedAt: daysAgo(31),
    creditUsd: REWARD_USD,
    creditStatus: 'reversed',
    ineligibleReason: null,
    creditAvailableAt: null,
    creditExpiresAt: null,
  },
  {
    id: 'ref_001',
    email: 'jordan@brightpath.io',
    name: 'Jordan Ellis',
    status: 'subscribed',
    signedUpAt: daysAgo(62),
    subscribedAt: daysAgo(55),
    creditUsd: REWARD_USD,
    creditStatus: 'granted',
    ineligibleReason: null,
    creditAvailableAt: null,
    creditExpiresAt: null,
  },
  {
    id: 'ref_004',
    email: 'priya@oldpost.co',
    name: null,
    status: 'expired',
    signedUpAt: daysAgo(190),
    subscribedAt: null,
    creditUsd: 0,
    creditStatus: 'none',
    ineligibleReason: null,
    creditAvailableAt: null,
    creditExpiresAt: null,
  },
]

/**
 * Dev state selector, in the spirit of the liftoffScore mock.
 *
 * The populated response is the useful default, which makes every other state
 * unreachable in `dev:mock`. A query parameter on the PAGE url picks one:
 *
 *   /dashboard/refer                 the six rows below
 *   /dashboard/refer?state=empty     no referrals, nothing earned
 *   /dashboard/refer?state=unpaid    earned credit, no subscription to spend it on
 *   /dashboard/refer?state=paged     a second page behind a Load more control
 *
 * MSW runs handlers in the page context, so `window.location` here is the
 * address bar, not the worker. Guarded anyway because this same file backs the
 * node server used by vitest.
 */
function devState(): string {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('state') ?? ''
}

const emptyProgram: ReferralProgram = {
  ...mockProgram,
  creditEarnedUsd: 0,
  creditAppliedUsd: 0,
  creditAvailableUsd: 0,
  pendingCount: 0,
  convertedCount: 0,
}

const unpaidProgram: ReferralProgram = {
  ...mockProgram,
  creditAppliedUsd: 0,
  creditRedeemable: false,
  canSendInvites: false,
}

/** Page two for `?state=paged`. Older signups, so the newest-first order holds
 *  across the page boundary the way the contract requires. */
const secondPage: Referral[] = [
  {
    id: 'ref_007',
    email: 'ines@calderworks.com',
    name: 'Ines Calder',
    status: 'expired',
    signedUpAt: daysAgo(240),
    subscribedAt: null,
    creditUsd: 0,
    creditStatus: 'none',
    ineligibleReason: null,
    creditAvailableAt: null,
    creditExpiresAt: null,
  },
  {
    id: 'ref_008',
    email: 'omar@lattice-nine.com',
    name: null,
    status: 'expired',
    signedUpAt: daysAgo(310),
    subscribedAt: null,
    creditUsd: 0,
    creditStatus: 'none',
    ineligibleReason: null,
    creditAvailableAt: null,
    creditExpiresAt: null,
  },
]

export const referralsHandlers = [
  http.get('*/api/referrals/program', () => {
    const state = devState()
    if (state === 'empty') return HttpResponse.json(emptyProgram)
    if (state === 'unpaid') return HttpResponse.json(unpaidProgram)
    return HttpResponse.json(mockProgram)
  }),

  http.get('*/api/referrals', ({ request }) => {
    const state = devState()
    if (state === 'empty') {
      return HttpResponse.json<ReferralListPage>({
        referrals: [], hasMore: false, nextCursor: null,
      })
    }
    if (state === 'paged') {
      // Page two is reached by passing the cursor page one handed back, so the
      // Load more control is exercised the way the real endpoint drives it.
      const cursor = new URL(request.url).searchParams.get('cursor')
      if (cursor === 'page-2') {
        return HttpResponse.json<ReferralListPage>({
          referrals: secondPage, hasMore: false, nextCursor: null,
        })
      }
      return HttpResponse.json<ReferralListPage>({
        referrals: mockReferrals, hasMore: true, nextCursor: 'page-2',
      })
    }
    return HttpResponse.json<ReferralListPage>({
      referrals: mockReferrals, hasMore: false, nextCursor: null,
    })
  }),

  // Every rejection reason is reachable in dev, keyed off the address, because
  // each one renders different copy and the daily-cap case is the only one that
  // tells somebody to come back tomorrow. Anything else sends cleanly.
  http.post('*/api/referrals/invites', async ({ request }) => {
    const body = (await request.json()) as { emails?: string[] }
    const emails = body.emails ?? []

    const rejected: ReferralInviteResult['rejected'] = []
    const sentEmails: string[] = []
    for (const email of emails) {
      if (email.includes('invited')) rejected.push({ email, reason: 'already_invited' })
      else if (email.includes('customer')) rejected.push({ email, reason: 'already_a_customer' })
      else if (email.includes('capped')) rejected.push({ email, reason: 'daily_limit_reached' })
      else sentEmails.push(email)
    }

    return HttpResponse.json<ReferralInviteResult>({
      sent: sentEmails.length,
      rejected,
    })
  }),
]
