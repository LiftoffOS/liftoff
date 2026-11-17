import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listPersonnelWithAssignments,
  updatePersonAssignments,
} from '../services/personAssignments'
import { useTenant } from './useTenant'
import { WORKFORCE_QUERY_KEY } from './useWorkforce'

export const PERSONNEL_ASSIGNMENTS_KEY = ['personnel-assignments'] as const

export function usePersonnelWithAssignments() {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...PERSONNEL_ASSIGNMENTS_KEY, tenant?.id],
    queryFn: () => listPersonnelWithAssignments(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 2 * 60 * 1000,
  })
}

export function useUpdatePersonAssignments() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: ({ accountId, assignments }: {
      accountId: string
      assignments: Array<{ agentId: string; agentType: 'internal' | 'external' }>
    }) => updatePersonAssignments(tenant!.id, accountId, assignments),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PERSONNEL_ASSIGNMENTS_KEY })
      queryClient.invalidateQueries({ queryKey: [...WORKFORCE_QUERY_KEY, tenant?.id ?? ''] })
    },
  })
}
