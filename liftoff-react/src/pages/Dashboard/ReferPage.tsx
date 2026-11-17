import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, PageHeader, StatusBadge } from '../../components'
import ErrorState from '../../components/ErrorState'
import ReferralIllustration from '../../components/ReferralIllustration'
import { useToast } from '../../contexts/ToastContext'
import { useTenant } from '../../hooks/useTenant'
import {
  useLoadMoreReferrals,
  useReferralProgram,
  useReferrals,
  useSendReferralInvites,
} from '../../hooks/useReferrals'
import {
  isValidReferralEmail,
  parseEmailList,
  referralLink,
  type Referral,
  type ReferralInviteRejection,
} from '../../services/referrals'
import { formatUsd } from '../../utils/formatCurrency'
import { track } from '../../lib/analytics'
import CopyIcon from '../../assets/icons/copy.svg?react'
import MailIcon from '../../assets/icons/mail.svg?react'
import UserRoundPlusIcon from '../../assets/icons/user-round-plus.svg?react'
import LinkedInIcon from '../../assets/icons/linkedin.svg?react'
import XSocialIcon from '../../assets/icons/x-social.svg?react'
import FacebookIcon from '../../assets/icons/facebook.svg?react'
import WhatsappIcon from '../../assets/icons/whatsapp.svg?react'
import RedditIcon from '../../assets/icons/reddit.svg?react'
import './ReferPage.css'

/** What a conversion is worth, used only until the served program arrives.
 *
 *  The number is the whole point of the page, so the explainer has to read as
 *  a sentence from the first paint rather than as a gap that fills in. The
 *  served value still wins the moment it lands. */
const DEFAULT_REWARD_USD = 20

/** Line that travels with the link on every social network.
 *
 *  Two jobs, in this order: say what makes Liftoff different, then say what the
 *  recipient gets. "Click my link so I get $20" is a favour to ask; an offer is
 *  something worth clicking.
 *
 *  The amount is deliberately NOT named here. $20 reads as small to somebody
 *  who has never used Liftoff and has no sense of what an Operating Unit buys,
 *  so the number argues against the offer rather than for it. `bonusUsd` is
 *  still taken, but only to decide whether there is an offer to mention at all.
 *  The referrer sees the exact figure on the page; the recipient sees an offer.
 *
 *  Ends on a full stop, not a colon. A colon promises that the link follows
 *  immediately, which is true only of WhatsApp, where the URL is concatenated
 *  onto the same line. X and Reddit take the URL as a separate parameter, and
 *  the mail client puts it two lines down, so there a trailing colon just
 *  dangles. On Reddit it is worse than dangling: the message is the post
 *  TITLE, and titles do not end in colons.
 *
 *  Deliberately "bonus usage", never "bonus credits". The referee reward is
 *  Operating Units, and calling it credit is the exact confusion the programme
 *  is designed against: a $20 CREDIT would reduce a $20 Core invoice to zero,
 *  which disqualifies the referral under the full-price rule and halves the
 *  cost of manufacturing one. Section 3 of /referral/terms also states the
 *  bonus is "not exchangeable for money or account credit", so promising
 *  credit in the share text would contradict the terms it links to. */
function shareMessage(bonusUsd: number): string {
  return bonusUsd > 0
    ? 'Liftoff gives you agents that work for your business 24/7. Get bonus usage when you subscribe.'
    : 'Liftoff gives you agents that work for your business 24/7.'
}

const EMAIL_SUBJECT = 'Something worth a look for your business'

type ShareChannel = 'linkedin' | 'x' | 'facebook' | 'whatsapp' | 'reddit'

interface ShareTarget {
  channel: ShareChannel
  label: string
  icon: React.ReactNode
  href: (url: string) => string
}

const shareTargets = (message: string): ShareTarget[] => [
  {
    channel: 'linkedin',
    label: 'Share on LinkedIn',
    icon: <LinkedInIcon width="16" height="16" />,
    href: (url) =>
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  },
  {
    channel: 'x',
    label: 'Share on X',
    icon: <XSocialIcon width="15" height="15" />,
    href: (url) =>
      `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(message)}`,
  },
  {
    channel: 'whatsapp',
    label: 'Share on WhatsApp',
    icon: <WhatsappIcon width="16" height="16" />,
    href: (url) => `https://wa.me/?text=${encodeURIComponent(`${message} ${url}`)}`,
  },
  {
    channel: 'facebook',
    label: 'Share on Facebook',
    icon: <FacebookIcon width="16" height="16" />,
    href: (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
  },
  {
    channel: 'reddit',
    label: 'Share on Reddit',
    icon: <RedditIcon width="16" height="16" />,
    href: (url) =>
      `https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(message)}`,
  },
]

/** Money the way this page talks about it.
 *
 *  The reward and the credit balances are whole dollars in practice, and
 *  "$20.00 off your bill" reads like a receipt rather than an offer. Cents are
 *  shown only when there actually are some, which a partly consumed credit
 *  balance can produce. */
function formatMoney(usd: number): string {
  return Number.isInteger(usd) ? `$${usd.toLocaleString('en-US')}` : formatUsd(usd)
}

function formatDate(iso: string): string {
  // Full month name: the two date columns have width to spare, and there is no
  // reason to make somebody read an abbreviation.
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Why a referral earns nothing.
 *
 *  Every one of these is outside the referrer's control, so the row has to say
 *  which rule fired. A blank reads as the programme quietly not paying, and an
 *  unexplained "Not eligible" is worse on the self-referral rule than on any
 *  other, because that is the one somebody is most likely to want to contest.
 *
 *  The self-referral wording names the rule without asserting intent. The signal
 *  is a match on account details, and it can be a false positive: two people at
 *  one company, or a shared corporate card. "Same account details" is what was
 *  actually observed. Calling it self-referral in a table cell would state a
 *  motive we cannot see. */
function describeIneligible(reason: Referral['ineligibleReason']): string {
  switch (reason) {
    case 'existing_account':
      return 'Not eligible: existing account'
    case 'already_referred':
      return 'Not eligible: already referred'
    case 'discounted_signup':
      return 'Not eligible: discounted signup'
    case 'self_referral':
      return 'Not eligible: same account details'
    default:
      return 'Not eligible'
  }
}

/** Why an address was skipped, in words the sender can act on. */
function describeRejection(rejection: ReferralInviteRejection): string {
  switch (rejection.reason) {
    case 'already_invited':
      return `${rejection.email} was already invited`
    case 'already_a_customer':
      return `${rejection.email} already uses Liftoff`
    case 'daily_limit_reached':
      // The one rejection that is about the sender rather than the address, and
      // the one that fixes itself, so it says when to try again.
      return `${rejection.email} was not sent: the daily invitation limit was reached. Try again tomorrow`
    default:
      return `${rejection.email} is not a valid address`
  }
}

// ─── Referred person row ─────────────────────────────────────────────────────

function ReferralRow({ referral }: { referral: Referral }) {
  const converted = referral.status === 'subscribed'

  return (
    <tr className="refer-table__row">
      <td className="refer-table__cell">
        <span className="refer-table__name">{referral.name ?? referral.email}</span>
        {referral.name && <span className="refer-table__sub">{referral.email}</span>}
      </td>
      <td className="refer-table__cell">
        {converted ? (
          <StatusBadge variant="success">Subscribed</StatusBadge>
        ) : referral.status === 'signed_up' ? (
          <StatusBadge variant="neutral">Signed up</StatusBadge>
        ) : (
          <StatusBadge variant="draft">Expired</StatusBadge>
        )}
      </td>
      {/* Two dated columns rather than one that changes meaning per row. A
          single "Date" showed the subscription date where there was one and the
          sign-up date otherwise, so the same header meant different things down
          the column, and an expired row read as though it expired on the day it
          signed up. */}
      <td className="refer-table__cell refer-table__cell--muted">
        {formatDate(referral.signedUpAt)}
      </td>
      <td className="refer-table__cell refer-table__cell--muted">
        {referral.subscribedAt ? formatDate(referral.subscribedAt) : 'Not yet'}
      </td>
      <td className="refer-table__cell refer-table__cell--amount">
        {/* Both shapes are amount-then-qualifier, so the column reads down the
            page as one thing: "$20 / Pending" against "- / Not earned yet". A
            bare qualifier on its own line sat where the figures were not. */}
        {referral.creditStatus === 'ineligible' ? (
          <>
            <span className="refer-table__credit refer-table__credit--none">-</span>
            <span className="refer-table__sub">{describeIneligible(referral.ineligibleReason)}</span>
          </>
        ) : referral.creditStatus === 'reversed' ? (
          // The row keeps its place. A conversion that was paid and then charged
          // back is something the referrer should be able to see happened,
          // rather than a row that silently loses its figure.
          <>
            <span className="refer-table__credit refer-table__credit--none">-</span>
            <span className="refer-table__sub">Reversed</span>
          </>
        ) : referral.creditUsd > 0 ? (
          <>
            <span className="refer-table__credit">{formatMoney(referral.creditUsd)}</span>
            {/* The sub-line carries the date the amount above it depends on:
                when pending credit turns spendable, or when granted credit runs
                out. A bare "Pending" says the money is not available without
                saying when it will be. */}
            {referral.creditStatus === 'pending' && (
              <span className="refer-table__sub">
                {referral.creditAvailableAt
                  ? `Available ${formatDate(referral.creditAvailableAt)}`
                  : 'Pending'}
              </span>
            )}
            {referral.creditStatus === 'granted' && referral.creditExpiresAt && (
              <span className="refer-table__sub">
                Expires {formatDate(referral.creditExpiresAt)}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="refer-table__credit refer-table__credit--none">-</span>
            <span className="refer-table__sub">Not earned yet</span>
          </>
        )}
      </td>
    </tr>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ReferPage() {
  const { currentTenant } = useTenant()
  const tenantId = currentTenant?.id ?? ''
  const { showToast } = useToast()

  const programQuery = useReferralProgram()
  const referralsQuery = useReferrals()
  const sendInvites = useSendReferralInvites()
  const loadMore = useLoadMoreReferrals()

  const program = programQuery.data
  const reward = program?.rewardPerReferralUsd ?? DEFAULT_REWARD_USD
  const link = program ? referralLink(program) : ''

  const [emailsRaw, setEmailsRaw] = useState('')
  const [note, setNote] = useState('')
  // The invite form is the heaviest thing on the page and the least used, so it
  // opens on request instead of sitting there with two empty fields.
  const [inviteOpen, setInviteOpen] = useState(false)
  const emailsRef = useRef<HTMLTextAreaElement>(null)

  const { valid, invalid } = useMemo(() => {
    const parsed = parseEmailList(emailsRaw)
    return {
      valid: parsed.filter(isValidReferralEmail),
      invalid: parsed.filter((email) => !isValidReferralEmail(email)),
    }
  }, [emailsRaw])

  // Opening the form should put the cursor where the person is about to type.
  useEffect(() => {
    if (inviteOpen) emailsRef.current?.focus()
  }, [inviteOpen])

  const viewedRef = useRef(false)
  useEffect(() => {
    if (!tenantId || viewedRef.current) return
    viewedRef.current = true
    track('referral_page_viewed', { tenant_id: tenantId })
  }, [tenantId])

  const copy = async (value: string, surface: 'link_field' | 'code', label: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      track('referral_link_copied', { tenant_id: tenantId, surface })
      showToast(`${label} copied`, 'success')
    } catch {
      showToast('Could not copy. Please select the text and copy it by hand.', 'error')
    }
  }

  const share = (target: ShareTarget) => {
    if (!link) return
    track('referral_link_shared', { tenant_id: tenantId, channel: target.channel })
    window.open(target.href(link), '_blank', 'noopener,noreferrer')
  }

  const shareByMailClient = () => {
    if (!link) return
    track('referral_link_shared', { tenant_id: tenantId, channel: 'email_client' })
    const body = `${shareMessage(program?.refereeBonusUsd ?? 0)}\n\n${link}`
    window.location.href = `mailto:?subject=${encodeURIComponent(EMAIL_SUBJECT)}&body=${encodeURIComponent(body)}`
  }

  const handleSend = async () => {
    if (valid.length === 0 || sendInvites.isPending) return
    try {
      const result = await sendInvites.mutateAsync({
        emails: valid,
        message: note.trim() || undefined,
      })
      track('referral_invites_sent', { tenant_id: tenantId, count: result.sent })
      setEmailsRaw('')
      setNote('')

      const sentPart =
        result.sent === 1 ? 'Invitation sent' : `${result.sent} invitations sent`
      if (result.rejected.length > 0) {
        showToast(`${sentPart}. ${describeRejection(result.rejected[0])}.`, 'success')
      } else {
        showToast(`${sentPart}.`, 'success')
      }
    } catch {
      track('referral_invites_failed', { tenant_id: tenantId, count: valid.length })
      showToast('Could not send the invitations. Please try again.', 'error')
    }
  }

  // The rail leads with what a referral is worth, not with a balance: every
  // workspace starts at zero, and a headline reading "$0" is the first thing a
  // new person would see. The running totals sit with the list they total.
  const converted = program?.convertedCount ?? 0
  const available = program?.creditAvailableUsd ?? 0
  const earnedSummary =
    converted === 0
      ? 'Nothing earned yet'
      : `${formatMoney(program?.creditEarnedUsd ?? 0)} earned from ${converted} ${
          converted === 1 ? 'subscriber' : 'subscribers'
        }${
          available > 0
            ? program?.creditRedeemable === false
              ? `. ${formatMoney(available)} held until you subscribe`
              : `. ${formatMoney(available)} ready for your next invoice`
            : ''
        }`

  const referrals = referralsQuery.data?.referrals ?? []

  // The program call is what produces the link, so a failure there leaves the
  // page with nothing to share. The list below it is allowed to fail on its own
  // without taking the sharing half of the page down with it.
  if (programQuery.isError) {
    return (
      <div className="refer-page">
        <PageHeader title="Refer and earn" />
        <ErrorState
          title="Your referral link is not available"
          subtitle="We could not load your referral program. Please try again."
          onRetry={() => programQuery.refetch()}
        />
      </div>
    )
  }

  return (
    <div className="refer-page">
      <PageHeader title="Refer and earn" />

      {/* ── What the programme is worth, and the link itself ─────────── */}
      {/* The rail carries no border on purpose. It is shorter than the card
          beside it and always will be, and a borderless column has no bottom
          edge to misalign against one. */}
      <div className="refer-top">
      <div className="refer-summary">
        {/* Copy first, drawing under it. With the orbit on top, the rail's
            first line of text landed level with the middle of the card beside
            it; this way the two columns start on the same line. */}
        {/* The give-and-get shape retail referral programmes use, because it is
            read in one pass. Both halves are stated in dollars: the person
            being invited has never used Liftoff and would have to learn what an
            Operating Unit is before the offer meant anything. */}
        <p className="refer-summary__headline">
          Give <span className="refer-summary__amount">
            {formatMoney(program?.refereeBonusUsd ?? 0)}
          </span>, get <span className="refer-summary__amount">{formatMoney(reward)}</span>
        </p>
        <p className="refer-summary__how">
          {/* "off your bill", not "off your next invoice". The vesting rule
              means the credit may not reach the next one, and no comparable
              programme puts its waiting period in the offer line: Mailchimp
              markets the $30 and keeps the 60 day requirement in its help and
              terms. The per-row "Available <date>" in the table below and the
              terms link carry the detail. */}
          {/* One sentence per line span, as above. Sharing a span let the wrap
              fall after "You", splitting the second sentence across lines. */}
          <span className="refer-summary__line">
            They get {formatMoney(program?.refereeBonusUsd ?? 0)} of bonus usage on their first
            month.
          </span>
          <span className="refer-summary__line">
            {program && !program.creditRedeemable
              ? `You get ${formatMoney(reward)} off your bill when you subscribe.`
              : `You get ${formatMoney(reward)} off your bill.`}
          </span>
          <span className="refer-summary__line">
            {/* The cap, the vesting period and the reversal rules all live in
                the terms now. Stating one of them here and not the others read
                as the whole story when it was not. */}
            <a className="refer-summary__link" href="/referral/terms">
              Referral Program Terms of Service
            </a>
          </span>
        </p>
        <ReferralIllustration />
      </div>

      <section className="refer-card" aria-labelledby="refer-link-title">
        <h2 id="refer-link-title" className="refer-card__title">
          Your referral link
        </h2>
        {/* Same copy control as Workspace ID in Settings and the webhook
            credentials: a code block with an icon-only copy button beside it. */}
        <div className="refer-copy">
          <div className="refer-copy__row">
            <span className="refer-copy__label">Link</span>
            <code className="settings-section__code refer-copy__code">
              {link || (programQuery.isPending ? 'Loading your link...' : 'Not available')}
            </code>
            <button
              type="button"
              className="settings-section__copy"
              onClick={() => copy(link, 'link_field', 'Referral link')}
              aria-label="Copy referral link"
              disabled={!link}
            >
              <CopyIcon width="16" height="16" />
            </button>
          </div>
          {program?.code && (
            <div className="refer-copy__row">
              <span className="refer-copy__label">Code</span>
              <code className="settings-section__code">{program.code}</code>
              <button
                type="button"
                className="settings-section__copy"
                onClick={() => copy(program.code, 'code', 'Referral code')}
                aria-label="Copy referral code"
              >
                <CopyIcon width="16" height="16" />
              </button>
            </div>
          )}
        </div>

        <div className="refer-share">
          <span className="refer-share__label">Or share it on</span>
          <div className="refer-share__buttons">
            {shareTargets(shareMessage(program?.refereeBonusUsd ?? 0)).map((target) => (
              <button
                key={target.channel}
                type="button"
                className="refer-share__button"
                onClick={() => share(target)}
                disabled={!link}
                aria-label={target.label}
                title={target.label}
              >
                {target.icon}
              </button>
            ))}
            <button
              type="button"
              className="refer-share__button"
              onClick={shareByMailClient}
              disabled={!link}
              aria-label="Share by email"
              title="Share by email"
            >
              <MailIcon width="16" height="16" />
            </button>
          </div>
          {/* Paid workspaces only. Everyone keeps the link and the share
              buttons; only the control that makes Liftoff send mail on the
              caller's behalf is gated. */}
          {program?.canSendInvites && (
            <Button
              variant="outline"
              size="sm"
              className="refer-share__divide"
              onClick={() => setInviteOpen((open) => !open)}
              disabled={!link}
            >
              {inviteOpen ? 'Close' : 'Invite by email'}
            </Button>
          )}
        </div>

        {inviteOpen && program?.canSendInvites && (
          <div className="refer-invite" id="refer-invite">
            <label className="refer-field" htmlFor="refer-emails">
              <span className="refer-field__label">Email addresses</span>
              <textarea
                id="refer-emails"
                ref={emailsRef}
                className="refer-field__control"
                rows={2}
                value={emailsRaw}
                placeholder="jordan@example.com, sam@example.com"
                onChange={(e) => setEmailsRaw(e.target.value)}
              />
            </label>

            <label className="refer-field" htmlFor="refer-note">
              <span className="refer-field__label">Add a note (optional)</span>
              <textarea
                id="refer-note"
                className="refer-field__control"
                rows={2}
                value={note}
                maxLength={500}
                placeholder="A line about why you think they would find this useful."
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            {invalid.length > 0 && (
              <p className="refer-field__error" role="alert">
                {invalid.length === 1
                  ? `${invalid[0]} is not a valid email address.`
                  : `${invalid.length} of the addresses are not valid email addresses.`}
              </p>
            )}

            <div className="refer-invite__actions">
              <Button
                onClick={handleSend}
                disabled={valid.length === 0 || invalid.length > 0}
                loading={sendInvites.isPending}
              >
                {valid.length > 1 ? `Send ${valid.length} invitations` : 'Send invitation'}
              </Button>
            </div>
          </div>
        )}
      </section>

      </div>

      {/* ── Who has subscribed ───────────────────────────────────────── */}
      <section className="refer-card" aria-labelledby="refer-list-title">
        <div className="refer-list__header">
          <h2 id="refer-list-title" className="refer-card__title">
            People you have referred
          </h2>
          {/* Totals sit with the rows they total, opposite the heading. Held
              back until there is a row, so an empty list is not headed by a
              running total of nothing. */}
          {referrals.length > 0 && <p className="refer-list__totals">{earnedSummary}</p>}
        </div>

        {referralsQuery.isError ? (
          <div className="refer-list__state">
            <p className="refer-list__state-text">We could not load your referrals.</p>
            <Button variant="outline" size="sm" onClick={() => referralsQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : referralsQuery.isPending ? (
          <div className="refer-list__state">
            <div className="loading-spinner" />
          </div>
        ) : referrals.length === 0 ? (
          <EmptyState
            icon={<UserRoundPlusIcon width="24" height="24" />}
            title="No referrals yet"
            description="Anyone who signs up on your link will appear here."
          />
        ) : (
          <>
            <div className="refer-table__scroll">
              <table className="refer-table">
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Status</th>
                    <th scope="col">Signed up</th>
                    <th scope="col">Subscribed</th>
                    <th scope="col" className="refer-table__cell--amount">
                      Credit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {referrals.map((referral) => (
                    <ReferralRow key={referral.id} referral={referral} />
                  ))}
                </tbody>
              </table>
            </div>
            {/* The programme is uncapped by design, so a workspace can outgrow
                one page. Without this the rest were fetched by nobody and the
                list simply stopped, with nothing to say it had. */}
            {referralsQuery.data?.hasMore && referralsQuery.data.nextCursor && (
              <div className="refer-list__more">
                <Button
                  variant="outline"
                  size="sm"
                  loading={loadMore.isPending}
                  onClick={() => loadMore.mutate(referralsQuery.data.nextCursor!)}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
