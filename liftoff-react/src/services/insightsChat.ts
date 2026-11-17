// Insights Chat API Client
//
// Typed wrappers around the /api/insights/threads CRUD endpoints from
// liftoff-platform-backend Phase 3 commit #2 (router.ts). Used by the
// useInsightsThreads / useInsightsMessages hooks below.

import type { ChatStreamError } from './chatSse'
import { api } from './api'
import type { ChatThreadContinuation } from './liftoffChat'
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
import { createChatPresenceFetchers } from './presence'
import type { VisualizationBlock } from '../types/insights'
import type { PendingAttachment } from './internalAgents'
import type { MediaRef } from '../types/media'
import type { FileAttachment } from '../components/Chat/ChatMessages'
import type { Contributor } from '../types/contributors'
import type { ChatMessageAttachment } from '../types/chatAttachments'

// ── Types ───────────────────────────────────────────────────────────────

export interface InsightsChatThread {
  id: string
  tenantId: string
  accountId: string
  title: string | null
  /** The Insights Manager has replied since this reader last opened the
   *  thread. Absent on an older backend, which reads as false and renders no
   *  indicator. */
  unread: boolean
  createdAt: string
  updatedAt: string
}

export type InsightsMessageRole = 'user' | 'assistant'

export interface InsightsChatMessage {
  id: string
  threadId: string
  role: InsightsMessageRole
  content: string
  visualizationBlocks: VisualizationBlock[] | null
  /** What the person attached when they sent this message. Metadata only: an
   *  upload's extracted text is a one-turn model input, not transcript. Always
   *  a list, so no caller has to invent the empty case. */
  attachments: ChatMessageAttachment[]
  inputTokens: number
  outputTokens: number
  /** What kind of row this is, when it is not ordinary speech. Null for
   *  everything a person or the team said. `forwarded_context` is background
   *  Liftoff passed on when it brought this colleague into one of its
   *  conversations: a report about the thread, not a turn in it. */
  messageType: string | null
  /** Images, video or audio the team produced for this message. Its own field,
   *  never folded into `attachments`: that name means the opposite thing on
   *  different surfaces. Rendered by ChatMessages itself, so passing it through
   *  here is the whole of what this surface has to do. */
  media?: MediaRef[]
  /** File cards shown into this message. Same field name and shape as every
   *  other surface, so one renderer draws them. */
  files?: FileAttachment[]
  /** Colleagues other than the Insights Manager who had a hand in the reply, each
   *  named as the person saw it. Same shape as every other surface's message,
   *  so one renderer draws the chips. Empty when nobody else contributed.
   *  Optional because a message from an older backend carries none. */
  contributors?: Contributor[]
  createdAt: string
}

export type PaginatedThreadsResponse = PaginatedChatThreads<InsightsChatThread>

export type PaginatedMessagesResponse = PaginatedChatMessages<InsightsChatMessage>

// ── Client ──────────────────────────────────────────────────────────────

const BASE_PATH = '/api/insights'

const client = createChatSurfaceClient<
  InsightsChatThread,
  InsightsChatMessage,
  StreamInsightsChatInput,
  StreamInsightsChatCallbacks
>({
  basePath: BASE_PATH,
  dispatchEvent: dispatchSseEvent,
})

// ── Thread CRUD ─────────────────────────────────────────────────────────

/**
 * `unread` is declared required on InsightsChatThread, so the boundary is
 * where it becomes true. A backend that predates the field sends nothing, and
 * coercing here means one place decides what absent means instead of every
 * consumer remembering to treat undefined as false. Same rule as agent chat.
 */
function normalizeThread(thread: InsightsChatThread): InsightsChatThread {
  return { ...thread, unread: thread.unread === true }
}

/**
 * List threads visible to the caller. Backend enforces the permission
 * matrix (owner/admin see all tenant threads, member/viewer see own).
 * Forward cursor pagination, default 20 per page.
 */
export async function listInsightsThreads(
  tenantId: string,
  options?: ChatCursorOptions,
): Promise<PaginatedThreadsResponse> {
  const response = await client.listThreads(tenantId, options)
  return { ...response, threads: (response.threads ?? []).map(normalizeThread) }
}

// ── Unread state ────────────────────────────────────────────────────────

/**
 * Record that this reader has now seen everything in a thread. The marker is
 * per person, so the server takes the account from the authenticated caller
 * and never from the body.
 */
export async function markInsightsThreadRead(
  tenantId: string,
  threadId: string,
): Promise<void> {
  await api.post<void>(`${BASE_PATH}/threads/${threadId}/read`, { tenantId })
}

/** Mark every thread with an unread reply read for this reader, in one call.
 *  Backs the history modal's "Mark All Read". */
export async function markAllInsightsThreadsRead(tenantId: string): Promise<void> {
  await api.post<void>(`${BASE_PATH}/threads/read-all`, { tenantId })
}

/** How many threads carry an unread Insights Manager reply for this reader.
 *  One number rather than a per-thread map: the surface is a single
 *  assistant, so the only question any indicator asks is "is there anything
 *  to come back to". */
export interface InsightsUnreadCountResponse {
  count: number
}

export async function getInsightsUnreadCount(
  tenantId: string,
): Promise<InsightsUnreadCountResponse> {
  return await api.get<InsightsUnreadCountResponse>(
    `${BASE_PATH}/threads/unread-count?tenantId=${encodeURIComponent(tenantId)}`,
  )
}

/**
 * Create a new thread. Title is optional — auto-generated from the first
 * user message in Phase 6 (frontend computes the title in commit #5 by
 * truncating the first message at a word boundary, then PATCHes the thread).
 */
export const createInsightsThread = client.createThread

/**
 * Soft-delete a thread. Returns 204 on success, 404 if the thread is not
 * visible to the caller (no existence leak).
 */
export const deleteInsightsThread = client.deleteThread

// ── Message CRUD ────────────────────────────────────────────────────────

/**
 * List messages in a thread, newest first. Reverse cursor pagination so
 * scroll-to-top loads older messages.
 */
export const listInsightsMessages = client.listMessages

/**
 * Append a USER message to a thread via the direct POST endpoint.
 *
 * NOTE: In Phase 6 this is mostly superseded by `streamInsightsChatMessage`
 * below, which persists both the user message and the assistant reply
 * server-side as part of the streaming turn. This function is kept for
 * tests, optimistic drafts, and any callers that don't want to start an
 * SSE stream.
 */
export const sendInsightsUserMessage = client.sendUserMessage

// ── Work that goes on after a reply ─────────────────────────────────────

/**
 * Whether work is queued to continue an earlier turn on this conversation.
 * See ChatThreadContinuation on the Liftoff client: one shape, two routers.
 */
export async function getInsightsThreadContinuation(
  tenantId: string,
  threadId: string,
): Promise<ChatThreadContinuation | null> {
  const res = await api.get<{ continuation?: ChatThreadContinuation | null }>(
    `${BASE_PATH}/threads/${threadId}?tenantId=${encodeURIComponent(tenantId)}`,
  )
  return res.continuation ?? null
}

// ── Presence ────────────────────────────────────────────────────────────
//
// Byte-identical to the agent-chat contract, served by /api/insights' own
// router. See services/presence.ts for why every surface shares one shape.
//
// There is no turn-events counterpart: this surface records no per-turn
// execution events, so a non-sender learns a reply landed from the heartbeat's
// `latestMessageAt` rather than by following the turn.

const presence = createChatPresenceFetchers(BASE_PATH)

/** Record that this account is on the thread, and read back who else is. */
export const heartbeatInsightsPresence = presence.heartbeat

/** Release the seat on the way out. Best effort: the server ages rows out. */
export const clearInsightsPresence = presence.clear

// ── Chat streaming (Phase 6) ────────────────────────────────────────────

export interface StreamInsightsChatInput {
  tenantId: string
  threadId: string
  content?: string
  /** Files and connector references staged in the composer. The Insights
   *  Manager reads what you give it: /api/insights/chat-stream accepts this,
   *  injects the upload bodies into the turn and persists the metadata, exactly
   *  as Liftoff does. */
  attachments?: PendingAttachment[]
  /** The person handed the browser back, ending this hold: beside `content`
   *  (a send while they were driving) or instead of it. The backend verifies
   *  the hold against the runtime's record; a claim it will not honour is a
   *  409 the page treats as quiet. */
  browserHandback?: { holdId: string }
}

export type StreamInsightsChatError = ChatStreamError

export interface StreamInsightsChatCallbacks extends ChatDelegationCallbacks, ChatDelegationPauseCallbacks {
  /** LLM started processing (before any text / tool events). */
  onThinking?: () => void
  /** Per tool invocation in the agentic loop. */
  /** `label` is the phrase platform-backend authored for this tool, and the only
   *  thing a person should read. The name is for matching, never for display. */
  onToolCall?: (tool: string, label?: string) => void
  /** Incremental text outside of visualization fences. */
  onTextDelta?: (text: string) => void
  /** A complete visualization block parsed from a fenced block. */
  onContentBlock?: (block: VisualizationBlock) => void
  /** Terminal success — the final persisted assistant message. */
  /** Terminal success. The message is null when the turn was stopped before
   *  it said anything: nothing was persisted, so there is nothing to hand
   *  over. */
  onComplete?: (message: InsightsChatMessage | null) => void
  /** Terminal failure (request-level OR in-stream error event). */
  onError?: (err: StreamInsightsChatError) => void
  /** The message was folded into the turn already running on this thread
   *  rather than starting a new one. The reply arrives on the stream that is
   *  still open, so this response carries nothing else. */
  onInterruptDelivered?: () => void
}

/**
 * Ask the turn running on this thread to stop.
 *
 * `deliveredAs: 'noop'` means there was nothing running — the turn had already
 * finished, or the click raced its own reply. Same contract as
 * `stopAgentChatTurn` and `stopTeamPlanChatTurn`, so every chat surface is
 * handled identically.
 */
export const stopInsightsChatTurn = client.stopTurn

/**
 * Stream a chat turn from POST /api/insights/chat-stream (SSE).
 *
 * Accepts an AbortSignal so the calling component can abort on unmount,
 * navigation, "New Chat" click, or a new message being sent.
 */
export const streamInsightsChatMessage = client.streamMessage

/** Exported for the dispatch tests, as Liftoff's is: the routing of each
 *  frame is the contract the page relies on. */
export function dispatchSseEvent(
  event: string,
  data: Record<string, unknown>,
  cb: StreamInsightsChatCallbacks,
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
      // The Insights Manager handed the turn to a colleague: the live reply is
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
          ? (data.message as InsightsChatMessage)
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
