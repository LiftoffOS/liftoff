// The unread dot on the sidebar's Insights icon. Same accent dot the Review
// item already carries for pending approvals, driven by the Insights surface's
// own unread count, with a text equivalent on the link's accessible name.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import Sidebar from './Sidebar'

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    account: null,
    signOut: vi.fn(),
    tenants: [],
    currentTenant: { id: 't1', name: 'T' },
    switchTenant: vi.fn(),
    canManageMembers: () => false,
  }),
}))
vi.mock('../../hooks/useConnectors', () => ({
  usePrefetchConnectors: () => vi.fn(),
}))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))
vi.mock('./routePrefetch', () => ({ prefetchRoute: vi.fn() }))

let mockPendingTotal = 0
vi.mock('../../hooks/useOversight', () => ({
  usePendingApprovalCount: () => ({ data: { total: mockPendingTotal } }),
}))

let mockInsightsUnread = 0
vi.mock('../../hooks/useInsightsUnread', () => ({
  useInsightsUnreadCount: () => ({ data: mockInsightsUnread }),
}))

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Sidebar isCollapsed={false} onToggle={vi.fn()} isMobileOpen={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockPendingTotal = 0
  mockInsightsUnread = 0
})

describe('Sidebar Insights unread dot', () => {
  it('dots the Insights icon and augments the accessible name when replies are unread', () => {
    mockInsightsUnread = 2

    renderSidebar()

    const link = screen.getByRole('link', { name: /Insights, unread replies/ })
    const dot = link.querySelector('.sidebar__icon-dot')
    expect(dot).toBeInTheDocument()
    expect(dot).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows no dot when nothing is unread', () => {
    renderSidebar()

    const link = screen.getByRole('link', { name: 'Insights' })
    expect(link.querySelector('.sidebar__icon-dot')).not.toBeInTheDocument()
  })

  it('keeps the Review dot and the Insights dot independent', () => {
    // Pending approvals and unread Insights replies are different facts; one
    // indicator must never light the other.
    mockPendingTotal = 3

    renderSidebar()

    const review = screen.getByRole('link', { name: /Review/ })
    expect(review.querySelector('.sidebar__icon-dot')).toBeInTheDocument()
    const insights = screen.getByRole('link', { name: 'Insights' })
    expect(insights.querySelector('.sidebar__icon-dot')).not.toBeInTheDocument()
  })
})
