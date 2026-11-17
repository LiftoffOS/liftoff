// The surface a person looks at every day. When the stored photo URL no longer
// resolves — a rotated Firebase Storage download token is the way that happens —
// the circle must show their initials rather than nothing at all.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import Sidebar from './Sidebar'

const AVATAR_URL =
  'https://firebasestorage.googleapis.com/v0/b/b/o/profile-photos%2Fu%2Fx?alt=media&token=t'

let mockAccount: {
  firstName: string | null
  lastName: string | null
  email: string
  avatarUrl: string | null
} | null = null

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    account: mockAccount,
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
vi.mock('../../hooks/useOversight', () => ({
  usePendingApprovalCount: () => ({ data: { total: 0 } }),
}))
vi.mock('../../hooks/useInsightsUnread', () => ({
  useInsightsUnreadCount: () => ({ data: 0 }),
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
  mockAccount = {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    avatarUrl: AVATAR_URL,
  }
})

describe('Sidebar avatar', () => {
  it('renders the stored photo', () => {
    renderSidebar()

    expect(document.querySelector('.sidebar__avatar--image')).toHaveAttribute('src', AVATAR_URL)
  })

  it('shows initials instead once the photo fails to load', () => {
    renderSidebar()

    const image = document.querySelector('.sidebar__avatar--image')!
    fireEvent.error(image)

    expect(document.querySelector('.sidebar__avatar--image')).toBeNull()
    expect(screen.getByText('AL')).toBeInTheDocument()
  })
})
