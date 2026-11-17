// Unread state for Chat History's "All" list
//
// "All" holds threads from every surface, and each surface keeps its own read
// markers behind its own endpoints. Nothing new on the server: marking a row
// read calls the endpoint of the surface it lives on, and Mark All Read calls
// every surface's. Each write invalidates the same queries that surface's own
// hook does, plus the "All" list, so every dot that shows the thread clears
// together wherever it is drawn.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import { useToast } from '../contexts/ToastContext'
import { ALL_CHAT_THREADS_QUERY_KEY } from './useAllChatThreads'
import { AGENT_CHAT_THREADS_QUERY_KEY } from './useAgentChatThreads'
import { LIFTOFF_THREADS_QUERY_KEY } from './useLiftoffThreads'
import { INSIGHTS_THREADS_QUERY_KEY } from './useInsightsThreads'
import { TEAM_PLAN_THREADS_QUERY_KEY } from './useTeamPlanThreads'
import { CHAT_UNREAD_QUERY_KEY, useChatUnreadCounts } from './useChatUnread'
import { LIFTOFF_UNREAD_QUERY_KEY, useLiftoffUnreadCount } from './useLiftoffUnread'
import { INSIGHTS_UNREAD_QUERY_KEY, useInsightsUnreadCount } from './useInsightsUnread'
import { TEAM_PLAN_UNREAD_QUERY_KEY, useTeamPlanUnreadCount } from './useTeamPlanUnread'
import {
  getAgentChatUnreadCounts,
  markAgentChatThreadRead,
  markAllAgentChatThreadsRead,
} from '../services/agentChat'
import { markLiftoffThreadRead, markAllLiftoffThreadsRead } from '../services/liftoffChat'
import { markInsightsThreadRead, markAllInsightsThreadsRead } from '../services/insightsChat'
import { markTeamPlanThreadRead, markAllTeamPlanThreadsRead } from '../services/teamPlanChat'
import type { ChatThreadTarget } from '../lib/chatThreadRoute'

/** Whether anything in the workspace carries an unread reply for this reader:
 *  any team, or any of the three assistants. Read off the counts every other
 *  indicator already polls, so "All" cannot disagree with them. */
export function useAnyChatUnread(): boolean {
  const { data: teamCounts } = useChatUnreadCounts()
  const { data: liftoff } = useLiftoffUnreadCount()
  const { data: insights } = useInsightsUnreadCount()
  const { data: teamPlan } = useTeamPlanUnreadCount()
  return (
    Object.values(teamCounts ?? {}).some(count => count > 0)
    || (liftoff ?? 0) > 0
    || (insights ?? 0) > 0
    || (teamPlan ?? 0) > 0
  )
}

/** Every query a surface's own mark-read hook invalidates, plus "All". */
function invalidateSurface(
  queryClient: ReturnType<typeof useQueryClient>,
  tenantId: string | undefined,
  target: { kind: ChatThreadTarget['kind']; agentId?: string },
) {
  queryClient.invalidateQueries({ queryKey: ALL_CHAT_THREADS_QUERY_KEY })
  switch (target.kind) {
    case 'agent':
      queryClient.invalidateQueries({ queryKey: CHAT_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({
        queryKey: target.agentId
          ? [...AGENT_CHAT_THREADS_QUERY_KEY, target.agentId, tenantId]
          : AGENT_CHAT_THREADS_QUERY_KEY,
      })
      return
    case 'liftoff':
      queryClient.invalidateQueries({ queryKey: LIFTOFF_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: [...LIFTOFF_THREADS_QUERY_KEY, tenantId] })
      return
    case 'insights':
      queryClient.invalidateQueries({ queryKey: INSIGHTS_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: [...INSIGHTS_THREADS_QUERY_KEY, tenantId] })
      return
    case 'team_plan':
      queryClient.invalidateQueries({ queryKey: TEAM_PLAN_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: [...TEAM_PLAN_THREADS_QUERY_KEY, tenantId] })
      return
  }
}

/** Mark one thread read, on the surface it lives on. */
export function useMarkAnyThreadRead() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (target: ChatThreadTarget) => {
      const tenantId = tenant!.id
      switch (target.kind) {
        case 'agent':
          return markAgentChatThreadRead(tenantId, target.agentId, target.threadId)
        case 'liftoff':
          return markLiftoffThreadRead(tenantId, target.threadId)
        case 'insights':
          return markInsightsThreadRead(tenantId, target.threadId)
        case 'team_plan':
          return markTeamPlanThreadRead(tenantId, target.threadId)
      }
    },
    onSuccess: (_data, target) => invalidateSurface(queryClient, tenant?.id, target),
  })
}

/**
 * Mark every thread in the workspace read for this reader: all three
 * assistants, and every team with something unread. A team's read-all is per
 * team, so the teams come from a fresh read of the unread counts rather than
 * the polled one, which can be a minute old.
 *
 * Settles every surface before reporting, and fails if any one of them did,
 * so the caller can say so. The surfaces that succeeded stay read either way.
 */
export function useMarkAllChatsRead() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: async () => {
      const tenantId = tenant!.id
      const { counts } = await getAgentChatUnreadCounts(tenantId)
      const teamIds = Object.entries(counts ?? {})
        .filter(([, count]) => count > 0)
        .map(([agentId]) => agentId)
      const results = await Promise.allSettled([
        markAllLiftoffThreadsRead(tenantId),
        markAllInsightsThreadsRead(tenantId),
        markAllTeamPlanThreadsRead(tenantId),
        ...teamIds.map(agentId => markAllAgentChatThreadsRead(tenantId, agentId)),
      ])
      const failed = results.filter(r => r.status === 'rejected')
      if (failed.length > 0) {
        throw new Error(`${failed.length} of ${results.length} surfaces could not be marked read`)
      }
    },
    onSettled: () => {
      for (const kind of ['agent', 'liftoff', 'insights', 'team_plan'] as const) {
        invalidateSurface(queryClient, tenant?.id, { kind })
      }
    },
  })
}

/** What the "All" list needs to offer marking read, with the same failure
 *  toasts each surface's page shows for its own list. */
export function useAllChatReadActions() {
  const { showToast } = useToast()
  const hasUnread = useAnyChatUnread()
  const { mutate: markOne } = useMarkAnyThreadRead()
  const { mutate: markAll } = useMarkAllChatsRead()

  return {
    hasUnread,
    markRead: (target: ChatThreadTarget) => markOne(target, {
      onError: () => showToast('Could not mark the chat as read. Please try again.', 'error'),
    }),
    markAllRead: () => markAll(undefined, {
      onError: () => showToast('Could not mark your chats as read. Please try again.', 'error'),
    }),
  }
}
