import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getAiProviderKeys,
  updateAiProviderKeys,
  type AiProviderKey,
  type AiProviderKeyUpdate,
} from '../services/aiProviderKeys'

export const aiProviderKeysQueryKey = (tenantId: string | undefined) =>
  ['ai-provider-keys', tenantId] as const

/**
 * The workspace's stored AI provider keys, as redacted hints.
 *
 * Server state, not device state: every admin on every browser sees the same
 * committed set.
 *
 * This used to be gated on the settings card being expanded, back when the
 * collapsed row showed nothing and the read was pure cost. The collapsed row
 * now summarises how many providers have a key, so the read has to happen on
 * mount.
 */
export function useAiProviderKeys(tenantId: string | undefined) {
  return useQuery({
    queryKey: aiProviderKeysQueryKey(tenantId),
    queryFn: () => getAiProviderKeys(tenantId as string),
    enabled: !!tenantId,
  })
}

/**
 * Applies a set of keys. On success the server's fresh list goes straight into
 * the cache, so reopening the card shows the new hints without a refetch.
 */
export function useUpdateAiProviderKeys() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ tenantId, keys }: { tenantId: string; keys: AiProviderKeyUpdate }) =>
      updateAiProviderKeys(tenantId, keys),
    onSuccess: (data: AiProviderKey[], { tenantId }) => {
      queryClient.setQueryData(aiProviderKeysQueryKey(tenantId), data)
    },
  })
}
