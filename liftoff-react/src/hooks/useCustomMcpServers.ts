// Custom MCP Servers React hooks.
// Mirrors useExternalAgents.ts patterns — tenant-scoped React Query.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import {
  listCustomMcpServers,
  getCustomMcpServer,
  createCustomMcpServer,
  updateCustomMcpServer,
  deleteCustomMcpServer,
  rediscoverCustomMcpServer,
  type CreateCustomMcpServerInput,
  type CustomMcpServer,
  type UpdateCustomMcpServerInput,
} from '../services/customMcpServers'
import { track } from '../lib/analytics'

export const customMcpServerKeys = {
  all: ['custom-mcp-servers'] as const,
  lists: (tenantId: string | undefined) =>
    [...customMcpServerKeys.all, 'list', tenantId] as const,
  details: (tenantId: string | undefined) =>
    [...customMcpServerKeys.all, 'detail', tenantId] as const,
  detail: (tenantId: string | undefined, id: string) =>
    [...customMcpServerKeys.details(tenantId), id] as const,
}

export function useCustomMcpServers() {
  const { currentTenant } = useTenant()
  return useQuery({
    queryKey: customMcpServerKeys.lists(currentTenant?.id),
    queryFn: () => listCustomMcpServers(currentTenant!.id),
    enabled: !!currentTenant?.id,
    staleTime: 30_000,
  })
}

export function useCustomMcpServer(id: string | undefined) {
  const { currentTenant } = useTenant()
  return useQuery({
    queryKey: customMcpServerKeys.detail(currentTenant?.id, id ?? ''),
    queryFn: () => getCustomMcpServer(currentTenant!.id, id!),
    enabled: !!currentTenant?.id && !!id,
  })
}

export function useCreateCustomMcpServer() {
  const { currentTenant } = useTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateCustomMcpServerInput): Promise<CustomMcpServer> =>
      createCustomMcpServer(currentTenant!.id, data),
    onSuccess: (server) => {
      track('custom_mcp_server_created', { server_id: server.id })
      qc.invalidateQueries({ queryKey: customMcpServerKeys.lists(currentTenant?.id) })
      qc.invalidateQueries({ queryKey: ['connectors'] })
    },
  })
}

export function useUpdateCustomMcpServer() {
  const { currentTenant } = useTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateCustomMcpServerInput }) =>
      updateCustomMcpServer(currentTenant!.id, id, data),
    onSuccess: (_data, { id }) => {
      track('custom_mcp_server_updated', { server_id: id })
      qc.invalidateQueries({ queryKey: customMcpServerKeys.lists(currentTenant?.id) })
    },
  })
}

export function useDeleteCustomMcpServer() {
  const { currentTenant } = useTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteCustomMcpServer(currentTenant!.id, id),
    onSuccess: (_data, id) => {
      track('custom_mcp_server_deleted', { server_id: id })
      qc.invalidateQueries({ queryKey: customMcpServerKeys.lists(currentTenant?.id) })
      qc.invalidateQueries({ queryKey: ['connectors'] })
    },
  })
}

export function useRediscoverCustomMcpServer() {
  const { currentTenant } = useTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => rediscoverCustomMcpServer(currentTenant!.id, id),
    onSuccess: (_data, id) => {
      track('custom_mcp_server_rediscovered', { server_id: id })
      qc.invalidateQueries({ queryKey: customMcpServerKeys.lists(currentTenant?.id) })
    },
  })
}
