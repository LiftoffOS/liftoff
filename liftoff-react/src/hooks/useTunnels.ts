// Tunnels React hooks. CRUD over tunnel deployments + routes, token
// rotation, deploy artifact retrieval.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import {
  createTunnelDeployment,
  createTunnelRoute,
  deleteTunnelDeployment,
  deleteTunnelRoute,
  getTunnelDeployment,
  listTunnelDeployments,
  listTunnelRoutes,
  rotateTunnelToken,
  updateTunnelRoute,
  type CreateTunnelDeploymentResult,
  type TunnelDeployment,
  type TunnelRoute,
} from '../services/tunnels'
import { track } from '../lib/analytics'

export const tunnelKeys = {
  all: ['tunnels'] as const,
  deployments: (tenantId: string | undefined) =>
    [...tunnelKeys.all, 'deployments', tenantId] as const,
  deployment: (tenantId: string | undefined, id: string) =>
    [...tunnelKeys.deployments(tenantId), id] as const,
  routes: (tenantId: string | undefined, deploymentId: string | undefined) =>
    [...tunnelKeys.all, 'routes', tenantId, deploymentId ?? 'all'] as const,
}

export function useTunnelDeployments() {
  const { currentTenant } = useTenant()
  return useQuery({
    queryKey: tunnelKeys.deployments(currentTenant?.id),
    queryFn: () => listTunnelDeployments(currentTenant!.id),
    enabled: !!currentTenant?.id,
    staleTime: 15_000,
  })
}

/**
 * Poll a deployment by id. Used by <TunnelSetup /> to watch a pending
 * deployment flip to `active` once the customer's docker container connects.
 * Polls every 3s while status is `pending`; otherwise every 30s.
 */
export function useTunnelDeployment(id: string | undefined) {
  const { currentTenant } = useTenant()
  return useQuery<TunnelDeployment>({
    queryKey: tunnelKeys.deployment(currentTenant?.id, id ?? ''),
    queryFn: () => getTunnelDeployment(currentTenant!.id, id!),
    enabled: !!currentTenant?.id && !!id,
    refetchInterval: (q) => {
      const status = q.state.data?.status
      if (status === 'pending') return 3_000
      return 30_000
    },
  })
}

export function useCreateTunnelDeployment() {
  const { currentTenant } = useTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; tenantPrefix?: string }): Promise<CreateTunnelDeploymentResult> =>
      createTunnelDeployment(currentTenant!.id, data),
    onSuccess: (result) => {
      track('tunnel_deployment_created', { deployment_id: result.deployment.id })
      qc.invalidateQueries({ queryKey: tunnelKeys.deployments(currentTenant?.id) })
    },
  })
}

export function useDeleteTunnelDeployment() {
  const { currentTenant } = useTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteTunnelDeployment(currentTenant!.id, id),
    onSuccess: (_data, id) => {
      track('tunnel_deployment_deleted', { deployment_id: id })
      qc.invalidateQueries({ queryKey: tunnelKeys.deployments(currentTenant?.id) })
    },
  })
}

export function useRotateTunnelToken() {
  const { currentTenant } = useTenant()
  return useMutation({
    mutationFn: (id: string) => rotateTunnelToken(currentTenant!.id, id),
    onSuccess: (_data, id) => {
      track('tunnel_token_rotated', { deployment_id: id })
    },
  })
}

export function useTunnelRoutes(deploymentId?: string) {
  const { currentTenant } = useTenant()
  return useQuery<TunnelRoute[]>({
    queryKey: tunnelKeys.routes(currentTenant?.id, deploymentId),
    queryFn: () => listTunnelRoutes(currentTenant!.id, { deploymentId }),
    enabled: !!currentTenant?.id,
    staleTime: 30_000,
  })
}

export function useCreateTunnelRoute() {
  const { currentTenant } = useTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { deploymentId: string; upstreamUrl: string }) =>
      createTunnelRoute(currentTenant!.id, data),
    onSuccess: (route, vars) => {
      track('tunnel_route_created', { deployment_id: vars.deploymentId, route_id: route.id })
      qc.invalidateQueries({ queryKey: [...tunnelKeys.all, 'routes', currentTenant?.id] })
    },
  })
}

export function useUpdateTunnelRoute() {
  const { currentTenant } = useTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { upstreamUrl?: string } }) =>
      updateTunnelRoute(currentTenant!.id, id, data),
    onSuccess: (route, { id }) => {
      track('tunnel_route_updated', { deployment_id: route.deploymentId, route_id: id })
      qc.invalidateQueries({ queryKey: [...tunnelKeys.all, 'routes', currentTenant?.id] })
    },
  })
}

export function useDeleteTunnelRoute() {
  const { currentTenant } = useTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string; deploymentId: string }) =>
      deleteTunnelRoute(currentTenant!.id, id),
    onSuccess: (_data, { id, deploymentId }) => {
      track('tunnel_route_deleted', { deployment_id: deploymentId, route_id: id })
      qc.invalidateQueries({ queryKey: [...tunnelKeys.all, 'routes', currentTenant?.id] })
    },
  })
}
