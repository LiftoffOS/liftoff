/** Seed state passed via router.state when routing to a destination chat page
 *  from the HomePage router. The receiving page consumes it once on mount,
 *  sends the message, and scrubs the state so back/refresh never replays.
 *
 *  "Scrubs the state" means the seed keys ONLY. The same entry also carries
 *  identity — which team this is, which conversation is open — and that has to
 *  survive being handed a message. See `consumeSeed` in lib/chatNavState.ts,
 *  which is what every receiving page scrubs with. */

import type { PendingAttachment } from '../services/internalAgents'

export interface ChatSeedState {
  seedMessage: string
  seedAttachments?: PendingAttachment[]
  /** Present only when routing to a custom team — the receiving page needs to
   *  know which agent to send to. Mirrors the shape AgentChatPage's existing
   *  nav-state reader already expects. */
  agentId?: string
}

/** Router state for arriving at a chat page with its history already open,
 *  rather than with a message to send. Carried separately from ChatSeedState
 *  because it is the other reason to navigate to a chat: resuming something,
 *  not starting it. Consumed once and scrubbed, same as a seed. */
export interface ChatHistoryState {
  openHistory?: boolean
}
