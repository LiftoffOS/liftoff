// Chat unread state
//
// Three indicators ask the same question at three granularities: does this
// thread have a reply nobody has read, does this team, does this team seen from
// the teams list. So there is one query and one cache entry behind all three
// rather than three mechanisms that can disagree.
//
// The counts poll on an interval because a reply can land while the reader sits
// on /dashboard/agents doing nothing. Without it the dot would only appear on a
// reload, which is exactly the moment the reader has stopped needing to be told.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import {
  getAgentChatUnreadCounts,
  markAgentChatThreadRead,
  markAllAgentChatThreadsRead,
  type UnreadCountsResponse,
} from '../services/agentChat'
import { AGENT_CHAT_THREADS_QUERY_KEY } from './useAgentChatThreads'

export const CHAT_UNREAD_QUERY_KEY = ['agent-chat-unread'] as const

/** Unread thread count per team for the signed-in reader, across the tenant. */
export function useChatUnreadCounts() {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...CHAT_UNREAD_QUERY_KEY, tenant?.id],
    queryFn: () => getAgentChatUnreadCounts(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 30_000,
    refetchInterval: 60_000,
    select: (data: UnreadCountsResponse) => data.counts ?? {},
  })
}

/**
 * Mark a thread read.
 *
 * Invalidates both the counts and that team's thread list, so the row dot and
 * both badges clear together. Clearing only one of them is worse than clearing
 * neither: it tells the reader the state is being tracked and then contradicts
 * itself two surfaces later.
 */
export function useMarkThreadRead(agentId: string | null) {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (threadId: string) =>
      markAgentChatThreadRead(tenant!.id, agentId!, threadId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CHAT_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({
        queryKey: [...AGENT_CHAT_THREADS_QUERY_KEY, agentId, tenant?.id],
      })
    },
  })
}

/** Mark every thread with this team read. Invalidates the same two queries as
 *  marking one. */
export function useMarkAllThreadsRead(agentId: string | null) {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: () => markAllAgentChatThreadsRead(tenant!.id, agentId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CHAT_UNREAD_QUERY_KEY })
      queryClient.invalidateQueries({
        queryKey: [...AGENT_CHAT_THREADS_QUERY_KEY, agentId, tenant?.id],
      })
    },
  })
}
