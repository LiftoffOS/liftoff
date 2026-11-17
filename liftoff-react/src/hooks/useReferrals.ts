import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getReferralProgram,
  listReferrals,
  sendReferralInvites,
  type ReferralListPage,
} from '../services/referrals'
import { ApiError } from '../services/api'
import { useTenant } from './useTenant'

export const REFERRAL_PROGRAM_KEY = ['referral-program'] as const
export const REFERRAL_LIST_KEY = ['referrals'] as const

// A 4xx here means the endpoint is missing or the workspace is not eligible.
// Neither improves on a retry, and retrying only fills the console with noise.
const retryOnServerError = (_: number, error: unknown) =>
  !(error instanceof ApiError && error.status < 500)

export function useReferralProgram() {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...REFERRAL_PROGRAM_KEY, tenant?.id],
    queryFn: () => getReferralProgram(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 5 * 60 * 1000,
    retry: retryOnServerError,
  })
}

export function useReferrals() {
  const { currentTenant: tenant } = useTenant()

  return useQuery({
    queryKey: [...REFERRAL_LIST_KEY, tenant?.id],
    queryFn: () => listReferrals(tenant!.id, { limit: 50 }),
    enabled: !!tenant?.id,
    staleTime: 5 * 60 * 1000,
    retry: retryOnServerError,
  })
}

/** Appends the next page onto the cached list, mirroring useLoadMoreInvoices.
 *
 *  Not useInfiniteQuery: the list is one flat array the table maps over, and
 *  the cache shape has to stay a single `ReferralListPage` for the header line,
 *  which counts what has been loaded. */
export function useLoadMoreReferrals() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: (cursor: string) => listReferrals(tenant!.id, { limit: 50, cursor }),
    onSuccess: (newPage: ReferralListPage) => {
      queryClient.setQueryData(
        [...REFERRAL_LIST_KEY, tenant?.id],
        (old: ReferralListPage | undefined) => {
          if (!old) return newPage
          return {
            referrals: [...old.referrals, ...newPage.referrals],
            hasMore: newPage.hasMore,
            nextCursor: newPage.nextCursor,
          }
        },
      )
    },
  })
}

export function useSendReferralInvites() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()

  return useMutation({
    mutationFn: ({ emails, message }: { emails: string[]; message?: string }) =>
      sendReferralInvites(tenant!.id, emails, message),
    onSuccess: () => {
      // An invite creates nothing on the list until the person signs up, but
      // the program counters move as soon as the send is recorded.
      queryClient.invalidateQueries({ queryKey: REFERRAL_PROGRAM_KEY })
      queryClient.invalidateQueries({ queryKey: REFERRAL_LIST_KEY })
    },
  })
}
