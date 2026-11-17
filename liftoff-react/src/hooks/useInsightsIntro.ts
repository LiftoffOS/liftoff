// useInsightsIntro
//
// Drives the LLM-generated "insight intro text" — the one-paragraph
// summary that opens the dashboard above the metric cards. Independent
// of useInsightsReport so the main report (Phase A, instant) and the
// intro (Phase B, ~2 seconds) load in parallel and the report never
// waits on the LLM.
//
// Mirrors useInsightsObservations exactly: same state-reset behavior on
// period change, same AbortController cleanup, same fail-soft contract.
//
// Contract:
//   - Returns `intro` (string | null) and `isLoading`
//   - Starts fetching as soon as a tenant + period are available
//   - Re-fetches when the period changes (re-runs the stream)
//   - Cleans up on unmount / period change via AbortController
//   - NEVER throws — any error (network, SSE error event, abort) sets
//     isLoading=false with intro left at null. The frontend hides the
//     section in that case.

import { useEffect, useRef, useState } from 'react'
import { useTenant } from './useTenant'
import {
  streamInsightsIntro,
  type InsightsTimeRangePreset,
} from '../services/insights'

export function useInsightsIntro(
  period: InsightsTimeRangePreset = 'this_week',
  options: { enabled?: boolean } = {},
) {
  const { currentTenant: tenant } = useTenant()
  const enabled = options.enabled ?? true
  const [intro, setIntro] = useState<string | null>(null)
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

    streamInsightsIntro(
      tenant.id,
      period,
      {
        onIntro: content => {
          setIntro(content)
        },
        onComplete: () => {
          setIsLoading(false)
        },
        onError: () => {
          // Silent failure — the intro is a pure enhancement, not a
          // requirement. The section just stays hidden.
          setIsLoading(false)
        },
      },
      controller.signal,
    )

    return () => {
      controller.abort()
    }
  }, [tenant?.id, period, enabled])

  // Derived, not cleared. A new period sets isLoading before it streams, so
  // this is null for exactly the window the old reset covered: the previous
  // period's intro is never briefly shown, and no effect has to remember.
  return { intro: isLoading ? null : intro, isLoading }
}
