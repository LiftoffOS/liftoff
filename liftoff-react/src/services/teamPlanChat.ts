// Team Plan Chat API Client
//
// Typed wrappers around the /api/team-plan/threads CRUD endpoints.
// Modeled after services/insightsChat.ts — same streaming pattern,
// same thread/message structure.

import { api } from './api'
import type { ChatStreamError } from './chatSse'
import {
  createChatSurfaceClient,
  parseDelegationPaused,
  parseDelegationStarted,
  type ChatCursorOptions,
  type ChatDelegationCallbacks,
  type ChatDelegationPauseCallbacks,
  type PaginatedChatMessages,
  type PaginatedChatThreads,
} from './chatSurface'
import type { VisualizationBlock } from '../types/insights'
import type { PresenceState, ThreadPresence, TurnEventsResponse } from './presence'
import type { PendingAttachment } from './internalAgents'
import type { MediaRef } from '../types/media'
import type { FileAttachment } from '../components/Chat/ChatMessages'
import type { Contributor } from '../types/contributors'
import type { ChatMessageAttachment } from '../types/chatAttachments'

export { CAIO_AGENT_ID } from '../constants/agents'

// ── Types ───────────────────────────────────────────────────────────────

export interface TeamPlanChatThread {
  id: string
  tenantId: string
  accountId: string
  title: string | null
  /** The Chief AI Officer has replied since this reader last opened the
   *  thread. Absent on an older backend, which reads as false and renders no
   *  indicator. */
  unread: boolean
  createdAt: string
  updatedAt: string
}

export type TeamPlanMessageRole = 'user' | 'assistant'

export interface TeamPlanChatMessage {
  id: string
  threadId: string
  role: TeamPlanMessageRole
  content: string
  /** Diagrams the CAIO emitted with this message, parsed out of the reply text
   *  server-side. Today that means org_chart when it proposes a structure. */
  visualizationBlocks: VisualizationBlock[] | null
  /** What the person attached when they sent this message. Metadata only: an
   *  upload's extracted text is a one-turn model input, not transcript. Always
   *  a list, so no caller has to invent the empty case. */
  attachments: ChatMessageAttachment[]
  inputTokens: number
  outputTokens: number
  /** What kind of row this is, when it is not ordinary speech. Null for
   *  everything a person or the Chief AI Officer said. `forwarded_context` is
   *  background Liftoff passed on when it brought the CAIO into one of its
   *  conversations: a report about the thread, not a turn in it. */
  messageType: string | null
  /** Images, video or audio the team produced for this message. Its own field,
   *  never folded into `attachments`: that name means the opposite thing on
   *  different surfaces. Rendered by ChatMessages itself, so passing it through
   *  here is the whole of what this surface has to do.
   *
   *  The CAIO still has no media PRODUCER, but a person can now attach a
   *  picture to what they send it, so this carries the sent media back on
   *  reload and the renderer draws it in the sender's own bubble. */
  media?: MediaRef[]
  /** File cards shown into this message. Same field name and shape as every
   *  other surface, so one renderer draws them. */
  files?: FileAttachment[]
  /** Colleagues other than the Chief AI Officer who had a hand in the reply, each
   *  named as the person saw it. Same shape as every other surface's message,
   *  so one renderer draws the chips. Empty when nobody else contributed.
   *  Optional because a message from an older backend carries none. */
  contributors?: Contributor[]
  createdAt: string
}

export type PaginatedTeamPlanThreadsResponse = PaginatedChatThreads<TeamPlanChatThread>

export type PaginatedTeamPlanMessagesResponse = PaginatedChatMessages<TeamPlanChatMessage>

// ── Client ──────────────────────────────────────────────────────────────

const client = createChatSurfaceClient<
  TeamPlanChatThread,
  TeamPlanChatMessage,
  StreamTeamPlanChatInput,
  StreamTeamPlanChatCallbacks,
  { thread: TeamPlanChatThread; messages: TeamPlanChatMessage[] }
>({
  basePath: '/api/team-plan',
  dispatchEvent: dispatchSseEvent,
  buildStreamBody: greetingSafeBody,
})

// ── Thread CRUD ─────────────────────────────────────────────────────────

/**
 * `unread` is declared required on TeamPlanChatThread, so the boundary is
 * where it becomes true. A backend that predates the field sends nothing, and
 * coercing here means one place decides what absent means instead of every
 * consumer remembering to treat undefined as false. Same rule as agent chat.
 */
function normalizeThread(thread: TeamPlanChatThread): TeamPlanChatThread {
  return { ...thread, unread: thread.unread === true }
}

export async function listTeamPlanThreads(
  tenantId: string,
  options?: ChatCursorOptions,
): Promise<PaginatedTeamPlanThreadsResponse> {
  const response = await client.listThreads(tenantId, options)
  return { ...response, threads: (response.threads ?? []).map(normalizeThread) }
}

// ── Unread state ────────────────────────────────────────────────────────
//
// Served by workforce-service through the /api/team-plan proxy. The proxy
// derives its trusted headers from the request's own tenantId, so the GET
// carries it as a query param and the POST in the body, exactly like every
// other route on this surface.

/**
 * Record that this reader has now seen everything in a thread. The marker is
 * per person, so the server takes the account from the authenticated caller
 * and never from the body.
 */
export async function markTeamPlanThreadRead(
  tenantId: string,
  threadId: string,
): Promise<void> {
  await api.post<void>(`/api/team-plan/threads/${threadId}/read`, { tenantId })
}

/** Mark every thread with an unread reply read for this reader, in one call.
 *  Backs the history modal's "Mark All Read". */
export async function markAllTeamPlanThreadsRead(tenantId: string): Promise<void> {
  await api.post<void>('/api/team-plan/threads/read-all', { tenantId })
}

/** How many threads carry an unread Chief AI Officer reply for this reader,
 *  under the same visibility rule as the thread list. */
export interface TeamPlanUnreadCountResponse {
  count: number
}

export async function getTeamPlanUnreadCount(
  tenantId: string,
): Promise<TeamPlanUnreadCountResponse> {
  return await api.get<TeamPlanUnreadCountResponse>(
    `/api/team-plan/threads/unread-count?tenantId=${encodeURIComponent(tenantId)}`,
  )
}

export const createTeamPlanThread = client.createThread

export const deleteTeamPlanThread = client.deleteThread

// ── Message CRUD ────────────────────────────────────────────────────────

export const listTeamPlanMessages = client.listMessages

// ── Presence ────────────────────────────────────────────────────────────
//
// Same contract as the agent-chat endpoints, served by workforce-service
// through platform-backend's /api/team-plan proxy. See services/presence.ts
// for why the two surfaces share one shape.

export async function heartbeatTeamPlanPresence(
  tenantId: string,
  threadId: string,
  state: PresenceState,
): Promise<ThreadPresence> {
  return await api.post<ThreadPresence>(
    `/api/team-plan/threads/${threadId}/presence?tenantId=${encodeURIComponent(tenantId)}`,
    { tenantId, state },
  )
}

export async function clearTeamPlanPresence(
  tenantId: string,
  threadId: string,
): Promise<void> {
  await api.delete<void>(
    `/api/team-plan/threads/${threadId}/presence?tenantId=${encodeURIComponent(tenantId)}`,
  )
}

/**
 * Ask the turn running on this thread to stop.
 *
 * `deliveredAs: 'noop'` means there was nothing running — the turn had already
 * finished, or the click raced its own reply. Same contract as
 * `stopAgentChatTurn`, so both chat surfaces are handled identically.
 *
 * Hand-written rather than the shared client's `stopTurn`: this route carries
 * the tenant in the query string as well as the body, which the proxy in front
 * of workforce-service reads.
 */
export async function stopTeamPlanChatTurn(input: {
  tenantId: string
  threadId: string
}): Promise<{ acknowledged: boolean; deliveredAs: 'abort' | 'noop' }> {
  return await api.post<{ acknowledged: boolean; deliveredAs: 'abort' | 'noop' }>(
    `/api/team-plan/threads/${input.threadId}/stop?tenantId=${encodeURIComponent(input.tenantId)}`,
    { tenantId: input.tenantId },
  )
}

export async function getTeamPlanTurnEvents(
  tenantId: string,
  threadId: string,
  turnId: string,
  after: number,
): Promise<TurnEventsResponse> {
  const params = new URLSearchParams({ tenantId, turnId, after: String(after) })
  return await api.get<TurnEventsResponse>(
    `/api/team-plan/threads/${threadId}/turn-events?${params.toString()}`,
  )
}

// ── Chat streaming ──────────────────────────────────────────────────────

export interface StreamTeamPlanChatInput {
  tenantId: string
  // Optional: absent for the greeting, which is asked for before any thread
  // exists and creates none. The first message the person sends is what opens
  // the conversation.
  threadId?: string
  // Optional: when absent, the backend enters greeting mode -- reads the
  // workspace (connectors, existing agents) and streams a contextual
  // greeting with no user message.
  content?: string
  /** Files and connector references staged in the composer. The Chief AI
   *  Officer reads what you give it: /team-plan/chat-stream accepts this,
   *  injects the upload bodies into the turn and persists the metadata, exactly
   *  as Liftoff does. */
  attachments?: PendingAttachment[]
  /** The person handed the browser back, ending this hold: beside `content`
   *  (a send while they were driving) or instead of it. The backend verifies
   *  the hold against the runtime's record; a claim it will not honour is a
   *  409 the page treats as quiet. */
  browserHandback?: { holdId: string }
}

export type StreamTeamPlanChatError = ChatStreamError

export interface StreamTeamPlanChatCallbacks extends ChatDelegationCallbacks, ChatDelegationPauseCallbacks {
  onThinking?: () => void
  /** `label` is the phrase platform-backend authored for this tool, and the only
   *  thing a person should read. This surface streams from workforce-service
   *  through a transparent proxy, so it usually arrives without one and the
   *  fallback in activityLabel.ts answers instead. */
  onToolCall?: (tool: string, label?: string) => void
  onTextDelta?: (text: string) => void
  onContentBlock?: (block: VisualizationBlock) => void
  /** Terminal success. The message is null when the turn was stopped before
   *  it said anything: nothing was persisted, so there is nothing to hand
   *  over. */
  onComplete?: (message: TeamPlanChatMessage | null) => void
  onError?: (err: StreamTeamPlanChatError) => void
  /** The message was folded into the turn already running on this thread
   *  rather than starting a new one. The reply arrives on the stream that is
   *  still open, so this response carries nothing else. */
  onInterruptDelivered?: () => void
}

/** Build the request body field by field rather than passing the input
 *  through, so a field that is absent is absent on the wire. Both optional
 *  fields are read as missing by the backend's Zod schema — content triggers
 *  greeting mode, threadId decides whether anything is persisted — and
 *  `{ threadId: undefined }` serialises to a key the schema would reject. */
function greetingSafeBody(input: StreamTeamPlanChatInput): unknown {
  return {
    tenantId: input.tenantId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.content ? { content: input.content, attachments: input.attachments } : {}),
    ...(input.browserHandback ? { browserHandback: input.browserHandback } : {}),
  }
}

export const streamTeamPlanChatMessage = client.streamMessage

/** Exported for the dispatch tests, as Liftoff's is: the routing of each
 *  frame is the contract the page relies on. */
export function dispatchSseEvent(
  event: string,
  data: Record<string, unknown>,
  cb: StreamTeamPlanChatCallbacks,
): void {
  switch (event) {
    case 'thinking':
      cb.onThinking?.()
      return
    case 'tool_call':
      if (typeof data.tool === 'string') {
        cb.onToolCall?.(data.tool, typeof data.label === 'string' ? data.label : undefined)
      }
      return
    case 'text_delta':
      if (typeof data.text === 'string') cb.onTextDelta?.(data.text)
      return
    case 'content_block':
      if (data.block && typeof data.block === 'object') {
        cb.onContentBlock?.(data.block as VisualizationBlock)
      }
      return
    case 'delegation_started': {
      // The Chief AI Officer handed the turn to a colleague: the live reply is
      // attributed the way every other surface attributes one.
      const contributor = parseDelegationStarted(data)
      if (contributor) cb.onDelegationStarted?.(contributor)
      return
    }
    case 'delegation_paused':
      // Terminal and not a failure: the colleague stopped to wait on a person.
      cb.onDelegationPaused?.(parseDelegationPaused(data))
      return
    case 'complete':
      // A turn stopped before it said anything completes with no message —
      // there is no reply to persist and none is invented. Still terminal:
      // the handler has to fire either way, or the composer streams forever.
      cb.onComplete?.(
        data.message && typeof data.message === 'object'
          ? (data.message as TeamPlanChatMessage)
          : null,
      )
      return
    case 'interrupt_delivered':
      cb.onInterruptDelivered?.()
      return
    case 'error':
      cb.onError?.({
        code: (data.code as string) || 'UNKNOWN',
        message: (data.message as string) || 'Unknown error',
      })
      return
  }
}
