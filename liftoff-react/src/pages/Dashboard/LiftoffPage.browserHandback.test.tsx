import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// The person's hand-back as a turn on the Liftoff page: the persisted row is
// drawn as a status line in their name, never as speech; the Hand back button
// releases the wheel and, when the release was theirs, starts a turn with no
// words that names the hold; a release that ended nothing sends nothing; and a
// 409 on that turn shows no error.

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
vi.mock('../../hooks/useLiftoffDelegations', () => ({
  LIFTOFF_DELEGATIONS_QUERY_KEY: ['delegations'],
  useLiftoffDelegations: () => [],
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
  useAuth: () => ({ account: { id: 'account-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' } }),
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

// The pane, open, with this viewer driving. The session hook is the seam:
// handBackIfDriving answers the hold the release ended (or null).
const mockHandBackIfDriving = vi.fn()
const driver = { accountId: 'account-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', avatarUrl: null, takenAt: '2026-09-21T10:00:00.000Z', present: true }
const liveSession = {
  id: 'sess-1', liveViewUrl: 'https://live', ownerAccountId: 'account-1', owner: null, driver,
  takeoverState: 'taken_over', intervention: null,
}
vi.mock('../../hooks/useAssistantBrowserPane', () => ({
  useAssistantBrowserPane: () => ({
    isAvailable: true,
    isOpen: true,
    toggle: vi.fn(),
    close: vi.fn(),
    noticeToolCall: vi.fn(),
    assistantName: 'Liftoff',
    containerRef: { current: null },
    paneWidth: 480,
    isResizing: false,
    onResizeStart: vi.fn(),
    session: {
      query: { data: { session: liveSession, lastClosedSession: null } },
      ensureMutation: { mutate: vi.fn(), data: undefined, isPending: false, isError: false },
      gotoMutation: { mutate: vi.fn() },
      controlMutation: { mutate: vi.fn(), isPending: false },
      pointMutation: { mutate: vi.fn() },
      pausedFrameUrl: null,
      isEnsureError: false,
      handBackIfDriving: (...a: unknown[]) => mockHandBackIfDriving(...a),
      reportViewport: vi.fn(),
      onResizeEnd: vi.fn(),
    },
  }),
}))

import LiftoffPage from './LiftoffPage'
import { useLiftoffMessages } from '../../hooks/useLiftoffMessages'

const HOLD = '11111111-1111-4111-8111-111111111111'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <LiftoffPage />
    </QueryClientProvider>,
  )
}

function handbackRow() {
  return {
    id: 'm2', threadId: 'thread-1', role: 'assistant', content: 'Ada Lovelace handed the browser back',
    attachments: [], author: null, authorLabel: null, visualizationBlocks: [], messageType: 'browser_handback',
    inputTokens: 0, outputTokens: 0, createdAt: '2026-09-21T10:00:00.000Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockMessagesData = undefined
  mockCreateThread.mockResolvedValue({ thread: { id: 'thread-1' } })
  mockHandBackIfDriving.mockResolvedValue(HOLD)
  void useLiftoffMessages
})

describe('the hand-back on the Liftoff page', () => {
  it('renders the persisted row as a status line in the person\'s name, not as speech', async () => {
    mockMessagesData = { pages: [{ messages: [handbackRow()] }] }
    const { container } = renderPage()
    expect(screen.getByText('Ada Lovelace handed the browser back')).toBeInTheDocument()
    expect(container.querySelector('.chat-page__hitl-status')).toHaveTextContent('Ada Lovelace handed the browser back')
    await waitFor(() => expect(container.querySelector('.chat-message__bubble')).not.toBeInTheDocument())
  })

  it('the Hand back button releases the wheel and sends the hand-back as a turn with no words, naming the hold', async () => {
    // The page needs a thread for the turn; typing nothing and pressing
    // nothing else, the thread comes from the pane having been opened on one.
    // Here the row's thread stands in: the messages query names it.
    mockMessagesData = { pages: [{ messages: [handbackRow()] }] }
    mockStreamMessage.mockImplementation(async (_input: unknown, callbacks: { onComplete?: (m: unknown) => void }) => {
      callbacks.onComplete?.(null)
    })
    renderPage()
    // Open a thread the way the page does: a first send creates one.
    fireEvent.change(screen.getByPlaceholderText('Ask Liftoff anything...'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByLabelText('Send message'))
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1))
    // The send while driving carried the hand-back beside the words, in one turn.
    expect(mockStreamMessage.mock.calls[0][0]).toMatchObject({ threadId: 'thread-1', content: 'hello', browserHandback: { holdId: HOLD } })
    // The button: a turn of its own, with no words.
    fireEvent.click(screen.getByText('Hand back to Liftoff'))
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2))
    const [input] = mockStreamMessage.mock.calls[1] as [Record<string, unknown>]
    expect(input).toMatchObject({ threadId: 'thread-1', browserHandback: { holdId: HOLD } })
    expect(input).not.toHaveProperty('content')
    expect(mockHandBackIfDriving).toHaveBeenCalledWith('account-1')
  })

  it('sends nothing when the release ended no hold of this person\'s', async () => {
    mockHandBackIfDriving.mockResolvedValue(null)
    mockMessagesData = { pages: [{ messages: [handbackRow()] }] }
    renderPage()
    fireEvent.click(screen.getByText('Hand back to Liftoff'))
    await waitFor(() => expect(mockHandBackIfDriving).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(mockStreamMessage).not.toHaveBeenCalled()
  })

  it('a 409 on the hand-back turn shows no error', async () => {
    mockMessagesData = { pages: [{ messages: [handbackRow()] }] }
    mockStreamMessage.mockImplementation(async (input: Record<string, unknown>, callbacks: { onComplete?: (m: unknown) => void; onError?: (e: unknown) => void }) => {
      if (input.content) callbacks.onComplete?.(null)
      else callbacks.onError?.({ code: 'HTTP_409', message: 'handback_not_pending', status: 409 })
    })
    renderPage()
    fireEvent.change(screen.getByPlaceholderText('Ask Liftoff anything...'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByLabelText('Send message'))
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText('Hand back to Liftoff'))
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(mockShowToast).not.toHaveBeenCalled()
  })
})
