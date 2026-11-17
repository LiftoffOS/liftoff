// Team Plan Chat Messages Hook

import { useChatMessages } from './useChatMessages'
import { listTeamPlanMessages } from '../services/teamPlanChat'

export const TEAM_PLAN_MESSAGES_QUERY_KEY = ['team-plan-messages'] as const

export function useTeamPlanMessages(threadId: string | null) {
  return useChatMessages({
    queryKeyPrefix: TEAM_PLAN_MESSAGES_QUERY_KEY,
    threadId,
    listMessages: listTeamPlanMessages,
  })
}
