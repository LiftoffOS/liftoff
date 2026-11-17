import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import ChatHistoryModal, { type ChatHistoryScope, type ChatThread } from './ChatHistoryModal'
import type { CrossSurfaceThread } from '../../services/chatThreads'

// The "All" list is the one query the modal runs itself. Mocked, so each case
// states what the merged list holds and whether the modal asked for it.
const mockUseAllChatThreads = vi.fn()
vi.mock('../../hooks/useAllChatThreads', () => ({
  useAllChatThreads: (enabled: boolean) => mockUseAllChatThreads(enabled),
}))

// Marking read on "All" goes to the surface each thread lives on. Mocked, so
// these assert which thread the modal asks for, not the surface calls.
const mockAllRead = { hasUnread: false, markRead: vi.fn(), markAllRead: vi.fn() }
vi.mock('../../hooks/useAllChatUnread', () => ({
  useAllChatReadActions: () => mockAllRead,
}))

// jsdom has no IntersectionObserver; the infinite-scroll sentinel needs one to
// exist at mount. A no-op is enough — none of these cases scroll.
beforeAll(() => {
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

// The modal is shared by all three chat surfaces (team chat, Chief AI Officer
// plan page, Insights). Loading state is a spinner, never the word "Loading" —
// the spinner still has to carry an accessible name, because swapping visible
// text for an icon is only safe if screen readers keep hearing something.

const thread = (over: Partial<ChatThread> = {}): ChatThread => ({
  id: 't-1',
  title: 'Quarterly planning',
  updatedAt: new Date().toISOString(),
  ...over,
})

type ThreadsProp = Parameters<typeof ChatHistoryModal>[0]['threads']

const threadsProp = (over: Partial<ThreadsProp> = {}): ThreadsProp => ({
  data: undefined,
  isLoading: false,
  isError: false,
  fetchNextPage: vi.fn(),
  hasNextPage: false,
  isFetchingNextPage: false,
  ...over,
})

beforeEach(() => {
  mockUseAllChatThreads.mockReset()
  mockUseAllChatThreads.mockReturnValue(threadsProp())
  mockAllRead.hasUnread = false
  mockAllRead.markRead.mockReset()
  mockAllRead.markAllRead.mockReset()
})

// ModalOverlay renders through a portal, so assertions read from document,
// not from render()'s container.
const renderModal = (threads: ThreadsProp) =>
  render(
    <MemoryRouter>
      <ChatHistoryModal
        currentThreadId={null}
        onSelectThread={vi.fn()}
        onClose={vi.fn()}
        threads={threads}
      />
    </MemoryRouter>,
  )

describe('ChatHistoryModal loading state', () => {
  it('shows the standard spinner instead of the word "Loading" on first load', () => {
    renderModal(threadsProp({ isLoading: true }))

    expect(document.querySelector('.loading-spinner')).toBeInTheDocument()
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument()
  })

  it('gives the spinner an accessible name so it is still announced', () => {
    renderModal(threadsProp({ isLoading: true }))

    // role="status" is what makes aria-label stick; a bare div maps to the
    // generic role, which drops the name entirely.
    expect(screen.getByRole('status', { name: 'Loading chat history' })).toBeInTheDocument()
  })

  it('shows a small spinner, not text, while fetching the next page', () => {
    renderModal(
      threadsProp({
        data: { pages: [{ threads: [thread()] }] },
        hasNextPage: true,
        isFetchingNextPage: true,
      }),
    )

    expect(document.querySelector('.loading-spinner--sm')).toBeInTheDocument()
    expect(screen.queryByText(/loading more/i)).not.toBeInTheDocument()
  })

  it('renders no spinner once threads have arrived', () => {
    renderModal(threadsProp({ data: { pages: [{ threads: [thread()] }] } }))

    expect(document.querySelector('.loading-spinner')).not.toBeInTheDocument()
    expect(screen.getByText('Quarterly planning')).toBeInTheDocument()
  })
})

// The dot marks a thread the team has replied in since this reader last opened
// it. A dot on its own is colour-only, which reaches neither a screen reader
// nor a colour-blind reader, so the row carries the words too.
describe('ChatHistoryModal unread indicator', () => {
  it('renders the dot only on the unread row', () => {
    renderModal(
      threadsProp({
        data: {
          pages: [{
            threads: [
              thread({ id: 't-unread', title: 'Has a new reply', unread: true }),
              thread({ id: 't-read', title: 'Already read', unread: false }),
            ],
          }],
        },
      }),
    )

    expect(document.querySelectorAll('.chat-history-modal__unread-dot')).toHaveLength(1)
    const unreadRow = screen.getByText('Has a new reply').closest('button')
    expect(unreadRow?.querySelector('.chat-history-modal__unread-dot')).toBeInTheDocument()
    const readRow = screen.getByText('Already read').closest('button')
    expect(readRow?.querySelector('.chat-history-modal__unread-dot')).toBeNull()
  })

  it('renders no dot when the field is absent, so an older backend shows nothing', () => {
    renderModal(threadsProp({ data: { pages: [{ threads: [thread()] }] } }))

    expect(document.querySelector('.chat-history-modal__unread-dot')).toBeNull()
  })

  it('carries the state in the row text, not in colour alone', () => {
    renderModal(
      threadsProp({
        data: { pages: [{ threads: [thread({ title: 'Has a new reply', unread: true })] }] },
      }),
    )

    expect(screen.getByText('Unread reply')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Unread reply/ }),
    ).toBeInTheDocument()
  })
})

describe('marking read', () => {
  const pages = (threads: ChatThread[]) => threadsProp({ data: { pages: [{ threads }] } })

  const renderWith = (props: Partial<Parameters<typeof ChatHistoryModal>[0]>) => {
    const onSelectThread = vi.fn()
    render(
      <MemoryRouter>
        <ChatHistoryModal
          currentThreadId={null}
          onSelectThread={onSelectThread}
          onClose={vi.fn()}
          threads={pages([
            thread({ id: 'unread', title: 'Unread one', unread: true }),
            thread({ id: 'read', title: 'Read one', unread: false }),
          ])}
          {...props}
        />
      </MemoryRouter>,
    )
    return { onSelectThread }
  }

  it('offers Mark as Read on unread rows only, and it does not open the thread', () => {
    const onMarkRead = vi.fn()
    const { onSelectThread } = renderWith({ onMarkRead })

    expect(screen.queryByRole('button', { name: 'Mark Read one as read' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Mark Unread one as read' }))

    expect(onMarkRead).toHaveBeenCalledWith('unread')
    expect(onSelectThread).not.toHaveBeenCalled()
  })

  it('shows no row action without a handler', () => {
    renderWith({})

    expect(screen.queryByRole('button', { name: /as read$/ })).toBeNull()
  })

  it('runs Mark All Read from the menu beside the search', () => {
    const onMarkAllRead = vi.fn()
    renderWith({ onMarkAllRead, hasUnread: true })

    fireEvent.click(screen.getByRole('button', { name: 'Chat history options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark All Read' }))

    expect(onMarkAllRead).toHaveBeenCalledTimes(1)
  })

  it('disables Mark All Read when nothing is unread', () => {
    renderWith({ onMarkAllRead: vi.fn(), hasUnread: false })

    fireEvent.click(screen.getByRole('button', { name: 'Chat history options' }))

    expect(screen.getByRole('button', { name: 'Mark All Read' })).toBeDisabled()
  })

  it('hides the menu while searching, and brings it back when the search is cleared', () => {
    renderWith({ onMarkAllRead: vi.fn(), hasUnread: true })
    const search = screen.getByPlaceholderText('Search chats')

    fireEvent.change(search, { target: { value: 'Unread' } })
    expect(screen.queryByRole('button', { name: 'Chat history options' })).toBeNull()

    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Chat history options' })).toBeInTheDocument()
  })

  it('has no menu without a handler', () => {
    renderWith({})

    expect(screen.queryByRole('button', { name: 'Chat history options' })).toBeNull()
  })
})

describe('ChatHistoryModal views', () => {
  const crossThread = (over: Partial<CrossSurfaceThread> = {}): CrossSurfaceThread => ({
    id: 'x-1',
    kind: 'liftoff',
    title: 'Somewhere else',
    updatedAt: new Date().toISOString(),
    unread: false,
    agent: null,
    ...over,
  })

  const allThreads = (threads: CrossSurfaceThread[]) =>
    threadsProp({ data: { pages: [{ threads }] } }) as unknown as ReturnType<typeof threadsProp>

  // Where the router ended up, so a routed pick can be asserted on.
  function LocationProbe() {
    const location = useLocation()
    return <output data-testid="location">{`${location.pathname} ${JSON.stringify(location.state)}`}</output>
  }

  const renderScoped = (
    scope: ChatHistoryScope,
    { onSelectThread = vi.fn(), onClose = vi.fn(), onMarkRead, current = threadsProp() }: {
      onSelectThread?: (threadId: string) => void
      onClose?: () => void
      onMarkRead?: (threadId: string) => void
      current?: ThreadsProp
    } = {},
  ) =>
    render(
      <MemoryRouter initialEntries={['/dashboard/liftoff']}>
        <Routes>
          <Route
            path="*"
            element={(
              <>
                <LocationProbe />
                <ChatHistoryModal
                  currentThreadId={null}
                  onSelectThread={onSelectThread}
                  onClose={onClose}
                  onMarkRead={onMarkRead}
                  scope={scope}
                  threads={current}
                />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>,
    )

  it('offers no switch where the page names no scope', () => {
    renderModal(threadsProp({ data: { pages: [{ threads: [thread()] }] } }))

    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument()
  })

  it("names this chat's segment after the assistant and opens on it without asking for the rest", () => {
    renderScoped({ kind: 'team_plan' })

    expect(screen.getByRole('button', { name: 'Chief AI Officer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(mockUseAllChatThreads).toHaveBeenLastCalledWith(false)
  })

  it('names a team by the name the page gives it', () => {
    renderScoped({ kind: 'agent', agentId: 'a-1', name: 'Code Reviewer' })

    expect(screen.getByRole('button', { name: 'Code Reviewer' })).toBeInTheDocument()
  })

  it('lists every chat on All with who it is with', () => {
    mockUseAllChatThreads.mockImplementation((enabled: boolean) =>
      enabled
        ? allThreads([
          crossThread({ id: 'x-1', kind: 'insights', title: 'Cost by team' }),
          crossThread({ id: 'x-2', kind: 'agent', title: 'Review PR 12', agent: { id: 'a-9', name: 'Code Reviewer' } }),
        ])
        : threadsProp())
    renderScoped({ kind: 'liftoff' })

    fireEvent.click(screen.getByRole('button', { name: 'All' }))

    expect(mockUseAllChatThreads).toHaveBeenLastCalledWith(true)
    expect(screen.getByText('Cost by team')).toBeInTheDocument()
    expect(screen.getByText('Insights Manager')).toBeInTheDocument()
    expect(screen.getByText('Code Reviewer')).toBeInTheDocument()
  })

  it("routes a chat from elsewhere to its own page and closes", () => {
    mockUseAllChatThreads.mockReturnValue(allThreads([
      crossThread({ id: 'x-2', kind: 'agent', title: 'Review PR 12', agent: { id: 'a-9', name: 'Code Reviewer' } }),
    ]))
    const onSelectThread = vi.fn()
    const onClose = vi.fn()
    renderScoped({ kind: 'liftoff' }, { onSelectThread, onClose })

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: /Review PR 12/ }))

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/dashboard/agents/chat {"agentId":"a-9","threadId":"x-2"}',
    )
    expect(onSelectThread).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("opens a chat of this surface in place rather than routing to it", () => {
    mockUseAllChatThreads.mockReturnValue(allThreads([
      crossThread({ id: 'x-1', kind: 'liftoff', title: 'Weekly plan' }),
    ]))
    const onSelectThread = vi.fn()
    renderScoped({ kind: 'liftoff' }, { onSelectThread })

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: /Weekly plan/ }))

    expect(onSelectThread).toHaveBeenCalledWith('x-1')
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard/liftoff null')
  })

  it("routes another team's chat even from a team's own page", () => {
    mockUseAllChatThreads.mockReturnValue(allThreads([
      crossThread({ id: 'x-3', kind: 'agent', title: 'Other team chat', agent: { id: 'a-2', name: 'Other Team' } }),
      crossThread({ id: 'x-4', kind: 'agent', title: 'Same team chat', agent: { id: 'a-1', name: 'Code Reviewer' } }),
    ]))
    const onSelectThread = vi.fn()
    renderScoped({ kind: 'agent', agentId: 'a-1', name: 'Code Reviewer' }, { onSelectThread })

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: /Same team chat/ }))
    expect(onSelectThread).toHaveBeenCalledWith('x-4')

    fireEvent.click(screen.getByRole('button', { name: /Other team chat/ }))
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/dashboard/agents/chat {"agentId":"a-2","threadId":"x-3"}',
    )
  })

  it('keeps the search when switching views and runs it over the new list', () => {
    mockUseAllChatThreads.mockImplementation((enabled: boolean) =>
      enabled
        ? allThreads([
          crossThread({ id: 'x-1', kind: 'insights', title: 'Payroll totals' }),
          crossThread({ id: 'x-2', kind: 'insights', title: 'Cost by team' }),
        ])
        : threadsProp())
    renderScoped({ kind: 'liftoff' }, {
      current: threadsProp({ data: { pages: [{ threads: [thread({ title: 'Weekly plan' })] }] } }),
    })

    fireEvent.change(screen.getByPlaceholderText('Search chats'), { target: { value: 'payroll' } })
    expect(screen.getByText('No matches')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'All' }))

    expect(screen.getByPlaceholderText('Search chats')).toHaveValue('payroll')
    expect(screen.getByText('Payroll totals')).toBeInTheDocument()
    expect(screen.queryByText('Cost by team')).not.toBeInTheDocument()
  })

  it("marks a row read through the page on this chat's own list", () => {
    const onMarkRead = vi.fn()
    renderScoped({ kind: 'liftoff' }, {
      onMarkRead,
      current: threadsProp({ data: { pages: [{ threads: [thread({ id: 't-9', title: 'Unread here', unread: true })] }] } }),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Mark Unread here as read' }))

    expect(onMarkRead).toHaveBeenCalledWith('t-9')
    expect(mockAllRead.markRead).not.toHaveBeenCalled()
  })

  it('marks a row read on All on the surface it lives on, a team included', () => {
    mockUseAllChatThreads.mockReturnValue(allThreads([
      crossThread({ id: 'x-1', kind: 'team_plan', title: 'Plan unread', unread: true }),
      crossThread({ id: 'x-2', kind: 'agent', title: 'Team unread', unread: true, agent: { id: 'a-9', name: 'Code Reviewer' } }),
      crossThread({ id: 'x-3', kind: 'insights', title: 'Already read', unread: false }),
    ]))
    const onMarkRead = vi.fn()
    renderScoped({ kind: 'liftoff' }, { onMarkRead })

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark Plan unread as read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark Team unread as read' }))

    expect(mockAllRead.markRead).toHaveBeenNthCalledWith(1, { kind: 'team_plan', threadId: 'x-1' })
    expect(mockAllRead.markRead).toHaveBeenNthCalledWith(2, { kind: 'agent', threadId: 'x-2', agentId: 'a-9' })
    expect(screen.queryByRole('button', { name: 'Mark Already read as read' })).not.toBeInTheDocument()
    expect(onMarkRead).not.toHaveBeenCalled()
  })

  it('marks a row of this chat read on All the same way, without routing', () => {
    mockUseAllChatThreads.mockReturnValue(allThreads([
      crossThread({ id: 'x-1', kind: 'liftoff', title: 'Mine unread', unread: true }),
    ]))
    renderScoped({ kind: 'liftoff' }, { onMarkRead: vi.fn() })

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark Mine unread as read' }))

    expect(mockAllRead.markRead).toHaveBeenCalledWith({ kind: 'liftoff', threadId: 'x-1' })
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard/liftoff null')
  })

  it('runs Mark All Read on All over every chat, enabled by anything unread anywhere', () => {
    mockAllRead.hasUnread = true
    mockUseAllChatThreads.mockReturnValue(allThreads([crossThread()]))
    const onMarkAllRead = vi.fn()
    render(
      <MemoryRouter>
        <ChatHistoryModal
          currentThreadId={null}
          onSelectThread={vi.fn()}
          onClose={vi.fn()}
          onMarkAllRead={onMarkAllRead}
          hasUnread={false}
          scope={{ kind: 'liftoff' }}
          threads={threadsProp({ data: { pages: [{ threads: [thread()] }] } })}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Chat history options' }))
    expect(screen.getByRole('button', { name: 'Mark All Read' })).toBeDisabled()
    // Closed again before switching; the trigger toggles.
    fireEvent.click(screen.getByRole('button', { name: 'Chat history options' }))

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: 'Chat history options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark All Read' }))

    expect(mockAllRead.markAllRead).toHaveBeenCalled()
    expect(onMarkAllRead).not.toHaveBeenCalled()
  })

  it('disables Mark All Read on All when nothing anywhere is unread', () => {
    mockUseAllChatThreads.mockReturnValue(allThreads([crossThread()]))
    renderScoped({ kind: 'liftoff' })

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: 'Chat history options' }))

    expect(screen.getByRole('button', { name: 'Mark All Read' })).toBeDisabled()
  })
})
