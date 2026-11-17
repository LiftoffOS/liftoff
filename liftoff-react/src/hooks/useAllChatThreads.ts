// All Chat Threads Hook
//
// Forward infinite-scroll over /api/chat-threads, feeding the "All" view of the
// Chat History modal. Query semantics live in useChatThreads, which every chat
// surface shares.

import { useChatThreads } from './useChatThreads'
import { listAllChatThreads } from '../services/chatThreads'

export const ALL_CHAT_THREADS_QUERY_KEY = ['all-chat-threads'] as const

/** Gated by `enabled`: the modal opens on the current chat's own history, and
 *  only a switch to "All" should cost the cross-surface request.
 *
 *  Never fresh: reading a chat on its own page updates that surface's list,
 *  not this one, so every switch to "All" refetches behind the cached rows
 *  rather than showing unread dots that were cleared elsewhere. */
export function useAllChatThreads(enabled: boolean) {
  return useChatThreads({
    queryKeyPrefix: ALL_CHAT_THREADS_QUERY_KEY,
    listThreads: listAllChatThreads,
    enabled,
    staleTime: 0,
  })
}
