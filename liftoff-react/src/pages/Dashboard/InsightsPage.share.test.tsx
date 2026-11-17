import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Sharing a workspace insights thread. This surface has no team behind it, so
// the share is minted with no agentId at all: the backend rejects the field
// outright for this kind, and sending it would 400 the click.

// jsdom has no layout, so the conversation's auto-scroll needs a stub.
Element.prototype.scrollIntoView = vi.fn()

let mockLocationState: unknown = null
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useLocation: () => ({ state: mockLocationState, pathname: '/dashboard/insights' }),
    useNavigate: () => vi.fn(),
  }
})

vi.mock('../../services/insightsChat', () => ({
  // The page asks whether work is queued to continue an earlier turn on the
  // open conversation; nothing is, on a page these tests are about.
  getInsightsThreadContinuation: vi.fn().mockResolvedValue(null),
  streamInsightsChatMessage: vi.fn(),
  stopInsightsChatTurn: vi.fn(),
  markInsightsThreadRead: vi.fn().mockResolvedValue(undefined),
  getInsightsUnreadCount: vi.fn().mockResolvedValue({ count: 0 }),
}))

const mockCreateChatShare = vi.fn()
vi.mock('../../services/agentChat', () => ({
  createChatShare: (...args: unknown[]) => mockCreateChatShare(...args),
}))

const mockCreateThread = vi.fn()
vi.mock('../../hooks/useInsightsThreads', () => ({
  INSIGHTS_THREADS_QUERY_KEY: ['insights-threads'],
  useCreateInsightsThread: () => ({ mutateAsync: mockCreateThread, isPending: false }),
  useInsightsThreads: () => ({ data: undefined, isLoading: false }),
}))

vi.mock('../../hooks/useInsightsMessages', () => ({
  INSIGHTS_MESSAGES_QUERY_KEY: ['insights-messages'],
  useInsightsMessages: () => ({ data: undefined }),
}))

// The report above the conversation is not what is under test here; an empty
// workspace renders the onboarding text and makes no further requests.
vi.mock('../../hooks/useInsightsCounts', () => ({
  INSIGHTS_COUNTS_QUERY_KEY: ['insights-counts'],
  useInsightsCounts: () => ({ counts: { isEmpty: true }, isLoading: false }),
}))
vi.mock('../../hooks/useInsightsReport', () => ({
  useInsightsReport: () => ({ blocks: [], isLoading: false }),
}))
vi.mock('../../hooks/useInsightsObservations', () => ({
  useInsightsObservations: () => ({ observations: [], isLoading: false }),
}))
vi.mock('../../hooks/useInsightsIntro', () => ({
  useInsightsIntro: () => ({ intro: null, isLoading: false }),
}))

vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ liftoffScoreEnabled: false }),
}))

vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1', name: 'Test' } }),
}))

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ account: { id: 'account-1' } }),
}))

const mockShowToast = vi.fn()
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

vi.mock('../../hooks/useDictation', () => ({
  useDictation: () => ({ isListening: false, toggle: vi.fn() }),
}))

// Presence is not what is under test here, and a live roster would draw faces
// into the header the share assertions read.
vi.mock('../../hooks/useThreadPresence', () => ({
  useThreadPresence: () => ({ viewers: [], liveTurnId: null }),
}))

vi.mock('../../hooks/chatPresenceTransports', () => ({
  insightsPresenceTransport: {},
}))

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

import { track } from '../../lib/analytics'
import InsightsPage from './InsightsPage'

const THREAD_ID = 'thread-1'
const COPIED_TOAST =
  'Link copied to your clipboard. This link is only accessible to members of your workspace'

const mockWriteText = vi.fn()

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <InsightsPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Arriving from /share/<id>: the resolver hands the thread over as router
  // state, which is also what puts a thread on screen to share.
  mockLocationState = { threadId: THREAD_ID }
  mockCreateThread.mockResolvedValue({ thread: { id: THREAD_ID } })
  mockCreateChatShare.mockResolvedValue({ id: 'share-42' })
  mockWriteText.mockResolvedValue(undefined)
  // jsdom ships no clipboard, and no ClipboardItem either, so the handler
  // takes its pre-ClipboardItem branch.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mockWriteText },
    configurable: true,
  })
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('InsightsPage sharing', () => {
  it('opens the thread the share link resolved to', () => {
    renderPage()

    expect(screen.getByLabelText('Share')).toBeInTheDocument()
  })

  it('offers nothing to share before a conversation exists', () => {
    mockLocationState = null

    renderPage()

    expect(screen.queryByLabelText('Share')).not.toBeInTheDocument()
  })

  it('mints an insights share with no team on it', async () => {
    renderPage()

    fireEvent.click(screen.getByLabelText('Share'))

    await waitFor(() => expect(mockCreateChatShare).toHaveBeenCalledTimes(1))
    const input = mockCreateChatShare.mock.calls[0][0] as Record<string, unknown>
    expect(input).toEqual({
      tenantId: 'tenant-1',
      threadId: THREAD_ID,
      threadKind: 'insights',
    })
    // Belt and braces: toEqual would pass on an explicit undefined.
    expect('agentId' in input).toBe(false)
  })

  it('copies the share URL and says so', async () => {
    renderPage()

    fireEvent.click(screen.getByLabelText('Share'))

    await waitFor(() =>
      expect(mockWriteText).toHaveBeenCalledWith(`${window.location.origin}/share/share-42`),
    )
    expect(mockShowToast).toHaveBeenCalledWith(COPIED_TOAST, 'success')
    expect(track).toHaveBeenCalledWith('insights_share_created', { thread_id: THREAD_ID })
  })

  it('mints once per thread and copies the cached URL on a repeat click', async () => {
    renderPage()

    fireEvent.click(screen.getByLabelText('Share'))
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByLabelText('Share'))
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(2))
    expect(mockCreateChatShare).toHaveBeenCalledTimes(1)
  })

  it('says so when the link could not be minted', async () => {
    mockCreateChatShare.mockRejectedValue(new Error('500'))

    renderPage()
    fireEvent.click(screen.getByLabelText('Share'))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Could not copy the share link. Please try again.',
        'error',
      ),
    )
    expect(track).not.toHaveBeenCalledWith('insights_share_created', { thread_id: THREAD_ID })
  })
})
