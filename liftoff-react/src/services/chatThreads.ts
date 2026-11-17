// Chat History across every surface.
//
// GET /api/chat-threads merges the four chat surfaces (every agent's own
// chat, the Chief AI Officer, the Insights Manager and Liftoff) newest first
// behind one cursor. It backs the "All" view of the Chat History modal, where
// picking a thread routes to the surface it lives on, so every thread carries
// its kind, and the team behind it on the team kind.

import { api } from './api'
import type { ChatThreadKind } from './agentChat'
import type { ChatCursorOptions, PaginatedChatThreads } from './chatSurface'

export interface CrossSurfaceThread {
  id: string
  kind: ChatThreadKind
  title: string | null
  updatedAt: string
  unread: boolean
  /** The agent behind a thread of kind 'agent'. Null on the three platform
   *  assistants, which have no team behind them. */
  agent: { id: string; name: string } | null
}

export async function listAllChatThreads(
  tenantId: string,
  options?: ChatCursorOptions,
): Promise<PaginatedChatThreads<CrossSurfaceThread>> {
  const params = new URLSearchParams({ tenantId })
  if (options?.cursor) params.set('cursor', options.cursor)
  if (options?.limit) params.set('limit', String(options.limit))
  const response = await api.get<PaginatedChatThreads<CrossSurfaceThread>>(
    `/api/chat-threads?${params.toString()}`,
  )
  return {
    ...response,
    threads: (response.threads ?? []).map(t => ({
      ...t,
      unread: t.unread === true,
      agent: t.agent ?? null,
    })),
  }
}
