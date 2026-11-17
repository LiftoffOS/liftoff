// Shared chat thread queries.
//
// The four chat surfaces (agent chat, the CAIO team plan, the Insights Manager
// and Liftoff) list, create and delete threads identically: forward cursor
// pagination scoped to the current tenant, and a list that has to refresh the
// moment a thread appears or disappears. Only the query-key prefix and the
// service functions differ, so the query semantics are written once here and
// each surface's hook passes its own.
//
// The cache key is always [...prefix, tenantId]. Agent chat puts its agentId in
// the prefix, which is what keeps one team's threads out of another's entry.

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import type { ChatCursorOptions, ChatCursorPage } from '../services/chatSurface'

/** Page size for both directions of chat pagination, matching the backend
 *  default (DEFAULT_THREAD_LIMIT in the platform backend's chat-repository). */
export const CHAT_PAGE_SIZE = 20

interface UseChatThreadsOptions<TPage extends ChatCursorPage> {
  queryKeyPrefix: readonly unknown[]
  listThreads: (tenantId: string, options?: ChatCursorOptions) => Promise<TPage>
  /** Extra gate ANDed with the tenant check. Agent chat has nothing to list
   *  until it knows which team it is looking at. */
  enabled?: boolean
  /** How long a loaded list counts as fresh. */
  staleTime?: number
}

/**
 * Forward-paginated threads visible to the caller, newest activity first. The
 * backend enforces the permission matrix server-side.
 */
export function useChatThreads<TPage extends ChatCursorPage>({
  queryKeyPrefix,
  listThreads,
  enabled = true,
  staleTime = 30 * 1000,
}: UseChatThreadsOptions<TPage>) {
  const { currentTenant: tenant } = useTenant()

  return useInfiniteQuery({
    queryKey: [...queryKeyPrefix, tenant?.id],
    queryFn: ({ pageParam }) =>
      listThreads(tenant!.id, {
        cursor: pageParam,
        limit: CHAT_PAGE_SIZE,
      }),
    getNextPageParam: (lastPage: TPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
    initialPageParam: undefined as string | undefined,
    enabled: !!tenant?.id && enabled,
    staleTime,
  })
}

interface UseCreateChatThreadOptions<TResult> {
  queryKeyPrefix: readonly unknown[]
  createThread: (tenantId: string, title?: string) => Promise<TResult>
}

/**
 * Create a thread and refresh the list so it appears in the history modal at
 * once. The title is optional: the backend stores null and derives one from the
 * first user message.
 */
export function useCreateChatThread<TResult>({
  queryKeyPrefix,
  createThread,
}: UseCreateChatThreadOptions<TResult>) {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: ({ title }: { title?: string } = {}) => createThread(tenant!.id, title),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...queryKeyPrefix, tenant?.id],
      })
    },
  })
}

interface UseDeleteChatThreadOptions {
  queryKeyPrefix: readonly unknown[]
  deleteThread: (tenantId: string, threadId: string) => Promise<void>
}

/**
 * Soft-delete a thread and drop it from the list. The backend answers 404
 * rather than 403 when the thread is not visible to the caller, so a deletion
 * never leaks that somebody else's thread exists.
 */
export function useDeleteChatThread({
  queryKeyPrefix,
  deleteThread,
}: UseDeleteChatThreadOptions) {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (threadId: string) => deleteThread(tenant!.id, threadId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...queryKeyPrefix, tenant?.id],
      })
    },
  })
}
