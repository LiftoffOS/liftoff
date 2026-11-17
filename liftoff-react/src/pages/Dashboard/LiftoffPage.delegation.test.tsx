import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Liftoff can bring a colleague into a thread: the Chief AI Officer, the
// Insights Manager, or one of the customer's agents. Their reply comes back on
// Liftoff's own stream, so with no attribution it reads as Liftoff answering,
// and with no blocks the chart it drew is stored and never seen.

// jsdom has no layout, so the conversation's auto-scroll needs a stub.
Element.prototype.scrollIntoView = vi.fn()

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useLocation: () => ({ state: null, pathname: '/dashboard/liftoff' }),
    useNavigate: () => vi.fn(),
  }
})

const mockStreamMessage = vi.fn()
// The opening greeting goes to the same function, and is the one call with no
// thread. Answered silently here so mockStreamMessage only ever sees real
// turns: these tests are about what a turn does, and a greeting sharing their
// stubbed implementation would draw every block and count as every send.
// LiftoffPage.greeting.test.tsx is where the greeting itself is exercised.
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

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('../../hooks/useDictation', () => ({
  useDictation: () => ({ isListening: false, toggle: vi.fn() }),
}))

// Presence is not what is under test here, and a typing indicator renders into
// the same conversation element the delegated reply is asserted against.
vi.mock('../../hooks/useThreadPresence', () => ({
  useThreadPresence: () => ({ viewers: [], liveTurnId: null }),
}))

vi.mock('../../hooks/chatPresenceTransports', () => ({
  liftoffPresenceTransport: {},
}))

import LiftoffPage from './LiftoffPage'

type StreamCallbacks = {
  onThinking?: () => void
  onContentBlock?: (block: unknown) => void
  onDelegationStarted?: (contributor: { id: string; label: string }) => void
  onComplete?: (message: unknown) => void
}

/** Type a message and press send. */
function send(text: string) {
  const textarea = screen.getByPlaceholderText('Ask Liftoff anything...')
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.click(screen.getByLabelText('Send message'))
}

const costTable = {
  type: 'table',
  title: 'Cost Breakdown',
  columns: [
    { key: 'label', label: 'Team' },
    { key: 'amount', label: 'Amount' },
  ],
  rows: [{ label: 'Support', amount: '$120' }],
}

/** One persisted reply, in the shape the transcript reads off the wire.
 *  `contributors` is derived from the author pair exactly as the backend
 *  derives it: the one-element list for a hand-over, empty for Liftoff's own
 *  reply. */
function reply(overrides: Record<string, unknown>) {
  const author = (overrides.author as string | null | undefined) ?? null
  const authorLabel = (overrides.authorLabel as string | null | undefined) ?? null
  return {
    id: 'm1',
    threadId: 'thread-1',
    role: 'assistant',
    content: 'Here is where the spend went.',
    attachments: [],
    author,
    authorLabel,
    contributors: author ? [{ id: author, label: authorLabel ?? author }] : [],
    visualizationBlocks: [],
    inputTokens: 0,
    outputTokens: 0,
    createdAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  }
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
  mockCreateThread.mockResolvedValue({ thread: { id: 'thread-1' } })
})

describe('LiftoffPage delegated replies', () => {
  it('names the colleague who wrote a stored reply', () => {
    mockMessagesData = {
      pages: [{ messages: [reply({ author: 'insights', authorLabel: 'Insights Manager' })] }],
    }

    const { container } = renderPage()

    expect(screen.getByLabelText('Insights Manager')).toBeInTheDocument()
    expect(container.querySelector('.chat-message__sender-avatar')).toHaveTextContent('IM')
  })

  // The label is what the person saw at the time, not a lookup: a team renamed
  // or deleted since must not relabel an answer already read.
  it('shows the stored label verbatim', () => {
    mockMessagesData = {
      pages: [{ messages: [reply({ author: 'agent-7', authorLabel: 'Payroll Team' })] }],
    }

    renderPage()

    expect(screen.getByLabelText('Payroll Team')).toBeInTheDocument()
  })

  it('leaves a reply Liftoff wrote itself unlabelled', () => {
    mockMessagesData = { pages: [{ messages: [reply({})] }] }

    const { container } = renderPage()

    expect(screen.getByText('Here is where the spend went.')).toBeInTheDocument()
    expect(container.querySelector('.chat-message__time')).toBeInTheDocument()
    expect(container.querySelector('.chat-message__sender-avatar')).not.toBeInTheDocument()
  })

  it('draws what a stored reply drew beside its text', () => {
    mockMessagesData = {
      pages: [
        {
          messages: [
            reply({ authorLabel: 'Insights Manager', visualizationBlocks: [costTable] }),
          ],
        },
      ],
    }

    renderPage()

    expect(screen.getByText('Cost Breakdown')).toBeInTheDocument()
    expect(screen.getByText('Support')).toBeInTheDocument()
  })

  it('draws nothing extra for a reply that carries no blocks', () => {
    mockMessagesData = { pages: [{ messages: [reply({})] }] }

    const { container } = renderPage()

    expect(container.querySelector('.insights-report__table')).not.toBeInTheDocument()
  })

  // Relayed frame by frame, so it is drawn while the reply is still arriving
  // rather than appearing only once the turn is persisted.
  it('draws a block that arrives mid-stream', async () => {
    mockStreamMessage.mockImplementation(
      (_input: unknown, callbacks: StreamCallbacks) =>
        new Promise<void>(() => {
          callbacks.onThinking?.()
          callbacks.onContentBlock?.(costTable)
        }),
    )

    renderPage()
    send('where did the spend go?')

    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Cost Breakdown')).toBeInTheDocument()
  })

  // The whole point of the frame: on a long answer the handover is most of the
  // experience, and until it arrived the bubble was unattributed for all of it.
  it('names the colleague while the reply is still streaming', async () => {
    mockStreamMessage.mockImplementation(
      (_input: unknown, callbacks: StreamCallbacks) =>
        new Promise<void>(() => {
          callbacks.onThinking?.()
          callbacks.onDelegationStarted?.({
            id: 'insights',
            label: 'Insights Manager',
          })
        }),
    )

    renderPage()
    send('where did the spend go?')

    expect(await screen.findByLabelText('Insights Manager')).toBeInTheDocument()
  })

  it('leaves the streaming bubble unlabelled when Liftoff answers itself', async () => {
    mockStreamMessage.mockImplementation(
      (_input: unknown, callbacks: StreamCallbacks) =>
        new Promise<void>(() => {
          callbacks.onThinking?.()
        }),
    )

    const { container } = renderPage()
    send('what can you do?')

    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1))
    expect(container.querySelector('.chat-message__sender-avatar')).not.toBeInTheDocument()
  })

  // The persisted reply carries the same label of its own, so a live one left
  // behind would name the colleague twice, and then name it again on whatever
  // Liftoff answers next.
  it('drops the live label when the stream ends', async () => {
    const stream: { callbacks?: StreamCallbacks; finish?: () => void } = {}
    mockStreamMessage.mockImplementation(
      (_input: unknown, callbacks: StreamCallbacks) =>
        new Promise<void>(resolve => {
          stream.callbacks = callbacks
          stream.finish = resolve
          callbacks.onThinking?.()
          callbacks.onDelegationStarted?.({
            id: 'insights',
            label: 'Insights Manager',
          })
        }),
    )

    renderPage()
    send('where did the spend go?')

    expect(await screen.findByLabelText('Insights Manager')).toBeInTheDocument()

    await act(async () => {
      stream.callbacks?.onComplete?.(null)
      stream.finish?.()
    })

    await waitFor(() =>
      expect(screen.queryByLabelText('Insights Manager')).not.toBeInTheDocument(),
    )
  })
})
