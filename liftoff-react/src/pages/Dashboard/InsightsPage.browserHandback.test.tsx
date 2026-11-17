import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// The person's hand-back and point on the Insights Manager's thread: rows about
// the conversation in the person's name, drawn as status lines, never as
// speech, and never attributed to a colleague.

Element.prototype.scrollIntoView = vi.fn()

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useLocation: () => ({ state: { threadId: 'thread-1' }, pathname: '/dashboard/insights' }),
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
vi.mock('../../services/agentChat', () => ({
  createChatShare: vi.fn(),
}))
vi.mock('../../hooks/useInsightsThreads', () => ({
  INSIGHTS_THREADS_QUERY_KEY: ['insights-threads'],
  useCreateInsightsThread: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useInsightsThreads: () => ({ data: undefined, isLoading: false }),
}))
const row = (overrides: Record<string, unknown>) => ({
  id: 'm-x', threadId: 'thread-1', role: 'assistant', content: '', visualizationBlocks: null, messageType: null,
  contributors: [], inputTokens: 0, outputTokens: 0, createdAt: '2026-09-19T10:00:00.000Z', ...overrides,
})
vi.mock('../../hooks/useInsightsMessages', () => ({
  INSIGHTS_MESSAGES_QUERY_KEY: ['insights-messages'],
  useInsightsMessages: () => ({
    data: {
      pages: [{
        // Newest first, as the messages query answers.
        messages: [
          row({ id: 'p1', content: 'Ada Lovelace pointed at link "Sports"', messageType: 'browser_point', createdAt: '2026-09-19T10:01:00.000Z' }),
          row({ id: 'h1', content: 'Ada Lovelace handed the browser back', messageType: 'browser_handback' }),
        ],
      }],
    },
  }),
}))
vi.mock('../../hooks/useInsightsCounts', () => ({
  INSIGHTS_COUNTS_QUERY_KEY: ['insights-counts'],
  useInsightsCounts: () => ({ counts: { isEmpty: true }, isLoading: false }),
}))
vi.mock('../../hooks/useInsightsReport', () => ({ useInsightsReport: () => ({ blocks: [], isLoading: false }) }))
vi.mock('../../hooks/useInsightsObservations', () => ({ useInsightsObservations: () => ({ observations: [], isLoading: false }) }))
vi.mock('../../hooks/useInsightsIntro', () => ({ useInsightsIntro: () => ({ intro: null, isLoading: false }) }))
vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ liftoffScoreEnabled: false }) }))
vi.mock('../../hooks/useTenant', () => ({ useTenant: () => ({ currentTenant: { id: 'tenant-1', name: 'Test' } }) }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ account: { id: 'account-1' } }) }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
vi.mock('../../hooks/useDictation', () => ({ useDictation: () => ({ isListening: false, toggle: vi.fn() }) }))
vi.mock('../../hooks/useThreadPresence', () => ({ useThreadPresence: () => ({ viewers: [], liveTurnId: null }) }))
vi.mock('../../hooks/chatPresenceTransports', () => ({ insightsPresenceTransport: {} }))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

import InsightsPage from './InsightsPage'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <InsightsPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => { vi.clearAllMocks() })

describe("the person's browser events on the Insights Manager's thread", () => {
  it('draws the hand-back and the point as status lines in their name, not as speech, with no chip', () => {
    const { container } = renderPage()
    const rows = container.querySelectorAll('.chat-page__hitl-status')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Ada Lovelace handed the browser back')
    expect(rows[1]).toHaveTextContent('Ada Lovelace pointed at link "Sports"')
    expect(rows[0].querySelector('.chat-message__sender-avatar')).toBeNull()
    expect(rows[0].closest('.chat-message__bubble')).toBeNull()
    expect(container.querySelector('.chat-message__bubble')).not.toBeInTheDocument()
  })
})
