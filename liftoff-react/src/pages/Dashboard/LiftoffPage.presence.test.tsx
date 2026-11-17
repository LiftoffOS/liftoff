import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Liftoff is a workspace surface, so a thread can have more than one person on
// it. The same facepile and typing bubble team chat uses are wired here, and to
// the same places: the roster in the header, the bubble at the foot of the
// conversation.

// jsdom has no layout, so the conversation's auto-scroll needs a stub.
Element.prototype.scrollIntoView = vi.fn()

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useLocation: () => ({ state: { threadId: 'thread-1' }, pathname: '/dashboard/liftoff' }),
    useNavigate: () => vi.fn(),
  }
})

vi.mock('../../services/liftoffChat', () => ({
  // The page asks whether work is queued to continue an earlier turn on the
  // open conversation; nothing is, on a page these tests are about.
  getLiftoffThreadContinuation: vi.fn().mockResolvedValue(null),
  streamLiftoffChatMessage: vi.fn(),
  stopLiftoffChatTurn: vi.fn(),
  listLiftoffThreadDelegations: vi.fn().mockResolvedValue([]),
  markLiftoffThreadRead: vi.fn().mockResolvedValue(undefined),
  getLiftoffUnreadCount: vi.fn().mockResolvedValue({ count: 0 }),
}))

vi.mock('../../services/agentChat', () => ({ createChatShare: vi.fn() }))

vi.mock('../../hooks/useLiftoffThreads', () => ({
  LIFTOFF_THREADS_QUERY_KEY: ['threads'],
  useCreateLiftoffThread: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useLiftoffThreads: () => ({ data: undefined, isLoading: false }),
}))

vi.mock('../../hooks/useLiftoffMessages', () => ({
  LIFTOFF_MESSAGES_QUERY_KEY: ['messages'],
  useLiftoffMessages: () => ({ data: undefined }),
}))

vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1', name: 'Test' } }),
}))

// Literal rather than the ME constant below: mock factories run while the page
// module is imported, which is before a const in this file is initialised.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ account: { id: 'account-1' } }),
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('../../hooks/useDictation', () => ({
  useDictation: () => ({ isListening: false, toggle: vi.fn() }),
}))

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

// The transport is exercised in the hook's own suite; here it only has to be an
// object the page can hand over.
const mockUseThreadPresence = vi.fn()
vi.mock('../../hooks/useThreadPresence', () => ({
  useThreadPresence: (...args: unknown[]) => mockUseThreadPresence(...args),
}))

vi.mock('../../hooks/chatPresenceTransports', () => ({
  liftoffPresenceTransport: { key: 'liftoff' },
}))

import { liftoffPresenceTransport } from '../../hooks/chatPresenceTransports'
import type { ThreadPresenceEntry } from '../../services/presence'
import LiftoffPage from './LiftoffPage'

const ME = 'account-1'

const person = (over: Partial<ThreadPresenceEntry> = {}): ThreadPresenceEntry => ({
  accountId: 'acc-2',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  avatarUrl: null,
  typing: false,
  ...over,
})

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
  mockUseThreadPresence.mockReturnValue({ viewers: [], liveTurnId: null })
})

describe('LiftoffPage presence', () => {
  it('polls its own surface for the thread on screen', () => {
    renderPage()

    expect(mockUseThreadPresence).toHaveBeenCalledWith(
      liftoffPresenceTransport,
      'thread-1',
      expect.objectContaining({ draft: '', isStreaming: false }),
    )
  })

  it('shows who else is on the thread', () => {
    mockUseThreadPresence.mockReturnValue({
      viewers: [person({ accountId: ME, firstName: 'Me' }), person()],
      liveTurnId: null,
    })

    const { container } = renderPage()

    const avatars = container.querySelectorAll('.thread-presence__avatar')
    expect(avatars).toHaveLength(1)
    expect(avatars[0]).toHaveTextContent('AL')
    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument()
  })

  it('leaves the header alone when you are the only one here', () => {
    mockUseThreadPresence.mockReturnValue({
      viewers: [person({ accountId: ME, firstName: 'Me' })],
      liveTurnId: null,
    })

    const { container } = renderPage()

    expect(container.querySelector('.thread-presence')).not.toBeInTheDocument()
  })

  it('draws a typing bubble at the foot of the conversation', () => {
    mockUseThreadPresence.mockReturnValue({
      viewers: [person({ typing: true })],
      liveTurnId: null,
    })

    const { container } = renderPage()

    const typing = container.querySelector('.chat-page__conversation .thread-typing')
    expect(typing).toBeInTheDocument()
    expect(typing?.querySelector('.chat-message__typing')).toBeInTheDocument()
  })

  it('does not draw a typing bubble for your own keystrokes', () => {
    mockUseThreadPresence.mockReturnValue({
      viewers: [person({ accountId: ME, typing: true })],
      liveTurnId: null,
    })

    const { container } = renderPage()

    expect(container.querySelector('.thread-typing')).not.toBeInTheDocument()
  })
})
