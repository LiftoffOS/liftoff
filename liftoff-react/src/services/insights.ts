import { api } from './api'
import { auth } from '../config/firebase'
import type { ObservationBlock, VisualizationBlock } from '../types/insights'

// Same API base URL selection logic as services/api.ts. Duplicated here so
// the streaming function stays a pure fetch — the `api` wrapper doesn't
// expose the base URL and doesn't support ReadableStream responses.
const MSW_DISABLED =
  typeof import.meta.env.VITE_DISABLE_MSW === 'string' &&
  import.meta.env.VITE_DISABLE_MSW.toLowerCase() === 'true'

const API_BASE_URL =
  import.meta.env.DEV && !MSW_DISABLED
    ? ''
    : (import.meta.env.VITE_API_URL || 'http://localhost:8080')

export interface InsightsReportResponse {
  blocks: VisualizationBlock[]
}

export type InsightsTimeRangePreset =
  | 'today' | 'yesterday' | 'this_week' | 'last_week'
  | 'this_month' | 'last_month'
  | 'this_quarter' | 'last_quarter'
  | 'this_year'

/**
 * Fetch the insights report for a tenant and time period.
 */
export async function getInsightsReport(
  tenantId: string,
  period: InsightsTimeRangePreset = 'this_week',
): Promise<InsightsReportResponse> {
  const params = new URLSearchParams({ tenantId, period })
  return await api.get<InsightsReportResponse>(`/api/insights/report?${params.toString()}`)
}

// ── /api/insights/counts ────────────────────────────────────────────────
//
// Cheap all-time count probe. The InsightsPage hits this on mount and
// gates the expensive report/intro/observations fetches behind it so a
// brand-new workspace renders the empty-state text instantly instead of
// staring at a 2-3s skeleton.

export interface InsightsCountsResponse {
  agentCount: number
  invocationCount: number
  auditCount: number
  isEmpty: boolean
}

export async function getInsightsCounts(
  tenantId: string,
): Promise<InsightsCountsResponse> {
  const params = new URLSearchParams({ tenantId })
  return await api.get<InsightsCountsResponse>(`/api/insights/counts?${params.toString()}`)
}

// Empty-state copy for the freshly-provisioned workspace. Kept in sync
// manually with EMPTY_INSIGHTS_TEXT in
// liftoff-platform-backend/src/insights/report-service.ts — when counts
// confirms isEmpty=true, the frontend renders this verbatim instead of
// firing the report endpoint (which would otherwise return the same text
// after a short-circuit). If you change one side, change the other.
export const EMPTY_INSIGHTS_TEXT =
  'No insights yet. Once your agents start working, you will see the performance metrics for your whole workspace here.'

// ── Observations streaming (Phase 7) ────────────────────────────────────
//
// Phase B of the hybrid loading: the report loads instantly from the
// function above, then the frontend calls this to layer LLM-generated
// observations on top once they're ready. Designed to degrade silently:
// any failure (network error, SSE error event, abort) just leaves the
// observations section empty — the report itself is unaffected.

export interface StreamObservationsError {
  code: string
  message: string
  status?: number
}

export interface StreamObservationsCallbacks {
  /** Sent immediately by the backend on connect. */
  onThinking?: () => void
  /** One per ObservationBlock in the response. */
  onObservation?: (block: ObservationBlock) => void
  /** Terminal success — the backend sent a `complete` event. */
  onComplete?: (count: number) => void
  /** Terminal failure. Frontend should hide the section, not show a toast. */
  onError?: (err: StreamObservationsError) => void
}

/**
 * Stream the Key Observations section for the current report via SSE.
 * Mirrors streamInsightsChatMessage's manual-parse approach because
 * browsers don't have a native SSE parser for fetch bodies.
 */
export async function streamInsightsObservations(
  tenantId: string,
  period: InsightsTimeRangePreset,
  callbacks: StreamObservationsCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const params = new URLSearchParams({ tenantId, period })
  const url = `${API_BASE_URL}/api/insights/report/observations?${params.toString()}`

  let response: Response
  try {
    const token = await auth.currentUser?.getIdToken()
    response = await fetch(url, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    callbacks.onError?.({
      code: 'NETWORK_ERROR',
      message: (err as Error).message || 'Network error',
    })
    return
  }

  if (!response.ok) {
    callbacks.onError?.({
      code: `HTTP_${response.status}`,
      message: `HTTP ${response.status}`,
      status: response.status,
    })
    return
  }

  const reader = response.body?.getReader()
  if (!reader) {
    callbacks.onError?.({ code: 'NO_BODY', message: 'No response body' })
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')
        if (line === '') {
          currentEvent = ''
          continue
        }
        if (line.startsWith(':')) continue // SSE comment
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
          continue
        }
        if (line.startsWith('data: ') && currentEvent) {
          try {
            const data = JSON.parse(line.slice(6)) as Record<string, unknown>
            dispatchObservationEvent(currentEvent, data, callbacks)
          } catch {
            // Ignore malformed frames
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    callbacks.onError?.({
      code: 'STREAM_ERROR',
      message: (err as Error).message || 'Stream read failed',
    })
  }
}

function dispatchObservationEvent(
  event: string,
  data: Record<string, unknown>,
  cb: StreamObservationsCallbacks,
): void {
  switch (event) {
    case 'thinking':
      cb.onThinking?.()
      return
    case 'observation':
      if (data.block && typeof data.block === 'object') {
        cb.onObservation?.(data.block as ObservationBlock)
      }
      return
    case 'complete':
      cb.onComplete?.(typeof data.count === 'number' ? data.count : 0)
      return
    case 'error':
      cb.onError?.({
        code: (data.code as string) || 'UNKNOWN',
        message: (data.message as string) || 'Unknown error',
      })
      return
  }
}

// ── Intro streaming ─────────────────────────────────────────────────────
//
// Companion to the observations stream above. Same Phase-B layering: the
// report loads instantly, then this fills in the LLM-generated
// one-paragraph "insight intro text" that renders as a leading text block
// above the metric cards. Same fail-soft contract: any failure leaves the
// section empty, never blocks the report.

export interface StreamIntroError {
  code: string
  message: string
  status?: number
}

export interface StreamIntroCallbacks {
  /** Sent immediately by the backend on connect. */
  onThinking?: () => void
  /** The generated paragraph (sent at most once before complete). */
  onIntro?: (content: string) => void
  /** Terminal success — backend sent a `complete` event. hasIntro is false
   *  when the LLM call returned null (no meaningful data, error, etc). */
  onComplete?: (hasIntro: boolean) => void
  /** Terminal failure. Frontend should hide the section, not show a toast. */
  onError?: (err: StreamIntroError) => void
}

/**
 * Stream the LLM-generated insight intro text via SSE. Mirrors
 * streamInsightsObservations exactly with a different event vocabulary.
 */
export async function streamInsightsIntro(
  tenantId: string,
  period: InsightsTimeRangePreset,
  callbacks: StreamIntroCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const params = new URLSearchParams({ tenantId, period })
  const url = `${API_BASE_URL}/api/insights/report/intro?${params.toString()}`

  let response: Response
  try {
    const token = await auth.currentUser?.getIdToken()
    response = await fetch(url, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    callbacks.onError?.({
      code: 'NETWORK_ERROR',
      message: (err as Error).message || 'Network error',
    })
    return
  }

  if (!response.ok) {
    callbacks.onError?.({
      code: `HTTP_${response.status}`,
      message: `HTTP ${response.status}`,
      status: response.status,
    })
    return
  }

  const reader = response.body?.getReader()
  if (!reader) {
    callbacks.onError?.({ code: 'NO_BODY', message: 'No response body' })
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')
        if (line === '') {
          currentEvent = ''
          continue
        }
        if (line.startsWith(':')) continue // SSE comment
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
          continue
        }
        if (line.startsWith('data: ') && currentEvent) {
          try {
            const data = JSON.parse(line.slice(6)) as Record<string, unknown>
            dispatchIntroEvent(currentEvent, data, callbacks)
          } catch {
            // Ignore malformed frames
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    callbacks.onError?.({
      code: 'STREAM_ERROR',
      message: (err as Error).message || 'Stream read failed',
    })
  }
}

function dispatchIntroEvent(
  event: string,
  data: Record<string, unknown>,
  cb: StreamIntroCallbacks,
): void {
  switch (event) {
    case 'thinking':
      cb.onThinking?.()
      return
    case 'intro':
      if (typeof data.content === 'string') {
        cb.onIntro?.(data.content)
      }
      return
    case 'complete':
      cb.onComplete?.(data.hasIntro === true)
      return
    case 'error':
      cb.onError?.({
        code: (data.code as string) || 'UNKNOWN',
        message: (data.message as string) || 'Unknown error',
      })
      return
  }
}
