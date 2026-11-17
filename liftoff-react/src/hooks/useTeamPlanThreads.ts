// Team Plan Chat Threads Hook

import { useChatThreads, useCreateChatThread, useDeleteChatThread } from './useChatThreads'
import {
  listTeamPlanThreads,
  createTeamPlanThread,
  deleteTeamPlanThread,
} from '../services/teamPlanChat'

export const TEAM_PLAN_THREADS_QUERY_KEY = ['team-plan-threads'] as const

export function useTeamPlanThreads() {
  return useChatThreads({
    queryKeyPrefix: TEAM_PLAN_THREADS_QUERY_KEY,
    listThreads: listTeamPlanThreads,
  })
}

export function useCreateTeamPlanThread() {
  return useCreateChatThread({
    queryKeyPrefix: TEAM_PLAN_THREADS_QUERY_KEY,
    createThread: createTeamPlanThread,
  })
}

export function useDeleteTeamPlanThread() {
  return useDeleteChatThread({
    queryKeyPrefix: TEAM_PLAN_THREADS_QUERY_KEY,
    deleteThread: deleteTeamPlanThread,
  })
}
