import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import ReviewQueuePage from './ReviewQueuePage'
import { clarificationErrorMessage } from './reviewQueueErrors'
import { ApiError } from '../../services/api'

// Mock react-router hooks
const mockNavigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ state: null }),
  }
})

// Mock the auth context
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    currentTenant: { id: 'test-tenant-id', name: 'Test Tenant' },
  }),
}))

// Mock toast context
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}))

// Mock oversight hooks
const mockApprove = vi.fn()
const mockReject = vi.fn()
const mockSubmitFeedback = vi.fn()
const mockRespondClarification = vi.fn()
const mockDeclineClarification = vi.fn()

// The counts the runtime computes for the queue. Tests that care about the tab
// labels set this; the rest let it stay at zero.
let mockQueueCounts: Record<string, number> | null = null
// Whether the count query has answered yet. The page distinguishes "no items"
// from "we could not read the queue", and a null count that has actually come
// back is the second of those.
let mockCountsFetched = true

vi.mock('../../hooks/useOversight', () => ({
  useApprovals: vi.fn(),
  usePendingApprovalCount: () => ({ data: mockQueueCounts, isFetched: mockCountsFetched }),
  useApproveRequest: () => ({
    mutate: mockApprove,
    isPending: false,
  }),
  useRejectRequest: () => ({
    mutate: mockReject,
    isPending: false,
  }),
  useSubmitLateFeedback: () => ({
    mutate: mockSubmitFeedback,
    isPending: false,
  }),
  useRespondToClarification: () => ({
    mutate: mockRespondClarification,
    isPending: false,
  }),
  useDeclineClarification: () => ({
    mutate: mockDeclineClarification,
    isPending: false,
  }),
}))

// Import after mocks
import { useApprovals } from '../../hooks/useOversight'

// Helper to create mock approval
function createMockApproval(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'approval' as const,
    id: 'apr_001',
    tenantId: 'test-tenant-id',
    agentId: 'agent_123',
    agentName: 'Test Agent',
    hitlLevel: 1,
    reason: 'communication_review' as const,
    pendingToolCalls: [
      { id: 'tc_001', name: 'sendEmail', input: { to: 'user@example.com' } },
    ],
    status: 'pending' as const,
    createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60000).toISOString(),
    expiresAt: new Date(Date.now() + 55 * 60000).toISOString(), // 55 minutes from now
    ...overrides,
  }
}

// Helper to create expired approval
function createExpiredApproval(overrides: Record<string, unknown> = {}) {
  return createMockApproval({
    id: 'apr_expired',
    status: 'expired',
    expiresAt: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
    ...overrides,
  })
}

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

/** The queue's two views are two server-side sets. This answers each with its
 *  own items, the way the runtime does, so a test cannot accidentally assert
 *  that the page filters one into the other. */
function mockFeedByWindow(feeds: { actionable: unknown[]; passed: unknown[] }) {
  const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
  mockUseApprovals.mockImplementation((options?: { window?: string }) => {
    const items = options?.window === 'passed' ? feeds.passed : feeds.actionable
    return {
      data: { pages: [{ items, total: items.length, counts: null, cursor: null, hasMore: false }] },
      isLoading: false,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    }
  })
}

/** The filter tab, told apart from an approval card whose deadline reads
 *  "Decision window passed". */
const passedTab = () =>
  screen.getByRole('button', { name: /^passed$/i })

/** jsdom has no IntersectionObserver, and the queue pages by scrolling. This
 *  captures the callback so a test can say "the end of the list came into
 *  view" without a layout engine. */
let intersect: ((entries: { isIntersecting: boolean }[]) => void) | null = null
class TestIntersectionObserver {
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    intersect = callback
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
  root = null
  rootMargin = ''
  thresholds = []
}

describe('ReviewQueuePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQueueCounts = null
    mockCountsFetched = true
    intersect = null
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    // jsdom has no layout, so the dropdown's keyboard-focus scroll is a no-op
    // here rather than a crash.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  describe('Filter functionality', () => {
    it('shows "Passed" filter button', () => {
      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [createMockApproval()], total: 1, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      expect(passedTab()).toBeInTheDocument()
    })

    it('"Passed" asks the server for the passed view, not the loaded page', async () => {
      // The two views are different sets, decided by the runtime: an approval
      // whose window closed is precisely what the actionable feed excludes.
      // Filtering one feed into the other is what used to make the tab a view
      // of a race window instead of a view of the queue.
      const pendingApproval = createMockApproval({ id: 'apr_pending', agentName: 'Pending Agent' })
      const expiredApproval = createExpiredApproval({ id: 'apr_expired', agentName: 'Expired Agent' })

      mockFeedByWindow({
        actionable: [pendingApproval],
        passed: [expiredApproval],
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      expect(screen.getByText('Pending Agent')).toBeInTheDocument()
      expect(screen.queryByText('Expired Agent')).not.toBeInTheDocument()

      fireEvent.click(passedTab())

      await waitFor(() => {
        expect(screen.getByText('Expired Agent')).toBeInTheDocument()
      })
      expect(screen.queryByText('Pending Agent')).not.toBeInTheDocument()
      expect(useApprovals).toHaveBeenCalledWith(expect.objectContaining({ window: 'passed' }))
    })

    it('renders an already-answered approval as answered, without offering the form again', async () => {
      // The passed page says which approvals already carry feedback. Without
      // it the form is offered a second time and the only way to learn it was
      // answered is to submit and be told so.
      const answered = createExpiredApproval({
        id: 'apr_answered',
        agentName: 'Answered Agent',
        lateFeedbackSubmitted: true,
      })

      mockFeedByWindow({ actionable: [], passed: [answered] })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })
      fireEvent.click(passedTab())

      fireEvent.click(await screen.findByText('Answered Agent'))

      await waitFor(() => {
        expect(screen.getByText('Feedback submitted')).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument()
    })

    it('offers the feedback form for a lapsed approval the sweeper has not flipped yet', async () => {
      // Still status='pending' with a past window: it reached the passed view
      // because the runtime put it there, and that is the fact the card trusts.
      const lapsedButPending = createMockApproval({
        id: 'apr_lapsed',
        agentName: 'Lapsed Agent',
        status: 'pending',
        expiresAt: new Date(Date.now() - 60000).toISOString(),
      })

      mockFeedByWindow({ actionable: [], passed: [lapsedButPending] })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })
      fireEvent.click(passedTab())

      fireEvent.click(await screen.findByText('Lapsed Agent'))

      // Approving is no longer on offer; the decision window is closed.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))

      // Approve opens the note form; confirming it is what submits.
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'It was the right call' } })
      fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

      expect(mockSubmitFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: 'apr_lapsed',
          decision: 'would_approve',
          // The backend has always accepted a reason on this half; only the
          // rejection side was ever sending one.
          reason: 'It was the right call',
        }),
        expect.anything(),
      )
      expect(mockApprove).not.toHaveBeenCalled()
    })

    it('"All" asks for the actionable view and renders it whole', async () => {
      const pendingApproval = createMockApproval({ id: 'apr_pending', agentName: 'Pending Agent' })

      mockFeedByWindow({ actionable: [pendingApproval], passed: [] })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      const allFilter = screen.getByRole('button', { name: /^all/i })
      expect(allFilter).toHaveClass('segmented-control__option--active')
      expect(screen.getByText('Pending Agent')).toBeInTheDocument()
      expect(useApprovals).toHaveBeenCalledWith(expect.objectContaining({ window: 'actionable' }))
    })
  })

  describe('Paging', () => {
    const mockFetchNextPage = vi.fn()

    function mockPagedFeed(overrides: { hasNextPage?: boolean; isFetchingNextPage?: boolean } = {}) {
      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{
            items: [createMockApproval()],
            total: 40, counts: null, cursor: 'next', hasMore: true,
          }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: mockFetchNextPage,
        hasNextPage: overrides.hasNextPage ?? true,
        isFetchingNextPage: overrides.isFetchingNextPage ?? false,
      })
    }

    it('has no button to press', () => {
      mockPagedFeed()

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
    })

    it('fetches the next page when the end of the list comes into view', () => {
      mockPagedFeed()

      render(<ReviewQueuePage />, { wrapper: createWrapper() })
      expect(mockFetchNextPage).not.toHaveBeenCalled()

      intersect?.([{ isIntersecting: true }])

      expect(mockFetchNextPage).toHaveBeenCalledTimes(1)
    })

    it('does not stack requests while a page is already in flight', () => {
      mockPagedFeed({ isFetchingNextPage: true })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })
      intersect?.([{ isIntersecting: true }])

      expect(mockFetchNextPage).not.toHaveBeenCalled()
    })

    it('stops observing once there is nothing left to fetch', () => {
      mockPagedFeed({ hasNextPage: false })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      // No sentinel is rendered, so no observer was ever constructed.
      expect(intersect).toBeNull()
    })

    it('shows a spinner while the next page loads', () => {
      mockPagedFeed({ isFetchingNextPage: true })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      expect(screen.getByRole('status', { name: /loading more items/i })).toBeInTheDocument()
    })
  })

  describe('Agent filter', () => {
    it('keeps every agent it has seen in the dropdown after scoping to one', async () => {
      // Scoping is server-side now, so the filtered feed contains one agent.
      // A dropdown rebuilt from that feed would collapse to the selected agent
      // and leave no way to reach another one.
      const first = createMockApproval({ id: 'apr_1', agentId: 'agent_1', agentName: 'First Agent' })
      const second = createMockApproval({ id: 'apr_2', agentId: 'agent_2', agentName: 'Second Agent' })

      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      let scopedAgent: string | undefined
      mockUseApprovals.mockImplementation((options?: { agentId?: string }) => {
        scopedAgent = options?.agentId
        const items = options?.agentId
          ? [first, second].filter((a) => a.agentId === options.agentId)
          : [first, second]
        return {
          data: { pages: [{ items, total: items.length, counts: null, cursor: null, hasMore: false }] },
          isLoading: false,
          error: null,
          fetchNextPage: vi.fn(),
          hasNextPage: false,
          isFetchingNextPage: false,
        }
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      const openDropdown = () =>
        fireEvent.click(screen.getByRole('button', { expanded: false, hidden: false }))

      openDropdown()
      fireEvent.click(screen.getByRole('option', { name: 'First Agent' }))

      await waitFor(() => expect(scopedAgent).toBe('agent_1'))

      // Both agents are still reachable from the dropdown.
      openDropdown()
      expect(screen.getByRole('option', { name: 'Second Agent' })).toBeInTheDocument()
    })
  })

  describe('Approval card display', () => {
    it('displays "Decision window passed" text on expired approval detail', () => {
      const expiredApproval = createExpiredApproval()

      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [expiredApproval], total: 1, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      // Click "Passed" filter to see expired items
      const passedFilter = passedTab()
      fireEvent.click(passedFilter)

      // The card's footer shows "Decision window passed" via formatDeadlineTime
      expect(screen.getByText('Decision window passed')).toBeInTheDocument()
    })

    it('shows approval card as button with agent name', () => {
      const expiredApproval = createExpiredApproval()

      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [expiredApproval], total: 1, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      // Click "Passed" filter
      const passedFilter = passedTab()
      fireEvent.click(passedFilter)

      // Find the card button with the agent name
      const card = screen.getByRole('button', { name: /test agent/i })
      expect(card).toBeInTheDocument()
    })
  })

  describe('Expired approval actions', () => {
    it('shows Approve/Reject buttons for expired approvals (calls submitFeedback internally)', async () => {
      const expiredApproval = createExpiredApproval()

      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [expiredApproval], total: 1, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      // Click "Passed" filter
      const passedFilter = passedTab()
      fireEvent.click(passedFilter)

      // Select the expired approval
      const card = screen.getByRole('button', { name: /test agent/i })
      fireEvent.click(card)

      // Should show Approve and Reject buttons (same UI, different backend behavior)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument()
      })
    })

    it('shows rejection reason textarea when Reject is clicked on expired approval', async () => {
      const expiredApproval = createExpiredApproval()

      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [expiredApproval], total: 1, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      // Click "Passed" filter and select approval
      fireEvent.click(passedTab())
      fireEvent.click(screen.getByRole('button', { name: /test agent/i }))

      // Click "Reject" to show the reject form
      await waitFor(() => {
        fireEvent.click(screen.getByRole('button', { name: /reject/i }))
      })

      // Should show rejection reason textarea
      expect(screen.getByPlaceholderText(/explain why this request is being rejected/i)).toBeInTheDocument()
    })
  })

  describe('State management', () => {
    it('resets form state when switching between approvals', async () => {
      const expired1 = createExpiredApproval({ id: 'apr_1', agentName: 'Agent One' })
      const expired2 = createExpiredApproval({ id: 'apr_2', agentName: 'Agent Two' })

      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [expired1, expired2], total: 2, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      // Click "Passed" filter
      fireEvent.click(passedTab())

      // Select first approval and click Reject to show reject form
      fireEvent.click(screen.getByText('Agent One'))
      await waitFor(() => {
        fireEvent.click(screen.getByRole('button', { name: /reject/i }))
      })

      // Type rejection reason
      const textarea = screen.getByPlaceholderText(/explain why this request is being rejected/i)
      fireEvent.change(textarea, { target: { value: 'Test reason' } })

      // Switch to second approval
      fireEvent.click(screen.getByText('Agent Two'))

      // Form state should be reset - no rejection reason textarea visible
      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/explain why this request is being rejected/i)).not.toBeInTheDocument()
      })
    })
  })

  describe('Error handling', () => {
    it('displays error state when feedback submission fails', async () => {
      const expiredApproval = createExpiredApproval()

      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [expiredApproval], total: 1, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      // Mock submission failure - submitFeedback is called when clicking Approve on expired
      mockSubmitFeedback.mockImplementation((_input: unknown, { onError }: { onError: (e: Error) => void }) => {
        onError(new Error('Network error'))
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      // Click "Passed" filter and select approval
      fireEvent.click(passedTab())
      fireEvent.click(screen.getByRole('button', { name: /test agent/i }))

      // Click Approve (which calls submitFeedback for expired approvals)
      await waitFor(() => {
        fireEvent.click(screen.getByRole('button', { name: /approve/i }))
      })
      // The would-approve half opens a note form first now, the way the reject
      // half always has: nothing is being decided once the window has closed,
      // so the explanation is the whole value of the answer.
      fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

      // Should display error message in role="alert"
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
        expect(screen.getByText('Network error')).toBeInTheDocument()
      })
    })
  })

  describe('Accessibility', () => {
    it('approval cards have aria-pressed attribute', async () => {
      const approval = createMockApproval()

      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [approval], total: 1, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      // Approval card should have aria-pressed attribute
      const card = screen.getByRole('button', { name: /test agent/i })
      expect(card).toHaveAttribute('aria-pressed', 'false')

      // Click it and it should be selected
      fireEvent.click(card)
      expect(card).toHaveAttribute('aria-pressed', 'true')
    })

    it('has an ARIA live region for announcements', () => {
      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [createMockApproval()], total: 1, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      const liveRegion = screen.getByRole('status')
      expect(liveRegion).toHaveAttribute('aria-live', 'polite')
    })

    it('rejection reason textarea has a label', async () => {
      const expiredApproval = createExpiredApproval()

      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [expiredApproval], total: 1, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      // Click "Passed" filter, select approval, and click reject
      fireEvent.click(passedTab())
      fireEvent.click(screen.getByRole('button', { name: /test agent/i }))
      await waitFor(() => {
        fireEvent.click(screen.getByRole('button', { name: /reject/i }))
      })

      // The textarea is inside a <label> with text "Rejection reason (optional)"
      const textarea = screen.getByLabelText(/rejection reason/i)
      expect(textarea).toBeInTheDocument()
    })

    it('error message has role="alert"', async () => {
      const expiredApproval = createExpiredApproval()

      const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
      mockUseApprovals.mockReturnValue({
        data: {
          pages: [{ items: [expiredApproval], total: 1, cursor: null, hasMore: false }],
        },
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      })

      // Mock submission failure
      mockSubmitFeedback.mockImplementation((_input: unknown, { onError }: { onError: (e: Error) => void }) => {
        onError(new Error('Test error'))
      })

      render(<ReviewQueuePage />, { wrapper: createWrapper() })

      // Trigger error by clicking Approve on expired approval
      fireEvent.click(passedTab())
      fireEvent.click(screen.getByRole('button', { name: /test agent/i }))
      await waitFor(() => {
        fireEvent.click(screen.getByRole('button', { name: /approve/i }))
      })
      // The would-approve half opens a note form first now, the way the reject
      // half always has: nothing is being decided once the window has closed,
      // so the explanation is the whole value of the answer.
      fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

      await waitFor(() => {
        const errorAlert = screen.getByRole('alert')
        expect(errorAlert).toBeInTheDocument()
      })
    })
  })
})

describe('ReviewQueuePage — generic HITL card summary', () => {
  beforeEach(() => vi.clearAllMocks())

  function renderWith(approval: Record<string, unknown>) {
    const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
    mockUseApprovals.mockReturnValue({
      data: { pages: [{ items: [approval], total: 1, cursor: null, hasMore: false }] },
      isLoading: false, error: null, fetchNextPage: vi.fn(), hasNextPage: false, isFetchingNextPage: false,
    })
    render(<ReviewQueuePage />, { wrapper: createWrapper() })
  }

  it('renders the Action and Why prose the gate wrote', () => {
    renderWith(createMockApproval({
      agentName: 'Eng Assistant',
      reason: 'super_destructive_gate',
      actionSummary: 'Merge pull request #7 in acme/site',
      whySummary: 'Both reviews approved',
      detail: 'github · merge_pull_request — repo site, owner acme',
      pendingToolCalls: [
        { id: 'tc_1', name: 'mcp__github-7d07a896__merge_pull_request', input: { owner: 'acme', repo: 'site' } },
      ],
    }))
    fireEvent.click(screen.getByRole('button', { name: /eng assistant/i }))
    expect(screen.getByText('Merge pull request #7 in acme/site')).toBeInTheDocument()
    expect(screen.getByText(/Both reviews approved/)).toBeInTheDocument()
  })

  it('names the call in words and lists its arguments instead of the flattened line', () => {
    renderWith(createMockApproval({
      agentName: 'Eng Assistant',
      actionSummary: 'Merge pull request #7 in acme/site',
      detail: 'github · merge_pull_request — repo site, owner acme',
      pendingToolCalls: [
        { id: 'tc_1', name: 'mcp__github-7d07a896__merge_pull_request', input: { owner: 'acme', repo: 'site' } },
      ],
    }))
    fireEvent.click(screen.getByRole('button', { name: /eng assistant/i }))

    expect(screen.getByText('GitHub')).toBeInTheDocument()
    expect(screen.getByText('Merge pull request')).toBeInTheDocument()
    expect(screen.getByText('Owner')).toBeInTheDocument()
    expect(screen.getByText('acme')).toBeInTheDocument()
    // The stored line says the same thing worse, so it is not repeated.
    expect(screen.queryByText(/github · merge_pull_request/)).toBeNull()
  })

  /** The report this rendering exists for: one argument, an object, which the
   *  runtime flattens into `category {"type":"general",…` and cuts at 80
   *  characters. The panel showed that string to a person. */
  it('breaks a nested object argument into rows rather than showing cut-off JSON', () => {
    renderWith(createMockApproval({
      agentName: 'Support Triage',
      actionSummary: 'Record a step output with general category and low urgency.',
      detail: 'liftoff · record_step_output — category {"type":"general","urgency":"Low","sensitive":false,"prior_agent_replies":0,"sum…',
      pendingToolCalls: [{
        id: 'tc_1',
        name: 'mcp__liftoff-tools-dd7d80bd__record_step_output',
        input: { category: { type: 'general', urgency: 'Low', sensitive: false } },
      }],
    }))
    fireEvent.click(screen.getByRole('button', { name: /support triage/i }))

    expect(screen.getByText('Liftoff')).toBeInTheDocument()
    expect(screen.getByText('Record step output')).toBeInTheDocument()
    expect(screen.getByText('Category')).toBeInTheDocument()
    expect(screen.getByText('Urgency')).toBeInTheDocument()
    expect(screen.getByText('Low')).toBeInTheDocument()
    // Booleans read as an answer, not as a literal.
    expect(screen.getByText('No')).toBeInTheDocument()
    expect(screen.queryByText(/"type":"general"/)).toBeNull()
  })

  /** Blast radius is the one gate that is about size, and the count only
   *  exists in the stored line. Dropping the whole line would drop it. */
  it('keeps the measurement the blast-radius gate appended to the line', () => {
    renderWith(createMockApproval({
      agentName: 'Revenue Ops',
      reason: 'blast_radius',
      hitlLevel: 2,
      actionSummary: 'Move 142 contacts to the customer lifecycle stage',
      detail: 'hubspot · batch_update_contacts — objectType contacts — This run would have affected 142 items in total (limit 100).',
      pendingToolCalls: [
        { id: 'tc_1', name: 'mcp__hubspot-b81d4f27__batch_update_contacts', input: { objectType: 'contacts' } },
      ],
    }))
    fireEvent.click(screen.getByRole('button', { name: /revenue ops/i }))

    expect(
      screen.getByText('This run would have affected 142 items in total (limit 100).'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/hubspot · batch_update_contacts/)).toBeNull()
  })

  it('still describes the call when the gate wrote no summary', () => {
    renderWith(createMockApproval({ agentName: 'Growth', actionSummary: null }))
    fireEvent.click(screen.getByRole('button', { name: /growth/i }))
    expect(screen.getByText('Send email')).toBeInTheDocument()
    expect(screen.getByText('user@example.com')).toBeInTheDocument()
  })

  it('holds the exact payload behind a toggle, with secrets removed', () => {
    renderWith(createMockApproval({
      agentName: 'Growth',
      actionSummary: null,
      pendingToolCalls: [
        { id: 'tc_1', name: 'sendEmail', input: { to: 'user@example.com', apiKey: 'sk-live-123' } },
      ],
    }))
    fireEvent.click(screen.getByRole('button', { name: /growth/i }))

    const toggle = screen.getByRole('button', { name: 'View request' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)

    const raw = document.querySelector('.tool-call__input')!
    expect(raw.textContent).toContain('user@example.com')
    expect(raw.textContent).not.toContain('sk-live-123')
  })
})

/** An empty queue and a queue we could not read are different facts, and the
 *  page reports one of them with a celebration. The backend's breaker answers
 *  an unreachable runtime with an empty page and a null count, so these tests
 *  pin the difference rather than the happy path. */
describe('ReviewQueuePage — empty, unknown, and loading are not the same', () => {
  /** `total` is the page's own report of the queue size, and it rides the same
   *  response as the items. Null is the backend saying it could not reach the
   *  tenant runtime; a real empty queue reports 0. */
  function renderWithFeed(
    items: unknown[],
    queryState: Record<string, unknown> = {},
    total: number | null = items.length,
  ) {
    const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
    mockUseApprovals.mockReturnValue({
      data: { pages: [{ items, total, counts: null, cursor: null, hasMore: false }] },
      isLoading: false,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      refetch: vi.fn(),
      ...queryState,
    })
    render(<ReviewQueuePage />, { wrapper: createWrapper() })
  }

  it('says the queue could not be loaded when the page total came back null', () => {
    renderWithFeed([], {}, null)

    expect(screen.getByText('This queue could not be loaded')).toBeInTheDocument()
    expect(screen.queryByText('All Caught Up!')).not.toBeInTheDocument()
  })

  it('offers a way to ask again rather than leaving the reader on a dead page', () => {
    renderWithFeed([], {}, null)

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('treats a listing error as unreadable even when a total arrived', () => {
    renderWithFeed([], { error: new Error('network') }, 0)

    expect(screen.getByText('This queue could not be loaded')).toBeInTheDocument()
  })

  it('celebrates only when the runtime actually reported zero', () => {
    renderWithFeed([], {}, 0)

    expect(screen.getByText('All Caught Up!')).toBeInTheDocument()
    expect(screen.queryByText('This queue could not be loaded')).not.toBeInTheDocument()
  })

  it('judges the passed view on its own response, not the actionable count', () => {
    // The count query takes no window. Reading its null-ness here would be a
    // statement about a different queue than the one on screen.
    mockQueueCounts = null
    renderWithFeed([], {}, 0)

    expect(screen.getByText('All Caught Up!')).toBeInTheDocument()
    expect(screen.queryByText('This queue could not be loaded')).not.toBeInTheDocument()
  })

  it('shows neither verdict while the first page is still in flight', () => {
    // The skeleton returns before any of this, so the test only has to prove
    // that a queue nobody has read yet is never reported as one or the other.
    renderWithFeed([], { isLoading: true }, null)

    expect(screen.queryByText('All Caught Up!')).not.toBeInTheDocument()
    expect(screen.queryByText('This queue could not be loaded')).not.toBeInTheDocument()
  })
})

/** Answering and declining are both answers. Until declining existed the only
 *  way to say no was to let the ask expire, which told the team nothing for a
 *  day and looked identical to never having opened the queue. */
describe('ReviewQueuePage — clarifications', () => {
  function createMockClarification(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'clarification' as const,
      id: 'clr_001',
      tenantId: 'test-tenant-id',
      agentId: 'agent_123',
      agentName: 'Research Team',
      threadId: 'thread_abc',
      question: 'Which spreadsheet holds the Q3 figures?',
      source: 'recovery_llm' as const,
      vendorRequestId: null,
      createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
      expiresAt: new Date(Date.now() + 20 * 60 * 60000).toISOString(),
      ...overrides,
    }
  }

  function renderWithClarification(overrides: Record<string, unknown> = {}) {
    mockQueueCounts = { total: 1 }
    const items = [createMockClarification(overrides)]
    const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
    mockUseApprovals.mockReturnValue({
      data: { pages: [{ items, total: 1, counts: null, cursor: null, hasMore: false }] },
      isLoading: false, error: null, fetchNextPage: vi.fn(),
      hasNextPage: false, isFetchingNextPage: false, refetch: vi.fn(),
    })
    render(<ReviewQueuePage />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByRole('button', { name: /research team/i }))
  }

  it('does not offer to open the thread in chat', () => {
    // The thread a clarification carries was minted by the runtime in its own
    // database for any run that had no chat. The chat API cannot resolve it,
    // and the 404 rendered as an empty conversation — telling the reader there
    // was nothing there while the question sat in front of them.
    renderWithClarification()

    expect(screen.queryByText(/open in chat/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('shows the question and its deadline the way an approval shows its own', () => {
    renderWithClarification()

    // Once on the card, once in the panel — the same shape an approval takes.
    expect(screen.getAllByText('Which spreadsheet holds the Q3 figures?')).toHaveLength(2)
    expect(screen.getByText('Waiting on an answer')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^question$/i })).toBeInTheDocument()
  })

  /** Questions are written by the team as markdown — ids in backticks, the ask
   *  in bold, the options as a numbered list. Printed as text, the reader saw
   *  the asterisks and backticks instead of what they stand for. */
  it('renders the question as the markdown it is', () => {
    const question = [
      'Please do one or more of the following for spreadsheet **1G833gSE**:',
      '',
      '1. **Re-share the sheet** with the service account (id: `2b820bc9`).',
      '2. Confirm the first tab exists.',
    ].join('\n')
    renderWithClarification({ question })

    const panel = document.querySelector('.approval-detail__question') as HTMLElement
    expect(panel.querySelector('strong')?.textContent).toBe('1G833gSE')
    expect(panel.querySelector('code')?.textContent).toBe('2b820bc9')
    expect(panel.querySelectorAll('ol > li')).toHaveLength(2)
    expect(panel.textContent).not.toContain('**')
    expect(panel.textContent).not.toContain('`')
  })

  it('shows the card preview without its markup', () => {
    renderWithClarification({
      question: 'Which **spreadsheet** holds the `Q3` figures?',
    })

    const card = document.querySelector('.approval-card__reason')
    expect(card?.textContent).toBe('Which spreadsheet holds the Q3 figures?')
  })

  it('sends a typed answer', () => {
    renderWithClarification()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'The Q3 sheet in Finance' } })
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))

    expect(mockRespondClarification).toHaveBeenCalledWith(
      expect.objectContaining({ clarificationId: 'clr_001', response: 'The Q3 sheet in Finance' }),
      expect.anything(),
    )
  })

  it('lets a reader decline, with the reason carried as the rejection reason is', () => {
    renderWithClarification()

    fireEvent.click(screen.getByRole('button', { name: /continue anyway/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Nobody here owns that system' } })
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    expect(mockDeclineClarification).toHaveBeenCalledWith(
      { clarificationId: 'clr_001', reason: 'Nobody here owns that system' },
      expect.anything(),
    )
  })

  it('declines without a reason rather than demanding one', () => {
    renderWithClarification()

    fireEvent.click(screen.getByRole('button', { name: /continue anyway/i }))
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    expect(mockDeclineClarification).toHaveBeenCalledWith(
      { clarificationId: 'clr_001', reason: undefined },
      expect.anything(),
    )
  })
})

/** A queue is worked top to bottom. Emptying the panel after every decision
 *  made the reader re-find their place in the list each time. */
describe('ReviewQueuePage — selection advances after a decision', () => {
  it('selects the next item once the current one is decided', () => {
    mockQueueCounts = { total: 2 }
    const first = createMockApproval({ id: 'apr_first', agentName: 'First Team' })
    const second = createMockApproval({ id: 'apr_second', agentName: 'Second Team' })
    const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
    mockUseApprovals.mockReturnValue({
      data: { pages: [{ items: [first, second], total: 2, counts: null, cursor: null, hasMore: false }] },
      isLoading: false, error: null, fetchNextPage: vi.fn(),
      hasNextPage: false, isFetchingNextPage: false, refetch: vi.fn(),
    })
    // The real hook removes the row optimistically; here the list is static, so
    // the assertion is only about where selection lands.
    mockApprove.mockImplementation((_vars: unknown, opts: { onSuccess: () => void }) => opts.onSuccess())

    render(<ReviewQueuePage />, { wrapper: createWrapper() })

    fireEvent.click(screen.getByRole('button', { name: /first team/i }))
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(screen.getByRole('button', { name: /second team/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('falls back to the item above when the last one is decided', () => {
    mockQueueCounts = { total: 2 }
    const first = createMockApproval({ id: 'apr_first', agentName: 'First Team' })
    const second = createMockApproval({ id: 'apr_second', agentName: 'Second Team' })
    const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
    mockUseApprovals.mockReturnValue({
      data: { pages: [{ items: [first, second], total: 2, counts: null, cursor: null, hasMore: false }] },
      isLoading: false, error: null, fetchNextPage: vi.fn(),
      hasNextPage: false, isFetchingNextPage: false, refetch: vi.fn(),
    })
    mockApprove.mockImplementation((_vars: unknown, opts: { onSuccess: () => void }) => opts.onSuccess())

    render(<ReviewQueuePage />, { wrapper: createWrapper() })

    fireEvent.click(screen.getByRole('button', { name: /second team/i }))
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(screen.getByRole('button', { name: /first team/i })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('ReviewQueuePage — clarification panel shape and refusals', () => {
  function renderClarification(overrides: Record<string, unknown> = {}) {
    mockQueueCounts = { total: 1 }
    const items = [{
      kind: 'clarification' as const,
      id: 'clr_100',
      tenantId: 'test-tenant-id',
      agentId: 'agent_123',
      agentName: 'Research Team',
      threadId: 'thread_abc',
      question: 'Which sheet?',
      source: 'recovery_llm' as const,
      vendorRequestId: null,
      createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
      expiresAt: new Date(Date.now() + 20 * 60 * 60000).toISOString(),
      ...overrides,
    }]
    const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
    mockUseApprovals.mockReturnValue({
      data: { pages: [{ items, total: 1, counts: null, cursor: null, hasMore: false }] },
      isLoading: false, error: null, fetchNextPage: vi.fn(),
      hasNextPage: false, isFetchingNextPage: false, refetch: vi.fn(),
    })
    const utils = render(<ReviewQueuePage />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByRole('button', { name: /research team/i }))
    return utils
  }

  it('puts every action in one row, so the panel draws one divider like the approval panel', () => {
    // Both `.approval-detail__reject-form` and `.approval-detail__actions`
    // carry a top border. Rendering them together drew two rules where the
    // approval panel draws one.
    const { container } = renderClarification()

    expect(container.querySelectorAll('.approval-detail__reject-form')).toHaveLength(1)
    expect(container.querySelectorAll('.approval-detail__actions')).toHaveLength(0)
    // Both actions live in the form's own row.
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue anyway/i })).toBeInTheDocument()
  })

  it('does not offer to decline an Anchor intervention', () => {
    // It resumes by handing text to a live browser session and the vendor has
    // no abort, so a decline would type "no answer is available" into somebody's
    // browser as though it were the instruction they were waiting for.
    renderClarification({ source: 'anchor_intervention', vendorRequestId: 'req-1' })

    expect(screen.queryByRole('button', { name: /continue anyway/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument()
  })
})

describe('clarificationErrorMessage', () => {
  it('tells a settled question apart from a failure', () => {
    expect(clarificationErrorMessage(new ApiError('gone', 404), 'answer'))
      .toBe('This question is no longer waiting for an answer')
  })

  it('names the race rather than blaming the reader', () => {
    expect(clarificationErrorMessage(new ApiError('clarification already resolved', 409), 'answer'))
      .toBe('Someone else already answered this question')
  })

  it('distinguishes a refusal to decline from a lost race', () => {
    expect(clarificationErrorMessage(
      new ApiError('anchor_intervention clarifications cannot be declined', 409), 'decline',
    )).toBe('This question cannot be declined')
  })

  it('falls back to a plain failure for anything else', () => {
    expect(clarificationErrorMessage(new ApiError('boom', 500), 'decline')).toBe('Failed to send')
    expect(clarificationErrorMessage(new Error('offline'), 'answer')).toBe('Failed to send reply')
  })
})

describe('ReviewQueuePage — late feedback advances like every other action', () => {
  it('moves to the next item once feedback is recorded', async () => {
    const first = createExpiredApproval({ id: 'apr_a', agentName: 'First Team' })
    const second = createExpiredApproval({ id: 'apr_b', agentName: 'Second Team' })
    mockFeedByWindow({ actionable: [], passed: [first, second] })
    mockSubmitFeedback.mockImplementation(
      (_input: unknown, { onSuccess }: { onSuccess: () => void }) => onSuccess(),
    )

    render(<ReviewQueuePage />, { wrapper: createWrapper() })
    fireEvent.click(passedTab())

    fireEvent.click(await screen.findByText('First Team'))
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /second team/i })).toHaveAttribute('aria-pressed', 'true')
    })
  })
})

/** Approving can now say why. A rejection has always been able to explain
 *  itself and an approval never could, so the learning loop only ever heard
 *  half of each decision. */
describe('ReviewQueuePage — a live approval can carry a note', () => {
  function renderApproval(overrides: Record<string, unknown> = {}) {
    mockQueueCounts = { total: 1 }
    mockFeedByWindow({ actionable: [createMockApproval({ agentName: 'Ops Team', ...overrides })], passed: [] })
    render(<ReviewQueuePage />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByRole('button', { name: /ops team/i }))
  }

  /** The standing-policy choice is not part of the button group. It shares the
   *  design system's checkbox with every other one in the product, and it sits
   *  on a line of its own under the buttons in both states, so opening the note
   *  form does not move it. */
  it('keeps the standing-policy checkbox below the buttons, open or closed', () => {
    renderApproval()

    const line = document.querySelector('.approval-detail__always-apply')!
    expect(line.querySelector('.checkbox')).toBeTruthy()
    expect(
      line.compareDocumentPosition(document.querySelector('.approval-detail__action-buttons')!),
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING)

    fireEvent.click(screen.getByRole('button', { name: /add a note/i }))

    const extra = document.querySelector('.reject-form__extra')!
    expect(extra.querySelector('.checkbox')).toBeTruthy()
    expect(
      extra.compareDocumentPosition(document.querySelector('.reject-form__actions')!),
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING)
  })

  it('keeps approving to one click when nobody wants to explain', () => {
    renderApproval()

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(mockApprove).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'apr_001', approvalNote: undefined }),
      expect.anything(),
    )
  })

  it('sends the note when one is written', () => {
    renderApproval()

    fireEvent.click(screen.getByRole('button', { name: /add a note/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Vendor already vetted' } })
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(mockApprove).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'apr_001', approvalNote: 'Vendor already vetted' }),
      expect.anything(),
    )
  })

  it('treats a whitespace-only note as no note rather than storing blank memory', () => {
    renderApproval()

    fireEvent.click(screen.getByRole('button', { name: /add a note/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(mockApprove).toHaveBeenCalledWith(
      expect.objectContaining({ approvalNote: undefined }),
      expect.anything(),
    )
  })

  it('carries the standing-policy choice through the note form', () => {
    // Opening the note form must not lose "always apply" — the note is the
    // rationale for exactly that standing decision.
    renderApproval()

    fireEvent.click(screen.getByRole('button', { name: /add a note/i }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Safe for this team' } })
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(mockApprove).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysApply: true, approvalNote: 'Safe for this team' }),
      expect.anything(),
    )
  })

  it('does not offer a note where there is no decision left to make', async () => {
    // The passed view has its own late-feedback form; a live approve note
    // would be offering a decision whose window has closed.
    mockQueueCounts = { total: 1 }
    mockFeedByWindow({ actionable: [], passed: [createExpiredApproval({ agentName: 'Lapsed Team' })] })
    render(<ReviewQueuePage />, { wrapper: createWrapper() })
    fireEvent.click(passedTab())
    fireEvent.click(await screen.findByText('Lapsed Team'))

    expect(screen.queryByRole('button', { name: /add a note/i })).not.toBeInTheDocument()
  })
})

/** The compare link is the whole point of a merge approval: nobody can judge a
 *  merge from the panel text alone. It used to render only on the legacy
 *  no-summary path, which is the branch production stopped taking once the gate
 *  started writing card summaries. */
describe('ReviewQueuePage — merge approvals link out to the branch', () => {
  function renderMerge(overrides: Record<string, unknown> = {}) {
    mockQueueCounts = { total: 1 }
    mockFeedByWindow({
      actionable: [createMockApproval({
        agentName: 'Eng Team',
        reason: 'merge_to_main',
        pendingToolCalls: [{
          id: 'tc_1',
          name: 'mcp__github-7d07a896__merge_pull_request',
          input: { owner: 'acme', repo: 'storefront', head: 'feature/checkout-copy' },
        }],
        ...overrides,
      })],
      passed: [],
    })
    render(<ReviewQueuePage />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByRole('button', { name: /eng team/i }))
  }

  it('shows the link beside a card summary, not only on the raw fallback', () => {
    renderMerge({ actionSummary: 'Merge pull request #482 into main' })

    expect(screen.getByRole('link', { name: /view branch on github/i }))
      .toHaveAttribute('href', 'https://github.com/acme/storefront/compare/feature/checkout-copy')
  })

  it('still shows it on the raw fallback', () => {
    renderMerge({ actionSummary: null })

    expect(screen.getByRole('link', { name: /view branch on github/i })).toBeInTheDocument()
  })

  it('says nothing when the call does not carry a branch', () => {
    renderMerge({
      actionSummary: 'Merge something',
      pendingToolCalls: [{ id: 'tc_1', name: 'merge_branch', input: { owner: 'acme' } }],
    })

    expect(screen.queryByRole('link', { name: /view branch on github/i })).not.toBeInTheDocument()
  })
})

/** The heading on every card and panel is who is asking.
 *
 *  Every other test in this file passes `agentName`, so none of them exercise
 *  what the page renders without one. These do, because the id is not a
 *  substitute: it is the tenant runtime's `agents.id`, a different id space
 *  from the `internal_agents.id` the Teams pages use, so there is nothing on
 *  the client to resolve it against and nothing a reader can do with it.
 */
describe('ReviewQueuePage — who is asking', () => {
  function renderQueue(items: Record<string, unknown>[]) {
    mockQueueCounts = { total: items.length }
    const mockUseApprovals = useApprovals as ReturnType<typeof vi.fn>
    mockUseApprovals.mockReturnValue({
      data: { pages: [{ items, total: items.length, counts: null, cursor: null, hasMore: false }] },
      isLoading: false, error: null, fetchNextPage: vi.fn(),
      hasNextPage: false, isFetchingNextPage: false, refetch: vi.fn(),
    })
    render(<ReviewQueuePage />, { wrapper: createWrapper() })
  }

  const clarification = (overrides: Record<string, unknown> = {}) => ({
    kind: 'clarification' as const,
    id: 'clr_name',
    tenantId: 'test-tenant-id',
    agentId: '9f31c2ae-4d70-4b18-9c55-0a1e6b83d240',
    agentName: 'Code Reviewer',
    threadId: 'thread_abc',
    question: 'Which repository should I open the pull request against?',
    source: 'recovery_llm' as const,
    vendorRequestId: null,
    createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
    expiresAt: new Date(Date.now() + 20 * 60 * 60000).toISOString(),
    ...overrides,
  })

  it('names the team on a clarification card and panel', () => {
    renderQueue([clarification()])

    fireEvent.click(screen.getByRole('button', { name: /code reviewer/i }))

    expect(screen.getAllByText('Code Reviewer').length).toBeGreaterThan(0)
  })

  it('names the team on an approval card', () => {
    renderQueue([createMockApproval({ agentName: 'Release Coordinator' })])

    expect(screen.getAllByText('Release Coordinator').length).toBeGreaterThan(0)
  })

  it('never puts a raw id in front of the reader when the name is missing', () => {
    renderQueue([clarification({ agentName: null })])

    expect(screen.queryByText(/9f31c2ae/)).not.toBeInTheDocument()
    expect(screen.getAllByText('Unknown agent').length).toBeGreaterThan(0)
  })

  it('says the same thing when the field never arrives at all', () => {
    const { agentName: _omitted, ...withoutName } = clarification()
    renderQueue([withoutName])

    expect(screen.queryByText(/9f31c2ae/)).not.toBeInTheDocument()
    expect(screen.getAllByText('Unknown agent').length).toBeGreaterThan(0)
  })

  it('offers the team by name in the scope filter, not by id', () => {
    renderQueue([clarification()])

    expect(screen.queryByText(/Agent 9f31c2ae/)).not.toBeInTheDocument()
    expect(screen.getAllByText('Code Reviewer').length).toBeGreaterThan(0)
  })
})
