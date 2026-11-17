// Router state on a chat page, and the two very different jobs it does.
//
// Chat surfaces keep thread ids out of the address bar. Everything a chat page
// needs to know that is not in the URL therefore travels in `location.state`,
// which under BrowserRouter is `history.state.usr` — and that survives a reload.
// Two kinds of thing live there, and telling them apart is the whole point of
// this file:
//
//   ONE-SHOT   seedMessage, seedAttachments, openHistory
//              An instruction to do something once on arrival: send this, open
//              that. Replaying it on a refresh would re-send a message or
//              reopen a modal over a live conversation, so it is scrubbed the
//              moment it is consumed.
//
//   IDENTITY   agentId, threadId, threadScope
//              What the person is looking at. Refreshing should land back on
//              exactly this, so it must SURVIVE the scrub.
//
// The scrub used to be `state: null`, which could not tell the two apart and
// threw away both. That cost two things: a refresh lost the open conversation,
// and on AgentChatPage — where `agentId` arrives only as state, with no query
// param — consuming a seed erased the agent id and bounced the person to the
// teams list mid-send.

import type { PendingAttachment } from '../services/internalAgents'

/** Every key a chat page recognises on `location.state`. */
export interface ChatNavState {
  // One-shot.
  seedMessage?: string
  seedAttachments?: PendingAttachment[]
  openHistory?: boolean
  // Identity.
  agentId?: string
  threadId?: string
  threadScope?: string
  // Anything else a caller put there is preserved untouched.
  [key: string]: unknown
}

const ONE_SHOT_KEYS = ['seedMessage', 'seedAttachments', 'openHistory'] as const

/**
 * The identity of the thing a resumed thread has to still belong to.
 *
 * A history entry outlives the app state around it. Someone can switch tenant
 * in another tab — `switchTenant` swaps in place without navigating, and the
 * choice is remembered in localStorage — then reload this one, and the entry
 * would hand back a thread from the tenant they just left. Stamping the entry
 * lets the reload notice.
 */
export function threadScope(tenantId: string | undefined, scopeId: string): string {
  return `${tenantId ?? ''}:${scopeId}`
}

/**
 * Drop the one-shot keys, keep everything else.
 *
 * Returns null when nothing is left, so a page with no identity to remember
 * still ends up with a clean empty entry rather than `{}`.
 */
export function consumeSeed(state: unknown): ChatNavState | null {
  if (!state || typeof state !== 'object') return null
  const next: ChatNavState = { ...(state as ChatNavState) }
  for (const key of ONE_SHOT_KEYS) delete next[key]
  return Object.keys(next).length > 0 ? next : null
}

/**
 * The thread this history entry is holding, or null.
 *
 * An entry with NO stamp is trusted. That is the share-link case: the
 * /share/<id> resolver hands the thread over as state and the backend has
 * already checked who may open it, so a missing stamp means "somebody else
 * vouched for this", not "suspect". Only a stamp that actively disagrees is
 * refused.
 */
export function readResumeThread(state: unknown, scope: string): string | null {
  if (!state || typeof state !== 'object') return null
  const { threadId, threadScope: stamp } = state as ChatNavState
  if (!threadId) return null
  if (stamp !== undefined && stamp !== scope) return null
  return threadId
}

/**
 * The state this entry should carry for `threadId`, or null to clear it.
 *
 * Returns the SAME object reference when nothing would change, which is what
 * lets the caller treat "no change" as "do not navigate" and avoid a render
 * loop.
 */
export function writeResumeThread(
  state: unknown,
  threadId: string | null,
  scope: string,
): ChatNavState | null {
  const current: ChatNavState | null =
    state && typeof state === 'object' ? (state as ChatNavState) : null

  if (threadId === null) {
    if (!current || (current.threadId === undefined && current.threadScope === undefined)) {
      return current
    }
    const next = { ...current }
    delete next.threadId
    delete next.threadScope
    return Object.keys(next).length > 0 ? next : null
  }

  if (current && current.threadId === threadId && current.threadScope === scope) return current
  return { ...(current ?? {}), threadId, threadScope: scope }
}
