import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Sending while the Chief AI Officer is still replying must deliver the message
// INTO that reply, not start a second turn on the same thread. Both turns would
// append to one transcript, and the person would watch two answers argue with
// each other (ADR-041).

// jsdom has no layout, so the conversation's auto-scroll needs a stub.
Element.prototype.scrollIntoView = vi.fn()

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useLocation: () => ({ state: null, pathname: '/dashboard/agents/plan' }),
    useNavigate: () => vi.fn(),
  }
})

const mockStreamMessage = vi.fn()
const mockStopTurn = vi.fn()
// Mutable so the Chat History dot tests can vary it; read at call time, so
// every earlier test keeps the zero default.
let mockUnreadCount = 0
vi.mock('../../services/teamPlanChat', () => ({
  CAIO_AGENT_ID: '00000000-0000-0000-0000-000000000001',
  streamTeamPlanChatMessage: (...args: unknown[]) => mockStreamMessage(...args),
  stopTeamPlanChatTurn: (...args: unknown[]) => mockStopTurn(...args),
  markTeamPlanThreadRead: vi.fn().mockResolvedValue(undefined),
  getTeamPlanUnreadCount: vi.fn(async () => ({ count: mockUnreadCount })),
}))

const mockCreateChatShare = vi.fn()
vi.mock('../../services/agentChat', () => ({
  createChatShare: (...args: unknown[]) => mockCreateChatShare(...args),
  // Imported by the More pane's messaging cards; never called unless a test
  // clicks Add to Microsoft Teams.
  getTeamsConnectUrl: vi.fn().mockResolvedValue({ url: 'https://teams.invalid' }),
}))

// The More pane's Slack card calls this on click; rendering the pane only
// reads `connecting`.
vi.mock('../../hooks/useIntegrationConnect', () => ({
  useIntegrationConnect: () => ({ connect: vi.fn(), connecting: null }),
}))

const mockCreateThread = vi.fn()
vi.mock('../../hooks/useTeamPlanThreads', () => ({
  TEAM_PLAN_THREADS_QUERY_KEY: ['team-plan-threads'],
  useCreateTeamPlanThread: () => ({ mutateAsync: mockCreateThread, isPending: false }),
  useTeamPlanThreads: () => ({ data: undefined, isLoading: false }),
}))

// The transcript, when a test needs one on screen. The hook is read whatever
// the thread, so a fixed page of rows renders on mount.
let mockMessagesData: unknown = undefined
vi.mock('../../hooks/useTeamPlanMessages', () => ({
  TEAM_PLAN_MESSAGES_QUERY_KEY: ['team-plan-messages'],
  useTeamPlanMessages: () => ({ data: mockMessagesData }),
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

vi.mock('../../hooks/useObservedTurn', () => ({
  useObservedTurn: () => null,
}))

vi.mock('../../hooks/chatPresenceTransports', () => ({
  teamPlanPresenceTransport: {},
}))

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

import TeamPlanPage from './TeamPlanPage'

type StreamCallbacks = {
  onThinking?: () => void
  onTextDelta?: (text: string) => void
  onInterruptDelivered?: () => void
  onComplete?: (message: unknown) => void
}

// What the Chief AI Officer opens with. Not a clock string: the backend reads
// the tenant's connectors and agents and the CAIO speaks to what is there.
const GREETING = 'You have Slack connected and no agents yet. Where should we start?'

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <TeamPlanPage />
    </QueryClientProvider>,
  )
}

/** The greeting call and the ones that carry a message go to the same
 *  function. A greeting has no thread; that is what tells them apart. */
function sendCalls() {
  return mockStreamMessage.mock.calls.filter(
    call => (call[0] as { threadId?: string }).threadId !== undefined,
  )
}

/** Wait for the opening greeting to arrive and settle, so a test that is about
 *  something else starts from the same place a person does. */
async function greetingSettles() {
  expect(await screen.findByText(GREETING)).toBeInTheDocument()
}

/**
 * Get the page into the state these tests are about: a thread open and a reply
 * still streaming into it.
 *
 * This used to happen by itself, as a side effect of the greeting: the page
 * created a thread on mount and streamed into it, leaving a permanent untitled
 * thread behind on every visit nobody typed into. The greeting is still the
 * first thing that happens, but it has no thread and persists nothing, so
 * saying something is what opens a conversation — here as in the product.
 */
async function startRun() {
  await greetingSettles()
  const textarea = screen.getByPlaceholderText('Ask your Chief AI Officer...')
  fireEvent.change(textarea, { target: { value: 'plan my workforce' } })
  fireEvent.click(screen.getByLabelText('Send message'))
  await waitFor(() => expect(sendCalls()).toHaveLength(1))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUnreadCount = 0
  mockMessagesData = undefined
  mockCreateThread.mockResolvedValue({ thread: { id: 'thread-1' } })
  mockStopTurn.mockResolvedValue({ acknowledged: true, deliveredAs: 'abort' })
  mockCreateChatShare.mockResolvedValue({ id: 'share-42' })
  mockStreamMessage.mockImplementation(
    (input: { threadId?: string }, callbacks: StreamCallbacks) => {
      // The greeting: says its piece and ends. Nothing comes back on the
      // complete frame because nothing was persisted.
      if (input.threadId === undefined) {
        callbacks.onTextDelta?.(GREETING)
        callbacks.onComplete?.(null)
        return Promise.resolve()
      }
      // A real turn's stream stays open, which is what puts the page in the
      // "a turn is running" state the mid-run path cares about.
      return new Promise<void>(() => {
        callbacks.onThinking?.()
        callbacks.onTextDelta?.('Let me take a look at your workspace.')
      })
    },
  )
})

describe('TeamPlanPage greets without starting a conversation', () => {
  it('asks for the greeting with no thread, and creates none', async () => {
    renderPage()

    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1))
    // No threadId and no content: the request the backend reads as "introduce
    // yourself", and persists nothing for.
    expect(mockStreamMessage.mock.calls[0][0]).toEqual({ tenantId: 'tenant-1' })
    expect(mockCreateThread).not.toHaveBeenCalled()
  })

  it('says the greeting as a message, not as empty-state copy', async () => {
    renderPage()

    const greeting = await screen.findByText(GREETING)
    // In a bubble, from the Chief AI Officer. It used to be a grey paragraph
    // in the empty state, next to a heading talking about the CAIO in the
    // third person while the sentence itself spoke in the first.
    expect(greeting.closest('.chat-message--assistant')).not.toBeNull()
  })

  it('drops the empty state once the greeting lands', async () => {
    renderPage()
    await greetingSettles()

    expect(screen.queryByText('Plan Your AI Workforce')).not.toBeInTheDocument()
  })

  it('asks only once, however many times the effect runs', async () => {
    renderPage()
    await greetingSettles()

    // StrictMode double-invokes effects, and on this surface a greeting is a
    // real LLM turn. Two of them to say hello once is a bill, not a bug fix.
    expect(mockStreamMessage).toHaveBeenCalledTimes(1)
  })

  it('keeps the greeting on screen once the person replies', async () => {
    renderPage()
    await startRun()

    // The conversation opens with what the CAIO said, then the reply to it.
    expect(screen.getByText(GREETING)).toBeInTheDocument()
  })
})

describe('TeamPlanPage mid-run sending', () => {
  it('delivers a message typed during the reply into the running turn', async () => {
    renderPage()
    await startRun()
    const firstSignal = sendCalls()[0][2] as AbortSignal

    const textarea = screen.getByPlaceholderText('Ask your Chief AI Officer...')
    // The composer stays usable for the whole run.
    expect(textarea).not.toBeDisabled()

    fireEvent.change(textarea, { target: { value: 'actually, focus on support' } })
    fireEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() => expect(sendCalls()).toHaveLength(2))
    expect(sendCalls()[1][0]).toEqual({
      tenantId: 'tenant-1',
      threadId: 'thread-1',
      content: 'actually, focus on support',
      attachments: [],
    })
    // The live stream is untouched: its reply is still the one being rendered.
    expect(firstSignal.aborted).toBe(false)
    expect(sendCalls()[1][2]).not.toBe(firstSignal)
  })

  it('tells the person their message went into the reply in progress', async () => {
    renderPage()
    await startRun()

    mockStreamMessage.mockImplementationOnce(
      async (_input: unknown, callbacks: StreamCallbacks) => {
        callbacks.onInterruptDelivered?.()
      },
    )

    const textarea = screen.getByPlaceholderText('Ask your Chief AI Officer...')
    fireEvent.change(textarea, { target: { value: 'and keep it under budget' } })
    fireEvent.click(screen.getByLabelText('Send message'))

    expect(
      await screen.findByText("Sent: delivered to the Chief AI Officer's current reply"),
    ).toBeInTheDocument()
  })

  it('shows Stop while the reply streams and nothing has been typed', async () => {
    renderPage()
    await startRun()
    expect(screen.getByLabelText('Stop the current run')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Stop the current run'))
    await waitFor(() =>
      expect(mockStopTurn).toHaveBeenCalledWith({ tenantId: 'tenant-1', threadId: 'thread-1' }),
    )
    expect(await screen.findByText('Stopping…')).toBeInTheDocument()
  })

  it('says so when the stop request does not land', async () => {
    // This used to be swallowed: the button did nothing and said nothing.
    mockStopTurn.mockRejectedValue(new Error('404'))
    renderPage()
    await startRun()

    fireEvent.click(screen.getByLabelText('Stop the current run'))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Could not stop the response. Please try again.',
        'error',
      ),
    )
  })
})

// The Chief AI Officer has an agent row of its own, so a plan share carries an
// agentId the way a team's own chat does. Only the kind tells the two apart,
// and the backend requires the field on both.
describe('TeamPlanPage sharing', () => {
  it('mints a plan share with the Chief AI Officer on it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    renderPage()
    await startRun()

    fireEvent.click(screen.getByLabelText('Share'))

    await waitFor(() => expect(mockCreateChatShare).toHaveBeenCalledTimes(1))
    expect(mockCreateChatShare).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      agentId: '00000000-0000-0000-0000-000000000001',
      threadId: 'thread-1',
      threadKind: 'team_plan',
    })
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/share-42`),
    )
    expect(mockShowToast).toHaveBeenCalledWith(
      'Link copied to your clipboard. This link is only accessible to members of your workspace',
      'success',
    )
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('says so when the link could not be minted', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockCreateChatShare.mockRejectedValue(new Error('500'))

    renderPage()
    await startRun()

    fireEvent.click(screen.getByLabelText('Share'))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Could not copy the share link. Please try again.',
        'error',
      ),
    )
    Reflect.deleteProperty(navigator, 'clipboard')
  })
})

// The More pane: the same messaging-options pane AgentChatPage carries, on the
// Chief AI Officer's surface. The button sits in the title group beside Voice
// Mode and shares the right-pane strip with the browser live view.
describe('More pane', () => {
  it('opens the messaging options from the title-group button and closes again', () => {
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Show more pane' }))

    expect(screen.getByText('More Ways to Connect')).toBeInTheDocument()
    expect(screen.getByText('Add to Slack')).toBeInTheDocument()
    expect(screen.getByText('Add to Microsoft Teams')).toBeInTheDocument()
    expect(screen.getByText('Add to AI Coding Tool')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close more pane' }))
    expect(screen.queryByText('More Ways to Connect')).not.toBeInTheDocument()
  })
})

// The Chat History dot: same wrap, dot and accessible-name switch the team
// agent chat's history button carries, fed by this surface's own unread count.
describe('Chat History unread dot', () => {
  it('dots the button and augments the accessible name when a reply is unread', async () => {
    mockUnreadCount = 2

    renderPage()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Chat History, unread replies' }),
      ).toBeInTheDocument(),
    )
    const dot = document.querySelector('.chat-page__icon-btn-dot')
    expect(dot).toBeInTheDocument()
    expect(dot).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows no dot when nothing is unread', async () => {
    renderPage()

    expect(await screen.findByRole('button', { name: 'Chat History' })).toBeInTheDocument()
    expect(document.querySelector('.chat-page__icon-btn-dot')).not.toBeInTheDocument()
  })
})

// A hand-over the Chief AI Officer made can end with the colleague waiting on
// a person, and the note it forwarded can sit on its own thread when a
// colleague brought it in. Both are rows about the conversation, not speech,
// and they read the way the same rows read on Liftoff and in a team's chat.
describe('rows a hand-over writes on the plan thread', () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: 'm-x',
    threadId: 'thread-1',
    role: 'assistant',
    content: '',
    visualizationBlocks: null,
    messageType: null,
    contributors: [],
    inputTokens: 0,
    outputTokens: 0,
    createdAt: '2026-09-19T10:00:00.000Z',
    ...overrides,
  })

  it('draws a colleague waiting on a person as a status line, not as speech', async () => {
    const WAITING = 'Liftoff is waiting on an approval before it can continue.'
    mockMessagesData = {
      pages: [{
        messages: [row({
          content: WAITING,
          messageType: 'hitl_status',
          contributors: [{ id: 'liftoff', label: 'Liftoff' }],
        })],
      }],
    }

    const { container } = renderPage()
    await greetingSettles()

    const status = container.querySelector('.chat-page__hitl-status')
    expect(status).toBeInTheDocument()
    expect(status).toHaveTextContent(WAITING)
    expect(status?.querySelector('.chat-page__hitl-status__dot')).toBeInTheDocument()
    expect(status?.closest('.chat-message__bubble')).toBeNull()
  })

  it('attributes a forwarded note to the colleague that wrote it', async () => {
    mockMessagesData = {
      pages: [{
        messages: [row({
          content: 'Insights Manager shared background from the conversation so far\n\nThe Watches team costs the most.',
          messageType: 'forwarded_context',
          contributors: [{ id: 'insights', label: 'Insights Manager' }],
        })],
      }],
    }

    const { container } = renderPage()
    await greetingSettles()

    const rows = container.querySelectorAll('.chat-page__hitl-status')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Insights Manager shared background from the conversation so far')
    expect(rows[0].querySelector('.chat-message__sender-avatar')).toHaveTextContent('IM')
    // The brief an older row still carries is not rendered.
    expect(container.textContent).not.toContain('costs the most')
    expect(container.querySelector('details')).not.toBeInTheDocument()
  })

  it("draws the person's hand-back and point as status lines in their name, not as speech, with no chip", async () => {
    mockMessagesData = {
      pages: [{
        // Newest first, as the messages query answers.
        messages: [
          row({ id: 'p1', content: 'Ada Lovelace pointed at link "Sports"', messageType: 'browser_point', createdAt: '2026-09-19T10:01:00.000Z' }),
          row({ id: 'h1', content: 'Ada Lovelace handed the browser back', messageType: 'browser_handback' }),
        ],
      }],
    }

    const { container } = renderPage()
    await greetingSettles()

    const rows = container.querySelectorAll('.chat-page__hitl-status')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Ada Lovelace handed the browser back')
    expect(rows[1]).toHaveTextContent('Ada Lovelace pointed at link "Sports"')
    expect(rows[0].querySelector('.chat-message__sender-avatar')).toBeNull()
    expect(rows[0].closest('.chat-message__bubble')).toBeNull()
  })
})
