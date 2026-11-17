// Custom MCP Server service.
//
// Mirrors src/services/externalAgents.ts. The backend's
// /api/custom-mcp-servers endpoints accept the same single-form payload
// the ConnectCustomMcpServerModal submits.

import { api } from './api'

export type CustomMcpServerDeliveryMode = 'public_url' | 'tunneled'
export type AuthType = 'none' | 'api_key' | 'bearer_token' | 'custom_headers'

export interface CustomHeader {
  key: string
  value: string
}

export interface CustomMcpServer {
  id: string
  tenantId: string
  name: string
  deliveryMode: CustomMcpServerDeliveryMode
  endpointUrl: string
  authType: AuthType
  authSecretName: string | null
  tunnelRouteId: string | null
  rawMcpTools: unknown[]
  connectorId: string
  createdAt: string
  updatedAt: string
}

export interface CreateCustomMcpServerInput {
  name: string
  deliveryMode: CustomMcpServerDeliveryMode
  endpointUrl?: string
  authType: AuthType
  apiKey?: string
  bearerToken?: string
  customHeaders?: CustomHeader[]
  tunnelRouteId?: string
}

/**
 * Everything about a registered MCP server that can change without it becoming
 * a different server.
 *
 * `name` used to be the only editable field, which left a server whose
 * endpoint moved or whose token rotated unrepairable: the only way out was
 * removing it and adding it again, and removing it takes its connector id with
 * it, so every agent bound to that server had to be bound again by hand.
 * Editing in place keeps the id, so every bound team recovers at once.
 *
 * Credentials are write-only. The modal shows a masked placeholder it cannot
 * read back, so omitting them means "leave the stored value alone" rather than
 * "clear it".
 */
export interface UpdateCustomMcpServerInput {
  name?: string
  /** Ignored for tunneled servers, which resolve their endpoint from the tunnel route. */
  endpointUrl?: string
  authType?: AuthType
  apiKey?: string
  bearerToken?: string
  customHeaders?: CustomHeader[]
}

export async function listCustomMcpServers(tenantId: string): Promise<CustomMcpServer[]> {
  const res = await api.get<{ servers: CustomMcpServer[] }>(
    `/api/custom-mcp-servers?tenantId=${tenantId}`,
  )
  return res.servers
}

export async function getCustomMcpServer(tenantId: string, id: string): Promise<CustomMcpServer> {
  return api.get<CustomMcpServer>(`/api/custom-mcp-servers/${id}?tenantId=${tenantId}`)
}

export async function createCustomMcpServer(
  tenantId: string,
  data: CreateCustomMcpServerInput,
): Promise<CustomMcpServer> {
  return api.post<CustomMcpServer>(
    `/api/custom-mcp-servers?tenantId=${tenantId}`,
    data,
  )
}

export async function updateCustomMcpServer(
  tenantId: string,
  id: string,
  data: UpdateCustomMcpServerInput,
): Promise<CustomMcpServer> {
  return api.patch<CustomMcpServer>(`/api/custom-mcp-servers/${id}?tenantId=${tenantId}`, data)
}

export async function deleteCustomMcpServer(tenantId: string, id: string): Promise<void> {
  await api.delete(`/api/custom-mcp-servers/${id}?tenantId=${tenantId}`)
}

export async function rediscoverCustomMcpServer(
  tenantId: string,
  id: string,
): Promise<CustomMcpServer> {
  return api.post<CustomMcpServer>(`/api/custom-mcp-servers/${id}/rediscover?tenantId=${tenantId}`, {})
}
