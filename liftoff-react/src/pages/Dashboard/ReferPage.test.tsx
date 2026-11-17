import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/mocks/server'
import ReferPage from './ReferPage'

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ currentTenant: { id: 't1' } }),
}))

const showToast = vi.fn()
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}))

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

const writeText = vi.fn().mockResolvedValue(undefined)

/** userEvent.setup() installs its own clipboard stub, so ours has to go on
 *  afterwards or the page writes into theirs and this file asserts nothing. */
function stubClipboard() {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  showToast.mockClear()
  writeText.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ReferPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ReferPage', () => {
  it('states the reward and copies the served referral link', async () => {
    const user = userEvent.setup()
    stubClipboard()
    renderPage()

    // The reward is the point of the page: it has to be a number on screen,
    // taken from the program rather than assumed by the component.
    // The headline is split across spans so the amounts can be styled, so this
    // matches on the element's own text rather than on a single text node.
    expect(
      await screen.findByText(
        (_, el) =>
          el?.classList.contains('refer-summary__headline') === true &&
          /Give \$20, get \$20/.test(el.textContent ?? ''),
      ),
    ).toBeInTheDocument()

    expect(
      await screen.findByText('https://example.com/?ref=k7m2q9'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Copy referral link' }))

    expect(writeText).toHaveBeenCalledWith('https://example.com/?ref=k7m2q9')
    expect(showToast).toHaveBeenCalledWith('Referral link copied', 'success')

    // The bare code is its own copy target: people read it out and type it in.
    await user.click(screen.getByRole('button', { name: 'Copy referral code' }))
    expect(writeText).toHaveBeenCalledWith('k7m2q9')
  })

  it('opens a social network with the referral link attached', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderPage()

    const linkedin = await screen.findByRole('button', { name: 'Share on LinkedIn' })
    await waitFor(() => expect(linkedin).toBeEnabled())
    await user.click(linkedin)

    expect(open).toHaveBeenCalledWith(
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent('https://example.com/?ref=k7m2q9')}`,
      '_blank',
      'noopener,noreferrer',
    )

    // X carries the message as well as the link, and it names what the
    // recipient gets rather than what the sender gets. The amount is
    // deliberately absent: it reads as small to somebody with no sense of what
    // an Operating Unit buys.
    await user.click(screen.getByRole('button', { name: 'Share on X' }))
    const xUrl = open.mock.calls[1][0] as string
    const shared = decodeURIComponent(xUrl)
    expect(shared).toContain('Get bonus usage when you subscribe')
    expect(shared).not.toContain('$20')
  })

  it('refuses to send a malformed address and sends the parsed list once it is valid', async () => {
    const user = userEvent.setup()
    let sentBody: { emails?: string[]; message?: string } | null = null
    server.use(
      http.post('*/api/referrals/invites', async ({ request }) => {
        sentBody = (await request.json()) as { emails?: string[]; message?: string }
        return HttpResponse.json({ sent: sentBody.emails?.length ?? 0, rejected: [] })
      }),
    )
    renderPage()

    // The form is behind a disclosure, so nothing is on screen until asked for.
    expect(screen.queryByLabelText('Email addresses')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Invite by email' }))

    const emails = await screen.findByLabelText('Email addresses')
    await user.type(emails, 'not-an-address')

    expect(screen.getByRole('alert')).toHaveTextContent(
      'not-an-address is not a valid email address.',
    )
    expect(screen.getByRole('button', { name: /send invitation/i })).toBeDisabled()

    await user.clear(emails)
    await user.type(emails, 'jordan@example.com, sam@example.com')

    const send = screen.getByRole('button', { name: 'Send 2 invitations' })
    await user.click(send)

    await waitFor(() =>
      expect(sentBody).toEqual({ emails: ['jordan@example.com', 'sam@example.com'] }),
    )
    expect(showToast).toHaveBeenCalledWith('2 invitations sent.', 'success')
    // The field empties so a second click cannot re-send the same list.
    expect(emails).toHaveValue('')
  })

  it('lists referred people and the credit each conversion earned', async () => {
    renderPage()

    expect(
      await screen.findByText('$40 earned from 2 subscribers. $20 ready for your next invoice'),
    ).toBeInTheDocument()

    expect(screen.getByText('Jordan Ellis')).toBeInTheDocument()
    // The referred party's workspace is deliberately not shown: printing it
    // beside a masked address would undo the masking.
    expect(screen.queryByText('Harbourline Logistics')).not.toBeInTheDocument()
    // Four are subscribed. Two of those earned credit (Jordan applied, Wei
    // available), one was charged back and one is ineligible, which is why the
    // header line says $40 from 2 subscribers rather than from 4.
    expect(
      screen.getAllByText('Subscribed', { selector: '.status-badge' }),
    ).toHaveLength(5)
    expect(screen.getByText('Reversed')).toBeInTheDocument()

    // A referral that subscribed but earns nothing says why, rather than
    // sitting in the list with a blank where the money would be.
    expect(screen.getByText('Not eligible: existing account')).toBeInTheDocument()

    // Pending credit says when it becomes spendable rather than just "Pending".
    expect(screen.getByText(/^Available /)).toBeInTheDocument()
    expect(screen.queryByText('Pending')).not.toBeInTheDocument()

    // A sign-up that has not converted is listed, but earns nothing.
    expect(screen.getByText('Sam Fielder')).toBeInTheDocument()
    expect(screen.getAllByText('Not earned yet')).toHaveLength(2)
  })

  it('offers link sharing but not email invites to a workspace that cannot send', async () => {
    server.use(
      http.get('*/api/referrals/program', () =>
        HttpResponse.json({
          code: 'k7m2q9',
          url: 'https://example.com/?ref=k7m2q9',
          rewardPerReferralUsd: 20,
          creditEarnedUsd: 0,
          creditAppliedUsd: 0,
          creditAvailableUsd: 0,
          canSendInvites: false,
          pendingCount: 0,
          convertedCount: 0,
        }),
      ),
    )
    renderPage()

    // The link and every share target stay available: a link is inert until
    // somebody clicks it.
    expect(await screen.findByRole('button', { name: 'Copy referral link' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share on LinkedIn' })).toBeInTheDocument()

    // The control that makes Liftoff send mail on their behalf does not.
    expect(screen.queryByRole('button', { name: 'Invite by email' })).not.toBeInTheDocument()
  })

  it('does not promise a discount to a workspace with no subscription', async () => {
    server.use(
      http.get('*/api/referrals/program', () =>
        HttpResponse.json({
          code: 'k7m2q9',
          url: 'https://example.com/?ref=k7m2q9',
          rewardPerReferralUsd: 20,
          refereeBonusOus: 800,
          refereeBonusUsd: 20,
          creditEarnedUsd: 20,
          creditAppliedUsd: 0,
          creditAvailableUsd: 20,
          creditRedeemable: false,
          canSendInvites: false,
          pendingCount: 0,
          convertedCount: 1,
        }),
      ),
    )
    renderPage()

    // It can still be earned, so the offer stands; it just cannot come off a
    // bill that does not exist yet.
    expect(
      await screen.findByText('You get $20 off your bill when you subscribe.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('$20 earned from 1 subscriber. $20 held until you subscribe'),
    ).toBeInTheDocument()
  })

  it('loads the next page of referrals on request', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/api/referrals', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor')
        if (cursor === 'page-2') {
          return HttpResponse.json({
            referrals: [
              {
                id: 'ref_007', email: 'ines@calderworks.com', name: 'Ines Calder',
                status: 'subscribed', signedUpAt: '2026-01-05T00:00:00.000Z',
                subscribedAt: '2026-01-12T00:00:00.000Z', creditUsd: 20,
                creditStatus: 'granted', ineligibleReason: null,
                creditAvailableAt: null, creditExpiresAt: null,
              },
            ],
            hasMore: false,
            nextCursor: null,
          })
        }
        return HttpResponse.json({
          referrals: [
            {
              id: 'ref_001', email: 'jordan@brightpath.io', name: 'Jordan Ellis',
              status: 'subscribed', signedUpAt: '2026-07-03T00:00:00.000Z',
              subscribedAt: '2026-07-10T00:00:00.000Z', creditUsd: 20,
              creditStatus: 'granted', ineligibleReason: null,
              creditAvailableAt: null, creditExpiresAt: null,
            },
          ],
          hasMore: true,
          nextCursor: 'page-2',
        })
      }),
    )
    renderPage()

    expect(await screen.findByText('Jordan Ellis')).toBeInTheDocument()
    expect(screen.queryByText('Ines Calder')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Load more' }))

    // The next page is appended, not swapped in.
    expect(await screen.findByText('Ines Calder')).toBeInTheDocument()
    expect(screen.getByText('Jordan Ellis')).toBeInTheDocument()
    // And the control goes once there is nothing left to fetch.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('names an address the daily cap kept back, and says when to retry', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('*/api/referrals/invites', async ({ request }) => {
        const body = (await request.json()) as { emails?: string[] }
        // The endpoint truncates at 30 a day and names what it truncated. An
        // address in neither `sent` nor `rejected` would show a success toast
        // for a smaller number than the sender typed, with no way to learn
        // which addresses went.
        return HttpResponse.json({
          sent: 1,
          rejected: [{ email: body.emails![1], reason: 'daily_limit_reached' }],
        })
      }),
    )
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Invite by email' }))
    const emails = await screen.findByLabelText('Email addresses')
    await user.type(emails, 'first@example.com, second@example.com')
    await user.click(screen.getByRole('button', { name: 'Send 2 invitations' }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Invitation sent. second@example.com was not sent: the daily invitation limit was reached. Try again tomorrow.',
        'success',
      ),
    )
  })

  it('keeps the page usable when the referral program cannot be loaded', async () => {
    server.use(
      // 404 rather than 500: the hook deliberately retries server errors, and
      // a missing route is the shape this actually fails in before the backend
      // endpoint ships.
      http.get('*/api/referrals/program', () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 }),
      ),
    )
    renderPage()

    expect(await screen.findByText('Your referral link is not available')).toBeInTheDocument()
    // The page still identifies itself rather than rendering as a bare error.
    expect(screen.getByRole('heading', { name: 'Refer and earn' })).toBeInTheDocument()
  })
})
