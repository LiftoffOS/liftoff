import { useQuery } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import { getInsightsReport, type InsightsTimeRangePreset } from '../services/insights'

const INSIGHTS_REPORT_QUERY_KEY = ['insights-report'] as const

export function useInsightsReport(
  period: InsightsTimeRangePreset = 'this_week',
  options: { enabled?: boolean } = {},
) {
  const { currentTenant: tenant } = useTenant()
  const callerEnabled = options.enabled ?? true

  const query = useQuery({
    queryKey: [...INSIGHTS_REPORT_QUERY_KEY, tenant?.id, period],
    queryFn: () => getInsightsReport(tenant!.id, period),
    enabled: !!tenant?.id && callerEnabled,
    staleTime: 2 * 60 * 1000, // 2 minutes
  })

  return {
    blocks: query.data?.blocks ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  }
}
