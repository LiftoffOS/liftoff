// Agent Chat Threads Hook

import { useChatThreads, useCreateChatThread, useDeleteChatThread } from './useChatThreads'
import {
  listAgentChatThreads,
  createAgentChatThread,
  deleteAgentChatThread,
} from '../services/agentChat'

export const AGENT_CHAT_THREADS_QUERY_KEY = ['agent-chat-threads'] as const

/** The agentId sits in the key prefix, ahead of the tenant, so each team's
 *  thread list is its own cache entry. */
function queryKeyPrefix(agentId: string | null): readonly unknown[] {
  return [...AGENT_CHAT_THREADS_QUERY_KEY, agentId]
}

export function useAgentChatThreads(agentId: string | null) {
  return useChatThreads({
    queryKeyPrefix: queryKeyPrefix(agentId),
    listThreads: (tenantId, options) => listAgentChatThreads(tenantId, agentId!, options),
    enabled: !!agentId,
  })
}

export function useCreateAgentChatThread(agentId: string | null) {
  return useCreateChatThread({
    queryKeyPrefix: queryKeyPrefix(agentId),
    createThread: (tenantId, title) => createAgentChatThread(tenantId, agentId!, title),
  })
}

export function useDeleteAgentChatThread(agentId: string | null) {
  return useDeleteChatThread({
    queryKeyPrefix: queryKeyPrefix(agentId),
    deleteThread: (tenantId, threadId) =>
      deleteAgentChatThread(tenantId, agentId!, threadId),
  })
}
