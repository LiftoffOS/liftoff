// Insights unread state
//
// Same design as agent chat's useChatUnread and Liftoff's useLiftoffUnread, on
// the Insights surface's own endpoints: one count query behind every
// indicator, so the dot on the sidebar's Insights icon and the row dots in the
// history modal cannot disagree.
//
// The count polls on an interval because a reply can land while the reader
// sits anywhere in the app doing nothing. Without it the dot would only appear
// on a reload, which is exactly the moment the reader has stopped needing to
// be told.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import {
  getInsightsUnreadCount,
  markInsightsThreadRead,
  markAllInsightsThreadsRead,
  type InsightsUnreadCountResponse,
} from '../services/insightsChat'
import { INSIGHTS_THREADS_QUERY_KEY } from './useInsightsThreads'

export const INSIGHTS_UNREAD_QUERY_KEY = ['insights-unread'] as const

/** Threads with an unread Insights Manager reply for the signed-in reader. */
export function useInsightsUnreadCount() {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...INSIGHTS_UNREAD_QUERY_KEY, tenant?.id],
    queryFn: () => getInsightsUnreadCount(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 30_000,
    refetchInterval: 60_000,
    select: (data: InsightsUnreadCountResponse) => data.count ?? 0,
  })
}

/**
 * Mark a thread read.
 *
 * Invalidates both the count and the thread list, so the sidebar dot and the
 * history modal's row dots clear together. Clearing only one of them is worse
 * than clearing neither: it tells the reader the state is being tracked and
 * then contradicts itself two surfaces later.
 */
export function useMarkInsightsThreadRead() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (threadId: string) => markInsightsThreadRead(tenant!.id, threadId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INSIGHTS_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({
        queryKey: [...INSIGHTS_THREADS_QUERY_KEY, tenant?.id],
      })
    },
  })
}

/** Mark every thread read. Invalidates the same two queries as marking one. */
export function useMarkAllInsightsThreadsRead() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: () => markAllInsightsThreadsRead(tenant!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INSIGHTS_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({
        queryKey: [...INSIGHTS_THREADS_QUERY_KEY, tenant?.id],
      })
    },
  })
}
