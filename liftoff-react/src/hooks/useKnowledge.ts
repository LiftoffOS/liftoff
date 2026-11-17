import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../services/api'
import {
  listKnowledgeItems,
  createKnowledgeItem,
  batchCreateKnowledgeItems,
  updateKnowledgeItem,
  deleteKnowledgeItem,
  browseConnector,
  importConnector,
  syncItems,
  type KnowledgeItem,
  type CreateKnowledgeItemInput,
} from '../services/knowledge'
import { useTenant } from './useTenant'
import { track } from '../lib/analytics'

export const KNOWLEDGE_QUERY_KEY = ['knowledge'] as const

const retryOnServerError = (_: number, error: unknown) =>
  !(error instanceof ApiError && error.status < 500)

export function useKnowledgeItems() {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...KNOWLEDGE_QUERY_KEY, tenant?.id],
    queryFn: () => listKnowledgeItems(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 60 * 1000,
    retry: retryOnServerError,
  })
}

export function useCreateKnowledgeItem() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (input: CreateKnowledgeItemInput) => createKnowledgeItem(tenant!.id, input),
    onSuccess: (_data, input) => {
      track('knowledge_item_created', { source: input.connectorId ? 'connector' : 'manual' })
      queryClient.invalidateQueries({ queryKey: KNOWLEDGE_QUERY_KEY })
    },
  })
}

export function useBatchCreateKnowledgeItems() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (items: CreateKnowledgeItemInput[]) => batchCreateKnowledgeItems(tenant!.id, items),
    onSuccess: (_data, items) => {
      track('knowledge_items_batch_imported', { count: items.length })
      queryClient.invalidateQueries({ queryKey: KNOWLEDGE_QUERY_KEY })
      // Poll until all connector items finish content extraction (extractionStatus = done|error).
      // Stop after 20 attempts (~60 seconds) as a safety valve.
      const poll = (attempts: number) => {
        if (attempts <= 0) return
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: KNOWLEDGE_QUERY_KEY })
          const data = queryClient.getQueryData<KnowledgeItem[]>([...KNOWLEDGE_QUERY_KEY, tenant?.id])
          const allDone = !data || data.filter(i => i.connectorId).every(
            i => i.extractionStatus === 'done' || i.extractionStatus === 'error' || i.extractionStatus === 'none',
          )
          if (!allDone) poll(attempts - 1)
        }, 3000)
      }
      poll(20)
    },
  })
}

export function useUpdateKnowledgeItem() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<CreateKnowledgeItemInput> }) =>
      updateKnowledgeItem(tenant!.id, id, input),
    onSuccess: (_data, { id }) => {
      track('knowledge_item_updated', { item_id: id })
      queryClient.invalidateQueries({ queryKey: KNOWLEDGE_QUERY_KEY })
    },
  })
}

export function useDeleteKnowledgeItem() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (id: string) => deleteKnowledgeItem(tenant!.id, id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: KNOWLEDGE_QUERY_KEY })
      const previous = queryClient.getQueryData<KnowledgeItem[]>([...KNOWLEDGE_QUERY_KEY, tenant?.id])
      queryClient.setQueryData<KnowledgeItem[]>(
        [...KNOWLEDGE_QUERY_KEY, tenant?.id],
        (old) => old?.filter((item) => item.id !== id),
      )
      return { previous }
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData([...KNOWLEDGE_QUERY_KEY, tenant?.id], context.previous)
      }
    },
    onSuccess: (_data, id) => {
      track('knowledge_item_deleted', { item_id: id })
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: KNOWLEDGE_QUERY_KEY })
    },
  })
}

/** `entityType` selects what the connector enumerates. Files are the default,
 *  but the same endpoint already serves other shapes — Slack answers
 *  `channels` from conversations.list, and the Zendesk/Intercom hierarchy
 *  drives its own levels through `expandEntityType`. Passing it through is what
 *  lets one browse path serve every object kind a template can ask for. */
export function useBrowseConnector(
  connectorId: string | null,
  query: string,
  folderId?: string,
  mimeTypes?: readonly string[],
  entityType?: string,
) {
  const { currentTenant: tenant } = useTenant()

  return useInfiniteQuery({
    queryKey: ['knowledge-browse', tenant?.id, connectorId, query, folderId, mimeTypes, entityType],
    queryFn: ({ pageParam }) =>
      browseConnector(tenant!.id, connectorId!, query || undefined, pageParam || undefined, mimeTypes, folderId, entityType),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    enabled: !!tenant?.id && !!connectorId,
    staleTime: 30 * 1000,
    retry: false,
  })
}

export function useImportConnector() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (connectorId: string) => importConnector(tenant!.id, connectorId),
    onSuccess: (_data, connectorId) => {
      track('knowledge_connector_imported', { connector_id: connectorId })
      // Import is async on the server — poll until extraction is complete for all items.
      const poll = (attempts: number) => {
        if (attempts <= 0) return
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: KNOWLEDGE_QUERY_KEY })
          const data = queryClient.getQueryData<KnowledgeItem[]>([...KNOWLEDGE_QUERY_KEY, tenant?.id])
          const allDone = !data || data.filter(i => i.connectorId).every(
            i => i.extractionStatus === 'done' || i.extractionStatus === 'error' || i.extractionStatus === 'none',
          )
          if (!allDone) poll(attempts - 1)
        }, 3000)
      }
      poll(20)
    },
  })
}

export function useSyncItems() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (connectorId?: string) => syncItems(tenant!.id, connectorId),
    onSuccess: (_data, connectorId) => {
      track('knowledge_items_synced', { connector_id: connectorId ?? null })
      queryClient.invalidateQueries({ queryKey: KNOWLEDGE_QUERY_KEY })
    },
  })
}

export type { KnowledgeItem, CreateKnowledgeItemInput }
