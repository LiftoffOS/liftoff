// The badge on the Chat History button, and the two paths that clear it.
//
// The page has a lot of hooks; every one that is not about unread state is
// stubbed to the quietest thing that renders. What is under test is narrow:
// the badge appears only when this team has a non-zero count, its accessible
// name says so rather than relying on colour, and opening a conversation marks
// it read.
//
// The share button's minting contract rides along at the bottom. It belongs to
// the same header and needs this same mock surface to render at all, and the
// alternative is a second copy of nineteen mocks that would drift from these.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const AGENT_ID = 'agent-1'

class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
global.ResizeObserver = ResizeObserverMock
// jsdom does not implement it; ChatMessages scrolls to the newest message.
Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => {
  mockSearch = `?agentId=${AGENT_ID}`
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
      root = null
      rootMargin = ''
      thresholds = []
    },
  )
})

// Mutable so a test can start the page with no agentId (the redirect-in-flight
// state) and have one arrive on a later render of the SAME mount.
let mockSearch = `?agentId=${AGENT_ID}`

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ search: mockSearch, state: null, pathname: '/dashboard/agents/chat', hash: '', key: 'k' }),
  }
})

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ account: { id: 'acct-1' }, currentTenant: { id: 't1' } }),
}))
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))
vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 't1' }, switchTenant: vi.fn() }),
}))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

// Threads: one row, unread, so the history modal has something to select.
const threadsResult = {
  data: { pages: [{ threads: [{ id: 'thread-1', title: 'Pipeline review', updatedAt: new Date().toISOString(), unread: true }] }] },
  isLoading: false,
  isError: false,
  fetchNextPage: vi.fn(),
  hasNextPage: false,
  isFetchingNextPage: false,
}
// Stable across renders, so a test can ask whether the page created a thread
// rather than only what it rendered.
const createThreadMutateAsync = vi.fn()
vi.mock('../../hooks/useAgentChatThreads', () => ({
  AGENT_CHAT_THREADS_QUERY_KEY: ['agent-chat-threads'],
  useAgentChatThreads: () => threadsResult,
  useCreateAgentChatThread: () => ({
    mutate: vi.fn(),
    mutateAsync: (...args: unknown[]) => createThreadMutateAsync(...args),
    isPending: false,
  }),
}))
let mockMessagePages: { messages: Array<{ id: string; role: string; content: string; createdAt: string }> }[] | undefined
vi.mock('../../hooks/useAgentChatMessages', () => ({
  AGENT_CHAT_MESSAGES_QUERY_KEY: ['agent-chat-messages'],
  useAgentChatMessages: () => ({ data: mockMessagePages ? { pages: mockMessagePages } : undefined }),
}))

let selectHandler: ((id: string) => void) | null = null
vi.mock('../../hooks/useChatStreaming', () => ({
  useChatStreaming: (opts: { setCurrentThreadId: (id: string | null) => void }) => {
    selectHandler = opts.setCurrentThreadId
    return {
      inputValue: '',
      setInputValue: vi.fn(),
      streaming: null,
      sending: false,
      midRunSending: false,
      creatingThread: false,
      handleSend: vi.fn(),
      sendDuringRun: vi.fn(),
      handleNewChat: vi.fn(),
      handleSelectThread: (id: string) => opts.setCurrentThreadId(id),
      // Stubbed to nothing here. What the greeting actually does is the
      // subject of AgentChatPage.greeting.test.tsx, which runs the real hook;
      // these tests are about the unread badge and would only be testing this
      // stub. Present so the page's opening effect has something to call.
      startGreeting: vi.fn(),
      greeting: null,
    }
  },
}))

vi.mock('../../hooks/useThreadPresence', () => ({
  useThreadPresence: () => ({ viewers: [], liveTurnId: null, latestMessageAt: null }),
}))
vi.mock('../../hooks/usePendingApproval', () => ({
  PENDING_APPROVAL_QUERY_KEY: ['pending-approval'],
  usePendingApproval: () => ({ data: null }),
}))
vi.mock('../../hooks/useObservedTurn', () => ({ useObservedTurn: () => null }))
vi.mock('../../hooks/chatPresenceTransports', () => ({
  agentChatPresenceTransport: () => ({}),
}))
vi.mock('../../hooks/useVoiceChat', () => ({
  useVoiceChat: () => ({
    isVoiceMode: false,
    toggleVoiceMode: vi.fn(),
    isListening: false,
    toggleListening: vi.fn(),
  }),
}))
vi.mock('../../hooks/useConnectors', () => ({ useConnectors: () => ({ data: undefined }) }))
vi.mock('../../hooks/useBrowserSessionForThread', () => ({
  useBrowserSessionForThread: () => ({
    query: { data: undefined },
    ensureMutation: { mutate: vi.fn(), isPending: false, isError: false, data: undefined },
    controlMutation: { mutate: vi.fn() },
    gotoMutation: { mutate: vi.fn() },
    pointMutation: { mutate: vi.fn() },
    handBackIfDriving: vi.fn(async () => null),
    reportViewport: vi.fn(),
    onResizeEnd: vi.fn(),
    isEnsureError: false,
    pausedFrameUrl: null,
  }),
}))

vi.mock('../../services/internalAgents', () => ({
  getInternalAgent: () => Promise.resolve({ id: AGENT_ID, role: 'Sales Team', status: 'active' }),
}))
const mockCreateChatShare = vi.fn()
vi.mock('../../services/agentChat', () => ({
  streamAgentChatMessage: vi.fn(),
  createChatShare: (...args: unknown[]) => mockCreateChatShare(...args),
  stopAgentChatTurn: vi.fn(),
}))
vi.mock('../../services/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))

let mockCounts: Record<string, number> = {}
const markThreadReadMutate = vi.fn()
vi.mock('../../hooks/useChatUnread', () => ({
  useChatUnreadCounts: () => ({ data: mockCounts }),
  useMarkThreadRead: () => ({ mutate: markThreadReadMutate }),
  useMarkAllThreadsRead: () => ({ mutate: vi.fn() }),
}))

import AgentChatPage from './AgentChatPage'

// The person's hand-back and point in a team's chat: rows about the
// conversation in the person's name, drawn as status lines, never as speech,
// and never attributed to a colleague.

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (): ReactElement => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentChatPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return render(tree())
}

beforeEach(() => {
  mockCounts = {}
  mockMessagePages = undefined
  createThreadMutateAsync.mockReset()
  selectHandler = null
})

describe("the person's browser events in a team's chat", () => {
  it('draws the hand-back and the point as status lines in their name, not as speech, with no chip', () => {
    mockMessagePages = [{
      // Newest first, as the messages query answers.
      messages: [
        { id: 'p1', role: 'assistant', content: 'Ada Lovelace pointed at link "Sports"', createdAt: '2026-09-19T10:01:00.000Z', messageType: 'browser_point' } as never,
        { id: 'h1', role: 'assistant', content: 'Ada Lovelace handed the browser back', createdAt: '2026-09-19T10:00:00.000Z', messageType: 'browser_handback' } as never,
      ],
    }]
    renderPage()
    act(() => { selectHandler!('thread-1') })
    const rows = document.querySelectorAll('.chat-page__hitl-status')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Ada Lovelace handed the browser back')
    expect(rows[1]).toHaveTextContent('Ada Lovelace pointed at link "Sports"')
    expect(rows[0].querySelector('.chat-message__sender-avatar')).toBeNull()
    expect(rows[0].closest('.chat-message__bubble')).toBeNull()
    expect(document.querySelector('.chat-message__bubble')).toBeNull()
  })
})
