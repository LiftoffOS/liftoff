// Run again (ADR-030) React Query hook.
// Re-runs a failed autonomous run and refreshes the activity feed so the new
// run appears. The component owns the success/error toast (matching
// useRequestCorrection).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { rerunActivityRun } from '../services/activityLogs'
import { ACTIVITY_LOGS_QUERY_KEY } from './useActivityLogs'

export function useRerunRun() {
  const { currentTenant: tenant } = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ internalAgentId, invocationId }: { internalAgentId: string; invocationId: string }) =>
      rerunActivityRun(tenant!.id, internalAgentId, invocationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ACTIVITY_LOGS_QUERY_KEY })
    },
  })
}
