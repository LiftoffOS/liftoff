// useLiftoffScore
//
// LiftoffScore for the Insights report. The flag gate and the role gate live
// here rather than in the page, so no caller can fire the request for a viewer
// who must not see it.
//
// Fail-soft, matching the intro and observations streams: any error resolves to
// an absent section rather than a toast. A 403 or 404 is a terminal answer, not
// a transient fault, so it is never retried.

import { useQuery } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import { useAuth } from '../contexts/AuthContext'
import { useFeatureFlags } from '../contexts/FeatureFlagsContext'
import { ApiError } from '../services/api'
import { getLiftoffScore } from '../services/liftoffScore'
import type { InsightsTimeRangePreset } from '../services/insights'
import type { LiftoffScoreResponse } from '../types/liftoffScore'

export const LIFTOFF_SCORE_QUERY_KEY = ['score'] as const

interface UseLiftoffScoreOptions {
  /** Caller-side gate. InsightsPage passes its cheap counts probe through here. */
  enabled?: boolean
}

export function useLiftoffScore(
  period: InsightsTimeRangePreset,
  options: UseLiftoffScoreOptions = {},
) {
  const { enabled: callerEnabled = true } = options
  const { currentTenant: tenant } = useTenant()
  const { canManageMembers } = useAuth()
  const { liftoffScoreEnabled } = useFeatureFlags()

  const allowed = liftoffScoreEnabled && canManageMembers()

  const query = useQuery<LiftoffScoreResponse>({
    queryKey: [...LIFTOFF_SCORE_QUERY_KEY, tenant?.id, period],
    queryFn: () => getLiftoffScore(tenant!.id, period),
    enabled: !!tenant?.id && callerEnabled && allowed,
    // Recomputed on a batch cadence, so the list should not jitter in a session.
    staleTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        return false
      }
      return failureCount < 1
    },
  })

  return {
    scores: query.data,
    isLoading: query.isLoading && query.fetchStatus !== 'idle',
    error: query.error,
  }
}
