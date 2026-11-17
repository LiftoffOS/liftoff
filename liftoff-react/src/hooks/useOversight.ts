// Oversight React Query Hooks
// Per implementation plan: Phase 1.4 Frontend hooks with optimistic updates

import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query'
import {
  getOversightSettings,
  updateOversightSettings,
  listApprovals,
  approveRequest,
  rejectRequest,
  getPendingCount,
  submitLateFeedback,
  respondToClarification,
  declineClarification,
  type UpdateOversightInput,
  type PaginatedApprovalsResponse,
  type PendingCountResponse,
  type QueueCounts,
  type QueueItem,
  type QueueWindow,
  type OversightSettings,
  type LateFeedbackDecision,
} from '../services/oversight'
import { useAuth } from '../contexts/AuthContext'
import { track } from '../lib/analytics'

export const OVERSIGHT_QUERY_KEY = ['oversight-settings'] as const
export const APPROVALS_QUERY_KEY = ['hitl-approvals'] as const
export const PENDING_COUNT_KEY = ['hitl-pending-count'] as const

/** The review queue's cache key, built in one place.
 *
 *  Every optimistic update used to spell the key out by hand, ending in the
 *  literal 'pending'. Any change to how the key was built would have left those
 *  writes addressing a cache entry that no longer existed: no optimistic
 *  update, no rollback, and nothing to notice it. */
export function approvalsQueryKey(
  tenantId: string | undefined,
  agentId?: string,
  window: QueueWindow = 'actionable',
) {
  return [...APPROVALS_QUERY_KEY, tenantId, agentId ?? 'all', window] as const
}

export function pendingCountQueryKey(tenantId: string | undefined, agentId?: string) {
  return [...PENDING_COUNT_KEY, tenantId, agentId ?? 'all'] as const
}

/** Which count bucket an item belongs to. Derived from the item itself, in one
 *  place, so no caller has to classify anything. */
function bucketOf(item: QueueItem): keyof QueueCounts {
  if (item.kind === 'clarification') return 'clarifications'
  if (item.hitlLevel === 1) return 'approvalsStandard'
  if (item.hitlLevel === 2) return 'approvalsCritical'
  return 'approvalsOther'
}

function decrementCounts(counts: QueueCounts | null, bucket: keyof QueueCounts): QueueCounts | null {
  if (!counts) return counts
  return {
    ...counts,
    total: Math.max(0, counts.total - 1),
    [bucket]: Math.max(0, counts[bucket] - 1),
  }
}

/** Optimistically take one item out of every cached view of the queue.
 *
 *  Shared by approve, reject and respond-to-clarification: they used to carry a
 *  copy each, and a copy is where another definition of the queue starts.
 *  Writing across every cached key (rather than one guessed key) also keeps the
 *  agent-filtered views in step with the unfiltered one.
 *
 *  Returns the snapshots the caller hands back to restoreQueueSnapshots on
 *  failure. */
function removeQueueItemFromCache(queryClient: QueryClient, itemId: string) {
  const listSnapshots = queryClient.getQueriesData<InfiniteData<PaginatedApprovalsResponse>>({
    queryKey: APPROVALS_QUERY_KEY,
  })
  const countSnapshots = queryClient.getQueriesData<PendingCountResponse>({
    queryKey: PENDING_COUNT_KEY,
  })

  // The item carries its own bucket, so classification happens here and nowhere
  // else. It has to be read before the removal, which is why the lookup leads.
  let bucket: keyof QueueCounts | undefined
  for (const [, data] of listSnapshots) {
    const found = data?.pages.flatMap((page) => page.items).find((item) => item.id === itemId)
    if (found) {
      bucket = bucketOf(found)
      break
    }
  }

  queryClient.setQueriesData<InfiniteData<PaginatedApprovalsResponse>>(
    { queryKey: APPROVALS_QUERY_KEY },
    (old) => {
      if (!old) return old
      const held = old.pages.some((page) => page.items.some((item) => item.id === itemId))
      if (!held) return old
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.filter((item) => item.id !== itemId),
          total: page.total === null ? null : Math.max(0, page.total - 1),
          counts: bucket ? decrementCounts(page.counts, bucket) : page.counts,
        })),
      }
    },
  )

  queryClient.setQueriesData<PendingCountResponse>({ queryKey: PENDING_COUNT_KEY }, (old) => {
    if (!old || old.count === null) return old
    const next: PendingCountResponse = { ...old, count: Math.max(0, old.count - 1) }
    if (next.total !== undefined) next.total = Math.max(0, next.total - 1)
    if (bucket && next[bucket] !== undefined) {
      next[bucket] = Math.max(0, (next[bucket] as number) - 1)
    }
    return next
  })

  return { listSnapshots, countSnapshots }
}

type QueueSnapshots = ReturnType<typeof removeQueueItemFromCache>

function restoreQueueSnapshots(queryClient: QueryClient, snapshots: QueueSnapshots | undefined) {
  if (!snapshots) return
  for (const [key, data] of snapshots.listSnapshots) {
    queryClient.setQueryData(key, data)
  }
  for (const [key, data] of snapshots.countSnapshots) {
    queryClient.setQueryData(key, data)
  }
}

// Get oversight settings with loading/error states [FIX: FE-001]
export function useOversightSettings() {
  const { currentTenant: tenant } = useAuth()

  return useQuery({
    queryKey: [...OVERSIGHT_QUERY_KEY, tenant?.id],
    queryFn: () => getOversightSettings(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 2 * 60 * 1000, // 2 minutes
  })
}

// Update oversight settings with optimistic update [FIX: FE-007]
export function useUpdateOversightSettings() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useAuth()

  return useMutation({
    mutationFn: (data: UpdateOversightInput) =>
      updateOversightSettings(tenant!.id, data),
    onMutate: async (newSettings) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({
        queryKey: [...OVERSIGHT_QUERY_KEY, tenant?.id],
      })

      // Snapshot previous value
      const previousSettings = queryClient.getQueryData<OversightSettings>([
        ...OVERSIGHT_QUERY_KEY,
        tenant?.id,
      ])

      // Optimistically update the cache
      if (previousSettings) {
        queryClient.setQueryData<OversightSettings>(
          [...OVERSIGHT_QUERY_KEY, tenant?.id],
          {
            ...previousSettings,
            ...newSettings,
            sensitiveWork: {
              ...previousSettings.sensitiveWork,
              ...newSettings.sensitiveWork,
            },
            updatedAt: new Date().toISOString(),
          }
        )
      }

      return { previousSettings }
    },
    onError: (_err, _newSettings, context) => {
      // Rollback on error
      if (context?.previousSettings) {
        queryClient.setQueryData(
          [...OVERSIGHT_QUERY_KEY, tenant?.id],
          context.previousSettings
        )
      }
    },
    onSettled: () => {
      // Refetch to ensure server state
      queryClient.invalidateQueries({
        queryKey: [...OVERSIGHT_QUERY_KEY, tenant?.id],
      })
    },
  })
}

// The review queue, with infinite scroll. What is actionable is the runtime's
// call, not this hook's: there is no status filter to pass. `window: 'passed'`
// asks for the other view, the approvals whose decision window closed without
// an answer, which is a different set rather than a filter over this one.
export function useApprovals(options?: { agentId?: string; window?: QueueWindow }) {
  const { currentTenant: tenant } = useAuth()

  return useInfiniteQuery({
    queryKey: approvalsQueryKey(tenant?.id, options?.agentId, options?.window),
    queryFn: async ({ pageParam }) => {
      return listApprovals(tenant!.id, {
        cursor: pageParam,
        limit: 20,
        agentId: options?.agentId,
        window: options?.window,
      })
    },
    getNextPageParam: (lastPage) => lastPage.cursor,
    initialPageParam: undefined as string | undefined,
    enabled: !!tenant?.id,
    staleTime: 30 * 1000, // 30 seconds for approvals (more time-sensitive)
    refetchInterval: 60 * 1000, // Refetch every minute
  })
}

// Approve a HITL request with optimistic update
export function useApproveRequest() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useAuth()

  return useMutation({
    mutationFn: (
      { approvalId, alwaysApply, approvalNote, editedToolInputs }:
        {
          approvalId: string
          alwaysApply?: boolean
          approvalNote?: string
          editedToolInputs?: Record<string, Record<string, unknown>>
        },
    ) =>
      approveRequest(approvalId, tenant!.id, { alwaysApply, approvalNote, editedToolInputs }),
    onMutate: async ({ approvalId }) => {
      await queryClient.cancelQueries({ queryKey: APPROVALS_QUERY_KEY })
      return removeQueueItemFromCache(queryClient, approvalId)
    },
    onError: (_err, _vars, context) => {
      restoreQueueSnapshots(queryClient, context)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: PENDING_COUNT_KEY })
    },
  })
}

// Reject a HITL request with optimistic update
export function useRejectRequest() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useAuth()

  return useMutation({
    mutationFn: ({ approvalId, reason, alwaysApply }: { approvalId: string; reason?: string; alwaysApply?: boolean }) =>
      rejectRequest(approvalId, tenant!.id, reason, { alwaysApply }),
    onMutate: async ({ approvalId }) => {
      await queryClient.cancelQueries({ queryKey: APPROVALS_QUERY_KEY })
      return removeQueueItemFromCache(queryClient, approvalId)
    },
    onError: (_err, _vars, context) => {
      restoreQueueSnapshots(queryClient, context)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: PENDING_COUNT_KEY })
    },
  })
}

// The review queue's counts, bucketed by kind. Every surface that shows a
// number reads this one query, so the dashboard tile, the queue's tab labels
// and the oversight page cannot disagree about how much is waiting.
//
// `total` falls back to `count`, the single number older backends send. That
// keeps this deploy from being gated on the backend's: until it ships the
// breakdown, the buckets read zero and the total is still the truth.
export function usePendingApprovalCount(options?: { agentId?: string }) {
  const { currentTenant: tenant } = useAuth()

  return useQuery({
    queryKey: pendingCountQueryKey(tenant?.id, options?.agentId),
    queryFn: () => getPendingCount(tenant!.id, { agentId: options?.agentId }),
    select: (data: PendingCountResponse) => ({
      ...data,
      total: data.total ?? data.count ?? null,
    }),
    enabled: !!tenant?.id,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  })
}

// PR0: respond to a pending clarification question (recovery LLM or Anchor intervention).
export function useRespondToClarification() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useAuth()

  return useMutation({
    mutationFn: ({ clarificationId, response }: { clarificationId: string; response: string }) => {
      if (!tenant) {
        throw new Error('No tenant selected.')
      }
      return respondToClarification(tenant.id, clarificationId, response)
    },
    onMutate: async ({ clarificationId }) => {
      await queryClient.cancelQueries({ queryKey: APPROVALS_QUERY_KEY })
      return removeQueueItemFromCache(queryClient, clarificationId)
    },
    onError: (_err, _vars, context) => {
      restoreQueueSnapshots(queryClient, context)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: PENDING_COUNT_KEY })
    },
  })
}

/** Decline a pending clarification: the run resumes with no answer available.
 *
 *  Cache handling is the same as answering because the outcome is the same
 *  from the queue's point of view — the item is gone and the run is moving
 *  again. Only what the team is told differs. */
export function useDeclineClarification() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useAuth()

  return useMutation({
    mutationFn: ({ clarificationId, reason }: { clarificationId: string; reason?: string }) => {
      if (!tenant) {
        throw new Error('No tenant selected.')
      }
      return declineClarification(tenant.id, clarificationId, reason)
    },
    onMutate: async ({ clarificationId }) => {
      await queryClient.cancelQueries({ queryKey: APPROVALS_QUERY_KEY })
      return removeQueueItemFromCache(queryClient, clarificationId)
    },
    onError: (_err, _vars, context) => {
      restoreQueueSnapshots(queryClient, context)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: PENDING_COUNT_KEY })
    },
  })
}


// Submit late feedback for expired approvals (for agent learning)
export function useSubmitLateFeedback() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useAuth()

  return useMutation({
    mutationFn: (input: {
      approvalId: string
      decision: LateFeedbackDecision
      reason?: string
    }) => {
      // Guard against missing tenant - fail fast with clear error
      if (!tenant) {
        throw new Error('No tenant selected. Please select a tenant before submitting feedback.')
      }
      return submitLateFeedback(input.approvalId, tenant.id, {
        decision: input.decision,
        reason: input.reason,
      })
    },
    onSuccess: (_data, { approvalId, decision }) => {
      track('approval_late_feedback_submitted', { approval_id: approvalId, decision })
      // Invalidate approvals to refresh the list
      queryClient.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY })
    },
    // Caller should provide onError for user-facing error handling
  })
}
