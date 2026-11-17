import { useState, useMemo, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { ActionMenu, EmptyState, ModalOverlay, SegmentedControl, TextInput, Tooltip } from '../../components'
import MailOpenIcon from '../../assets/icons/mail-open.svg?react'
import MessageCircleMoreIcon from '../../assets/icons/message-circle-more.svg?react'
import XIcon from '../../assets/icons/x.svg?react'
import { formatRelativeTime } from '../../utils/chat'
import './ChatHistoryModal.css'
import { useAutoFocus } from '../../hooks/useAutoFocus'
import { useAllChatThreads } from '../../hooks/useAllChatThreads'
import { useAllChatReadActions } from '../../hooks/useAllChatUnread'
import {
  PLATFORM_ASSISTANT_NAMES,
  chatThreadRoute,
  type ChatThreadTarget,
} from '../../lib/chatThreadRoute'
import type { ChatThreadKind } from '../../services/agentChat'
import type { CrossSurfaceThread } from '../../services/chatThreads'

export interface ChatThread {
  id: string
  title: string | null
  updatedAt: string
  /** The team has replied since this reader last opened the thread. */
  unread?: boolean
}

/** Who the open chat is with. A team is named by the page, each platform
 *  assistant by its own name. */
export type ChatHistoryScope =
  | { kind: 'agent'; agentId: string; name: string }
  | { kind: Exclude<ChatThreadKind, 'agent'> }

type HistoryView = 'current' | 'all'

/** One row, whichever list it came from. The rest is set on the "All" list
 *  only: who the chat is with, the thread on its own surface (what marking it
 *  read addresses), and where it opens when that is not this chat. */
interface HistoryRow {
  id: string
  title: string | null
  updatedAt: string
  unread: boolean
  source?: string
  thread?: ChatThreadTarget | null
  target?: ChatThreadTarget | null
}

function scopeName(scope: ChatHistoryScope): string {
  return scope.kind === 'agent' ? scope.name : PLATFORM_ASSISTANT_NAMES[scope.kind]
}

/** A row of the "All" list: null target when it belongs to the open chat, so
 *  picking it switches threads in place instead of routing. */
function allRow(thread: CrossSurfaceThread, scope: ChatHistoryScope): HistoryRow {
  const row = {
    id: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
    unread: thread.unread,
  }
  if (thread.kind === 'agent') {
    const agent = thread.agent
    if (!agent) return { ...row, source: 'agent', thread: null, target: null }
    const isHere = scope.kind === 'agent' && scope.agentId === agent.id
    const ref: ChatThreadTarget = { kind: 'agent', threadId: thread.id, agentId: agent.id }
    return { ...row, source: agent.name, thread: ref, target: isHere ? null : ref }
  }
  const ref: ChatThreadTarget = { kind: thread.kind, threadId: thread.id }
  return {
    ...row,
    source: PLATFORM_ASSISTANT_NAMES[thread.kind],
    thread: ref,
    target: scope.kind === thread.kind ? null : ref,
  }
}

interface ChatHistoryModalProps {
  currentThreadId: string | null
  /** Who this chat is with. Given, a control above the search switches the
   *  list between this chat's own history and every chat in the workspace. */
  scope?: ChatHistoryScope
  onSelectThread: (threadId: string) => void
  onClose: () => void
  /** Marks one thread read. Offered on hover over an unread row only. */
  onMarkRead?: (threadId: string) => void
  /** Marks every thread read, from the menu beside the search. */
  onMarkAllRead?: () => void
  /** Anything unread on this surface, including threads not loaded yet.
   *  Mark All Read is disabled without it. */
  hasUnread?: boolean
  threads: {
    data: { pages: { threads: ChatThread[] }[] } | undefined
    isLoading: boolean
    isError: boolean
    fetchNextPage: () => void
    hasNextPage: boolean | undefined
    isFetchingNextPage: boolean
  }
}

export default function ChatHistoryModal({
  currentThreadId,
  onSelectThread,
  onClose,
  onMarkRead,
  onMarkAllRead,
  hasUnread = false,
  scope,
  threads: currentThreads,
}: ChatHistoryModalProps) {
  const searchRef = useAutoFocus<HTMLInputElement>()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  // Always opens on this chat's own history: the modal is launched from a
  // chat, so that is what the person most likely came for.
  const [view, setView] = useState<HistoryView>('current')
  const titleId = 'chat-history-modal-title'
  const listRef = useRef<HTMLDivElement>(null)

  const isAll = !!scope && view === 'all'
  const allThreads = useAllChatThreads(isAll)
  const allRead = useAllChatReadActions()
  const {
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = isAll ? allThreads : currentThreads

  const currentData = currentThreads.data
  const allData = allThreads.data
  const threads: HistoryRow[] = useMemo(() => {
    if (isAll && scope) {
      // Keyed by id: consecutive pages of the merged list can repeat a row
      // whose activity landed on the page boundary.
      const seen = new Set<string>()
      return (allData?.pages.flatMap(page => page.threads) ?? [])
        .filter(t => !seen.has(t.id) && !!seen.add(t.id))
        .map(t => allRow(t, scope))
    }
    return (currentData?.pages.flatMap(page => page.threads) ?? []).map(t => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      unread: !!t.unread,
    }))
  }, [isAll, scope, allData, currentData])

  const query = search.toLowerCase().trim()
  const filteredThreads = useMemo(() => {
    if (!query) return threads
    return threads.filter(t =>
      (t.title ?? 'Untitled chat').toLowerCase().includes(query)
      || !!t.source?.toLowerCase().includes(query),
    )
  }, [threads, query])

  useEffect(() => {
    const sentinel = listRef.current?.querySelector<HTMLDivElement>(
      '.chat-history-modal__sentinel',
    )
    if (!sentinel || !hasNextPage) return

    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && !isFetchingNextPage) {
          fetchNextPage()
        }
      },
      { root: listRef.current, threshold: 0.1 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, filteredThreads.length])

  const handleSelect = (row: HistoryRow) => {
    if (row.target) {
      const { pathname, state } = chatThreadRoute(row.target)
      navigate(pathname, { state })
    } else {
      onSelectThread(row.id)
    }
    onClose()
  }

  const showEmptyState = !isLoading && !isError && threads.length === 0
  const showNoResults = !isLoading && !isError && threads.length > 0 && filteredThreads.length === 0

  return (
    <ModalOverlay onClose={onClose} ariaLabelledBy={titleId}>
      <div className="chat-history-modal" role="dialog" aria-labelledby={titleId}>
        <div className="chat-history-modal__header">
          <h2 id={titleId} className="chat-history-modal__title">
            Chat History
          </h2>
          <button
            type="button"
            className="chat-history-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon width={16} height={16} />
          </button>
        </div>

        {scope && (
          <SegmentedControl<HistoryView>
            className="chat-history-modal__views"
            value={view}
            onChange={setView}
            options={[
              { value: 'current', label: scopeName(scope) },
              { value: 'all', label: 'All' },
            ]}
          />
        )}

        {/* Kept while a search is typed, so switching views runs the same
          * search over the other list instead of dropping it. */}
        {(threads.length > 0 || search !== '') && (
          <div className="chat-history-modal__toolbar">
            <TextInput
              variant="search"
              placeholder="Search chats"
              value={search}
              onChange={e => setSearch(e.target.value)}
              ref={searchRef}
              className="chat-history-modal__search"
            />
            {/* Out of the way while searching: the search takes the row. */}
            {/* On "All" it marks every chat in the workspace read, and is
              * enabled by anything unread anywhere. */}
            {(isAll || onMarkAllRead) && !search && (
              <ActionMenu
                ariaLabel="Chat history options"
                items={[isAll
                  ? { label: 'Mark All Read', onClick: allRead.markAllRead, disabled: !allRead.hasUnread }
                  : { label: 'Mark All Read', onClick: () => onMarkAllRead?.(), disabled: !hasUnread }]}
              />
            )}
          </div>
        )}

        <div className="chat-history-modal__list" ref={listRef}>
          {isLoading && (
            <div className="chat-history-modal__loading">
              {/* role="status" is load-bearing: a bare <div aria-label> maps to
                * the generic role, which prohibits naming, so the name is
                * dropped and screen readers announce nothing at all. Dropping
                * the visible "Loading…" text without this regresses them. */}
              <div className="loading-spinner" role="status" aria-label="Loading chat history" />
            </div>
          )}

          {isError && (
            <p className="chat-history-modal__empty">
              Couldn't load chat history. Please try again.
            </p>
          )}

          {showEmptyState && (
            <EmptyState
              icon={<MessageCircleMoreIcon width="32" height="32" />}
              title="No chats yet"
              description="All your recent chats will appear here."
            />
          )}

          {showNoResults && (
            <EmptyState
              title="No matches"
              description={`Nothing matching "${search}"`}
            />
          )}

          {filteredThreads.map(thread => {
            const isActive = thread.id === currentThreadId && !thread.target
            // On "All" a row is marked read on the surface it lives on.
            const canMarkRead = thread.unread && (isAll ? !!thread.thread : !!onMarkRead)
            const markRead = () => {
              if (isAll) {
                if (thread.thread) allRead.markRead(thread.thread)
              } else {
                onMarkRead?.(thread.id)
              }
            }
            // A wrapper rather than one <button>: the row's actions are
            // buttons too, and a button cannot hold another.
            return (
              <div
                key={thread.id}
                className={`chat-history-modal__row${
                  isActive ? ' chat-history-modal__row--active' : ''
                }${canMarkRead ? ' chat-history-modal__row--has-actions' : ''}`}
              >
                <button
                  type="button"
                  className="chat-history-modal__row-select"
                  onClick={() => handleSelect(thread)}
                >
                  {thread.unread && (
                    <>
                      <span className="chat-history-modal__unread-dot" aria-hidden="true" />
                      {/* The row's accessible name is its text, so the dot needs a
                        * text equivalent. Colour alone reaches neither a screen
                        * reader nor a colour-blind reader. */}
                      <span className="sr-only">Unread reply</span>
                    </>
                  )}
                  <span className="chat-history-modal__row-title">
                    {thread.title ?? 'Untitled chat'}
                  </span>
                  {thread.source && (
                    <span className="chat-history-modal__row-source">{thread.source}</span>
                  )}
                  <span className="chat-history-modal__row-time">
                    {formatRelativeTime(thread.updatedAt)}
                  </span>
                </button>
                {canMarkRead && (
                  <div className="chat-history-modal__row-actions">
                    <Tooltip text="Mark as Read" position="top">
                      <button
                        type="button"
                        className="chat-history-modal__row-action"
                        onClick={markRead}
                        aria-label={`Mark ${thread.title ?? 'Untitled chat'} as read`}
                      >
                        <MailOpenIcon width={16} height={16} />
                      </button>
                    </Tooltip>
                  </div>
                )}
              </div>
            )
          })}

          {hasNextPage && (
            <div className="chat-history-modal__sentinel" aria-hidden="true">
              {isFetchingNextPage && (
                <div className="loading-spinner loading-spinner--sm" />
              )}
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
