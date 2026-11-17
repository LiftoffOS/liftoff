// Liftoff Chat Messages Hook
//
// Reverse infinite-scroll over /api/liftoff/threads/:id/messages. Query
// semantics, including what "next page" means for a transcript, live in
// useChatMessages, which every chat surface shares.

import { useChatMessages, useSendChatUserMessage } from './useChatMessages'
import { LIFTOFF_THREADS_QUERY_KEY } from './useLiftoffThreads'
import { listLiftoffMessages, sendLiftoffUserMessage } from '../services/liftoffChat'

export const LIFTOFF_MESSAGES_QUERY_KEY = ['messages'] as const

export function useLiftoffMessages(threadId: string | null) {
  return useChatMessages({
    queryKeyPrefix: LIFTOFF_MESSAGES_QUERY_KEY,
    threadId,
    listMessages: listLiftoffMessages,
  })
}

export function useSendLiftoffUserMessage() {
  return useSendChatUserMessage({
    messagesQueryKeyPrefix: LIFTOFF_MESSAGES_QUERY_KEY,
    threadsQueryKeyPrefix: LIFTOFF_THREADS_QUERY_KEY,
    sendUserMessage: sendLiftoffUserMessage,
  })
}
