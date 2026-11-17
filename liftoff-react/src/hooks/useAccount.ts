import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  updateAccount,
  initiateEmailChange,
  cancelEmailChange,
  getDeletionPreflight,
  deleteSelf,
  type UpdateAccountRequest,
  type DeletionPreflight,
} from '../services/account'
import { useAuth } from '../contexts/AuthContext'
import { track } from '../lib/analytics'

type AccountField = 'firstName' | 'lastName' | 'email' | 'timezone' | 'avatarUrl' | 'persona' | 'notificationTypes' | 'notificationFrequency' | 'notificationDelivery'

/**
 * Hook for updating account details (name, timezone, avatarUrl, persona).
 * Automatically refreshes account data in AuthContext and — only when a
 * member-list-visible field changed — invalidates tenant member queries
 * so the new avatar/name renders everywhere.
 */
export function useUpdateAccount() {
  const { updateAccountData } = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: UpdateAccountRequest) => updateAccount(data),
    onSuccess: (updatedAccount, variables) => {
      const fields: AccountField[] = []
      for (const key of Object.keys(variables)) {
        if (key === 'preferences' && variables.preferences) {
          if ('notificationTypes' in variables.preferences) fields.push('notificationTypes')
          if ('notificationFrequency' in variables.preferences) fields.push('notificationFrequency')
          if ('notificationDelivery' in variables.preferences) fields.push('notificationDelivery')
        } else if (
          key === 'firstName' || key === 'lastName' || key === 'timezone' ||
          key === 'avatarUrl' || key === 'persona'
        ) {
          fields.push(key)
        }
      }
      if (fields.length > 0) {
        track('account_profile_updated', { fields })
      }
      // Update account data in AuthContext directly with the mutation result.
      // More reliable than refreshAccount(): no extra API call, synchronous,
      // and uses exactly what the backend returned.
      updateAccountData(updatedAccount)
      // Only invalidate member-list caches when a field that actually renders
      // in a member list changed. Persona / preferences / timezone don't
      // affect the rendered row, so invalidating for those just burns
      // network round-trips.
      const memberVisibleChanged =
        'firstName' in variables ||
        'lastName' in variables ||
        'avatarUrl' in variables
      if (memberVisibleChanged) {
        queryClient.invalidateQueries({ queryKey: ['workspace-team-members'] })
        queryClient.invalidateQueries({ queryKey: ['tenant-members'] })
      }
    },
  })
}

/**
 * Hook for initiating an email change (sends verification email)
 */
export function useInitiateEmailChange() {
  return useMutation({
    mutationFn: (newEmail: string) => initiateEmailChange(newEmail),
    onSuccess: () => {
      track('email_change_initiated', {})
    },
  })
}

/**
 * Hook for canceling a pending email change
 * Automatically refreshes account data in AuthContext on success
 */
export function useCancelEmailChange() {
  const { refreshAccount } = useAuth()

  return useMutation({
    mutationFn: () => cancelEmailChange(),
    onSuccess: () => {
      track('email_change_canceled', {})
      // Refresh account data to clear pendingEmail
      refreshAccount()
    },
  })
}

/**
 * Hook for the user-deletion preflight. Drives the DeleteAccountModal:
 * the response determines whether the modal blocks on a subscription /
 * invoice, or proceeds to confirm-delete with workspace consequence copy.
 *
 * Short stale-time: the modal opens off a fresh refetch on click, so the
 * user sees current subscription state if they just cancelled.
 */
export function useDeletionPreflight() {
  return useQuery<DeletionPreflight>({
    queryKey: ['deletion-preflight'],
    queryFn: getDeletionPreflight,
    enabled: false,
    staleTime: 10_000,
  })
}

/**
 * Hook that fires DELETE /api/accounts/me. Caller handles signOut +
 * navigation in onSuccess (the AuthContext is torn down post-deletion).
 */
export function useDeleteSelf() {
  return useMutation({
    mutationFn: () => deleteSelf(),
    onSuccess: () => {
      track('account_deletion_confirmed', {})
    },
  })
}
