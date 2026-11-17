// A custom API connection's repair controls, as React Query.
//
// Mirrors useCustomMcpServers.ts — the closest thing in the app, and for the
// same reason: both are per-instance connectors whose detail lives outside the
// connector row, so the Connections tile can only show them by asking.
//
// Four controls, none of which implies another. Three are here; removing the
// connection is `useDeleteConnector`, which the page already has.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import {
  getCustomApiConnection,
  refreshCustomApiSpec,
  reverifyCustomApiConnection,
  updateCustomApiConnection,
  type CustomApiConnectionChanges,
} from '../services/customApiCapture'
import { CONNECTORS_QUERY_KEY } from './useConnectors'

export const customApiConnectionKeys = {
  all: ['custom-api-connections'] as const,
  detail: (tenantId: string | undefined, connectorId: string) =>
    [...customApiConnectionKeys.all, tenantId, connectorId] as const,
}

export function useCustomApiConnection(connectorId: string | undefined) {
  const { currentTenant } = useTenant()
  return useQuery({
    queryKey: customApiConnectionKeys.detail(currentTenant?.id, connectorId ?? ''),
    queryFn: () => getCustomApiConnection(connectorId!, currentTenant!.id),
    enabled: !!connectorId && !!currentTenant?.id,
    staleTime: 30_000,
  })
}

/** Edit hosts, placement or verification in place. The connector id is kept,
 *  so every bound agent keeps working and no tool is renamed. */
export function useUpdateCustomApiConnection() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { connectorId: string; changes: CustomApiConnectionChanges }) =>
      updateCustomApiConnection({ ...input, tenantId: currentTenant!.id }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: customApiConnectionKeys.detail(currentTenant?.id, variables.connectorId),
      })
      // The edit re-runs the verification, so the connector row's status may
      // have moved in either direction. The tile reads that row.
      void queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY })
    },
  })
}

/** Re-run the declared verification with the key already in custody — the
 *  repair for a connection that broke without the key changing. */
export function useReverifyCustomApiConnection() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (connectorId: string) =>
      reverifyCustomApiConnection({ connectorId, tenantId: currentTenant!.id }),
    onSuccess: (_data, connectorId) => {
      void queryClient.invalidateQueries({
        queryKey: customApiConnectionKeys.detail(currentTenant?.id, connectorId),
      })
      void queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY })
    },
  })
}

/** Read the provider's specification again. `apply` is the second step: the
 *  first reports what changed and writes nothing. */
export function useRefreshCustomApiSpec() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (args: { connectorId: string; apply?: boolean }) =>
      refreshCustomApiSpec({ ...args, tenantId: currentTenant!.id }),
    onSuccess: (data, args) => {
      if (!data.applied) return
      void queryClient.invalidateQueries({
        queryKey: customApiConnectionKeys.detail(currentTenant?.id, args.connectorId),
      })
      void queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY })
    },
  })
}
