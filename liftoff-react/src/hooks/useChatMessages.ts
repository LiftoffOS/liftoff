// Shared chat message queries.
//
// Every chat surface scrolls its transcript the same way, so the semantics are
// written once here and each surface's hook passes its query-key prefix and its
// service functions.
//
// Note on the cursor semantics: the backend returns each page newest-first,
// with nextCursor pointing at the OLDEST message on that page, and each
// subsequent fetch returns messages older than that cursor. React-query's "next
// page" terminology is preserved, but it means "older messages": the newest sit
// at the bottom of the viewport, so the page a reader pulls in is the one they
// see when they scroll UP.
//
// The cache key is always [...prefix, tenantId, threadId]. Agent chat puts its
// agentId in the prefix, which is what keeps one team's transcript out of
// another's entry.

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import { CHAT_PAGE_SIZE } from './useChatThreads'
import type { ChatCursorOptions, ChatCursorPage } from '../services/chatSurface'

interface UseChatMessagesOptions<TPage extends ChatCursorPage> {
  queryKeyPrefix: readonly unknown[]
  /** Null on a fresh chat before the first send, which disables the query and
   *  leaves `data` undefined. */
  threadId: string | null
  listMessages: (
    tenantId: string,
    threadId: string,
    options?: ChatCursorOptions,
  ) => Promise<TPage>
  /** Extra gate ANDed with the tenant and thread checks. Agent chat has nothing
   *  to read until it knows which team it is looking at. */
  enabled?: boolean
}

/** Reverse-paginated messages for one thread. */
export function useChatMessages<TPage extends ChatCursorPage>({
  queryKeyPrefix,
  threadId,
  listMessages,
  enabled = true,
}: UseChatMessagesOptions<TPage>) {
  const { currentTenant: tenant } = useTenant()

  return useInfiniteQuery({
    queryKey: [...queryKeyPrefix, tenant?.id, threadId],
    queryFn: ({ pageParam }) =>
      listMessages(tenant!.id, threadId!, {
        cursor: pageParam,
        limit: CHAT_PAGE_SIZE,
      }),
    getNextPageParam: (lastPage: TPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
    initialPageParam: undefined as string | undefined,
    enabled: !!tenant?.id && !!threadId && enabled,
    staleTime: 10 * 1000,
  })
}

interface UseSendChatUserMessageOptions<TResult> {
  messagesQueryKeyPrefix: readonly unknown[]
  threadsQueryKeyPrefix: readonly unknown[]
  sendUserMessage: (
    tenantId: string,
    threadId: string,
    content: string,
  ) => Promise<TResult>
}

/**
 * Append a user message to a thread. The backend sanitizes it (strips control
 * chars, HTML-escapes) and enforces the length cap. On success the message list
 * for this thread is invalidated, AND the thread list is invalidated so the
 * parent thread bubbles to the top of the Chat History modal: the backend
 * touches updated_at on every append.
 */
export function useSendChatUserMessage<TResult>({
  messagesQueryKeyPrefix,
  threadsQueryKeyPrefix,
  sendUserMessage,
}: UseSendChatUserMessageOptions<TResult>) {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: ({ threadId, content }: { threadId: string; content: string }) =>
      sendUserMessage(tenant!.id, threadId, content),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: [...messagesQueryKeyPrefix, tenant?.id, variables.threadId],
      })
      queryClient.invalidateQueries({
        queryKey: [...threadsQueryKeyPrefix, tenant?.id],
      })
    },
  })
}
