// Insights Chat History Modal
//
// Picker modal that opens when the Chat History icon button on InsightsPage
// is clicked. Lists threads visible to the caller (backend enforces the
// permission matrix). Click a thread to switch to it; modal dismisses via
// backdrop click, Escape, or by selecting a thread.
//
// Follows the PersonAssignmentModal pattern from src/pages/Dashboard/
// PersonAssignmentModal.tsx — same shape, but no <ModalActions> footer
// because there is nothing to save or cancel. The only dismiss paths are
// the three free ones from <ModalOverlay>: backdrop click, Escape key,
// and selecting a thread (which calls onSelectThread then onClose).

import { useState, useMemo, useEffect, useRef } from 'react'
import { EmptyState, ModalOverlay, TextInput } from '../../components'
import MessageCircleMoreIcon from '../../assets/icons/message-circle-more.svg?react'
import XIcon from '../../assets/icons/x.svg?react'
import { useInsightsThreads } from '../../hooks/useInsightsThreads'
import type { InsightsChatThread } from '../../services/insightsChat'
import './InsightsChatHistoryModal.css'
import { useAutoFocus } from '../../hooks/useAutoFocus'

interface InsightsChatHistoryModalProps {
  /** Currently selected thread id, used to highlight the active row. */
  currentThreadId: string | null
  /** Called when the user picks a thread; the parent should setCurrentThreadId(threadId). */
  onSelectThread: (threadId: string) => void
  /** Backdrop / Escape / post-select dismissal. */
  onClose: () => void
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`

  return date.toLocaleDateString()
}

export default function InsightsChatHistoryModal({
  currentThreadId,
  onSelectThread,
  onClose,
}: InsightsChatHistoryModalProps) {
  const searchRef = useAutoFocus<HTMLInputElement>()
  const [search, setSearch] = useState('')
  const titleId = 'insights-chat-history-modal-title'
  const listRef = useRef<HTMLDivElement>(null)

  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInsightsThreads()

  // Flatten paginated results
  const threads: InsightsChatThread[] = useMemo(
    () => data?.pages.flatMap(page => page.threads) ?? [],
    [data],
  )

  // Client-side search by title (server-side search is a follow-up if needed)
  const query = search.toLowerCase().trim()
  const filteredThreads = useMemo(() => {
    if (!query) return threads
    return threads.filter(t => (t.title ?? 'Untitled chat').toLowerCase().includes(query))
  }, [threads, query])

  // Infinite scroll: fetch next page when the sentinel scrolls into view
  useEffect(() => {
    const sentinel = listRef.current?.querySelector<HTMLDivElement>(
      '.insights-chat-history-modal__sentinel',
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

  const handleSelect = (threadId: string) => {
    onSelectThread(threadId)
    onClose()
  }

  const showEmptyState = !isLoading && !isError && threads.length === 0
  const showNoResults = !isLoading && !isError && threads.length > 0 && filteredThreads.length === 0

  return (
    <ModalOverlay onClose={onClose} ariaLabelledBy={titleId}>
      <div className="insights-chat-history-modal" role="dialog" aria-labelledby={titleId}>
        <div className="insights-chat-history-modal__header">
          <h2 id={titleId} className="insights-chat-history-modal__title">
            Chat History
          </h2>
          <button
            type="button"
            className="insights-chat-history-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon width={16} height={16} />
          </button>
        </div>

        {threads.length > 0 && (
          <TextInput
            variant="search"
            placeholder="Search chats"
            value={search}
            onChange={e => setSearch(e.target.value)}
            ref={searchRef}
          />
        )}

        <div className="insights-chat-history-modal__list" ref={listRef}>
          {isLoading && (
            <div className="insights-chat-history-modal__loading">
              <div className="loading-spinner" role="status" aria-label="Loading chat history" />
            </div>
          )}

          {isError && (
            <p className="insights-chat-history-modal__empty">
              Couldn’t load chat history. Please try again.
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
            const isActive = thread.id === currentThreadId
            return (
              <button
                key={thread.id}
                type="button"
                className={`insights-chat-history-modal__row${
                  isActive ? ' insights-chat-history-modal__row--active' : ''
                }`}
                onClick={() => handleSelect(thread.id)}
              >
                <span className="insights-chat-history-modal__row-title">
                  {thread.title ?? 'Untitled chat'}
                </span>
                <span className="insights-chat-history-modal__row-time">
                  {formatRelativeTime(thread.updatedAt)}
                </span>
              </button>
            )
          })}

          {hasNextPage && (
            <div className="insights-chat-history-modal__sentinel" aria-hidden="true">
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
