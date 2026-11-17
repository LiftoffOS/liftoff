// The greeting a team chat opens with.
//
// Three shapes this has had. It was a real message streamed into a thread the
// page created on mount, which left a permanent untitled row behind on every
// visit nobody typed into. Then it was a client-computed string rendered as
// grey empty-state copy under a decorative icon, which fixed the rows by
// taking the greeting away from the team and giving it to the page furniture.
//
// Now: a real message again, said by the team, streamed from the backend with
// no thread and nothing persisted. The first thing the person sends is what
// creates the conversation.
//
// This file runs the REAL useChatStreaming. AgentChatPage.unread.test.tsx
// stubs it, so nothing there can tell whether any of this works.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const AGENT_ID = 'agent-1'
const GREETING = 'How can I help you this morning?'

class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
global.ResizeObserver = ResizeObserverMock
Element.prototype.scrollIntoView = vi.fn()

let mockSearch = `?agentId=${AGENT_ID}`
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ search: mockSearch, state: null, pathname: '/dashboard/agents/chat', hash: '', key: 'k' }),
  }
})

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ account: { id: 'acct-1' }, currentTenant: { id: 't1' } }),
}))
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: (...args: unknown[]) => mockShowToast(...args) }),
}))
vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 't1' }, switchTenant: vi.fn() }),
}))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

const createThreadMutateAsync = vi.fn()
vi.mock('../../hooks/useAgentChatThreads', () => ({
  AGENT_CHAT_THREADS_QUERY_KEY: ['agent-chat-threads'],
  useAgentChatThreads: () => ({
    data: { pages: [{ threads: [] }] },
    isLoading: false,
    isError: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
  useCreateAgentChatThread: () => ({
    mutate: vi.fn(),
    mutateAsync: (...args: unknown[]) => createThreadMutateAsync(...args),
    isPending: false,
  }),
}))

vi.mock('../../hooks/useAgentChatMessages', () => ({
  AGENT_CHAT_MESSAGES_QUERY_KEY: ['agent-chat-messages'],
  useAgentChatMessages: () => ({ data: undefined }),
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
vi.mock('../../hooks/useChatUnread', () => ({
  useChatUnreadCounts: () => ({ data: {} }),
  useMarkThreadRead: () => ({ mutate: vi.fn() }),
  useMarkAllThreadsRead: () => ({ mutate: vi.fn() }),
}))

let mockAgentStatus = 'active'
const mockUpdateStatus = vi.fn()
vi.mock('../../services/internalAgents', () => ({
  getInternalAgent: () =>
    Promise.resolve({ id: AGENT_ID, role: 'Sales Team', status: mockAgentStatus }),
  updateInternalAgentStatus: (...args: unknown[]) => mockUpdateStatus(...args),
}))

const mockStreamAgentChat = vi.fn()
const mockShowToast = vi.fn()
vi.mock('../../services/agentChat', () => ({
  streamAgentChatMessage: (...args: unknown[]) => mockStreamAgentChat(...args),
  createChatShare: vi.fn(),
  stopAgentChatTurn: vi.fn(),
}))
vi.mock('../../services/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))

import AgentChatPage from './AgentChatPage'

type StreamCallbacks = {
  onTextDelta?: (text: string) => void
  onComplete?: (message: unknown) => void
  onError?: (err: { code: string; message: string }) => void
}

/** The greeting call and the ones carrying a message go to the same function.
 *  A greeting has no thread; that is what tells them apart. */
function greetingCalls() {
  return mockStreamAgentChat.mock.calls.filter(
    call => (call[0] as { threadId?: string }).threadId === undefined,
  )
}
function sendCalls() {
  return mockStreamAgentChat.mock.calls.filter(
    call => (call[0] as { threadId?: string }).threadId !== undefined,
  )
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentChatPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockSearch = `?agentId=${AGENT_ID}`
  mockAgentStatus = 'active'
  createThreadMutateAsync.mockReset().mockResolvedValue({ thread: { id: 'thread-1' } })
  mockShowToast.mockReset()
  // Both are asserted with .not.toHaveBeenCalled(), which is only meaningful
  // if the previous test's calls are cleared first.
  mockNavigate.mockReset()
  mockUpdateStatus.mockReset()
  mockStreamAgentChat.mockReset().mockImplementation(
    (input: { threadId?: string }, callbacks: StreamCallbacks) => {
      if (input.threadId === undefined) {
        callbacks.onTextDelta?.(GREETING)
        // Null, because nothing was written down to hand back.
        callbacks.onComplete?.(null)
      }
      return Promise.resolve()
    },
  )
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

describe('the greeting arrives without a thread', () => {
  it('asks for it with a tenant and a team, and nothing else', async () => {
    renderPage()

    await waitFor(() => expect(greetingCalls()).toHaveLength(1))
    // No threadId, no content: what the backend reads as "say hello", and
    // persists nothing for.
    expect(greetingCalls()[0][0]).toEqual({ tenantId: 't1', agentId: AGENT_ID })
  })

  it('creates no thread to put it in', async () => {
    renderPage()

    await screen.findByText(GREETING)
    expect(createThreadMutateAsync).not.toHaveBeenCalled()
  })

  it('says it as a message rather than as empty-state copy', async () => {
    renderPage()

    const greeting = await screen.findByText(GREETING)
    // In an assistant bubble. It used to be a grey paragraph in the empty
    // state, beneath a heading that talked about the team in the third person
    // while the sentence itself spoke in the first.
    expect(greeting.closest('.chat-message--assistant')).not.toBeNull()
  })

  it('replaces the empty state rather than sitting inside it', async () => {
    renderPage()

    await screen.findByText(GREETING)
    expect(screen.queryByText(/^Start a conversation with/)).not.toBeInTheDocument()
  })

  it('asks only once, however many times the effect runs', async () => {
    renderPage()

    await screen.findByText(GREETING)
    expect(greetingCalls()).toHaveLength(1)
  })
})

describe('the first message is what starts the conversation', () => {
  it('creates the thread on send, not on open', async () => {
    renderPage()
    await screen.findByText(GREETING)
    expect(createThreadMutateAsync).not.toHaveBeenCalled()

    await userEvent.type(screen.getByPlaceholderText(/^Message /), 'what is in the pipeline?')
    await userEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() => expect(createThreadMutateAsync).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(sendCalls()).toHaveLength(1))
    expect(sendCalls()[0][0]).toMatchObject({
      tenantId: 't1',
      threadId: 'thread-1',
      content: 'what is in the pipeline?',
    })
  })

  it('keeps the greeting above the reply to it', async () => {
    renderPage()
    await screen.findByText(GREETING)

    await userEvent.type(screen.getByPlaceholderText(/^Message /), 'hello')
    await userEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() => expect(sendCalls()).toHaveLength(1))
    // The conversation reads from the top: what the team opened with, then
    // the person answering it.
    expect(screen.getByText(GREETING)).toBeInTheDocument()
  })
})

describe('typing over a greeting that is still arriving', () => {
  // The greeting holds the same streaming scaffold a reply does. If that made
  // the composer behave as though a turn were running, Send would route to the
  // mid-run path, which needs a thread to deliver into and returns silently
  // without one: the person's first message would vanish on the way out.
  it('starts the conversation instead of swallowing the message', async () => {
    let finishGreeting: (() => void) | null = null
    mockStreamAgentChat.mockImplementation(
      (input: { threadId?: string }, callbacks: StreamCallbacks) => {
        if (input.threadId !== undefined) return Promise.resolve()
        return new Promise<void>(resolve => {
          callbacks.onTextDelta?.('Good ')
          finishGreeting = () => {
            callbacks.onTextDelta?.(GREETING)
            callbacks.onComplete?.(null)
            resolve()
          }
        })
      },
    )

    renderPage()
    await waitFor(() => expect(greetingCalls()).toHaveLength(1))
    // Mid-greeting: the team is still talking.
    await screen.findByText('Good')

    await userEvent.type(screen.getByPlaceholderText(/^Message /), 'skip it, what is due today?')
    await userEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() => expect(createThreadMutateAsync).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(sendCalls()).toHaveLength(1))
    expect(sendCalls()[0][0]).toMatchObject({
      threadId: 'thread-1',
      content: 'skip it, what is due today?',
    })
    expect(finishGreeting).not.toBeNull()
  })

  it('does not let the abandoned greeting tear down the turn that replaced it', async () => {
    let finishGreeting: (() => void) | null = null
    mockStreamAgentChat.mockImplementation(
      (input: { threadId?: string }, callbacks: StreamCallbacks) => {
        if (input.threadId !== undefined) {
          // A real turn's stream stays open.
          return new Promise<void>(() => {
            callbacks.onTextDelta?.('Three things are due.')
          })
        }
        return new Promise<void>(resolve => {
          callbacks.onTextDelta?.('Good ')
          finishGreeting = () => {
            callbacks.onComplete?.(null)
            resolve()
          }
        })
      },
    )

    renderPage()
    await waitFor(() => expect(greetingCalls()).toHaveLength(1))
    await screen.findByText('Good')

    await userEvent.type(screen.getByPlaceholderText(/^Message /), 'what is due today?')
    await userEvent.click(screen.getByLabelText('Send message'))
    await waitFor(() => expect(sendCalls()).toHaveLength(1))
    expect(await screen.findByText('Three things are due.')).toBeInTheDocument()

    // The greeting's own stream lands late, after its scaffold was taken over.
    finishGreeting!()

    // The reply is still on screen: settling a greeting must not clear a
    // bubble that now belongs to somebody else's turn.
    await waitFor(() => expect(screen.getByText('Three things are due.')).toBeInTheDocument())
  })
})

describe('New chat', () => {
  it('greets again when leaving a conversation for a blank one', async () => {
    renderPage()
    await screen.findByText(GREETING)

    await userEvent.type(screen.getByPlaceholderText(/^Message /), 'hello')
    await userEvent.click(screen.getByLabelText('Send message'))
    await waitFor(() => expect(sendCalls()).toHaveLength(1))

    await userEvent.click(screen.getByLabelText('New Chat'))

    await waitFor(() => expect(greetingCalls()).toHaveLength(2))
  })

  it('leaves the greeting alone when the chat is already blank', async () => {
    renderPage()
    await screen.findByText(GREETING)

    await userEvent.click(screen.getByLabelText('New Chat'))

    // Nothing to leave, so nothing to re-greet — and above all the page does
    // not blank out the greeting it is already showing.
    expect(screen.getByText(GREETING)).toBeInTheDocument()
    expect(greetingCalls()).toHaveLength(1)
  })
})

describe('when there is nothing to greet with', () => {
  it('leaves a draft team alone', async () => {
    mockAgentStatus = 'draft'
    renderPage()

    // A draft cannot be talked to, so its empty state is an invitation to
    // launch it rather than a conversation opener.
    expect(await screen.findByText(/is awaiting launch$/)).toBeInTheDocument()
    expect(greetingCalls()).toHaveLength(0)
  })

  it('starts a draft team in place, without leaving the conversation', async () => {
    // It used to navigate to /dashboard/agents/update, which is a form this
    // action does not need, and it passed the INTERNAL team id in the slot that
    // page reads as an EXTERNAL agent id. The page fetched
    // /api/external-agents/<internal id>, got a 404, and rendered
    // "Something went wrong". Launching is a status change, so it happens here.
    mockAgentStatus = 'draft'
    mockUpdateStatus.mockResolvedValue({ id: AGENT_ID, role: 'Sales Team', status: 'active' })
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: 'Start Team' }))

    await waitFor(() => expect(mockUpdateStatus).toHaveBeenCalled())
    expect(mockUpdateStatus.mock.calls[0][0]).toBe(AGENT_ID)
    expect(mockUpdateStatus.mock.calls[0][2]).toBe('active')

    // Stayed put, said so, and stopped calling itself unlaunched.
    expect(mockNavigate).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Sales Team is starting up', 'success'),
    )
    await waitFor(() =>
      expect(screen.queryByText(/is awaiting launch$/)).not.toBeInTheDocument(),
    )
  })

  it('says so and stays put when the launch fails', async () => {
    mockAgentStatus = 'draft'
    mockUpdateStatus.mockRejectedValue(new Error('nope'))
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: 'Start Team' }))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Sales Team could not be started. Please try again.',
        'error',
      ),
    )
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(screen.getByText(/is awaiting launch$/)).toBeInTheDocument()
  })

  it('falls back to the empty state when the greeting fails', async () => {
    mockStreamAgentChat.mockImplementation(
      (_input: unknown, callbacks: StreamCallbacks) => {
        callbacks.onError?.({ code: 'NETWORK_ERROR', message: 'offline' })
        return Promise.resolve()
      },
    )
    renderPage()

    expect(await screen.findByText(/^Start a conversation with/)).toBeInTheDocument()
    expect(screen.queryByText(GREETING)).not.toBeInTheDocument()
  })

  it('says nothing about a hello nobody asked for', async () => {
    mockStreamAgentChat.mockImplementation(
      (_input: unknown, callbacks: StreamCallbacks) => {
        callbacks.onError?.({ code: 'NETWORK_ERROR', message: 'offline' })
        return Promise.resolve()
      },
    )
    renderPage()

    await screen.findByText(/^Start a conversation with/)
    // No message was lost and none was typed, so there is nothing to report.
    expect(mockShowToast).not.toHaveBeenCalled()
  })
})
