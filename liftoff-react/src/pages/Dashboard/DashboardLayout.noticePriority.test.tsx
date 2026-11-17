// One notice slot, priority ordered.
//
// Both banners can be eligible at the same moment: a workspace can be payment
// blocked while the same person has browser notifications half-configured. Two
// stacked banners read as a broken page, and the blocking problem has to win,
// so this locks the ordering rather than leaving it to render order.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

const mocks = vi.hoisted(() => ({
  billing: null as {
    executionBlocked: boolean
    outstandingBalanceUsd: number
    suspendedReason?: string | null
  } | null,
}))

vi.mock('../../hooks/useBilling', () => ({
  useBillingOverview: () => ({ data: mocks.billing }),
}))

vi.mock('../../hooks/useInternalAgents', () => ({
  useInternalAgents: () => ({ data: { pages: [{ internalAgents: [{ id: 'a1' }] }] } }),
}))

vi.mock('../../hooks/useBrowserNotifications', () => ({
  useEnableBrowserNotifications: () => vi.fn(),
  useDisableBrowserNotifications: () => vi.fn(),
}))

vi.mock('../../components', () => ({
  Sidebar: () => <div data-testid="sidebar-stub" />,
}))

// Both notices are real here. Stubbing either would defeat the point.
vi.mock('../../lib/pushNotifications', () => ({
  getPushPermissionState: () => 'default',
  requestAndRegister: vi.fn(),
}))

vi.mock('../../lib/notificationPrompt', () => ({
  isPromptDismissed: () => false,
  dismissPrompt: vi.fn(),
}))

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    account: { preferences: { notificationDelivery: { browser: true } } },
  }),
}))

import DashboardLayout from './DashboardLayout'

// /dashboard, because the notification notice only asks on the home page and
// the review queue. Rendering at "/" would make it invisible for a reason that
// has nothing to do with the priority rule under test.
function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <DashboardLayout />
    </MemoryRouter>,
  )
}

describe('DashboardLayout notice slot', () => {
  beforeEach(() => {
    mocks.billing = null
  })

  it('shows payment alone when both notices are eligible', () => {
    mocks.billing = { executionBlocked: true, outstandingBalanceUsd: 42.5 }
    renderLayout()
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].textContent).toContain('unable to run')
    expect(alerts[0].textContent).not.toContain('permission')
  })

  it('falls through to the notification notice when payment is fine', () => {
    mocks.billing = { executionBlocked: false, outstandingBalanceUsd: 0 }
    renderLayout()
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].textContent).toContain('needs your permission')
  })

  // A blocking banner is not dismissible: hiding it does not make the workspace
  // start running again.
  it('gives the payment notice no dismiss control', () => {
    mocks.billing = { executionBlocked: true, outstandingBalanceUsd: 10 }
    renderLayout()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})

// Same stop, different cause, different way out. Offering to update a payment
// method to somebody whose card is fine and whose Operating Units are gone is a
// button that cannot fix anything.
describe('DashboardLayout notice slot — why the workspace stopped', () => {
  beforeEach(() => {
    mocks.billing = null
  })

  it('offers billing, not a card update, when the Operating Units are gone', () => {
    mocks.billing = {
      executionBlocked: true,
      outstandingBalanceUsd: 0,
      suspendedReason: 'zero_prepaid_balance',
    }
    renderLayout()

    const alert = screen.getAllByRole('alert')[0]
    expect(alert.textContent).toContain('insufficient Operating Units')
    expect(screen.getByRole('button', { name: 'Go to Billing' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Update Payment Method' })).toBeNull()
  })

  // A declined auto-reload IS a card problem, even though the workspace is
  // equally out of Operating Units. It keeps the banner whose button fixes it.
  it('keeps the card-update banner when the reload was declined', () => {
    mocks.billing = {
      executionBlocked: true,
      outstandingBalanceUsd: 0,
      suspendedReason: 'auto_reload_failed',
    }
    renderLayout()

    expect(screen.getByRole('button', { name: 'Update Payment Method' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Go to Billing' })).toBeNull()
  })

  it('keeps the card-update banner for an unpaid balance', () => {
    mocks.billing = { executionBlocked: true, outstandingBalanceUsd: 128.4 }
    renderLayout()

    const alert = screen.getAllByRole('alert')[0]
    expect(alert.textContent).toContain('$128.40')
    expect(screen.getByRole('button', { name: 'Update Payment Method' })).toBeTruthy()
  })

  it('gives the Operating Units notice no dismiss control either', () => {
    mocks.billing = {
      executionBlocked: true,
      outstandingBalanceUsd: 0,
      suspendedReason: 'zero_prepaid_balance',
    }
    renderLayout()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})
