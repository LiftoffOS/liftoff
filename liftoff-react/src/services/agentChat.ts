// Agent Chat API Client
//
// Typed wrappers around the /api/agent-chat CRUD endpoints. The common thread,
// message and streaming endpoints come from services/chatSurface.ts, the same
// factory the other three chat surfaces use; what is written out here is what
// is genuinely agent-chat's own: the agentId in every path, unread state, chat
// shares, feedback, and a stop route that is not thread-scoped.

import { api } from './api'
import { auth } from '../config/firebase'
import { API_BASE_URL, type ChatStreamError } from './chatSse'
import {
  createChatSurfaceClient,
  parseDelegationStarted,
  type ChatDelegationCallbacks,
  type PaginatedChatMessages,
  type PaginatedChatThreads,
} from './chatSurface'
import type { PendingAttachment } from './internalAgents'
import type { MediaRef } from '../types/media'
import type { Contributor } from '../types/contributors'

// ── Types ───────────────────────────────────────────────────────────────

export interface AgentChatThread {
  id: string
  tenantId: string
  accountId: string
  // 'mcp': conversations from a connected coding tool (read-only here in v1)
  channel: 'web' | 'slack' | 'mcp'
  sourceLabel?: string | null
  agentId: string
  title: string | null
  createdAt: string
  updatedAt: string
  /** The team has replied since this reader last opened the thread. Absent on
   *  an older backend, which reads as false and renders no indicator. */
  unread: boolean
}

export type AgentChatMessageRole = 'user' | 'assistant'

export interface AgentChatFileAttachment {
  generatedFileId: string
  filename: string
  outputType: string
  version: number
  downloadUrl: string
  webViewUrl?: string
}

export interface AgentChatCitation {
  ref: number
  filename: string
  page?: number
  quote: string
}

/**
 * Human author of a user message, resolved server-side from the chat turn.
 * Absent on assistant messages, on messages from an unresolved Slack or Teams
 * guest, and on older messages that predate turn tracking.
 */
export interface AgentChatMessageSender {
  accountId: string
  firstName: string | null
  lastName: string | null
  email: string
  avatarUrl: string | null
}

export interface AgentChatMessage {
  id: string
  tenantId: string
  threadId: string
  agentId: string
  role: AgentChatMessageRole
  content: string
  toolCalls: unknown[] | null
  inputTokens: number
  outputTokens: number
  createdAt: string
  messageType?: string
  attachments?: AgentChatFileAttachment[]
  /** Images, video or audio the team produced for this message. Its own field,
   *  never folded into `attachments`: that name means the opposite thing on
   *  different surfaces. Rendered by ChatMessages itself, so passing it through
   *  here is the whole of what this surface has to do. */
  media?: MediaRef[]
  citations?: AgentChatCitation[]
  sender?: AgentChatMessageSender | null
  /** External display name for a sender with no Liftoff account (a Slack or
   *  Teams guest). Present only when `sender` is absent. */
  senderLabel?: string | null
  /** Teammates this team delegated part of the reply to, in first-call order,
   *  each named as the person saw it. `[]` when the team answered alone.
   *  Optional because a message from an older backend carries none. */
  contributors?: Contributor[]
}

export type PaginatedAgentChatThreadsResponse = PaginatedChatThreads<AgentChatThread>

export type PaginatedAgentChatMessagesResponse = PaginatedChatMessages<AgentChatMessage>

// ── Client ──────────────────────────────────────────────────────────────

/**
 * Every agent-chat route is scoped to one team, so the base path is not a
 * constant the way the other surfaces' are. The client is built per call rather
 * than cached per agentId: it is a handful of closures, and a cache keyed by
 * agentId would outlive the teams it was built for.
 */
function client(agentId: string) {
  return createChatSurfaceClient<
    AgentChatThread,
    AgentChatMessage,
    StreamAgentChatInput,
    StreamAgentChatCallbacks,
    { thread: AgentChatThread; messages: AgentChatMessage[] }
  >({
    basePath: `/api/agent-chat/${agentId}`,
    dispatchEvent: dispatchSseEvent,
    buildStreamBody: greetingSafeBody,
    onNonSseResponse: handleNonSseResponse,
  })
}

// ── Thread CRUD ─────────────────────────────────────────────────────────

/**
 * `unread` is declared required on AgentChatThread, so the boundary is where it
 * becomes true. A backend that predates the field sends nothing, and coercing
 * here means one place decides what absent means instead of every consumer
 * remembering to treat undefined as false.
 */
function normalizeThread(thread: AgentChatThread): AgentChatThread {
  return { ...thread, unread: thread.unread === true }
}

export async function listAgentChatThreads(
  tenantId: string,
  agentId: string,
  options?: { cursor?: string; limit?: number },
): Promise<PaginatedAgentChatThreadsResponse> {
  const response = await client(agentId).listThreads(tenantId, options)
  return { ...response, threads: (response.threads ?? []).map(normalizeThread) }
}

export async function createAgentChatThread(
  tenantId: string,
  agentId: string,
  title?: string,
): Promise<{ thread: AgentChatThread; messages: AgentChatMessage[] }> {
  const response = await client(agentId).createThread(tenantId, title)
  return { ...response, thread: normalizeThread(response.thread) }
}

export async function deleteAgentChatThread(
  tenantId: string,
  agentId: string,
  threadId: string,
): Promise<void> {
  await client(agentId).deleteThread(tenantId, threadId)
}

// ── Unread state ────────────────────────────────────────────────────────

/**
 * Record that this reader has now seen everything in a thread. The marker is
 * per person, so the server takes the account from the authenticated caller
 * and never from the body.
 */
export async function markAgentChatThreadRead(
  tenantId: string,
  agentId: string,
  threadId: string,
): Promise<void> {
  await api.post<void>(
    `/api/agent-chat/${agentId}/threads/${threadId}/read`,
    { tenantId },
  )
}

/** Mark every thread with this team that has an unread reply read for this
 *  reader, in one call. Backs the history modal's "Mark All Read". */
export async function markAllAgentChatThreadsRead(
  tenantId: string,
  agentId: string,
): Promise<void> {
  await api.post<void>(`/api/agent-chat/${agentId}/threads/read-all`, { tenantId })
}

/** Threads with an unread reply, per team. A team with none is absent from the
 *  map rather than present as zero. */
export interface UnreadCountsResponse {
  counts: Record<string, number>
}

export async function getAgentChatUnreadCounts(
  tenantId: string,
): Promise<UnreadCountsResponse> {
  return await api.get<UnreadCountsResponse>(
    `/api/agent-chat/unread-counts?tenantId=${encodeURIComponent(tenantId)}`,
  )
}

// ── Share links ─────────────────────────────────────────────────────────

/** Which chat surface a share link points at. */
export type ChatThreadKind = 'agent' | 'team_plan' | 'insights' | 'liftoff'

/** The kinds whose threads belong to an agent. Everything else is a platform
 *  surface by subtraction, so a kind added above is agentless until somebody
 *  puts it here on purpose, which is the safer default of the two: the backend
 *  rejects a stray agentId outright. */
type AgentBackedKind = Extract<ChatThreadKind, 'agent' | 'team_plan'>
type PlatformKind = Exclude<ChatThreadKind, AgentBackedKind>

/** A thread that belongs to an agent, so the team comes back with it. */
interface AgentBackedShare {
  tenantId: string
  agentId: string
  threadId: string
}

/** A thread on one of the two platform surfaces. They have no team behind
 *  them, so the backend omits agentId rather than sending null. */
interface PlatformShare {
  tenantId: string
  threadId: string
}

/**
 * What a share id resolves to. A union rather than one shape with an optional
 * agentId: written this way, reading `agentId` off an insights or Liftoff
 * share is a compile error instead of an undefined that reaches the router.
 *
 * One member per kind rather than the two members the shapes alone would need,
 * because TypeScript only drops a union member on `!==` when its discriminant
 * is that single literal. SharePage rules the platform kinds out and then
 * reads agentId, and grouping the kinds would leave that read unnarrowed.
 *
 * Links minted before the Chief AI Officer chat could be shared carry no
 * threadKind at all. They are all agent chats, which is what SharePage's
 * fallthrough branch treats an unrecognised kind as.
 */
export type ChatShareResolution =
  | (AgentBackedShare & { threadKind: 'agent' })
  | (AgentBackedShare & { threadKind: 'team_plan' })
  | (PlatformShare & { threadKind: 'insights' })
  | (PlatformShare & { threadKind: 'liftoff' })

/**
 * What POST /api/chat-shares accepts. The backend REQUIRES agentId for a
 * team's own threads and rejects it with a 400 for the two platform surfaces,
 * so the pairing is expressed in the type rather than checked at runtime:
 * neither mistake compiles. `agentId?: never` on the second member is what
 * makes the rejection hold for a spread object as well as a literal, where
 * excess-property checking alone would not.
 */
export type CreateChatShareInput =
  | { tenantId: string; agentId: string; threadId: string; threadKind: AgentBackedKind }
  | { tenantId: string; agentId?: never; threadId: string; threadKind: PlatformKind }

export async function createChatShare(input: CreateChatShareInput): Promise<{ id: string }> {
  return await api.post<{ id: string }>('/api/chat-shares', {
    tenantId: input.tenantId,
    // Spread rather than passed as undefined: the field has to be absent from
    // the JSON for the agentless kinds, not present and empty.
    ...(input.agentId ? { agentId: input.agentId } : {}),
    threadId: input.threadId,
    threadKind: input.threadKind,
  })
}

export async function resolveChatShare(shareId: string): Promise<ChatShareResolution> {
  return await api.get<ChatShareResolution>(`/api/chat-shares/${encodeURIComponent(shareId)}`)
}

// ── Message CRUD ────────────────────────────────────────────────────────

export async function listAgentChatMessages(
  tenantId: string,
  agentId: string,
  threadId: string,
  options?: { cursor?: string; limit?: number },
): Promise<PaginatedAgentChatMessagesResponse> {
  return await client(agentId).listMessages(tenantId, threadId, options)
}

// ── Chat streaming ──────────────────────────────────────────────────────

export interface StreamAgentChatInput {
  tenantId: string
  agentId: string
  // Optional: absent for the greeting, which is asked for before any thread
  // exists and creates none. The first message the person sends is what opens
  // the conversation.
  threadId?: string
  // Optional: when absent, the backend enters greeting mode.
  content?: string
  // Files and connector references attached to this message. This WAS a no-op:
  // the client sent it and the backend's request schema did not declare it, so
  // zod stripped every attachment on this surface — silently, while the
  // composer showed a chip. The schema declares it now.
  attachments?: PendingAttachment[]
  /** The person handed the browser back, ending this hold: beside `content`
   *  (a send while they were driving) or instead of it. The backend verifies
   *  the hold against the runtime's record; a claim it will not honour is a
   *  409 the page treats as quiet. */
  browserHandback?: { holdId: string }
}

export type StreamAgentChatError = ChatStreamError

export interface AwaitingInputEvent {
  question: string
  sessionId: string
}

export interface HitlRequiredEvent {
  approvalId: string
  reason: string
  /** Who the approval was routed to, by name. Empty when it went to the
   *  workspace admins, which `routedToAdmins` reports instead. */
  routedTo?: string[]
  routedToAccountIds?: string[]
  routedToAdmins?: boolean
  /** Agent has nobody assigned: open to the workspace rather than escalated. */
  unassigned?: boolean
  /** Level 1 needs an admin or owner; level 2 any member. */
  hitlLevel?: number
}

/** A team this conversation delegated work to stopped for a human approval.
 *  Not a failure and not terminal: the team handling this conversation keeps
 *  speaking after it, so nothing settles here. A status row naming the waiting
 *  team was persisted by the backend the moment this fired, so the handler's
 *  job is to refresh the transcript and surface the way to the review queue,
 *  where the decision is waiting. */
export interface DelegationPausedEvent {
  /** The waiting team's name as the person should see it. Null when it could
   *  not be resolved; the persisted row still explains the stall. */
  agentName: string | null
  approvalId: string | null
  reason: string
}

/** Values a tool returned that were delivered to the PERSON and deliberately
 *  kept out of the model's context — a signed download link, a one-time token.
 *
 *  Live only. The runtime lifts these off a tool result so the model never
 *  holds them, and nothing persists them for the same reason: writing them into
 *  the transcript would put them back into the context the lift removed them
 *  from, on the next turn that reads history. So they arrive once, on the turn
 *  that produced them, and a reload does not bring them back. That is the right
 *  trade for a one-time token and the reason they render beside the tool call
 *  rather than as a message. */
export interface HostDeliveredEvent {
  /** The tool that returned them, so the surface can say where they came from. */
  tool: string
  fields: Array<{ path: string; value: unknown }>
}

export interface StreamAgentChatCallbacks extends ChatDelegationCallbacks {
  onThinking?: () => void
  /** `label` is the phrase platform-backend authored for this tool, and the only
   *  thing a person should read. The name is for matching, never for display. */
  onToolCall?: (tool: string, label?: string) => void
  onAgentStart?: (agentId: string) => void
  onTextDelta?: (text: string) => void
  /** One assistant message ended and another may follow. Token deltas arrive as
   *  one undifferentiated stream, so this is the only reliable place to put a
   *  paragraph break between messages. */
  onTextBreak?: () => void
  /** Terminal success. The message is null when the turn was stopped before
   *  it said anything: nothing was persisted, so there is nothing to hand
   *  over. */
  onComplete?: (message: AgentChatMessage | null) => void
  onError?: (err: StreamAgentChatError) => void
  onAwaitingInput?: (event: AwaitingInputEvent) => void
  /** A tool call was gated by HITL approval. The turn pauses; the operator
   *  approves/rejects out-of-band in /dashboard/review and the SAME run resumes
   *  to completion. The chat surface shows a minimal waiting status that
   *  deep-links into the existing Review queue (no new approval UI). */
  onHitlRequired?: (event: HitlRequiredEvent) => void
  /** In-flight notification, like onHitlRequired and unlike Liftoff's
   *  delegation_paused: there the delegate held the rest of the turn, so the
   *  pause ended the stream; here the delegating team continues narrating and
   *  the stream ends through its own complete event. Settling on this event
   *  would cut that narration off mid-sentence. */
  onDelegationPausedNotice?: (event: DelegationPausedEvent) => void
  // onDelegationStarted comes from ChatDelegationCallbacks. Here it fires
  // before the delegated run's work, once per teammate the team hands work
  // to; the team keeps narrating afterwards, so text resuming ends the
  // activity line while the chip stays.
  /** A tool returned something for the reader that the agent never saw. */
  onHostDelivered?: (event: HostDeliveredEvent) => void
  /** Hybrid execution engine: backend returns this JSON shape (not SSE) when
   *  the user's message is the answer to a pending ask_user clarification.
   *  The autonomous run has been re-enqueued via Cloud Tasks. */
  onClarificationAccepted?: () => void
  /** Hybrid execution engine: backend returns this JSON shape when the user
   *  message is delivered as an interrupt to an in-flight autonomous run.
   *  The recovery LLM picks it up at the next step boundary. */
  onInterruptDelivered?: () => void
}

/** Ask the platform to stop the run currently active on a thread. Resolves
 *  with deliveredAs 'abort' (a run was signalled) or 'noop' (nothing running —
 *  a benign race with completion).
 *
 *  Hand-written rather than the shared client's `stopTurn`: this route is
 *  scoped to the team rather than the thread, takes the thread in the body, and
 *  rejects on a non-2xx instead of resolving. */
export async function stopAgentChatTurn(input: {
  agentId: string
  tenantId: string
  threadId: string
}): Promise<{ acknowledged: boolean; deliveredAs: 'abort' | 'noop' }> {
  const token = await auth.currentUser?.getIdToken()
  const response = await fetch(`${API_BASE_URL}/api/agent-chat/${input.agentId}/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ tenantId: input.tenantId, threadId: input.threadId }),
  })
  if (!response.ok) {
    throw new Error(`Stop request failed (HTTP ${response.status})`)
  }
  return response.json()
}

/** Build the request body field by field rather than passing the input
 *  through, so a field that is absent is absent on the wire. Both optional
 *  fields are read as missing by the backend's Zod schema — content triggers
 *  greeting mode, threadId decides whether anything is persisted — and
 *  `{ threadId: undefined }` serialises to a key the schema would reject. */
function greetingSafeBody(input: StreamAgentChatInput): unknown {
  return {
    tenantId: input.tenantId,
    agentId: input.agentId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.content ? { content: input.content, attachments: input.attachments } : {}),
    ...(input.browserHandback ? { browserHandback: input.browserHandback } : {}),
  }
}

/**
 * Hybrid execution engine: a chat-stream request can come back as plain JSON
 * instead of an SSE stream, when the message answered a pending ask_user
 * clarification (`{ resumed: true }`) or was delivered into a run already in
 * flight (`{ acknowledged: true, deliveredAs: 'interrupt' }`). Both are
 * terminal, and neither ever reaches the event dispatcher.
 */
function handleNonSseResponse(
  raw: Record<string, unknown> | null,
  callbacks: StreamAgentChatCallbacks,
): void {
  const json = raw as
    | { resumed?: boolean; acknowledged?: boolean; deliveredAs?: string }
    | null
  if (json?.resumed) {
    callbacks.onClarificationAccepted?.()
    return
  }
  if (json?.acknowledged && json?.deliveredAs === 'interrupt') {
    callbacks.onInterruptDelivered?.()
    return
  }
  // Unknown JSON shape — surface as a generic error.
  callbacks.onError?.({
    code: 'UNEXPECTED_RESPONSE',
    message: 'Server returned non-SSE response of unknown shape',
  })
}

export async function streamAgentChatMessage(
  input: StreamAgentChatInput,
  callbacks: StreamAgentChatCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  await client(input.agentId).streamMessage(input, callbacks, signal)
}

// ── Feedback ────────────────────────────────────────────────────────────

export interface AgentChatFeedbackInput {
  tenantId: string
  agentId: string
  messageId: string
  rating: 'positive' | 'negative'
  comment?: string
}

export async function submitAgentChatFeedback(
  input: AgentChatFeedbackInput,
): Promise<void> {
  await api.post<void>(
    `/api/agent-chat/${input.agentId}/feedback`,
    {
      tenantId: input.tenantId,
      messageId: input.messageId,
      rating: input.rating,
      comment: input.comment,
    },
  )
}

// ── Microsoft Teams connect (tenant-level; one shared bot) ────────────────

export async function getTeamsConnectUrl(
  tenantId: string,
): Promise<{ url: string }> {
  return await api.get<{ url: string }>(
    `/api/agent-chat/teams/connect-url?tenantId=${encodeURIComponent(tenantId)}`,
  )
}

// ── SSE dispatch ────────────────────────────────────────────────────────

export function dispatchSseEvent(
  event: string,
  data: Record<string, unknown>,
  cb: StreamAgentChatCallbacks,
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
    case 'agent_start':
      if (typeof data.agentId === 'string') cb.onAgentStart?.(data.agentId)
      return
    case 'text_delta':
      if (typeof data.text === 'string') cb.onTextDelta?.(data.text)
      return
    case 'text_break':
      cb.onTextBreak?.()
      return
    case 'complete':
      // A turn stopped before it said anything completes with no message —
      // there is no reply to persist and none is invented. Still terminal:
      // the handler has to fire either way, or the composer streams forever.
      cb.onComplete?.(
        data.message && typeof data.message === 'object'
          ? (data.message as AgentChatMessage)
          : null,
      )
      return
    case 'awaiting_input':
      if (typeof data.question === 'string' && typeof data.sessionId === 'string') {
        cb.onAwaitingInput?.({ question: data.question, sessionId: data.sessionId })
      }
      return
    case 'interrupt_delivered':
      cb.onInterruptDelivered?.()
      return
    case 'clarification_accepted':
      cb.onClarificationAccepted?.()
      return
    case 'hitl_required':
      if (typeof data.approvalId === 'string' && typeof data.reason === 'string') {
        cb.onHitlRequired?.({
          approvalId: data.approvalId,
          reason: data.reason,
          routedTo: Array.isArray(data.routedTo) ? (data.routedTo as string[]) : [],
          routedToAccountIds: Array.isArray(data.routedToAccountIds)
            ? (data.routedToAccountIds as string[])
            : [],
          routedToAdmins: data.routedToAdmins === true,
          unassigned: data.unassigned === true,
          hitlLevel: typeof data.hitlLevel === 'number' ? data.hitlLevel : 2,
        })
      }
      return
    case 'host_delivered': {
      // Only well-formed entries. A field without a path cannot be labelled,
      // and an unlabelled value beside a tool call says nothing a reader can
      // act on — dropping it is better than rendering a bare string.
      const fields = Array.isArray(data.fields)
        ? (data.fields as Array<Record<string, unknown>>)
            .filter((f) => f && typeof f.path === 'string')
            .map((f) => ({ path: f.path as string, value: f.value }))
        : []
      if (fields.length > 0) {
        cb.onHostDelivered?.({
          tool: typeof data.tool === 'string' ? data.tool : '',
          fields,
        })
      }
      return
    }
    case 'delegation_started': {
      const contributor = parseDelegationStarted(data)
      if (contributor) cb.onDelegationStarted?.(contributor)
      return
    }
    case 'delegation_paused':
      // `agentName`/`approvalId` may legitimately be null (best-effort
      // resolution), so they are normalised rather than required: a pause whose
      // team could not be named still stalled the delegated work and still
      // needs surfacing.
      cb.onDelegationPausedNotice?.({
        agentName: typeof data.agentName === 'string' ? data.agentName : null,
        approvalId: typeof data.approvalId === 'string' ? data.approvalId : null,
        reason:
          typeof data.reason === 'string'
            ? data.reason
            : 'A team this conversation delegated work to is waiting on an approval.',
      })
      return
    case 'error':
      cb.onError?.({
        code: (data.code as string) || 'UNKNOWN',
        message: (data.message as string) || 'Unknown error',
      })
      return
  }
}
