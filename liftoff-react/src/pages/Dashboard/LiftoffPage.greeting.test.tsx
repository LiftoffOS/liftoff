// The greeting Liftoff opens with.
//
// This page had none. It opened on "Start a conversation with Liftoff / Send a
// message to get started" — the page describing itself in grey empty-state
// text, while the two other chat surfaces had the assistant say hello. Now it
// greets the same way they do: streamed from the backend with no thread and
// nothing persisted, rendered as a message, and the first thing the person
// sends is what creates the conversation.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

Element.prototype.scrollIntoView = vi.fn()

const GREETING = 'How can I help you this morning?'

let mockLocationState: unknown = null

// The real navigate: `navigate(pathname, { replace: true, state: null })` is
// how a consumed seed is scrubbed out of history, and the render after it is
// the one where the page no longer knows a message was handed to it. Mocking
// that away would hide the gap this file's last case is about.
const mockNavigate = vi.fn((_path: string, options?: { state?: unknown }) => {
  if (options && 'state' in options) mockLocationState = options.state ?? null
})

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useLocation: () => ({ state: mockLocationState, pathname: '/dashboard/liftoff' }),
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

vi.mock('../../hooks/useLiftoffMessages', () => ({
  LIFTOFF_MESSAGES_QUERY_KEY: ['messages'],
  useLiftoffMessages: () => ({ data: undefined }),
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
function sendCalls() {
  return mockStreamMessage.mock.calls.filter(
    call => (call[0] as { threadId?: string }).threadId !== undefined,
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

beforeEach(() => {
  vi.clearAllMocks()
  mockLocationState = null
  mockCreateThread.mockResolvedValue({ thread: { id: 'thread-1' } })
  mockStopTurn.mockResolvedValue({ acknowledged: true, deliveredAs: 'abort' })
  mockStreamMessage.mockImplementation(
    (input: { threadId?: string }, callbacks: StreamCallbacks) => {
      if (input.threadId === undefined) {
        callbacks.onTextDelta?.(GREETING)
        // Null, because nothing was written down to hand back.
        callbacks.onComplete?.(null)
        return Promise.resolve()
      }
      // A real turn's stream stays open.
      return new Promise<void>(() => {
        callbacks.onThinking?.()
      })
    },
  )
})

describe('Liftoff greets on open', () => {
  it('asks with a tenant and nothing else', async () => {
    renderPage()

    await waitFor(() => expect(greetingCalls()).toHaveLength(1))
    expect(greetingCalls()[0][0]).toEqual({ tenantId: 'tenant-1' })
  })

  it('creates no thread to put it in', async () => {
    renderPage()

    await screen.findByText(GREETING)
    expect(mockCreateThread).not.toHaveBeenCalled()
  })

  it('says it as a message rather than as empty-state copy', async () => {
    renderPage()

    const greeting = await screen.findByText(GREETING)
    expect(greeting.closest('.chat-message--assistant')).not.toBeNull()
  })

  it('replaces the empty state rather than sitting inside it', async () => {
    renderPage()

    await screen.findByText(GREETING)
    expect(screen.queryByText('Start a conversation with Liftoff')).not.toBeInTheDocument()
    expect(screen.queryByText('Send a message to get started.')).not.toBeInTheDocument()
  })

  it('asks only once, however many times the effect runs', async () => {
    renderPage()

    await screen.findByText(GREETING)
    expect(greetingCalls()).toHaveLength(1)
  })

  it('stays quiet on a thread opened from a share link', async () => {
    mockLocationState = { threadId: 'shared-thread' }
    renderPage()

    // Opening somebody else's conversation is not being greeted.
    await waitFor(() => expect(screen.queryByText(GREETING)).not.toBeInTheDocument())
    expect(greetingCalls()).toHaveLength(0)
  })
})

describe('the first message is what starts the conversation', () => {
  it('creates the thread on send, not on open', async () => {
    renderPage()
    await screen.findByText(GREETING)
    expect(mockCreateThread).not.toHaveBeenCalled()

    send('what changed this week?')

    await waitFor(() => expect(mockCreateThread).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(sendCalls()).toHaveLength(1))
    expect(sendCalls()[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      threadId: 'thread-1',
      content: 'what changed this week?',
    })
  })

  it('keeps the greeting above the reply to it', async () => {
    renderPage()
    await screen.findByText(GREETING)

    send('hello')

    await waitFor(() => expect(sendCalls()).toHaveLength(1))
    expect(screen.getByText(GREETING)).toBeInTheDocument()
  })
})

describe('when the greeting does not arrive', () => {
  beforeEach(() => {
    mockStreamMessage.mockImplementation(
      (input: { threadId?: string }, callbacks: StreamCallbacks) => {
        if (input.threadId === undefined) {
          callbacks.onError?.({ code: 'NETWORK_ERROR', message: 'offline' })
        }
        return Promise.resolve()
      },
    )
  })

  it('falls back to the empty state', async () => {
    renderPage()

    expect(await screen.findByText('Start a conversation with Liftoff')).toBeInTheDocument()
    expect(screen.queryByText(GREETING)).not.toBeInTheDocument()
  })

  it('says nothing about a hello nobody asked for', async () => {
    renderPage()

    await screen.findByText('Start a conversation with Liftoff')
    // Nothing was typed and nothing was lost, so there is nothing to report.
    expect(mockShowToast).not.toHaveBeenCalled()
  })
})

// Arriving with something already said.
//
// The home composer routes an @mention to this page and hands the message over
// as router state; the page sends it on arrival. Greeting somebody in the
// middle of that is answering a question nobody asked — and it costs a second
// stream on the way in.
//
// The guard is not simply `hasSeed`. Consuming a seed scrubs it from history
// FIRST, so a render later it looks as though nobody arrived with anything,
// while the thread the send is creating does not exist yet either. The greeting
// used to fire straight into that gap.
describe('arriving from the home composer with a message', () => {
  beforeEach(() => {
    mockLocationState = { seedMessage: 'help me create an agent' }
  })

  it('does not say hello over it', async () => {
    renderPage()

    await waitFor(() => expect(sendCalls()).toHaveLength(1))
    expect(greetingCalls()).toHaveLength(0)
    expect(screen.queryByText(GREETING)).not.toBeInTheDocument()
  })

  it('sends the message it was handed', async () => {
    renderPage()

    await waitFor(() => expect(sendCalls()).toHaveLength(1))
    expect(sendCalls()[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      threadId: 'thread-1',
      content: 'help me create an agent',
    })
  })

  it('shows it once while the reply is still arriving', async () => {
    renderPage()

    await waitFor(() => expect(sendCalls()).toHaveLength(1))
    expect(screen.getAllByText('help me create an agent')).toHaveLength(1)
  })
})
