// Insights Chat Threads Hook
//
// Forward infinite-scroll over /api/insights/threads, feeding the Chat History
// modal. Query semantics live in useChatThreads, which every chat surface
// shares.

import { useChatThreads, useCreateChatThread, useDeleteChatThread } from './useChatThreads'
import {
  listInsightsThreads,
  createInsightsThread,
  deleteInsightsThread,
} from '../services/insightsChat'

export const INSIGHTS_THREADS_QUERY_KEY = ['insights-threads'] as const

export function useInsightsThreads() {
  return useChatThreads({
    queryKeyPrefix: INSIGHTS_THREADS_QUERY_KEY,
    listThreads: listInsightsThreads,
  })
}

export function useCreateInsightsThread() {
  return useCreateChatThread({
    queryKeyPrefix: INSIGHTS_THREADS_QUERY_KEY,
    createThread: createInsightsThread,
  })
}

export function useDeleteInsightsThread() {
  return useDeleteChatThread({
    queryKeyPrefix: INSIGHTS_THREADS_QUERY_KEY,
    deleteThread: deleteInsightsThread,
  })
}
