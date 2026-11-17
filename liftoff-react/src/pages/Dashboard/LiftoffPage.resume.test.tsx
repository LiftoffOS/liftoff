// Refreshing the page used to lose the conversation.
//
// Thread ids are deliberately kept out of the address bar, and the thread was
// held in `useState` and nowhere else — so a reload remounted the page, found
// nothing, and opened a blank chat. The conversation was still there, but only
// via the Chat History modal, which nobody thinks to open after a refresh.
//
// The fix writes the open thread onto the history entry, which under
// BrowserRouter survives a reload. This file covers the surface that reads
// it: every chat page shares the mechanism (lib/chatNavState +
// hooks/useResumableThread, unit-tested separately), and Liftoff is the one
// with a harness able to drive a real send.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../services/api'

Element.prototype.scrollIntoView = vi.fn()

const GREETING = 'How can I help you this morning?'
const TENANT_SCOPE = 'tenant-1:liftoff'

// The history entry. `mockNavigate` writes it the way the real router would,
// so a "reload" in this file is genuinely a re-render from the state the page
// itself left behind — not a value handed to it by the test.
let mockLocationState: unknown = null

const mockNavigate = vi.fn((_path: string, options?: { state?: unknown }) => {
  if (options && 'state' in options) mockLocationState = options.state ?? null
})

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useLocation: () => ({
      state: mockLocationState,
      pathname: '/dashboard/liftoff',
      search: '',
    }),
    useNavigate: () => mockNavigate,
  }
})

const mockStreamMessage = vi.fn()
const mockStopTurn = vi.fn()
vi.mock('../../services/liftoffChat', () => ({
  // The page asks whether work is queued to continue an earlier turn on the
  // open conversation; nothing is, on a page these tests are about.
  getLiftoffThreadContinuation: vi.fn().mockResolvedValue(null),
  streamLiftoffChatMessage: (...args: unknown[]) => mockStreamMessage(...args),
  stopLiftoffChatTurn: (...args: unknown[]) => mockStopTurn(...args),
  listLiftoffThreadDelegations: vi.fn().mockResolvedValue([]),
  markLiftoffThreadRead: vi.fn().mockResolvedValue(undefined),
  getLiftoffUnreadCount: vi.fn().mockResolvedValue({ count: 0 }),
}))

const mockCreateThread = vi.fn()
vi.mock('../../hooks/useLiftoffThreads', () => ({
  LIFTOFF_THREADS_QUERY_KEY: ['threads'],
  useCreateLiftoffThread: () => ({ mutateAsync: mockCreateThread, isPending: false }),
  useLiftoffThreads: () => ({ data: undefined, isLoading: false }),
}))

// Keyed by thread so "the transcript came back" is observable: the resumed
// thread renders a message no blank chat could have.
const RESUMED_MESSAGE = 'the answer you were reading before the refresh'
let messagesError: unknown = null
vi.mock('../../hooks/useLiftoffMessages', () => ({
  LIFTOFF_MESSAGES_QUERY_KEY: ['messages'],
  useLiftoffMessages: (threadId: string | null) => ({
    data: threadId
      ? {
          pages: [
            {
              messages: [
                {
                  id: 'm-1',
                  threadId,
                  role: 'assistant',
                  content: RESUMED_MESSAGE,
                  createdAt: new Date().toISOString(),
                  authorLabel: null,
                  messageType: null,
                },
              ],
            },
          ],
        }
      : undefined,
    error: threadId ? messagesError : null,
    isLoading: false,
  }),
}))

vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1', name: 'Test' } }),
}))
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ account: { id: 'account-1' } }),
}))
const mockShowToast = vi.fn()
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: (...args: unknown[]) => mockShowToast(...args) }),
}))
vi.mock('../../hooks/useDictation', () => ({
  useDictation: () => ({ isListening: false, toggle: vi.fn() }),
}))
vi.mock('../../hooks/useThreadPresence', () => ({
  useThreadPresence: () => ({ viewers: [], liveTurnId: null }),
}))
vi.mock('../../hooks/chatPresenceTransports', () => ({
  liftoffPresenceTransport: {},
}))

import LiftoffPage from './LiftoffPage'

type StreamCallbacks = {
  onThinking?: () => void
  onTextDelta?: (text: string) => void
  onComplete?: (message: unknown) => void
  onError?: (err: { code: string; message: string }) => void
}

/** The greeting is the one call with no thread. */
function greetingCalls() {
  return mockStreamMessage.mock.calls.filter(
    call => (call[0] as { threadId?: string }).threadId === undefined,
  )
}

function send(text: string) {
  const textarea = screen.getByPlaceholderText('Ask Liftoff anything...')
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.click(screen.getByLabelText('Send message'))
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <LiftoffPage />
    </QueryClientProvider>,
  )
}

/** What a browser reload does: tear the page down, keep the history entry. */
function reload(unmount: () => void) {
  unmount()
  // Only what the reloaded page does is interesting; the first visit's
  // greeting already happened and would otherwise be counted twice.
  mockStreamMessage.mockClear()
  return renderPage()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLocationState = null
  messagesError = null
  mockCreateThread.mockResolvedValue({ thread: { id: 'thread-1' } })
  mockStopTurn.mockResolvedValue({ acknowledged: true, deliveredAs: 'abort' })
  mockStreamMessage.mockImplementation(
    (input: { threadId?: string }, callbacks: StreamCallbacks) => {
      if (input.threadId === undefined) {
        callbacks.onTextDelta?.(GREETING)
        callbacks.onComplete?.(null)
        return Promise.resolve()
      }
      return new Promise<void>(() => {
        callbacks.onThinking?.()
      })
    },
  )
})

describe('the open conversation is remembered across a reload', () => {
  it('puts the thread on the history entry when one is created', async () => {
    renderPage()
    await screen.findByText(GREETING)

    send('what changed this week?')

    await waitFor(() =>
      expect(mockLocationState).toMatchObject({
        threadId: 'thread-1',
        threadScope: TENANT_SCOPE,
      }),
    )
  })

  it('leaves the URL alone doing it', async () => {
    renderPage()
    await screen.findByText(GREETING)

    send('what changed this week?')
    await waitFor(() => expect(mockLocationState).toMatchObject({ threadId: 'thread-1' }))

    // Every navigation is to the same address, and no thread id reaches it.
    for (const [path] of mockNavigate.mock.calls) {
      expect(path).toBe('/dashboard/liftoff')
    }
  })

  it('comes back to the same conversation after a reload', async () => {
    const { unmount } = renderPage()
    await screen.findByText(GREETING)
    send('what changed this week?')
    await waitFor(() => expect(mockLocationState).toMatchObject({ threadId: 'thread-1' }))

    reload(unmount)

    // The transcript is back...
    expect(await screen.findByText(RESUMED_MESSAGE)).toBeInTheDocument()
    // ...and the page did not greet over it, because it is not a new chat.
    expect(greetingCalls()).toHaveLength(0)
  })

  it('does not flash the empty state over a conversation that is loading', async () => {
    mockLocationState = { threadId: 'thread-1', threadScope: TENANT_SCOPE }
    renderPage()

    expect(screen.queryByText('Start a conversation with Liftoff')).not.toBeInTheDocument()
  })
})

describe('New chat is still a new chat', () => {
  it('takes the thread back off the entry', async () => {
    renderPage()
    await screen.findByText(GREETING)
    send('what changed this week?')
    await waitFor(() => expect(mockLocationState).toMatchObject({ threadId: 'thread-1' }))

    fireEvent.click(screen.getByLabelText('New Chat'))

    // Otherwise a refresh would resurrect the conversation they just left.
    await waitFor(() => expect(mockLocationState).toBeNull())
  })
})

describe('an entry that no longer applies is refused', () => {
  it('ignores a thread stamped for another tenant', async () => {
    mockLocationState = { threadId: 'thread-1', threadScope: 'tenant-2:liftoff' }
    renderPage()

    // Switching tenant in another tab swaps in place without navigating, so
    // this entry can outlive the tenant it was written under. Greeting rather
    // than opening someone else's workspace's conversation is the point.
    await waitFor(() => expect(greetingCalls()).toHaveLength(1))
    expect(screen.queryByText(RESUMED_MESSAGE)).not.toBeInTheDocument()
  })

  it('still opens an unstamped thread, which is how share links arrive', async () => {
    mockLocationState = { threadId: 'shared-thread' }
    renderPage()

    expect(await screen.findByText(RESUMED_MESSAGE)).toBeInTheDocument()
    expect(greetingCalls()).toHaveLength(0)
  })
})

describe('a resumed thread that is gone', () => {
  it('falls back to a fresh chat on a 404', async () => {
    messagesError = new ApiError('Not found', 404)
    mockLocationState = { threadId: 'thread-1', threadScope: TENANT_SCOPE }
    renderPage()

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'That conversation is no longer available.',
        'error',
      ),
    )
    await waitFor(() => expect(greetingCalls()).toHaveLength(1))
  })

  it('keeps the thread when the network is the problem', async () => {
    // The case this whole feature exists for: losing connection and reloading
    // is how people GET here. Dropping the conversation on a transient failure
    // would recreate the bug in a worse form.
    messagesError = new ApiError('Bad gateway', 502)
    mockLocationState = { threadId: 'thread-1', threadScope: TENANT_SCOPE }
    renderPage()

    await waitFor(() => expect(screen.getByText(RESUMED_MESSAGE)).toBeInTheDocument())
    expect(mockShowToast).not.toHaveBeenCalled()
    expect(greetingCalls()).toHaveLength(0)
    expect(mockLocationState).toMatchObject({ threadId: 'thread-1' })
  })

  it('keeps the thread when the failure is not an ApiError at all', async () => {
    messagesError = new TypeError('Failed to fetch')
    mockLocationState = { threadId: 'thread-1', threadScope: TENANT_SCOPE }
    renderPage()

    await waitFor(() => expect(screen.getByText(RESUMED_MESSAGE)).toBeInTheDocument())
    expect(mockShowToast).not.toHaveBeenCalled()
  })
})
