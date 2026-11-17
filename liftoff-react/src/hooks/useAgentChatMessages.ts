// Agent Chat Messages Hook

import { useChatMessages } from './useChatMessages'
import { listAgentChatMessages } from '../services/agentChat'

export const AGENT_CHAT_MESSAGES_QUERY_KEY = ['agent-chat-messages'] as const

export function useAgentChatMessages(agentId: string | null, threadId: string | null) {
  return useChatMessages({
    // The agentId sits ahead of the tenant, so each team's transcript is its
    // own cache entry.
    queryKeyPrefix: [...AGENT_CHAT_MESSAGES_QUERY_KEY, agentId],
    threadId,
    listMessages: (tenantId, id, options) =>
      listAgentChatMessages(tenantId, agentId!, id, options),
    enabled: !!agentId,
  })
}
