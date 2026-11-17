// useInsightsObservations — Phase 7
//
// Drives the LLM-generated Key Observations section of the insights
// dashboard. Independent of useInsightsReport so the main report (Phase
// A, instant) and the observations (Phase B, 2-3 seconds) load in
// parallel and the report never waits on the LLM.
//
// Contract:
//   - Returns `observations` (ObservationBlock[]) and `isLoading`
//   - Starts fetching as soon as a tenant + period are available
//   - Re-fetches when the period changes (re-runs the stream)
//   - Cleans up on unmount / period change via AbortController
//   - NEVER throws — any error (network, SSE error event, abort) sets
//     isLoading=false with observations left at whatever arrived so far
//     (typically [])

import { useEffect, useRef, useState } from 'react'
import { useTenant } from './useTenant'
import {
  streamInsightsObservations,
  type InsightsTimeRangePreset,
} from '../services/insights'
import type { ObservationBlock } from '../types/insights'

/** Stable empty array, so a consumer memoising on this does not see a new
 *  dependency on every render while a period loads. */
const NO_OBSERVATIONS: ObservationBlock[] = []

export function useInsightsObservations(
  period: InsightsTimeRangePreset = 'this_week',
  options: { enabled?: boolean } = {},
) {
  const { currentTenant: tenant } = useTenant()
  const enabled = options.enabled ?? true
  const [observations, setObservations] = useState<ObservationBlock[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  // A change of workspace or period starts a new stream, and the section is
  // loading from that moment. Said here rather than in the effect below, so
  // there is no frame showing the previous period's result as settled.
  const streamKey = tenant?.id && enabled ? `${tenant.id}|${period}` : null
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  if (streamKey && streamKey !== loadingKey) {
    setLoadingKey(streamKey)
    setIsLoading(true)
  }

  useEffect(() => {
    if (!tenant?.id || !enabled) return

    // Abort any in-flight stream from a previous effect invocation. The
    // AbortSignal check inside the stream function bails out gracefully
    // before any callback fires.
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    streamInsightsObservations(
      tenant.id,
      period,
      {
        onObservation: block => {
          setObservations(prev => [...prev, block])
        },
        onComplete: () => {
          setIsLoading(false)
        },
        onError: () => {
          // Silent failure per Phase 7 plan — observations are a pure
          // enhancement, not a requirement. The section just stays empty.
          setIsLoading(false)
        },
      },
      controller.signal,
    )

    return () => {
      controller.abort()
    }
  }, [tenant?.id, period, enabled])

  // Derived, not cleared, for the same reason as useInsightsIntro: a new
  // period sets isLoading before it streams, so the previous period's
  // observations are never briefly shown.
  return { observations: isLoading ? NO_OBSERVATIONS : observations, isLoading }
}
