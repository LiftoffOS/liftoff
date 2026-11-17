// Liftoff Chat Threads Hook
//
// Forward infinite-scroll over /api/liftoff/threads, feeding the Chat History
// modal. Query semantics live in useChatThreads, which every chat surface
// shares.

import { useChatThreads, useCreateChatThread, useDeleteChatThread } from './useChatThreads'
import {
  listLiftoffThreads,
  createLiftoffThread,
  deleteLiftoffThread,
} from '../services/liftoffChat'

export const LIFTOFF_THREADS_QUERY_KEY = ['threads'] as const

export function useLiftoffThreads() {
  return useChatThreads({
    queryKeyPrefix: LIFTOFF_THREADS_QUERY_KEY,
    listThreads: listLiftoffThreads,
  })
}

export function useCreateLiftoffThread() {
  return useCreateChatThread({
    queryKeyPrefix: LIFTOFF_THREADS_QUERY_KEY,
    createThread: createLiftoffThread,
  })
}

export function useDeleteLiftoffThread() {
  return useDeleteChatThread({
    queryKeyPrefix: LIFTOFF_THREADS_QUERY_KEY,
    deleteThread: deleteLiftoffThread,
  })
}
