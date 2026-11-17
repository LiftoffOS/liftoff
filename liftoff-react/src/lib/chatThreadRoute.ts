// Where a chat thread opens, by the surface it lives on.
//
// Shared by the /share/<id> resolver and the "All" view of the Chat History
// modal, the two places that open a thread without already being on its page.
// Thread and team ids travel as router state, never in the address bar: every
// destination page reads them from there.

import type { ChatThreadKind } from '../services/agentChat'

/** The platform assistants by their names, for the surfaces with no team
 *  behind them. */
export const PLATFORM_ASSISTANT_NAMES: Record<Exclude<ChatThreadKind, 'agent'>, string> = {
  liftoff: 'Liftoff',
  team_plan: 'Chief AI Officer',
  insights: 'Insights Manager',
}

export type ChatThreadTarget =
  | { kind: 'agent'; threadId: string; agentId: string }
  | { kind: Exclude<ChatThreadKind, 'agent'>; threadId: string }

export function chatThreadRoute(target: ChatThreadTarget): {
  pathname: string
  state: { threadId: string; agentId?: string }
} {
  switch (target.kind) {
    case 'team_plan':
      return { pathname: '/dashboard/agents/plan', state: { threadId: target.threadId } }
    case 'insights':
      return { pathname: '/dashboard/insights', state: { threadId: target.threadId } }
    case 'liftoff':
      return { pathname: '/dashboard/liftoff', state: { threadId: target.threadId } }
    case 'agent':
      return {
        pathname: '/dashboard/agents/chat',
        state: { agentId: target.agentId, threadId: target.threadId },
      }
  }
}
