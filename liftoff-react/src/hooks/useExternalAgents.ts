// External Agents React Hooks
// TanStack Query hooks for external agent data management
// Follows useTeams.ts patterns for consistency

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import {
  listExternalAgents,
  getExternalAgent,
  createExternalAgent,
  updateExternalAgent,
  updateExternalAgentStatus,
  deleteExternalAgent,
  discoverExternalAgentStream,
  getExternalAgentVersions,
  rollbackExternalAgentVersion,
  getUserFriendlyErrorMessage,
  type ExternalAgent,
  type ExternalAgentStatus,
  type CreateExternalAgentInput,
  type UpdateExternalAgentInput,
  type DiscoverInput,
  type DiscoverStreamCallbacks,
} from '../services/externalAgents'
import { auth } from '../config/firebase'
import { WORKFORCE_QUERY_KEY } from './useWorkforce'
import { track } from '../lib/analytics'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

// Query keys for cache management.
// Every key includes the tenantId — without it, React Query would share cache
// slots across tenants. When a user switches workspaces, the hook would return
// the previous tenant's data until the next refetch (cross-tenant cache
// pollution). Matches the tenant-scoping convention used by every other
// tenant-scoped hook in the codebase.
export const externalAgentKeys = {
  all: ['external-agents'] as const,
  lists: (tenantId: string | undefined) =>
    [...externalAgentKeys.all, 'list', tenantId] as const,
  list: (tenantId: string | undefined, filters: { status?: string }) =>
    [...externalAgentKeys.lists(tenantId), filters] as const,
  details: (tenantId: string | undefined) =>
    [...externalAgentKeys.all, 'detail', tenantId] as const,
  detail: (tenantId: string | undefined, id: string) =>
    [...externalAgentKeys.details(tenantId), id] as const,
  versions: (tenantId: string | undefined, id: string) =>
    [...externalAgentKeys.detail(tenantId, id), 'versions'] as const,
}

// Hook: List all external agents
export function useExternalAgents(options?: { status?: ExternalAgentStatus }) {
  const { currentTenant } = useTenant()

  return useQuery({
    queryKey: externalAgentKeys.list(currentTenant?.id, options || {}),
    queryFn: () => listExternalAgents(currentTenant!.id, options),
    enabled: !!currentTenant?.id,
    staleTime: 30_000, // 30 seconds
    refetchInterval: 60_000, // Poll every 60 seconds for status changes (EA-003)
  })
}

// Hook: Get single external agent
export function useExternalAgent(agentId: string | undefined) {
  const { currentTenant } = useTenant()

  return useQuery({
    queryKey: externalAgentKeys.detail(currentTenant?.id, agentId || ''),
    queryFn: () => getExternalAgent(agentId!, currentTenant!.id),
    enabled: !!currentTenant?.id && !!agentId,
    staleTime: 30_000,
  })
}

// Hook: Create external agent
export function useCreateExternalAgent() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: CreateExternalAgentInput) => {
      const idempotencyKey = `create-external-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`
      return createExternalAgent(currentTenant!.id, data, idempotencyKey)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: externalAgentKeys.lists(currentTenant?.id) })
    },
  })
}

// Hook: Update external agent
export function useUpdateExternalAgent() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ agentId, data }: { agentId: string; data: UpdateExternalAgentInput }) =>
      updateExternalAgent(agentId, currentTenant!.id, data),
    onSuccess: (updatedAgent, { agentId }) => {
      track('agent_updated', { agent_id: agentId, kind: 'external' })
      queryClient.setQueryData(externalAgentKeys.detail(currentTenant?.id, agentId), updatedAgent)
      queryClient.invalidateQueries({ queryKey: externalAgentKeys.lists(currentTenant?.id) })
    },
  })
}

// Hook: Update external agent status
export function useUpdateExternalAgentStatus() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ agentId, status }: { agentId: string; status: ExternalAgentStatus }) =>
      updateExternalAgentStatus(agentId, currentTenant!.id, status),
    onSuccess: (updatedAgent, { agentId, status }) => {
      track('agent_status_changed', { agent_id: agentId, kind: 'external', status })
      queryClient.setQueryData(externalAgentKeys.detail(currentTenant?.id, agentId), updatedAgent)
      queryClient.invalidateQueries({ queryKey: externalAgentKeys.lists(currentTenant?.id) })
      queryClient.invalidateQueries({ queryKey: [...WORKFORCE_QUERY_KEY, currentTenant?.id ?? ''] })
    },
  })
}

// Hook: Delete external agent
export function useDeleteExternalAgent() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (agentId: string) => deleteExternalAgent(agentId, currentTenant!.id),
    onSuccess: (_data, agentId) => {
      track('agent_deleted', { agent_id: agentId, kind: 'external' })
      queryClient.invalidateQueries({ queryKey: externalAgentKeys.lists(currentTenant?.id) })
      queryClient.invalidateQueries({ queryKey: [...WORKFORCE_QUERY_KEY, currentTenant?.id ?? ''] })
    },
  })
}

// Hook: Discover external agent (SSE streaming)
// Returns mutation that streams progress to callbacks
export function useDiscoverExternalAgent() {
  const { currentTenant } = useTenant()

  return useMutation({
    mutationFn: ({
      input,
      callbacks,
    }: {
      input: DiscoverInput
      callbacks: DiscoverStreamCallbacks
    }) => {
      if (!currentTenant?.id) {
        callbacks.onError(new Error('No tenant selected. Please refresh the page.'))
        return Promise.resolve()
      }
      return discoverExternalAgentStream(currentTenant.id, input, callbacks)
    },
  })
}

// Hook: Re-discover external agent capabilities
// Used when user clicks "Rediscover Capabilities" button
export function useRediscoverCapabilities() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      agentId,
      callbacks,
    }: {
      agentId: string
      callbacks: DiscoverStreamCallbacks
    }) => {
      // Call special re-discover endpoint that uses stored credentials
      const token = await auth.currentUser?.getIdToken()

      const response = await fetch(
        `${API_BASE_URL}/api/external-agents/${agentId}/rediscover-stream?tenantId=${currentTenant!.id}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { Authorization: `Bearer ${token}` }),
          },
        }
      )

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Request failed' }))
        const rawMessage = error.message || `HTTP ${response.status}`
        const friendlyError = new Error(getUserFriendlyErrorMessage(rawMessage, response.status))
        callbacks.onError(friendlyError)
        throw friendlyError
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      if (!reader) {
        const noReaderError = new Error('Unable to connect. Please try again.')
        callbacks.onError(noReaderError)
        throw noReaderError
      }

      let buffer = ''
      let streamErrored: Error | null = null

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Parse SSE events from buffer
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          let currentEvent = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7)
            } else if (line.startsWith('data: ') && currentEvent) {
              try {
                const data = JSON.parse(line.slice(6))

                if (currentEvent === 'progress') {
                  callbacks.onProgress(data.stage)
                } else if (currentEvent === 'complete') {
                  callbacks.onComplete(data)
                } else if (currentEvent === 'error') {
                  streamErrored = new Error(getUserFriendlyErrorMessage(data.message))
                  callbacks.onError(streamErrored)
                }
              } catch {
                // Ignore JSON parse errors
              }
              currentEvent = ''
            }
          }
        }
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'Connection interrupted'
        const friendlyError = new Error(getUserFriendlyErrorMessage(rawMessage))
        callbacks.onError(friendlyError)
        throw friendlyError
      }

      if (streamErrored) throw streamErrored
    },
    onSuccess: (_, { agentId }) => {
      track('agent_rediscovered', { agent_id: agentId, kind: 'external' })
      queryClient.invalidateQueries({ queryKey: externalAgentKeys.detail(currentTenant?.id, agentId) })
      queryClient.invalidateQueries({ queryKey: externalAgentKeys.lists(currentTenant?.id) })
    },
  })
}

// Hook: Get version history for an external agent
export function useExternalAgentVersions(agentId: string | undefined) {
  const { currentTenant } = useTenant()

  return useQuery({
    queryKey: externalAgentKeys.versions(currentTenant?.id, agentId || ''),
    queryFn: () => getExternalAgentVersions(agentId!, currentTenant!.id),
    enabled: !!currentTenant?.id && !!agentId,
    staleTime: 30_000,
  })
}

// Hook: Rollback external agent to a specific version
export function useRollbackExternalAgent() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ agentId, version }: { agentId: string; version: number }) =>
      rollbackExternalAgentVersion(agentId, currentTenant!.id, version),
    onSuccess: (updatedAgent: ExternalAgent, { version }) => {
      track('agent_rolled_back', { agent_id: updatedAgent.id, kind: 'external', to_version: version })
      queryClient.setQueryData(externalAgentKeys.detail(currentTenant?.id, updatedAgent.id), updatedAgent)
      queryClient.invalidateQueries({ queryKey: externalAgentKeys.lists(currentTenant?.id) })
      queryClient.invalidateQueries({ queryKey: externalAgentKeys.versions(currentTenant?.id, updatedAgent.id) })
    },
  })
}
