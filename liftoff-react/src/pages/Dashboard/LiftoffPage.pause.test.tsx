import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// An agent Liftoff handed a turn to can stop for a human approval. That is not
// a failure and it is not the end of the conversation: the person's message is
// stored, the run is alive, and it continues the moment somebody decides.
//
// It used to reach this page on the error channel, which restored their message
// into the composer as though the send had failed and toasted a failure over it.
// And it was never written down, so a reload showed a truncated answer with no
// sign that anything was waiting.

// jsdom has no layout, so the conversation's auto-scroll needs a stub.
Element.prototype.scrollIntoView = vi.fn()

const mockNavigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useLocation: () => ({ state: null, pathname: '/dashboard/liftoff' }),
    useNavigate: () => mockNavigate,
  }
})

const mockStreamMessage = vi.fn()
// The opening greeting goes to the same function, and is the one call with no
// thread. Answered silently here so mockStreamMessage only ever sees real
// turns. LiftoffPage.greeting.test.tsx exercises the greeting itself.
vi.mock('../../services/liftoffChat', () => ({
  // The page asks whether work is queued to continue an earlier turn on the
  // open conversation; nothing is, on a page these tests are about.
  getLiftoffThreadContinuation: vi.fn().mockResolvedValue(null),
  streamLiftoffChatMessage: (...args: unknown[]) =>
    (args[0] as { threadId?: string }).threadId === undefined
      ? Promise.resolve()
      : mockStreamMessage(...args),
  stopLiftoffChatTurn: vi.fn(),
  listLiftoffThreadDelegations: vi.fn().mockResolvedValue([]),
  markLiftoffThreadRead: vi.fn().mockResolvedValue(undefined),
  getLiftoffUnreadCount: vi.fn().mockResolvedValue({ count: 0 }),
}))

// The pairing is what turns the team named on a status row into a destination.
// Mocked here so the row can be rendered without first driving a whole handover.
let mockDelegations: Array<{
  targetKind: string
  targetId: string | null
  delegateThreadId: string
}> = []
vi.mock('../../hooks/useLiftoffDelegations', () => ({
  LIFTOFF_DELEGATIONS_QUERY_KEY: ['delegations'],
  useLiftoffDelegations: () => mockDelegations,
}))

const mockCreateThread = vi.fn()
vi.mock('../../hooks/useLiftoffThreads', () => ({
  LIFTOFF_THREADS_QUERY_KEY: ['threads'],
  useCreateLiftoffThread: () => ({ mutateAsync: mockCreateThread, isPending: false }),
  useLiftoffThreads: () => ({ data: undefined, isLoading: false }),
}))

let mockMessagesData: unknown = undefined
vi.mock('../../hooks/useLiftoffMessages', () => ({
  LIFTOFF_MESSAGES_QUERY_KEY: ['messages'],
  useLiftoffMessages: () => ({ data: mockMessagesData }),
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
  onDelegationStarted?: (contributor: { id: string; label: string }) => void
  onDelegationPaused?: (event: {
    author: string
    authorLabel: string
    delegateThreadId: string | null
    reason: string
  }) => void
  onError?: (err: { code: string; message: string }) => void
}

const WAITING = 'Support Team is waiting on an approval before it can continue.'

/** The status row a paused handover persists into the transcript. */
function statusRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm2',
    threadId: 'thread-1',
    role: 'assistant',
    content: WAITING,
    attachments: [],
    author: 'agent-7',
    authorLabel: 'Support Team',
    visualizationBlocks: [],
    messageType: 'hitl_status',
    inputTokens: 0,
    outputTokens: 0,
    createdAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  }
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
  mockMessagesData = undefined
  mockDelegations = [
    { targetKind: 'team', targetId: 'agent-7', delegateThreadId: 'delegate-thread-1' },
  ]
  mockCreateThread.mockResolvedValue({ thread: { id: 'thread-1' } })
})

describe('a delegated turn that paused for an approval', () => {
  // The whole reason the row is persisted: a reload has no stream to learn from,
  // and everyone else on the thread never had one.
  it('shows the stall on reload, as a status line rather than as speech', async () => {
    mockMessagesData = { pages: [{ messages: [statusRow()] }] }

    const { container } = renderPage()

    expect(screen.getByText(WAITING)).toBeInTheDocument()
    expect(container.querySelector('.chat-page__hitl-status')).toBeInTheDocument()
    // Not dressed as something the team said. Awaited because the page opens
    // by greeting, and the greeting's own bubble is on screen until it
    // settles — this asks whether the STATUS ROW became one, which is a
    // question about the page after it has finished opening.
    await waitFor(() =>
      expect(container.querySelector('.chat-message__bubble')).not.toBeInTheDocument(),
    )
  })

  // "Review it in that team's chat" with no link was the old copy, and the
  // destination was an untitled thread nobody could find.
  it('offers the way to the conversation holding the decision', () => {
    mockMessagesData = { pages: [{ messages: [statusRow()] }] }

    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Open Support Team' }))

    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents/chat', {
      state: { agentId: 'agent-7', threadId: 'delegate-thread-1' },
    })
  })

  // Thread ids stay out of the address bar and browser history on every surface
  // in this app; the destination travels as router state.
  it('never puts the thread id in the path it navigates to', () => {
    mockMessagesData = { pages: [{ messages: [statusRow()] }] }

    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Open Support Team' }))

    const [path] = mockNavigate.mock.calls[0] as [string]
    expect(path).toBe('/dashboard/agents/chat')
    expect(path).not.toContain('delegate-thread-1')
    expect(path).not.toContain('agent-7')
  })

  it('still reports the stall when the pairing cannot be resolved', () => {
    mockDelegations = []
    mockMessagesData = { pages: [{ messages: [statusRow()] }] }

    renderPage()

    expect(screen.getByText(WAITING)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Support Team' })).not.toBeInTheDocument()
  })

  // The defect this replaces: the pause arrived as an error, so the message the
  // person had already sent was pushed back into the composer as if it had
  // failed to send.
  it('does not restore the sent message into the composer', async () => {
    mockStreamMessage.mockImplementation(
      async (_input: unknown, callbacks: StreamCallbacks) => {
        callbacks.onThinking?.()
        callbacks.onDelegationStarted?.({ id: 'agent-7', label: 'Support Team' })
        callbacks.onTextDelta?.('Looking into it.')
        callbacks.onDelegationPaused?.({
          author: 'agent-7',
          authorLabel: 'Support Team',
          delegateThreadId: 'delegate-thread-1',
          reason: WAITING,
        })
      },
    )

    renderPage()
    await act(async () => {
      send('ask the support team to issue the refund')
    })

    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1))
    const textarea = screen.getByPlaceholderText('Ask Liftoff anything...')
    await waitFor(() => expect(textarea).toHaveValue(''))
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  // Terminal: the live bubble has to come down, or the composer streams forever.
  it('settles the stream so the composer is released', async () => {
    mockStreamMessage.mockImplementation(
      async (_input: unknown, callbacks: StreamCallbacks) => {
        callbacks.onThinking?.()
        callbacks.onDelegationPaused?.({
          author: 'agent-7',
          authorLabel: 'Support Team',
          delegateThreadId: 'delegate-thread-1',
          reason: WAITING,
        })
      },
    )

    const { container } = renderPage()
    await act(async () => {
      send('ask the support team to issue the refund')
    })

    await waitFor(() =>
      expect(container.querySelector('.chat-message__activity')).not.toBeInTheDocument(),
    )
  })
})

// The other direction: the Insights Manager or the Chief AI Officer can now
// bring Liftoff in, and Liftoff's own thread then holds the note the asker
// forwarded. It is a colleague's row on Liftoff's page, attributed to the
// colleague that wrote it, and folded like every forwarded note.
describe('a note a colleague forwarded to Liftoff', () => {
  const NOTE = [
    'Insights Manager shared background from the conversation so far',
    '',
    'They were looking at webhook failures for the Watches team.',
  ].join('\n')

  it('renders as a status line, attributed to the colleague that forwarded it, with nothing of the brief', async () => {
    mockMessagesData = {
      pages: [{
        messages: [statusRow({
          id: 'm-note',
          content: NOTE,
          messageType: 'forwarded_context',
          author: 'insights',
          authorLabel: 'Insights Manager',
          contributors: [{ id: 'insights', label: 'Insights Manager' }],
        })],
      }],
    }

    const { container } = renderPage()

    const row = container.querySelector('.chat-page__hitl-status')
    expect(row).toBeInTheDocument()
    expect(row).toHaveTextContent('Insights Manager shared background from the conversation so far')
    // An older row still carries the brief after a blank line; none of it is
    // rendered, and there is nothing to open.
    expect(container.textContent).not.toContain('webhook failures')
    expect(container.querySelector('details')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Insights Manager')).toBeInTheDocument()
    expect(screen.queryByLabelText('Liftoff')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(container.querySelector('.chat-message__bubble')).not.toBeInTheDocument(),
    )
  })
})
