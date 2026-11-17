// useInsightsCounts
//
// Cheap all-time probe (~50ms backend, three SELECT COUNT(*) queries) that
// tells the InsightsPage whether the tenant has any data at all. The page
// gates the expensive report / intro / observations fetches on the result,
// so a brand-new workspace renders the empty-state text instantly instead
// of staring at a 2-3s skeleton.
//
// Auto-refetches:
//   - on window focus (default React Query behavior) — covers "user created
//     an agent in another tab, comes back to /insights"
//   - after 30s stale time — covers slow drift (first invocation lands in
//     the background, page is left open)
//
// Cache invalidation on agent creation lives in useCreateInternalAgent so
// the empty → non-empty flip is instant for same-tab same-session creates.

import { useQuery } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import {
  getInsightsCounts,
  type InsightsCountsResponse,
} from '../services/insights'

export const INSIGHTS_COUNTS_QUERY_KEY = ['insights-counts'] as const

export function useInsightsCounts() {
  const { currentTenant: tenant } = useTenant()

  const query = useQuery<InsightsCountsResponse>({
    queryKey: [...INSIGHTS_COUNTS_QUERY_KEY, tenant?.id],
    queryFn: () => getInsightsCounts(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 30 * 1000,
  })

  return {
    counts: query.data,
    isLoading: query.isLoading,
    error: query.error,
  }
}
