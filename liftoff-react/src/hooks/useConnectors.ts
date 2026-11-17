import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listConnectors,
  deleteConnector,
} from '../services/connections'
import { useAuth } from '../contexts/AuthContext'
import { INTERNAL_AGENTS_QUERY_KEY } from './useInternalAgents'

export const CONNECTORS_QUERY_KEY = ['connectors'] as const

export function useConnectors() {
  const { currentTenant: tenant } = useAuth()

  return useQuery({
    queryKey: [...CONNECTORS_QUERY_KEY, tenant?.id],
    queryFn: () => listConnectors(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 30 * 1000, // 30 seconds - shorter to catch new connections quickly
    refetchOnMount: 'always', // Always refetch when component mounts
    refetchOnWindowFocus: true, // Refetch when user returns to tab
  })
}

export function useDeleteConnector() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useAuth()

  return useMutation({
    mutationFn: (connectorId: string) => deleteConnector(connectorId, tenant!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY })
      // The connector.deleted event triggers a backend scrub of dead
      // connector UUIDs from internal_agents.integrations (see
      // platform-backend src/internal-agents/connector-binding-cleanup-service.ts).
      // Invalidate the agents cache so /teams/update re-reads the
      // scrubbed array without waiting for the stale window. Pub/Sub
      // round-trip is sub-second in practice.
      queryClient.invalidateQueries({ queryKey: INTERNAL_AGENTS_QUERY_KEY })
    },
  })
}

export function usePrefetchConnectors() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useAuth()

  return () => {
    if (tenant?.id) {
      queryClient.prefetchQuery({
        queryKey: [...CONNECTORS_QUERY_KEY, tenant.id],
        queryFn: () => listConnectors(tenant.id),
        staleTime: 30 * 1000,
      })
    }
  }
}
