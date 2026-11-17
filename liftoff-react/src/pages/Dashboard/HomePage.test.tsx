import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import HomePage from './HomePage'

// Mock ResizeObserver
class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
global.ResizeObserver = ResizeObserverMock

// Mock react-router hooks
const mockNavigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

// Mock account state for preference tests
let mockAccount: { firstName?: string; preferences?: { gettingStartedHidden?: boolean } } | null = { preferences: {} }
const mockHideGettingStarted = vi.fn()
let mockIsLoading = false

// Mock the auth context
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    account: mockAccount,
    currentTenant: { id: 'test-tenant-id', name: 'Test Tenant' },
  }),
}))

// Mock toast context
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}))

// Mock useGettingStartedPreference hook
vi.mock('../../hooks/useGettingStartedPreference', () => ({
  useGettingStartedPreference: () => ({
    isHidden: mockAccount?.preferences?.gettingStartedHidden ?? false,
    isLoading: mockIsLoading,
    hideGettingStarted: mockHideGettingStarted,
    isHiding: false,
  }),
  GETTING_STARTED_REMIND_LATER_KEY: 'liftoff_getting_started_remind_later',
}))

// Mock internal agents hooks
vi.mock('../../hooks/useInternalAgents', () => ({
  useInternalAgents: () => ({
    data: { pages: [{ internalAgents: [] }] },
    isLoading: false,
  }),
  useRecentlyViewedInternalAgents: () => ({
    data: { internalAgents: [] },
    isLoading: false,
  }),
  useUpdateInternalAgentStatus: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useDeleteInternalAgent: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useCreateInternalAgent: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}))

// Mock external agents hooks
vi.mock('../../hooks/useExternalAgents', () => ({
  useExternalAgents: () => ({
    data: { agents: [] },
    isLoading: false,
  }),
  useUpdateExternalAgentStatus: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useDeleteExternalAgent: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}))

// Mock teams hook
vi.mock('../../hooks/useTeams', () => ({
  useTeams: () => ({
    data: { pages: [{ teams: [] }] },
    isLoading: false,
  }),
}))

// Mock activity logs hook
vi.mock('../../hooks/useActivityLogs', () => ({
  useActivityLogs: () => ({
    data: { pages: [{ items: [] }] },
    isLoading: false,
  }),
}))

// Mock approvals hook — the /review queue feed, discriminated by `kind`, plus
// the counts the runtime computes for it.
const mockQueueItems: unknown[] = []
const mockQueueCounts: Record<string, number> | null = {
  total: 0,
  approvalsStandard: 0,
  approvalsCritical: 0,
  approvalsOther: 0,
  clarifications: 0,
}
vi.mock('../../hooks/useOversight', () => ({
  useApprovals: () => ({
    data: {
      pages: [{
        items: mockQueueItems,
        cursor: null,
        hasMore: false,
        total: mockQueueCounts?.total ?? null,
        counts: mockQueueCounts,
      }],
    },
    isLoading: false,
  }),
  usePendingApprovalCount: () => ({
    data: mockQueueCounts ? { count: mockQueueCounts.total, ...mockQueueCounts } : { count: null },
  }),
}))

// Mock team stats hook
vi.mock('../../hooks/useAgentStats', () => ({
  useAgentStats: () => ({
    activeTeams: 0,
    tasksCompletedLast30Days: 0,
    hoursSavedLast30Days: 0,
    isLoading: false,
  }),
}))

// Mock workspace members hook
vi.mock('../../hooks/useTenantMembers', () => ({
  useWorkspaceMembers: () => ({
    data: [],
    isLoading: false,
  }),
}))

// Liftoff thread and unread state, mutable so the Resume-button tests can vary
// them while every earlier test keeps the empty default (no button, no dot).
let mockLiftoffThreadPages: Array<{ threads: Array<{ id: string }> }> = []
let mockLiftoffUnreadCount = 0

vi.mock('../../hooks/useLiftoffThreads', () => ({
  useLiftoffThreads: () => ({ data: { pages: mockLiftoffThreadPages } }),
}))

vi.mock('../../hooks/useLiftoffUnread', () => ({
  useLiftoffUnreadCount: () => ({ data: mockLiftoffUnreadCount }),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
}

describe('HomePage Getting Started Banner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    mockAccount = { preferences: {} }
    mockIsLoading = false
  })

  it('hides banner when backend preference is set', () => {
    mockAccount = { preferences: { gettingStartedHidden: true } }

    render(<HomePage />, { wrapper: createWrapper() })

    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument()
  })

  it('persists preference across simulated page refresh', async () => {
    // First render - banner is visible
    mockAccount = { preferences: {} }
    const { unmount } = render(<HomePage />, { wrapper: createWrapper() })

    expect(screen.getByText('Getting Started')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Do not Show Again'))
    expect(mockHideGettingStarted).toHaveBeenCalled()

    // Unmount to simulate leaving page
    unmount()

    // Simulate backend having the preference now
    mockAccount = { preferences: { gettingStartedHidden: true } }

    // Re-render to simulate page refresh
    render(<HomePage />, { wrapper: createWrapper() })

    // Banner should be hidden
    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument()
  })

  it('shows banner when both localStorage and backend have no preference', () => {
    mockAccount = { preferences: {} }

    render(<HomePage />, { wrapper: createWrapper() })

    expect(screen.getByText('Getting Started')).toBeInTheDocument()
  })

  it('Remind Me Later uses sessionStorage (session-only)', () => {
    mockAccount = { preferences: {} }

    render(<HomePage />, { wrapper: createWrapper() })

    // Banner should be visible
    expect(screen.getByText('Getting Started')).toBeInTheDocument()

    // Click "Remind Me Later"
    fireEvent.click(screen.getByText('Remind Me Later'))

    // Should set sessionStorage
    expect(sessionStorage.getItem('liftoff_getting_started_remind_later')).toBe('true')

    // Banner should be hidden
    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument()
  })

  it("Don't Show Again calls hideGettingStarted", () => {
    mockAccount = { preferences: {} }

    render(<HomePage />, { wrapper: createWrapper() })

    fireEvent.click(screen.getByText('Do not Show Again'))

    expect(mockHideGettingStarted).toHaveBeenCalled()
  })

  it('does not flash banner while loading preferences', () => {
    mockAccount = null
    mockIsLoading = true

    render(<HomePage />, { wrapper: createWrapper() })

    // Banner should NOT be visible while loading
    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument()
  })
})

// The header CTA and the banner's first card open the same destination, so only
// one of them is ever on screen.
describe('HomePage header CTA hands off with the Getting Started banner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    mockAccount = { preferences: {} }
    mockIsLoading = false
  })

  const headerCta = () => screen.queryByRole('button', { name: 'Add Agent' })

  it('hides the header CTA while the banner is showing', () => {
    render(<HomePage />, { wrapper: createWrapper() })

    expect(screen.getByText('Getting Started')).toBeInTheDocument()
    expect(headerCta()).not.toBeInTheDocument()
  })

  it('shows the header CTA when the banner is permanently hidden', () => {
    mockAccount = { preferences: { gettingStartedHidden: true } }

    render(<HomePage />, { wrapper: createWrapper() })

    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument()
    expect(headerCta()).toBeInTheDocument()
  })

  it('shows the header CTA as soon as the banner is dismissed for the session', () => {
    render(<HomePage />, { wrapper: createWrapper() })

    expect(headerCta()).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Remind Me Later'))

    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument()
    expect(headerCta()).toBeInTheDocument()
  })

  it('does not flash the header CTA while preferences are loading', () => {
    mockAccount = null
    mockIsLoading = true

    render(<HomePage />, { wrapper: createWrapper() })

    // Neither surface is committed yet, so the CTA must not appear only to be
    // replaced by the banner a moment later.
    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument()
    expect(headerCta()).not.toBeInTheDocument()
  })

  it('navigates to team exploration from the header CTA', () => {
    mockAccount = { preferences: { gettingStartedHidden: true } }

    render(<HomePage />, { wrapper: createWrapper() })

    fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }))

    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents/explore')
  })
})

// The dot on Resume Previous Conversation mirrors the teams list's Message
// Team dot: same accent dot, same accessible-name augmentation, driven by the
// Liftoff surface's own unread count.
describe('HomePage Resume Previous Conversation unread dot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAccount = { preferences: { gettingStartedHidden: true } }
    mockLiftoffThreadPages = [{ threads: [{ id: 'thread-1' }] }]
    mockLiftoffUnreadCount = 0
  })

  it('shows no dot when nothing is unread', () => {
    render(<HomePage />, { wrapper: createWrapper() })

    expect(
      screen.getByRole('button', { name: /^Resume Previous Conversation$/ }),
    ).toBeInTheDocument()
    expect(document.querySelector('.home-page__resume-dot')).not.toBeInTheDocument()
  })

  it('shows the dot and augments the accessible name when replies are unread', () => {
    mockLiftoffUnreadCount = 2

    render(<HomePage />, { wrapper: createWrapper() })

    // Colour alone reaches neither a screen reader nor a colour-blind reader,
    // so the state must ride on the button's accessible name too.
    expect(screen.getByRole('button', { name: /unread replies/ })).toBeInTheDocument()
    const dot = document.querySelector('.home-page__resume-dot')
    expect(dot).toBeInTheDocument()
    expect(dot).toHaveAttribute('aria-hidden', 'true')
  })

  it('offers no resume at all when there is nothing to resume, unread or not', () => {
    mockLiftoffThreadPages = [{ threads: [] }]
    mockLiftoffUnreadCount = 5

    render(<HomePage />, { wrapper: createWrapper() })

    expect(screen.queryByText('Resume Previous Conversation')).not.toBeInTheDocument()
    expect(document.querySelector('.home-page__resume-dot')).not.toBeInTheDocument()
  })
})
