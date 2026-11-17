import { api } from './api'
import type { InsightsTimeRangePreset } from './insights'
import type { LiftoffScoreResponse } from '../types/liftoffScore'

// ── /api/score ──────────────────────────────────────────────────
//
// LiftoffScore for every teammate in the workspace, human and AI. Owner and
// admin only: the backend returns 403 for anyone below admin, and that is the
// real gate. The frontend simply does not call it for other roles.
//
// Separate from /api/insights/report because the permission boundary, the cache
// lifetime (scores are recomputed on a batch cadence, not per report) and the
// refuse-to-rate states all belong to this feature rather than to report
// composition.

/** Fetch LiftoffScore for a tenant and time period. */
export async function getLiftoffScore(
  tenantId: string,
  period: InsightsTimeRangePreset = 'this_month',
): Promise<LiftoffScoreResponse> {
  const params = new URLSearchParams({ tenantId, period })
  return await api.get<LiftoffScoreResponse>(`/api/score?${params.toString()}`)
}
