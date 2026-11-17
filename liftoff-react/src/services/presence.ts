// Chat thread presence.
//
// One call per poll: it records that you are on the thread and returns
// everyone who is, so a viewer costs one request per interval instead of two
// and can never read a roster that does not yet contain themselves.

import { api } from './api'

export type PresenceState = 'viewing' | 'typing'

/** Shape matches AvatarPerson so UserAvatar consumes it directly. */
export interface ThreadPresenceEntry {
  accountId: string
  firstName: string | null
  lastName: string | null
  email: string
  avatarUrl: string | null
  typing: boolean
}

export interface ThreadPresence {
  viewers: ThreadPresenceEntry[]
  /** A turn running right now. Non-null means a reply is being generated. It is
   *  a cursor only on the surfaces that record per-turn execution events; on
   *  Liftoff and the Insights Manager it is an indicator and nothing more, so
   *  what a non-sender there gets is `latestMessageAt` when the reply lands. */
  liveTurnId?: string | null
  /** Newest message in the thread. Lets a viewer notice somebody else's
   *  message landed without the message list needing its own poll. */
  latestMessageAt: string | null
}

export async function heartbeatPresence(
  tenantId: string,
  agentId: string,
  threadId: string,
  state: PresenceState,
): Promise<ThreadPresence> {
  return await api.post<ThreadPresence>(
    `/api/agent-chat/${agentId}/threads/${threadId}/presence`,
    { tenantId, state },
  )
}

export async function clearPresence(
  tenantId: string,
  agentId: string,
  threadId: string,
): Promise<void> {
  await api.delete(
    `/api/agent-chat/${agentId}/threads/${threadId}/presence?tenantId=${tenantId}`,
  )
}

export type TurnEventKind =
  | 'text' | 'thinking' | 'tool_call' | 'tool_result'
  | 'awaiting_input' | 'hitl_required' | 'delegation_started' | 'error' | 'done'

export interface TurnEvent {
  seq: number
  kind: TurnEventKind
  payload: Record<string, unknown> | null
}

export interface TurnEventsResponse {
  turnId: string
  events: TurnEvent[]
  done: boolean
}

/**
 * Execution events for a turn somebody else is running, after a cursor.
 * The sender never calls this — they hold the SSE stream.
 */
export async function getTurnEvents(
  tenantId: string,
  agentId: string,
  threadId: string,
  turnId: string,
  after: number,
): Promise<TurnEventsResponse> {
  const params = new URLSearchParams({ tenantId, turnId, after: String(after) })
  return await api.get<TurnEventsResponse>(
    `/api/agent-chat/${agentId}/threads/${threadId}/turn-events?${params.toString()}`,
  )
}

// ── Transport ──────────────────────────────────────────────────────────────
//
// Presence works the same way on every chat surface, but they live behind
// different services: agent chat under /api/agent-chat here, the CAIO under
// /api/team-plan in workforce-service, Liftoff and the Insights Manager under
// their own routers. The response shapes are identical by design, so the hooks
// take one of these instead of building an /api/agent-chat URL themselves, and
// no surface needs its own copy of the polling, typing-decay and follow logic.

export interface ChatPresenceTransport {
  /** Distinguishes surfaces in the react-query cache key. */
  readonly key: string
  heartbeat(tenantId: string, threadId: string, state: PresenceState): Promise<ThreadPresence>
  clear(tenantId: string, threadId: string): Promise<void>
  /**
   * Replay of a turn somebody else is running. Optional because it is a real
   * capability, not a formality: only agent chat and the Chief AI Officer chat
   * record per-turn execution events, so only they can serve a cursor. Liftoff
   * and the Insights Manager omit it, and `useObservedTurn` stands down rather
   * than following a turn that has nothing to read.
   *
   * A stub resolving empty-and-done was the alternative and is worse: it would
   * satisfy the type while leaving the follower enabled, which draws an empty
   * streaming bubble for as long as the other person's turn runs and refetches
   * the message list before the reply exists. Absent says the true thing.
   */
  turnEvents?(
    tenantId: string,
    threadId: string,
    turnId: string,
    after: number,
  ): Promise<TurnEventsResponse>
  /** The message-list query to invalidate when a turn lands. */
  messagesQueryKey(tenantId: string, threadId: string): readonly unknown[]
}

/**
 * The heartbeat/clear pair for a surface whose router carries no agent id:
 * Liftoff and the Insights Manager. Both serve the agent-chat contract verbatim
 * under their own base path, so the wire format is written once here rather
 * than copied into each service module.
 */
export function createChatPresenceFetchers(basePath: string): {
  heartbeat: (tenantId: string, threadId: string, state: PresenceState) => Promise<ThreadPresence>
  clear: (tenantId: string, threadId: string) => Promise<void>
} {
  return {
    heartbeat: async (tenantId, threadId, state) =>
      await api.post<ThreadPresence>(`${basePath}/threads/${threadId}/presence`, {
        tenantId,
        state,
      }),
    clear: async (tenantId, threadId) => {
      await api.delete<void>(
        `${basePath}/threads/${threadId}/presence?tenantId=${encodeURIComponent(tenantId)}`,
      )
    },
  }
}
