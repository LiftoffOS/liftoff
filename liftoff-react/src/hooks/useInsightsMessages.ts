// Insights Chat Messages Hook
//
// Reverse infinite-scroll over /api/insights/threads/:id/messages. Query
// semantics, including what "next page" means for a transcript, live in
// useChatMessages, which every chat surface shares.

import { useChatMessages, useSendChatUserMessage } from './useChatMessages'
import { INSIGHTS_THREADS_QUERY_KEY } from './useInsightsThreads'
import { listInsightsMessages, sendInsightsUserMessage } from '../services/insightsChat'

export const INSIGHTS_MESSAGES_QUERY_KEY = ['insights-messages'] as const

export function useInsightsMessages(threadId: string | null) {
  return useChatMessages({
    queryKeyPrefix: INSIGHTS_MESSAGES_QUERY_KEY,
    threadId,
    listMessages: listInsightsMessages,
  })
}

export function useSendInsightsUserMessage() {
  return useSendChatUserMessage({
    messagesQueryKeyPrefix: INSIGHTS_MESSAGES_QUERY_KEY,
    threadsQueryKeyPrefix: INSIGHTS_THREADS_QUERY_KEY,
    sendUserMessage: sendInsightsUserMessage,
  })
}
