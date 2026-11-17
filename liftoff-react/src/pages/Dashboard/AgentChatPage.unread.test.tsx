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
import { act, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
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
    handBackIfDriving: vi.fn(async () => undefined),
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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (): ReactElement => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentChatPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const result = render(tree())
  return {
    ...result,
    /** Re-render the SAME mounted page so mocked hook data changes are picked
     *  up without remounting — a remount would re-seed the reply watcher. */
    refresh: () => act(() => { result.rerender(tree()) }),
  }
}

/** Drive the page's own setCurrentThreadId, the seam every selection path uses. */
function selectThread(threadId: string) {
  act(() => { selectHandler!(threadId) })
}

beforeEach(() => {
  mockCounts = {}
  mockMessagePages = undefined
  markThreadReadMutate.mockClear()
  mockCreateChatShare.mockReset()
  mockCreateChatShare.mockResolvedValue({ id: 'share-42' })
  createThreadMutateAsync.mockReset()
  createThreadMutateAsync.mockResolvedValue({ thread: { id: 'auto-created-thread' } })
  selectHandler = null
})

// The bug this is here to stop coming back.
//
// If opening this page creates a thread and streams a greeting into it, every
// visit nobody types into leaves a permanent row behind. No turn runs, so
// nothing ever titles it, and Chat History fills up with "Untitled chat". A
// "fix" that deletes the wrong line looks the same in a commit message, which
// is exactly why the assertion is on the create call rather than on anything
// rendered.
describe('AgentChatPage does not start a conversation nobody asked for', () => {
  it('creates no thread when the page is opened', () => {
    renderPage()

    expect(createThreadMutateAsync).not.toHaveBeenCalled()
  })
})

/** A page of persisted messages, newest first, as useAgentChatMessages returns them. */
function messagePage(ids: Array<[string, string]>) {
  return [{
    messages: ids
      .map(([id, role]) => ({ id, role, content: 'x', createdAt: '2026-08-07T12:00:00.000Z' }))
      .reverse(),
  }]
}

describe('AgentChatPage chat history badge', () => {
  it('shows the dot when this team has a non-zero count', () => {
    mockCounts = { [AGENT_ID]: 2 }

    renderPage()

    expect(document.querySelector('.chat-page__icon-btn-dot')).toBeInTheDocument()
  })

  it('shows nothing when the count is for a different team', () => {
    mockCounts = { 'some-other-agent': 5 }

    renderPage()

    expect(document.querySelector('.chat-page__icon-btn-dot')).toBeNull()
    expect(screen.getByRole('button', { name: 'Chat History' })).toBeInTheDocument()
  })

  it('says so in the accessible name, not in colour alone', () => {
    mockCounts = { [AGENT_ID]: 1 }

    renderPage()

    expect(
      screen.getByRole('button', { name: 'Chat History, unread replies' }),
    ).toBeInTheDocument()
  })
})

describe('AgentChatPage marks threads read', () => {
  it('marks the thread read when one is selected from the history modal', async () => {
    mockCounts = { [AGENT_ID]: 1 }

    renderPage()
    await userEvent.click(
      screen.getByRole('button', { name: 'Chat History, unread replies' }),
    )
    // Anchored: the row's Mark as Read button also names the thread.
    await userEvent.click(screen.getByRole('button', { name: /^(Unread reply)?Pipeline review/ }))

    expect(markThreadReadMutate).toHaveBeenCalledWith('thread-1')
  })

  it('marks the thread read when arriving by deep link', async () => {
    // Selection through the same seam the deep-link effect uses: the page's
    // own setCurrentThreadId, which is what useChatStreaming was handed.
    renderPage()
    expect(selectHandler).not.toBeNull()

    markThreadReadMutate.mockClear()
    selectThread('thread-2')

    expect(markThreadReadMutate).toHaveBeenCalledWith('thread-2')
  })

  it('does not re-post when the thread already on screen is selected again', async () => {
    renderPage()
    selectThread('thread-1')
    markThreadReadMutate.mockClear()

    selectThread('thread-1')

    expect(markThreadReadMutate).not.toHaveBeenCalled()
  })
})

// The reply-watcher. A reply can reach an open thread three ways: this reader's
// own SSE stream, the presence poll surfacing somebody else's turn, and the
// tenant-runtime settle callback landing after the stream closed. Keying on the
// newest persisted reply catches all three; keying on the stream ending caught
// one and raced the third.
describe('AgentChatPage marks a reply read while the thread is open', () => {
  it('does not post again while the newest reply is unchanged', async () => {
    mockMessagePages = messagePage([['m1', 'user'], ['m2', 'assistant']])

    const { refresh } = renderPage()
    selectThread('thread-1')
    markThreadReadMutate.mockClear()

    // Nothing new arrived: presence polls every few seconds and re-renders this
    // page constantly, so an unguarded watcher would post on every tick.
    refresh()
    refresh()
    refresh()

    expect(markThreadReadMutate).not.toHaveBeenCalled()
  })

  it('marks the FIRST reply on a brand-new thread read', async () => {
    // The case a "skip the first load as history" guard gets wrong, and the one
    // that matters most: the reader opened an empty thread, sent a message and
    // watched the answer arrive. It must not be unread the moment they leave.
    mockMessagePages = messagePage([['m1', 'user']])

    const { refresh } = renderPage()
    selectThread('thread-new')
    markThreadReadMutate.mockClear()

    mockMessagePages = messagePage([['m1', 'user'], ['m2', 'assistant']])
    refresh()

    expect(markThreadReadMutate).toHaveBeenCalledWith('thread-new')
  })

  it('posts when a new reply lands on the open thread', async () => {
    mockMessagePages = messagePage([['m1', 'user'], ['m2', 'assistant']])

    const { refresh } = renderPage()
    selectThread('thread-1')
    markThreadReadMutate.mockClear()

    // A reply arrives: the transcript grows a newer assistant row.
    mockMessagePages = messagePage([['m1', 'user'], ['m2', 'assistant'], ['m3', 'assistant']])
    refresh()

    expect(markThreadReadMutate).toHaveBeenCalledWith('thread-1')
  })

  it('ignores a user message landing on the open thread', async () => {
    mockMessagePages = messagePage([['m1', 'user'], ['m2', 'assistant']])

    const { refresh } = renderPage()
    selectThread('thread-1')
    markThreadReadMutate.mockClear()

    // A colleague's question is not a reply, and must not move the marker.
    mockMessagePages = messagePage([['m1', 'user'], ['m2', 'assistant'], ['m3', 'user']])
    refresh()

    expect(markThreadReadMutate).not.toHaveBeenCalled()
  })

  it('tracks the reply per thread, so a switch is not swallowed by the guard', async () => {
    mockMessagePages = messagePage([['m1', 'user'], ['m2', 'assistant']])

    const { refresh } = renderPage()
    selectThread('thread-1')
    refresh()
    markThreadReadMutate.mockClear()

    // Same newest-reply id, different thread. A guard keyed on the reply id
    // alone would treat this as already accounted for and go quiet.
    selectThread('thread-2')
    expect(markThreadReadMutate).toHaveBeenCalledWith('thread-2')

    // ...and once recorded for this thread, repeat renders stay quiet.
    markThreadReadMutate.mockClear()
    refresh()
    expect(markThreadReadMutate).not.toHaveBeenCalled()
  })
})

// A team's own chat is the one kind that MUST carry an agentId: the backend
// requires it here and rejects it on the two surfaces that have no team.
describe('AgentChatPage share button', () => {
  it('mints an agent share for the open thread', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    renderPage()
    selectThread('thread-1')
    await userEvent.click(screen.getByLabelText('Share'))

    expect(mockCreateChatShare).toHaveBeenCalledWith({
      tenantId: 't1',
      agentId: AGENT_ID,
      threadId: 'thread-1',
      threadKind: 'agent',
    })
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/share-42`)
    Reflect.deleteProperty(navigator, 'clipboard')
  })
})

describe('AgentChatPage survives agentId arriving late', () => {
  // agentId is read from router state and search params, so it can show up on a
  // later render without the component unmounting — a redirect landing, or a
  // deep link resolving. The page used to guard on it with an early return
  // placed ABOVE eight hooks, so the render before it arrived ran eight fewer
  // hooks than the render after, and React threw "Rendered more hooks than
  // during the previous render" the moment it appeared. The guard now sits
  // below every hook. This mounts the page in the redirect-in-flight state and
  // then supplies the id, which is the exact transition that used to crash.
  // Any stable thing the page puts on screen once it has an id. The greeting
  // used to serve as this probe, back when it was empty-state copy that
  // rendered synchronously; it is a streamed message now, so the empty state's
  // own heading is what is left that does not depend on a round trip.
  const rendered = /^Start a conversation with/

  it('does not change its hook count when the id shows up', () => {
    mockSearch = ''
    const page = renderPage()
    // Nothing to show yet: the guard still returns null, just from lower down.
    expect(screen.queryByText(rendered)).toBeNull()

    mockSearch = `?agentId=${AGENT_ID}`
    expect(() => page.refresh()).not.toThrow()

    // And it genuinely rendered rather than staying blank.
    expect(screen.getByText(rendered)).toBeInTheDocument()
  })
})
