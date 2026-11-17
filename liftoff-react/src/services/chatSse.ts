// Shared SSE plumbing for the chat surfaces.
//
// Browsers have no native SSE parser for POST requests, so a chat service has
// to read the body as a stream and parse event/data frames by hand. That reader
// is identical everywhere: only the URL, the request body and the set of event
// names differ. All four surfaces now reach it through services/chatSurface.ts,
// so a new surface adds no fifth copy.
//
// What stays with the caller is the part that is genuinely per-surface: the
// typed callbacks and the switch that routes an event name onto them.

import { auth } from '../config/firebase'
import { delegationHeader } from '../lib/supportDelegation'

// Same API base URL selection as services/api.ts. Duplicated because the `api`
// wrapper does not expose the base URL and does not support ReadableStream
// responses.
const MSW_DISABLED =
  typeof import.meta.env.VITE_DISABLE_MSW === 'string' &&
  import.meta.env.VITE_DISABLE_MSW.toLowerCase() === 'true'

export const API_BASE_URL =
  import.meta.env.DEV && !MSW_DISABLED
    ? ''
    : (import.meta.env.VITE_API_URL || 'http://localhost:8080')

export interface ChatStreamError {
  code: string
  message: string
  /** HTTP status for request-level errors (non-2xx); absent for SSE error events. */
  status?: number
  /** For 429 responses. */
  retryAfter?: number
}

/** Routes one parsed SSE frame onto a surface's own callbacks. */
export type SseEventHandler = (event: string, data: Record<string, unknown>) => void

/**
 * POST to an SSE endpoint and feed each parsed frame to `onEvent`.
 *
 * Terminal failures (network, non-2xx, stream read) go to `onError`. An abort
 * is silent by design: the caller aborted, so it already knows, and surfacing
 * it as an error would show a toast for a deliberate navigation or Stop.
 *
 * `onNonSseResponse` is for the one endpoint that can answer a streaming
 * request with plain JSON instead. It is opt-in rather than always-on so the
 * surfaces without that behaviour read the body exactly as they always have,
 * whatever Content-Type came back.
 */
export async function streamChatSse(
  path: string,
  body: unknown,
  onEvent: SseEventHandler,
  onError: (err: ChatStreamError) => void,
  signal?: AbortSignal,
  onNonSseResponse?: (json: Record<string, unknown> | null) => void,
): Promise<void> {
  let response: Response
  try {
    const token = await auth.currentUser?.getIdToken()
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        // Streaming goes through fetch rather than EventSource, so it carries
        // the same headers as every other call. A support session that reached
        // the dashboard but not the chat stream would be the worst of both.
        ...delegationHeader(),
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    onError({
      code: 'NETWORK_ERROR',
      message: (err as Error).message || 'Network error',
    })
    return
  }

  if (!response.ok) {
    const errorBody = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }))
    const retryAfterHeader = response.headers.get('Retry-After')
    onError({
      code: response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`,
      message: errorBody.error || errorBody.message || `HTTP ${response.status}`,
      status: response.status,
      retryAfter: retryAfterHeader ? Number(retryAfterHeader) : undefined,
    })
    return
  }

  if (onNonSseResponse) {
    const contentType = response.headers.get('Content-Type') ?? ''
    if (!contentType.startsWith('text/event-stream')) {
      onNonSseResponse(
        (await response.json().catch(() => null)) as Record<string, unknown> | null,
      )
      return
    }
  }

  const reader = response.body?.getReader()
  if (!reader) {
    onError({ code: 'NO_BODY', message: 'No response body' })
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  // Whether the server said it had finished writing.
  //
  // A reader that reports `done` says the body ended. It does NOT say why, and
  // the two reasons are opposites: the turn finished, or the connection was cut
  // underneath it. Both arrive here as the same value, so this loop used to
  // `break` and return normally either way — a truncated stream was reported to
  // the caller as a completed one, and the person was told nothing at all.
  //
  // Every chat stream router ends with an explicit `event: done` frame for
  // exactly this. Its ABSENCE at EOF is the signal, which is why it is tracked
  // here rather than dispatched to the surfaces: no surface needs to render it,
  // and the one thing it means is a property of the transport.
  //
  // `complete` and `error` count too, and deliberately. They are the two frames
  // every surface's vocabulary shares, and a turn that delivered one of them
  // HAS given the caller its answer — a socket dying in the gap between that
  // frame and `done` would otherwise fire a spurious failure on a turn the
  // person already has. The case worth reporting is a stream that ended having
  // said nothing terminal at all.
  let sawTerminal = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are event/data line pairs separated by a blank line. Split
      // on \n and keep the last, possibly incomplete, line in the buffer.
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')
        if (line === '') {
          // End of a frame. Reset the event name so a stray `data:` arriving
          // without an `event:` is not routed onto the previous handler.
          currentEvent = ''
          continue
        }
        if (line.startsWith(':')) continue // comment / heartbeat
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
          continue
        }
        if (line.startsWith('data: ') && currentEvent) {
          if (currentEvent === 'done') {
            // Transport-level marker. No surface renders it.
            sawTerminal = true
            continue
          }
          if (currentEvent === 'complete' || currentEvent === 'error') {
            sawTerminal = true
          }
          try {
            onEvent(currentEvent, JSON.parse(line.slice(6)) as Record<string, unknown>)
          } catch {
            // A dropped or malformed frame must not kill the loop.
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    onError({
      code: 'STREAM_ERROR',
      message: (err as Error).message || 'Stream read failed',
    })
    return
  }

  // EOF with no `done` frame in front of it: the body ended before the server
  // finished writing. Reported rather than swallowed, because the caller's
  // error path is the one that refetches the thread and says something — and a
  // reply written during the gap is exactly what that refetch picks up.
  // An abort usually rejects the pending read and is handled above, but a Stop
  // or a navigation landing in the same tick as the close arrives here instead:
  // `done`, with no terminal frame, and nothing wrong. The caller aborted, so it
  // already knows, and a toast for a deliberate Stop is exactly the noise the
  // abort branch above exists to avoid.
  if (!sawTerminal && !signal?.aborted) {
    onError({
      code: 'STREAM_TRUNCATED',
      message: 'The connection ended before the reply finished arriving.',
    })
  }
}
