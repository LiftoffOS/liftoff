// Liftoff Chat API Client
//
// Typed wrappers around the /api/liftoff/* endpoints. Liftoff is a platform
// assistant, not one of the customer's agents, so it follows the Insights
// Manager's shape rather than agent-chat's: its own router with no agentId in
// any URL.
//
// That distinction is load-bearing. An internal_agents row would show up in
// every surface that lists the customer's teams (team builder, connectors,
// integrations), and a system row with tenant_id NULL is unreachable through
// agent-chat's tenant-scoped admission check anyway.

import { api } from './api'
import type { ChatStreamError } from './chatSse'
import {
  createChatSurfaceClient,
  parseDelegationPaused,
  parseDelegationStarted,
  type ChatCursorOptions,
  type ChatDelegationCallbacks,
  type ChatDelegationPauseCallbacks,
  type DelegationPausedEvent,
  type PaginatedChatMessages,
  type PaginatedChatThreads,
} from './chatSurface'
import type { Contributor } from '../types/contributors'
import { createChatPresenceFetchers } from './presence'
import type { VisualizationBlock } from '../types/insights'
import type { PendingAttachment } from './internalAgents'
import type { MediaRef } from '../types/media'
import type { FileAttachment } from '../components/Chat/ChatMessages'
import type { ChatMessageAttachment } from '../types/chatAttachments'

// ── Types ───────────────────────────────────────────────────────────────

export interface LiftoffChatThread {
  id: string
  tenantId: string
  accountId: string
  title: string | null
  /** Liftoff has replied since this reader last opened the thread. Absent on
   *  an older backend, which reads as false and renders no indicator. */
  unread: boolean
  createdAt: string
  updatedAt: string
}

export type LiftoffMessageRole = 'user' | 'assistant'

/** What a message carried when it was sent. Metadata only: an upload's text is
 *  a one-turn input to the model and is deliberately not stored, so a reopened
 *  thread can name the file without reproducing it.
 *
 *  The shape is shared with the Insights Manager and the Chief AI Officer, which
 *  store the same rows; this alias keeps the name Liftoff's callers already use. */
export type LiftoffMessageAttachment = ChatMessageAttachment

export interface LiftoffChatMessage {
  id: string
  threadId: string
  role: LiftoffMessageRole
  content: string
  attachments: LiftoffMessageAttachment[]
  /** Which colleague Liftoff brought in to answer: `'caio'`, `'insights'`, or
   *  one of the customer's agents by id. Null is Liftoff answering as itself,
   *  which is what every message written before delegation reads back as. */
  author: string | null
  /** That colleague's name as the person saw it. Stored alongside the reply
   *  rather than resolved on read, so renaming or deleting a team never
   *  relabels an answer somebody has already had. */
  authorLabel: string | null
  /** The same fact in the shape every surface's message carries, so one
   *  renderer draws the chips: a hand-over is the one-element case, derived
   *  server-side from `author` / `authorLabel`. `[]` for a reply Liftoff wrote
   *  itself. */
  contributors: Contributor[]
  /** What the reply drew beside its text, e.g. the org chart the Chief AI
   *  Officer emits when it proposes a team. Always a list, like attachments:
   *  the backend never sends null, so no caller has to invent the empty case. */
  visualizationBlocks: VisualizationBlock[]
  /** What kind of row this is, when it is not ordinary speech. `'hitl_status'`
   *  is a sentence the conversation posted about ITSELF, because the colleague
   *  it handed the turn to stopped for an approval, and it renders as a status
   *  line rather than as something anyone said. Null on speech, which is every
   *  message written before the column existed. Same vocabulary team chat uses
   *  for the same fact. */
  messageType: string | null
  /** Images, video or audio the team produced for this message. Its own field,
   *  never folded into `attachments`: that name means the opposite thing on
   *  different surfaces. Rendered by ChatMessages itself, so passing it through
   *  here is the whole of what this surface has to do. */
  media?: MediaRef[]
  /** File cards shown into this message. Same field name and shape as every
   *  other surface, so one renderer draws them. */
  files?: FileAttachment[]
  inputTokens: number
  outputTokens: number
  createdAt: string
}

export type PaginatedLiftoffThreadsResponse = PaginatedChatThreads<LiftoffChatThread>

export type PaginatedLiftoffMessagesResponse = PaginatedChatMessages<LiftoffChatMessage>

// ── Client ──────────────────────────────────────────────────────────────

const BASE_PATH = '/api/liftoff'

const client = createChatSurfaceClient<
  LiftoffChatThread,
  LiftoffChatMessage,
  StreamLiftoffChatInput,
  StreamLiftoffChatCallbacks
>({
  basePath: BASE_PATH,
  dispatchEvent: dispatchSseEvent,
  buildStreamBody: greetingSafeBody,
})

// ── Thread CRUD ─────────────────────────────────────────────────────────

/**
 * `unread` is declared required on LiftoffChatThread, so the boundary is where
 * it becomes true. A backend that predates the field sends nothing, and
 * coercing here means one place decides what absent means instead of every
 * consumer remembering to treat undefined as false. Same rule as agent chat.
 */
function normalizeThread(thread: LiftoffChatThread): LiftoffChatThread {
  return { ...thread, unread: thread.unread === true }
}

/** List threads visible to the caller, newest activity first. The backend
 *  enforces the permission matrix. */
export async function listLiftoffThreads(
  tenantId: string,
  options?: ChatCursorOptions,
): Promise<PaginatedLiftoffThreadsResponse> {
  const response = await client.listThreads(tenantId, options)
  return { ...response, threads: (response.threads ?? []).map(normalizeThread) }
}

/** Create a thread. Title is optional; the backend derives one from the first
 *  user message. */
export const createLiftoffThread = client.createThread

/** Soft-delete a thread. 404 rather than 403 when it is not visible, so the
 *  response never leaks that it exists. */
export const deleteLiftoffThread = client.deleteThread

// ── Message CRUD ────────────────────────────────────────────────────────

/** Reverse-paginated messages: newest first, so scrolling up loads older. */
export const listLiftoffMessages = client.listMessages

/** Append a user message without starting a stream. The streaming turn
 *  persists both sides itself, so this is for tests and optimistic drafts. */
export const sendLiftoffUserMessage = client.sendUserMessage

// ── Unread state ────────────────────────────────────────────────────────

/**
 * Record that this reader has now seen everything in a thread. The marker is
 * per person, so the server takes the account from the authenticated caller
 * and never from the body.
 */
export async function markLiftoffThreadRead(
  tenantId: string,
  threadId: string,
): Promise<void> {
  await api.post<void>(`${BASE_PATH}/threads/${threadId}/read`, { tenantId })
}

/** Mark every thread with an unread reply read for this reader, in one call.
 *  Backs the history modal's "Mark All Read". */
export async function markAllLiftoffThreadsRead(tenantId: string): Promise<void> {
  await api.post<void>(`${BASE_PATH}/threads/read-all`, { tenantId })
}

/** How many threads carry an unread Liftoff reply for this reader. One number
 *  rather than a per-thread map: the surface is a single assistant, so the only
 *  question any indicator asks is "is there anything to come back to". */
export interface LiftoffUnreadCountResponse {
  count: number
}

export async function getLiftoffUnreadCount(
  tenantId: string,
): Promise<LiftoffUnreadCountResponse> {
  return await api.get<LiftoffUnreadCountResponse>(
    `${BASE_PATH}/threads/unread-count?tenantId=${encodeURIComponent(tenantId)}`,
  )
}


// ── Work that goes on after a reply ─────────────────────────────────────

/** The work queued to continue an earlier turn on a conversation.
 *
 *  A turn is bounded: its rounds, the model's context window, and the clock
 *  on the stream that carries it. When a bound closes a turn with work still
 *  to do, the rest is queued and runs on the same conversation as a further
 *  turn, whose reply lands in the transcript like any other. Without this
 *  read the conversation looks finished until that reply appears, which is
 *  the one thing the person should not be shown.
 *
 *  `queued` is waiting for the conversation to be free, `claimed` is a worker
 *  about to start, `running` is under way; all three mean the same thing to a
 *  reader. Null when nothing is queued, and null from a backend that predates
 *  the field. */
export interface ChatThreadContinuation {
  status: 'queued' | 'claimed' | 'running'
}

/**
 * Whether work is queued to continue an earlier turn on this conversation.
 *
 * The same read the Insights Manager's surface makes, on its own router.
 */
export async function getLiftoffThreadContinuation(
  tenantId: string,
  threadId: string,
): Promise<ChatThreadContinuation | null> {
  const res = await api.get<{ continuation?: ChatThreadContinuation | null }>(
    `${BASE_PATH}/threads/${threadId}?tenantId=${encodeURIComponent(tenantId)}`,
  )
  return res.continuation ?? null
}

// ── Paired colleague threads ────────────────────────────────────────────

/** One colleague this conversation has a thread with. */
export interface LiftoffThreadDelegation {
  /** `'caio'` and `'insights'` are the two singleton colleagues; `'team'` is one
   *  of the customer's own agents. */
  targetKind: 'caio' | 'insights' | 'team'
  /** The team, for `targetKind: 'team'`. Null for the two singletons. */
  targetId: string | null
  /** That colleague's thread on its own surface. */
  delegateThreadId: string
}

/**
 * Which thread this conversation is using with each colleague it has brought in.
 *
 * Read so a transcript row saying a team is waiting on an approval can offer to
 * OPEN that conversation: the row names the team, and this turns the name into a
 * destination. Fetching it rather than putting it in the message is what keeps
 * the id out of the address bar, since the destination is then handed to the
 * router as state.
 */
export async function listLiftoffThreadDelegations(
  tenantId: string,
  threadId: string,
): Promise<LiftoffThreadDelegation[]> {
  const res = await api.get<{ delegations: LiftoffThreadDelegation[] }>(
    `${BASE_PATH}/threads/${threadId}/delegations?tenantId=${encodeURIComponent(tenantId)}`,
  )
  return res.delegations ?? []
}

// ── Presence ────────────────────────────────────────────────────────────
//
// Byte-identical to the agent-chat contract, served by /api/liftoff's own
// router. See services/presence.ts for why every surface shares one shape.
//
// There is no turn-events counterpart: this surface records no per-turn
// execution events, so a non-sender learns a reply landed from the heartbeat's
// `latestMessageAt` rather than by following the turn.

const presence = createChatPresenceFetchers(BASE_PATH)

/** Record that this account is on the thread, and read back who else is. */
export const heartbeatLiftoffPresence = presence.heartbeat

/** Release the seat on the way out. Best effort: the server ages rows out. */
export const clearLiftoffPresence = presence.clear

// ── Chat streaming ──────────────────────────────────────────────────────

export interface StreamLiftoffChatInput {
  tenantId: string
  /** Optional: absent for the greeting, which is asked for before any thread
   *  exists and creates none. The first message the person sends is what opens
   *  the conversation. */
  threadId?: string
  content?: string
  /** Files and connector references staged in the composer.
   *
   *  Unlike the Insights Manager, Liftoff is meant to work on what you give it,
   *  so /api/liftoff/chat-stream must accept this rather than strip it. Every
   *  other chat service declares the same field today and the backend ignores
   *  it; that no-op is not acceptable here. */
  attachments?: PendingAttachment[]
  /** The person handed the browser back, ending this hold: beside `content`
   *  (a send while they were driving) or instead of it. The backend verifies
   *  the hold against the runtime's record; a claim it will not honour is a
   *  409 the page treats as quiet. */
  browserHandback?: { holdId: string }
}

/** Build the request body field by field rather than passing the input
 *  through, so a field that is absent is absent on the wire.
 *
 *  The backend reads threadId and content as both-or-neither: together they
 *  are a turn, and the request carrying neither is the greeting, which
 *  persists nothing. `{ threadId: undefined }` would serialise to a key the
 *  Zod schema rejects, which is why this is built rather than spread. */
function greetingSafeBody(input: StreamLiftoffChatInput): unknown {
  // A browser event stands in for the words: with a thread and no content it
  // is a turn of its own, and the backend accepts that pair.
  const hasEvent = !!input.browserHandback
  return {
    tenantId: input.tenantId,
    ...(input.threadId && (input.content || hasEvent) ? { threadId: input.threadId } : {}),
    ...(input.threadId && input.content ? { content: input.content, attachments: input.attachments } : {}),
    ...(input.threadId && input.browserHandback ? { browserHandback: input.browserHandback } : {}),
  }
}

export type StreamLiftoffChatError = ChatStreamError

/** The colleague handling the turn stopped and is waiting on a person: an
 *  approval, or a question it asked.
 *
 *  Terminal, and deliberately NOT an error. It used to arrive on the error
 *  channel, which put the person's message back in the composer as though the
 *  send had failed and popped a red toast over a conversation where nothing had
 *  gone wrong. Their message is stored, the run is alive, and it continues the
 *  moment somebody decides. */
export type { DelegationPausedEvent }

export interface StreamLiftoffChatCallbacks extends ChatDelegationCallbacks, ChatDelegationPauseCallbacks {
  /** The model started work, before any text or tool events. */
  onThinking?: () => void
  /** One tool invocation in the agentic loop. */
  /** `label` is the phrase platform-backend authored for this tool, and the only
   *  thing a person should read. The name is for matching, never for display. */
  onToolCall?: (tool: string, label?: string) => void
  /** Incremental reply text. */
  onTextDelta?: (text: string) => void
  /** One finished visualization block. Liftoff draws none of its own: these are
   *  relayed from the colleague handling the turn, so the stream carries the
   *  same event the Insights Manager and the Chief AI Officer already emit. */
  onContentBlock?: (block: VisualizationBlock) => void
  // onDelegationStarted comes from ChatDelegationCallbacks. Here it fires
  // once, before any of the relayed reply, and has no closing counterpart:
  // Liftoff does not speak again after a handover, so the stream's own
  // terminal event ends the delegated segment.
  // onDelegationPaused comes from ChatDelegationPauseCallbacks: terminal, and
  // not a failure. Whatever the colleague managed to say is already stored,
  // and so is the status row the frame carries the text of, so the only thing
  // left for the client to do is stop streaming and offer the way to the
  // conversation holding the decision.
  /** Terminal success. The message is null when the turn was stopped before it
   *  said anything: nothing was persisted, so there is nothing to hand over. */
  onComplete?: (message: LiftoffChatMessage | null) => void
  /** Terminal failure, request-level or an in-stream error event. */
  onError?: (err: StreamLiftoffChatError) => void
  /** The message was folded into the turn already running on this thread
   *  instead of starting a new one, so the reply arrives on the open stream. */
  onInterruptDelivered?: () => void
}

/** Ask the turn running on this thread to stop.
 *
 *  `deliveredAs: 'noop'` means nothing was running: the turn had already
 *  finished, or the click raced its own reply. Same contract as the other chat
 *  surfaces so every Stop button behaves identically. */
export const stopLiftoffChatTurn = client.stopTurn

/** Stream a chat turn from POST /api/liftoff/chat-stream. */
export const streamLiftoffChatMessage = client.streamMessage

export function dispatchSseEvent(
  event: string,
  data: Record<string, unknown>,
  cb: StreamLiftoffChatCallbacks,
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
      const contributor = parseDelegationStarted(data)
      if (contributor) cb.onDelegationStarted?.(contributor)
      return
    }
    case 'delegation_paused':
      cb.onDelegationPaused?.(parseDelegationPaused(data))
      return
    case 'complete':
      // A turn stopped before it said anything completes with no message. None
      // is invented, but the handler still fires: it is terminal either way,
      // and skipping it would leave the composer streaming forever.
      cb.onComplete?.(
        data.message && typeof data.message === 'object'
          ? (data.message as LiftoffChatMessage)
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
