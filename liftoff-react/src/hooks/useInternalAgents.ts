import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query'
import { ApiError } from '../services/api'
import {
  listInternalAgents,
  getInternalAgent,
  createInternalAgent,
  updateInternalAgent,
  updateInternalAgentStatus,
  deleteInternalAgent,
  distillInternalAgent,
  getInternalAgentVersions,
  rollbackInternalAgentVersion,
  getRecentlyViewedInternalAgents,
  recordInternalAgentView,
  listAgentMemories,
  getAgentSkills,
  getAgentWebhook,
  provisionAgentWebhook,
  resetAgentWebhookCredentials,
  updateAgentWebhook,
  listAgentWebhookDeliveries,
  type InternalAgentStatus,
  type CreateInternalAgentInput,
  type UpdateInternalAgentInput,
  type DistillInput,
  type PaginatedInternalAgentsResponse,
  type AgentMemory,
  type AgentMemoriesResponse,
  type AgentSkill,
  type AgentSkillsResponse,
  type AgentWebhookMetadata,
  type AgentWebhookCredentials,
  type AgentWebhookDelivery,
  type AgentWebhookDeliveriesResponse,
  type UpdateAgentWebhookInput,
} from '../services/internalAgents'
import { useTenant } from './useTenant'
import { WORKFORCE_QUERY_KEY } from './useWorkforce'
import { INSIGHTS_COUNTS_QUERY_KEY } from './useInsightsCounts'
import type { InternalAgent } from '../services/internalAgents'
import { track } from '../lib/analytics'

export const INTERNAL_AGENTS_QUERY_KEY = ['internal-agents'] as const

const retryOnServerError = (_: number, error: unknown) =>
  !(error instanceof ApiError && error.status < 500)

// List internal agents with pagination support (BE-001)
export function useInternalAgents(options?: { status?: InternalAgentStatus }) {
  const { currentTenant: tenant } = useTenant()

  return useInfiniteQuery({
    queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, options?.status],
    queryFn: ({ pageParam }) =>
      listInternalAgents(tenant!.id, { cursor: pageParam, status: options?.status }),
    getNextPageParam: (lastPage) => lastPage.cursor,
    initialPageParam: undefined as string | undefined,
    enabled: !!tenant?.id,
    staleTime: 2 * 60 * 1000,
    retry: retryOnServerError,
  })
}

// Get a single internal agent by ID
export function useInternalAgent(internalAgentId: string | undefined) {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, internalAgentId],
    queryFn: () => getInternalAgent(internalAgentId!, tenant!.id),
    enabled: !!tenant?.id && !!internalAgentId,
    staleTime: 2 * 60 * 1000,
    retry: retryOnServerError,
  })
}

// Create an internal agent with idempotency key (DE-001)
export function useCreateInternalAgent() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (data: CreateInternalAgentInput) => {
      const idempotencyKey = crypto.randomUUID()
      return createInternalAgent(tenant!.id, data, idempotencyKey)
    },
    onSuccess: (createdInternalAgent) => {
      // Tenant-scoped invalidation — without `tenant?.id` in the key prefix,
      // every other tenant's cached internal-agents list would also be
      // marked stale (cross-tenant cache pollution on every mutation).
      queryClient.invalidateQueries({ queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id] })
      // Insights empty-state probe is keyed on agent count; invalidate so a
      // user who just created their first agent stops seeing the onboarding
      // text on /insights without waiting for the 30s stale window.
      queryClient.invalidateQueries({ queryKey: [...INSIGHTS_COUNTS_QUERY_KEY, tenant?.id] })
      // Record a view for the newly created internal agent so it appears in Recent Teams
      recordInternalAgentView(tenant!.id, createdInternalAgent.id, 'teams_list').then(() => {
        queryClient.invalidateQueries({ queryKey: ['recently-viewed-internal-agents', tenant?.id] })
      })
    },
  })
}

// Update an internal agent
export function useUpdateInternalAgent() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: ({ internalAgentId, data }: { internalAgentId: string; data: UpdateInternalAgentInput }) =>
      updateInternalAgent(internalAgentId, tenant!.id, data),
    onSuccess: (updatedInternalAgent) => {
      track('agent_updated', { agent_id: updatedInternalAgent.id, kind: 'internal' })
      // Update cache for the specific internal agent
      queryClient.setQueryData(
        [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, updatedInternalAgent.id],
        updatedInternalAgent
      )
      // Invalidate list queries and the skills cache so the next open of
      // Advanced Settings fetches fresh data after the Pub/Sub event lands.
      queryClient.invalidateQueries({ queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id] })
      queryClient.invalidateQueries({
        queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, updatedInternalAgent.id, 'skills'],
      })
    },
  })
}

// Update internal agent status (activate/pause)
export function useUpdateInternalAgentStatus() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: ({ internalAgentId, status }: { internalAgentId: string; status: InternalAgentStatus }) =>
      updateInternalAgentStatus(internalAgentId, tenant!.id, status),
    onSuccess: (updatedInternalAgent) => {
      track('agent_status_changed', {
        agent_id: updatedInternalAgent.id,
        kind: 'internal',
        status: updatedInternalAgent.status as 'active' | 'paused' | 'draft',
      })
      queryClient.setQueryData(
        [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, updatedInternalAgent.id],
        updatedInternalAgent
      )
      queryClient.invalidateQueries({ queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id] })
      queryClient.invalidateQueries({ queryKey: [...WORKFORCE_QUERY_KEY, tenant?.id ?? ''] })
    },
  })
}

// Delete an internal agent with optimistic update (FE-004)
export function useDeleteInternalAgent() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (internalAgentId: string) => deleteInternalAgent(internalAgentId, tenant!.id),
    onMutate: async (internalAgentId) => {
      // Cancel outgoing refetches — tenant-scoped so we don't also cancel
      // refetches of internal-agents queries belonging to other workspaces
      // the user has open in other tabs.
      await queryClient.cancelQueries({ queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id] })

      // Snapshot the previous value
      const previousData = queryClient.getQueryData<
        InfiniteData<PaginatedInternalAgentsResponse>
      >([...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, undefined])

      // Optimistically update the cache
      queryClient.setQueryData<InfiniteData<PaginatedInternalAgentsResponse>>(
        [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, undefined],
        (old) => {
          if (!old) return old
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              internalAgents: page.internalAgents.filter((a) => a.id !== internalAgentId),
              total: page.total - 1,
            })),
          }
        }
      )

      return { previousData }
    },
    onError: (_err, _internalAgentId, context) => {
      // Rollback on error
      if (context?.previousData) {
        queryClient.setQueryData(
          [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, undefined],
          context.previousData
        )
      }
    },
    onSuccess: (_data, internalAgentId) => {
      track('agent_deleted', { agent_id: internalAgentId, kind: 'internal' })
    },
    onSettled: () => {
      // Refetch to ensure server state
      queryClient.invalidateQueries({ queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id] })
      queryClient.invalidateQueries({ queryKey: [...WORKFORCE_QUERY_KEY, tenant?.id ?? ''] })
    },
  })
}

// Distill internal agent configuration using LLM
export function useDistillInternalAgent() {
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (input: DistillInput) => distillInternalAgent(tenant!.id, input),
  })
}

// Get version history for an internal agent
export function useInternalAgentVersions(internalAgentId: string | undefined) {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, internalAgentId, 'versions'],
    queryFn: () => getInternalAgentVersions(internalAgentId!, tenant!.id),
    enabled: !!tenant?.id && !!internalAgentId,
    staleTime: 30 * 1000,
    retry: retryOnServerError,
  })
}

// Rollback internal agent to a specific version
export function useRollbackInternalAgent() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: ({ internalAgentId, version }: { internalAgentId: string; version: number }) =>
      rollbackInternalAgentVersion(internalAgentId, tenant!.id, version),
    onSuccess: (updatedInternalAgent: InternalAgent, { version }) => {
      track('agent_rolled_back', { agent_id: updatedInternalAgent.id, kind: 'internal', to_version: version })
      // Update cache for the specific internal agent
      queryClient.setQueryData(
        [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, updatedInternalAgent.id],
        updatedInternalAgent
      )
      // Invalidate list queries and version history
      queryClient.invalidateQueries({ queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id] })
    },
  })
}

// Prefetch internal agents for navigation
export function usePrefetchInternalAgents() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return () => {
    if (tenant?.id) {
      queryClient.prefetchInfiniteQuery({
        queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant.id, undefined],
        queryFn: ({ pageParam }) =>
          listInternalAgents(tenant.id, { cursor: pageParam }),
        initialPageParam: undefined as string | undefined,
        staleTime: 2 * 60 * 1000,
      })
    }
  }
}

export function useRecentlyViewedInternalAgents(limit: number = 6) {
  const { currentTenant } = useTenant()

  return useQuery({
    queryKey: ['recently-viewed-internal-agents', currentTenant?.id, limit],
    queryFn: () => getRecentlyViewedInternalAgents(currentTenant!.id, limit),
    enabled: !!currentTenant?.id,
    staleTime: 2 * 60 * 1000,
    retry: retryOnServerError,
  })
}

export function useRecordInternalAgentView() {
  const queryClient = useQueryClient()
  const { currentTenant } = useTenant()

  return useMutation({
    mutationFn: ({ internalAgentId, source }: { internalAgentId: string; source?: 'dashboard' | 'teams_list' | 'direct_link' }) =>
      recordInternalAgentView(currentTenant!.id, internalAgentId, source),
    onSuccess: (_data, { internalAgentId, source }) => {
      track('agent_viewed', { agent_id: internalAgentId, kind: 'internal', source: source ?? 'direct_link' })
      queryClient.invalidateQueries({ queryKey: ['recently-viewed-internal-agents', currentTenant?.id] })
    },
    onError: (error) => {
      console.warn('Failed to record internal agent view:', error)
    },
  })
}

export function useAgentMemories(internalAgentId: string | undefined, opts: { enabled?: boolean } = {}) {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: ['agent-memories', tenant?.id, internalAgentId],
    queryFn: () => listAgentMemories(internalAgentId!, tenant!.id, { limit: 100 }),
    enabled: !!tenant?.id && !!internalAgentId && (opts.enabled !== false),
    staleTime: 30 * 1000,
    retry: retryOnServerError,
  })
}

export function useAgentSkills(internalAgentId: string | undefined, opts: { enabled?: boolean } = {}) {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, internalAgentId, 'skills'],
    queryFn: () => getAgentSkills(internalAgentId!, tenant!.id),
    enabled: !!tenant?.id && !!internalAgentId && (opts.enabled !== false),
    staleTime: 2 * 60 * 1000,
    retry: retryOnServerError,
  })
}

// ---------------------------------------------------------------------------
// Per-agent inbound webhooks

export function useAgentWebhook(internalAgentId: string | undefined) {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, internalAgentId, 'webhook'],
    queryFn: () => getAgentWebhook(internalAgentId!, tenant!.id),
    enabled: !!tenant?.id && !!internalAgentId,
    staleTime: 30 * 1000,
    retry: retryOnServerError,
  })
}

export function useProvisionAgentWebhook() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (internalAgentId: string) =>
      provisionAgentWebhook(internalAgentId, tenant!.id),
    onSuccess: (_data, internalAgentId) => {
      track('agent_webhook_provisioned', { agent_id: internalAgentId, kind: 'internal' })
      queryClient.invalidateQueries({
        queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, internalAgentId, 'webhook'],
      })
    },
  })
}

export function useResetAgentWebhookCredentials() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (internalAgentId: string) =>
      resetAgentWebhookCredentials(internalAgentId, tenant!.id),
    onSuccess: (_data, internalAgentId) => {
      track('agent_webhook_credentials_reset', { agent_id: internalAgentId, kind: 'internal' })
      queryClient.invalidateQueries({
        queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, internalAgentId, 'webhook'],
      })
    },
  })
}

export function useUpdateAgentWebhook() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: ({ internalAgentId, data }: { internalAgentId: string; data: UpdateAgentWebhookInput }) =>
      updateAgentWebhook(internalAgentId, tenant!.id, data),
    onSuccess: (updated, { internalAgentId }) => {
      track('agent_webhook_updated', { agent_id: internalAgentId, kind: 'internal' })
      queryClient.setQueryData(
        [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, internalAgentId, 'webhook'],
        updated,
      )
    },
  })
}

export function useAgentWebhookDeliveries(internalAgentId: string | undefined, limit = 5) {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...INTERNAL_AGENTS_QUERY_KEY, tenant?.id, internalAgentId, 'webhook', 'deliveries', limit],
    queryFn: () => listAgentWebhookDeliveries(internalAgentId!, tenant!.id, limit),
    enabled: !!tenant?.id && !!internalAgentId,
    staleTime: 15 * 1000,
    retry: retryOnServerError,
  })
}

// Re-export types for consumers
export type {
  AgentMemory,
  AgentMemoriesResponse,
  AgentSkill,
  AgentSkillsResponse,
  AgentWebhookMetadata,
  AgentWebhookCredentials,
  AgentWebhookDelivery,
  AgentWebhookDeliveriesResponse,
  UpdateAgentWebhookInput,
}

