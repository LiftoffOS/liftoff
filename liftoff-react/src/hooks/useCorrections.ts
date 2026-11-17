// Corrections React Query Hooks
// Handles correction options, requests, and history

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import {
  getCorrectionOptions,
  requestCorrection,
  getCorrectionHistory,
  type CorrectionOptions,
  type CorrectionRequestResult,
  type CorrectionHistoryEntry,
} from '../services/corrections'
import { ACTIVITY_LOGS_QUERY_KEY } from './useActivityLogs'

export const CORRECTIONS_QUERY_KEY = ['corrections'] as const

// Get correction options for an audit log
export function useCorrectionOptions(auditLogId: string | undefined) {
  const { currentTenant: tenant } = useAuth()

  return useQuery({
    queryKey: [...CORRECTIONS_QUERY_KEY, 'options', tenant?.id, auditLogId],
    queryFn: () => getCorrectionOptions(tenant!.id, auditLogId!),
    enabled: !!tenant?.id && !!auditLogId,
    staleTime: 30 * 1000, // 30 seconds
  })
}

// Get correction history for an audit log
export function useCorrectionHistory(auditLogId: string | undefined) {
  const { currentTenant: tenant } = useAuth()

  return useQuery({
    queryKey: [...CORRECTIONS_QUERY_KEY, 'history', tenant?.id, auditLogId],
    queryFn: () => getCorrectionHistory(tenant!.id, auditLogId!),
    enabled: !!tenant?.id && !!auditLogId,
    staleTime: 60 * 1000, // 1 minute
  })
}

// Request a correction mutation
export function useRequestCorrection() {
  const { currentTenant: tenant } = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ auditLogId, reason }: { auditLogId: string; reason?: string }) =>
      requestCorrection(tenant!.id, auditLogId, reason),
    onSuccess: (_data, variables) => {
      // Invalidate activity logs to refresh the table
      queryClient.invalidateQueries({ queryKey: ACTIVITY_LOGS_QUERY_KEY })
      // Invalidate correction options for this log
      queryClient.invalidateQueries({
        queryKey: [...CORRECTIONS_QUERY_KEY, 'options', tenant?.id, variables.auditLogId],
      })
      // Invalidate correction history for this log
      queryClient.invalidateQueries({
        queryKey: [...CORRECTIONS_QUERY_KEY, 'history', tenant?.id, variables.auditLogId],
      })
    },
  })
}

// Re-export types for convenience
export type { CorrectionOptions, CorrectionRequestResult, CorrectionHistoryEntry }
