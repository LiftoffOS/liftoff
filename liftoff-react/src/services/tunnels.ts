// Tunnels service.
//
// CRUD over mcp_tunnel_deployments / mcp_tunnel_routes plus token rotation
// and deploy artifact retrieval. The plaintext tunnel token is returned by
// createTunnelDeployment() and rotateTunnelToken() ONCE — the API never
// returns it on subsequent reads. UI must surface it immediately (the
// docker-run snippet inside <TunnelSetup />).

import { api } from './api'

export type TunnelStatus = 'pending' | 'active' | 'disconnected'

export interface TunnelDeployment {
  id: string
  tenantId: string
  name: string
  tenantPrefix: string
  tunnelTokenSecretName: string
  innerTlsEnabled: boolean
  status: TunnelStatus
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TunnelRoute {
  id: string
  deploymentId: string
  subdomain: string
  upstreamUrl: string
  publicUrl: string
  createdAt: string
  updatedAt: string
}

export interface TunnelDeployArtifact {
  image: string
  dockerRunCommand: string
  dockerComposeYaml: string
  terminatorEndpoint: string
}

export interface CreateTunnelDeploymentResult {
  deployment: TunnelDeployment
  tunnelToken: string
  deployArtifact: TunnelDeployArtifact
}

export interface RotateTunnelTokenResult {
  newTunnelToken: string
  previousTokenExpiresAt: string
}

export async function listTunnelDeployments(tenantId: string): Promise<TunnelDeployment[]> {
  const res = await api.get<{ deployments: TunnelDeployment[] }>(
    `/api/tunnel-deployments?tenantId=${tenantId}`,
  )
  return res.deployments
}

export async function getTunnelDeployment(tenantId: string, id: string): Promise<TunnelDeployment> {
  return api.get<TunnelDeployment>(`/api/tunnel-deployments/${id}?tenantId=${tenantId}`)
}

export async function createTunnelDeployment(
  tenantId: string,
  data: { name: string; tenantPrefix?: string },
): Promise<CreateTunnelDeploymentResult> {
  return api.post<CreateTunnelDeploymentResult>(
    `/api/tunnel-deployments?tenantId=${tenantId}`,
    data,
  )
}

export async function deleteTunnelDeployment(tenantId: string, id: string): Promise<void> {
  await api.delete(`/api/tunnel-deployments/${id}?tenantId=${tenantId}`)
}

export async function rotateTunnelToken(tenantId: string, id: string): Promise<RotateTunnelTokenResult> {
  return api.post<RotateTunnelTokenResult>(
    `/api/tunnel-deployments/${id}/rotate-token?tenantId=${tenantId}`,
    {},
  )
}

export async function listTunnelRoutes(
  tenantId: string,
  options: { deploymentId?: string; unbound?: boolean } = {},
): Promise<TunnelRoute[]> {
  const params = new URLSearchParams({ tenantId })
  if (options.deploymentId) params.set('deploymentId', options.deploymentId)
  if (options.unbound) params.set('unbound', 'true')
  const res = await api.get<{ routes: TunnelRoute[] }>(`/api/tunnel-routes?${params.toString()}`)
  return res.routes
}

export async function createTunnelRoute(
  tenantId: string,
  data: { deploymentId: string; upstreamUrl: string },
): Promise<TunnelRoute> {
  return api.post<TunnelRoute>(`/api/tunnel-routes?tenantId=${tenantId}`, data)
}

export async function updateTunnelRoute(
  tenantId: string,
  id: string,
  data: { upstreamUrl?: string },
): Promise<TunnelRoute> {
  return api.patch<TunnelRoute>(`/api/tunnel-routes/${id}?tenantId=${tenantId}`, data)
}

export async function deleteTunnelRoute(tenantId: string, id: string): Promise<void> {
  await api.delete(`/api/tunnel-routes/${id}?tenantId=${tenantId}`)
}
