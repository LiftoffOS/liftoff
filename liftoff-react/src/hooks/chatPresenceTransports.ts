// Presence transports, one per chat surface.
//
// Lives in the hooks layer rather than beside the fetchers because a transport
// also names the message-list query to invalidate, and those keys are defined
// by the hooks that own them.

import type { ChatPresenceTransport } from '../services/presence'
import { heartbeatPresence, clearPresence, getTurnEvents } from '../services/presence'
import {
  heartbeatTeamPlanPresence,
  clearTeamPlanPresence,
  getTeamPlanTurnEvents,
} from '../services/teamPlanChat'
import { heartbeatLiftoffPresence, clearLiftoffPresence } from '../services/liftoffChat'
import { heartbeatInsightsPresence, clearInsightsPresence } from '../services/insightsChat'
import { AGENT_CHAT_MESSAGES_QUERY_KEY } from './useAgentChatMessages'
import { TEAM_PLAN_MESSAGES_QUERY_KEY } from './useTeamPlanMessages'
import { LIFTOFF_MESSAGES_QUERY_KEY } from './useLiftoffMessages'
import { INSIGHTS_MESSAGES_QUERY_KEY } from './useInsightsMessages'

/** Agent chat, served by platform-backend under /api/agent-chat/:agentId. */
export function agentChatPresenceTransport(agentId: string): ChatPresenceTransport {
  return {
    key: `agent-chat:${agentId}`,
    heartbeat: (tenantId, threadId, state) =>
      heartbeatPresence(tenantId, agentId, threadId, state),
    clear: (tenantId, threadId) => clearPresence(tenantId, agentId, threadId),
    turnEvents: (tenantId, threadId, turnId, after) =>
      getTurnEvents(tenantId, agentId, threadId, turnId, after),
    messagesQueryKey: (tenantId, threadId) =>
      [...AGENT_CHAT_MESSAGES_QUERY_KEY, agentId, tenantId, threadId],
  }
}

/** The Chief AI Officer chat, served by workforce-service under /api/team-plan.
 *  Constant because there is one CAIO per workspace, not one per agent id. */
export const teamPlanPresenceTransport: ChatPresenceTransport = {
  key: 'team-plan',
  heartbeat: heartbeatTeamPlanPresence,
  clear: clearTeamPlanPresence,
  turnEvents: getTeamPlanTurnEvents,
  messagesQueryKey: (tenantId, threadId) =>
    [...TEAM_PLAN_MESSAGES_QUERY_KEY, tenantId, threadId],
}

// The two below deliberately declare no `turnEvents`. Neither router records
// per-turn execution events, so there is no cursor to follow and nothing to
// replay; what a non-sender gets instead is the heartbeat's `latestMessageAt`,
// which moves when the reply lands and refetches the transcript. Omitting the
// method is what tells `useObservedTurn` to stand down.

/** Liftoff, served by platform-backend under /api/liftoff. Constant because
 *  there is one Liftoff per workspace, not one per agent id. */
export const liftoffPresenceTransport: ChatPresenceTransport = {
  key: 'liftoff',
  heartbeat: heartbeatLiftoffPresence,
  clear: clearLiftoffPresence,
  messagesQueryKey: (tenantId, threadId) =>
    [...LIFTOFF_MESSAGES_QUERY_KEY, tenantId, threadId],
}

/** The Insights Manager, served by platform-backend under /api/insights. */
export const insightsPresenceTransport: ChatPresenceTransport = {
  key: 'insights',
  heartbeat: heartbeatInsightsPresence,
  clear: clearInsightsPresence,
  messagesQueryKey: (tenantId, threadId) =>
    [...INSIGHTS_MESSAGES_QUERY_KEY, tenantId, threadId],
}
