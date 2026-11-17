// Team-plan unread state
//
// Same design as agent chat's useChatUnread and Liftoff's useLiftoffUnread, on
// the Chief AI Officer surface's own endpoints (served by workforce-service
// through the /api/team-plan proxy): one count query behind every indicator,
// so the dot on the teams page's Plan Workforce button and the row dots in the
// history modal cannot disagree.
//
// The count polls on an interval because a reply can land while the reader
// sits on /dashboard/agents doing nothing. Without it the dot would only appear
// on a reload, which is exactly the moment the reader has stopped needing to
// be told.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import {
  getTeamPlanUnreadCount,
  markTeamPlanThreadRead,
  markAllTeamPlanThreadsRead,
  type TeamPlanUnreadCountResponse,
} from '../services/teamPlanChat'
import { TEAM_PLAN_THREADS_QUERY_KEY } from './useTeamPlanThreads'

export const TEAM_PLAN_UNREAD_QUERY_KEY = ['team-plan-unread'] as const

/** Threads with an unread Chief AI Officer reply for the signed-in reader. */
export function useTeamPlanUnreadCount() {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...TEAM_PLAN_UNREAD_QUERY_KEY, tenant?.id],
    queryFn: () => getTeamPlanUnreadCount(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 30_000,
    refetchInterval: 60_000,
    select: (data: TeamPlanUnreadCountResponse) => data.count ?? 0,
  })
}

/**
 * Mark a thread read.
 *
 * Invalidates both the count and the thread list, so the Plan Workforce dot
 * and the history modal's row dots clear together. Clearing only one of them
 * is worse than clearing neither: it tells the reader the state is being
 * tracked and then contradicts itself two surfaces later.
 */
export function useMarkTeamPlanThreadRead() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (threadId: string) => markTeamPlanThreadRead(tenant!.id, threadId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TEAM_PLAN_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({
        queryKey: [...TEAM_PLAN_THREADS_QUERY_KEY, tenant?.id],
      })
    },
  })
}

/** Mark every thread read. Invalidates the same two queries as marking one. */
export function useMarkAllTeamPlanThreadsRead() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: () => markAllTeamPlanThreadsRead(tenant!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TEAM_PLAN_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({
        queryKey: [...TEAM_PLAN_THREADS_QUERY_KEY, tenant?.id],
      })
    },
  })
}
