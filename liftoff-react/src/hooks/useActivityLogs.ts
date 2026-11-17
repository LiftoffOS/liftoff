// Activity Logs React Query Hooks
// Fetches agent audit logs with pagination and filtering

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import {
  listActivityLogs,
  getActivityLog,
  type ActivityLogFilters,
  type PaginatedActivityLogsResponse,
} from '../services/activityLogs'

export const ACTIVITY_LOGS_QUERY_KEY = ['activity-logs'] as const

// List activity logs with infinite scroll pagination
export function useActivityLogs(filters?: ActivityLogFilters) {
  const { currentTenant: tenant } = useAuth()

  return useInfiniteQuery({
    queryKey: [...ACTIVITY_LOGS_QUERY_KEY, tenant?.id, filters],
    queryFn: ({ pageParam }) =>
      listActivityLogs(tenant!.id, {
        cursor: pageParam,
        limit: 25,
        filters,
      }),
    getNextPageParam: (lastPage: PaginatedActivityLogsResponse) =>
      lastPage.hasMore ? lastPage.cursor : undefined,
    initialPageParam: undefined as string | undefined,
    enabled: !!tenant?.id,
    staleTime: 30 * 1000, // 30 seconds
    refetchInterval: 60 * 1000, // Refetch every minute for live updates
  })
}

// Get a single activity log
export function useActivityLog(logId: string | undefined) {
  const { currentTenant: tenant } = useAuth()

  return useQuery({
    queryKey: [...ACTIVITY_LOGS_QUERY_KEY, tenant?.id, logId],
    queryFn: () => getActivityLog(tenant!.id, logId!),
    enabled: !!tenant?.id && !!logId,
    staleTime: 60 * 1000,
  })
}
