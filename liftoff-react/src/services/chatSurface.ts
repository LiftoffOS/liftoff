// Chat surface client factory.
//
// Four chat surfaces (agent chat, the CAIO team plan, the Insights Manager and
// Liftoff) speak the same protocol to four different routers: threads under
// `{base}/threads`, messages under `{base}/threads/:id/messages`, a stop
// signal, and a streaming turn at `{base}/chat-stream`. Only the base path, the
// response types and the SSE event vocabulary differ, so the wire format is
// written once here and each surface passes what is genuinely its own.
//
// What deliberately does NOT live here: the endpoints one or two surfaces have
// and the rest do not (presence, unread state, chat shares, turn events,
// Insights reports and counts), and the two stop routes that do not match the
// common shape. Those stay in the service module that owns them.

import { api } from './api'
import { streamChatSse, type ChatStreamError } from './chatSse'
import type { Contributor } from '../types/contributors'

// ── Shared response shapes ──────────────────────────────────────────────

/** Cursor pagination arguments, forward for threads and reverse for messages. */
export interface ChatCursorOptions {
  cursor?: string
  limit?: number
}

/** The half of a paginated response that drives the infinite queries: where the
 *  next page starts, and whether there is one. */
export interface ChatCursorPage {
  nextCursor: string | null
  hasMore: boolean
}

export interface PaginatedChatThreads<TThread> extends ChatCursorPage {
  threads: TThread[]
}

export interface PaginatedChatMessages<TMessage> extends ChatCursorPage {
  messages: TMessage[]
}

/**
 * Outcome of asking a turn to stop.
 *
 * `deliveredAs: 'noop'` means there was nothing running: the turn had already
 * finished, or the click raced its own reply. Every surface reports it the same
 * way so every Stop button behaves identically.
 */
export interface ChatTurnStopResult {
  acknowledged: boolean
  deliveredAs: 'abort' | 'noop'
}

// ── Configuration ───────────────────────────────────────────────────────

/** The minimum a surface's callbacks must offer: somewhere to report a
 *  request-level failure. Everything else is per-surface and reaches the
 *  callbacks through `dispatchEvent`. */
export interface ChatStreamErrorCallbacks {
  onError?: (err: ChatStreamError) => void
}

/** The one frame every surface sends the same way: a colleague was brought
 *  into the reply. Handled by one callback on every surface, so it is parsed
 *  once here rather than four times in four vocabularies. */
export interface ChatDelegationCallbacks {
  /** A colleague took over the reply, or part of it, mid-turn, named so the
   *  live bubble can be attributed while it is still arriving: a chip for the
   *  colleague and "Working with <name>" on the activity line. Fires once per
   *  colleague brought in; a team that hands work to two teammates fires it
   *  twice. */
  onDelegationStarted?: (contributor: Contributor) => void
}

/** `delegation_started` on the wire: `{ author, authorLabel }`, the same
 *  payload on Liftoff and on team chat. Both fields or nothing: a label with
 *  no identity behind it, or an identity with nothing to show, is not worth
 *  relabelling a live reply over. */
export function parseDelegationStarted(data: Record<string, unknown>): Contributor | null {
  if (typeof data.author !== 'string' || typeof data.authorLabel !== 'string') return null
  if (!data.author || !data.authorLabel) return null
  return { id: data.author, label: data.authorLabel }
}

/** The colleague a platform assistant handed the turn to stopped to wait on
 *  a person.
 *
 *  Terminal, and NOT an error, which is the whole reason it has its own
 *  channel: routed through onError, it put the person's message back in the
 *  composer as though the send had failed and popped a red toast over a
 *  conversation where nothing had gone wrong. Their message is stored, the
 *  run is alive, and it continues the moment somebody decides. */
export interface DelegationPausedEvent {
  /** The colleague waiting, by id: 'caio', 'insights', 'liftoff', or one of
   *  the customer's agents. */
  author: string
  /** Its name as the person should see it. */
  authorLabel: string
  /** The colleague's own conversation, where the decision is waiting. Passed
   *  to the router as state, never as a URL segment. Null only when the
   *  pairing could not be read, in which case there is nothing to open. */
  delegateThreadId: string | null
  /** The sentence shown in the transcript, already stored as a status row. */
  reason: string
}

/** The pause frame every platform assistant sends the same way, parsed once.
 *  `delegateThreadId` may legitimately be null (the pairing could not be
 *  read), so it is normalised rather than required: a pause with nowhere to
 *  send the person is still a pause, and swallowing the frame would leave
 *  the composer streaming forever. */
export function parseDelegationPaused(data: Record<string, unknown>): DelegationPausedEvent {
  return {
    author: typeof data.author === 'string' ? data.author : '',
    authorLabel: typeof data.authorLabel === 'string' ? data.authorLabel : '',
    delegateThreadId: typeof data.delegateThreadId === 'string' ? data.delegateThreadId : null,
    reason: typeof data.reason === 'string' ? data.reason : '',
  }
}

/** The pause callback the three platform assistants share. Team chat has its
 *  own, non-terminal notice instead (a delegate of the SPEAKING team paused),
 *  which is why this is not on ChatDelegationCallbacks. */
export interface ChatDelegationPauseCallbacks {
  /** That colleague stopped and is waiting on a person. Terminal, not a
   *  failure. */
  onDelegationPaused?: (event: DelegationPausedEvent) => void
}

export interface ChatSurfaceConfig<TStreamInput, TCallbacks> {
  /** Router root with no trailing slash: `/api/insights`, `/api/agent-chat/<id>`. */
  basePath: string
  /**
   * Routes one parsed SSE frame onto this surface's callbacks. The event
   * vocabulary is genuinely per-surface (only Insights and the team plan emit
   * `content_block`, only agent chat emits `hitl_required` and `text_break`),
   * so the switch stays with the surface that owns it.
   */
  dispatchEvent: (
    event: string,
    data: Record<string, unknown>,
    callbacks: TCallbacks,
  ) => void
  /** Request body for a streaming turn. Defaults to the input untouched; the
   *  surfaces with a greeting mode override it to drop an empty `content`. */
  buildStreamBody?: (input: TStreamInput) => unknown
  /** Handles a 2xx reply that is not an SSE stream at all. Only agent chat has
   *  one, so only agent chat pays the Content-Type check: see `streamChatSse`. */
  onNonSseResponse?: (
    json: Record<string, unknown> | null,
    callbacks: TCallbacks,
  ) => void
}

export interface ChatSurfaceClient<TThread, TMessage, TCreated, TStreamInput, TCallbacks> {
  /** Threads visible to the caller, newest activity first. The backend enforces
   *  the permission matrix. */
  listThreads(
    tenantId: string,
    options?: ChatCursorOptions,
  ): Promise<PaginatedChatThreads<TThread>>
  /** Create a thread. Title is optional; the backend derives one from the first
   *  user message. */
  createThread(tenantId: string, title?: string): Promise<TCreated>
  /** Soft-delete a thread. 404 rather than 403 when it is not visible, so the
   *  response never leaks that it exists. */
  deleteThread(tenantId: string, threadId: string): Promise<void>
  /** Reverse-paginated messages: newest first, so scrolling up loads older. */
  listMessages(
    tenantId: string,
    threadId: string,
    options?: ChatCursorOptions,
  ): Promise<PaginatedChatMessages<TMessage>>
  /** Append a user message without starting a stream. The streaming turn
   *  persists both sides itself, so this is for tests and optimistic drafts. */
  sendUserMessage(
    tenantId: string,
    threadId: string,
    content: string,
  ): Promise<{ message: TMessage }>
  /** Ask the turn running on this thread to stop. */
  stopTurn(input: { tenantId: string; threadId: string }): Promise<ChatTurnStopResult>
  /** Stream a chat turn from `{base}/chat-stream`. Accepts an AbortSignal so
   *  the caller can abort on unmount, navigation or a new send. */
  streamMessage(
    input: TStreamInput,
    callbacks: TCallbacks,
    signal?: AbortSignal,
  ): Promise<void>
}

/** `?tenantId=...` plus the cursor pair when present. Shared by both list
 *  endpoints, which build the query identically. */
function cursorQuery(tenantId: string, options?: ChatCursorOptions): string {
  const params = new URLSearchParams({ tenantId })
  if (options?.cursor) params.append('cursor', options.cursor)
  if (options?.limit) params.append('limit', String(options.limit))
  return params.toString()
}

export function createChatSurfaceClient<
  TThread,
  TMessage,
  TStreamInput,
  TCallbacks extends ChatStreamErrorCallbacks,
  TCreated = { thread: TThread },
>(
  config: ChatSurfaceConfig<TStreamInput, TCallbacks>,
): ChatSurfaceClient<TThread, TMessage, TCreated, TStreamInput, TCallbacks> {
  const { basePath } = config

  return {
    listThreads: async (tenantId, options) =>
      await api.get<PaginatedChatThreads<TThread>>(
        `${basePath}/threads?${cursorQuery(tenantId, options)}`,
      ),

    createThread: async (tenantId, title) =>
      await api.post<TCreated>(`${basePath}/threads`, { tenantId, title }),

    deleteThread: async (tenantId, threadId) => {
      await api.delete<void>(
        `${basePath}/threads/${threadId}?tenantId=${encodeURIComponent(tenantId)}`,
      )
    },

    listMessages: async (tenantId, threadId, options) =>
      await api.get<PaginatedChatMessages<TMessage>>(
        `${basePath}/threads/${threadId}/messages?${cursorQuery(tenantId, options)}`,
      ),

    sendUserMessage: async (tenantId, threadId, content) =>
      await api.post<{ message: TMessage }>(
        `${basePath}/threads/${threadId}/messages`,
        { tenantId, content },
      ),

    stopTurn: async input =>
      await api.post<ChatTurnStopResult>(`${basePath}/threads/${input.threadId}/stop`, {
        tenantId: input.tenantId,
      }),

    streamMessage: async (input, callbacks, signal) => {
      await streamChatSse(
        `${basePath}/chat-stream`,
        config.buildStreamBody ? config.buildStreamBody(input) : input,
        (event, data) => config.dispatchEvent(event, data, callbacks),
        err => callbacks.onError?.(err),
        signal,
        config.onNonSseResponse
          ? json => config.onNonSseResponse!(json, callbacks)
          : undefined,
      )
    },
  }
}
