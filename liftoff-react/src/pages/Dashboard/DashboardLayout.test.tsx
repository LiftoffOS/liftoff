// PaymentBlockedBanner unit tests — locks in the null-safe contract on the
// new BillingOverview wire shape (PR3 returns 200 with safe defaults for
// unprovisioned tenants; useBillingOverview returns BillingOverview | null
// after the G1 fix). The banner must not crash when billing is null,
// undefined, or has executionBlocked=false.
//
// Renders DashboardLayout in isolation with a stubbed useBilling hook.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

const mockUseBillingOverview = vi.fn()

vi.mock('../../hooks/useBilling', () => ({
  useBillingOverview: () => mockUseBillingOverview(),
}))

// Sidebar pulls in many UI deps and the router context — stub it out.
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

// The notice slot falls through to the browser-notification banner whenever
// payment is fine, and both that banner and usePushTokenSync read the auth
// context. Standing up a real AuthProvider would drag Firebase into a test that
// has nothing to do with it.
//
// Push reports 'granted' here so the notification banner stays silent and these
// assertions stay about PaymentBlockedBanner, which is what this file covers.
// Its own visibility rules live in NotificationPermissionBanner.test.tsx.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ account: { preferences: {} } }),
}))

vi.mock('../../lib/pushNotifications', () => ({
  getPushPermissionState: () => 'granted',
}))

import DashboardLayout from './DashboardLayout'

function renderLayout() {
  return render(
    <MemoryRouter>
      <DashboardLayout />
    </MemoryRouter>,
  )
}

describe('DashboardLayout PaymentBlockedBanner', () => {
  it('renders no banner when billing data is undefined (loading)', () => {
    mockUseBillingOverview.mockReturnValue({ data: undefined })
    renderLayout()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders no banner when billing data is null (unprovisioned, after G1)', () => {
    mockUseBillingOverview.mockReturnValue({ data: null })
    renderLayout()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders no banner when executionBlocked is false', () => {
    mockUseBillingOverview.mockReturnValue({
      data: {
        executionBlocked: false,
        outstandingBalanceUsd: 0,
      },
    })
    renderLayout()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders banner with dollar amount when executionBlocked and outstanding > 0', () => {
    mockUseBillingOverview.mockReturnValue({
      data: {
        executionBlocked: true,
        outstandingBalanceUsd: 42.5,
      },
    })
    renderLayout()
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toContain('$42.50 balance is')
  })

  it('renders banner with "your balance is" wording when executionBlocked but outstanding is 0', () => {
    mockUseBillingOverview.mockReturnValue({
      data: {
        executionBlocked: true,
        outstandingBalanceUsd: 0,
      },
    })
    renderLayout()
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toContain('your balance is')
    expect(banner.textContent).not.toContain('$')
  })
})
