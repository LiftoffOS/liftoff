// Liftoff unread state
//
// Same design as agent chat's useChatUnread, on the Liftoff surface's own
// endpoints: one count query behind every indicator, so the dot on the home
// page's Resume button and the row dots in the history modal cannot disagree.
//
// The count polls on an interval because a reply can land while the reader sits
// on /dashboard doing nothing. Without it the dot would only appear on a
// reload, which is exactly the moment the reader has stopped needing to be told.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import {
  getLiftoffUnreadCount,
  markLiftoffThreadRead,
  markAllLiftoffThreadsRead,
  type LiftoffUnreadCountResponse,
} from '../services/liftoffChat'
import { LIFTOFF_THREADS_QUERY_KEY } from './useLiftoffThreads'

export const LIFTOFF_UNREAD_QUERY_KEY = ['unread'] as const

/** Threads with an unread Liftoff reply for the signed-in reader. */
export function useLiftoffUnreadCount() {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...LIFTOFF_UNREAD_QUERY_KEY, tenant?.id],
    queryFn: () => getLiftoffUnreadCount(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 30_000,
    refetchInterval: 60_000,
    select: (data: LiftoffUnreadCountResponse) => data.count ?? 0,
  })
}

/**
 * Mark a thread read.
 *
 * Invalidates both the count and the thread list, so the Resume-button dot and
 * the history modal's row dots clear together. Clearing only one of them is
 * worse than clearing neither: it tells the reader the state is being tracked
 * and then contradicts itself two surfaces later.
 */
export function useMarkLiftoffThreadRead() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (threadId: string) => markLiftoffThreadRead(tenant!.id, threadId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LIFTOFF_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({
        queryKey: [...LIFTOFF_THREADS_QUERY_KEY, tenant?.id],
      })
    },
  })
}

/** Mark every thread read. Invalidates the same two queries as marking one. */
export function useMarkAllLiftoffThreadsRead() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: () => markAllLiftoffThreadsRead(tenant!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LIFTOFF_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({
        queryKey: [...LIFTOFF_THREADS_QUERY_KEY, tenant?.id],
      })
    },
  })
}
